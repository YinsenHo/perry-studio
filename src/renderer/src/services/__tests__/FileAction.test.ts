import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fileManagerDeleteFile: vi.fn(),
  fileManagerGetFile: vi.fn(),
  flushTopics: vi.fn(),
  messageBlocksBulkDelete: vi.fn(),
  messageBlocksEquals: vi.fn(),
  messageBlocksWhere: vi.fn(),
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
    flushTopics: mocks.flushTopics
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
    mocks.flushTopics.mockResolvedValue(undefined)
  })

  it('uses a destructive Storage v2 conversation flush after removing file blocks', async () => {
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
    expect(mocks.flushTopics).toHaveBeenCalledWith(['topic-1'], expect.any(Function), {
      destructive: true
    })
    expect(mocks.flushTopics.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fileManagerDeleteFile.mock.invocationCallOrder[0]
    )
  })
})
