import fs from 'node:fs'
import path from 'node:path'

import type { Client, Row } from '@libsql/client'
import { loggerService } from '@logger'
import { DatabaseManager } from '@main/services/agents/database/DatabaseManager'
import { getDataPath } from '@main/utils'

import { storageV2DataRootService } from './DataRootService'
import { getAvailablePathSync, movePathSync } from './SafeFileMove'
import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2Database } from './StorageV2Database'

export type StorageV2AgentLegacyProjectionReport = {
  agentDbPath: string
  archivedFiles: string[]
  projectedAgentCount: number
  projectedPlaceholderAgentCount: number
  projectedSessionCount: number
  projectedSessionMessageCount: number
  projectedSkillCount: number
  projectedPlaceholderSkillCount: number
  projectedAgentSkillCount: number
  projectedTaskCount: number
  projectedTaskRunLogCount: number
  projectedChannelCount: number
  projectedChannelTaskSubscriptionCount: number
  skippedSessionCount: number
  skippedSessionMessageCount: number
  skippedAgentSkillCount: number
  skippedTaskCount: number
  skippedTaskRunLogCount: number
  skippedChannelCount: number
  skippedChannelTaskSubscriptionCount: number
  restoredChannelSecretCount: number
  missingChannelSecretCount: number
  warnings: string[]
}

const LEGACY_DELETE_ORDER = [
  'channel_task_subscriptions',
  'session_messages',
  'task_run_logs',
  'channels',
  'agent_skills',
  'scheduled_tasks',
  'sessions',
  'skills',
  'agents'
] as const

const CHANNEL_SECRET_KEYS = [
  'app_secret',
  'app_token',
  'bot_token',
  'client_secret',
  'encrypt_key',
  'verification_token'
] as const

const SUPPORTED_CHANNEL_TYPES = new Set(['telegram', 'feishu', 'qq', 'wechat', 'discord', 'slack'])
const SUPPORTED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'])

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function text(row: Row | null | undefined, key: string): string | null {
  const value = row?.[key]
  return value == null ? null : String(value)
}

function requiredText(row: Row | null | undefined, key: string, fallback: string): string {
  return text(row, key) ?? fallback
}

function intValue(row: Row | null | undefined, key: string, fallback = 0): number {
  const value = row?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value as T

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function normalizeJson(value: unknown, fallback: unknown) {
  return toJson(parseJson(value, fallback) ?? fallback)
}

function textFromRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

function valueFromRecord(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key]
    }
  }
  return undefined
}

function isoTimestamp(value: unknown, fallback = new Date().toISOString()): string {
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

function epochMs(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.length >= 10) return numeric

    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function readRows(client: Client, sql: string, args: Array<string | number | null> = []): Promise<Row[]> {
  const result = await client.execute({ sql, args })
  return result.rows
}

async function withTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.execute('BEGIN IMMEDIATE')
  try {
    const result = await fn()
    await client.execute('COMMIT')
    return result
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {})
    throw error
  }
}

function archiveFileIfExists(source: string, archiveRoot: string, userDataPath: string) {
  if (!fs.existsSync(source)) return null

  const relativePath = path.relative(userDataPath, source)
  const safeRelativePath = relativePath.startsWith('..') ? path.basename(source) : relativePath
  const target = getAvailablePathSync(path.join(archiveRoot, 'agent-runtime', safeRelativePath))

  movePathSync(source, target)
  return target
}

function getLegacyAgentDbPaths() {
  const dataRoot = getDataPath()
  const userDataPath = path.dirname(dataRoot)
  return {
    userDataPath,
    currentPath: path.join(dataRoot, 'agents.db'),
    oldPath: path.join(userDataPath, 'agents.db')
  }
}

function isAgentPersistedMessage(value: unknown): value is Record<string, unknown> & { blocks: unknown[] } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).message &&
      Array.isArray((value as Record<string, unknown>).blocks)
  )
}

function getMessagePayload(row: Row) {
  return parseJson<Record<string, any>>(row.metadata_json, {})
}

function getBlockPayload(row: Row) {
  return parseJson<Record<string, any>>(row.payload_json, {})
}

function getOriginalSessionContent(message: Row, blocks: Row[], agentId: string, sessionId: string) {
  for (const block of blocks) {
    const blockPayload = getBlockPayload(block)
    const nestedContent = blockPayload.payload?.content
    if (isAgentPersistedMessage(nestedContent)) {
      return toJson(nestedContent)
    }

    if (isAgentPersistedMessage(blockPayload)) {
      return toJson(blockPayload)
    }
  }

  const messagePayload = getMessagePayload(message)
  if (isAgentPersistedMessage(messagePayload)) {
    return toJson(messagePayload)
  }

  const normalizedBlocks = blocks.map((block, blockIndex) => {
    const blockPayload = getBlockPayload(block)
    if (blockPayload.id || blockPayload.type || blockPayload.messageId) {
      return {
        ...blockPayload,
        id: blockPayload.id ?? text(block, 'id') ?? `${text(message, 'id')}:block:${blockIndex}`,
        messageId: blockPayload.messageId ?? text(message, 'id'),
        type: blockPayload.type ?? text(block, 'type') ?? 'main_text',
        content: blockPayload.content ?? text(block, 'text') ?? ''
      }
    }

    return {
      id: text(block, 'id') ?? `${text(message, 'id')}:block:${blockIndex}`,
      messageId: text(message, 'id'),
      type: text(block, 'type') ?? 'main_text',
      content: text(block, 'text') ?? '',
      createdAt: text(block, 'created_at') ?? text(message, 'created_at'),
      updatedAt: text(block, 'updated_at') ?? text(message, 'updated_at'),
      status: 'success'
    }
  })
  const messageId = text(message, 'id') ?? `agent-message:${sessionId}:${text(message, 'created_at') ?? Date.now()}`

  return toJson({
    message: {
      ...messagePayload,
      id: messagePayload.id ?? messageId,
      role: text(message, 'role') ?? 'assistant',
      assistantId: messagePayload.assistantId ?? agentId,
      topicId: messagePayload.topicId ?? `agent-session:${sessionId}`,
      createdAt: messagePayload.createdAt ?? text(message, 'created_at'),
      updatedAt: messagePayload.updatedAt ?? text(message, 'updated_at'),
      status: messagePayload.status ?? text(message, 'status') ?? 'success',
      blocks: Array.isArray(messagePayload.blocks) ? messagePayload.blocks : normalizedBlocks.map((block) => block.id)
    },
    blocks: normalizedBlocks
  })
}

function getOriginalSessionMetadata(message: Row, blocks: Row[]) {
  const messagePayload = getMessagePayload(message)
  const nestedMessageMetadata = messagePayload.metadata

  if (nestedMessageMetadata && typeof nestedMessageMetadata === 'object') {
    const record = nestedMessageMetadata as Record<string, unknown>
    if (record.metadata !== undefined) return toJson(record.metadata)
  }

  for (const block of blocks) {
    const blockPayload = getBlockPayload(block)
    const nestedMetadata = blockPayload.payload?.metadata
    if (nestedMetadata !== undefined) return toJson(nestedMetadata)
  }

  return nestedMessageMetadata ? toJson(nestedMessageMetadata) : null
}

function getOriginalAgentSessionId(message: Row) {
  const messagePayload = getMessagePayload(message)
  const metadata = messagePayload.metadata
  if (metadata && typeof metadata === 'object' && typeof metadata.agentSessionId === 'string') {
    return metadata.agentSessionId
  }
  if (typeof messagePayload.agentSessionId === 'string') {
    return messagePayload.agentSessionId
  }
  return ''
}

function getLegacyMessageIntegerId(message: Row, usedIds: Set<number>) {
  const messagePayload = getMessagePayload(message)
  const metadata = messagePayload.metadata
  const candidates = [
    metadata && typeof metadata === 'object' ? metadata.legacyId : undefined,
    typeof messagePayload.legacyId === 'string' ? messagePayload.legacyId : undefined,
    text(message, 'id')?.replace(/^agent-message:/, '')
  ]

  for (const candidate of candidates) {
    const numeric = Number(candidate)
    if (Number.isSafeInteger(numeric) && numeric > 0 && !usedIds.has(numeric)) {
      usedIds.add(numeric)
      return numeric
    }
  }

  return null
}

function emptyReport(agentDbPath: string): StorageV2AgentLegacyProjectionReport {
  return {
    agentDbPath,
    archivedFiles: [],
    projectedAgentCount: 0,
    projectedPlaceholderAgentCount: 0,
    projectedSessionCount: 0,
    projectedSessionMessageCount: 0,
    projectedSkillCount: 0,
    projectedPlaceholderSkillCount: 0,
    projectedAgentSkillCount: 0,
    projectedTaskCount: 0,
    projectedTaskRunLogCount: 0,
    projectedChannelCount: 0,
    projectedChannelTaskSubscriptionCount: 0,
    skippedSessionCount: 0,
    skippedSessionMessageCount: 0,
    skippedAgentSkillCount: 0,
    skippedTaskCount: 0,
    skippedTaskRunLogCount: 0,
    skippedChannelCount: 0,
    skippedChannelTaskSubscriptionCount: 0,
    restoredChannelSecretCount: 0,
    missingChannelSecretCount: 0,
    warnings: []
  }
}

export class StorageV2AgentLegacyProjectionService {
  private logger = loggerService.withContext('StorageV2AgentLegacyProjectionService')

  async projectToLegacyRuntime(options: { archiveRoot?: string } = {}): Promise<StorageV2AgentLegacyProjectionReport> {
    const { userDataPath, currentPath, oldPath } = getLegacyAgentDbPaths()
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const archiveRoot =
      options.archiveRoot ?? path.join(rootInfo.dataRoot, 'legacy', `agent-projection-${timestampForFilename()}`)
    const report = emptyReport(currentPath)

    await DatabaseManager.close()

    for (const dbPath of [currentPath, oldPath]) {
      for (const suffix of ['', '-wal', '-shm']) {
        const archivedFile = archiveFileIfExists(`${dbPath}${suffix}`, archiveRoot, userDataPath)
        if (archivedFile) {
          report.archivedFiles.push(archivedFile)
        }
      }
    }

    const dbManager = await DatabaseManager.getInstance()
    const targetClient = await dbManager.getClient()
    const storageClient = await storageV2Database.getClient()

    await withTransaction(targetClient, async () => {
      await this.resetLegacyTables(targetClient)
      await this.projectRows(storageClient, targetClient, report)
    })

    this.logger.info('Projected Storage v2 agent data to legacy runtime database', {
      agentDbPath: report.agentDbPath,
      agentCount: report.projectedAgentCount,
      sessionCount: report.projectedSessionCount,
      sessionMessageCount: report.projectedSessionMessageCount
    })

    return report
  }

  private async resetLegacyTables(client: Client) {
    await client.execute('PRAGMA foreign_keys = ON')
    for (const table of LEGACY_DELETE_ORDER) {
      await client.execute(`DELETE FROM ${table}`)
    }
    await client
      .execute("DELETE FROM sqlite_sequence WHERE name IN ('session_messages', 'task_run_logs')")
      .catch(() => {})
  }

  private async projectRows(storageClient: Client, targetClient: Client, report: StorageV2AgentLegacyProjectionReport) {
    const [agents, sessions, skills, agentSkills, tasks, taskRunLogs, channels, channelTaskSubscriptions] =
      await Promise.all([
        readRows(storageClient, 'SELECT * FROM agents ORDER BY sort_order ASC, created_at ASC'),
        readRows(
          storageClient,
          'SELECT * FROM agent_sessions WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC'
        ),
        readRows(storageClient, 'SELECT * FROM skills WHERE deleted_at IS NULL ORDER BY name ASC'),
        readRows(storageClient, 'SELECT * FROM agent_skills ORDER BY agent_id ASC, skill_id ASC'),
        readRows(
          storageClient,
          'SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY next_run ASC, created_at ASC'
        ),
        readRows(storageClient, 'SELECT * FROM task_run_logs ORDER BY run_at ASC, id ASC'),
        readRows(storageClient, 'SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY created_at ASC'),
        readRows(storageClient, 'SELECT * FROM channel_task_subscriptions ORDER BY channel_id ASC, task_id ASC')
      ])

    const agentIds = new Set<string>()
    const visibleAgentIds = new Set<string>()
    const agentTypeById = new Map<string, string>()

    for (const row of agents) {
      const id = requiredText(row, 'id', '')
      if (!id) continue
      agentIds.add(id)
      const deletedAt = text(row, 'deleted_at')
      if (!deletedAt) {
        visibleAgentIds.add(id)
        agentTypeById.set(id, requiredText(row, 'type', 'pi'))
      }

      await targetClient.execute({
        sql: `
          INSERT INTO agents (
            id, type, name, description, deleted_at, accessible_paths, instructions,
            model, plan_model, small_model, mcps, allowed_tools, configuration,
            sort_order, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          id,
          requiredText(row, 'type', 'pi'),
          requiredText(row, 'name', id),
          text(row, 'description'),
          deletedAt,
          normalizeJson(text(row, 'accessible_paths_json'), []),
          text(row, 'instructions'),
          requiredText(row, 'model_id', ''),
          text(row, 'plan_model_id'),
          text(row, 'small_model_id'),
          normalizeJson(text(row, 'mcps_json'), []),
          normalizeJson(text(row, 'allowed_tools_json'), []),
          normalizeJson(text(row, 'configuration_json'), {}),
          intValue(row, 'sort_order'),
          requiredText(row, 'created_at', new Date().toISOString()),
          requiredText(row, 'updated_at', new Date().toISOString())
        ]
      })
      report.projectedAgentCount++
    }

    const referencedAgentIds = new Set(
      [
        ...sessions.map((row) => text(row, 'agent_id')),
        ...tasks.map((row) => text(row, 'agent_id')),
        ...agentSkills.map((row) => text(row, 'agent_id'))
      ].filter((id): id is string => Boolean(id))
    )

    for (const agentId of referencedAgentIds) {
      if (visibleAgentIds.has(agentId) || agentIds.has(agentId)) continue
      await this.insertPlaceholderAgent(targetClient, agentId)
      agentIds.add(agentId)
      visibleAgentIds.add(agentId)
      agentTypeById.set(agentId, 'unknown')
      report.projectedPlaceholderAgentCount++
      report.warnings.push(`Created placeholder agent ${agentId} for orphaned Storage v2 references.`)
    }

    const sessionIds = new Set<string>()
    for (const row of sessions) {
      const id = requiredText(row, 'id', '')
      const agentId = requiredText(row, 'agent_id', '')
      if (!id || !agentId || !visibleAgentIds.has(agentId)) {
        report.skippedSessionCount++
        report.warnings.push(`Skipped agent session ${id || 'unknown'} because its agent is missing.`)
        continue
      }

      const currentConfig = parseJson<Record<string, unknown>>(text(row, 'current_config_json'), {})
      const inheritedConfig = parseJson<Record<string, unknown>>(text(row, 'inherited_config_json'), {})
      const fallbackAgent = agents.find((agent) => text(agent, 'id') === agentId)
      const now = new Date().toISOString()

      await targetClient.execute({
        sql: `
          INSERT INTO sessions (
            id, agent_type, agent_id, name, description, accessible_paths, instructions,
            model, plan_model, small_model, mcps, allowed_tools, slash_commands,
            configuration, sort_order, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          id,
          textFromRecord(currentConfig, ['agentType', 'agent_type']) ?? agentTypeById.get(agentId) ?? 'pi',
          agentId,
          requiredText(row, 'name', id),
          textFromRecord(currentConfig, ['description']),
          normalizeJson(valueFromRecord(currentConfig, ['accessiblePaths', 'accessible_paths']), []),
          textFromRecord(currentConfig, ['instructions']) ?? text(fallbackAgent, 'instructions'),
          textFromRecord(currentConfig, ['model']) ?? text(fallbackAgent, 'model_id') ?? '',
          textFromRecord(currentConfig, ['planModel', 'plan_model']) ?? text(fallbackAgent, 'plan_model_id'),
          textFromRecord(currentConfig, ['smallModel', 'small_model']) ?? text(fallbackAgent, 'small_model_id'),
          normalizeJson(valueFromRecord(currentConfig, ['mcps']), []),
          normalizeJson(valueFromRecord(currentConfig, ['allowedTools', 'allowed_tools']), []),
          normalizeJson(valueFromRecord(currentConfig, ['slashCommands', 'slash_commands']), []),
          normalizeJson(valueFromRecord(currentConfig, ['configuration']) ?? inheritedConfig, {}),
          intValue(row, 'sort_order'),
          isoTimestamp(row.created_at, now),
          isoTimestamp(row.updated_at, now)
        ]
      })
      sessionIds.add(id)
      report.projectedSessionCount++
    }

    const skillIds = new Set<string>()
    const skillFolderNames = new Set<string>()
    for (const row of skills) {
      const id = requiredText(row, 'id', '')
      const folderName = requiredText(row, 'folder_name', id)
      if (!id || !folderName || skillFolderNames.has(folderName)) {
        report.warnings.push(`Skipped skill ${id || 'unknown'} because its folder name is duplicated or missing.`)
        continue
      }

      await this.insertSkill(targetClient, row, id, folderName, true)
      skillIds.add(id)
      skillFolderNames.add(folderName)
      report.projectedSkillCount++
    }

    for (const row of agentSkills) {
      const agentId = text(row, 'agent_id')
      const skillId = text(row, 'skill_id')
      if (!agentId || !skillId || !visibleAgentIds.has(agentId)) {
        report.skippedAgentSkillCount++
        continue
      }

      if (!skillIds.has(skillId)) {
        const folderName = `storage-v2-missing-${skillId}`
        if (!skillFolderNames.has(folderName)) {
          await this.insertPlaceholderSkill(targetClient, skillId, folderName)
          skillIds.add(skillId)
          skillFolderNames.add(folderName)
          report.projectedPlaceholderSkillCount++
          report.warnings.push(`Created placeholder skill ${skillId} for orphaned Storage v2 references.`)
        }
      }

      await targetClient.execute({
        sql: `
          INSERT INTO agent_skills (agent_id, skill_id, is_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [agentId, skillId, intValue(row, 'enabled', 0), epochMs(row.created_at), epochMs(row.updated_at)]
      })
      report.projectedAgentSkillCount++
    }

    const taskIds = new Set<string>()
    for (const row of tasks) {
      const id = requiredText(row, 'id', '')
      const agentId = requiredText(row, 'agent_id', '')
      if (!id || !agentId || !visibleAgentIds.has(agentId)) {
        report.skippedTaskCount++
        continue
      }

      await targetClient.execute({
        sql: `
          INSERT INTO scheduled_tasks (
            id, agent_id, name, prompt, schedule_type, schedule_value, timeout_minutes,
            next_run, last_run, last_result, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          id,
          agentId,
          requiredText(row, 'name', id),
          requiredText(row, 'prompt', ''),
          requiredText(row, 'schedule_type', 'once'),
          requiredText(row, 'schedule_value', ''),
          intValue(row, 'timeout_minutes', 2),
          text(row, 'next_run'),
          text(row, 'last_run'),
          text(row, 'last_result'),
          requiredText(row, 'status', 'active'),
          requiredText(row, 'created_at', new Date().toISOString()),
          requiredText(row, 'updated_at', new Date().toISOString())
        ]
      })
      taskIds.add(id)
      report.projectedTaskCount++
    }

    for (const row of taskRunLogs) {
      const taskId = text(row, 'task_id')
      if (!taskId || !taskIds.has(taskId)) {
        report.skippedTaskRunLogCount++
        continue
      }

      await targetClient.execute({
        sql: `
          INSERT INTO task_run_logs (id, task_id, session_id, run_at, duration_ms, status, result, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          intValue(row, 'id'),
          taskId,
          text(row, 'session_id'),
          requiredText(row, 'run_at', new Date().toISOString()),
          intValue(row, 'duration_ms'),
          requiredText(row, 'status', 'success'),
          text(row, 'result_json'),
          text(row, 'error')
        ]
      })
      report.projectedTaskRunLogCount++
    }

    const projectedChannelIds = new Set<string>()
    for (const row of channels) {
      const type = requiredText(row, 'type', '')
      const channelId = requiredText(row, 'id', `${type}-${Date.now()}`)
      if (!SUPPORTED_CHANNEL_TYPES.has(type)) {
        report.skippedChannelCount++
        report.warnings.push(
          `Skipped channel ${channelId || 'unknown'} because type ${type || 'unknown'} is unsupported.`
        )
        continue
      }

      const permissionMode = text(row, 'permission_mode')
      const restoredConfig = await this.restoreChannelConfig(type, channelId, text(row, 'config_json'), report)
      const sessionId = text(row, 'session_id')
      const agentId = text(row, 'agent_id')

      await targetClient.execute({
        sql: `
          INSERT INTO channels (
            id, type, name, agent_id, session_id, config, is_active,
            active_chat_ids, permission_mode, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          channelId,
          type,
          requiredText(row, 'name', type),
          agentId && visibleAgentIds.has(agentId) ? agentId : null,
          sessionId && sessionIds.has(sessionId) ? sessionId : null,
          restoredConfig,
          intValue(row, 'is_active', 1),
          normalizeJson(text(row, 'active_chat_ids_json'), []),
          permissionMode && SUPPORTED_PERMISSION_MODES.has(permissionMode) ? permissionMode : null,
          epochMs(row.created_at),
          epochMs(row.updated_at)
        ]
      })
      projectedChannelIds.add(channelId)
      report.projectedChannelCount++
    }

    for (const row of channelTaskSubscriptions) {
      const channelId = text(row, 'channel_id')
      const taskId = text(row, 'task_id')
      if (!channelId || !taskId || !projectedChannelIds.has(channelId) || !taskIds.has(taskId)) {
        report.skippedChannelTaskSubscriptionCount++
        continue
      }

      await targetClient.execute({
        sql: `
          INSERT INTO channel_task_subscriptions (channel_id, task_id)
          VALUES (?, ?)
        `,
        args: [channelId, taskId]
      })
      report.projectedChannelTaskSubscriptionCount++
    }

    await this.projectSessionMessages(storageClient, targetClient, sessionIds, report)
  }

  private async insertPlaceholderAgent(client: Client, agentId: string) {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO agents (
          id, type, name, description, deleted_at, accessible_paths, instructions,
          model, plan_model, small_model, mcps, allowed_tools, configuration,
          sort_order, created_at, updated_at
        )
        VALUES (?, 'unknown', ?, 'Recovered placeholder for Storage v2 references', NULL,
          '[]', NULL, '', NULL, NULL, '[]', '[]', '{}', 999999, ?, ?)
      `,
      args: [agentId, agentId, now, now]
    })
  }

  private async insertSkill(client: Client, row: Row, id: string, folderName: string, enabled: boolean) {
    await client.execute({
      sql: `
        INSERT INTO skills (
          id, name, description, folder_name, source, source_url, namespace, author,
          tags, content_hash, is_enabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        requiredText(row, 'name', id),
        text(row, 'description'),
        folderName,
        requiredText(row, 'source', 'local'),
        text(row, 'source_url'),
        text(row, 'namespace'),
        text(row, 'author'),
        normalizeJson(text(row, 'tags_json'), []),
        requiredText(row, 'content_hash', ''),
        enabled ? 1 : 0,
        epochMs(row.created_at),
        epochMs(row.updated_at)
      ]
    })
  }

  private async insertPlaceholderSkill(client: Client, skillId: string, folderName: string) {
    const now = Date.now()
    await client.execute({
      sql: `
        INSERT INTO skills (
          id, name, description, folder_name, source, source_url, namespace, author,
          tags, content_hash, is_enabled, created_at, updated_at
        )
        VALUES (?, ?, 'Recovered placeholder for Storage v2 references', ?, 'local',
          NULL, NULL, NULL, '[]', '', 0, ?, ?)
      `,
      args: [skillId, skillId, folderName, now, now]
    })
  }

  private async restoreChannelConfig(
    type: string,
    channelId: string,
    rawConfig: string | null,
    report: StorageV2AgentLegacyProjectionReport
  ) {
    const config = parseJson<Record<string, unknown>>(rawConfig, {})
    const nextConfig = config && typeof config === 'object' ? { ...config } : {}
    nextConfig.type = typeof nextConfig.type === 'string' ? nextConfig.type : type

    for (const key of CHANNEL_SECRET_KEYS) {
      const refKey = `${key}_secret_ref`
      const secretRef = nextConfig[refKey]
      if (typeof secretRef !== 'string' || !secretRef) continue

      const secret = await storageV2SecretVaultService.getSecret(secretRef)
      if (secret) {
        nextConfig[key] = secret
        report.restoredChannelSecretCount++
      } else {
        report.missingChannelSecretCount++
        report.warnings.push(`Channel ${channelId} is missing restored secret ${key}.`)
      }
      delete nextConfig[refKey]
    }

    return toJson(nextConfig)
  }

  private async projectSessionMessages(
    storageClient: Client,
    targetClient: Client,
    sessionIds: Set<string>,
    report: StorageV2AgentLegacyProjectionReport
  ) {
    const messages = await readRows(
      storageClient,
      `
        SELECT
          m.*,
          c.session_id AS legacy_session_id,
          c.owner_id AS legacy_agent_id
        FROM messages m
        INNER JOIN conversations c ON c.id = m.conversation_id
        WHERE c.kind = 'agent_session'
          AND c.deleted_at IS NULL
          AND m.deleted_at IS NULL
          AND c.session_id IS NOT NULL
        ORDER BY c.session_id ASC, m.created_at ASC, m.id ASC
      `
    )

    const messageIds = messages.map((row) => String(row.id))
    const blocksByMessageId = new Map<string, Row[]>()

    for (const chunk of chunkArray(messageIds, 800)) {
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(', ')
      const blocks = await readRows(
        storageClient,
        `
          SELECT *
          FROM message_blocks
          WHERE deleted_at IS NULL AND message_id IN (${placeholders})
          ORDER BY message_id ASC, ordinal ASC, created_at ASC
        `,
        chunk
      )

      for (const block of blocks) {
        const messageId = String(block.message_id)
        const messageBlocks = blocksByMessageId.get(messageId) ?? []
        messageBlocks.push(block)
        blocksByMessageId.set(messageId, messageBlocks)
      }
    }

    const usedLegacyIds = new Set<number>()
    for (const message of messages) {
      const sessionId = text(message, 'legacy_session_id')
      const agentId = text(message, 'legacy_agent_id') ?? 'unknown'
      if (!sessionId || !sessionIds.has(sessionId)) {
        report.skippedSessionMessageCount++
        continue
      }

      const blocks = blocksByMessageId.get(String(message.id)) ?? []
      const legacyId = getLegacyMessageIntegerId(message, usedLegacyIds)
      const baseArgs = [
        sessionId,
        requiredText(message, 'role', 'assistant'),
        getOriginalSessionContent(message, blocks, agentId, sessionId),
        getOriginalAgentSessionId(message),
        getOriginalSessionMetadata(message, blocks),
        requiredText(message, 'created_at', new Date().toISOString()),
        requiredText(message, 'updated_at', new Date().toISOString())
      ]

      if (legacyId) {
        await targetClient.execute({
          sql: `
            INSERT INTO session_messages (
              id, session_id, role, content, agent_session_id, metadata, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: [legacyId, ...baseArgs]
        })
      } else {
        await targetClient.execute({
          sql: `
            INSERT INTO session_messages (
              session_id, role, content, agent_session_id, metadata, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          args: baseArgs
        })
      }

      report.projectedSessionMessageCount++
    }
  }
}

export const storageV2AgentLegacyProjectionService = new StorageV2AgentLegacyProjectionService()
