import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filesToArray: vi.fn(),
  getState: vi.fn(),
  knowledgeNotesToArray: vi.fn(),
  messageBlocksAnyOf: vi.fn(),
  messageBlocksToArray: vi.fn(),
  messageBlocksWhere: vi.fn(),
  quickPhrasesToArray: vi.fn(),
  settingsToArray: vi.fn(),
  topicsGet: vi.fn(),
  topicsToArray: vi.fn(),
  translateHistoryToArray: vi.fn(),
  translateLanguagesToArray: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    files: {
      toArray: mocks.filesToArray
    },
    knowledge_notes: {
      toArray: mocks.knowledgeNotesToArray
    },
    message_blocks: {
      where: mocks.messageBlocksWhere
    },
    quick_phrases: {
      toArray: mocks.quickPhrasesToArray
    },
    settings: {
      toArray: mocks.settingsToArray
    },
    topics: {
      get: mocks.topicsGet,
      toArray: mocks.topicsToArray
    },
    translate_history: {
      toArray: mocks.translateHistoryToArray
    },
    translate_languages: {
      toArray: mocks.translateLanguagesToArray
    }
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: mocks.getState
  }
}))

describe('StorageV2Service legacy Dexie snapshots', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.filesToArray.mockResolvedValue([])
    mocks.knowledgeNotesToArray.mockResolvedValue([])
    mocks.messageBlocksToArray.mockResolvedValue([{ id: 'block-1', messageId: 'message-1', type: 'main_text' }])
    mocks.messageBlocksAnyOf.mockReturnValue({ toArray: mocks.messageBlocksToArray })
    mocks.messageBlocksWhere.mockReturnValue({ anyOf: mocks.messageBlocksAnyOf })
    mocks.quickPhrasesToArray.mockResolvedValue([])
    mocks.settingsToArray.mockResolvedValue([])
    mocks.topicsToArray.mockResolvedValue([])
    mocks.translateHistoryToArray.mockResolvedValue([])
    mocks.translateLanguagesToArray.mockResolvedValue([])
    mocks.getState.mockReturnValue({
      assistants: {
        defaultAssistant: {
          id: 'default-assistant',
          topics: []
        },
        assistants: [
          {
            id: 'redux-assistant',
            topics: [
              {
                id: 'redux-only-topic',
                assistantId: 'redux-assistant',
                name: 'Redux only',
                messages: []
              },
              {
                id: 'restored-topic',
                assistantId: 'redux-assistant',
                name: 'Stale Redux name',
                messages: []
              }
            ]
          }
        ]
      }
    })
  })

  it('can build restore snapshots from Dexie topics without stale Redux-only topics', async () => {
    mocks.topicsGet.mockImplementation(async (topicId: string) => {
      if (topicId === 'restored-topic') {
        return {
          id: 'restored-topic',
          name: 'Restored topic',
          messages: [
            {
              id: 'message-1',
              assistantId: 'message-assistant',
              blocks: ['block-1']
            }
          ]
        }
      }

      return undefined
    })

    const { getLegacyDexieSnapshotForStorageV2 } = await import('../StorageV2Service')
    const snapshot = await getLegacyDexieSnapshotForStorageV2({
      includeReduxOnlyTopics: false,
      preferMessageAssistantId: true
    })

    expect(snapshot.conversations).toHaveLength(1)
    expect(snapshot.conversations[0]).toEqual(
      expect.objectContaining({
        assistantId: 'message-assistant',
        messages: [
          {
            id: 'message-1',
            assistantId: 'message-assistant',
            blocks: ['block-1']
          }
        ],
        blocks: [{ id: 'block-1', messageId: 'message-1', type: 'main_text' }]
      })
    )
    expect(snapshot.conversations[0].topic).toEqual(
      expect.objectContaining({
        id: 'restored-topic',
        assistantId: 'message-assistant',
        name: 'Restored topic',
        messages: []
      })
    )
  })
})
