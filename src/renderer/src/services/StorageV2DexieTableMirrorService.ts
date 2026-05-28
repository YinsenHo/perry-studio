import { loggerService } from '@logger'
import db from '@renderer/databases'

const logger = loggerService.withContext('StorageV2DexieTableMirrorService')

const DEFAULT_DEBOUNCE_MS = 500
const STORAGE_V2_DEXIE_TABLE_PREFIX = 'dexie.table.'

export const STORAGE_V2_DEXIE_TABLE_NAMES = [
  'knowledge_notes',
  'quick_phrases',
  'translate_history',
  'translate_languages'
] as const

export type StorageV2DexieTableName = (typeof STORAGE_V2_DEXIE_TABLE_NAMES)[number]

type DexieAuxiliaryRow = Record<string, unknown> & { id: string }

type DexieTransactionLike = {
  on?: (eventName: 'complete', callback: () => void) => void
}

type DexieTableLike = {
  hook?: (eventName: 'creating' | 'updating' | 'deleting', callback: (...args: any[]) => void) => void
  where?: (index: string) => {
    anyOf: (keys: string[]) => {
      toArray: () => Promise<DexieAuxiliaryRow[]>
    }
  }
}

function toStorageV2SettingKey(tableName: StorageV2DexieTableName, id: string) {
  return `${STORAGE_V2_DEXIE_TABLE_PREFIX}${tableName}.${id}`
}

function getTable(tableName: StorageV2DexieTableName): DexieTableLike | undefined {
  return (db as unknown as Record<StorageV2DexieTableName, DexieTableLike>)[tableName]
}

function readRowId(primaryKey: unknown, obj?: { id?: unknown }): string | undefined {
  if (typeof obj?.id === 'string' && obj.id.length > 0) return obj.id
  if (typeof primaryKey === 'string' && primaryKey.length > 0) return primaryKey
  return undefined
}

function clonePendingMap(source: Map<StorageV2DexieTableName, Set<string>>) {
  return new Map(Array.from(source.entries()).map(([tableName, rowIds]) => [tableName, Array.from(rowIds)]))
}

class StorageV2DexieTableMirrorService {
  private installed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingRowIds = new Map<StorageV2DexieTableName, Set<string>>()
  private pendingDeletedIds = new Map<StorageV2DexieTableName, Set<string>>()
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false

  install() {
    if (this.installed) return
    this.installed = true

    for (const tableName of STORAGE_V2_DEXIE_TABLE_NAMES) {
      const table = getTable(tableName)
      if (typeof table?.hook !== 'function') {
        logger.warn(`Dexie ${tableName} hooks are unavailable; Storage v2 table mirror skipped this table.`)
        continue
      }

      table.hook('creating', (primaryKey, obj, transaction) => {
        this.afterCommit(transaction, () => this.scheduleRow(tableName, readRowId(primaryKey, obj)))
      })

      table.hook('updating', (_mods, primaryKey, _obj, transaction) => {
        this.afterCommit(transaction, () => this.scheduleRow(tableName, readRowId(primaryKey)))
      })

      table.hook('deleting', (primaryKey, _obj, transaction) => {
        this.afterCommit(transaction, () => this.scheduleDelete(tableName, readRowId(primaryKey)))
      })
    }
  }

  scheduleRow(tableName: StorageV2DexieTableName, rowId: string | undefined, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended || !rowId) return
    this.addPending(this.pendingRowIds, tableName, rowId)
    this.removePending(this.pendingDeletedIds, tableName, rowId)
    this.scheduleFlush(debounceMs)
  }

  scheduleDelete(tableName: StorageV2DexieTableName, rowId: string | undefined, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended || !rowId) return
    this.addPending(this.pendingDeletedIds, tableName, rowId)
    this.removePending(this.pendingRowIds, tableName, rowId)
    this.scheduleFlush(debounceMs)
  }

  scheduleDeletes(tableName: StorageV2DexieTableName, rowIds: string[], debounceMs = DEFAULT_DEBOUNCE_MS) {
    for (const rowId of rowIds) {
      this.scheduleDelete(tableName, rowId, debounceMs)
    }
  }

  async flush() {
    if (this.suspended) return
    if (!window.api?.storageV2) return

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.inflight) {
      this.needsFollowUp = true
      await this.inflight
      if (this.needsFollowUp) {
        this.needsFollowUp = false
        await this.flush()
      }
      return
    }

    if (this.pendingRowIds.size === 0 && this.pendingDeletedIds.size === 0) return

    this.inflight = this.mirrorPendingNow().finally(() => {
      this.inflight = null
    })

    await this.inflight
  }

  suspendUntilReload() {
    this.suspended = true
    this.pendingRowIds.clear()
    this.pendingDeletedIds.clear()
    this.needsFollowUp = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private afterCommit(transaction: DexieTransactionLike | undefined, callback: () => void) {
    if (transaction && typeof transaction.on === 'function') {
      transaction.on('complete', callback)
      return
    }

    setTimeout(callback, 0)
  }

  private scheduleFlush(debounceMs: number) {
    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, debounceMs)
  }

  private addPending(
    map: Map<StorageV2DexieTableName, Set<string>>,
    tableName: StorageV2DexieTableName,
    rowId: string
  ) {
    const rowIds = map.get(tableName) ?? new Set<string>()
    rowIds.add(rowId)
    map.set(tableName, rowIds)
  }

  private removePending(
    map: Map<StorageV2DexieTableName, Set<string>>,
    tableName: StorageV2DexieTableName,
    rowId: string
  ) {
    const rowIds = map.get(tableName)
    if (!rowIds) return
    rowIds.delete(rowId)
    if (rowIds.size === 0) {
      map.delete(tableName)
    }
  }

  private requeuePending(
    rowIdsByTable: Map<StorageV2DexieTableName, string[]>,
    deletedIdsByTable: Map<StorageV2DexieTableName, string[]>
  ) {
    for (const [tableName, rowIds] of rowIdsByTable.entries()) {
      for (const rowId of rowIds) {
        this.addPending(this.pendingRowIds, tableName, rowId)
      }
    }

    for (const [tableName, rowIds] of deletedIdsByTable.entries()) {
      for (const rowId of rowIds) {
        this.addPending(this.pendingDeletedIds, tableName, rowId)
      }
    }
  }

  private async mirrorPendingNow() {
    const rowIdsByTable = clonePendingMap(this.pendingRowIds)
    const deletedIdsByTable = clonePendingMap(this.pendingDeletedIds)
    this.pendingRowIds.clear()
    this.pendingDeletedIds.clear()

    try {
      let mirroredRowCount = 0
      let deleteMarkerCount = 0

      for (const tableName of STORAGE_V2_DEXIE_TABLE_NAMES) {
        const rowIds = rowIdsByTable.get(tableName) ?? []
        const deletedIds = deletedIdsByTable.get(tableName) ?? []
        if (rowIds.length === 0 && deletedIds.length === 0) continue

        const table = getTable(tableName)
        const rows = rowIds.length && table?.where ? await table.where('id').anyOf(rowIds).toArray() : []
        const foundRowIds = new Set(rows.map((row) => row.id))
        const missingRowIds = rowIds.filter((rowId) => !foundRowIds.has(rowId))

        for (const row of rows) {
          await window.api.storageV2.setSetting(
            toStorageV2SettingKey(tableName, row.id),
            row,
            `dexie-table:${tableName}`
          )
          mirroredRowCount++
        }

        for (const rowId of [...missingRowIds, ...deletedIds]) {
          await window.api.storageV2.setSetting(
            toStorageV2SettingKey(tableName, rowId),
            null,
            `dexie-table:${tableName}`
          )
          deleteMarkerCount++
        }
      }

      logger.debug(
        `Mirrored ${mirroredRowCount} Dexie auxiliary row(s) and ${deleteMarkerCount} delete marker(s) to Storage v2`
      )
    } catch (error) {
      this.requeuePending(rowIdsByTable, deletedIdsByTable)
      this.scheduleFlush(DEFAULT_DEBOUNCE_MS)
      logger.warn('Failed to mirror Dexie auxiliary tables to Storage v2', error as Error)
    }
  }
}

export const storageV2DexieTableMirrorService = new StorageV2DexieTableMirrorService()
