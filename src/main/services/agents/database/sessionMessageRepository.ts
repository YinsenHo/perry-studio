import { createHash } from 'node:crypto'

import { loggerService } from '@logger'
import { storageV2ConversationRepository } from '@main/services/storageV2/StorageV2Repositories'
import type {
  AgentMessageAssistantPersistPayload,
  AgentMessagePersistExchangePayload,
  AgentMessagePersistExchangeResult,
  AgentMessageUserPersistPayload,
  AgentPersistedMessage,
  AgentSessionMessageEntity
} from '@types'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { BaseService } from '../BaseService'
import type { InsertSessionMessageRow, SessionMessageRow } from './schema'
import { sessionMessagesTable, sessionsTable } from './schema'

const logger = loggerService.withContext('AgentMessageRepository')
const GENERATED_MESSAGE_ID_PREFIX = 4_000_000_000_000_000

export type PersistUserMessageParams = AgentMessageUserPersistPayload & {
  sessionId: string
  agentSessionId?: string
}

export type PersistAssistantMessageParams = AgentMessageAssistantPersistPayload & {
  sessionId: string
  agentSessionId: string
}

class AgentMessageRepository extends BaseService {
  private static instance: AgentMessageRepository | null = null

  static getInstance(): AgentMessageRepository {
    if (!AgentMessageRepository.instance) {
      AgentMessageRepository.instance = new AgentMessageRepository()
    }

    return AgentMessageRepository.instance
  }

  private serializeMessage(payload: AgentPersistedMessage): string {
    return JSON.stringify(payload)
  }

  private serializeMetadata(metadata?: Record<string, unknown>): string | undefined {
    if (!metadata) {
      return undefined
    }

    try {
      return JSON.stringify(metadata)
    } catch (error) {
      logger.warn('Failed to serialize session message metadata', error as Error)
      return undefined
    }
  }

  private deserialize(row: any): AgentSessionMessageEntity {
    if (!row) return row

    const deserialized = { ...row }

    if (typeof deserialized.content === 'string') {
      try {
        deserialized.content = JSON.parse(deserialized.content)
      } catch (error) {
        logger.warn('Failed to parse session message content JSON', error as Error)
      }
    }

    if (typeof deserialized.metadata === 'string') {
      try {
        deserialized.metadata = JSON.parse(deserialized.metadata)
      } catch (error) {
        logger.warn('Failed to parse session message metadata JSON', error as Error)
      }
    }

    return deserialized
  }

  private generateMessageRowId(sessionId: string, role: string, messageId: string): number {
    const digest = createHash('sha256').update(`${sessionId}:${role}:${messageId}`).digest('hex')
    return GENERATED_MESSAGE_ID_PREFIX + Number.parseInt(digest.slice(0, 12), 16)
  }

  private extractMessageText(payload: AgentPersistedMessage): string | null {
    const parts: string[] = []
    const messageContent = (payload.message as { content?: unknown }).content

    if (typeof messageContent === 'string') {
      parts.push(messageContent)
    } else if (Array.isArray(messageContent)) {
      for (const entry of messageContent) {
        if (typeof entry === 'string') {
          parts.push(entry)
        } else if (entry && typeof entry === 'object') {
          const text = (entry as { text?: unknown; content?: unknown }).text ?? (entry as { content?: unknown }).content
          if (typeof text === 'string') parts.push(text)
        }
      }
    }

    for (const block of payload.blocks ?? []) {
      const text = (block as { text?: unknown; content?: unknown }).text ?? (block as { content?: unknown }).content
      if (typeof text === 'string') parts.push(text)
    }

    const uniqueParts = Array.from(new Set(parts.map((part) => part.trim()).filter(Boolean)))
    return uniqueParts.length > 0 ? uniqueParts.join('\n') : null
  }

  private async upsertStorageV2Message(
    database: Awaited<ReturnType<typeof this.getDatabase>>,
    input: {
      legacyRowId: number
      sessionId: string
      agentSessionId: string
      payload: AgentPersistedMessage
      metadata?: Record<string, unknown>
      createdAt: string
    }
  ): Promise<void> {
    const sessionRows = await database
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, input.sessionId))
      .limit(1)
    const session = sessionRows[0]
    const conversationId = `agent-session:${input.sessionId}`
    const messageId = `agent-message:${input.legacyRowId}`
    const blockId = `agent-message-block:${input.legacyRowId}`
    const payloadMessage = input.payload.message as Record<string, unknown>

    await storageV2ConversationRepository.upsertConversation({
      id: conversationId,
      kind: 'agent_session',
      ownerType: 'agent',
      ownerId: session?.agent_id ?? 'unknown',
      sessionId: input.sessionId,
      title: session?.name ?? input.sessionId,
      sortOrder: session?.sort_order ?? 0,
      createdAt: session?.created_at ?? input.createdAt,
      updatedAt: input.createdAt
    })

    await storageV2ConversationRepository.upsertMessage(conversationId, {
      ...payloadMessage,
      id: messageId,
      role: input.payload.message.role,
      requestId: input.payload.message.id,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      metadata: {
        legacyId: input.legacyRowId,
        agentSessionId: input.agentSessionId,
        metadata: input.metadata
      },
      blocks: [blockId]
    })

    await storageV2ConversationRepository.upsertMessageBlocks(
      messageId,
      [
        {
          id: blockId,
          type: 'agent_session_entry',
          content: this.extractMessageText(input.payload),
          payload: {
            content: input.payload,
            metadata: input.metadata
          },
          createdAt: input.createdAt,
          updatedAt: input.createdAt
        }
      ],
      { pruneMissing: true }
    )
  }

  private async findExistingMessageRow(
    sessionId: string,
    role: string,
    messageId: string
  ): Promise<SessionMessageRow | null> {
    const database = await this.getDatabase()
    // Use SQLite json_extract to query by messageId directly, avoiding loading all messages
    const rows = await database
      .select()
      .from(sessionMessagesTable)
      .where(
        and(
          eq(sessionMessagesTable.session_id, sessionId),
          eq(sessionMessagesTable.role, role),
          sql`json_extract(${sessionMessagesTable.content}, '$.message.id') = ${messageId}`
        )
      )
      .limit(1)

    return rows[0] ?? null
  }

  private async findMessageRowByPayloadId(sessionId: string, messageId: string): Promise<SessionMessageRow | null> {
    const database = await this.getDatabase()
    const rows = await database
      .select()
      .from(sessionMessagesTable)
      .where(
        and(
          eq(sessionMessagesTable.session_id, sessionId),
          sql`json_extract(${sessionMessagesTable.content}, '$.message.id') = ${messageId}`
        )
      )
      .limit(1)

    return rows[0] ?? null
  }

  private async upsertMessage(
    params: PersistUserMessageParams | PersistAssistantMessageParams
  ): Promise<AgentSessionMessageEntity> {
    const { sessionId, agentSessionId = '', payload, metadata, createdAt } = params

    if (!payload?.message?.role) {
      throw new Error('Message payload missing role')
    }

    if (!payload.message.id) {
      throw new Error('Message payload missing id')
    }

    const database = await this.getDatabase()
    const now = createdAt ?? payload.message.createdAt ?? new Date().toISOString()
    const serializedPayload = this.serializeMessage(payload)
    const serializedMetadata = this.serializeMetadata(metadata)

    const existingRow = await this.findExistingMessageRow(sessionId, payload.message.role, payload.message.id)

    if (existingRow) {
      const metadataToPersist = serializedMetadata ?? existingRow.metadata ?? undefined
      const agentSessionToPersist = agentSessionId || existingRow.agent_session_id || ''

      await this.upsertStorageV2Message(database, {
        legacyRowId: existingRow.id,
        sessionId,
        agentSessionId: agentSessionToPersist,
        payload,
        metadata,
        createdAt: now
      })

      await database
        .update(sessionMessagesTable)
        .set({
          content: serializedPayload,
          metadata: metadataToPersist,
          agent_session_id: agentSessionToPersist,
          updated_at: now
        })
        .where(eq(sessionMessagesTable.id, existingRow.id))

      return this.deserialize({
        ...existingRow,
        content: serializedPayload,
        metadata: metadataToPersist,
        agent_session_id: agentSessionToPersist,
        updated_at: now
      })
    }

    const legacyRowId = this.generateMessageRowId(sessionId, payload.message.role, payload.message.id)
    const insertData: InsertSessionMessageRow = {
      id: legacyRowId,
      session_id: sessionId,
      role: payload.message.role,
      content: serializedPayload,
      agent_session_id: agentSessionId,
      metadata: serializedMetadata,
      created_at: now,
      updated_at: now
    }

    await this.upsertStorageV2Message(database, {
      legacyRowId,
      sessionId,
      agentSessionId,
      payload,
      metadata,
      createdAt: now
    })

    const [saved] = await database.insert(sessionMessagesTable).values(insertData).returning()

    return this.deserialize(saved)
  }

  async persistUserMessage(params: PersistUserMessageParams): Promise<AgentSessionMessageEntity> {
    return this.upsertMessage({ ...params, agentSessionId: params.agentSessionId ?? '' })
  }

  async persistAssistantMessage(params: PersistAssistantMessageParams): Promise<AgentSessionMessageEntity> {
    return this.upsertMessage(params)
  }

  async persistExchange(params: AgentMessagePersistExchangePayload): Promise<AgentMessagePersistExchangeResult> {
    const { sessionId, agentSessionId, user, assistant } = params

    const exchangeResult: AgentMessagePersistExchangeResult = {}

    if (user?.payload) {
      exchangeResult.userMessage = await this.persistUserMessage({
        sessionId,
        agentSessionId,
        payload: user.payload,
        metadata: user.metadata,
        createdAt: user.createdAt
      })
    }

    if (assistant?.payload) {
      exchangeResult.assistantMessage = await this.persistAssistantMessage({
        sessionId,
        agentSessionId,
        payload: assistant.payload,
        metadata: assistant.metadata,
        createdAt: assistant.createdAt
      })
    }

    return exchangeResult
  }

  async getSessionHistory(sessionId: string): Promise<AgentPersistedMessage[]> {
    try {
      const database = await this.getDatabase()
      const rows = await database
        .select()
        .from(sessionMessagesTable)
        .where(eq(sessionMessagesTable.session_id, sessionId))
        .orderBy(asc(sessionMessagesTable.created_at))

      const messages: AgentPersistedMessage[] = []

      for (const row of rows) {
        const deserialized = this.deserialize(row)
        if (deserialized?.content) {
          messages.push(deserialized.content as AgentPersistedMessage)
        }
      }

      logger.info(`Loaded ${messages.length} messages for session ${sessionId}`)
      return messages
    } catch (error) {
      logger.error('Failed to load session history', error as Error)
      throw error
    }
  }

  async findRowsByPayloadMessageIds(sessionId: string, messageIds: string[]): Promise<SessionMessageRow[]> {
    const uniqueMessageIds = Array.from(new Set(messageIds.filter(Boolean)))
    if (uniqueMessageIds.length === 0) return []

    const rows: SessionMessageRow[] = []
    const seenRowIds = new Set<number>()

    for (const messageId of uniqueMessageIds) {
      const row = await this.findMessageRowByPayloadId(sessionId, messageId)
      if (!row || seenRowIds.has(row.id)) continue

      rows.push(row)
      seenRowIds.add(row.id)
    }

    return rows
  }

  async listRowsForSession(sessionId: string): Promise<SessionMessageRow[]> {
    const database = await this.getDatabase()
    return database
      .select()
      .from(sessionMessagesTable)
      .where(eq(sessionMessagesTable.session_id, sessionId))
      .orderBy(asc(sessionMessagesTable.created_at))
  }

  async deleteRowsByIds(sessionId: string, rowIds: number[]): Promise<number[]> {
    const uniqueRowIds = Array.from(new Set(rowIds.filter((id) => Number.isSafeInteger(id))))
    if (uniqueRowIds.length === 0) return []

    const database = await this.getDatabase()
    const rows = await database
      .select({ id: sessionMessagesTable.id })
      .from(sessionMessagesTable)
      .where(and(eq(sessionMessagesTable.session_id, sessionId), inArray(sessionMessagesTable.id, uniqueRowIds)))

    const existingRowIds = rows.map((row) => row.id)
    if (existingRowIds.length === 0) return []

    await database
      .delete(sessionMessagesTable)
      .where(and(eq(sessionMessagesTable.session_id, sessionId), inArray(sessionMessagesTable.id, existingRowIds)))

    return existingRowIds
  }
}

export const agentMessageRepository = AgentMessageRepository.getInstance()
