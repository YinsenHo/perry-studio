import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStorageV2AutoHydrateEnabled: vi.fn(),
  listStorageV2Conversations: vi.fn(),
  listStorageV2Messages: vi.fn(),
  topicsCount: vi.fn(),
  topicsGet: vi.fn(),
  topicsPut: vi.fn(),
  topicsToArray: vi.fn(),
  messageBlocksCount: vi.fn(),
  messageBlocksBulkPut: vi.fn(),
  messageBlocksBulkDelete: vi.fn(),
  filesBulkPut: vi.fn(),
  transaction: vi.fn(async (...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      await callback()
    }
  })
}))

vi.mock('../StorageV2HydrationService', () => ({
  getStorageV2AutoHydrateEnabled: mocks.getStorageV2AutoHydrateEnabled
}))

vi.mock('../StorageV2Service', () => ({
  listStorageV2Conversations: mocks.listStorageV2Conversations,
  listStorageV2Messages: mocks.listStorageV2Messages
}))

vi.mock('@renderer/databases', () => ({
  default: {
    topics: {
      count: mocks.topicsCount,
      get: mocks.topicsGet,
      put: mocks.topicsPut,
      toArray: mocks.topicsToArray
    },
    message_blocks: {
      count: mocks.messageBlocksCount,
      bulkPut: mocks.messageBlocksBulkPut,
      bulkDelete: mocks.messageBlocksBulkDelete
    },
    files: {
      bulkPut: mocks.filesBulkPut
    },
    transaction: mocks.transaction
  }
}))

import {
  fetchStorageV2TopicMessages,
  hydrateStorageV2ConversationsIfDexieEmpty,
  shouldPreferStorageV2ConversationReads
} from '../StorageV2ConversationHydrationService'

describe('StorageV2ConversationHydrationService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.clearAllMocks()
    originalApi = window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAppInfo: vi.fn().mockResolvedValue({
          filesPath: '/tmp/cherry-files'
        })
      }
    })
    mocks.topicsGet.mockResolvedValue({
      id: 'topic-1',
      messages: [
        {
          id: 'old-message',
          blocks: ['old-block', 'block-text']
        }
      ]
    })
    mocks.topicsCount.mockResolvedValue(0)
    mocks.topicsToArray.mockResolvedValue([])
    mocks.messageBlocksCount.mockResolvedValue(0)
    mocks.listStorageV2Conversations.mockResolvedValue([])
    mocks.listStorageV2Messages.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('hydrates Storage v2 messages into runtime messages and seeds Dexie cache', async () => {
    mocks.listStorageV2Conversations.mockResolvedValue([
      {
        id: 'topic-1',
        ownerId: 'assistant-1',
        title: 'Storage v2 Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:03.000Z',
        pinned: true
      }
    ])
    mocks.listStorageV2Messages.mockResolvedValueOnce([
      {
        id: 'message-1',
        role: 'user',
        status: null,
        metadata: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: null,
        blocks: [
          {
            id: 'block-file',
            messageId: 'message-1',
            type: 'file',
            ordinal: 2,
            text: null,
            payload: {
              file: {
                id: 'file-1',
                name: '',
                origin_name: 'upload.txt',
                ext: 'txt',
                path: '/old/path/upload.txt',
                count: 0
              }
            },
            createdAt: '2026-01-01T00:00:02.000Z',
            updatedAt: null
          },
          {
            id: 'block-text',
            messageId: 'message-1',
            type: 'main_text',
            ordinal: 1,
            text: 'hello from Storage v2',
            payload: null,
            createdAt: '2026-01-01T00:00:01.000Z',
            updatedAt: null
          }
        ]
      }
    ])

    const result = await fetchStorageV2TopicMessages('topic-1')

    expect(result?.messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        role: 'user',
        assistantId: 'assistant-1',
        topicId: 'topic-1',
        status: 'success',
        blocks: ['block-text', 'block-file']
      })
    ])
    expect(result?.blocks).toEqual([
      expect.objectContaining({
        id: 'block-file',
        type: 'file',
        status: 'success',
        file: expect.objectContaining({
          id: 'file-1',
          name: 'file-1.txt',
          origin_name: 'upload.txt',
          ext: '.txt',
          path: '/tmp/cherry-files/file-1.txt',
          count: 1
        })
      }),
      expect.objectContaining({
        id: 'block-text',
        type: 'main_text',
        status: 'success',
        content: 'hello from Storage v2'
      })
    ])
    expect(mocks.transaction).toHaveBeenCalled()
    expect(mocks.messageBlocksBulkDelete).toHaveBeenCalledWith(['old-block'])
    expect(mocks.messageBlocksBulkPut).toHaveBeenCalledWith(result?.blocks)
    expect(mocks.filesBulkPut).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'file-1',
        path: '/tmp/cherry-files/file-1.txt'
      })
    ])
    expect(mocks.topicsPut).toHaveBeenCalledWith({
      id: 'topic-1',
      assistantId: 'assistant-1',
      name: 'Storage v2 Topic',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:03.000Z',
      pinned: true,
      messages: result?.messages
    })
  })

  it('treats an existing empty Storage v2 topic as authoritative and seeds an empty Dexie cache', async () => {
    mocks.listStorageV2Conversations.mockResolvedValue([
      {
        id: 'empty-topic',
        ownerId: 'assistant-1',
        title: 'Empty Topic',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ])
    mocks.listStorageV2Messages.mockResolvedValueOnce([])

    await expect(fetchStorageV2TopicMessages('empty-topic')).resolves.toEqual({
      messages: [],
      blocks: []
    })

    expect(mocks.transaction).toHaveBeenCalled()
    expect(mocks.messageBlocksBulkDelete).toHaveBeenCalledWith(['old-block', 'block-text'])
    expect(mocks.messageBlocksBulkPut).not.toHaveBeenCalled()
    expect(mocks.topicsPut).toHaveBeenCalledWith({
      id: 'empty-topic',
      assistantId: 'assistant-1',
      name: 'Empty Topic',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: []
    })
  })

  it('hydrates all Storage v2 assistant conversations when Dexie conversation cache is empty', async () => {
    mocks.topicsCount.mockResolvedValue(0)
    mocks.messageBlocksCount.mockResolvedValue(0)
    mocks.listStorageV2Conversations.mockResolvedValue([
      {
        id: 'topic-1',
        ownerId: 'assistant-1',
        title: 'Restored Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z'
      },
      {
        id: 'empty-topic',
        ownerId: 'assistant-1',
        title: 'Empty Topic',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ])
    mocks.listStorageV2Messages
      .mockResolvedValueOnce([
        {
          id: 'message-1',
          role: 'assistant',
          status: null,
          metadata: null,
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: null,
          blocks: [
            {
              id: 'block-text',
              messageId: 'message-1',
              type: 'main_text',
              ordinal: 1,
              text: 'restored search content',
              payload: null,
              createdAt: '2026-01-01T00:00:01.000Z',
              updatedAt: null
            }
          ]
        }
      ])
      .mockResolvedValueOnce([])

    await expect(hydrateStorageV2ConversationsIfDexieEmpty('history-message-search')).resolves.toBe(true)

    expect(mocks.topicsPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'topic-1',
        assistantId: 'assistant-1',
        name: 'Restored Topic',
        messages: [
          expect.objectContaining({
            id: 'message-1',
            topicId: 'topic-1'
          })
        ]
      })
    )
    expect(mocks.topicsPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'empty-topic',
        assistantId: 'assistant-1',
        name: 'Empty Topic',
        messages: []
      })
    )
  })

  it('does not hydrate Storage v2 conversations when Dexie already has every topic', async () => {
    mocks.topicsCount.mockResolvedValue(1)
    mocks.messageBlocksCount.mockResolvedValue(1)
    mocks.topicsToArray.mockResolvedValue([{ id: 'existing-topic', messages: [{ id: 'message-1', blocks: [] }] }])
    mocks.listStorageV2Conversations.mockResolvedValue([
      {
        id: 'existing-topic',
        ownerId: 'assistant-1',
        title: 'Existing Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])

    await expect(hydrateStorageV2ConversationsIfDexieEmpty('history-message-search')).resolves.toBe(false)

    expect(mocks.listStorageV2Conversations).toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('hydrates missing Storage v2 conversations when Dexie only has a partial cache', async () => {
    mocks.topicsCount.mockResolvedValue(1)
    mocks.messageBlocksCount.mockResolvedValue(1)
    mocks.topicsToArray.mockResolvedValue([{ id: 'existing-topic', messages: [{ id: 'message-1', blocks: [] }] }])
    mocks.listStorageV2Conversations.mockResolvedValue([
      {
        id: 'existing-topic',
        ownerId: 'assistant-1',
        title: 'Existing Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'missing-topic',
        ownerId: 'assistant-1',
        title: 'Missing Topic',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:01.000Z'
      }
    ])
    mocks.listStorageV2Messages.mockResolvedValueOnce([
      {
        id: 'message-2',
        role: 'assistant',
        status: null,
        metadata: null,
        createdAt: '2026-01-02T00:00:01.000Z',
        updatedAt: null,
        blocks: [
          {
            id: 'block-2',
            messageId: 'message-2',
            type: 'main_text',
            ordinal: 1,
            text: 'missing topic content',
            payload: null,
            createdAt: '2026-01-02T00:00:01.000Z',
            updatedAt: null
          }
        ]
      }
    ])

    await expect(hydrateStorageV2ConversationsIfDexieEmpty('topic-manager-partial-list')).resolves.toBe(true)

    expect(mocks.listStorageV2Messages).toHaveBeenCalledWith('missing-topic', { limit: 1000, offset: 0 })
    expect(mocks.topicsPut).toHaveBeenCalledTimes(1)
    expect(mocks.topicsPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'missing-topic',
        assistantId: 'assistant-1',
        name: 'Missing Topic',
        messages: [expect.objectContaining({ id: 'message-2', topicId: 'missing-topic' })]
      })
    )
  })

  it('rechecks existing empty Dexie topic caches against Storage v2', async () => {
    mocks.topicsCount.mockResolvedValue(1)
    mocks.messageBlocksCount.mockResolvedValue(0)
    mocks.topicsToArray.mockResolvedValue([{ id: 'empty-topic', messages: [] }])
    mocks.listStorageV2Conversations.mockResolvedValue([
      {
        id: 'empty-topic',
        ownerId: 'assistant-1',
        title: 'Restored Empty Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    mocks.listStorageV2Messages.mockResolvedValueOnce([
      {
        id: 'message-1',
        role: 'assistant',
        status: null,
        metadata: null,
        createdAt: '2026-01-01T00:00:01.000Z',
        updatedAt: null,
        blocks: [
          {
            id: 'block-text',
            messageId: 'message-1',
            type: 'main_text',
            ordinal: 1,
            text: 'restored empty topic content',
            payload: null,
            createdAt: '2026-01-01T00:00:01.000Z',
            updatedAt: null
          }
        ]
      }
    ])

    await expect(hydrateStorageV2ConversationsIfDexieEmpty('history-message-search')).resolves.toBe(true)

    expect(mocks.listStorageV2Conversations).toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalled()
    expect(mocks.topicsPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'empty-topic',
        name: 'Restored Empty Topic',
        messages: [expect.objectContaining({ id: 'message-1', topicId: 'empty-topic' })]
      })
    )
  })

  it('falls back to legacy reads when Storage v2 has neither messages nor a topic row', async () => {
    mocks.listStorageV2Messages.mockResolvedValueOnce([])
    mocks.listStorageV2Conversations.mockResolvedValue([])

    await expect(fetchStorageV2TopicMessages('missing-topic')).resolves.toBeNull()

    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('falls back to legacy reads when Storage v2 auto hydrate status cannot be read', async () => {
    mocks.getStorageV2AutoHydrateEnabled.mockRejectedValueOnce(new Error('ipc unavailable'))

    await expect(shouldPreferStorageV2ConversationReads()).resolves.toBe(false)
  })
})
