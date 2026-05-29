import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  fetchStorageV2TopicMessages: vi.fn(),
  hydrateStorageV2ConversationsIfDexieEmpty: vi.fn(),
  loadTopicMessagesThunk: vi.fn((topicId: string) => ({ type: 'messages/loadTopic', payload: topicId })),
  topicsDelete: vi.fn(),
  topicsGet: vi.fn(),
  topicsToArray: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('@renderer/databases', () => ({
  db: {
    topics: {
      delete: mocks.topicsDelete,
      get: mocks.topicsGet,
      toArray: mocks.topicsToArray
    }
  },
  default: {
    topics: {
      delete: mocks.topicsDelete,
      get: mocks.topicsGet,
      toArray: mocks.topicsToArray
    }
  }
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    t: vi.fn((key: string) => key)
  }
}))

vi.mock('@renderer/services/ApiService', () => ({
  fetchMessagesSummary: vi.fn()
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {},
  EventEmitter: {
    emit: vi.fn()
  }
}))

vi.mock('@renderer/services/MessagesService', () => ({
  safeDeleteFiles: vi.fn()
}))

vi.mock('@renderer/services/StorageV2AssistantWriteService', () => ({
  mutateStorageV2AssistantFirst: vi.fn()
}))

vi.mock('@renderer/services/StorageV2ConversationHydrationService', () => ({
  fetchStorageV2TopicMessages: mocks.fetchStorageV2TopicMessages,
  hydrateStorageV2ConversationsIfDexieEmpty: mocks.hydrateStorageV2ConversationsIfDexieEmpty
}))

vi.mock('@renderer/services/StorageV2ConversationMirrorService', () => ({
  storageV2ConversationMirrorService: {
    flushTopicMessagesSnapshot: vi.fn(),
    scheduleTopic: vi.fn()
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: mocks.dispatch,
    getState: () => ({
      assistants: {
        assistants: []
      },
      runtime: {
        chat: {
          newlyRenamedTopics: [],
          renamingTopics: []
        }
      }
    })
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopic: vi.fn((payload) => ({ type: 'assistants/updateTopic', payload }))
}))

vi.mock('@renderer/store/runtime', () => ({
  setNewlyRenamedTopics: vi.fn((payload) => ({ type: 'runtime/setNewlyRenamedTopics', payload })),
  setRenamingTopics: vi.fn((payload) => ({ type: 'runtime/setRenamingTopics', payload }))
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  loadTopicMessagesThunk: mocks.loadTopicMessagesThunk
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  findMainTextBlocks: vi.fn(() => [])
}))

vi.mock('../useAssistant', () => ({
  useAssistant: vi.fn(() => ({ assistant: { topics: [] } }))
}))

describe('TopicManager Storage v2 read-through', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('returns a topic restored from Storage v2 when the Dexie topic cache is missing', async () => {
    const restoredMessage = {
      id: 'message-1',
      topicId: 'topic-1',
      role: 'assistant',
      blocks: []
    }
    const restoredTopic = {
      id: 'topic-1',
      messages: [restoredMessage]
    }

    mocks.topicsGet.mockResolvedValueOnce(undefined).mockResolvedValueOnce(restoredTopic)
    mocks.fetchStorageV2TopicMessages.mockResolvedValue({
      messages: [restoredMessage],
      blocks: []
    })

    const { TopicManager } = await import('../useTopic')

    await expect(TopicManager.getTopic('topic-1')).resolves.toEqual(restoredTopic)

    expect(mocks.fetchStorageV2TopicMessages).toHaveBeenCalledWith('topic-1')
    expect(mocks.topicsGet).toHaveBeenCalledTimes(2)
  })

  it('hydrates the conversation list from Storage v2 when the Dexie topic list is empty', async () => {
    const restoredTopic = {
      id: 'topic-1',
      messages: []
    }

    mocks.topicsToArray.mockResolvedValueOnce([]).mockResolvedValueOnce([restoredTopic])
    mocks.hydrateStorageV2ConversationsIfDexieEmpty.mockResolvedValue(true)

    const { TopicManager } = await import('../useTopic')

    await expect(TopicManager.getAllTopics()).resolves.toEqual([restoredTopic])

    expect(mocks.hydrateStorageV2ConversationsIfDexieEmpty).toHaveBeenCalledWith('topic-manager-empty-list')
    expect(mocks.topicsToArray).toHaveBeenCalledTimes(2)
  })

  it('loads messages after restoring a missing topic from Storage v2', async () => {
    const restoredMessage = {
      id: 'message-1',
      topicId: 'topic-1',
      role: 'assistant',
      blocks: []
    }
    const emptyRuntimeTopic = {
      id: 'topic-1',
      messages: []
    }
    const hydratedRuntimeTopic = {
      id: 'topic-1',
      messages: [restoredMessage]
    }

    mocks.topicsGet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(emptyRuntimeTopic)
      .mockResolvedValueOnce(hydratedRuntimeTopic)
    mocks.fetchStorageV2TopicMessages.mockResolvedValue({
      messages: [restoredMessage],
      blocks: []
    })

    const { TopicManager } = await import('../useTopic')

    await expect(TopicManager.getTopicMessages('topic-1')).resolves.toEqual([restoredMessage])

    expect(mocks.fetchStorageV2TopicMessages).toHaveBeenCalledWith('topic-1')
    expect(mocks.loadTopicMessagesThunk).toHaveBeenCalledWith('topic-1')
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'messages/loadTopic', payload: 'topic-1' })
  })
})
