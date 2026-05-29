import fs from 'node:fs'
import path from 'node:path'

import { createClient, type Row } from '@libsql/client'
import { app } from 'electron'

import { storageV2DataRootService } from './DataRootService'
import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2Database } from './StorageV2Database'
import { type StorageV2ConversationImport, storageV2ConversationRepository } from './StorageV2Repositories'
import { storageV2SyncLogService } from './SyncLogService'

type LegacyAgentDbSnapshotOptions = {
  dryRun?: boolean
  dbPath?: string
  createSnapshot?: boolean
  pruneMissing?: boolean
}

type LegacyAgentDbRows = Record<(typeof LEGACY_TABLES)[number], Row[]>
type LegacyAgentDbTableSet = Set<(typeof LEGACY_TABLES)[number]>

export type StorageV2LegacyAgentDbImportReport = {
  dryRun: boolean
  sourceDbPath: string | null
  snapshotPath?: string
  agentCount: number
  sessionCount: number
  sessionMessageCount: number
  skillCount: number
  agentSkillCount: number
  taskCount: number
  taskRunLogCount: number
  channelCount: number
  channelTaskSubscriptionCount: number
  importedAgentCount: number
  importedSessionCount: number
  importedSessionMessageCount: number
  importedSkillCount: number
  importedAgentSkillCount: number
  importedTaskCount: number
  importedTaskRunLogCount: number
  importedChannelCount: number
  importedChannelTaskSubscriptionCount: number
  secretCandidateCount: number
  importedSecretCount: number
  skippedSecretCount: number
  warnings: string[]
}

const LEGACY_TABLES = [
  'agents',
  'sessions',
  'session_messages',
  'skills',
  'agent_skills',
  'scheduled_tasks',
  'task_run_logs',
  'channels',
  'channel_task_subscriptions'
] as const

const ENTITY_TYPE_BY_TABLE = {
  agent_sessions: 'agent_session',
  agents: 'agent',
  channels: 'channel',
  scheduled_tasks: 'scheduled_task',
  skills: 'skill',
  task_run_logs: 'task_run_log'
} as const

const CHANNEL_SECRET_KEYS = [
  'app_secret',
  'app_token',
  'bot_token',
  'client_secret',
  'encrypt_key',
  'verification_token'
]

function now() {
  return new Date().toISOString()
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
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

function normalizeJson(value: unknown) {
  return toJson(parseJson(value))
}

function text(row: Row, key: string): string | null {
  const value = row[key]
  return value == null ? null : String(value)
}

function requiredText(row: Row, key: string, fallback: string): string {
  return text(row, key) ?? fallback
}

function intValue(row: Row, key: string, fallback = 0): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function timestamp(value: unknown, fallback = now()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.length >= 10) {
      return new Date(numeric).toISOString()
    }

    return value
  }

  return fallback
}

function firstExistingPath(paths: Array<string | undefined>) {
  return paths.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))) ?? null
}

function candidateAgentDbPaths(explicitPath?: string) {
  const dataRoot = storageV2DataRootService.resolveDataRoot().dataRoot
  const userDataPath = app.getPath('userData')

  return [
    explicitPath,
    path.join(dataRoot, 'agents.db'),
    path.join(userDataPath, 'Data', 'agents.db'),
    path.join(userDataPath, 'agents.db')
  ]
}

function extractAgentSessionText(content: unknown) {
  const parsed = parseJson(content)
  if (typeof parsed === 'string') return parsed
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, any>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    if (typeof record.message === 'string') return record.message
  }
  return typeof content === 'string' ? content : toJson(content)
}

async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const client = await storageV2Database.getClient()
  return storageV2Database.withTransaction(client, fn)
}

async function getEntityVersion(
  client: ReturnType<typeof createClient>,
  table: keyof typeof ENTITY_TYPE_BY_TABLE,
  idColumn: string,
  entityId: string,
  versioned = false
) {
  if (!versioned) return 1

  const result = await client.execute({
    sql: `SELECT version FROM ${table} WHERE ${idColumn} = ?`,
    args: [entityId]
  })
  return Number(result.rows[0]?.version ?? 1)
}

async function recordEntityChange(
  client: ReturnType<typeof createClient>,
  input: {
    table: keyof typeof ENTITY_TYPE_BY_TABLE
    idColumn?: string
    entityId: string
    operation?: 'upsert' | 'delete'
    payload?: unknown
    versioned?: boolean
  }
) {
  await storageV2SyncLogService.recordChange({
    client,
    entityType: ENTITY_TYPE_BY_TABLE[input.table],
    entityId: input.entityId,
    operation: input.operation ?? 'upsert',
    payload: input.payload ?? { id: input.entityId },
    version: await getEntityVersion(
      client,
      input.table,
      input.idColumn ?? 'id',
      input.entityId,
      input.versioned === true
    )
  })
}

export class StorageV2LegacyAgentDbImportService {
  async importSnapshot(options: LegacyAgentDbSnapshotOptions = {}): Promise<StorageV2LegacyAgentDbImportReport> {
    const dryRun = options.dryRun !== false
    const shouldCreateSnapshot = !dryRun && options.createSnapshot !== false
    const shouldPruneMissing = options.pruneMissing !== false
    const sourceDbPath = firstExistingPath(candidateAgentDbPaths(options.dbPath))
    const warnings: string[] = []

    if (!sourceDbPath) {
      warnings.push('Legacy agent database was not found.')
      return this.emptyReport(dryRun, null, warnings)
    }

    const legacyClient = createClient({
      url: `file:${sourceDbPath}`,
      intMode: 'number'
    })

    try {
      const tables = await this.getTables(legacyClient)
      const rows = await this.readLegacyRows(legacyClient, tables)
      const secretCandidateCount = this.countChannelSecretCandidates(rows.channels)
      let importedSecretCount = 0
      let snapshotPath: string | undefined

      if (secretCandidateCount > 0 && dryRun) {
        warnings.push('Channel credentials were detected. Dry run did not write them to the Storage v2 secret vault.')
      } else if (secretCandidateCount > 0 && !storageV2SecretVaultService.isAvailable()) {
        warnings.push('Channel credentials were detected but safeStorage encryption is unavailable on this system.')
      }

      if (!dryRun) {
        snapshotPath = shouldCreateSnapshot
          ? (await storageV2Database.createSnapshot('before-legacy-agent-db-import')).path
          : undefined
        importedSecretCount = await withTransaction(async () =>
          this.writeRows(rows, tables, warnings, { pruneMissing: shouldPruneMissing })
        )
        await this.importSessionMessages(rows, tables, warnings, { pruneMissing: shouldPruneMissing })
        if (shouldPruneMissing && tables.has('sessions')) {
          await this.markMissingAgentSessionConversations(rows.sessions, warnings)
        }
      }

      return {
        dryRun,
        sourceDbPath,
        snapshotPath,
        agentCount: rows.agents.length,
        sessionCount: rows.sessions.length,
        sessionMessageCount: rows.session_messages.length,
        skillCount: rows.skills.length,
        agentSkillCount: rows.agent_skills.length,
        taskCount: rows.scheduled_tasks.length,
        taskRunLogCount: rows.task_run_logs.length,
        channelCount: rows.channels.length,
        channelTaskSubscriptionCount: rows.channel_task_subscriptions.length,
        importedAgentCount: dryRun ? 0 : rows.agents.length,
        importedSessionCount: dryRun ? 0 : rows.sessions.length,
        importedSessionMessageCount: dryRun ? 0 : rows.session_messages.length,
        importedSkillCount: dryRun ? 0 : rows.skills.length,
        importedAgentSkillCount: dryRun ? 0 : rows.agent_skills.length,
        importedTaskCount: dryRun ? 0 : rows.scheduled_tasks.length,
        importedTaskRunLogCount: dryRun ? 0 : rows.task_run_logs.length,
        importedChannelCount: dryRun ? 0 : rows.channels.length,
        importedChannelTaskSubscriptionCount: dryRun ? 0 : rows.channel_task_subscriptions.length,
        secretCandidateCount,
        importedSecretCount,
        skippedSecretCount: secretCandidateCount - importedSecretCount,
        warnings
      }
    } finally {
      legacyClient.close()
    }
  }

  private emptyReport(
    dryRun: boolean,
    sourceDbPath: string | null,
    warnings: string[]
  ): StorageV2LegacyAgentDbImportReport {
    return {
      dryRun,
      sourceDbPath,
      agentCount: 0,
      sessionCount: 0,
      sessionMessageCount: 0,
      skillCount: 0,
      agentSkillCount: 0,
      taskCount: 0,
      taskRunLogCount: 0,
      channelCount: 0,
      channelTaskSubscriptionCount: 0,
      importedAgentCount: 0,
      importedSessionCount: 0,
      importedSessionMessageCount: 0,
      importedSkillCount: 0,
      importedAgentSkillCount: 0,
      importedTaskCount: 0,
      importedTaskRunLogCount: 0,
      importedChannelCount: 0,
      importedChannelTaskSubscriptionCount: 0,
      secretCandidateCount: 0,
      importedSecretCount: 0,
      skippedSecretCount: 0,
      warnings
    }
  }

  private async getTables(client: ReturnType<typeof createClient>): Promise<LegacyAgentDbTableSet> {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    return new Set(
      result.rows
        .map((row) => String(row.name))
        .filter((table): table is (typeof LEGACY_TABLES)[number] =>
          LEGACY_TABLES.includes(table as (typeof LEGACY_TABLES)[number])
        )
    )
  }

  private async readLegacyRows(
    client: ReturnType<typeof createClient>,
    tables: LegacyAgentDbTableSet
  ): Promise<LegacyAgentDbRows> {
    const rows = Object.fromEntries(LEGACY_TABLES.map((table) => [table, [] as Row[]])) as LegacyAgentDbRows

    for (const table of LEGACY_TABLES) {
      if (!tables.has(table)) continue
      const result = await client.execute(`SELECT * FROM ${table}`)
      rows[table] = result.rows
    }

    return rows
  }

  private countChannelSecretCandidates(channels: Row[]) {
    return channels.reduce((count, channel) => {
      const config = parseJson(text(channel, 'config'))
      if (!config || typeof config !== 'object') return count
      const record = config as Record<string, unknown>
      return count + CHANNEL_SECRET_KEYS.filter((key) => typeof record[key] === 'string' && record[key]).length
    }, 0)
  }

  private async writeRows(
    rows: LegacyAgentDbRows,
    tables: LegacyAgentDbTableSet,
    warnings: string[],
    options: { pruneMissing?: boolean } = {}
  ) {
    const client = await storageV2Database.getClient()
    let importedSecretCount = 0
    const agentIds = new Set(rows.agents.map((row) => text(row, 'id')).filter((id): id is string => Boolean(id)))
    const skillIds = new Set(rows.skills.map((row) => text(row, 'id')).filter((id): id is string => Boolean(id)))
    const sessionIds = new Set(rows.sessions.map((row) => text(row, 'id')).filter((id): id is string => Boolean(id)))
    const taskIds = new Set(
      rows.scheduled_tasks.map((row) => text(row, 'id')).filter((id): id is string => Boolean(id))
    )
    const taskRunLogIds = new Set<string>()
    const channelIds = new Set(rows.channels.map((row) => text(row, 'id')).filter((id): id is string => Boolean(id)))
    const agentSkillKeys = new Set(
      rows.agent_skills
        .map((row) => {
          const agentId = text(row, 'agent_id')
          const skillId = text(row, 'skill_id')
          return agentId && skillId ? `${agentId}\u001f${skillId}` : null
        })
        .filter((key): key is string => Boolean(key))
    )
    const channelTaskSubscriptionKeys = new Set(
      rows.channel_task_subscriptions
        .map((row) => {
          const channelId = text(row, 'channel_id')
          const taskId = text(row, 'task_id')
          return channelId && taskId ? `${channelId}\u001f${taskId}` : null
        })
        .filter((key): key is string => Boolean(key))
    )
    const referencedAgentIds = new Set(
      [
        ...rows.sessions.map((row) => text(row, 'agent_id')),
        ...rows.scheduled_tasks.map((row) => text(row, 'agent_id')),
        ...rows.agent_skills.map((row) => text(row, 'agent_id'))
      ].filter((id): id is string => Boolean(id))
    )
    const needsMissingAgent =
      rows.sessions.some((row) => !text(row, 'agent_id')) || rows.scheduled_tasks.some((row) => !text(row, 'agent_id'))

    for (const agentId of referencedAgentIds) {
      if (agentIds.has(agentId)) continue
      await this.ensurePlaceholderAgent(agentId, warnings)
      agentIds.add(agentId)
    }

    if (needsMissingAgent && !agentIds.has('legacy-missing-agent')) {
      await this.ensurePlaceholderAgent('legacy-missing-agent', warnings)
      agentIds.add('legacy-missing-agent')
    }

    for (const skillId of rows.agent_skills.map((row) => text(row, 'skill_id'))) {
      if (!skillId || skillIds.has(skillId)) continue
      await this.ensurePlaceholderSkill(skillId, warnings)
      skillIds.add(skillId)
    }

    for (const [index, row] of rows.agents.entries()) {
      const id = requiredText(row, 'id', `legacy-agent-${index}`)
      const currentTime = now()
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
          id,
          requiredText(row, 'type', 'pi'),
          requiredText(row, 'name', id),
          text(row, 'description'),
          text(row, 'instructions'),
          requiredText(row, 'model', ''),
          text(row, 'plan_model'),
          text(row, 'small_model'),
          normalizeJson(text(row, 'accessible_paths')),
          normalizeJson(text(row, 'mcps')),
          normalizeJson(text(row, 'allowed_tools')),
          normalizeJson(text(row, 'configuration')),
          intValue(row, 'sort_order', index),
          timestamp(row.created_at, currentTime),
          timestamp(row.updated_at, currentTime),
          text(row, 'deleted_at')
        ]
      })
      await recordEntityChange(client, {
        table: 'agents',
        entityId: id,
        operation: text(row, 'deleted_at') ? 'delete' : 'upsert',
        payload: {
          id,
          type: requiredText(row, 'type', 'pi'),
          name: requiredText(row, 'name', id),
          deletedAt: text(row, 'deleted_at')
        },
        versioned: true
      })
    }

    for (const [index, row] of rows.sessions.entries()) {
      const id = requiredText(row, 'id', `legacy-session-${index}`)
      const currentTime = now()
      const currentConfig = {
        agentType: text(row, 'agent_type'),
        description: text(row, 'description'),
        accessiblePaths: parseJson(text(row, 'accessible_paths')),
        instructions: text(row, 'instructions'),
        model: text(row, 'model'),
        planModel: text(row, 'plan_model'),
        smallModel: text(row, 'small_model'),
        mcps: parseJson(text(row, 'mcps')),
        allowedTools: parseJson(text(row, 'allowed_tools')),
        slashCommands: parseJson(text(row, 'slash_commands')),
        configuration: parseJson(text(row, 'configuration'))
      }

      await client.execute({
        sql: `
          INSERT INTO agent_sessions (
            id, agent_id, name, inherited_config_json, current_config_json,
            sort_order, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            agent_id = excluded.agent_id,
            name = excluded.name,
            inherited_config_json = excluded.inherited_config_json,
            current_config_json = excluded.current_config_json,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = agent_sessions.version + 1
        `,
        args: [
          id,
          requiredText(row, 'agent_id', 'legacy-missing-agent'),
          requiredText(row, 'name', id),
          normalizeJson(text(row, 'configuration')),
          toJson(currentConfig),
          intValue(row, 'sort_order', index),
          timestamp(row.created_at, currentTime),
          timestamp(row.updated_at, currentTime)
        ]
      })
      await recordEntityChange(client, {
        table: 'agent_sessions',
        entityId: id,
        payload: {
          id,
          agentId: requiredText(row, 'agent_id', 'legacy-missing-agent'),
          name: requiredText(row, 'name', id)
        },
        versioned: true
      })
    }

    for (const [index, row] of rows.skills.entries()) {
      const id = requiredText(row, 'id', `legacy-skill-${index}`)
      const currentTime = now()
      await client.execute({
        sql: `
          INSERT INTO skills (
            id, name, description, folder_name, source, source_url, namespace, author, tags_json,
            content_hash, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            folder_name = excluded.folder_name,
            source = excluded.source,
            source_url = excluded.source_url,
            namespace = excluded.namespace,
            author = excluded.author,
            tags_json = excluded.tags_json,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = skills.version + 1
        `,
        args: [
          id,
          requiredText(row, 'name', id),
          text(row, 'description'),
          requiredText(row, 'folder_name', id),
          requiredText(row, 'source', 'local'),
          text(row, 'source_url'),
          text(row, 'namespace'),
          text(row, 'author'),
          normalizeJson(text(row, 'tags')),
          requiredText(row, 'content_hash', ''),
          timestamp(row.created_at, currentTime),
          timestamp(row.updated_at, currentTime)
        ]
      })
      await recordEntityChange(client, {
        table: 'skills',
        entityId: id,
        payload: {
          id,
          name: requiredText(row, 'name', id),
          folderName: requiredText(row, 'folder_name', id)
        },
        versioned: true
      })
    }

    for (const row of rows.agent_skills) {
      const agentId = text(row, 'agent_id')
      const skillId = text(row, 'skill_id')
      if (!agentId || !skillId) continue
      const currentTime = now()
      await client.execute({
        sql: `
          INSERT INTO agent_skills (agent_id, skill_id, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, skill_id) DO UPDATE SET
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `,
        args: [
          agentId,
          skillId,
          intValue(row, 'is_enabled', 0),
          timestamp(row.created_at, currentTime),
          timestamp(row.updated_at, currentTime)
        ]
      })
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'agent_skill',
        entityId: `${agentId}:${skillId}`,
        payload: {
          agentId,
          skillId,
          enabled: Boolean(intValue(row, 'is_enabled', 0))
        }
      })
    }

    for (const [index, row] of rows.scheduled_tasks.entries()) {
      const id = requiredText(row, 'id', `legacy-task-${index}`)
      const currentTime = now()
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
          id,
          requiredText(row, 'agent_id', 'legacy-missing-agent'),
          requiredText(row, 'name', id),
          requiredText(row, 'prompt', ''),
          requiredText(row, 'schedule_type', 'once'),
          requiredText(row, 'schedule_value', ''),
          intValue(row, 'timeout_minutes', 2),
          text(row, 'next_run'),
          text(row, 'last_run'),
          text(row, 'last_result'),
          requiredText(row, 'status', 'active'),
          timestamp(row.created_at, currentTime),
          timestamp(row.updated_at, currentTime)
        ]
      })
      await recordEntityChange(client, {
        table: 'scheduled_tasks',
        entityId: id,
        payload: {
          id,
          agentId: requiredText(row, 'agent_id', 'legacy-missing-agent'),
          name: requiredText(row, 'name', id),
          status: requiredText(row, 'status', 'active')
        },
        versioned: true
      })
    }

    for (const row of rows.task_run_logs) {
      const id = intValue(row, 'id', -1)
      const taskId = text(row, 'task_id')
      if (!taskId || !taskIds.has(taskId)) {
        warnings.push(`Skipped legacy task run log ${text(row, 'id') ?? 'unknown'}: missing scheduled task.`)
        continue
      }
      if (id < 0) {
        warnings.push(`Skipped legacy task run log ${text(row, 'id') ?? 'unknown'}: invalid id.`)
        continue
      }
      taskRunLogIds.add(String(id))

      await client.execute({
        sql: `
          INSERT INTO task_run_logs (id, task_id, session_id, run_at, duration_ms, status, result_json, error, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            task_id = excluded.task_id,
            session_id = excluded.session_id,
            run_at = excluded.run_at,
            duration_ms = excluded.duration_ms,
            status = excluded.status,
            result_json = excluded.result_json,
            error = excluded.error,
            version = task_run_logs.version + 1
        `,
        args: [
          id,
          taskId,
          text(row, 'session_id'),
          requiredText(row, 'run_at', now()),
          intValue(row, 'duration_ms'),
          requiredText(row, 'status', 'success'),
          normalizeJson(text(row, 'result')),
          text(row, 'error')
        ]
      })
      await recordEntityChange(client, {
        table: 'task_run_logs',
        entityId: String(id),
        payload: {
          id,
          taskId,
          status: requiredText(row, 'status', 'success')
        },
        versioned: true
      })
    }

    for (const [index, row] of rows.channels.entries()) {
      const id = requiredText(row, 'id', `legacy-channel-${index}`)
      const { configJson, importedSecrets } = await this.prepareChannelConfig(id, text(row, 'config'), warnings)
      importedSecretCount += importedSecrets
      const currentTime = now()
      const agentId = text(row, 'agent_id')
      const sessionId = text(row, 'session_id')
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
          id,
          requiredText(row, 'type', 'unknown'),
          requiredText(row, 'name', id),
          agentId && agentIds.has(agentId) ? agentId : null,
          sessionId && rows.sessions.some((session) => text(session, 'id') === sessionId) ? sessionId : null,
          configJson,
          intValue(row, 'is_active', 1),
          normalizeJson(text(row, 'active_chat_ids')),
          text(row, 'permission_mode'),
          timestamp(row.created_at, currentTime),
          timestamp(row.updated_at, currentTime)
        ]
      })
      await recordEntityChange(client, {
        table: 'channels',
        entityId: id,
        payload: {
          id,
          type: requiredText(row, 'type', 'unknown'),
          name: requiredText(row, 'name', id),
          agentId: agentId && agentIds.has(agentId) ? agentId : null,
          sessionId: sessionId && rows.sessions.some((session) => text(session, 'id') === sessionId) ? sessionId : null
        },
        versioned: true
      })
    }

    for (const row of rows.channel_task_subscriptions) {
      const channelId = text(row, 'channel_id')
      const taskId = text(row, 'task_id')
      if (!channelId || !taskId) continue
      if (!channelIds.has(channelId) || !taskIds.has(taskId)) {
        warnings.push(
          `Skipped channel task subscription ${channelId || 'unknown'}:${taskId || 'unknown'}: missing channel or task.`
        )
        continue
      }

      const currentTime = now()
      await client.execute({
        sql: `
          INSERT INTO channel_task_subscriptions (channel_id, task_id, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(channel_id, task_id) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
        args: [channelId, taskId, currentTime, currentTime]
      })
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'channel_task_subscription',
        entityId: `${channelId}:${taskId}`,
        payload: {
          channelId,
          taskId
        }
      })
    }

    if (options.pruneMissing !== false) {
      if (tables.has('agents')) {
        await this.markMissingEntityRowsDeleted(client, 'agents', 'id', agentIds, { versioned: true })
      }
      if (tables.has('sessions')) {
        await this.markMissingEntityRowsDeleted(client, 'agent_sessions', 'id', sessionIds, { versioned: true })
      }
      if (tables.has('skills')) {
        await this.markMissingEntityRowsDeleted(client, 'skills', 'id', skillIds, { versioned: true })
      }
      if (tables.has('scheduled_tasks')) {
        await this.markMissingEntityRowsDeleted(client, 'scheduled_tasks', 'id', taskIds, { versioned: true })
      }
      if (tables.has('channels')) {
        await this.markMissingEntityRowsDeleted(client, 'channels', 'id', channelIds, { versioned: true })
      }
      if (tables.has('agent_skills')) {
        await this.deleteMissingAgentSkillRows(client, agentSkillKeys)
      }
      if (tables.has('task_run_logs')) {
        await this.deleteMissingTaskRunLogRows(client, taskRunLogIds)
      }
      if (tables.has('channel_task_subscriptions')) {
        await this.deleteMissingChannelTaskSubscriptionRows(client, channelTaskSubscriptionKeys)
      }
    }

    return importedSecretCount
  }

  private async markMissingEntityRowsDeleted(
    client: ReturnType<typeof createClient>,
    table: 'agents' | 'agent_sessions' | 'skills' | 'scheduled_tasks' | 'channels',
    idColumn: string,
    ids: Set<string>,
    options: { versioned?: boolean } = {}
  ) {
    const currentTime = now()
    const versionSql = options.versioned ? ', version = version + 1' : ''
    const idsArray = Array.from(ids)
    const missingRows =
      ids.size === 0
        ? await client.execute({
            sql: `
              SELECT ${idColumn} AS id${options.versioned ? ', version' : ''}
              FROM ${table}
              WHERE deleted_at IS NULL
            `,
            args: []
          })
        : await client.execute({
            sql: `
              SELECT ${idColumn} AS id${options.versioned ? ', version' : ''}
              FROM ${table}
              WHERE deleted_at IS NULL AND ${idColumn} NOT IN (${idsArray.map(() => '?').join(', ')})
            `,
            args: idsArray
          })

    if (ids.size === 0) {
      await client.execute({
        sql: `
          UPDATE ${table}
          SET deleted_at = ?, updated_at = ?${versionSql}
          WHERE deleted_at IS NULL
        `,
        args: [currentTime, currentTime]
      })
    } else {
      await client.execute({
        sql: `
          UPDATE ${table}
          SET deleted_at = ?, updated_at = ?${versionSql}
          WHERE deleted_at IS NULL AND ${idColumn} NOT IN (${idsArray.map(() => '?').join(', ')})
        `,
        args: [currentTime, currentTime, ...idsArray]
      })
    }

    for (const row of missingRows.rows) {
      const entityId = text(row, 'id')
      if (!entityId) continue
      await storageV2SyncLogService.recordChange({
        client,
        entityType: ENTITY_TYPE_BY_TABLE[table],
        entityId,
        operation: 'delete',
        payload: {
          id: entityId,
          deletedAt: currentTime
        },
        version: options.versioned ? Number(row.version ?? 0) + 1 : 1
      })
    }
  }

  private async deleteMissingAgentSkillRows(client: ReturnType<typeof createClient>, agentSkillKeys: Set<string>) {
    const keysArray = Array.from(agentSkillKeys)
    const missingRows =
      agentSkillKeys.size === 0
        ? await client.execute('SELECT agent_id, skill_id FROM agent_skills')
        : await client.execute({
            sql: `
              SELECT agent_id, skill_id
              FROM agent_skills
              WHERE agent_id || char(31) || skill_id NOT IN (${keysArray.map(() => '?').join(', ')})
            `,
            args: keysArray
          })

    if (agentSkillKeys.size === 0) {
      await client.execute('DELETE FROM agent_skills')
    } else {
      await client.execute({
        sql: `
          DELETE FROM agent_skills
          WHERE agent_id || char(31) || skill_id NOT IN (${keysArray.map(() => '?').join(', ')})
        `,
        args: keysArray
      })
    }

    for (const row of missingRows.rows) {
      const agentId = text(row, 'agent_id')
      const skillId = text(row, 'skill_id')
      if (!agentId || !skillId) continue

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'agent_skill',
        entityId: `${agentId}:${skillId}`,
        operation: 'delete',
        payload: { agentId, skillId }
      })
    }
  }

  private async deleteMissingChannelTaskSubscriptionRows(
    client: ReturnType<typeof createClient>,
    subscriptionKeys: Set<string>
  ) {
    const keysArray = Array.from(subscriptionKeys)
    const missingRows =
      subscriptionKeys.size === 0
        ? await client.execute('SELECT channel_id, task_id FROM channel_task_subscriptions')
        : await client.execute({
            sql: `
              SELECT channel_id, task_id
              FROM channel_task_subscriptions
              WHERE channel_id || char(31) || task_id NOT IN (${keysArray.map(() => '?').join(', ')})
            `,
            args: keysArray
          })

    if (subscriptionKeys.size === 0) {
      await client.execute('DELETE FROM channel_task_subscriptions')
    } else {
      await client.execute({
        sql: `
          DELETE FROM channel_task_subscriptions
          WHERE channel_id || char(31) || task_id NOT IN (${keysArray.map(() => '?').join(', ')})
        `,
        args: keysArray
      })
    }

    for (const row of missingRows.rows) {
      const channelId = text(row, 'channel_id')
      const taskId = text(row, 'task_id')
      if (!channelId || !taskId) continue

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'channel_task_subscription',
        entityId: `${channelId}:${taskId}`,
        operation: 'delete',
        payload: { channelId, taskId }
      })
    }
  }

  private async deleteMissingTaskRunLogRows(client: ReturnType<typeof createClient>, taskRunLogIds: Set<string>) {
    const idsArray = Array.from(taskRunLogIds)
    const missingRows =
      taskRunLogIds.size === 0
        ? await client.execute('SELECT id, version FROM task_run_logs')
        : await client.execute({
            sql: `
              SELECT id, version
              FROM task_run_logs
              WHERE CAST(id AS TEXT) NOT IN (${idsArray.map(() => '?').join(', ')})
            `,
            args: idsArray
          })

    if (taskRunLogIds.size === 0) {
      await client.execute('DELETE FROM task_run_logs')
    } else {
      await client.execute({
        sql: `
          DELETE FROM task_run_logs
          WHERE CAST(id AS TEXT) NOT IN (${idsArray.map(() => '?').join(', ')})
        `,
        args: idsArray
      })
    }

    for (const row of missingRows.rows) {
      const id = text(row, 'id')
      if (!id) continue

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'task_run_log',
        entityId: id,
        operation: 'delete',
        payload: { id },
        version: Number(row.version ?? 0) + 1
      })
    }
  }

  private async ensurePlaceholderAgent(agentId: string, warnings: string[]) {
    const client = await storageV2Database.getClient()
    const currentTime = now()

    await client.execute({
      sql: `
        INSERT INTO agents (
          id, type, name, description, instructions, model_id, plan_model_id, small_model_id,
          accessible_paths_json, mcps_json, allowed_tools_json, configuration_json,
          sort_order, created_at, updated_at, deleted_at, version
        )
        VALUES (?, 'unknown', ?, 'Recovered placeholder for legacy references', NULL, '', NULL, NULL,
          '[]', '[]', '[]', '{}', 999999, ?, ?, NULL, 1)
        ON CONFLICT(id) DO NOTHING
      `,
      args: [agentId, agentId, currentTime, currentTime]
    })
    await recordEntityChange(client, {
      table: 'agents',
      entityId: agentId,
      payload: {
        id: agentId,
        type: 'unknown',
        placeholder: true
      },
      versioned: true
    })

    warnings.push(`Created placeholder agent ${agentId} because legacy rows referenced a missing agent.`)
  }

  private async ensurePlaceholderSkill(skillId: string, warnings: string[]) {
    const client = await storageV2Database.getClient()
    const currentTime = now()

    await client.execute({
      sql: `
        INSERT INTO skills (
          id, name, description, folder_name, source, source_url, namespace, author, tags_json,
          content_hash, created_at, updated_at, deleted_at, version
        )
        VALUES (?, ?, 'Recovered placeholder for legacy references', ?, 'local', NULL, NULL, NULL, '[]',
          '', ?, ?, NULL, 1)
        ON CONFLICT(id) DO NOTHING
      `,
      args: [skillId, skillId, `legacy-missing-${skillId}`, currentTime, currentTime]
    })
    await recordEntityChange(client, {
      table: 'skills',
      entityId: skillId,
      payload: {
        id: skillId,
        placeholder: true
      },
      versioned: true
    })

    warnings.push(`Created placeholder skill ${skillId} because legacy rows referenced a missing skill.`)
  }

  private async prepareChannelConfig(channelId: string, rawConfig: string | null, warnings: string[]) {
    const config = parseJson(rawConfig)
    if (!config || typeof config !== 'object') {
      return {
        configJson: normalizeJson(rawConfig),
        importedSecrets: 0
      }
    }

    const nextConfig = { ...(config as Record<string, unknown>) }
    let importedSecrets = 0

    for (const key of CHANNEL_SECRET_KEYS) {
      const value = nextConfig[key]
      if (typeof value !== 'string' || !value) continue

      if (storageV2SecretVaultService.isAvailable()) {
        const secretRef = await storageV2SecretVaultService.setSecret('channel', channelId, key, value)
        delete nextConfig[key]
        nextConfig[`${key}_secret_ref`] = secretRef
        importedSecrets++
      } else {
        delete nextConfig[key]
        nextConfig[`${key}_secret_unmigrated`] = true
        warnings.push(`Skipped secret field ${key} for channel ${channelId}: safeStorage is unavailable.`)
      }
    }

    return {
      configJson: toJson(nextConfig),
      importedSecrets
    }
  }

  private async importSessionMessages(
    rows: LegacyAgentDbRows,
    tables: LegacyAgentDbTableSet,
    warnings: string[],
    options: { pruneMissing?: boolean } = {}
  ) {
    if (!tables.has('session_messages')) {
      return
    }

    const sessionsById = new Map(rows.sessions.map((session) => [text(session, 'id'), session]))
    const messagesBySessionId = new Map<string, Row[]>()

    for (const row of rows.session_messages) {
      const sessionId = text(row, 'session_id')
      if (!sessionId) {
        warnings.push(`Skipped legacy session message ${text(row, 'id') ?? 'unknown'}: missing session id.`)
        continue
      }
      const messages = messagesBySessionId.get(sessionId) ?? []
      messages.push(row)
      messagesBySessionId.set(sessionId, messages)
    }

    const importedSessionIds = new Set<string>()
    for (const row of rows.sessions) {
      const sessionId = text(row, 'id')
      if (!sessionId) continue
      importedSessionIds.add(sessionId)
      const conversation = this.toConversationImport(sessionId, row, messagesBySessionId.get(sessionId) ?? [])
      await storageV2ConversationRepository.importConversation(conversation, {
        pruneMissingMessages: options.pruneMissing !== false,
        pruneMissingBlocks: options.pruneMissing !== false
      })
    }

    for (const [sessionId, messages] of messagesBySessionId.entries()) {
      if (importedSessionIds.has(sessionId)) continue
      const session = sessionsById.get(sessionId)
      const conversation = this.toConversationImport(sessionId, session, messages)
      await storageV2ConversationRepository.importConversation(conversation, {
        pruneMissingMessages: options.pruneMissing !== false,
        pruneMissingBlocks: options.pruneMissing !== false
      })
    }
  }

  private async markMissingAgentSessionConversations(rows: Row[], warnings: string[]) {
    const sessionIds = new Set(rows.map((row) => text(row, 'id')).filter((id): id is string => Boolean(id)))
    const client = await storageV2Database.getClient()
    const sessionIdList = Array.from(sessionIds)
    const staleConversations =
      sessionIdList.length === 0
        ? await client.execute(`
            SELECT id
            FROM conversations
            WHERE kind = 'agent_session' AND deleted_at IS NULL
          `)
        : await client.execute({
            sql: `
              SELECT id
              FROM conversations
              WHERE kind = 'agent_session'
                AND deleted_at IS NULL
                AND (session_id IS NULL OR session_id NOT IN (${sessionIdList.map(() => '?').join(', ')}))
            `,
            args: sessionIdList
          })

    let deletedCount = 0
    for (const row of staleConversations.rows) {
      const conversationId = text(row, 'id')
      if (!conversationId) continue

      const result = await storageV2ConversationRepository.delete(conversationId)
      if (result.deleted) {
        deletedCount++
      }
    }

    if (deletedCount > 0) {
      warnings.push(`Marked ${deletedCount} stale Storage v2 agent conversation(s) as deleted.`)
    }
  }

  private toConversationImport(
    sessionId: string,
    session: Row | null | undefined,
    rows: Row[]
  ): StorageV2ConversationImport {
    const conversationId = `agent-session:${sessionId}`
    const createdAt = timestamp(session?.created_at, now())
    const updatedAt = timestamp(session?.updated_at, createdAt)
    const sessionRow = session ?? ({} as Row)

    return {
      id: conversationId,
      kind: 'agent_session',
      ownerType: 'agent',
      ownerId: text(sessionRow, 'agent_id') ?? 'unknown',
      sessionId,
      title: text(sessionRow, 'name') ?? sessionId,
      createdAt,
      updatedAt,
      messages: rows.map((row, index) => {
        const messageId = `agent-message:${text(row, 'id') ?? `${sessionId}:${index}`}`
        return {
          id: messageId,
          role: requiredText(row, 'role', 'agent'),
          status: null,
          metadata: {
            legacyId: text(row, 'id'),
            agentSessionId: text(row, 'agent_session_id'),
            metadata: parseJson(text(row, 'metadata'))
          },
          createdAt: timestamp(row.created_at, createdAt),
          updatedAt: timestamp(row.updated_at, updatedAt)
        }
      }),
      blocks: rows.map((row, index) => {
        const messageId = `agent-message:${text(row, 'id') ?? `${sessionId}:${index}`}`
        return {
          id: `agent-message-block:${text(row, 'id') ?? `${sessionId}:${index}`}`,
          messageId,
          type: 'agent_session_entry',
          content: extractAgentSessionText(text(row, 'content')),
          payload: {
            content: parseJson(text(row, 'content')),
            metadata: parseJson(text(row, 'metadata'))
          },
          createdAt: timestamp(row.created_at, createdAt),
          updatedAt: timestamp(row.updated_at, updatedAt)
        }
      })
    }
  }
}

export const storageV2LegacyAgentDbImportService = new StorageV2LegacyAgentDbImportService()
