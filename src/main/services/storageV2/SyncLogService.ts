import { randomUUID } from 'node:crypto'

import type { Client } from '@libsql/client'

import { storageV2Database } from './StorageV2Database'

type StorageV2ChangeOperation = 'upsert' | 'delete'

type StorageV2ChangeInput = {
  client?: Client
  entityType: string
  entityId: string
  operation?: StorageV2ChangeOperation
  payload?: unknown
  baseVersion?: number | null
  version?: number
}

const DEVICE_ID_KEY = 'device_id'

function now() {
  return new Date().toISOString()
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

export class StorageV2SyncLogService {
  async getDeviceId(client?: Client): Promise<string> {
    const dbClient = client ?? (await storageV2Database.getClient())
    const result = await dbClient.execute({
      sql: 'SELECT value FROM storage_meta WHERE key = ?',
      args: [DEVICE_ID_KEY]
    })
    const existing = result.rows[0]?.value
    if (typeof existing === 'string' && existing) {
      return existing
    }

    const deviceId = randomUUID()
    await dbClient.execute({
      sql: `
        INSERT INTO storage_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      args: [DEVICE_ID_KEY, deviceId, now()]
    })

    return deviceId
  }

  async recordChange(input: StorageV2ChangeInput) {
    const client = input.client ?? (await storageV2Database.getClient())
    const createdAt = now()
    const deviceId = await this.getDeviceId(client)
    const version = input.version ?? 1

    await client.execute({
      sql: `
        INSERT INTO sync_changes (
          id, entity_type, entity_id, operation, payload_json, base_version, version, device_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        randomUUID(),
        input.entityType,
        input.entityId,
        input.operation ?? 'upsert',
        toJson(input.payload),
        input.baseVersion ?? null,
        version,
        deviceId,
        createdAt
      ]
    })

    if (input.operation === 'delete') {
      await client.execute({
        sql: `
          INSERT INTO sync_tombstones (entity_type, entity_id, deleted_at, device_id, version)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            deleted_at = excluded.deleted_at,
            device_id = excluded.device_id,
            version = excluded.version
        `,
        args: [input.entityType, input.entityId, createdAt, deviceId, version]
      })
    }
  }
}

export const storageV2SyncLogService = new StorageV2SyncLogService()
