import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storage: {
    upsertConversation: vi.fn(),
    upsertMessage: vi.fn(),
    upsertMessageBlocks: vi.fn()
  }
}))

vi.mock('@main/services/storageV2/StorageV2Repositories', () => ({
  storageV2ConversationRepository: mocks.storage
}))

vi.mock('@main/apiServer/services/mcp', () => ({
  mcpApiService: {
    getServerInfo: vi.fn()
  }
}))

vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn()
}))

vi.mock('@main/utils', () => ({
  getDataPath: vi.fn(() => '/mock/data')
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }))
  }
}))

import { agentMessageRepository } from '../sessionMessageRepository'

function createSelectQuery(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows)
      }))
    }))
  }
}

function createPayload(role: 'user' | 'assistant' = 'user') {
  return {
    message: {
      id: `${role}-message-1`,
      role,
      content: role === 'user' ? 'Hello' : 'Hi there',
      createdAt: '2026-05-29T00:00:00.000Z'
    },
    blocks: []
  } as any
}

describe('AgentMessageRepository Storage v2-first writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storage.upsertConversation.mockResolvedValue({ id: 'agent-session:session-1' })
    mocks.storage.upsertMessage.mockResolvedValue({ id: 'agent-message:1' })
    mocks.storage.upsertMessageBlocks.mockResolvedValue({ messageId: 'agent-message:1', blockCount: 1 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('upserts Storage v2 conversation/message/block before inserting a legacy message row', async () => {
    const sessionRow = {
      id: 'session-1',
      agent_id: 'agent-1',
      name: 'Session',
      sort_order: 0,
      created_at: '2026-05-29T00:00:00.000Z'
    }
    let insertedRow: any
    const returning = vi.fn(async () => [insertedRow])
    const values = vi.fn((row: any) => {
      insertedRow = row
      return { returning }
    })
    const insert = vi.fn(() => ({ values }))
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(createSelectQuery([]))
        .mockReturnValueOnce(createSelectQuery([sessionRow])),
      insert
    }

    vi.spyOn(agentMessageRepository as never, 'getDatabase').mockResolvedValue(database as never)

    const saved = await agentMessageRepository.persistUserMessage({
      sessionId: 'session-1',
      payload: createPayload('user'),
      metadata: { source: 'test' },
      createdAt: '2026-05-29T00:00:01.000Z'
    })

    const legacyId = insertedRow.id
    expect(saved.id).toBe(legacyId)
    expect(mocks.storage.upsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-session:session-1',
        ownerId: 'agent-1',
        sessionId: 'session-1'
      })
    )
    expect(mocks.storage.upsertMessage).toHaveBeenCalledWith(
      'agent-session:session-1',
      expect.objectContaining({
        id: `agent-message:${legacyId}`,
        role: 'user',
        requestId: 'user-message-1'
      })
    )
    expect(mocks.storage.upsertMessageBlocks).toHaveBeenCalledWith(
      `agent-message:${legacyId}`,
      [
        expect.objectContaining({
          id: `agent-message-block:${legacyId}`,
          type: 'agent_session_entry',
          content: 'Hello'
        })
      ],
      { pruneMissing: true }
    )
    expect(mocks.storage.upsertMessageBlocks.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]
    )
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: legacyId, session_id: 'session-1' }))
  })

  it('does not insert a legacy message row when the Storage v2 first write fails', async () => {
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(createSelectQuery([]))
        .mockReturnValueOnce(createSelectQuery([{ id: 'session-1', agent_id: 'agent-1' }])),
      insert: vi.fn()
    }

    vi.spyOn(agentMessageRepository as never, 'getDatabase').mockResolvedValue(database as never)
    mocks.storage.upsertMessage.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(
      agentMessageRepository.persistUserMessage({
        sessionId: 'session-1',
        payload: createPayload('user')
      })
    ).rejects.toThrow('storage unavailable')

    expect(database.insert).not.toHaveBeenCalled()
  })

  it('upserts Storage v2 before updating an existing legacy message row', async () => {
    const existingRow = {
      id: 42,
      session_id: 'session-1',
      role: 'assistant',
      content: JSON.stringify(createPayload('assistant')),
      agent_session_id: 'agent-session-runtime-1',
      metadata: JSON.stringify({ previous: true }),
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:00.000Z'
    }
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn(() => ({ where }))
    const update = vi.fn(() => ({ set }))
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(createSelectQuery([existingRow]))
        .mockReturnValueOnce(createSelectQuery([{ id: 'session-1', agent_id: 'agent-1' }])),
      update
    }

    vi.spyOn(agentMessageRepository as never, 'getDatabase').mockResolvedValue(database as never)

    await expect(
      agentMessageRepository.persistAssistantMessage({
        sessionId: 'session-1',
        agentSessionId: 'agent-session-runtime-2',
        payload: createPayload('assistant'),
        metadata: { next: true },
        createdAt: '2026-05-29T00:00:02.000Z'
      })
    ).resolves.toEqual(expect.objectContaining({ id: 42, agent_session_id: 'agent-session-runtime-2' }))

    expect(mocks.storage.upsertMessage).toHaveBeenCalledWith(
      'agent-session:session-1',
      expect.objectContaining({
        id: 'agent-message:42',
        role: 'assistant'
      })
    )
    expect(mocks.storage.upsertMessageBlocks.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]
    )
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_session_id: 'agent-session-runtime-2'
      })
    )
  })
})
