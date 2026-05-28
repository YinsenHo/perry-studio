import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentGetStreamingCacheInfo: vi.fn(),
  deleteFiles: vi.fn(),
  dexieDeleteBlocks: vi.fn(),
  dexieDeleteMessage: vi.fn(),
  dexieDeleteMessages: vi.fn(),
  dexieClearMessages: vi.fn(),
  findTopicIdsForBlockIds: vi.fn(),
  flushTopic: vi.fn(),
  flushTopics: vi.fn(),
  getState: vi.fn()
}))

vi.mock('../DexieMessageDataSource', () => ({
  DexieMessageDataSource: vi.fn(() => ({
    deleteBlocks: mocks.dexieDeleteBlocks,
    deleteMessage: mocks.dexieDeleteMessage,
    deleteMessages: mocks.dexieDeleteMessages,
    clearMessages: mocks.dexieClearMessages
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
    mocks.flushTopics.mockResolvedValue(undefined)
  })

  it('cleans message files only after the destructive conversation mirror flush', async () => {
    const files = [{ id: 'file-1', ext: '.png' }]
    mocks.dexieDeleteMessage.mockResolvedValue(files)

    const { dbService } = await import('../DbService')

    await dbService.deleteMessage('topic-1', 'message-1')

    expect(mocks.dexieDeleteMessage).toHaveBeenCalledWith('topic-1', 'message-1')
    expect(mocks.flushTopic).toHaveBeenCalledWith('topic-1', expect.any(Function), { destructive: true })
    expect(mocks.deleteFiles).toHaveBeenCalledWith(files)
    expect(mocks.flushTopic.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteFiles.mock.invocationCallOrder[0])
  })

  it('keeps message files when the destructive conversation mirror flush fails', async () => {
    const files = [{ id: 'file-1', ext: '.png' }]
    mocks.dexieDeleteMessage.mockResolvedValue(files)
    mocks.flushTopic.mockRejectedValue(new Error('storage busy'))

    const { dbService } = await import('../DbService')

    await expect(dbService.deleteMessage('topic-1', 'message-1')).rejects.toThrow('storage busy')

    expect(mocks.deleteFiles).not.toHaveBeenCalled()
  })

  it('cleans block files only after all affected topics are mirrored', async () => {
    const files = [{ id: 'file-1', ext: '.png' }]
    mocks.findTopicIdsForBlockIds.mockResolvedValue(new Set(['topic-1']))
    mocks.dexieDeleteBlocks.mockResolvedValue(files)

    const { dbService } = await import('../DbService')

    await dbService.deleteBlocks(['block-1'])

    expect(mocks.flushTopics).toHaveBeenCalledWith(['topic-1'], expect.any(Function), { destructive: true })
    expect(mocks.deleteFiles).toHaveBeenCalledWith(files)
    expect(mocks.flushTopics.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteFiles.mock.invocationCallOrder[0])
  })
})
