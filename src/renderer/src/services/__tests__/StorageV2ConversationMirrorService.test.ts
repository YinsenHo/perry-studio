import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filesGet: vi.fn(),
  fetchStorageV2TopicMessages: vi.fn(),
  messageBlocksAnyOf: vi.fn(),
  messageBlocksWhere: vi.fn(),
  topicsGet: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    files: {
      get: mocks.filesGet
    },
    message_blocks: {
      where: mocks.messageBlocksWhere
    },
    topics: {
      get: mocks.topicsGet
    }
  }
}))

vi.mock('../StorageV2ConversationHydrationService', () => ({
  fetchStorageV2TopicMessages: mocks.fetchStorageV2TopicMessages
}))

describe('StorageV2ConversationMirrorService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api
    mocks.fetchStorageV2TopicMessages.mockResolvedValue(null)
    mocks.messageBlocksAnyOf.mockResolvedValue([])
    mocks.messageBlocksWhere.mockReturnValue({ anyOf: mocks.messageBlocksAnyOf })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('flushes empty topic metadata with assistant topic order', async () => {
    const syncConversation = vi.fn().mockResolvedValue({ messageCount: 0, blockCount: 0 })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          syncConversation
        }
      }
    })

    mocks.topicsGet.mockResolvedValue({
      id: 'topic-2',
      messages: []
    })

    const state = {
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              {
                id: 'topic-1',
                assistantId: 'assistant-1',
                name: 'First',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: []
              },
              {
                id: 'topic-2',
                assistantId: 'assistant-1',
                name: 'Second',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:01.000Z',
                messages: [],
                pinned: true
              }
            ]
          }
        ]
      }
    }

    const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

    await storageV2ConversationMirrorService.flushTopic('topic-2', () => state)

    expect(syncConversation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'topic-2',
        messages: [],
        blocks: []
      }),
      {
        pruneMissingBlocks: false,
        pruneMissingMessages: false
      }
    )
    expect(mocks.fetchStorageV2TopicMessages).toHaveBeenCalledWith('topic-2')
    expect(syncConversation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'topic-2',
        ownerId: 'assistant-1',
        title: 'Second',
        pinned: true,
        sortOrder: 1,
        messages: [],
        blocks: []
      })
    )
  })

  it('skips pre-hydration for destructive topic flushes', async () => {
    const syncConversation = vi.fn().mockResolvedValue({ messageCount: 0, blockCount: 0 })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          syncConversation
        }
      }
    })

    mocks.topicsGet.mockResolvedValue({
      id: 'topic-1',
      messages: []
    })

    const state = {
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              {
                id: 'topic-1',
                assistantId: 'assistant-1',
                name: 'Cleared',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: []
              }
            ]
          }
        ]
      }
    }

    const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

    await storageV2ConversationMirrorService.flushTopic('topic-1', () => state, { destructive: true })

    expect(mocks.fetchStorageV2TopicMessages).not.toHaveBeenCalled()
    expect(syncConversation).toHaveBeenCalledTimes(1)
    expect(syncConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'topic-1',
        messages: [],
        blocks: []
      })
    )
  })

  it('preserves destructive flush semantics when a mirror retry is queued', async () => {
    const syncConversation = vi.fn().mockRejectedValueOnce(new Error('storage busy')).mockResolvedValue({
      messageCount: 0,
      blockCount: 0
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          syncConversation
        }
      }
    })

    mocks.topicsGet.mockResolvedValue({
      id: 'topic-1',
      messages: []
    })

    const state = {
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              {
                id: 'topic-1',
                assistantId: 'assistant-1',
                name: 'Cleared',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: []
              }
            ]
          }
        ]
      }
    }

    const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

    await expect(
      storageV2ConversationMirrorService.flushTopic('topic-1', () => state, { destructive: true })
    ).rejects.toThrow('storage busy')
    await storageV2ConversationMirrorService.flush()

    expect(mocks.fetchStorageV2TopicMessages).not.toHaveBeenCalled()
    expect(syncConversation).toHaveBeenCalledTimes(2)
  })

  it('rejects strict flushes when a conversation mirror write is still pending after failure', async () => {
    const syncConversation = vi.fn().mockRejectedValue(new Error('storage busy'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          syncConversation
        }
      }
    })

    mocks.topicsGet.mockResolvedValue({
      id: 'topic-1',
      messages: []
    })

    const state = {
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              {
                id: 'topic-1',
                assistantId: 'assistant-1',
                name: 'Strict',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: []
              }
            ]
          }
        ]
      }
    }

    const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

    storageV2ConversationMirrorService.scheduleTopic('topic-1', () => state, 1000, { destructive: true })

    await expect(storageV2ConversationMirrorService.flushStrict()).rejects.toThrow('storage busy')
    expect(syncConversation).toHaveBeenCalledTimes(1)
  })

  it('rejects strict flushes when Storage v2 API is unavailable with pending conversation work', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const state = {
      assistants: {
        assistants: []
      }
    }

    const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

    storageV2ConversationMirrorService.scheduleTopic('topic-1', () => state, 1000, { destructive: true })

    await expect(storageV2ConversationMirrorService.flushStrict()).rejects.toThrow(
      'Storage v2 API unavailable while conversation mirror work is pending'
    )
  })

  it('retries pending conversation mirrors when Storage v2 API becomes available later', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    mocks.topicsGet.mockResolvedValue({
      id: 'topic-1',
      messages: []
    })

    const state = {
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              {
                id: 'topic-1',
                assistantId: 'assistant-1',
                name: 'Retry',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: []
              }
            ]
          }
        ]
      }
    }

    try {
      const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

      storageV2ConversationMirrorService.scheduleTopic('topic-1', () => state, 1000, { destructive: true })
      await storageV2ConversationMirrorService.flush()

      const syncConversation = vi.fn().mockResolvedValue({ messageCount: 0, blockCount: 0 })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          storageV2: {
            syncConversation
          }
        }
      })

      await vi.advanceTimersByTimeAsync(1499)
      expect(syncConversation).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(syncConversation).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries destructive mirrors when the Dexie topic snapshot cannot be read', async () => {
    vi.useFakeTimers()
    const syncConversation = vi.fn().mockResolvedValue({ messageCount: 0, blockCount: 0 })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          syncConversation
        }
      }
    })

    mocks.topicsGet.mockRejectedValueOnce(new Error('dexie busy')).mockResolvedValue({
      id: 'topic-1',
      messages: []
    })

    const state = {
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              {
                id: 'topic-1',
                assistantId: 'assistant-1',
                name: 'Recovered',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: []
              }
            ]
          }
        ]
      }
    }

    try {
      const { storageV2ConversationMirrorService } = await import('../StorageV2ConversationMirrorService')

      await expect(
        storageV2ConversationMirrorService.flushTopic('topic-1', () => state, { destructive: true })
      ).rejects.toThrow('dexie busy')

      expect(syncConversation).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1500)

      expect(syncConversation).toHaveBeenCalledTimes(1)
      expect(mocks.fetchStorageV2TopicMessages).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
