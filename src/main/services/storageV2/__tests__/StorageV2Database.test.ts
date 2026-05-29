import * as fs from 'node:fs'

import type { Client } from '@libsql/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { storageV2DataRootService } from '../DataRootService'
import { StorageV2Database } from '../StorageV2Database'

function createMockClient(events: string[]): Client {
  return {
    execute: vi.fn(async (input: string | { sql: string }) => {
      events.push(typeof input === 'string' ? input : input.sql)
      return { rows: [], columns: [], columnTypes: [] }
    })
  } as unknown as Client
}

describe('StorageV2Database.withTransaction', () => {
  it('serializes concurrent transactions on the shared client', async () => {
    const database = new StorageV2Database()
    const events: string[] = []
    const client = createMockClient(events)
    let releaseFirst!: () => void
    let first!: Promise<void>
    const firstStarted = new Promise<void>((resolve) => {
      first = database.withTransaction(client, async () => {
        events.push('first:start')
        resolve()
        await new Promise<void>((release) => {
          releaseFirst = release
        })
        events.push('first:end')
      })
    })

    await firstStarted

    const second = database.withTransaction(client, async () => {
      events.push('second:start')
    })

    await Promise.resolve()
    expect(events).not.toContain('second:start')

    const idle = database.waitForIdle().then(() => {
      events.push('idle')
    })
    await Promise.resolve()
    expect(events).not.toContain('idle')

    releaseFirst()
    await Promise.all([first, second, idle])

    expect(events).toEqual([
      'BEGIN IMMEDIATE',
      'first:start',
      'first:end',
      'COMMIT',
      'BEGIN IMMEDIATE',
      'second:start',
      'COMMIT',
      'idle'
    ])
  })

  it('rolls back a failed transaction before running the next queued transaction', async () => {
    const database = new StorageV2Database()
    const events: string[] = []
    const client = createMockClient(events)

    await expect(
      database.withTransaction(client, async () => {
        events.push('first:start')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await database.withTransaction(client, async () => {
      events.push('second:start')
    })

    expect(events).toEqual(['BEGIN IMMEDIATE', 'first:start', 'ROLLBACK', 'BEGIN IMMEDIATE', 'second:start', 'COMMIT'])
  })
})

describe('StorageV2Database.integrityReport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports orphan blobs, broken blob references, and unreferenced secret vault entries', async () => {
    vi.spyOn(storageV2DataRootService, 'ensureDataRoot').mockReturnValue({
      dataRoot: '/mock/data',
      source: 'current-user-data',
      manifest: {
        format: 'cherry-studio-pi-storage',
        version: 2,
        profileId: 'profile-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastOpenedBy: {
          appId: 'test',
          productName: 'Cherry Studio Pi',
          version: '1.0.0'
        }
      },
      candidates: []
    })
    const database = new StorageV2Database()
    const vaultPath = '/mock/data/secrets/vault.json'
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === vaultPath)
    vi.mocked(fs.readFileSync).mockImplementation((candidate) => {
      if (String(candidate) !== vaultPath) throw new Error('unexpected path')
      return JSON.stringify({
        version: 1,
        secrets: {
          'provider:unused:apiKey': {
            encrypted: 'ciphertext',
            encoding: 'electron-safe-storage',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    })
    const execute = vi.fn(async (input: string | { sql: string }) => {
      const sql = typeof input === 'string' ? input : input.sql

      if (sql.includes('PRAGMA quick_check') || sql.includes('PRAGMA integrity_check')) {
        return { rows: [{ result: 'ok' }], columns: [], columnTypes: [] }
      }
      if (sql.includes('PRAGMA foreign_key_check')) {
        return { rows: [], columns: [], columnTypes: [] }
      }
      if (sql.includes('FROM message_blocks mb') && sql.includes('mb.blob_id IS NOT NULL')) {
        return { rows: [{ count: 1 }], columns: [], columnTypes: [] }
      }
      if (sql.includes('FROM profiles p') && sql.includes('avatar_blob_id')) {
        return { rows: [{ count: 1 }], columns: [], columnTypes: [] }
      }
      if (sql.includes('FROM assistants a') && sql.includes('avatar_blob_id')) {
        return { rows: [{ count: 1 }], columns: [], columnTypes: [] }
      }
      if (sql.includes('FROM agents a') && sql.includes('avatar_blob_id')) {
        return { rows: [{ count: 1 }], columns: [], columnTypes: [] }
      }
      if (sql.includes('LEFT JOIN profiles p ON p.avatar_blob_id = b.id')) {
        return { rows: [{ count: 1 }], columns: [], columnTypes: [] }
      }
      if (sql.includes('b.ref_count != COALESCE')) {
        return { rows: [{ count: 1 }], columns: [], columnTypes: [] }
      }
      if (sql.includes('SELECT id, storage_path, checksum') && sql.includes('FROM blobs')) {
        return { rows: [], columns: [], columnTypes: [] }
      }
      if (sql.includes('COUNT(*) AS count')) {
        return { rows: [{ count: 0 }], columns: [], columnTypes: [] }
      }

      return { rows: [], columns: [], columnTypes: [] }
    })
    vi.spyOn(database, 'getClient').mockResolvedValue({ execute } as unknown as Client)

    const report = await database.integrityReport()
    const issueCounts = Object.fromEntries(report.issues.map((issue) => [issue.id, issue.count]))

    expect(report.ok).toBe(false)
    expect(issueCounts).toMatchObject({
      agent_avatars_without_blob: 1,
      assistant_avatars_without_blob: 1,
      blob_ref_count_mismatch: 1,
      message_blocks_without_blob: 1,
      orphan_blobs: 1,
      orphan_secret_vault_entries: 1,
      profile_avatars_without_blob: 1
    })
  })
})
