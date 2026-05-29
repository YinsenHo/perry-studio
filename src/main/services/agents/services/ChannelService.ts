import { loggerService } from '@logger'
import { storageV2AgentRuntimeTombstoneService } from '@main/services/storageV2/AgentRuntimeTombstoneService'
import { storageV2AgentRuntimeWriteService } from '@main/services/storageV2/AgentRuntimeWriteService'
import { and, eq, inArray } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'

import { BaseService } from '../BaseService'
import {
  type ChannelConfig,
  type ChannelRow,
  channelsTable,
  channelTaskSubscriptionsTable,
  type InsertChannelRow
} from '../database/schema'

const logger = loggerService.withContext('ChannelService')

export class ChannelService extends BaseService {
  private static instance: ChannelService | null = null

  static getInstance(): ChannelService {
    if (!ChannelService.instance) {
      ChannelService.instance = new ChannelService()
    }
    return ChannelService.instance
  }

  async createChannel(data: {
    type: ChannelConfig['type']
    name: string
    agentId?: string
    config: ChannelConfig
    isActive?: boolean
    permissionMode?: string
  }): Promise<ChannelRow> {
    const database = await this.getDatabase()
    const now = Date.now()

    const insertData: InsertChannelRow & { id: string; createdAt: number; updatedAt: number } = {
      id: uuidv4(),
      type: data.type,
      name: data.name,
      agentId: data.agentId,
      sessionId: null,
      config: data.config,
      isActive: data.isActive ?? true,
      activeChatIds: [],
      permissionMode: data.permissionMode,
      createdAt: now,
      updatedAt: now
    }

    await storageV2AgentRuntimeWriteService.upsertChannel(insertData)
    const result = await database.insert(channelsTable).values(insertData).returning()

    if (!result[0]) {
      throw new Error('Failed to create channel')
    }

    logger.info('Channel created', { channelId: result[0].id, type: data.type })
    return result[0]
  }

  async getChannel(id: string): Promise<ChannelRow | null> {
    const database = await this.getDatabase()
    const result = await database.select().from(channelsTable).where(eq(channelsTable.id, id)).limit(1)
    return result[0] ?? null
  }

  async findBySessionId(sessionId: string): Promise<ChannelRow | null> {
    const database = await this.getDatabase()
    const result = await database.select().from(channelsTable).where(eq(channelsTable.sessionId, sessionId)).limit(1)
    return result[0] ?? null
  }

  async listChannels(filters?: { agentId?: string; type?: string }): Promise<ChannelRow[]> {
    const database = await this.getDatabase()

    const agentCond = filters?.agentId ? eq(channelsTable.agentId, filters.agentId) : undefined
    const typeCond = filters?.type ? eq(channelsTable.type, filters.type) : undefined
    const where = agentCond && typeCond ? and(agentCond, typeCond) : (agentCond ?? typeCond)

    if (where) {
      return database.select().from(channelsTable).where(where)
    }

    return database.select().from(channelsTable)
  }

  /**
   * Add a chatId to the channel's activeChatIds if not already present.
   * Used to auto-track conversations when allowed_chat_ids is empty.
   */
  async addActiveChatId(channelId: string, chatId: string): Promise<void> {
    const channel = await this.getChannel(channelId)
    if (!channel) return

    const existing = channel.activeChatIds ?? []
    if (existing.includes(chatId)) return

    await this.updateChannel(channelId, { activeChatIds: [...existing, chatId] })
  }

  async updateChannel(
    id: string,
    updates: Partial<
      Pick<ChannelRow, 'name' | 'agentId' | 'sessionId' | 'config' | 'isActive' | 'activeChatIds' | 'permissionMode'>
    >
  ): Promise<ChannelRow | null> {
    const database = await this.getDatabase()
    const existing = await this.getChannel(id)
    if (!existing) {
      return null
    }

    const updateData = { ...updates, updatedAt: Date.now() }
    const storageRow = {
      ...existing,
      ...updateData
    }

    await storageV2AgentRuntimeWriteService.upsertChannel(storageRow)
    const result = await database.update(channelsTable).set(updateData).where(eq(channelsTable.id, id)).returning()

    if (!result[0]) {
      return null
    }

    logger.info('Channel updated', { channelId: id })
    return result[0]
  }

  async deleteChannel(id: string, options: { storageV2Tombstoned?: boolean } = {}): Promise<boolean> {
    const database = await this.getDatabase()
    const existing = await this.getChannel(id)
    if (!existing) {
      return false
    }

    if (!options.storageV2Tombstoned) {
      await storageV2AgentRuntimeTombstoneService.tombstoneChannel(id)
    }
    const result = await database.delete(channelsTable).where(eq(channelsTable.id, id)).returning()
    if (result.length > 0) {
      logger.info('Channel deleted', { channelId: id })
    }
    return result.length > 0
  }

  // ---- Task subscription methods ----

  async subscribeToTask(channelId: string, taskId: string): Promise<void> {
    const database = await this.getDatabase()
    await database.insert(channelTaskSubscriptionsTable).values({ channelId, taskId }).onConflictDoNothing()
    logger.info('Channel subscribed to task', { channelId, taskId })
  }

  async unsubscribeFromTask(channelId: string, taskId: string): Promise<void> {
    const database = await this.getDatabase()
    await database
      .delete(channelTaskSubscriptionsTable)
      .where(
        and(eq(channelTaskSubscriptionsTable.channelId, channelId), eq(channelTaskSubscriptionsTable.taskId, taskId))
      )
    logger.info('Channel unsubscribed from task', { channelId, taskId })
  }

  async getSubscribedChannels(taskId: string): Promise<ChannelRow[]> {
    const database = await this.getDatabase()
    const subs = await database
      .select({ channelId: channelTaskSubscriptionsTable.channelId })
      .from(channelTaskSubscriptionsTable)
      .where(eq(channelTaskSubscriptionsTable.taskId, taskId))

    if (subs.length === 0) return []

    const channelIds = subs.map((s) => s.channelId)
    return database.select().from(channelsTable).where(inArray(channelsTable.id, channelIds))
  }

  async getSubscribedTasks(channelId: string): Promise<string[]> {
    const database = await this.getDatabase()
    const subs = await database
      .select({ taskId: channelTaskSubscriptionsTable.taskId })
      .from(channelTaskSubscriptionsTable)
      .where(eq(channelTaskSubscriptionsTable.channelId, channelId))
    return subs.map((s) => s.taskId)
  }
}

export const channelService = ChannelService.getInstance()
