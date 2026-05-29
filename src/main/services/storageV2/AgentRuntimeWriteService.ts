import type { Client } from '@libsql/client'
import type {
  ChannelRow,
  InsertChannelRow,
  InsertSessionRow,
  InsertTaskRow,
  SessionRow,
  TaskRow
} from '@main/services/agents/database/schema'

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

type AgentRuntimeRow = {
  id: string
  type: string
  name: string
  description?: string | null
  instructions?: string | null
  model?: string | null
  plan_model?: string | null
  small_model?: string | null
  accessible_paths?: unknown
  mcps?: unknown
  allowed_tools?: unknown
  configuration?: unknown
  sort_order?: number | null
  created_at?: string | number | null
  updated_at?: string | number | null
  deleted_at?: string | null
}

type AgentSessionRuntimeRow = Pick<
  SessionRow | InsertSessionRow,
  | 'id'
  | 'agent_id'
  | 'agent_type'
  | 'name'
  | 'description'
  | 'accessible_paths'
  | 'instructions'
  | 'model'
  | 'plan_model'
  | 'small_model'
  | 'mcps'
  | 'allowed_tools'
  | 'slash_commands'
  | 'configuration'
  | 'sort_order'
  | 'created_at'
  | 'updated_at'
> & {
  id: string
  deleted_at?: string | null
}

type AgentSessionUpsertOptions = {
  shiftExistingForAgent?: boolean
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

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  if (!value.trim()) return null

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function normalizeJson(value: unknown, fallback: unknown) {
  const parsed = parseJson(value)
  return toJson(parsed ?? fallback)
}

function normalizeValue<T>(value: unknown, fallback: T): T | unknown {
  return parseJson(value) ?? fallback
}

function buildAgentSessionCurrentConfig(session: AgentSessionRuntimeRow): Record<string, unknown> {
  return {
    agentType: session.agent_type,
    description: session.description ?? null,
    accessiblePaths: normalizeValue(session.accessible_paths, []),
    instructions: session.instructions ?? null,
    model: session.model ?? '',
    planModel: session.plan_model ?? null,
    smallModel: session.small_model ?? null,
    mcps: normalizeValue(session.mcps, []),
    allowedTools: normalizeValue(session.allowed_tools, []),
    slashCommands: normalizeValue(session.slash_commands, []),
    configuration: normalizeValue(session.configuration, {})
  }
}

export class StorageV2AgentRuntimeWriteService {
  async upsertAgent(agent: AgentRuntimeRow): Promise<void> {
    const client = await storageV2Database.getClient()
    const updatedAt = toIsoTimestamp(agent.updated_at, now())
    const createdAt = toIsoTimestamp(agent.created_at, updatedAt)

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO agents (
            id, type, name, description, instructions, model_id, plan_model_id, small_model_id,
            accessible_paths_json, mcps_json, allowed_tools_json, configuration_json,
            sort_order, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            type = excluded.type,
            name = excluded.name,
            description = excluded.description,
            instructions = excluded.instructions,
            model_id = excluded.model_id,
            plan_model_id = excluded.plan_model_id,
            small_model_id = excluded.small_model_id,
            accessible_paths_json = excluded.accessible_paths_json,
            mcps_json = excluded.mcps_json,
            allowed_tools_json = excluded.allowed_tools_json,
            configuration_json = excluded.configuration_json,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = agents.version + 1
        `,
        args: [
          agent.id,
          agent.type,
          agent.name,
          agent.description ?? null,
          agent.instructions ?? null,
          agent.model ?? '',
          agent.plan_model ?? null,
          agent.small_model ?? null,
          normalizeJson(agent.accessible_paths, []),
          normalizeJson(agent.mcps, []),
          normalizeJson(agent.allowed_tools, []),
          normalizeJson(agent.configuration, {}),
          agent.sort_order ?? 0,
          createdAt,
          updatedAt,
          agent.deleted_at ?? null
        ]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'agent',
        entityId: agent.id,
        operation: agent.deleted_at ? 'delete' : 'upsert',
        payload: {
          id: agent.id,
          type: agent.type,
          name: agent.name,
          deletedAt: agent.deleted_at ?? null
        },
        version: await getVersion(client, 'agents', agent.id)
      })
    })
  }

  async upsertAgentSession(session: AgentSessionRuntimeRow, options: AgentSessionUpsertOptions = {}): Promise<void> {
    const client = await storageV2Database.getClient()
    const updatedAt = toIsoTimestamp(session.updated_at, now())
    const createdAt = toIsoTimestamp(session.created_at, updatedAt)
    const sessionName = session.name ?? session.id
    const sortOrder = session.sort_order ?? 0

    await storageV2Database.withTransaction(client, async () => {
      if (options.shiftExistingForAgent) {
        await this.shiftExistingAgentSessions(client, session.agent_id, session.id, updatedAt)
      }

      await client.execute({
        sql: `
          INSERT INTO agent_sessions (
            id, agent_id, name, inherited_config_json, current_config_json,
            sort_order, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            agent_id = excluded.agent_id,
            name = excluded.name,
            inherited_config_json = excluded.inherited_config_json,
            current_config_json = excluded.current_config_json,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = agent_sessions.version + 1
        `,
        args: [
          session.id,
          session.agent_id,
          sessionName,
          normalizeJson(session.configuration, {}),
          toJson(buildAgentSessionCurrentConfig(session)),
          sortOrder,
          createdAt,
          updatedAt,
          session.deleted_at ?? null
        ]
      })

      await client.execute({
        sql: `
          INSERT INTO conversations (
            id, kind, owner_type, owner_id, session_id, title, pinned, archived, sort_order,
            created_at, updated_at, deleted_at, version
          )
          VALUES (?, 'agent_session', 'agent', ?, ?, ?, 0, 0, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            owner_type = excluded.owner_type,
            owner_id = excluded.owner_id,
            session_id = excluded.session_id,
            title = excluded.title,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = conversations.version + 1
        `,
        args: [
          `agent-session:${session.id}`,
          session.agent_id,
          session.id,
          sessionName,
          sortOrder,
          createdAt,
          updatedAt,
          session.deleted_at ?? null
        ]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'agent_session',
        entityId: session.id,
        operation: session.deleted_at ? 'delete' : 'upsert',
        payload: {
          id: session.id,
          agentId: session.agent_id,
          name: sessionName,
          deletedAt: session.deleted_at ?? null
        },
        version: await getVersion(client, 'agent_sessions', session.id)
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'conversation',
        entityId: `agent-session:${session.id}`,
        operation: session.deleted_at ? 'delete' : 'upsert',
        payload: {
          kind: 'agent_session',
          ownerType: 'agent',
          ownerId: session.agent_id,
          sessionId: session.id,
          title: sessionName,
          deletedAt: session.deleted_at ?? null
        },
        version: await getVersion(client, 'conversations', `agent-session:${session.id}`)
      })
    })
  }

  private async shiftExistingAgentSessions(
    client: Client,
    agentId: string,
    insertedSessionId: string,
    updatedAt: string
  ): Promise<void> {
    const shiftedResult = await client.execute({
      sql: `
        SELECT id
        FROM agent_sessions
        WHERE agent_id = ? AND id != ? AND deleted_at IS NULL
      `,
      args: [agentId, insertedSessionId]
    })
    const shiftedSessionIds = shiftedResult.rows
      .map((row) => (typeof row.id === 'string' ? row.id : null))
      .filter((id): id is string => Boolean(id))

    if (shiftedSessionIds.length === 0) return

    const shiftedConversationResult = await client.execute({
      sql: `
        SELECT id
        FROM conversations
        WHERE kind = 'agent_session'
          AND session_id IN (${shiftedSessionIds.map(() => '?').join(', ')})
          AND deleted_at IS NULL
      `,
      args: shiftedSessionIds
    })
    const shiftedConversationIds = new Set(
      shiftedConversationResult.rows
        .map((row) => (typeof row.id === 'string' ? row.id : null))
        .filter((id): id is string => Boolean(id))
    )

    await client.execute({
      sql: `
        UPDATE agent_sessions
        SET sort_order = sort_order + 1, updated_at = ?, version = version + 1
        WHERE agent_id = ? AND id != ? AND deleted_at IS NULL
      `,
      args: [updatedAt, agentId, insertedSessionId]
    })

    await client.execute({
      sql: `
        UPDATE conversations
        SET sort_order = sort_order + 1, updated_at = ?, version = version + 1
        WHERE kind = 'agent_session'
          AND session_id IN (${shiftedSessionIds.map(() => '?').join(', ')})
          AND deleted_at IS NULL
      `,
      args: [updatedAt, ...shiftedSessionIds]
    })

    for (const sessionId of shiftedSessionIds) {
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'agent_session',
        entityId: sessionId,
        payload: {
          id: sessionId,
          agentId,
          sortOrderShifted: true
        },
        version: await getVersion(client, 'agent_sessions', sessionId)
      })

      const conversationId = `agent-session:${sessionId}`
      if (shiftedConversationIds.has(conversationId)) {
        await storageV2SyncLogService.recordChange({
          client,
          entityType: 'conversation',
          entityId: conversationId,
          payload: {
            kind: 'agent_session',
            ownerType: 'agent',
            ownerId: agentId,
            sessionId,
            sortOrderShifted: true
          },
          version: await getVersion(client, 'conversations', conversationId)
        })
      }
    }
  }

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
