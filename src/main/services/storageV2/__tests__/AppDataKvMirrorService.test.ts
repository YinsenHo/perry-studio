import type { Client } from '@libsql/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StorageV2AppDataKvMirrorService } from '../AppDataKvMirrorService'
import { storageV2SecretVaultService } from '../SecretVaultService'
import { storageV2Database } from '../StorageV2Database'
import { storageV2SyncLogService } from '../SyncLogService'

function createMockClient() {
  const execute = vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
    const sql = typeof input === 'string' ? input : input.sql
    const args = typeof input === 'string' ? [] : (input.args ?? [])

    if (sql.includes('SELECT version FROM kv_records')) {
      return { rows: [{ version: 7 }], columns: [], columnTypes: [] }
    }

    if (sql.includes('SELECT value_json FROM sync_state') && args[0] === 'legacy-app.last-sync-summary') {
      return {
        rows: [{ value_json: JSON.stringify({ downloaded: 2, lastSyncAt: 1760000000300 }) }],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes('SELECT value_json FROM sync_state') && args[0] === 'legacy-app.device-id') {
      return {
        rows: [{ value_json: JSON.stringify('device-1') }],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes('SELECT scope, key, value_json')) {
      return {
        rows: [
          {
            scope: 'settings',
            key: 'theme',
            value_json: JSON.stringify({ mode: 'dark' }),
            updated_at: '2026-01-01T00:00:00.000Z',
            deleted_at: null,
            version: 3
          },
          {
            scope: 'settings',
            key: 'old-theme',
            value_json: null,
            updated_at: '2026-01-02T00:00:00.000Z',
            deleted_at: '2026-01-02T00:00:00.000Z',
            version: 4
          }
        ],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes("scope = 'workbench.shortcuts'")) {
      return {
        rows: [
          {
            key: 'docs',
            value_json: JSON.stringify({
              id: 'docs',
              name: 'Docs',
              url: 'https://docs.example.com',
              sourcePath: null,
              kind: 'url',
              metadata: null,
              createdAt: 1767225600000,
              updatedAt: 1767225600000,
              deletedAt: null
            }),
            updated_at: '2026-01-01T00:00:00.000Z',
            deleted_at: null
          },
          {
            key: 'old-docs',
            value_json: JSON.stringify({
              id: 'old-docs',
              name: 'Old Docs',
              url: 'https://old.example.com',
              sourcePath: null,
              kind: 'url',
              metadata: null,
              createdAt: 1767312000000,
              updatedAt: 1767312000000,
              deletedAt: 1767312000000
            }),
            updated_at: '2026-01-02T00:00:00.000Z',
            deleted_at: '2026-01-02T00:00:00.000Z'
          }
        ],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes('FROM sync_conflicts') && sql.includes("entity_type = 'app-record'")) {
      return {
        rows: [
          {
            id: 'settings:theme:1760000000999',
            entity_id: 'settings:theme',
            local_snapshot_json: JSON.stringify({ value: { mode: 'light' }, hash: 'local-hash' }),
            remote_snapshot_json: JSON.stringify({
              value: { mode: 'dark' },
              hash: 'remote-hash',
              baseHash: 'base-hash'
            }),
            created_at: '2026-01-01T00:00:00.999Z',
            resolved_at: null
          }
        ],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes('SELECT value_json') && args[0] === 'agent-tools' && args[1] === 'github') {
      return {
        rows: [
          {
            value_json: JSON.stringify({
              apiKeySecretRef: 'storage-v2://secret/app-data/test',
              endpoint: 'https://example.com'
            })
          }
        ],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes('SELECT value_json') && args[0] === 'settings' && args[1] === 'optional') {
      return {
        rows: [{ value_json: JSON.stringify(null), deleted_at: null }],
        columns: [],
        columnTypes: []
      }
    }

    if (sql.includes('SELECT value_json') && args[0] === 'settings' && args[1] === 'deleted') {
      return {
        rows: [{ value_json: null, deleted_at: '2026-01-01T00:00:00.000Z' }],
        columns: [],
        columnTypes: []
      }
    }

    return { rows: [], columns: [], columnTypes: [] }
  })

  return {
    client: { execute } as unknown as Client,
    execute
  }
}

describe('StorageV2AppDataKvMirrorService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mirrors app records into kv_records and stores sensitive fields as secret refs', async () => {
    const { client, execute } = createMockClient()
    const recordChange = vi.spyOn(storageV2SyncLogService, 'recordChange').mockResolvedValue(undefined)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)
    vi.spyOn(storageV2Database, 'withTransaction').mockImplementation(async (_client, fn) => fn())
    vi.spyOn(storageV2SecretVaultService, 'isAvailable').mockReturnValue(true)
    vi.spyOn(storageV2SecretVaultService, 'setSecret').mockResolvedValue('storage-v2://secret/app-data/test')

    await new StorageV2AppDataKvMirrorService().upsertRecord(
      'agent-tools',
      'github',
      {
        apiKey: 'secret-value',
        endpoint: 'https://example.com'
      },
      1760000000000
    )

    const insertCall = execute.mock.calls.find(
      ([input]) => typeof input !== 'string' && input.sql.includes('INSERT INTO kv_records')
    )
    expect(insertCall).toBeTruthy()
    const args = (insertCall![0] as { args: unknown[] }).args
    expect(args[0]).toBe('agent-tools')
    expect(args[1]).toBe('github')
    expect(args[3]).toBe('app-record')
    expect(String(args[2])).toContain('apiKeySecretRef')
    expect(String(args[2])).not.toContain('secret-value')
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'kv_record',
        entityId: 'agent-tools:github',
        version: 7
      })
    )
  })

  it('marks sensitive app record fields unavailable instead of storing plaintext when safeStorage is unavailable', async () => {
    const { client, execute } = createMockClient()
    vi.spyOn(storageV2SyncLogService, 'recordChange').mockResolvedValue(undefined)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)
    vi.spyOn(storageV2Database, 'withTransaction').mockImplementation(async (_client, fn) => fn())
    vi.spyOn(storageV2SecretVaultService, 'isAvailable').mockReturnValue(false)
    const setSecret = vi.spyOn(storageV2SecretVaultService, 'setSecret')

    await new StorageV2AppDataKvMirrorService().upsertRecord(
      'agent-tools',
      'github',
      {
        apiKey: 'secret-value',
        nested: {
          clientSecret: 'nested-secret'
        },
        endpoint: 'https://example.com'
      },
      1760000000000
    )

    const insertCall = execute.mock.calls.find(
      ([input]) => typeof input !== 'string' && input.sql.includes('INSERT INTO kv_records')
    )
    expect(insertCall).toBeTruthy()
    const args = (insertCall![0] as { args: unknown[] }).args
    const storedValue = JSON.parse(args[2] as string)
    expect(storedValue).toEqual({
      apiKeySecretUnavailable: true,
      nested: {
        clientSecretSecretUnavailable: true
      },
      endpoint: 'https://example.com'
    })
    expect(JSON.stringify(storedValue)).not.toContain('secret-value')
    expect(JSON.stringify(storedValue)).not.toContain('nested-secret')
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('mirrors cache deletes as kv tombstones', async () => {
    const { client, execute } = createMockClient()
    const recordChange = vi.spyOn(storageV2SyncLogService, 'recordChange').mockResolvedValue(undefined)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)
    vi.spyOn(storageV2Database, 'withTransaction').mockImplementation(async (_client, fn) => fn())

    await new StorageV2AppDataKvMirrorService().deleteCache('minapp', 'tab-1')

    const insertCall = execute.mock.calls.find(
      ([input]) => typeof input !== 'string' && input.sql.includes('INSERT INTO kv_records')
    )
    expect(insertCall).toBeTruthy()
    const args = (insertCall![0] as { args: unknown[] }).args
    expect(args[0]).toBe('cache.minapp')
    expect(args[1]).toBe('tab-1')
    expect(args[2]).toBe('app-cache')
    expect(args[4]).toBeTruthy()
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'kv_record',
        entityId: 'cache.minapp:tab-1',
        operation: 'delete'
      })
    )
  })

  it('reads app records from kv_records and restores secret refs', async () => {
    const { client } = createMockClient()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)
    vi.spyOn(storageV2SecretVaultService, 'getSecret').mockResolvedValue('secret-value')

    const value = await new StorageV2AppDataKvMirrorService().getRecord('agent-tools', 'github')

    expect(value).toEqual({
      apiKey: 'secret-value',
      endpoint: 'https://example.com'
    })
  })

  it('distinguishes null app records and tombstones from missing Storage v2 rows', async () => {
    const { client } = createMockClient()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    await expect(new StorageV2AppDataKvMirrorService().getRecordEntry('settings', 'optional')).resolves.toEqual({
      found: true,
      value: null,
      deletedAt: null
    })
    await expect(new StorageV2AppDataKvMirrorService().getRecordEntry('settings', 'deleted')).resolves.toEqual({
      found: true,
      value: null,
      deletedAt: '2026-01-01T00:00:00.000Z'
    })
    await expect(new StorageV2AppDataKvMirrorService().getRecordEntry('settings', 'missing')).resolves.toEqual({
      found: false,
      value: null,
      deletedAt: null
    })
  })

  it('lists app records from Storage v2 for direct app-data fallback reads', async () => {
    const { client } = createMockClient()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    await expect(new StorageV2AppDataKvMirrorService().listRecords('settings', true)).resolves.toEqual([
      {
        scope: 'settings',
        key: 'theme',
        value: { mode: 'dark' },
        valueHash: 'e1b46b0528a8f30c9d819820cb67ba6daa128e14c91711cc6ccb5d6779a8fa17',
        updatedAt: 1767225600000,
        deletedAt: null,
        deviceId: 'device-1',
        version: 3
      },
      {
        scope: 'settings',
        key: 'old-theme',
        value: null,
        valueHash: 'eb164972688e36f77a8cc1eebc90c1b80bf06b3d508a4b0ec4885c8515988ea9',
        updatedAt: 1767312000000,
        deletedAt: 1767312000000,
        deviceId: 'device-1',
        version: 4
      }
    ])
  })

  it('lists workbench shortcuts from Storage v2 with tombstones', async () => {
    const { client } = createMockClient()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    await expect(new StorageV2AppDataKvMirrorService().listWorkbenchShortcuts(true)).resolves.toEqual([
      {
        id: 'docs',
        name: 'Docs',
        url: 'https://docs.example.com',
        sourcePath: null,
        kind: 'url',
        metadata: null,
        createdAt: 1767225600000,
        updatedAt: 1767225600000,
        deletedAt: null
      },
      {
        id: 'old-docs',
        name: 'Old Docs',
        url: 'https://old.example.com',
        sourcePath: null,
        kind: 'url',
        metadata: null,
        createdAt: 1767312000000,
        updatedAt: 1767312000000,
        deletedAt: 1767312000000
      }
    ])
  })

  it('reads app sync state from Storage v2 sync_state', async () => {
    const { client } = createMockClient()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    await expect(new StorageV2AppDataKvMirrorService().getSyncState('last-sync-summary')).resolves.toEqual({
      downloaded: 2,
      lastSyncAt: 1760000000300
    })
  })

  it('reads app sync conflicts from Storage v2 sync_conflicts', async () => {
    const { client } = createMockClient()
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(client)

    await expect(new StorageV2AppDataKvMirrorService().listSyncConflicts()).resolves.toEqual([
      {
        id: 'settings:theme:1760000000999',
        scope: 'settings',
        key: 'theme',
        local_value: { mode: 'light' },
        remote_value: { mode: 'dark' },
        base_hash: 'base-hash',
        local_hash: 'local-hash',
        remote_hash: 'remote-hash',
        created_at: 1767225600999,
        resolved_at: null
      }
    ])
  })
})
