import { loggerService } from '@logger'
import { DatabaseManager } from '@main/services/agents/database/DatabaseManager'

import { storageV2AgentLegacyProjectionService } from './AgentLegacyProjectionService'
import { storageV2LegacyAgentDbImportService } from './LegacyAgentDbImportService'
import { storageV2Database } from './StorageV2Database'

const logger = loggerService.withContext('StorageV2AgentRuntimeRecoveryService')

function countFromRow(row: Record<string, unknown> | undefined): number {
  const value = row?.count
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export class StorageV2AgentRuntimeRecoveryService {
  private projection: Promise<boolean> | null = null
  private legacySeed: Promise<boolean> | null = null

  async projectIfLegacyAgentListEmpty(reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => {
      const legacyAgentCount = await this.countLegacyVisibleAgents()
      if (legacyAgentCount > 0) return false
      if ((await this.countLegacyDeletedAgents()) > 0) return false
      return (await this.countStorageVisibleAgents()) > 0
    })
  }

  async projectIfAgentListMissingRows(reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => {
      const [legacyAgentCount, storageAgentCount] = await Promise.all([
        this.countLegacyVisibleAgents(),
        this.countStorageVisibleAgents()
      ])
      return storageAgentCount > legacyAgentCount
    })
  }

  async projectIfAgentMissing(agentId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => {
      if ((await this.countLegacyDeletedAgent(agentId)) > 0) return false
      return (await this.countStorageAgent(agentId)) > 0
    })
  }

  async projectIfSessionMissing(agentId: string, sessionId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(
      reason,
      async () => (await this.countStorageSession({ agentId, sessionId })) > 0
    )
  }

  async projectIfSessionListEmpty(agentId: string | undefined, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageSession({ agentId })) > 0)
  }

  async projectIfSessionMissingById(sessionId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageSession({ sessionId })) > 0)
  }

  async projectIfSessionMessagesEmpty(sessionId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageSessionMessage(sessionId)) > 0)
  }

  async projectIfTaskMissing(taskId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageTask({ taskId })) > 0)
  }

  async projectIfTaskListEmpty(
    input: {
      agentId?: string
      includeHeartbeat?: boolean
    },
    reason: string
  ): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageTask(input)) > 0)
  }

  async projectIfTaskLogsEmpty(taskId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageTaskRunLog(taskId)) > 0)
  }

  async projectIfChannelMissing(channelId: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageChannel({ channelId })) > 0)
  }

  async projectIfChannelListEmpty(
    filters: {
      agentId?: string
      type?: string
    },
    reason: string
  ): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageChannel(filters)) > 0)
  }

  async projectIfStorageHasAnyAgentRuntimeRows(reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => (await this.countStorageAnyAgentRuntimeRows()) > 0)
  }

  private async projectIfStorageHasRows(reason: string, hasRows: () => Promise<boolean>): Promise<boolean> {
    while (this.projection) {
      if (await this.projection) {
        return true
      }
    }

    this.projection = this.projectNow(reason, hasRows).finally(() => {
      this.projection = null
    })

    return this.projection
  }

  private async projectNow(reason: string, hasRows: () => Promise<boolean>): Promise<boolean> {
    try {
      const legacySeeded = await this.seedStorageFromLegacyRuntime(reason)
      if (!legacySeeded) return false

      const storageHasRows = await hasRows()
      if (!storageHasRows) {
        return false
      }

      const report = await storageV2AgentLegacyProjectionService.projectToLegacyRuntime()
      logger.info('Recovered legacy agent runtime from Storage v2', {
        reason,
        agentDbPath: report.agentDbPath,
        agentCount: report.projectedAgentCount,
        sessionCount: report.projectedSessionCount,
        messageCount: report.projectedSessionMessageCount
      })
      return true
    } catch (error) {
      logger.warn('Failed to recover legacy agent runtime from Storage v2', error as Error)
      return false
    }
  }

  private async seedStorageFromLegacyRuntime(reason: string): Promise<boolean> {
    if (this.legacySeed) {
      return this.legacySeed
    }

    this.legacySeed = storageV2LegacyAgentDbImportService
      .importSnapshot({ dryRun: false, createSnapshot: false, pruneMissing: false })
      .then((report) => {
        if (
          report.agentCount > 0 ||
          report.sessionCount > 0 ||
          report.sessionMessageCount > 0 ||
          report.taskCount > 0 ||
          report.channelCount > 0
        ) {
          logger.info('Seeded Storage v2 agent data from legacy runtime before recovery', {
            reason,
            sourceDbPath: report.sourceDbPath,
            agentCount: report.agentCount,
            sessionCount: report.sessionCount,
            messageCount: report.sessionMessageCount
          })
        }
        return true
      })
      .catch((error) => {
        logger.warn('Failed to seed Storage v2 agent data from legacy runtime', error as Error)
        return false
      })
      .finally(() => {
        this.legacySeed = null
      })

    return this.legacySeed
  }

  private async countLegacyVisibleAgents() {
    const databaseManager = await DatabaseManager.getInstance()
    const client = await databaseManager.getClient()
    const result = await client.execute('SELECT COUNT(*) AS count FROM agents WHERE deleted_at IS NULL')
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countLegacyDeletedAgent(agentId: string) {
    const databaseManager = await DatabaseManager.getInstance()
    const client = await databaseManager.getClient()
    const result = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM agents WHERE id = ? AND deleted_at IS NOT NULL',
      args: [agentId]
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countLegacyDeletedAgents() {
    const databaseManager = await DatabaseManager.getInstance()
    const client = await databaseManager.getClient()
    const result = await client.execute('SELECT COUNT(*) AS count FROM agents WHERE deleted_at IS NOT NULL')
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageVisibleAgents() {
    const client = await storageV2Database.getClient()
    const result = await client.execute('SELECT COUNT(*) AS count FROM agents WHERE deleted_at IS NULL')
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageAgent(agentId: string) {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM agents WHERE id = ? AND deleted_at IS NULL',
      args: [agentId]
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageSession(input: { agentId?: string; sessionId?: string }) {
    const client = await storageV2Database.getClient()
    const clauses = ['deleted_at IS NULL']
    const args: string[] = []

    if (input.agentId) {
      clauses.push('agent_id = ?')
      args.push(input.agentId)
    }

    if (input.sessionId) {
      clauses.push('id = ?')
      args.push(input.sessionId)
    }

    const result = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM agent_sessions WHERE ${clauses.join(' AND ')}`,
      args
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageSessionMessage(sessionId: string) {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM messages m
        INNER JOIN conversations c ON c.id = m.conversation_id
        WHERE c.kind = 'agent_session'
          AND c.session_id = ?
          AND c.deleted_at IS NULL
          AND m.deleted_at IS NULL
      `,
      args: [sessionId]
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageTask(input: { agentId?: string; taskId?: string; includeHeartbeat?: boolean }) {
    const client = await storageV2Database.getClient()
    const clauses = ['deleted_at IS NULL']
    const args: string[] = []

    if (input.agentId) {
      clauses.push('agent_id = ?')
      args.push(input.agentId)
    }

    if (input.taskId) {
      clauses.push('id = ?')
      args.push(input.taskId)
    }

    if (!input.includeHeartbeat) {
      clauses.push("name != 'heartbeat'")
    }

    const result = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM scheduled_tasks WHERE ${clauses.join(' AND ')}`,
      args
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageTaskRunLog(taskId: string) {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM task_run_logs WHERE task_id = ?',
      args: [taskId]
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageChannel(filters: { channelId?: string; agentId?: string; type?: string }) {
    const client = await storageV2Database.getClient()
    const clauses = ['deleted_at IS NULL']
    const args: string[] = []

    if (filters.channelId) {
      clauses.push('id = ?')
      args.push(filters.channelId)
    }

    if (filters.agentId) {
      clauses.push('agent_id = ?')
      args.push(filters.agentId)
    }

    if (filters.type) {
      clauses.push('type = ?')
      args.push(filters.type)
    }

    const result = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM channels WHERE ${clauses.join(' AND ')}`,
      args
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageAnyAgentRuntimeRows() {
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM agents WHERE deleted_at IS NULL) +
        (SELECT COUNT(*) FROM agent_sessions WHERE deleted_at IS NULL) +
        (SELECT COUNT(*) FROM skills WHERE deleted_at IS NULL) +
        (SELECT COUNT(*) FROM agent_skills) +
        (SELECT COUNT(*) FROM scheduled_tasks WHERE deleted_at IS NULL) +
        (SELECT COUNT(*) FROM task_run_logs) +
        (SELECT COUNT(*) FROM channels WHERE deleted_at IS NULL) +
        (SELECT COUNT(*) FROM channel_task_subscriptions) +
        (
          SELECT COUNT(*)
          FROM conversations
          WHERE kind = 'agent_session'
            AND deleted_at IS NULL
        ) +
        (
          SELECT COUNT(*)
          FROM messages m
          INNER JOIN conversations c ON c.id = m.conversation_id
          WHERE c.kind = 'agent_session'
            AND c.deleted_at IS NULL
            AND m.deleted_at IS NULL
        ) AS count
    `)
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }
}

export const storageV2AgentRuntimeRecoveryService = new StorageV2AgentRuntimeRecoveryService()
