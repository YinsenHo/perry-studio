import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  client: {
    execute: vi.fn()
  },
  conversationDelete: vi.fn(),
  recordChange: vi.fn(),
  withTransaction: vi.fn(async (_client: unknown, fn: () => Promise<void>) => fn())
}))

vi.mock('../StorageV2Database', () => ({
  storageV2Database: {
    getClient: vi.fn(async () => mocks.client),
    withTransaction: mocks.withTransaction
  }
}))

vi.mock('../StorageV2Repositories', () => ({
  storageV2ConversationRepository: {
    delete: mocks.conversationDelete
  }
}))

vi.mock('../SyncLogService', () => ({
  storageV2SyncLogService: {
    recordChange: mocks.recordChange
  }
}))

import { StorageV2AgentRuntimeTombstoneService } from '../AgentRuntimeTombstoneService'

describe('StorageV2AgentRuntimeTombstoneService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.client.execute.mockResolvedValue({ rows: [], columns: [], columnTypes: [] })
    mocks.conversationDelete.mockResolvedValue({ deleted: true })
  })

  it('tombstones agent runtime entities and records delete changes', async () => {
    mocks.client.execute
      .mockResolvedValueOnce({ rows: [{ version: 2 }], columns: [], columnTypes: [] })
      .mockResolvedValueOnce({ rows: [], columns: [], columnTypes: [] })

    await new StorageV2AgentRuntimeTombstoneService().tombstoneTask('task-1')

    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('FROM scheduled_tasks'),
        args: ['task-1']
      })
    )
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('UPDATE scheduled_tasks'),
        args: [expect.any(String), expect.any(String), 'task-1']
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'scheduled_task',
        entityId: 'task-1',
        operation: 'delete',
        version: 3
      })
    )
  })

  it('tombstones the Storage v2 agent conversation when deleting a session', async () => {
    await new StorageV2AgentRuntimeTombstoneService().tombstoneSession('session-1')

    expect(mocks.conversationDelete).toHaveBeenCalledWith('agent-session:session-1')
  })

  it('tombstones agent session messages and their blocks', async () => {
    mocks.client.execute
      .mockResolvedValueOnce({
        rows: [{ conversation_id: 'agent-session:session-1', version: 4 }],
        columns: [],
        columnTypes: []
      })
      .mockResolvedValueOnce({ rows: [{ id: 'block-1', version: 1 }], columns: [], columnTypes: [] })
      .mockResolvedValueOnce({ rows: [], columns: [], columnTypes: [] })
      .mockResolvedValueOnce({ rows: [], columns: [], columnTypes: [] })

    await new StorageV2AgentRuntimeTombstoneService().tombstoneSessionMessage(42)

    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('FROM messages'),
        args: ['agent-message:42']
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'message_block',
        entityId: 'block-1',
        operation: 'delete',
        version: 2
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'message',
        entityId: 'agent-message:42',
        operation: 'delete',
        version: 5
      })
    )
  })
})
