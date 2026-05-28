import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { FileMetadata } from '@renderer/types'
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

type StorageV2StoredConversation = {
  id: string
  ownerId?: string
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

async function getConversationOwnerId(topicId: string) {
  const conversations = (await listStorageV2Conversations({ ownerType: 'assistant' })) as StorageV2StoredConversation[]
  return conversations.find((conversation) => conversation.id === topicId)?.ownerId ?? ''
}

async function seedDexieTopic(topicId: string, messages: Message[], blocks: MessageBlock[]) {
  const files = collectFilesFromBlocks(blocks)

  await db.transaction('rw', db.topics, db.message_blocks, db.files, async () => {
    const existingTopic = await db.topics.get(topicId)
    const nextBlockIds = new Set(blocks.map((block) => block.id))
    const oldBlockIds = (existingTopic?.messages ?? [])
      .flatMap((message) => message.blocks ?? [])
      .filter((blockId) => !nextBlockIds.has(blockId))

    if (oldBlockIds.length > 0) {
      await db.message_blocks.bulkDelete(oldBlockIds)
    }

    if (blocks.length > 0) {
      await db.message_blocks.bulkPut(blocks)
    }

    if (files.length > 0) {
      await db.files.bulkPut(files)
    }

    await db.topics.put({
      id: topicId,
      messages
    })
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
    const conversations = (await listStorageV2Conversations({
      ownerType: 'assistant'
    })) as StorageV2StoredConversation[]
    return conversations.some((conversation) => conversation.id === topicId)
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
    const storedMessages = await listAllStorageV2Messages(topicId)
    if (storedMessages.length === 0) return null

    const assistantId = await getConversationOwnerId(topicId)
    const blocks = await normalizeBlocksForRuntime(
      storedMessages.flatMap((message) => message.blocks.map(toMessageBlock))
    )
    const messages = storedMessages.map((message) => toMessage(topicId, assistantId, message))

    if (options.seedDexie !== false) {
      await seedDexieTopic(topicId, messages, blocks)
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
  } catch (error) {
    logger.warn('Failed to hydrate topic messages from Storage v2', error as Error)
    return null
  }
}
