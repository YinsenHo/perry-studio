import type { Client } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'

import { scanStorageV2SecretReferences } from '../SecretRefIntegrity'

function createMockClient(): Client {
  return {
    execute: vi.fn(async (input: string | { sql: string }) => {
      const sql = typeof input === 'string' ? input : input.sql

      if (sql.includes('provider_credentials')) {
        return {
          rows: [{ secret_ref: 'storage-v2://secret/provider/provider%201/apiKey' }],
          columns: [],
          columnTypes: []
        }
      }

      if (sql.includes('FROM settings')) {
        return {
          rows: [
            {
              value_json: JSON.stringify({
                nested: {
                  secretRef: 'storage-v2://secret/settings/s3/secretAccessKey'
                },
                invalidSecretRef: 'storage-v2://secret/%'
              })
            }
          ],
          columns: [],
          columnTypes: []
        }
      }

      if (sql.includes('FROM sync_conflicts')) {
        throw new Error('SQLITE_ERROR: no such table: sync_conflicts')
      }

      return { rows: [], columns: [], columnTypes: [] }
    })
  } as unknown as Client
}

describe('scanStorageV2SecretReferences', () => {
  it('collects nested secret refs and tracks invalid refs', async () => {
    const result = await scanStorageV2SecretReferences(createMockClient())

    expect(result.refs).toEqual(new Set(['provider:provider%201:apiKey', 'settings:s3:secretAccessKey']))
    expect(result.invalidRefs).toEqual(new Set(['storage-v2://secret/%']))
    expect(result.skippedSources).toEqual(['sync_conflicts.local_snapshot_json', 'sync_conflicts.remote_snapshot_json'])
  })
})
