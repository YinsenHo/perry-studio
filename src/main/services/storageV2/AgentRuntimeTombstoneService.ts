import { storageV2Database } from './StorageV2Database'
import { storageV2ConversationRepository } from './StorageV2Repositories'
import { storageV2SyncLogService } from './SyncLogService'

type AgentRuntimeEntityTable = 'agents' | 'agent_sessions' | 'scheduled_tasks' | 'channels'

const ENTITY_TYPE_BY_TABLE: Record<AgentRuntimeEntityTable, string> = {
  agents: 'agent',
  agent_sessions: 'agent_session',
  scheduled_tasks: 'scheduled_task',
  channels: 'channel'
}

function now() {
  return new Date().toISOString()
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export class StorageV2AgentRuntimeTombstoneService {
  async tombstoneAgent(agentId: string) {
    await this.tombstoneEntity('agents', agentId)
  }

  async tombstoneSession(sessionId: string) {
    await this.tombstoneEntity('agent_sessions', sessionId)
    await storageV2ConversationRepository.delete(`agent-session:${sessionId}`)
  }

  async tombstoneTask(taskId: string) {
    await this.tombstoneEntity('scheduled_tasks', taskId)
  }

  async tombstoneChannel(channelId: string) {
    await this.tombstoneEntity('channels', channelId)
  }

  async tombstoneSessionMessage(messageId: number | string) {
    const id = `agent-message:${messageId}`
    const client = await storageV2Database.getClient()
    const deletedAt = now()

    await storageV2Database.withTransaction(client, async () => {
      const existingResult = await client.execute({
        sql: 'SELECT conversation_id, version FROM messages WHERE id = ? AND deleted_at IS NULL',
        args: [id]
      })
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined
      const conversationId = text(existing?.conversation_id)
      const existingVersion = Number(existing?.version ?? 0)
      const blocksResult = await client.execute({
        sql: 'SELECT id, version FROM message_blocks WHERE message_id = ? AND deleted_at IS NULL',
        args: [id]
      })

      await client.execute({
        sql: `
          UPDATE message_blocks
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE message_id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, id]
      })
      await client.execute({
        sql: `
          UPDATE messages
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, id]
      })

      for (const row of blocksResult.rows) {
        const blockId = text(row.id)
        if (!blockId) continue

        await storageV2SyncLogService.recordChange({
          client,
          entityType: 'message_block',
          entityId: blockId,
          operation: 'delete',
          payload: { id: blockId, messageId: id, conversationId, deletedAt },
          version: Number(row.version ?? 0) + 1
        })
      }

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'message',
        entityId: id,
        operation: 'delete',
        payload: { id, conversationId, deletedAt },
        version: existingVersion > 0 ? existingVersion + 1 : 1
      })
    })
  }

  private async tombstoneEntity(table: AgentRuntimeEntityTable, entityId: string) {
    const client = await storageV2Database.getClient()
    const deletedAt = now()

    await storageV2Database.withTransaction(client, async () => {
      const existingResult = await client.execute({
        sql: `SELECT version FROM ${table} WHERE id = ? AND deleted_at IS NULL`,
        args: [entityId]
      })
      const existingVersion = Number(existingResult.rows[0]?.version ?? 0)

      await client.execute({
        sql: `
          UPDATE ${table}
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, entityId]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: ENTITY_TYPE_BY_TABLE[table],
        entityId,
        operation: 'delete',
        payload: { id: entityId, deletedAt },
        version: existingVersion > 0 ? existingVersion + 1 : 1
      })
    })
  }
}

export const storageV2AgentRuntimeTombstoneService = new StorageV2AgentRuntimeTombstoneService()
