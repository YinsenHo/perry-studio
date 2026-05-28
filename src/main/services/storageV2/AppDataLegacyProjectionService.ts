import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Client, Row } from '@libsql/client'
import { loggerService } from '@logger'
import { AppDataDatabase, getAppDataDatabase } from '@main/services/appData/AppDataDatabase'
import { app } from 'electron'

import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2Database } from './StorageV2Database'

export type StorageV2AppDataLegacyProjectionReport = {
  appDbPath: string
  archivedFiles: string[]
  projectedRecordCount: number
  projectedCacheCount: number
  projectedSyncStateCount: number
  projectedSyncConflictCount: number
  projectedWorkbenchShortcutCount: number
  restoredSecretCount: number
  missingSecretCount: number
  warnings: string[]
}

function text(row: Row, key: string): string | null {
  const value = row[key]
  return value == null ? null : String(value)
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

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function epochMs(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.length >= 10) return numeric

    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function hashValue(value: unknown, deletedAt?: number | null) {
  const payload = deletedAt ? { deletedAt } : value
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
}

function getAppDbPath() {
  return path.join(app.getPath('userData'), 'Data', 'app.db')
}

function archiveFileIfExists(source: string, archiveRoot: string) {
  if (!fs.existsSync(source)) return null

  const target = path.join(archiveRoot, 'app-runtime', 'Data', path.basename(source))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(source, target)
  return target
}

async function withTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.execute('BEGIN IMMEDIATE')
  try {
    const result = await fn()
    await client.execute('COMMIT')
    return result
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {})
    throw error
  }
}

function emptyReport(appDbPath: string): StorageV2AppDataLegacyProjectionReport {
  return {
    appDbPath,
    archivedFiles: [],
    projectedRecordCount: 0,
    projectedCacheCount: 0,
    projectedSyncStateCount: 0,
    projectedSyncConflictCount: 0,
    projectedWorkbenchShortcutCount: 0,
    restoredSecretCount: 0,
    missingSecretCount: 0,
    warnings: []
  }
}

export class StorageV2AppDataLegacyProjectionService {
  private logger = loggerService.withContext('StorageV2AppDataLegacyProjectionService')

  async projectToLegacyRuntime(
    options: { archiveRoot?: string } = {}
  ): Promise<StorageV2AppDataLegacyProjectionReport> {
    const appDbPath = getAppDbPath()
    const archiveRoot = options.archiveRoot ?? path.join(path.dirname(appDbPath), 'legacy-app-projection')
    const report = emptyReport(appDbPath)

    await AppDataDatabase.close()

    for (const suffix of ['', '-wal', '-shm']) {
      const archivedFile = archiveFileIfExists(`${appDbPath}${suffix}`, archiveRoot)
      if (archivedFile) {
        report.archivedFiles.push(archivedFile)
      }
    }

    const appDataDb = await getAppDataDatabase()
    const targetClient = await appDataDb.getRawClient()
    const storageClient = await storageV2Database.getClient()

    await withTransaction(targetClient, async () => {
      await this.resetLegacyTables(targetClient)
      await this.projectRows(storageClient, targetClient, report)
    })

    await AppDataDatabase.close()

    this.logger.info('Projected Storage v2 app data to legacy runtime database', {
      appDbPath,
      projectedRecordCount: report.projectedRecordCount,
      projectedWorkbenchShortcutCount: report.projectedWorkbenchShortcutCount
    })

    return report
  }

  private async resetLegacyTables(client: Client) {
    await client.execute('DELETE FROM workbench_shortcuts')
    await client.execute('DELETE FROM sync_conflicts')
    await client.execute('DELETE FROM app_cache')
    await client.execute('DELETE FROM app_records')
    await client.execute("DELETE FROM sync_state WHERE id != 'device-id'")
  }

  private async restoreSecrets(value: unknown, report: StorageV2AppDataLegacyProjectionReport): Promise<unknown> {
    if (Array.isArray(value)) {
      const restored: unknown[] = []
      for (const item of value) {
        restored.push(await this.restoreSecrets(item, report))
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
          report.restoredSecretCount++
        } else {
          restored[key] = item
          report.missingSecretCount++
          report.warnings.push(`Missing secret for restored app data key ${key}.`)
        }
        continue
      }

      restored[key] = await this.restoreSecrets(item, report)
    }

    return restored
  }

  private async projectRows(
    storageClient: Client,
    targetClient: Client,
    report: StorageV2AppDataLegacyProjectionReport
  ) {
    const [recordsResult, syncStateResult, conflictsResult] = await Promise.all([
      storageClient.execute(`
        SELECT scope, key, value_json, source, updated_at, deleted_at, version
        FROM kv_records
        WHERE source IN ('legacy-app-record', 'legacy-app-cache', 'legacy-workbench-shortcut')
        ORDER BY updated_at ASC
      `),
      storageClient.execute(`
        SELECT key, value_json, updated_at
        FROM sync_state
        WHERE key LIKE 'legacy-app.%'
        ORDER BY updated_at ASC
      `),
      storageClient.execute(`
        SELECT id, entity_id, local_snapshot_json, remote_snapshot_json, created_at, resolved_at
        FROM sync_conflicts
        WHERE entity_type = 'legacy-app-record'
        ORDER BY created_at ASC
      `)
    ])

    const restoredDeviceId = this.getRestoredDeviceId(syncStateResult.rows) ?? randomUUID()

    for (const row of syncStateResult.rows) {
      const storageKey = text(row, 'key')
      if (!storageKey?.startsWith('legacy-app.')) continue
      const id = storageKey.slice('legacy-app.'.length)
      const value = await this.restoreSecrets(parseJson(text(row, 'value_json'), null), report)

      await targetClient.execute({
        sql: `
          INSERT INTO sync_state (id, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
        args: [id, toJson(value), epochMs(row.updated_at)]
      })
      report.projectedSyncStateCount++
    }

    for (const row of recordsResult.rows) {
      const source = text(row, 'source')
      if (source === 'legacy-app-record') {
        await this.projectAppRecord(row, targetClient, restoredDeviceId, report)
      } else if (source === 'legacy-app-cache') {
        await this.projectAppCache(row, targetClient, report)
      } else if (source === 'legacy-workbench-shortcut') {
        await this.projectWorkbenchShortcut(row, targetClient, restoredDeviceId, report)
      }
    }

    for (const row of conflictsResult.rows) {
      await this.projectSyncConflict(row, targetClient, report)
    }
  }

  private getRestoredDeviceId(rows: Row[]) {
    const row = rows.find((candidate) => text(candidate, 'key') === 'legacy-app.device-id')
    const value = parseJson<unknown>(text(row ?? ({} as Row), 'value_json'), null)
    return typeof value === 'string' && value ? value : null
  }

  private async projectAppRecord(
    row: Row,
    targetClient: Client,
    deviceId: string,
    report: StorageV2AppDataLegacyProjectionReport
  ) {
    const scope = text(row, 'scope')
    const key = text(row, 'key')
    if (!scope || !key) return

    const value = await this.restoreSecrets(parseJson(text(row, 'value_json'), null), report)
    const deletedAt = row.deleted_at ? epochMs(row.deleted_at) : null
    const updatedAt = epochMs(row.updated_at)

    await targetClient.execute({
      sql: `
        INSERT INTO app_records (scope, key, value, value_hash, updated_at, deleted_at, device_id, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET
          value = excluded.value,
          value_hash = excluded.value_hash,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          device_id = excluded.device_id,
          version = excluded.version
      `,
      args: [
        scope,
        key,
        toJson(value),
        hashValue(value, deletedAt),
        updatedAt,
        deletedAt,
        deviceId,
        numberValue(row.version) ?? 1
      ]
    })
    report.projectedRecordCount++
  }

  private async projectAppCache(row: Row, targetClient: Client, report: StorageV2AppDataLegacyProjectionReport) {
    const scope = text(row, 'scope')
    const key = text(row, 'key')
    if (!scope?.startsWith('cache.') || !key) return

    const payload = parseJson<Record<string, unknown>>(text(row, 'value_json'), {})
    const value = await this.restoreSecrets(payload.value, report)

    await targetClient.execute({
      sql: `
        INSERT INTO app_cache (namespace, key, value, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      args: [scope.slice('cache.'.length), key, toJson(value), numberValue(payload.expiresAt), epochMs(row.updated_at)]
    })
    report.projectedCacheCount++
  }

  private async projectWorkbenchShortcut(
    row: Row,
    targetClient: Client,
    deviceId: string,
    report: StorageV2AppDataLegacyProjectionReport
  ) {
    const key = text(row, 'key')
    if (!key) return

    const shortcut = (await this.restoreSecrets(
      parseJson<Record<string, unknown>>(text(row, 'value_json'), {}),
      report
    )) as Record<string, unknown>
    const id = typeof shortcut.id === 'string' && shortcut.id ? shortcut.id : key
    const updatedAt = numberValue(shortcut.updatedAt) ?? epochMs(row.updated_at)
    const deletedAt = numberValue(shortcut.deletedAt)

    await targetClient.execute({
      sql: `
        INSERT INTO workbench_shortcuts (
          id, name, url, source_path, kind, metadata, created_at, updated_at, deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        typeof shortcut.name === 'string' ? shortcut.name : id,
        typeof shortcut.url === 'string' ? shortcut.url : '',
        typeof shortcut.sourcePath === 'string' ? shortcut.sourcePath : null,
        typeof shortcut.kind === 'string' ? shortcut.kind : 'url',
        toJson(shortcut.metadata ?? null),
        numberValue(shortcut.createdAt) ?? updatedAt,
        updatedAt,
        deletedAt
      ]
    })

    await targetClient.execute({
      sql: `
        INSERT INTO app_records (scope, key, value, value_hash, updated_at, deleted_at, device_id, version)
        VALUES ('workbench.shortcuts', ?, ?, ?, ?, ?, ?, 1)
      `,
      args: [id, toJson(shortcut), hashValue(shortcut, deletedAt), updatedAt, deletedAt, deviceId]
    })
    report.projectedWorkbenchShortcutCount++
  }

  private async projectSyncConflict(row: Row, targetClient: Client, report: StorageV2AppDataLegacyProjectionReport) {
    const id = text(row, 'id')
    if (!id) return

    const entityId = text(row, 'entity_id') ?? 'unknown:unknown'
    const separator = entityId.indexOf(':')
    const scope = separator >= 0 ? entityId.slice(0, separator) : 'unknown'
    const key = separator >= 0 ? entityId.slice(separator + 1) : entityId
    const localSnapshot = parseJson<Record<string, unknown>>(text(row, 'local_snapshot_json'), {})
    const remoteSnapshot = parseJson<Record<string, unknown>>(text(row, 'remote_snapshot_json'), {})
    const localValue = await this.restoreSecrets(localSnapshot.value, report)
    const remoteValue = await this.restoreSecrets(remoteSnapshot.value, report)

    await targetClient.execute({
      sql: `
        INSERT INTO sync_conflicts (
          id, scope, key, local_value, remote_value, base_hash,
          local_hash, remote_hash, created_at, resolved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        scope,
        key,
        toJson(localValue),
        toJson(remoteValue),
        typeof remoteSnapshot.baseHash === 'string' ? remoteSnapshot.baseHash : null,
        typeof localSnapshot.hash === 'string' ? localSnapshot.hash : null,
        typeof remoteSnapshot.hash === 'string' ? remoteSnapshot.hash : null,
        epochMs(row.created_at),
        row.resolved_at ? epochMs(row.resolved_at) : null
      ]
    })
    report.projectedSyncConflictCount++
  }
}

export const storageV2AppDataLegacyProjectionService = new StorageV2AppDataLegacyProjectionService()
