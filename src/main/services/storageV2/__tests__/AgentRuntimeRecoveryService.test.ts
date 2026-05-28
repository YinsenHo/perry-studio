import { DatabaseManager } from '@main/services/agents/database/DatabaseManager'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { storageV2AgentLegacyProjectionService } from '../AgentLegacyProjectionService'
import { StorageV2AgentRuntimeRecoveryService } from '../AgentRuntimeRecoveryService'
import { storageV2LegacyAgentDbImportService } from '../LegacyAgentDbImportService'
import { storageV2Database } from '../StorageV2Database'

function createCountClient(count: number) {
  return {
    execute: vi.fn(async () => ({
      rows: [{ count }],
      columns: [],
      columnTypes: []
    }))
  }
}

function createCountSequenceClient(counts: number[]) {
  let index = 0
  return {
    execute: vi.fn(async () => {
      const count = counts[Math.min(index, counts.length - 1)] ?? 0
      index++
      return {
        rows: [{ count }],
        columns: [],
        columnTypes: []
      }
    })
  }
}

function mockProjection() {
  return vi.spyOn(storageV2AgentLegacyProjectionService, 'projectToLegacyRuntime').mockResolvedValue({
    agentDbPath: '/tmp/agents.db',
    archivedFiles: [],
    projectedAgentCount: 1,
    projectedPlaceholderAgentCount: 0,
    projectedSessionCount: 1,
    projectedSessionMessageCount: 0,
    projectedSkillCount: 0,
    projectedPlaceholderSkillCount: 0,
    projectedAgentSkillCount: 0,
    projectedTaskCount: 0,
    projectedTaskRunLogCount: 0,
    projectedChannelCount: 0,
    skippedSessionCount: 0,
    skippedSessionMessageCount: 0,
    skippedAgentSkillCount: 0,
    skippedTaskCount: 0,
    skippedTaskRunLogCount: 0,
    skippedChannelCount: 0,
    restoredChannelSecretCount: 0,
    missingChannelSecretCount: 0,
    warnings: []
  })
}

describe('StorageV2AgentRuntimeRecoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('projects Storage v2 agent data when the legacy agent list is empty', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountClient(2)
    const projection = mockProjection()
    vi.spyOn(DatabaseManager, 'getInstance').mockResolvedValue({
      getClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfLegacyAgentListEmpty('test')

    expect(recovered).toBe(true)
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('seeds Storage v2 from the selected legacy agent database before projecting an empty runtime', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountSequenceClient([0, 1])
    const projection = mockProjection()
    const importSnapshot = vi.spyOn(storageV2LegacyAgentDbImportService, 'importSnapshot').mockResolvedValue({
      dryRun: false,
      sourceDbPath: '/tmp/old/agents.db',
      agentCount: 1,
      sessionCount: 1,
      sessionMessageCount: 1,
      skillCount: 0,
      agentSkillCount: 0,
      taskCount: 0,
      taskRunLogCount: 0,
      channelCount: 0,
      importedAgentCount: 1,
      importedSessionCount: 1,
      importedSessionMessageCount: 1,
      importedSkillCount: 0,
      importedAgentSkillCount: 0,
      importedTaskCount: 0,
      importedTaskRunLogCount: 0,
      importedChannelCount: 0,
      secretCandidateCount: 0,
      importedSecretCount: 0,
      skippedSecretCount: 0,
      warnings: []
    })
    vi.spyOn(DatabaseManager, 'getInstance').mockResolvedValue({
      getClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfLegacyAgentListEmpty('test')

    expect(recovered).toBe(true)
    expect(importSnapshot).toHaveBeenCalledWith({ dryRun: false, createSnapshot: false })
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('does not project when the legacy runtime already has visible agents', async () => {
    const legacyClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(DatabaseManager, 'getInstance').mockResolvedValue({
      getClient: async () => legacyClient
    } as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfLegacyAgentListEmpty('test')

    expect(recovered).toBe(false)
    expect(projection).not.toHaveBeenCalled()
  })

  it('projects a specific missing agent when Storage v2 has it', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(DatabaseManager, 'getInstance').mockResolvedValue({
      getClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfAgentMissing('agent-1', 'test')

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['agent-1']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('does not project a missing agent when the legacy runtime has a delete tombstone', async () => {
    const legacyClient = createCountClient(1)
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(DatabaseManager, 'getInstance').mockResolvedValue({
      getClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfAgentMissing('agent-1', 'test')

    expect(recovered).toBe(false)
    expect(storageClient.execute).not.toHaveBeenCalled()
    expect(projection).not.toHaveBeenCalled()
  })

  it('projects all sessions when the legacy session list is empty', async () => {
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfSessionListEmpty(undefined, 'test')

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('agent_sessions'),
        args: []
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('projects a specific session by id when Storage v2 has it', async () => {
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfSessionMissingById('session-1', 'test')

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('agent_sessions'),
        args: ['session-1']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('rechecks a specific session after an unrelated inflight projection found no rows', async () => {
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    const service = new StorageV2AgentRuntimeRecoveryService()
    ;(service as any).projection = Promise.resolve(false).finally(() => {
      ;(service as any).projection = null
    })
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await service.projectIfSessionMissingById('session-1', 'test')

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('agent_sessions'),
        args: ['session-1']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('projects session messages when Storage v2 has agent conversation history', async () => {
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfSessionMessagesEmpty(
      'session-1',
      'test'
    )

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("c.kind = 'agent_session'"),
        args: ['session-1']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('projects a specific missing task when Storage v2 has it', async () => {
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfTaskMissing('task-1', 'test')

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('scheduled_tasks'),
        args: ['task-1']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('projects a filtered channel list when Storage v2 has matching channels', async () => {
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AgentRuntimeRecoveryService().projectIfChannelListEmpty(
      { agentId: 'agent-1', type: 'telegram' },
      'test'
    )

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('channels'),
        args: ['agent-1', 'telegram']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })
})
