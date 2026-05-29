import type { Client } from '@libsql/client'
import type { ChannelRow, InsertChannelRow, InsertTaskRow, TaskRow } from '@main/services/agents/database/schema'

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

type ScheduledTaskRuntimeRow = Pick<
  TaskRow | InsertTaskRow,
  | 'id'
  | 'agent_id'
  | 'name'
  | 'prompt'
  | 'schedule_type'
  | 'schedule_value'
  | 'timeout_minutes'
  | 'next_run'
  | 'last_run'
  | 'last_result'
  | 'status'
  | 'created_at'
  | 'updated_at'
> & {
  id: string
  channel_ids?: string[] | null
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
  async upsertScheduledTask(task: ScheduledTaskRuntimeRow, channelIds?: string[]): Promise<void> {
    const client = await storageV2Database.getClient()
    const updatedAt = toIsoTimestamp(task.updated_at, now())
    const createdAt = toIsoTimestamp(task.created_at, updatedAt)

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO scheduled_tasks (
            id, agent_id, name, prompt, schedule_type, schedule_value, timeout_minutes,
            next_run, last_run, last_result, status, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            agent_id = excluded.agent_id,
            name = excluded.name,
            prompt = excluded.prompt,
            schedule_type = excluded.schedule_type,
            schedule_value = excluded.schedule_value,
            timeout_minutes = excluded.timeout_minutes,
            next_run = excluded.next_run,
            last_run = excluded.last_run,
            last_result = excluded.last_result,
            status = excluded.status,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = scheduled_tasks.version + 1
        `,
        args: [
          task.id,
          task.agent_id,
          task.name,
          task.prompt,
          task.schedule_type,
          task.schedule_value,
          task.timeout_minutes ?? 2,
          task.next_run ?? null,
          task.last_run ?? null,
          task.last_result ?? null,
          task.status ?? 'active',
          createdAt,
          updatedAt
        ]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'scheduled_task',
        entityId: task.id,
        payload: {
          id: task.id,
          agentId: task.agent_id,
          name: task.name,
          status: task.status ?? 'active'
        },
        version: await getVersion(client, 'scheduled_tasks', task.id)
      })

      if (channelIds !== undefined) {
        await this.syncTaskChannelSubscriptions(client, task.id, channelIds, updatedAt)
      }
    })
  }

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

  private async syncTaskChannelSubscriptions(
    client: Client,
    taskId: string,
    channelIds: string[],
    updatedAt: string
  ): Promise<void> {
    const uniqueChannelIds = Array.from(new Set(channelIds.filter(Boolean)))
    const staleRows =
      uniqueChannelIds.length === 0
        ? await client.execute({
            sql: 'SELECT channel_id FROM channel_task_subscriptions WHERE task_id = ?',
            args: [taskId]
          })
        : await client.execute({
            sql: `
              SELECT channel_id
              FROM channel_task_subscriptions
              WHERE task_id = ? AND channel_id NOT IN (${uniqueChannelIds.map(() => '?').join(', ')})
            `,
            args: [taskId, ...uniqueChannelIds]
          })

    if (uniqueChannelIds.length === 0) {
      await client.execute({
        sql: 'DELETE FROM channel_task_subscriptions WHERE task_id = ?',
        args: [taskId]
      })
    } else {
      await client.execute({
        sql: `
          DELETE FROM channel_task_subscriptions
          WHERE task_id = ? AND channel_id NOT IN (${uniqueChannelIds.map(() => '?').join(', ')})
        `,
        args: [taskId, ...uniqueChannelIds]
      })
    }

    for (const row of staleRows.rows) {
      const channelId = typeof row.channel_id === 'string' ? row.channel_id : null
      if (!channelId) continue
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'channel_task_subscription',
        entityId: `${channelId}:${taskId}`,
        operation: 'delete',
        payload: { channelId, taskId }
      })
    }

    for (const channelId of uniqueChannelIds) {
      await client.execute({
        sql: `
          INSERT INTO channel_task_subscriptions (channel_id, task_id, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(channel_id, task_id) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
        args: [channelId, taskId, updatedAt, updatedAt]
      })
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'channel_task_subscription',
        entityId: `${channelId}:${taskId}`,
        payload: { channelId, taskId }
      })
    }
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
