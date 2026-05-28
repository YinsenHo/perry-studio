/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import FileManager from '@renderer/services/FileManager'
import {
  fetchStorageV2TopicMessages,
  shouldPreferStorageV2ConversationReads,
  storageV2TopicExists
} from '@renderer/services/StorageV2ConversationHydrationService'
import { storageV2ConversationMirrorService } from '@renderer/services/StorageV2ConversationMirrorService'
import { storageV2FileMirrorService } from '@renderer/services/StorageV2FileMirrorService'
import store from '@renderer/store'
import type { FileMetadata } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'

import { AgentMessageDataSource } from './AgentMessageDataSource'
import { DexieMessageDataSource } from './DexieMessageDataSource'
import type { MessageDataSource } from './types'
import { buildAgentSessionTopicId, isAgentSessionTopicId } from './types'

const logger = loggerService.withContext('DbService')

/**
 * Facade service that routes data operations to the appropriate data source
 * based on the topic ID type (regular chat or agent session)
 */
class DbService implements MessageDataSource {
  private static instance: DbService
  private dexieSource: DexieMessageDataSource
  private agentSource: AgentMessageDataSource

  private constructor() {
    this.dexieSource = new DexieMessageDataSource()
    this.agentSource = new AgentMessageDataSource()
  }

  /**
   * Get singleton instance
   */
  static getInstance(): DbService {
    if (!DbService.instance) {
      DbService.instance = new DbService()
    }
    return DbService.instance
  }

  /**
   * Determine which data source to use based on topic ID
   */
  private getDataSource(topicId: string): MessageDataSource {
    if (isAgentSessionTopicId(topicId)) {
      logger.silly(`Using AgentMessageDataSource for topic ${topicId}`)
      return this.agentSource
    }

    // Future: Could add more data source types here
    // e.g., if (isCloudTopicId(topicId)) return this.cloudSource

    logger.silly(`Using DexieMessageDataSource for topic ${topicId}`)
    return this.dexieSource
  }

  /**
   * Resolve topicId for a message
   */
  private resolveMessageTopicId(messageId: string): string | undefined {
    const state = store.getState()

    const parentMessage = state.messages.entities[messageId]
    if (parentMessage) {
      return parentMessage.topicId
    }

    const agentInfo = this.agentSource.getStreamingCacheInfo(messageId)
    if (agentInfo) {
      return buildAgentSessionTopicId(agentInfo.sessionId)
    }

    return undefined
  }

  private getState() {
    return store.getState()
  }

  private scheduleRegularTopicMirror(topicId: string | undefined): void {
    if (!topicId || isAgentSessionTopicId(topicId)) return
    storageV2ConversationMirrorService.scheduleTopic(topicId, () => this.getState())
  }

  private scheduleRegularTopicMirrors(topicIds: Iterable<string | undefined>): void {
    storageV2ConversationMirrorService.scheduleTopics(
      Array.from(topicIds).filter((topicId) => topicId && !isAgentSessionTopicId(topicId)),
      () => this.getState()
    )
  }

  private async flushRegularTopicMirror(
    topicId: string | undefined,
    options: { destructive?: boolean } = {}
  ): Promise<void> {
    if (!topicId || isAgentSessionTopicId(topicId)) return

    await storageV2ConversationMirrorService.flushTopic(topicId, () => this.getState(), options)
  }

  private async flushRegularTopicMirrors(
    topicIds: Iterable<string | undefined>,
    options: { destructive?: boolean } = {}
  ): Promise<void> {
    await storageV2ConversationMirrorService.flushTopics(
      Array.from(topicIds).filter((topicId) => topicId && !isAgentSessionTopicId(topicId)),
      () => this.getState(),
      options
    )
  }

  private async cleanupFilesAfterConversationMirror(files: void | FileMetadata[]): Promise<void> {
    if (!files || files.length === 0) return
    await FileManager.deleteFiles(files)
  }

  // ============ Read Operations ============

  async fetchMessages(
    topicId: string,
    forceReload?: boolean
  ): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
  }> {
    const source = this.getDataSource(topicId)
    if (isAgentSessionTopicId(topicId)) {
      return source.fetchMessages(topicId, forceReload)
    }

    if (forceReload || (await shouldPreferStorageV2ConversationReads())) {
      const storageV2Messages = await fetchStorageV2TopicMessages(topicId)
      if (storageV2Messages) {
        return storageV2Messages
      }
    }

    const legacyMessages = await source.fetchMessages(topicId, forceReload)
    if (legacyMessages.messages.length > 0) {
      return legacyMessages
    }

    return (await fetchStorageV2TopicMessages(topicId)) ?? legacyMessages
  }

  // ============ Write Operations ============
  async appendMessage(topicId: string, message: Message, blocks: MessageBlock[], insertIndex?: number): Promise<void> {
    const source = this.getDataSource(topicId)
    await source.appendMessage(topicId, message, blocks, insertIndex)
    this.scheduleRegularTopicMirror(topicId)
  }

  async updateMessage(topicId: string, messageId: string, updates: Partial<Message>): Promise<void> {
    const source = this.getDataSource(topicId)
    await source.updateMessage(topicId, messageId, updates)
    this.scheduleRegularTopicMirror(topicId)
  }

  async updateMessageAndBlocks(
    topicId: string,
    messageUpdates: Partial<Message> & Pick<Message, 'id'>,
    blocksToUpdate: MessageBlock[]
  ): Promise<void> {
    const source = this.getDataSource(topicId)
    await source.updateMessageAndBlocks(topicId, messageUpdates, blocksToUpdate)
    this.scheduleRegularTopicMirror(topicId)
  }

  async deleteMessage(topicId: string, messageId: string): Promise<void> {
    const source = this.getDataSource(topicId)
    const filesToDelete = await source.deleteMessage(topicId, messageId)
    await this.flushRegularTopicMirror(topicId, { destructive: true })
    await this.cleanupFilesAfterConversationMirror(filesToDelete)
  }

  async deleteMessages(topicId: string, messageIds: string[]): Promise<void> {
    const source = this.getDataSource(topicId)
    const filesToDelete = await source.deleteMessages(topicId, messageIds)
    await this.flushRegularTopicMirror(topicId, { destructive: true })
    await this.cleanupFilesAfterConversationMirror(filesToDelete)
  }

  // ============ Block Operations ============

  async updateBlocks(blocks: MessageBlock[]): Promise<void> {
    if (blocks.length === 0) {
      return
    }

    const agentBlocks: MessageBlock[] = []
    const regularBlocks: MessageBlock[] = []
    const regularTopicIds = new Set<string>()
    const unresolvedRegularMessageIds = new Set<string>()

    for (const block of blocks) {
      const topicId = this.resolveMessageTopicId(block.messageId)

      if (topicId && isAgentSessionTopicId(topicId)) {
        agentBlocks.push(block)
      } else {
        if (!topicId) {
          logger.warn(`Unable to resolve topicId for block ${block.id}, defaulting to Dexie`)
          unresolvedRegularMessageIds.add(block.messageId)
        } else {
          regularTopicIds.add(topicId)
        }
        regularBlocks.push(block)
      }
    }

    if (agentBlocks.length > 0) {
      await this.agentSource.updateBlocks(agentBlocks)
    }

    if (regularBlocks.length > 0) {
      await this.dexieSource.updateBlocks(regularBlocks)
      this.scheduleRegularTopicMirrors(regularTopicIds)
      storageV2ConversationMirrorService.scheduleMessages(unresolvedRegularMessageIds, () => this.getState())
    }
  }

  async deleteBlocks(blockIds: string[]): Promise<void> {
    // Similar limitation as updateBlocks
    // Default to Dexie since agent blocks can't be deleted individually
    const topicIds = await storageV2ConversationMirrorService.findTopicIdsForBlockIds(blockIds, () => this.getState())
    const filesToDelete = await this.dexieSource.deleteBlocks(blockIds)
    await this.flushRegularTopicMirrors(topicIds, { destructive: true })
    await this.cleanupFilesAfterConversationMirror(filesToDelete)
  }

  // ============ Batch Operations ============

  async clearMessages(topicId: string): Promise<void> {
    const source = this.getDataSource(topicId)
    const filesToDelete = await source.clearMessages(topicId)
    await this.flushRegularTopicMirror(topicId, { destructive: true })
    await this.cleanupFilesAfterConversationMirror(filesToDelete)
  }

  async topicExists(topicId: string): Promise<boolean> {
    const source = this.getDataSource(topicId)
    if (await source.topicExists(topicId)) return true
    return isAgentSessionTopicId(topicId) ? false : storageV2TopicExists(topicId)
  }

  async ensureTopic(topicId: string): Promise<void> {
    const source = this.getDataSource(topicId)
    await source.ensureTopic(topicId)
    this.scheduleRegularTopicMirror(topicId)
  }

  // ============ Optional Methods (with fallback) ============

  async getRawTopic(topicId: string): Promise<{ id: string; messages: Message[] } | undefined> {
    const source = this.getDataSource(topicId)
    if (isAgentSessionTopicId(topicId)) {
      return source.getRawTopic(topicId)
    }

    if (await shouldPreferStorageV2ConversationReads()) {
      const storageV2Messages = await fetchStorageV2TopicMessages(topicId)
      if (storageV2Messages) {
        return {
          id: topicId,
          messages: storageV2Messages.messages
        }
      }
    }

    const legacyTopic = await source.getRawTopic(topicId)
    if (legacyTopic?.messages?.length) {
      return legacyTopic
    }

    const storageV2Messages = await fetchStorageV2TopicMessages(topicId)
    return storageV2Messages
      ? {
          id: topicId,
          messages: storageV2Messages.messages
        }
      : legacyTopic
  }

  async updateSingleBlock(blockId: string, updates: Partial<MessageBlock>): Promise<void> {
    const state = store.getState()
    const existingBlock = state.messageBlocks.entities[blockId]

    if (!existingBlock) {
      logger.warn(`Block ${blockId} not found in state, defaulting to Dexie`)
      await this.dexieSource.updateSingleBlock(blockId, updates)
      storageV2ConversationMirrorService.scheduleBlocks([blockId], () => this.getState())
      return
    }

    const topicId = this.resolveMessageTopicId(existingBlock.messageId)

    if (topicId && isAgentSessionTopicId(topicId)) {
      await this.agentSource.updateSingleBlock(blockId, updates)
      return
    }

    // Default to Dexie for regular blocks
    await this.dexieSource.updateSingleBlock(blockId, updates)
    this.scheduleRegularTopicMirror(topicId)
  }

  async bulkAddBlocks(blocks: MessageBlock[]): Promise<void> {
    // For bulk add operations, default to Dexie since agent blocks use persistExchange
    await this.dexieSource.bulkAddBlocks(blocks)
    storageV2ConversationMirrorService.scheduleMessages(
      blocks.map((block) => block.messageId),
      () => this.getState()
    )
  }

  async updateFileCount(fileId: string, delta: number, deleteIfZero: boolean = false): Promise<void> {
    // File operations only apply to Dexie source
    await this.dexieSource.updateFileCount(fileId, delta, deleteIfZero)
    storageV2FileMirrorService.scheduleFile(fileId)
  }

  async updateFileCounts(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void> {
    // File operations only apply to Dexie source
    await this.dexieSource.updateFileCounts(files)
    storageV2FileMirrorService.scheduleFiles(files.map((file) => file.id))
  }

  // ============ Utility Methods ============

  /**
   * Check if a topic is an agent session
   */
  isAgentSession(topicId: string): boolean {
    return isAgentSessionTopicId(topicId)
  }

  /**
   * Get the data source type for a topic
   */
  getSourceType(topicId: string): 'dexie' | 'agent' | 'unknown' {
    if (isAgentSessionTopicId(topicId)) {
      return 'agent'
    }
    // Add more checks for other source types as needed
    return 'dexie'
  }
}

// Export singleton instance
export const dbService = DbService.getInstance()

// Also export class for testing purposes
export { DbService }
