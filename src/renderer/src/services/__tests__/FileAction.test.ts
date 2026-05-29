import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fileManagerDeleteFile: vi.fn(),
  fileManagerGetFile: vi.fn(),
  flushTopicMessagesSnapshot: vi.fn(),
  messageBlocksBulkDelete: vi.fn(),
  messageBlocksEquals: vi.fn(),
  messageBlocksWhere: vi.fn(),
  modalError: vi.fn(),
  topicsToArray: vi.fn(),
  topicsUpdate: vi.fn(),
  transaction: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    message_blocks: {
      bulkDelete: mocks.messageBlocksBulkDelete,
      where: mocks.messageBlocksWhere
    },
    topics: {
      toArray: mocks.topicsToArray,
      update: mocks.topicsUpdate
    },
    transaction: mocks.transaction
  }
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFile: mocks.fileManagerDeleteFile,
    getFile: mocks.fileManagerGetFile
  }
}))

vi.mock('@renderer/services/StorageV2ConversationMirrorService', () => ({
  storageV2ConversationMirrorService: {
    flushTopicMessagesSnapshot: mocks.flushTopicMessagesSnapshot
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: mocks.getState
  }
}))

vi.mock('@renderer/components/Popups/TextEditPopup', () => ({
  default: {
    show: vi.fn()
  }
}))

describe('FileAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'modal', {
      configurable: true,
      value: {
        error: mocks.modalError,
        warning: vi.fn()
      }
    })
    mocks.getState.mockReturnValue({
      paintings: {}
    })
    mocks.fileManagerGetFile.mockResolvedValue({
      id: 'file-1',
      ext: '.txt',
      count: 1,
      origin_name: 'note.txt'
    })
    mocks.fileManagerDeleteFile.mockResolvedValue(undefined)
    mocks.messageBlocksWhere.mockReturnValue({
      equals: mocks.messageBlocksEquals
    })
    mocks.messageBlocksEquals.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          id: 'block-1',
          messageId: 'message-1'
        }
      ])
    })
    mocks.topicsToArray.mockResolvedValue([
      {
        id: 'topic-1',
        messages: [
          {
            id: 'message-1',
            blocks: ['block-1', 'block-2']
          }
        ]
      }
    ])
    mocks.topicsUpdate.mockResolvedValue(1)
    mocks.messageBlocksBulkDelete.mockResolvedValue(undefined)
    mocks.transaction.mockImplementation(async (_mode, _topics, _messageBlocks, callback) => callback())
    mocks.flushTopicMessagesSnapshot.mockResolvedValue(undefined)
  })

  it('persists the final conversation snapshot before removing file blocks', async () => {
    const { handleDelete } = await import('../FileAction')

    await handleDelete('file-1', (key) => key)

    expect(mocks.fileManagerDeleteFile).toHaveBeenCalledWith('file-1', true)
    expect(mocks.messageBlocksBulkDelete).toHaveBeenCalledWith(['block-1'])
    expect(mocks.topicsUpdate).toHaveBeenCalledWith('topic-1', {
      messages: [
        {
          id: 'message-1',
          blocks: ['block-2']
        }
      ]
    })
    expect(mocks.flushTopicMessagesSnapshot).toHaveBeenCalledWith(
      'topic-1',
      expect.any(Function),
      [
        {
          id: 'message-1',
          blocks: ['block-2']
        }
      ],
      {
        topic: {
          id: 'topic-1',
          messages: [
            {
              id: 'message-1',
              blocks: ['block-1', 'block-2']
            }
          ]
        },
        destructive: true
      }
    )
    expect(mocks.flushTopicMessagesSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.messageBlocksBulkDelete.mock.invocationCallOrder[0]
    )
    expect(mocks.flushTopicMessagesSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fileManagerDeleteFile.mock.invocationCallOrder[0]
    )
  })

  it('keeps legacy file records when the pre-delete Storage v2 snapshot fails', async () => {
    mocks.flushTopicMessagesSnapshot.mockRejectedValue(new Error('storage busy'))

    const { handleDelete } = await import('../FileAction')

    await handleDelete('file-1', (key) => key)

    expect(mocks.messageBlocksBulkDelete).not.toHaveBeenCalled()
    expect(mocks.fileManagerDeleteFile).not.toHaveBeenCalled()
    expect(mocks.modalError).toHaveBeenCalledWith({
      content: 'files.delete.db_error',
      centered: true
    })
  })
})
