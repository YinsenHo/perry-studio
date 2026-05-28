import { loggerService } from '@logger'
import { getAppDataDatabase } from '@main/services/appData/AppDataDatabase'

import { storageV2AppDataLegacyProjectionService } from './AppDataLegacyProjectionService'
import { storageV2LegacyAppDbImportService } from './LegacyAppDbImportService'
import { storageV2Database } from './StorageV2Database'

const logger = loggerService.withContext('StorageV2AppDataRuntimeRecoveryService')
const APP_RECORD_SOURCES = ['legacy-app-record', 'app-record'] as const

function countFromRow(row: Record<string, unknown> | undefined): number {
  const value = row?.count
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export class StorageV2AppDataRuntimeRecoveryService {
  private projection: Promise<boolean> | null = null
  private legacySeed: Promise<boolean> | null = null

  async projectIfLegacyAppRecordListEmpty(scope: string | undefined, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => {
      if ((await this.countLegacyAppRecords(scope)) > 0) return false
      return (await this.countStorageAppRecords(scope)) > 0
    })
  }

  async projectIfAppRecordMissing(scope: string, key: string, reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => {
      if ((await this.countLegacyAppRecord(scope, key)) > 0) return false
      return (await this.countStorageAppRecords(scope, key)) > 0
    })
  }

  async projectIfLegacyWorkbenchShortcutListEmpty(reason: string): Promise<boolean> {
    return this.projectIfStorageHasRows(reason, async () => {
      if ((await this.countLegacyWorkbenchShortcutRows()) > 0) return false
      return (await this.countStorageWorkbenchShortcuts()) > 0
    })
  }

  private async projectIfStorageHasRows(reason: string, hasRows: () => Promise<boolean>): Promise<boolean> {
    while (this.projection) {
      if (await this.projection) {
        return true
      }
    }

    this.projection = this.projectNow(reason, hasRows).finally(() => {
      this.projection = null
    })

    return this.projection
  }

  private async projectNow(reason: string, hasRows: () => Promise<boolean>): Promise<boolean> {
    try {
      const legacySeeded = await this.seedStorageFromLegacyRuntime(reason)
      if (!legacySeeded) return false

      const storageHasRows = await hasRows()
      if (!storageHasRows) {
        return false
      }

      const report = await storageV2AppDataLegacyProjectionService.projectToLegacyRuntime()
      logger.info('Recovered legacy app data runtime from Storage v2', {
        reason,
        appDbPath: report.appDbPath,
        recordCount: report.projectedRecordCount,
        cacheCount: report.projectedCacheCount,
        shortcutCount: report.projectedWorkbenchShortcutCount
      })
      return true
    } catch (error) {
      logger.warn('Failed to recover legacy app data runtime from Storage v2', error as Error)
      return false
    }
  }

  private async seedStorageFromLegacyRuntime(reason: string): Promise<boolean> {
    if (this.legacySeed) {
      return this.legacySeed
    }

    this.legacySeed = storageV2LegacyAppDbImportService
      .importSnapshot({ dryRun: false, createSnapshot: false, pruneMissing: false })
      .then((report) => {
        if (report.recordCount > 0 || report.cacheCount > 0 || report.workbenchShortcutCount > 0) {
          logger.info('Seeded Storage v2 app data from legacy runtime before recovery', {
            reason,
            sourceDbPath: report.sourceDbPath,
            recordCount: report.recordCount,
            cacheCount: report.cacheCount,
            shortcutCount: report.workbenchShortcutCount
          })
        }
        return true
      })
      .catch((error) => {
        logger.warn('Failed to seed Storage v2 app data from legacy runtime', error as Error)
        return false
      })
      .finally(() => {
        this.legacySeed = null
      })

    return this.legacySeed
  }

  private async countLegacyAppRecords(scope: string | undefined) {
    const appDataDb = await getAppDataDatabase()
    const client = await appDataDb.getRawClient()
    const result = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM app_records${scope ? ' WHERE scope = ?' : ''}`,
      args: scope ? [scope] : []
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countLegacyAppRecord(scope: string, key: string) {
    const appDataDb = await getAppDataDatabase()
    const client = await appDataDb.getRawClient()
    const result = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM app_records WHERE scope = ? AND key = ?',
      args: [scope, key]
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageAppRecords(scope: string | undefined, key?: string) {
    const client = await storageV2Database.getClient()
    const filters: string[] = []
    const args: string[] = [...APP_RECORD_SOURCES]

    if (scope) {
      filters.push('scope = ?')
      args.push(scope)
    }

    if (key) {
      filters.push('key = ?')
      args.push(key)
    }

    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM kv_records
        WHERE source IN (${APP_RECORD_SOURCES.map(() => '?').join(', ')})
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      `,
      args
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countLegacyWorkbenchShortcutRows() {
    const appDataDb = await getAppDataDatabase()
    const client = await appDataDb.getRawClient()
    const result = await client.execute('SELECT COUNT(*) AS count FROM workbench_shortcuts')
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }

  private async countStorageWorkbenchShortcuts() {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM kv_records
        WHERE scope = 'workbench.shortcuts'
          AND source IN ('legacy-workbench-shortcut', 'workbench-shortcut')
      `,
      args: []
    })
    return countFromRow(result.rows[0] as Record<string, unknown> | undefined)
  }
}

export const storageV2AppDataRuntimeRecoveryService = new StorageV2AppDataRuntimeRecoveryService()
