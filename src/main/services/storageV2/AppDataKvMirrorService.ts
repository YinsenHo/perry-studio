import { createHash } from 'node:crypto'

import type { Client } from '@libsql/client'
import type { AppDataRecord } from '@main/services/appData/AppDataDatabase'

import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2Database } from './StorageV2Database'
import { storageV2SyncLogService } from './SyncLogService'

type KvRecordSource = 'app-record' | 'app-cache' | 'workbench-shortcut'

type WorkbenchShortcutLike = Record<string, any> & {
  id?: string
  updatedAt?: number
  deletedAt?: number | null
}

type AppDataRecordLike = {
  scope: string
  key: string
  value: unknown
  valueHash?: string
  updatedAt: number
  deletedAt?: number | null
}

export type StorageV2AppDataValueEntry<T = unknown> = {
  found: boolean
  value: T | null
  deletedAt?: string | null
}

export type StorageV2AppSyncConflict = {
  id: string
  scope: string
  key: string
  local_value: unknown
  remote_value: unknown
  base_hash: string | null
  local_hash: string | null
  remote_hash: string | null
  created_at: number
  resolved_at: number | null
}

const SECRET_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bot[_-]?token|client[_-]?secret|app[_-]?secret|secret|password|private[_-]?key)/i
const APP_RECORD_SOURCES = ['app-record', 'legacy-app-record'] as const
const APP_CACHE_SOURCES = ['app-cache', 'legacy-app-cache'] as const
const WORKBENCH_SHORTCUT_SOURCES = ['workbench-shortcut', 'legacy-workbench-shortcut'] as const

function nowIso() {
  return new Date().toISOString()
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value as T

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toIsoTimestamp(value: unknown, fallback = nowIso()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && value.length >= 10) {
      return new Date(parsed).toISOString()
    }

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
  }

  return fallback
}

function epochMs(value: unknown, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.length >= 10) return numeric

    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function hashValue(value: unknown, deletedAt?: number | null) {
  const payload = deletedAt ? { deletedAt } : value
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSensitiveKey(key: string) {
  return SECRET_KEY_PATTERN.test(key) && !/(secretRef|secretUnavailable)$/i.test(key)
}

async function getKvRecordVersion(client: Client, scope: string, key: string) {
  const result = await client.execute({
    sql: 'SELECT version FROM kv_records WHERE scope = ? AND key = ?',
    args: [scope, key]
  })
  return Number(result.rows[0]?.version ?? 1)
}

export class StorageV2AppDataKvMirrorService {
  async getRecord(scope: string, key: string): Promise<unknown | null> {
    const entry = await this.getRecordEntry(scope, key)
    return entry.found && !entry.deletedAt ? entry.value : null
  }

  async getRecordEntry<T = unknown>(scope: string, key: string): Promise<StorageV2AppDataValueEntry<T>> {
    const row = await this.getKvRecord(scope, key, APP_RECORD_SOURCES, { includeDeleted: true })
    if (!row) return { found: false, value: null, deletedAt: null }

    const deletedAt = typeof row.deleted_at === 'string' ? row.deleted_at : null
    if (deletedAt) {
      return { found: true, value: null, deletedAt }
    }

    return {
      found: true,
      value: (await this.restoreSecrets(parseJson(row.value_json, null))) as T,
      deletedAt: null
    }
  }

  async listRecords(scope?: string, includeDeleted = false): Promise<AppDataRecord[]> {
    const client = await storageV2Database.getClient()
    const filters = scope ? ['scope = ?'] : []
    const args: string[] = [...APP_RECORD_SOURCES]
    if (scope) {
      args.push(scope)
    }
    const deviceId = (await this.getSyncState<string>('device-id')) ?? 'storage-v2'

    const result = await client.execute({
      sql: `
        SELECT scope, key, value_json, updated_at, deleted_at, version
        FROM kv_records
        WHERE source IN (${APP_RECORD_SOURCES.map(() => '?').join(', ')})
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY updated_at DESC
      `,
      args
    })

    const records: AppDataRecord[] = []
    for (const row of result.rows) {
      const recordScope = typeof row.scope === 'string' ? row.scope : null
      const key = typeof row.key === 'string' ? row.key : null
      if (!recordScope || !key) continue

      const deletedAt = row.deleted_at ? epochMs(row.deleted_at) : null
      const value = deletedAt == null ? await this.restoreSecrets(parseJson(row.value_json, null)) : null
      records.push({
        scope: recordScope,
        key,
        value,
        valueHash: hashValue(value, deletedAt),
        updatedAt: epochMs(row.updated_at),
        deletedAt,
        deviceId,
        version: Number(row.version ?? 1)
      })
    }

    return records
  }

  async getCache(namespace: string, key: string): Promise<unknown | null> {
    const row = await this.getKvRecord(`cache.${namespace}`, key, APP_CACHE_SOURCES)
    if (!row) return null

    const payload = parseJson<Record<string, unknown>>(row.value_json, {})
    const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt : null
    if (expiresAt && expiresAt <= Date.now()) return null

    return this.restoreSecrets(payload.value)
  }

  async listWorkbenchShortcuts(): Promise<Array<Record<string, unknown>>> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT value_json
        FROM kv_records
        WHERE scope = 'workbench.shortcuts'
          AND source IN (${WORKBENCH_SHORTCUT_SOURCES.map(() => '?').join(', ')})
          AND deleted_at IS NULL
        ORDER BY updated_at DESC
      `,
      args: [...WORKBENCH_SHORTCUT_SOURCES]
    })
    const shortcuts: Array<Record<string, unknown>> = []

    for (const row of result.rows) {
      const shortcut = await this.restoreSecrets(parseJson<Record<string, unknown>>(row.value_json, {}))
      if (isRecord(shortcut)) {
        shortcuts.push(shortcut)
      }
    }

    return shortcuts
  }

  async upsertRecord(scope: string, key: string, value: unknown, updatedAt?: number | string) {
    const ownerId = `${scope}:${key}`
    const sanitized = await this.sanitizeSecrets(value, ownerId)
    await this.upsertKvRecord({
      scope,
      key,
      value: sanitized.value,
      source: 'app-record',
      updatedAt: toIsoTimestamp(updatedAt)
    })
  }

  async deleteRecord(scope: string, key: string, deletedAt?: number | string) {
    await this.deleteKvRecord(scope, key, 'app-record', deletedAt)
  }

  async upsertRecordSnapshot(record: AppDataRecordLike) {
    if (record.deletedAt) {
      await this.deleteKvRecord(record.scope, record.key, 'app-record', record.deletedAt)
      return
    }

    await this.upsertRecord(record.scope, record.key, record.value, record.updatedAt)
  }

  async upsertCache(namespace: string, key: string, value: unknown, ttlMs?: number, updatedAt: number = Date.now()) {
    const ownerId = `cache.${namespace}:${key}`
    const sanitized = await this.sanitizeSecrets(value, ownerId)
    await this.upsertKvRecord({
      scope: `cache.${namespace}`,
      key,
      value: {
        value: sanitized.value,
        expiresAt: ttlMs ? updatedAt + ttlMs : null
      },
      source: 'app-cache',
      updatedAt: toIsoTimestamp(updatedAt)
    })
  }

  async deleteCache(namespace: string, key: string, deletedAt?: number | string) {
    await this.deleteKvRecord(`cache.${namespace}`, key, 'app-cache', deletedAt)
  }

  async upsertWorkbenchShortcut(shortcut: WorkbenchShortcutLike) {
    const id = typeof shortcut.id === 'string' && shortcut.id ? shortcut.id : null
    if (!id) return

    const sanitized = await this.sanitizeSecrets(shortcut, `workbench.shortcuts:${id}`)
    await this.upsertKvRecord({
      scope: 'workbench.shortcuts',
      key: id,
      value: sanitized.value,
      source: 'workbench-shortcut',
      updatedAt: toIsoTimestamp(shortcut.updatedAt)
    })
  }

  async upsertSyncState(id: string, value: unknown, updatedAt: number | string = Date.now()) {
    const client = await storageV2Database.getClient()

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO sync_state (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
        args: [`legacy-app.${id}`, toJson(value), toIsoTimestamp(updatedAt)]
      })
    })
  }

  async getSyncState<T = unknown>(id: string): Promise<T | null> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: 'SELECT value_json FROM sync_state WHERE key = ?',
      args: [`legacy-app.${id}`]
    })
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    return (await this.restoreSecrets(parseJson(row.value_json, null))) as T | null
  }

  async upsertSyncConflict(
    id: string,
    input: {
      scope: string
      key: string
      localRecord?: AppDataRecordLike
      remoteRecord: AppDataRecordLike
      baseHash?: string | null
    }
  ) {
    const client = await storageV2Database.getClient()
    const sanitizedLocal = await this.sanitizeSecrets(input.localRecord?.value ?? null, `sync-conflict:${id}:local`)
    const sanitizedRemote = await this.sanitizeSecrets(input.remoteRecord.value, `sync-conflict:${id}:remote`)

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO sync_conflicts (
            id, entity_type, entity_id, local_snapshot_json, remote_snapshot_json,
            base_version, created_at, resolved_at
          )
          VALUES (?, 'app-record', ?, ?, ?, NULL, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            local_snapshot_json = excluded.local_snapshot_json,
            remote_snapshot_json = excluded.remote_snapshot_json,
            created_at = excluded.created_at,
            resolved_at = excluded.resolved_at
        `,
        args: [
          id,
          `${input.scope}:${input.key}`,
          toJson({
            value: sanitizedLocal.value,
            hash: input.localRecord?.valueHash ?? null
          }),
          toJson({
            value: sanitizedRemote.value,
            hash: input.remoteRecord.valueHash ?? null,
            baseHash: input.baseHash ?? null
          }),
          nowIso()
        ]
      })
    })
  }

  async listSyncConflicts(unresolvedOnly = true): Promise<StorageV2AppSyncConflict[]> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT id, entity_id, local_snapshot_json, remote_snapshot_json, created_at, resolved_at
        FROM sync_conflicts
        WHERE entity_type = 'app-record'
          ${unresolvedOnly ? 'AND resolved_at IS NULL' : ''}
        ORDER BY created_at DESC
      `,
      args: []
    })
    const conflicts: StorageV2AppSyncConflict[] = []

    for (const row of result.rows) {
      const id = typeof row.id === 'string' ? row.id : null
      if (!id) continue

      const entityId = typeof row.entity_id === 'string' ? row.entity_id : 'unknown:unknown'
      const separator = entityId.indexOf(':')
      const scope = separator >= 0 ? entityId.slice(0, separator) : 'unknown'
      const key = separator >= 0 ? entityId.slice(separator + 1) : entityId
      const localSnapshot = parseJson<Record<string, unknown>>(row.local_snapshot_json, {})
      const remoteSnapshot = parseJson<Record<string, unknown>>(row.remote_snapshot_json, {})

      conflicts.push({
        id,
        scope,
        key,
        local_value: await this.restoreSecrets(localSnapshot.value ?? null),
        remote_value: await this.restoreSecrets(remoteSnapshot.value ?? null),
        base_hash: typeof remoteSnapshot.baseHash === 'string' ? remoteSnapshot.baseHash : null,
        local_hash: typeof localSnapshot.hash === 'string' ? localSnapshot.hash : null,
        remote_hash: typeof remoteSnapshot.hash === 'string' ? remoteSnapshot.hash : null,
        created_at: epochMs(row.created_at),
        resolved_at: row.resolved_at ? epochMs(row.resolved_at) : null
      })
    }

    return conflicts
  }

  private async upsertKvRecord(input: {
    scope: string
    key: string
    value: unknown
    source: KvRecordSource
    updatedAt: string
  }) {
    const client = await storageV2Database.getClient()

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO kv_records (scope, key, value_json, source, updated_at, deleted_at, version)
          VALUES (?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = excluded.value_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = kv_records.version + 1
        `,
        args: [input.scope, input.key, toJson(input.value), input.source, input.updatedAt]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'kv_record',
        entityId: `${input.scope}:${input.key}`,
        payload: {
          scope: input.scope,
          key: input.key,
          source: input.source
        },
        version: await getKvRecordVersion(client, input.scope, input.key)
      })
    })
  }

  private async getKvRecord(
    scope: string,
    key: string,
    sources: readonly string[],
    options: { includeDeleted?: boolean } = {}
  ): Promise<Record<string, unknown> | null> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT value_json, source, updated_at, deleted_at
        FROM kv_records
        WHERE scope = ?
          AND key = ?
          AND source IN (${sources.map(() => '?').join(', ')})
          ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      args: [scope, key, ...sources]
    })
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null
  }

  private async deleteKvRecord(scope: string, key: string, source: KvRecordSource, deletedAtInput?: number | string) {
    const client = await storageV2Database.getClient()
    const deletedAt = toIsoTimestamp(deletedAtInput)

    await storageV2Database.withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO kv_records (scope, key, value_json, source, updated_at, deleted_at, version)
          VALUES (?, ?, NULL, ?, ?, ?, 1)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = NULL,
            source = excluded.source,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = kv_records.version + 1
        `,
        args: [scope, key, source, deletedAt, deletedAt]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'kv_record',
        entityId: `${scope}:${key}`,
        operation: 'delete',
        payload: {
          scope,
          key,
          source,
          deletedAt
        },
        version: await getKvRecordVersion(client, scope, key)
      })
    })
  }

  private async restoreSecrets(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      const restored: unknown[] = []
      for (const item of value) {
        restored.push(await this.restoreSecrets(item))
      }
      return restored
    }

    if (!isRecord(value)) return value

    const restored: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('SecretUnavailable')) {
        continue
      }

      if (key.endsWith('SecretRef') && typeof item === 'string' && item) {
        const originalKey = key.slice(0, -'SecretRef'.length)
        const secret = await storageV2SecretVaultService.getSecret(item)
        if (secret) {
          restored[originalKey] = secret
        } else {
          restored[`${originalKey}SecretUnavailable`] = true
        }
        continue
      }

      restored[key] = await this.restoreSecrets(item)
    }

    return restored
  }

  private async sanitizeSecrets(
    value: unknown,
    ownerId: string,
    pathParts: string[] = []
  ): Promise<{ value: unknown; importedSecretCount: number }> {
    if (Array.isArray(value)) {
      const sanitized: unknown[] = []
      let importedSecretCount = 0

      for (const [index, item] of value.entries()) {
        const result = await this.sanitizeSecrets(item, ownerId, [...pathParts, String(index)])
        sanitized.push(result.value)
        importedSecretCount += result.importedSecretCount
      }

      return { value: sanitized, importedSecretCount }
    }

    if (!isRecord(value)) {
      return { value, importedSecretCount: 0 }
    }

    const sanitized: Record<string, unknown> = {}
    let importedSecretCount = 0

    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...pathParts, key]
      if (isSensitiveKey(key) && typeof item === 'string' && item) {
        if (storageV2SecretVaultService.isAvailable()) {
          const secretRef = await storageV2SecretVaultService.setSecret('app-data', ownerId, nextPath.join('.'), item)
          sanitized[`${key}SecretRef`] = secretRef
          importedSecretCount++
        } else {
          sanitized[`${key}SecretUnavailable`] = true
        }
        continue
      }

      const result = await this.sanitizeSecrets(item, ownerId, nextPath)
      sanitized[key] = result.value
      importedSecretCount += result.importedSecretCount
    }

    return { value: sanitized, importedSecretCount }
  }
}

export const storageV2AppDataKvMirrorService = new StorageV2AppDataKvMirrorService()
