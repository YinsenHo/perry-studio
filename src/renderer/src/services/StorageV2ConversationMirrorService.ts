import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'

const logger = loggerService.withContext('StorageV2ConversationMirrorService')

const DEFAULT_DEBOUNCE_MS = 1500

type StateGetter = () => Record<string, any>

type TopicOwner = {
  assistantId: string
  topic: Topic
}

type ConversationSnapshot = {
  assistantId: string
  topic: Omit<Topic, 'messages'> & { messages: [] }
  messages: Message[]
  blocks: MessageBlock[]
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
    const topic = assistant.topics?.find((candidate) => candidate.id === topicId)
    if (topic) {
      return {
        assistantId: assistant.id,
        topic
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

class StorageV2ConversationMirrorService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestGetState: StateGetter | null = null
  private pendingTopicIds = new Set<string>()
  private pendingMessageIds = new Set<string>()
  private pendingBlockIds = new Set<string>()
  private lastTopicSnapshotJson = new Map<string, string>()
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false

  scheduleTopic(topicId: string | undefined, getState: StateGetter, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended) return
    if (!topicId) return
    this.latestGetState = getState
    this.pendingTopicIds.add(topicId)
    this.scheduleFlush(debounceMs)
  }

  scheduleTopics(topicIds: Iterable<string | undefined>, getState: StateGetter, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended) return
    let hasPending = false

    for (const topicId of topicIds) {
      if (!topicId) continue
      this.pendingTopicIds.add(topicId)
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

  private async mirrorPendingNow() {
    if (!this.latestGetState || !window.api?.storageV2) return

    const getState = this.latestGetState
    const state = getState()
    const topicIds = new Set(this.pendingTopicIds)
    const messageIds = new Set(this.pendingMessageIds)
    const blockIds = new Set(this.pendingBlockIds)

    this.pendingTopicIds.clear()
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

    if (topicIds.size === 0) return

    const conversations: ConversationSnapshot[] = []
    const filesById = new Map<string, FileMetadata>()
    const pendingSnapshots = new Map<string, string>()

    for (const topicId of topicIds) {
      const snapshot = await this.buildTopicSnapshot(topicId, state)
      if (!snapshot) continue

      const snapshotJson = JSON.stringify(snapshot.conversation)
      if (snapshotJson === this.lastTopicSnapshotJson.get(topicId)) continue

      pendingSnapshots.set(topicId, snapshotJson)
      conversations.push(snapshot.conversation)

      for (const [fileId, file] of snapshot.files) {
        filesById.set(fileId, file)
      }
    }

    if (conversations.length === 0) return

    try {
      await window.api.storageV2.importLegacyDexieSnapshot(
        {
          conversations,
          files: Array.from(filesById.values())
        },
        { dryRun: false }
      )

      for (const [topicId, snapshotJson] of pendingSnapshots) {
        this.lastTopicSnapshotJson.set(topicId, snapshotJson)
      }

      logger.debug(`Mirrored ${conversations.length} conversation(s) to Storage v2`)
    } catch (error) {
      logger.warn('Failed to mirror conversations to Storage v2', error as Error)
    }
  }

  suspendUntilReload() {
    this.suspended = true
    this.latestGetState = null
    this.pendingTopicIds.clear()
    this.pendingMessageIds.clear()
    this.pendingBlockIds.clear()
    this.needsFollowUp = false

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
        topic: stripTopicMessages(owner.topic),
        messages,
        blocks
      },
      files
    }
  }
}

export const storageV2ConversationMirrorService = new StorageV2ConversationMirrorService()
