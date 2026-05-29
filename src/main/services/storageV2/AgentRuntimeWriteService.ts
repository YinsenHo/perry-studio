import type { Client } from '@libsql/client'
import type { ChannelRow, InsertChannelRow } from '@main/services/agents/database/schema'

import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2Database } from './StorageV2Database'
import { storageV2SyncLogService } from './SyncLogService'

const CHANNEL_SECRET_KEYS = [
  'app_secret',
  'app_token',
  'bot_token',
  'client_secret',
  'encrypt_key',
  'verification_token'
] as const

type ChannelRuntimeRow = Pick<
  ChannelRow | InsertChannelRow,
  'id' | 'type' | 'name' | 'agentId' | 'sessionId' | 'config' | 'isActive' | 'activeChatIds' | 'permissionMode'
> & {
  id: string
  createdAt?: number | string | null
  updatedAt?: number | string | null
}

function now() {
  return new Date().toISOString()
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function toIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  if (typeof value === 'string' && value) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
  }

  return fallback
}

async function getVersion(client: Client, table: string, entityId: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT version FROM ${table} WHERE id = ?`,
    args: [entityId]
  })
  return Number(result.rows[0]?.version ?? 1)
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return { ...(value as Record<string, unknown>) }
}

export class StorageV2AgentRuntimeWriteService {
  async upsertChannel(channel: ChannelRuntimeRow): Promise<void> {
    const client = await storageV2Database.getClient()
    const updatedAt = toIsoTimestamp(channel.updatedAt, now())
    const createdAt = toIsoTimestamp(channel.createdAt, updatedAt)
    const configJson = await this.prepareChannelConfig(channel.id, channel.config)

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO channels (
            id, type, name, agent_id, session_id, config_json, is_active,
            active_chat_ids_json, permission_mode, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            type = excluded.type,
            name = excluded.name,
            agent_id = excluded.agent_id,
            session_id = excluded.session_id,
            config_json = excluded.config_json,
            is_active = excluded.is_active,
            active_chat_ids_json = excluded.active_chat_ids_json,
            permission_mode = excluded.permission_mode,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = channels.version + 1
        `,
        args: [
          channel.id,
          channel.type,
          channel.name,
          channel.agentId ?? null,
          channel.sessionId ?? null,
          configJson,
          channel.isActive === false ? 0 : 1,
          toJson(channel.activeChatIds ?? []),
          channel.permissionMode ?? null,
          createdAt,
          updatedAt
        ]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'channel',
        entityId: channel.id,
        payload: {
          id: channel.id,
          type: channel.type,
          name: channel.name,
          agentId: channel.agentId ?? null,
          sessionId: channel.sessionId ?? null
        },
        version: await getVersion(client, 'channels', channel.id)
      })
    })
  }

  private async prepareChannelConfig(channelId: string, rawConfig: unknown): Promise<string> {
    const nextConfig = cloneRecord(rawConfig)

    for (const key of CHANNEL_SECRET_KEYS) {
      const value = nextConfig[key]
      if (typeof value !== 'string' || !value) continue

      delete nextConfig[key]

      if (storageV2SecretVaultService.isAvailable()) {
        nextConfig[`${key}_secret_ref`] = await storageV2SecretVaultService.setSecret('channel', channelId, key, value)
      } else {
        nextConfig[`${key}_secret_unmigrated`] = true
      }
    }

    return toJson(nextConfig)
  }
}

export const storageV2AgentRuntimeWriteService = new StorageV2AgentRuntimeWriteService()
