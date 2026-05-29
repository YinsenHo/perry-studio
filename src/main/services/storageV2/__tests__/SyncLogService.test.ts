import type { Client } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'

import { StorageV2SyncLogService } from '../SyncLogService'

function createClient() {
  const execute = vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
    const sql = typeof input === 'string' ? input : input.sql
    if (sql.includes('SELECT value FROM storage_meta')) {
      return { rows: [{ value: 'device-1' }], columns: [], columnTypes: [] }
    }
    return { rows: [], columns: [], columnTypes: [] }
  })

  return {
    client: { execute } as unknown as Client,
    execute
  }
}

describe('StorageV2SyncLogService', () => {
  it('rejects unknown sync entity types before writing ledger rows', async () => {
    const { client, execute } = createClient()

    await expect(
      new StorageV2SyncLogService().recordChange({
        client,
        entityType: 'unknown-entity',
        entityId: 'id-1'
      })
    ).rejects.toThrow('Unknown Storage v2 sync entity type')

    expect(execute).not.toHaveBeenCalled()
  })

  it('does not allow delete operations for append-only sync entities', async () => {
    const { client, execute } = createClient()

    await expect(
      new StorageV2SyncLogService().recordChange({
        client,
        entityType: 'task_run_log',
        entityId: 'log-1',
        operation: 'delete'
      })
    ).rejects.toThrow('append-only')

    expect(execute).not.toHaveBeenCalled()
  })

  it('writes tombstones for known delete-capable sync entities', async () => {
    const { client, execute } = createClient()

    await new StorageV2SyncLogService().recordChange({
      client,
      entityType: 'kv_record',
      entityId: 'settings:test',
      operation: 'delete',
      version: 7
    })

    const executedSql = execute.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.sql))
    expect(executedSql.some((sql) => sql.includes('INSERT INTO sync_changes'))).toBe(true)
    expect(executedSql.some((sql) => sql.includes('INSERT INTO sync_tombstones'))).toBe(true)
  })
})
