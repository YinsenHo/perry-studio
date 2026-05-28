import fs from 'node:fs'
import path from 'node:path'

import { createClient, type Row } from '@libsql/client'
import { app } from 'electron'

import { storageV2DataRootService } from './DataRootService'
import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2Database } from './StorageV2Database'

type LegacyAppDbImportOptions = {
  dryRun?: boolean
  dbPath?: string
}

export type StorageV2LegacyAppDbImportReport = {
  dryRun: boolean
  sourceDbPath: string | null
  snapshotPath?: string
  recordCount: number
  cacheCount: number
  syncStateCount: number
  syncConflictCount: number
  workbenchShortcutCount: number
  importedRecordCount: number
  importedCacheCount: number
  importedSyncStateCount: number
  importedSyncConflictCount: number
  importedWorkbenchShortcutCount: number
  secretCandidateCount: number
  importedSecretCount: number
  skippedSecretCount: number
  warnings: string[]
}

const LEGACY_TABLES = ['app_records', 'app_cache', 'sync_state', 'sync_conflicts', 'workbench_shortcuts'] as const
const SECRET_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bot[_-]?token|client[_-]?secret|app[_-]?secret|secret|password|private[_-]?key)/i

function now() {
  return new Date().toISOString()
}

function text(row: Row, key: string): string | null {
  const value = row[key]
  return value == null ? null : String(value)
}

function numberValue(row: Row, key: string): number | null {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function timestamp(value: unknown, fallback = now()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && value.length >= 10) {
      return new Date(parsed).toISOString()
    }
    return value
  }

  return fallback
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  if (!value.trim()) return null

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSensitiveKey(key: string) {
  return SECRET_KEY_PATTERN.test(key) && !/(secretRef|secretUnavailable)$/i.test(key)
}

function firstExistingPath(paths: Array<string | undefined>) {
  return paths.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))) ?? null
}

function candidateAppDbPaths(explicitPath?: string) {
  const dataRoot = storageV2DataRootService.resolveDataRoot().dataRoot
  const userDataPath = app.getPath('userData')

  return [explicitPath, path.join(dataRoot, 'app.db'), path.join(userDataPath, 'Data', 'app.db')]
}

async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const client = await storageV2Database.getClient()
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

export class StorageV2LegacyAppDbImportService {
  async importSnapshot(options: LegacyAppDbImportOptions = {}): Promise<StorageV2LegacyAppDbImportReport> {
    const dryRun = options.dryRun !== false
    const sourceDbPath = firstExistingPath(candidateAppDbPaths(options.dbPath))
    const warnings: string[] = []

    if (!sourceDbPath) {
      warnings.push('Legacy app database was not found.')
      return this.emptyReport(dryRun, null, warnings)
    }

    const legacyClient = createClient({
      url: `file:${sourceDbPath}`,
      intMode: 'number'
    })

    try {
      const tables = await this.getTables(legacyClient)
      const rows = await this.readRows(legacyClient, tables)
      const secretCandidateCount = this.countSecretCandidates(rows)
      let importedSecretCount = 0
      let snapshotPath: string | undefined

      if (secretCandidateCount > 0 && dryRun) {
        warnings.push('Sensitive app data fields were detected. Dry run did not write them to the secret vault.')
      } else if (secretCandidateCount > 0 && !storageV2SecretVaultService.isAvailable()) {
        warnings.push(
          'Sensitive app data fields were detected but safeStorage encryption is unavailable on this system.'
        )
      }

      if (!dryRun) {
        snapshotPath = (await storageV2Database.createSnapshot('before-legacy-app-db-import')).path
        importedSecretCount = await withTransaction(async () => this.writeRows(rows))
      }

      return {
        dryRun,
        sourceDbPath,
        snapshotPath,
        recordCount: rows.app_records.length,
        cacheCount: rows.app_cache.length,
        syncStateCount: rows.sync_state.length,
        syncConflictCount: rows.sync_conflicts.length,
        workbenchShortcutCount: rows.workbench_shortcuts.length,
        importedRecordCount: dryRun ? 0 : rows.app_records.length,
        importedCacheCount: dryRun ? 0 : rows.app_cache.length,
        importedSyncStateCount: dryRun ? 0 : rows.sync_state.length,
        importedSyncConflictCount: dryRun ? 0 : rows.sync_conflicts.length,
        importedWorkbenchShortcutCount: dryRun ? 0 : rows.workbench_shortcuts.length,
        secretCandidateCount,
        importedSecretCount,
        skippedSecretCount: secretCandidateCount - importedSecretCount,
        warnings
      }
    } finally {
      legacyClient.close()
    }
  }

  private emptyReport(
    dryRun: boolean,
    sourceDbPath: string | null,
    warnings: string[]
  ): StorageV2LegacyAppDbImportReport {
    return {
      dryRun,
      sourceDbPath,
      recordCount: 0,
      cacheCount: 0,
      syncStateCount: 0,
      syncConflictCount: 0,
      workbenchShortcutCount: 0,
      importedRecordCount: 0,
      importedCacheCount: 0,
      importedSyncStateCount: 0,
      importedSyncConflictCount: 0,
      importedWorkbenchShortcutCount: 0,
      secretCandidateCount: 0,
      importedSecretCount: 0,
      skippedSecretCount: 0,
      warnings
    }
  }

  private async getTables(client: ReturnType<typeof createClient>) {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    return new Set(result.rows.map((row) => String(row.name)))
  }

  private async readRows(client: ReturnType<typeof createClient>, tables: Set<string>) {
    const rows = Object.fromEntries(LEGACY_TABLES.map((table) => [table, [] as Row[]])) as Record<
      (typeof LEGACY_TABLES)[number],
      Row[]
    >

    for (const table of LEGACY_TABLES) {
      if (!tables.has(table)) continue
      const result = await client.execute(`SELECT * FROM ${table}`)
      rows[table] = result.rows
    }

    return rows
  }

  private countSecretCandidates(rows: Record<(typeof LEGACY_TABLES)[number], Row[]>) {
    const appRecordCount = rows.app_records.reduce(
      (count, row) => count + this.countSecretsInValue(parseJson(text(row, 'value'))),
      0
    )
    const cacheCount = rows.app_cache.reduce(
      (count, row) => count + this.countSecretsInValue(parseJson(text(row, 'value'))),
      0
    )
    const shortcutCount = rows.workbench_shortcuts.reduce(
      (count, row) => count + this.countSecretsInValue(parseJson(text(row, 'metadata'))),
      0
    )
    const conflictCount = rows.sync_conflicts.reduce(
      (count, row) =>
        count +
        this.countSecretsInValue(parseJson(text(row, 'local_value'))) +
        this.countSecretsInValue(parseJson(text(row, 'remote_value'))),
      0
    )

    return appRecordCount + cacheCount + shortcutCount + conflictCount
  }

  private countSecretsInValue(value: unknown): number {
    if (Array.isArray(value)) {
      return value.reduce((count, item) => count + this.countSecretsInValue(item), 0)
    }

    if (!isRecord(value)) {
      return 0
    }

    return Object.entries(value).reduce((count, [key, item]) => {
      if (isSensitiveKey(key) && typeof item === 'string' && item) {
        return count + 1
      }
      return count + this.countSecretsInValue(item)
    }, 0)
  }

  private async sanitizeSecrets(
    value: unknown,
    ownerId: string,
    pathParts: string[] = []
  ): Promise<{
    value: unknown
    importedSecretCount: number
  }> {
    if (Array.isArray(value)) {
      let importedSecretCount = 0
      const items: unknown[] = []
      for (const [index, item] of value.entries()) {
        const result = await this.sanitizeSecrets(item, ownerId, [...pathParts, String(index)])
        items.push(result.value)
        importedSecretCount += result.importedSecretCount
      }
      return { value: items, importedSecretCount }
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

  private async writeRows(rows: Record<(typeof LEGACY_TABLES)[number], Row[]>) {
    const client = await storageV2Database.getClient()
    let importedSecretCount = 0
    const appRecordKeys = new Set<string>()
    const appCacheKeys = new Set<string>()
    const workbenchShortcutKeys = new Set<string>()
    const syncStateKeys = new Set<string>()
    const syncConflictIds = new Set<string>()

    for (const row of rows.app_records) {
      const scope = text(row, 'scope')
      const key = text(row, 'key')
      if (!scope || !key) continue
      appRecordKeys.add(`${scope}\u001f${key}`)
      const sanitized = await this.sanitizeSecrets(parseJson(text(row, 'value')), `${scope}:${key}`)
      importedSecretCount += sanitized.importedSecretCount

      await client.execute({
        sql: `
          INSERT INTO kv_records (scope, key, value_json, source, updated_at, deleted_at, version)
          VALUES (?, ?, ?, 'legacy-app-record', ?, ?, ?)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = excluded.value_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = excluded.version
        `,
        args: [
          scope,
          key,
          toJson(sanitized.value),
          timestamp(row.updated_at),
          row.deleted_at ? timestamp(row.deleted_at) : null,
          numberValue(row, 'version') ?? 1
        ]
      })
    }

    for (const row of rows.app_cache) {
      const namespace = text(row, 'namespace')
      const key = text(row, 'key')
      if (!namespace || !key) continue
      appCacheKeys.add(`cache.${namespace}\u001f${key}`)
      const sanitized = await this.sanitizeSecrets(parseJson(text(row, 'value')), `cache.${namespace}:${key}`)
      importedSecretCount += sanitized.importedSecretCount

      await client.execute({
        sql: `
          INSERT INTO kv_records (scope, key, value_json, source, updated_at, deleted_at, version)
          VALUES (?, ?, ?, 'legacy-app-cache', ?, NULL, 1)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = excluded.value_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = kv_records.version + 1
        `,
        args: [
          `cache.${namespace}`,
          key,
          toJson({
            value: sanitized.value,
            expiresAt: numberValue(row, 'expires_at')
          }),
          timestamp(row.updated_at)
        ]
      })
    }

    for (const row of rows.workbench_shortcuts) {
      const id = text(row, 'id')
      if (!id) continue
      workbenchShortcutKeys.add(`workbench.shortcuts\u001f${id}`)
      const sanitizedMetadata = await this.sanitizeSecrets(
        parseJson(text(row, 'metadata')),
        `workbench.shortcuts:${id}`
      )
      importedSecretCount += sanitizedMetadata.importedSecretCount

      await client.execute({
        sql: `
          INSERT INTO kv_records (scope, key, value_json, source, updated_at, deleted_at, version)
          VALUES ('workbench.shortcuts', ?, ?, 'legacy-workbench-shortcut', ?, ?, 1)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = excluded.value_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = kv_records.version + 1
        `,
        args: [
          id,
          toJson({
            id,
            name: text(row, 'name'),
            url: text(row, 'url'),
            sourcePath: text(row, 'source_path'),
            kind: text(row, 'kind'),
            metadata: sanitizedMetadata.value,
            createdAt: numberValue(row, 'created_at'),
            updatedAt: numberValue(row, 'updated_at'),
            deletedAt: numberValue(row, 'deleted_at')
          }),
          timestamp(row.updated_at),
          row.deleted_at ? timestamp(row.deleted_at) : null
        ]
      })
    }

    for (const row of rows.sync_state) {
      const id = text(row, 'id')
      if (!id) continue
      syncStateKeys.add(`legacy-app.${id}`)

      await client.execute({
        sql: `
          INSERT INTO sync_state (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
        args: [`legacy-app.${id}`, toJson(parseJson(text(row, 'value'))), timestamp(row.updated_at)]
      })
    }

    for (const row of rows.sync_conflicts) {
      const id = text(row, 'id')
      if (!id) continue
      syncConflictIds.add(id)
      const sanitizedLocal = await this.sanitizeSecrets(
        parseJson(text(row, 'local_value')),
        `sync-conflict:${id}:local`
      )
      const sanitizedRemote = await this.sanitizeSecrets(
        parseJson(text(row, 'remote_value')),
        `sync-conflict:${id}:remote`
      )
      importedSecretCount += sanitizedLocal.importedSecretCount + sanitizedRemote.importedSecretCount

      await client.execute({
        sql: `
          INSERT INTO sync_conflicts (
            id, entity_type, entity_id, local_snapshot_json, remote_snapshot_json,
            base_version, created_at, resolved_at
          )
          VALUES (?, 'legacy-app-record', ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            local_snapshot_json = excluded.local_snapshot_json,
            remote_snapshot_json = excluded.remote_snapshot_json,
            created_at = excluded.created_at,
            resolved_at = excluded.resolved_at
        `,
        args: [
          id,
          `${text(row, 'scope') ?? 'unknown'}:${text(row, 'key') ?? 'unknown'}`,
          toJson({
            value: sanitizedLocal.value,
            hash: text(row, 'local_hash')
          }),
          toJson({
            value: sanitizedRemote.value,
            hash: text(row, 'remote_hash'),
            baseHash: text(row, 'base_hash')
          }),
          timestamp(row.created_at),
          row.resolved_at ? timestamp(row.resolved_at) : null
        ]
      })
    }

    await this.markMissingKvRowsDeleted(client, 'legacy-app-record', appRecordKeys)
    await this.markMissingKvRowsDeleted(client, 'legacy-app-cache', appCacheKeys)
    await this.markMissingKvRowsDeleted(client, 'legacy-workbench-shortcut', workbenchShortcutKeys)
    await this.deleteMissingSyncStateRows(client, syncStateKeys)
    await this.deleteMissingSyncConflictRows(client, syncConflictIds)

    return importedSecretCount
  }

  private async markMissingKvRowsDeleted(
    client: ReturnType<typeof createClient>,
    source: 'legacy-app-record' | 'legacy-app-cache' | 'legacy-workbench-shortcut',
    keys: Set<string>
  ) {
    const currentTime = now()

    if (keys.size === 0) {
      await client.execute({
        sql: `
          UPDATE kv_records
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE source = ? AND deleted_at IS NULL
        `,
        args: [currentTime, currentTime, source]
      })
      return
    }

    await client.execute({
      sql: `
        UPDATE kv_records
        SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE source = ?
          AND deleted_at IS NULL
          AND scope || char(31) || key NOT IN (${Array.from(keys)
            .map(() => '?')
            .join(', ')})
      `,
      args: [currentTime, currentTime, source, ...Array.from(keys)]
    })
  }

  private async deleteMissingSyncStateRows(client: ReturnType<typeof createClient>, keys: Set<string>) {
    if (keys.size === 0) {
      await client.execute("DELETE FROM sync_state WHERE key LIKE 'legacy-app.%'")
      return
    }

    await client.execute({
      sql: `
        DELETE FROM sync_state
        WHERE key LIKE 'legacy-app.%'
          AND key NOT IN (${Array.from(keys)
            .map(() => '?')
            .join(', ')})
      `,
      args: Array.from(keys)
    })
  }

  private async deleteMissingSyncConflictRows(client: ReturnType<typeof createClient>, ids: Set<string>) {
    if (ids.size === 0) {
      await client.execute("DELETE FROM sync_conflicts WHERE entity_type = 'legacy-app-record'")
      return
    }

    await client.execute({
      sql: `
        DELETE FROM sync_conflicts
        WHERE entity_type = 'legacy-app-record'
          AND id NOT IN (${Array.from(ids)
            .map(() => '?')
            .join(', ')})
      `,
      args: Array.from(ids)
    })
  }
}

export const storageV2LegacyAppDbImportService = new StorageV2LegacyAppDbImportService()
