import type { Client } from '@libsql/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { storageV2Database } from '../StorageV2Database'
import {
  StorageV2ConversationRepository,
  StorageV2KnowledgeRepository,
  StorageV2ProviderRepository
} from '../StorageV2Repositories'
import { storageV2SyncLogService } from '../SyncLogService'

function createMockClient() {
  const execute = vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
    const sql = typeof input === 'string' ? input : input.sql
    const args = typeof input === 'string' ? [] : (input.args ?? [])

    if (sql.includes('SELECT version FROM')) {
      return { rows: [{ version: 3 }], columns: [], columnTypes: [] }
    }

    if (sql.includes('FROM messages') && sql.includes('WHERE conversation_id = ?') && args[0] === 'topic-1') {
      return { rows: [{ id: 'stale-message', version: 4 }], columns: [], columnTypes: [] }
    }

    if (sql.includes('FROM message_blocks') && sql.includes('WHERE message_id = ?') && args[0] === 'stale-message') {
      return { rows: [{ id: 'stale-block', version: 2 }], columns: [], columnTypes: [] }
    }

    if (sql.includes('FROM message_blocks') && sql.includes('WHERE message_id = ?') && args[0] === 'message-1') {
      return { rows: [{ id: 'stale-message-block', version: 5 }], columns: [], columnTypes: [] }
    }

    return { rows: [], columns: [], columnTypes: [] }
  })

  return {
    client: { execute } as unknown as Client,
    execute
  }
}

describe('StorageV2ConversationRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('syncs a conversation snapshot in one transaction and tombstones missing children', async () => {
    const { client, execute } = createMockClient()
    const recordChange = vi.spyOn(storageV2SyncLogService, 'recordChange').mockResolvedValue(undefined)
    const withTransaction = vi
      .spyOn(storageV2Database, 'withTransaction')
      .mockImplementation(async (_client, fn) => fn())
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    await new StorageV2ConversationRepository().importConversation({
      id: 'topic-1',
      ownerId: 'assistant-1',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          createdAt: '2026-01-01T00:00:00.000Z',
          blocks: ['block-1']
        }
      ],
      blocks: [
        {
          id: 'block-1',
          messageId: 'message-1',
          type: 'main_text',
          content: 'hello',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })

    const executedSql = execute.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.sql))
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO conversations'))).toBe(true)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO messages'))).toBe(true)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO message_blocks'))).toBe(true)
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'conversation', entityId: 'topic-1' })
    )
    expect(recordChange).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'message', entityId: 'message-1' }))
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'message_block', entityId: 'block-1' })
    )
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'message', entityId: 'stale-message', operation: 'delete' })
    )
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'message_block', entityId: 'stale-block', operation: 'delete' })
    )
  })

  it('only prunes missing message blocks when requested', async () => {
    const { client, execute } = createMockClient()
    const recordChange = vi.spyOn(storageV2SyncLogService, 'recordChange').mockResolvedValue(undefined)
    vi.spyOn(storageV2Database, 'withTransaction').mockImplementation(async (_client, fn) => fn())
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    const repository = new StorageV2ConversationRepository()
    await repository.upsertMessageBlocks('message-1', [{ id: 'block-1', type: 'main_text', content: 'hello' }])
    expect(recordChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'message_block', entityId: 'stale-message-block', operation: 'delete' })
    )

    await repository.upsertMessageBlocks('message-1', [{ id: 'block-1', type: 'main_text', content: 'hello' }], {
      pruneMissing: true
    })

    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'message_block', entityId: 'stale-message-block', operation: 'delete' })
    )
    expect(
      execute.mock.calls.some(([input]) => typeof input !== 'string' && input.sql.includes('UPDATE message_blocks'))
    ).toBe(true)
  })
})

describe('StorageV2ProviderRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes stale provider credentials when a new api key cannot be stored', async () => {
    const { client, execute } = createMockClient()
    vi.spyOn(storageV2SyncLogService, 'recordChange').mockResolvedValue(undefined)
    vi.spyOn(storageV2Database, 'withTransaction').mockImplementation(async (_client, fn) => fn())
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    const result = await new StorageV2ProviderRepository().upsert({
      id: 'provider-1',
      type: 'openai',
      name: 'OpenAI',
      apiKey: 'new-secret',
      models: []
    } as any)

    expect(result.skippedSecret).toBe(true)
    expect(
      execute.mock.calls.some(
        ([input]) =>
          typeof input !== 'string' &&
          input.sql.includes('DELETE FROM provider_credentials') &&
          input.args?.[0] === 'provider-1'
      )
    ).toBe(true)
  })
})

describe('StorageV2KnowledgeRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reconstructs knowledge bases from structured Storage v2 tables', async () => {
    const execute = vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof input === 'string' ? input : input.sql

      if (sql.includes('FROM knowledge_bases')) {
        return {
          rows: [
            {
              id: 'base-1',
              name: 'Docs',
              model_id: 'embedding-model',
              rerank_model_id: 'rerank-model',
              settings_json: JSON.stringify({
                id: 'base-1',
                name: 'Docs',
                model: { id: 'embedding-model', name: 'Embedding Model' },
                items: [],
                created_at: 1760000000000,
                updated_at: 1760000000100,
                version: 2
              }),
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:01.000Z',
              version: 2
            }
          ],
          columns: [],
          columnTypes: []
        }
      }

      if (sql.includes('FROM knowledge_items')) {
        return {
          rows: [
            {
              id: 'item-1',
              knowledge_base_id: 'base-1',
              source_type: 'url',
              source_uri: 'https://example.com/docs',
              file_id: null,
              content_hash: 'unique-1',
              status: 'completed',
              metadata_json: JSON.stringify({
                id: 'item-1',
                type: 'url',
                content: 'https://example.com/docs',
                created_at: 1760000000200,
                updated_at: 1760000000300
              }),
              created_at: '2026-01-01T00:00:02.000Z',
              updated_at: '2026-01-01T00:00:03.000Z',
              version: 1
            }
          ],
          columns: [],
          columnTypes: []
        }
      }

      return { rows: [], columns: [], columnTypes: [] }
    })

    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue({ execute } as unknown as Client)

    await expect(new StorageV2KnowledgeRepository().listBases()).resolves.toEqual([
      expect.objectContaining({
        id: 'base-1',
        name: 'Docs',
        model: { id: 'embedding-model', name: 'Embedding Model' },
        items: [
          expect.objectContaining({
            id: 'item-1',
            baseId: 'base-1',
            type: 'url',
            content: 'https://example.com/docs',
            uniqueId: 'unique-1',
            processingStatus: 'completed'
          })
        ]
      })
    ])
  })
})
