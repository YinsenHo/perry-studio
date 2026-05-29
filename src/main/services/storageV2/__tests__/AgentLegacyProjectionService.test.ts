import { describe, expect, it, vi } from 'vitest'

import {
  type StorageV2AgentLegacyProjectionReport,
  storageV2AgentLegacyProjectionService
} from '../AgentLegacyProjectionService'

function createReport(): StorageV2AgentLegacyProjectionReport {
  return {
    agentDbPath: '/tmp/agents.db',
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

describe('StorageV2AgentLegacyProjectionService', () => {
  it('does not project active child rows for deleted Storage v2 agents', async () => {
    type ExecuteInput = string | { sql: string; args?: unknown[] }

    const storageExecute = vi.fn(async (input: ExecuteInput) => {
      if (typeof input === 'string') return { rows: [] }

      const sql = input.sql

      if (sql.includes('FROM agents')) {
        return {
          rows: [
            {
              id: 'agent-deleted',
              type: 'claude-code',
              name: 'Deleted agent',
              deleted_at: '2026-05-29T00:00:00.000Z',
              model_id: 'model-1',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-29T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM agent_sessions')) {
        return {
          rows: [
            {
              id: 'session-stale',
              agent_id: 'agent-deleted',
              name: 'Stale session',
              current_config_json: '{}',
              inherited_config_json: '{}',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM agent_skills')) {
        return {
          rows: [
            {
              agent_id: 'agent-deleted',
              skill_id: 'skill-stale',
              enabled: 1,
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM scheduled_tasks')) {
        return {
          rows: [
            {
              id: 'task-stale',
              agent_id: 'agent-deleted',
              name: 'Stale task',
              prompt: 'run',
              schedule_type: 'once',
              schedule_value: '2026-05-29T00:00:00.000Z',
              status: 'active',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM task_run_logs')) {
        return {
          rows: [
            {
              id: 1,
              task_id: 'task-stale',
              run_at: '2026-05-28T00:00:00.000Z',
              duration_ms: 10,
              status: 'success',
              result_json: '{}'
            }
          ]
        }
      }

      if (sql.includes('FROM channels')) {
        return {
          rows: [
            {
              id: 'channel-stale',
              type: 'telegram',
              name: 'Stale channel',
              agent_id: 'agent-deleted',
              config_json: '{}',
              is_active: 1,
              active_chat_ids_json: '[]',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM skills')) {
        return { rows: [] }
      }

      return { rows: [] }
    })
    const targetExecute = vi.fn(async (_input: ExecuteInput) => ({ rows: [] }))
    const report = createReport()

    await (storageV2AgentLegacyProjectionService as any).projectRows(
      { execute: storageExecute },
      { execute: targetExecute },
      report
    )

    const executedSql = targetExecute.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.sql))
    const channelInsert = targetExecute.mock.calls.find(([input]) => {
      const sql = typeof input === 'string' ? input : input.sql
      return sql.includes('INSERT INTO channels')
    })?.[0] as { args?: unknown[] } | undefined

    expect(executedSql.some((sql) => sql.includes('INSERT INTO agents'))).toBe(true)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO sessions'))).toBe(false)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO agent_skills'))).toBe(false)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO scheduled_tasks'))).toBe(false)
    expect(channelInsert?.args?.[3]).toBeNull()
    expect(report.skippedSessionCount).toBe(1)
    expect(report.skippedAgentSkillCount).toBe(1)
    expect(report.skippedTaskCount).toBe(1)
    expect(report.skippedTaskRunLogCount).toBe(1)
  })

  it('projects channel task subscriptions when both task and channel are restorable', async () => {
    type ExecuteInput = string | { sql: string; args?: unknown[] }

    const storageExecute = vi.fn(async (input: ExecuteInput) => {
      if (typeof input === 'string') return { rows: [] }

      const sql = input.sql

      if (sql.includes('FROM agents')) {
        return {
          rows: [
            {
              id: 'agent-1',
              type: 'claude-code',
              name: 'Agent',
              deleted_at: null,
              model_id: 'model-1',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-29T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM scheduled_tasks')) {
        return {
          rows: [
            {
              id: 'task-1',
              agent_id: 'agent-1',
              name: 'Daily task',
              prompt: 'run',
              schedule_type: 'once',
              schedule_value: '2026-05-29T00:00:00.000Z',
              status: 'active',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM channels')) {
        return {
          rows: [
            {
              id: 'channel-1',
              type: 'telegram',
              name: 'Telegram',
              agent_id: 'agent-1',
              config_json: '{}',
              is_active: 1,
              active_chat_ids_json: '[]',
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z'
            }
          ]
        }
      }

      if (sql.includes('FROM channel_task_subscriptions')) {
        return {
          rows: [
            {
              channel_id: 'channel-1',
              task_id: 'task-1'
            }
          ]
        }
      }

      return { rows: [] }
    })
    const targetExecute = vi.fn(async (_input: ExecuteInput) => ({ rows: [] }))
    const report = createReport()

    await (storageV2AgentLegacyProjectionService as any).projectRows(
      { execute: storageExecute },
      { execute: targetExecute },
      report
    )

    expect(targetExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO channel_task_subscriptions'),
        args: ['channel-1', 'task-1']
      })
    )
    expect(report.projectedChannelTaskSubscriptionCount).toBe(1)
    expect(report.skippedChannelTaskSubscriptionCount).toBe(0)
  })
})
