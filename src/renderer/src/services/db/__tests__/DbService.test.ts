import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentGetStreamingCacheInfo: vi.fn(),
  deleteFiles: vi.fn(),
  dexieAppendMessage: vi.fn(),
  dexieDeleteBlocks: vi.fn(),
  dexieDeleteMessage: vi.fn(),
  dexieDeleteMessages: vi.fn(),
  dexieClearMessages: vi.fn(),
  dexieGetRawTopic: vi.fn(),
  dexieUpdateMessage: vi.fn(),
  dexieUpdateMessageAndBlocks: vi.fn(),
  dexieUpdateBlocks: vi.fn(),
  dexieUpdateSingleBlock: vi.fn(),
  dexieBulkAddBlocks: vi.fn(),
  findTopicIdsForBlockIds: vi.fn(),
  flushTopic: vi.fn(),
  flushTopics: vi.fn(),
  flushTopicMessagesSnapshot: vi.fn(),
  getState: vi.fn(),
  scheduleTopic: vi.fn(),
  scheduleTopics: vi.fn(),
  scheduleMessages: vi.fn(),
  upsertTopicMessageFirst: vi.fn(),
  upsertMessageBlocksFirst: vi.fn()
}))

vi.mock('../DexieMessageDataSource', () => ({
  DexieMessageDataSource: vi.fn(() => ({
    appendMessage: mocks.dexieAppendMessage,
    deleteBlocks: mocks.dexieDeleteBlocks,
    deleteMessage: mocks.dexieDeleteMessage,
    deleteMessages: mocks.dexieDeleteMessages,
    clearMessages: mocks.dexieClearMessages,
    getRawTopic: mocks.dexieGetRawTopic,
    updateMessage: mocks.dexieUpdateMessage,
    updateMessageAndBlocks: mocks.dexieUpdateMessageAndBlocks,
    updateBlocks: mocks.dexieUpdateBlocks,
    updateSingleBlock: mocks.dexieUpdateSingleBlock,
    bulkAddBlocks: mocks.dexieBulkAddBlocks
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
    flushTopics: mocks.flushTopics,
    scheduleTopic: mocks.scheduleTopic,
    scheduleTopics: mocks.scheduleTopics,
    scheduleMessages: mocks.scheduleMessages,
    upsertTopicMessageFirst: mocks.upsertTopicMessageFirst,
    upsertMessageBlocksFirst: mocks.upsertMessageBlocksFirst
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
    mocks.upsertTopicMessageFirst.mockResolvedValue(undefined)
    mocks.dexieAppendMessage.mockResolvedValue(undefined)
    mocks.dexieUpdateMessage.mockResolvedValue(undefined)
    mocks.dexieUpdateMessageAndBlocks.mockResolvedValue(undefined)
    mocks.dexieUpdateBlocks.mockResolvedValue(undefined)
    mocks.dexieUpdateSingleBlock.mockResolvedValue(undefined)
    mocks.dexieBulkAddBlocks.mockResolvedValue(undefined)
    mocks.upsertMessageBlocksFirst.mockResolvedValue(undefined)
  })

  it('upserts Storage v2 messages before appending legacy Dexie rows', async () => {
    const message = { id: 'message-1', assistantId: 'assistant-1', topicId: 'topic-1', blocks: ['block-1'] }
    const blocks = [{ id: 'block-1', messageId: 'message-1', type: 'main_text' }]

    const { dbService } = await import('../DbService')

    await dbService.appendMessage('topic-1', message as any, blocks as any, 0)

    expect(mocks.upsertTopicMessageFirst).toHaveBeenCalledWith(
      'topic-1',
      expect.any(Function),
      message,
      blocks,
      expect.objectContaining({ pruneMissingBlocks: true })
    )
    expect(mocks.dexieAppendMessage).toHaveBeenCalledWith('topic-1', message, blocks, 0)
    expect(mocks.upsertTopicMessageFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dexieAppendMessage.mock.invocationCallOrder[0]
    )
  })

  it('keeps legacy rows untouched when the pre-append Storage v2 message write fails', async () => {
    mocks.upsertTopicMessageFirst.mockRejectedValue(new Error('storage busy'))

    const { dbService } = await import('../DbService')

    await expect(dbService.appendMessage('topic-1', { id: 'message-1' } as any, [], 0)).rejects.toThrow('storage busy')

    expect(mocks.dexieAppendMessage).not.toHaveBeenCalled()
  })

  it('upserts merged Storage v2 messages before updating legacy Dexie message rows', async () => {
    const topic = {
      id: 'topic-1',
      messages: [{ id: 'message-1', assistantId: 'assistant-1', topicId: 'topic-1', status: 'pending' }]
    }
    mocks.dexieGetRawTopic.mockResolvedValue(topic)

    const { dbService } = await import('../DbService')

    await dbService.updateMessage('topic-1', 'message-1', { status: 'success' } as any)

    expect(mocks.upsertTopicMessageFirst).toHaveBeenCalledWith(
      'topic-1',
      expect.any(Function),
      { id: 'message-1', assistantId: 'assistant-1', topicId: 'topic-1', status: 'success' },
      undefined,
      expect.objectContaining({ topic })
    )
    expect(mocks.dexieUpdateMessage).toHaveBeenCalledWith('topic-1', 'message-1', { status: 'success' })
    expect(mocks.upsertTopicMessageFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dexieUpdateMessage.mock.invocationCallOrder[0]
    )
  })

  it('upserts Storage v2 message blocks before updating legacy Dexie block rows', async () => {
    const blocks = [{ id: 'block-1', messageId: 'message-1', type: 'main_text' }]

    const { dbService } = await import('../DbService')

    await dbService.updateBlocks(blocks as any)

    expect(mocks.upsertMessageBlocksFirst).toHaveBeenCalledWith('message-1', blocks, { pruneMissing: false })
    expect(mocks.dexieUpdateBlocks).toHaveBeenCalledWith(blocks)
    expect(mocks.upsertMessageBlocksFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dexieUpdateBlocks.mock.invocationCallOrder[0]
    )
  })

  it('keeps legacy block rows untouched when the pre-update Storage v2 block write fails', async () => {
    mocks.upsertMessageBlocksFirst.mockRejectedValue(new Error('storage busy'))

    const { dbService } = await import('../DbService')

    await expect(
      dbService.updateBlocks([{ id: 'block-1', messageId: 'message-1', type: 'main_text' }] as any)
    ).rejects.toThrow('storage busy')

    expect(mocks.dexieUpdateBlocks).not.toHaveBeenCalled()
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
