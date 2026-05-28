import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'

import { fetchStorageV2TopicMessages } from './StorageV2ConversationHydrationService'

const logger = loggerService.withContext('StorageV2ConversationMirrorService')

const DEFAULT_DEBOUNCE_MS = 1500

type StateGetter = () => Record<string, any>

type TopicOwner = {
  assistantId: string
  topic: Topic
  sortOrder: number
}

type ConversationSnapshot = {
  assistantId: string
  sortOrder: number
  topic: Omit<Topic, 'messages'> & { messages: [] }
  messages: Message[]
  blocks: MessageBlock[]
}

type MirrorScheduleOptions = {
  destructive?: boolean
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stripTopicMessages(topic: Topic): Omit<Topic, 'messages'> & { messages: [] } {
  return {
    ...cloneJson(topic),
    messages: []
  }
}

function getUniqueAssistants(state: Record<string, any>): Assistant[] {
  const assistantsState = state.assistants ?? {}
  const assistantsById = new Map<string, Assistant>()

  if (assistantsState.defaultAssistant?.id) {
    assistantsById.set(assistantsState.defaultAssistant.id, assistantsState.defaultAssistant)
  }

  for (const assistant of assistantsState.assistants ?? []) {
    if (assistant?.id) {
      assistantsById.set(assistant.id, assistant)
    }
  }

  return Array.from(assistantsById.values())
}

function findTopicOwner(state: Record<string, any>, topicId: string): TopicOwner | null {
  for (const assistant of getUniqueAssistants(state)) {
    const topicIndex = assistant.topics?.findIndex((candidate) => candidate.id === topicId) ?? -1
    const topic = topicIndex >= 0 ? assistant.topics?.[topicIndex] : undefined
    if (topic) {
      return {
        assistantId: assistant.id,
        topic,
        sortOrder: topicIndex
      }
    }
  }

  return null
}

function buildFallbackTopic(topicId: string, messages: Message[]): TopicOwner | null {
  const firstMessage = messages[0]
  const assistantId = firstMessage?.assistantId

  if (!assistantId) return null

  const createdAt = firstMessage.createdAt ?? new Date().toISOString()
  const lastMessage = messages[messages.length - 1] ?? firstMessage
  const updatedAt = lastMessage.updatedAt ?? lastMessage.createdAt ?? createdAt

  return {
    assistantId,
    sortOrder: 0,
    topic: {
      id: topicId,
      assistantId,
      name: topicId,
      createdAt,
      updatedAt,
      messages: []
    }
  }
}

function getBlockFile(block: MessageBlock): FileMetadata | undefined {
  if ('file' in block && block.file && typeof block.file === 'object') {
    return block.file
  }

  return undefined
}

function collectFilesFromBlocks(blocks: MessageBlock[]) {
  const filesById = new Map<string, FileMetadata>()

  for (const block of blocks) {
    const file = getBlockFile(block)
    if (file?.id) {
      filesById.set(file.id, file)
    }
  }

  return filesById
}

function getTopicTitle(topic: Omit<Topic, 'messages'> & { messages: [] }) {
  const title = (topic as Record<string, any>).title
  return typeof topic.name === 'string' ? topic.name : typeof title === 'string' ? title : undefined
}

function getTopicSortOrder(topic: Omit<Topic, 'messages'> & { messages: [] }, fallbackSortOrder = 0) {
  const sortOrder = (topic as Record<string, any>).sortOrder
  return typeof sortOrder === 'number' ? sortOrder : fallbackSortOrder
}

function getMirrorMessageId(topicId: string, message: Message, index: number) {
  return typeof message.id === 'string' && message.id ? message.id : `${topicId}:message:${index}`
}

function getMirrorBlockId(messageId: string, block: MessageBlock, index: number) {
  return typeof block.id === 'string' && block.id ? block.id : `${messageId}:block:${index}`
}

class StorageV2ConversationMirrorService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestGetState: StateGetter | null = null
  private pendingTopicIds = new Set<string>()
  private pendingDestructiveTopicIds = new Set<string>()
  private pendingMessageIds = new Set<string>()
  private pendingBlockIds = new Set<string>()
  private lastTopicSnapshotJson = new Map<string, string>()
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false
  private lastError: unknown = null

  scheduleTopic(
    topicId: string | undefined,
    getState: StateGetter,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    options: MirrorScheduleOptions = {}
  ) {
    if (this.suspended) return
    if (!topicId) return
    this.latestGetState = getState
    this.pendingTopicIds.add(topicId)
    if (options.destructive) {
      this.pendingDestructiveTopicIds.add(topicId)
    }
    this.scheduleFlush(debounceMs)
  }

  scheduleTopics(
    topicIds: Iterable<string | undefined>,
    getState: StateGetter,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    options: MirrorScheduleOptions = {}
  ) {
    if (this.suspended) return
    let hasPending = false

    for (const topicId of topicIds) {
      if (!topicId) continue
      this.pendingTopicIds.add(topicId)
      if (options.destructive) {
        this.pendingDestructiveTopicIds.add(topicId)
      }
      hasPending = true
    }

    if (!hasPending) return

    this.latestGetState = getState
    this.scheduleFlush(debounceMs)
  }

  scheduleMessages(messageIds: Iterable<string | undefined>, getState: StateGetter, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended) return
    let hasPending = false

    for (const messageId of messageIds) {
      if (!messageId) continue
      this.pendingMessageIds.add(messageId)
      hasPending = true
    }

    if (!hasPending) return

    this.latestGetState = getState
    this.scheduleFlush(debounceMs)
  }

  scheduleBlocks(blockIds: Iterable<string | undefined>, getState: StateGetter, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended) return
    let hasPending = false

    for (const blockId of blockIds) {
      if (!blockId) continue
      this.pendingBlockIds.add(blockId)
      hasPending = true
    }

    if (!hasPending) return

    this.latestGetState = getState
    this.scheduleFlush(debounceMs)
  }

  async flushTopic(topicId: string | undefined, getState: StateGetter, options: MirrorScheduleOptions = {}) {
    this.scheduleTopic(topicId, getState, 0, options)
    await this.flush()
    if (options.destructive) {
      this.throwPendingDestructiveError([topicId])
      await this.flushStrict()
    }
  }

  async flushTopics(
    topicIds: Iterable<string | undefined>,
    getState: StateGetter,
    options: MirrorScheduleOptions = {}
  ) {
    const topicIdList = Array.from(topicIds)
    this.scheduleTopics(topicIdList, getState, 0, options)
    await this.flush()
    if (options.destructive) {
      this.throwPendingDestructiveError(topicIdList)
      await this.flushStrict()
    }
  }

  async findTopicIdsForBlockIds(blockIds: Iterable<string | undefined>, getState: StateGetter): Promise<Set<string>> {
    const topicIds = new Set<string>()
    if (this.suspended) return topicIds

    const blockIdList = Array.from(new Set(Array.from(blockIds).filter(Boolean))) as string[]
    if (blockIdList.length === 0) return topicIds

    try {
      const blocks = await db.message_blocks.where('id').anyOf(blockIdList).toArray()
      const messageIds = blocks.map((block) => block.messageId).filter(Boolean)
      return this.resolveTopicIdsForMessageIds(messageIds, getState())
    } catch (error) {
      logger.warn('Failed to resolve Storage v2 mirror topics from block ids', error as Error)
      return topicIds
    }
  }

  async flush() {
    if (this.suspended) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.inflight) {
      this.needsFollowUp = true
      await this.inflight
      if (this.needsFollowUp) {
        this.needsFollowUp = false
        await this.flush()
      }
      return
    }

    if (!this.hasPendingWork()) return

    this.inflight = this.mirrorPendingNow().finally(() => {
      this.inflight = null
    })

    await this.inflight
  }

  async flushStrict() {
    await this.flush()

    if (!this.hasPendingWork()) return

    if (!window.api?.storageV2) {
      throw new Error('Storage v2 API unavailable while conversation mirror work is pending')
    }

    if (this.lastError) {
      throw this.lastError instanceof Error ? this.lastError : new Error('Failed to mirror conversations to Storage v2')
    }

    throw new Error('Conversation mirror work is still pending after strict flush')
  }

  private scheduleFlush(debounceMs: number) {
    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, debounceMs)
  }

  private hasPendingWork() {
    return this.pendingTopicIds.size > 0 || this.pendingMessageIds.size > 0 || this.pendingBlockIds.size > 0
  }

  private throwPendingDestructiveError(topicIds: Iterable<string | undefined>) {
    if (!this.lastError) return

    for (const topicId of topicIds) {
      if (!topicId || !this.pendingDestructiveTopicIds.has(topicId)) continue
      throw this.lastError instanceof Error ? this.lastError : new Error('Failed to mirror conversations to Storage v2')
    }
  }

  private async mirrorPendingNow() {
    if (!this.latestGetState) return

    if (!window.api?.storageV2) {
      this.scheduleFlush(DEFAULT_DEBOUNCE_MS)
      return
    }

    const getState = this.latestGetState
    const state = getState()
    const topicIds = new Set(this.pendingTopicIds)
    const destructiveTopicIds = new Set(this.pendingDestructiveTopicIds)
    const messageIds = new Set(this.pendingMessageIds)
    const blockIds = new Set(this.pendingBlockIds)

    this.pendingTopicIds.clear()
    this.pendingDestructiveTopicIds.clear()
    this.pendingMessageIds.clear()
    this.pendingBlockIds.clear()

    for (const topicId of await this.resolveTopicIdsForMessageIds(messageIds, state)) {
      topicIds.add(topicId)
    }

    if (blockIds.size > 0) {
      try {
        const blocks = await db.message_blocks.where('id').anyOf(Array.from(blockIds)).toArray()
        for (const topicId of await this.resolveTopicIdsForMessageIds(
          blocks.map((block) => block.messageId),
          state
        )) {
          topicIds.add(topicId)
        }
      } catch (error) {
        logger.warn('Failed to resolve Storage v2 mirror topics from pending block ids', error as Error)
      }
    }

    if (topicIds.size === 0) {
      this.lastError = null
      return
    }

    try {
      const conversations: ConversationSnapshot[] = []
      const filesById = new Map<string, FileMetadata>()
      const pendingSnapshots = new Map<string, string>()

      for (const topicId of topicIds) {
        const snapshot = await this.buildMirrorSnapshot(topicId, state, {
          destructive: destructiveTopicIds.has(topicId)
        })
        if (!snapshot) continue

        const snapshotJson = JSON.stringify(snapshot.conversation)
        if (snapshotJson === this.lastTopicSnapshotJson.get(topicId)) continue

        pendingSnapshots.set(topicId, snapshotJson)
        conversations.push(snapshot.conversation)

        for (const [fileId, file] of snapshot.files) {
          filesById.set(fileId, file)
        }
      }

      if (conversations.length === 0) {
        this.lastError = null
        return
      }

      await this.mirrorConversations(conversations, Array.from(filesById.values()))

      for (const [topicId, snapshotJson] of pendingSnapshots) {
        this.lastTopicSnapshotJson.set(topicId, snapshotJson)
      }

      logger.debug(`Mirrored ${conversations.length} conversation(s) to Storage v2`)
      this.lastError = null
    } catch (error) {
      for (const topicId of topicIds) {
        this.pendingTopicIds.add(topicId)
        if (destructiveTopicIds.has(topicId)) {
          this.pendingDestructiveTopicIds.add(topicId)
        }
      }
      this.scheduleFlush(DEFAULT_DEBOUNCE_MS)
      this.lastError = error

      logger.warn('Failed to mirror conversations to Storage v2', error as Error)
    }
  }

  private async mirrorConversations(conversations: ConversationSnapshot[], files: FileMetadata[]) {
    const storageV2 = window.api.storageV2
    const canSyncConversation = typeof storageV2.syncConversation === 'function'
    const canUseDirectApi =
      typeof storageV2.upsertConversation === 'function' &&
      typeof storageV2.upsertMessage === 'function' &&
      typeof storageV2.upsertMessageBlocks === 'function'

    if (canSyncConversation) {
      for (const conversation of conversations) {
        await storageV2.syncConversation(this.toConversationImport(conversation))
      }

      await this.mirrorFiles(files)
      return
    }

    if (!canUseDirectApi) {
      await storageV2.importLegacyDexieSnapshot(
        {
          conversations,
          files
        },
        { dryRun: false }
      )
      return
    }

    for (const conversation of conversations) {
      await this.mirrorConversationDirect(conversation)
    }

    await this.mirrorFiles(files)
  }

  private async mirrorFiles(files: FileMetadata[]) {
    if (files.length > 0) {
      const storageV2 = window.api.storageV2

      if (typeof storageV2.upsertFile === 'function') {
        for (const file of files) {
          await storageV2.upsertFile(file)
        }
      } else {
        await storageV2.importLegacyDexieSnapshot(
          {
            conversations: [],
            files
          },
          { dryRun: false }
        )
      }
    }
  }

  private toConversationImport(conversation: ConversationSnapshot) {
    const topic = conversation.topic

    return {
      id: topic.id,
      kind: 'assistant_chat',
      ownerType: 'assistant',
      ownerId: conversation.assistantId,
      title: getTopicTitle(topic),
      pinned: Boolean((topic as Record<string, any>).pinned),
      archived: false,
      sortOrder: getTopicSortOrder(topic, conversation.sortOrder),
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt ?? topic.createdAt,
      messages: conversation.messages,
      blocks: conversation.blocks
    }
  }

  private async mirrorConversationDirect(conversation: ConversationSnapshot) {
    const topic = conversation.topic
    const topicId = topic.id
    const activeMessageIds = conversation.messages.map((message, index) => getMirrorMessageId(topicId, message, index))
    const blocksByMessage = new Map<string, MessageBlock[]>()

    for (const block of conversation.blocks) {
      const blocks = blocksByMessage.get(block.messageId) ?? []
      blocks.push(block)
      blocksByMessage.set(block.messageId, blocks)
    }

    await window.api.storageV2.upsertConversation(
      {
        id: topicId,
        kind: 'assistant_chat',
        ownerType: 'assistant',
        ownerId: conversation.assistantId,
        title: getTopicTitle(topic),
        pinned: Boolean((topic as Record<string, any>).pinned),
        archived: false,
        sortOrder: getTopicSortOrder(topic, conversation.sortOrder),
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt ?? topic.createdAt
      },
      {
        pruneMissingMessages: true,
        activeMessageIds
      }
    )

    for (const [messageIndex, message] of conversation.messages.entries()) {
      const messageId = activeMessageIds[messageIndex]
      const messageBlocks = blocksByMessage.get(messageId) ?? []

      await window.api.storageV2.upsertMessage(topicId, {
        ...message,
        id: messageId
      })
      await window.api.storageV2.upsertMessageBlocks(
        messageId,
        messageBlocks.map((block, blockIndex) => ({
          ...block,
          id: getMirrorBlockId(messageId, block, blockIndex),
          messageId
        })),
        { pruneMissing: true }
      )
    }
  }

  suspendUntilReload() {
    this.suspended = true
    this.latestGetState = null
    this.pendingTopicIds.clear()
    this.pendingDestructiveTopicIds.clear()
    this.pendingMessageIds.clear()
    this.pendingBlockIds.clear()
    this.needsFollowUp = false
    this.lastError = null

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async resolveTopicIdsForMessageIds(
    messageIds: Iterable<string | undefined>,
    state: Record<string, any>
  ): Promise<Set<string>> {
    const topicIds = new Set<string>()
    const unresolvedMessageIds = new Set<string>()
    const messageEntities = state.messages?.entities ?? {}

    for (const messageId of messageIds) {
      if (!messageId) continue

      const topicId = messageEntities[messageId]?.topicId
      if (topicId) {
        topicIds.add(topicId)
      } else {
        unresolvedMessageIds.add(messageId)
      }
    }

    if (unresolvedMessageIds.size === 0) return topicIds

    try {
      const topics = await db.topics.toArray()

      for (const topic of topics) {
        if (!topic?.id || !Array.isArray(topic.messages)) continue
        if (topic.messages.some((message) => unresolvedMessageIds.has(message.id))) {
          topicIds.add(topic.id)
        }
      }
    } catch (error) {
      logger.warn('Failed to resolve Storage v2 mirror topics from Dexie messages', error as Error)
    }

    return topicIds
  }

  private async buildTopicSnapshot(
    topicId: string,
    state: Record<string, any>
  ): Promise<{ conversation: ConversationSnapshot; files: Map<string, FileMetadata> } | null> {
    const persistedTopic = await db.topics.get(topicId)
    if (!persistedTopic) {
      logger.debug(`Skipped Storage v2 mirror for topic ${topicId}: missing Dexie topic cache`)
      return null
    }

    const messages = persistedTopic?.messages ?? []
    const owner = findTopicOwner(state, topicId) ?? buildFallbackTopic(topicId, messages)

    if (!owner) {
      logger.debug(`Skipped Storage v2 mirror for topic ${topicId}: missing assistant owner`)
      return null
    }

    const messageIds = messages
      .map((message) => message.id)
      .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0)
    const blocks = messageIds.length ? await db.message_blocks.where('messageId').anyOf(messageIds).toArray() : []
    const files = collectFilesFromBlocks(blocks)

    for (const fileId of files.keys()) {
      const persistedFile = await db.files.get(fileId)
      if (persistedFile) {
        files.set(fileId, persistedFile)
      }
    }

    return {
      conversation: {
        assistantId: owner.assistantId,
        sortOrder: owner.sortOrder,
        topic: stripTopicMessages(owner.topic),
        messages,
        blocks
      },
      files
    }
  }

  private async buildMirrorSnapshot(
    topicId: string,
    state: Record<string, any>,
    options: MirrorScheduleOptions
  ): Promise<{ conversation: ConversationSnapshot; files: Map<string, FileMetadata> } | null> {
    const snapshot = await this.buildTopicSnapshot(topicId, state)
    if (!snapshot || options.destructive) {
      return snapshot
    }

    await this.seedStorageV2TopicWithoutPruning(snapshot.conversation)
    await fetchStorageV2TopicMessages(topicId).catch((error) => {
      logger.warn('Failed to pre-hydrate Storage v2 topic before mirror prune', error as Error)
      return null
    })

    return (await this.buildTopicSnapshot(topicId, state)) ?? snapshot
  }

  private async seedStorageV2TopicWithoutPruning(conversation: ConversationSnapshot) {
    const storageV2 = window.api?.storageV2
    if (typeof storageV2?.syncConversation !== 'function') return

    await storageV2.syncConversation(this.toConversationImport(conversation), {
      pruneMissingMessages: false,
      pruneMissingBlocks: false
    })
  }
}

export const storageV2ConversationMirrorService = new StorageV2ConversationMirrorService()
