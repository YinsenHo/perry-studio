import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentGetStreamingCacheInfo: vi.fn(),
  deleteFiles: vi.fn(),
  dexieDeleteBlocks: vi.fn(),
  dexieDeleteMessage: vi.fn(),
  dexieDeleteMessages: vi.fn(),
  dexieClearMessages: vi.fn(),
  dexieGetRawTopic: vi.fn(),
  findTopicIdsForBlockIds: vi.fn(),
  flushTopic: vi.fn(),
  flushTopics: vi.fn(),
  flushTopicMessagesSnapshot: vi.fn(),
  getState: vi.fn()
}))

vi.mock('../DexieMessageDataSource', () => ({
  DexieMessageDataSource: vi.fn(() => ({
    deleteBlocks: mocks.dexieDeleteBlocks,
    deleteMessage: mocks.dexieDeleteMessage,
    deleteMessages: mocks.dexieDeleteMessages,
    clearMessages: mocks.dexieClearMessages,
    getRawTopic: mocks.dexieGetRawTopic
  }))
}))

vi.mock('../AgentMessageDataSource', () => ({
  AgentMessageDataSource: vi.fn(() => ({
    getStreamingCacheInfo: mocks.agentGetStreamingCacheInfo
  }))
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFiles: mocks.deleteFiles
  }
}))

vi.mock('@renderer/services/StorageV2ConversationMirrorService', () => ({
  storageV2ConversationMirrorService: {
    findTopicIdsForBlockIds: mocks.findTopicIdsForBlockIds,
    flushTopic: mocks.flushTopic,
    flushTopicMessagesSnapshot: mocks.flushTopicMessagesSnapshot,
    flushTopics: mocks.flushTopics
  }
}))

vi.mock('@renderer/services/StorageV2ConversationHydrationService', () => ({
  fetchStorageV2TopicMessages: vi.fn(),
  shouldPreferStorageV2ConversationReads: vi.fn(),
  storageV2TopicExists: vi.fn()
}))

vi.mock('@renderer/services/StorageV2FileMirrorService', () => ({
  storageV2FileMirrorService: {
    scheduleFile: vi.fn(),
    scheduleFiles: vi.fn()
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: mocks.getState
  }
}))

describe('DbService destructive file cleanup ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({})
    mocks.deleteFiles.mockResolvedValue(undefined)
    mocks.flushTopic.mockResolvedValue(undefined)
    mocks.flushTopicMessagesSnapshot.mockResolvedValue(undefined)
    mocks.flushTopics.mockResolvedValue(undefined)
  })

  it('persists the final message snapshot before deleting legacy message rows', async () => {
    const files = [{ id: 'file-1', ext: '.png' }]
    const topic = {
      id: 'topic-1',
      messages: [
        { id: 'message-1', blocks: ['block-1'] },
        { id: 'message-2', blocks: ['block-2'] }
      ]
    }
    mocks.dexieGetRawTopic.mockResolvedValue(topic)
    mocks.dexieDeleteMessage.mockResolvedValue(files)

    const { dbService } = await import('../DbService')

    await dbService.deleteMessage('topic-1', 'message-1')

    expect(mocks.flushTopicMessagesSnapshot).toHaveBeenCalledWith(
      'topic-1',
      expect.any(Function),
      [{ id: 'message-2', blocks: ['block-2'] }],
      { topic, destructive: true }
    )
    expect(mocks.dexieDeleteMessage).toHaveBeenCalledWith('topic-1', 'message-1')
    expect(mocks.deleteFiles).toHaveBeenCalledWith(files)
    expect(mocks.flushTopicMessagesSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dexieDeleteMessage.mock.invocationCallOrder[0]
    )
    expect(mocks.dexieDeleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteFiles.mock.invocationCallOrder[0]
    )
  })

  it('keeps legacy rows and files when the pre-delete Storage v2 snapshot fails', async () => {
    const files = [{ id: 'file-1', ext: '.png' }]
    mocks.dexieGetRawTopic.mockResolvedValue({
      id: 'topic-1',
      messages: [{ id: 'message-1', blocks: ['block-1'] }]
    })
    mocks.dexieDeleteMessage.mockResolvedValue(files)
    mocks.flushTopicMessagesSnapshot.mockRejectedValue(new Error('storage busy'))

    const { dbService } = await import('../DbService')

    await expect(dbService.deleteMessage('topic-1', 'message-1')).rejects.toThrow('storage busy')

    expect(mocks.dexieDeleteMessage).not.toHaveBeenCalled()
    expect(mocks.deleteFiles).not.toHaveBeenCalled()
  })

  it('persists affected topic snapshots before deleting legacy block rows', async () => {
    const files = [{ id: 'file-1', ext: '.png' }]
    mocks.findTopicIdsForBlockIds.mockResolvedValue(new Set(['topic-1']))
    const topic = {
      id: 'topic-1',
      messages: [{ id: 'message-1', blocks: ['block-1', 'block-2'] }]
    }
    mocks.dexieGetRawTopic.mockResolvedValue(topic)
    mocks.dexieDeleteBlocks.mockResolvedValue(files)

    const { dbService } = await import('../DbService')

    await dbService.deleteBlocks(['block-1'])

    expect(mocks.flushTopicMessagesSnapshot).toHaveBeenCalledWith(
      'topic-1',
      expect.any(Function),
      [{ id: 'message-1', blocks: ['block-2'] }],
      { topic, destructive: true }
    )
    expect(mocks.deleteFiles).toHaveBeenCalledWith(files)
    expect(mocks.flushTopicMessagesSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dexieDeleteBlocks.mock.invocationCallOrder[0]
    )
    expect(mocks.dexieDeleteBlocks.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteFiles.mock.invocationCallOrder[0]
    )
  })
})
