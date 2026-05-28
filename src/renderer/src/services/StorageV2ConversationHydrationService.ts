import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { FileMetadata, Topic } from '@renderer/types'
import {
  AssistantMessageStatus,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'

import { getStorageV2AutoHydrateEnabled } from './StorageV2HydrationService'
import { listStorageV2Conversations, listStorageV2Messages } from './StorageV2Service'

const logger = loggerService.withContext('StorageV2ConversationHydrationService')
let filesPathPromise: Promise<string | null> | null = null
let hydrateConversationsPromise: Promise<boolean> | null = null

type StorageV2StoredConversation = {
  id: string
  ownerId?: string
  title?: string | null
  createdAt?: string
  updatedAt?: string | null
  pinned?: boolean
}

type StorageV2StoredMessageBlock = {
  id: string
  messageId: string
  type: string
  ordinal: number
  text: string | null
  payload: Record<string, unknown> | null
  createdAt: string
  updatedAt?: string | null
}

type StorageV2StoredMessage = {
  id: string
  role: string
  status: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt?: string | null
  blocks: StorageV2StoredMessageBlock[]
}

type DexieConversationTopic = {
  id: string
  messages: Message[]
} & Partial<Topic>

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getMessageStatus(role: string, status: string | null) {
  if (status) return status
  return role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS
}

function normalizeBlockType(type: string): MessageBlockType {
  return Object.values(MessageBlockType).includes(type as MessageBlockType)
    ? (type as MessageBlockType)
    : MessageBlockType.UNKNOWN
}

function getFileExt(file: FileMetadata) {
  if (file.ext) return file.ext.startsWith('.') ? file.ext : `.${file.ext}`
  const name = file.origin_name || file.name || ''
  const dotIndex = name.lastIndexOf('.')
  return dotIndex >= 0 ? name.slice(dotIndex) : ''
}

function isFileBlock(block: MessageBlock): block is MessageBlock & { file: FileMetadata } {
  return (
    (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) &&
    isRecord((block as unknown as Record<string, unknown>).file) &&
    typeof (block as Record<string, any>).file.id === 'string'
  )
}

function normalizeFileForRuntime(file: FileMetadata, filesPath: string | null): FileMetadata {
  const ext = getFileExt(file)
  return {
    ...file,
    name: file.name || `${file.id}${ext}`,
    origin_name: file.origin_name || file.name || `${file.id}${ext}`,
    ext,
    path: filesPath ? `${filesPath}/${file.id}${ext}` : file.path,
    count: typeof file.count === 'number' && file.count > 0 ? file.count : 1
  }
}

function collectFilesFromBlocks(blocks: MessageBlock[]) {
  const filesById = new Map<string, FileMetadata>()

  for (const block of blocks) {
    if (isFileBlock(block)) {
      filesById.set(block.file.id, block.file)
    }
  }

  return Array.from(filesById.values())
}

function collectFileIdsFromBlocks(blocks: MessageBlock[]) {
  const fileIds = new Set<string>()

  for (const block of blocks) {
    if (isFileBlock(block)) {
      fileIds.add(block.file.id)
    }
  }

  return fileIds
}

async function getFilesPath() {
  if (!filesPathPromise) {
    filesPathPromise = window.api
      .getAppInfo()
      .then((info) => (typeof info?.filesPath === 'string' ? info.filesPath : null))
      .catch(() => null)
  }

  return filesPathPromise
}

async function normalizeBlocksForRuntime(blocks: MessageBlock[]) {
  if (!blocks.some(isFileBlock)) return blocks

  const filesPath = await getFilesPath()
  return blocks.map((block) => {
    if (!isFileBlock(block)) return block

    return {
      ...block,
      file: normalizeFileForRuntime(block.file, filesPath)
    } as MessageBlock
  })
}

function toMessageBlock(block: StorageV2StoredMessageBlock): MessageBlock {
  const payload = isRecord(block.payload) ? block.payload : {}
  const restored = {
    ...payload,
    id: block.id,
    messageId: block.messageId,
    type: normalizeBlockType(block.type),
    createdAt: block.createdAt,
    updatedAt: block.updatedAt ?? undefined,
    status:
      typeof payload.status === 'string'
        ? payload.status
        : block.type === MessageBlockType.UNKNOWN
          ? MessageBlockStatus.PENDING
          : MessageBlockStatus.SUCCESS
  } as Record<string, any>

  if (!('content' in restored) && typeof block.text === 'string') {
    restored.content = block.text
  }

  return restored as MessageBlock
}

function toMessage(topicId: string, assistantId: string, message: StorageV2StoredMessage): Message {
  const metadata = isRecord(message.metadata) ? message.metadata : {}
  const role =
    message.role === 'user' || message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
  const blockIds = message.blocks
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((block) => block.id)

  return {
    ...metadata,
    id: message.id,
    role,
    assistantId: typeof metadata.assistantId === 'string' ? metadata.assistantId : assistantId,
    topicId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt ?? undefined,
    status: getMessageStatus(role, message.status) as Message['status'],
    blocks: blockIds
  } as Message
}

async function getStorageV2Conversation(topicId: string) {
  const conversations = (await listStorageV2Conversations({ ownerType: 'assistant' })) as StorageV2StoredConversation[]
  return conversations.find((conversation) => conversation.id === topicId) ?? null
}

function toDexieTopic(
  topicId: string,
  messages: Message[],
  conversation?: StorageV2StoredConversation | null
): DexieConversationTopic {
  const firstMessage = messages[0]
  const lastMessage = messages.at(-1)
  const createdAt = conversation?.createdAt ?? firstMessage?.createdAt ?? new Date().toISOString()
  const updatedAt = conversation?.updatedAt ?? lastMessage?.updatedAt ?? lastMessage?.createdAt ?? createdAt

  const topic: DexieConversationTopic = {
    id: topicId,
    assistantId: conversation?.ownerId ?? firstMessage?.assistantId ?? '',
    name: conversation?.title || topicId,
    createdAt,
    updatedAt,
    messages
  }

  if (typeof conversation?.pinned === 'boolean') {
    topic.pinned = conversation.pinned
  }

  return topic
}

async function seedDexieTopic(
  topicId: string,
  messages: Message[],
  blocks: MessageBlock[],
  conversation?: StorageV2StoredConversation | null
) {
  const files = collectFilesFromBlocks(blocks)

  await db.transaction('rw', db.topics, db.message_blocks, db.files, async () => {
    const existingTopic = await db.topics.get(topicId)
    const nextBlockIds = new Set(blocks.map((block) => block.id))
    const nextFileIds = collectFileIdsFromBlocks(blocks)
    const oldBlockIds = (existingTopic?.messages ?? [])
      .flatMap((message) => message.blocks ?? [])
      .filter((blockId) => !nextBlockIds.has(blockId))
    const oldBlocks = oldBlockIds.length > 0 ? await db.message_blocks.where('id').anyOf(oldBlockIds).toArray() : []
    const removedFileIds = Array.from(collectFileIdsFromBlocks(oldBlocks)).filter((fileId) => !nextFileIds.has(fileId))

    if (oldBlockIds.length > 0) {
      await db.message_blocks.bulkDelete(oldBlockIds)
    }

    if (blocks.length > 0) {
      await db.message_blocks.bulkPut(blocks)
    }

    if (files.length > 0) {
      await db.files.bulkPut(files)
    }

    if (removedFileIds.length > 0) {
      const remainingFileBlocks = await db.message_blocks.where('file.id').anyOf(removedFileIds).toArray()
      const stillReferencedFileIds = collectFileIdsFromBlocks(remainingFileBlocks)
      const orphanedFileIds = removedFileIds.filter((fileId) => !stillReferencedFileIds.has(fileId))

      if (orphanedFileIds.length > 0) {
        await db.files.bulkDelete(orphanedFileIds)
      }
    }

    await db.topics.put(toDexieTopic(topicId, messages, conversation))
  })
}

async function listAllStorageV2Messages(topicId: string): Promise<StorageV2StoredMessage[]> {
  const pageSize = 1000
  const messages: StorageV2StoredMessage[] = []

  for (let offset = 0; ; offset += pageSize) {
    const page = (await listStorageV2Messages(topicId, {
      limit: pageSize,
      offset
    })) as StorageV2StoredMessage[]
    messages.push(...page)

    if (page.length < pageSize) {
      return messages
    }
  }
}

export async function shouldPreferStorageV2ConversationReads(): Promise<boolean> {
  return getStorageV2AutoHydrateEnabled().catch(() => false)
}

export async function storageV2TopicExists(topicId: string): Promise<boolean> {
  try {
    return Boolean(await getStorageV2Conversation(topicId))
  } catch (error) {
    logger.warn('Failed to check Storage v2 topic existence', error as Error)
    return false
  }
}

export async function fetchStorageV2TopicMessages(
  topicId: string,
  options: {
    seedDexie?: boolean
  } = {}
): Promise<{
  messages: Message[]
  blocks: MessageBlock[]
} | null> {
  try {
    const conversation = await getStorageV2Conversation(topicId)
    if (!conversation) return null

    return await fetchStorageV2TopicMessagesForConversation(conversation, options)
  } catch (error) {
    logger.warn('Failed to hydrate topic messages from Storage v2', error as Error)
    return null
  }
}

async function fetchStorageV2TopicMessagesForConversation(
  conversation: StorageV2StoredConversation,
  options: {
    seedDexie?: boolean
  } = {}
): Promise<{
  messages: Message[]
  blocks: MessageBlock[]
} | null> {
  const topicId = conversation.id
  const storedMessages = await listAllStorageV2Messages(topicId)

  if (storedMessages.length === 0) {
    if (options.seedDexie !== false) {
      await seedDexieTopic(topicId, [], [], conversation)
    }

    return {
      messages: [],
      blocks: []
    }
  }

  const assistantId = conversation.ownerId ?? ''
  const blocks = await normalizeBlocksForRuntime(
    storedMessages.flatMap((message) => message.blocks.map(toMessageBlock))
  )
  const messages = storedMessages.map((message) => toMessage(topicId, assistantId, message))

  if (options.seedDexie !== false) {
    await seedDexieTopic(topicId, messages, blocks, conversation)
  }

  logger.info('Hydrated topic messages from Storage v2', {
    topicId,
    messageCount: messages.length,
    blockCount: blocks.length
  })

  return {
    messages,
    blocks
  }
}

async function shouldHydrateDexieConversationCache() {
  const topicCount = await db.topics.count()
  if (topicCount === 0) return true

  const blockCount = await db.message_blocks.count()
  if (blockCount > 0) return false

  const topics = await db.topics.toArray()
  return topics.some((topic) => topic.messages?.some((message) => (message.blocks?.length ?? 0) > 0))
}

export async function hydrateStorageV2ConversationsIfDexieEmpty(reason: string): Promise<boolean> {
  if (hydrateConversationsPromise) {
    return hydrateConversationsPromise
  }

  hydrateConversationsPromise = (async () => {
    try {
      const shouldHydrateAll = await shouldHydrateDexieConversationCache()

      const conversations = (await listStorageV2Conversations({
        ownerType: 'assistant'
      })) as StorageV2StoredConversation[]

      if (conversations.length === 0) {
        return false
      }

      const existingDexieTopics = shouldHydrateAll
        ? new Map<string, DexieConversationTopic>()
        : new Map((await db.topics.toArray()).map((topic) => [topic.id, topic as DexieConversationTopic]))
      const conversationsToHydrate = shouldHydrateAll
        ? conversations
        : conversations.filter((conversation) => {
            const existingTopic = existingDexieTopics.get(conversation.id)
            return !existingTopic || (existingTopic.messages?.length ?? 0) === 0
          })

      if (conversationsToHydrate.length === 0) {
        return false
      }

      let hydratedCount = 0

      for (const conversation of conversationsToHydrate) {
        try {
          const result = await fetchStorageV2TopicMessagesForConversation(conversation)
          if (result) {
            hydratedCount += 1
          }
        } catch (error) {
          logger.warn('Failed to hydrate assistant conversation from Storage v2', error as Error)
        }
      }

      if (hydratedCount > 0) {
        logger.info('Hydrated assistant conversations from Storage v2 into Dexie cache', {
          reason,
          conversationCount: hydratedCount
        })
      }

      return hydratedCount > 0
    } catch (error) {
      logger.warn('Failed to hydrate assistant conversations from Storage v2', error as Error)
      return false
    } finally {
      hydrateConversationsPromise = null
    }
  })()

  return hydrateConversationsPromise
}
