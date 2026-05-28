import { loggerService } from '@logger'
import db from '@renderer/databases'

const logger = loggerService.withContext('StorageV2DexieSettingsMirrorService')

const DEFAULT_DEBOUNCE_MS = 0
const RETRY_DEBOUNCE_MS = 5000
const STORAGE_V2_DEXIE_SETTINGS_PREFIX = 'dexie.settings.'

type DexieTransactionLike = {
  on?: (eventName: 'complete', callback: () => void) => void
}

function toStorageV2SettingKey(id: string) {
  return `${STORAGE_V2_DEXIE_SETTINGS_PREFIX}${id}`
}

class StorageV2DexieSettingsMirrorService {
  private installed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingSettingIds = new Set<string>()
  private pendingDeletedIds = new Set<string>()
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false
  private lastError: unknown = null

  install() {
    if (this.installed) return
    this.installed = true

    if (typeof db.settings?.hook !== 'function') {
      logger.warn('Dexie settings hooks are unavailable; Storage v2 settings mirror was not installed.')
      return
    }

    db.settings.hook('creating', (primaryKey, obj, transaction) => {
      const id = typeof obj?.id === 'string' ? obj.id : typeof primaryKey === 'string' ? primaryKey : undefined
      this.afterCommit(transaction, () => this.scheduleSetting(id))
    })

    db.settings.hook('updating', (_mods, primaryKey, _obj, transaction) => {
      const id = typeof primaryKey === 'string' ? primaryKey : undefined
      this.afterCommit(transaction, () => this.scheduleSetting(id))
    })

    db.settings.hook('deleting', (primaryKey, _obj, transaction) => {
      const id = typeof primaryKey === 'string' ? primaryKey : undefined
      this.afterCommit(transaction, () => this.scheduleDelete(id))
    })
  }

  scheduleSetting(settingId: string | undefined, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended || !settingId) return
    this.pendingDeletedIds.delete(settingId)
    this.pendingSettingIds.add(settingId)
    this.scheduleFlush(debounceMs)
  }

  scheduleDelete(settingId: string | undefined, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended || !settingId) return
    this.pendingSettingIds.delete(settingId)
    this.pendingDeletedIds.add(settingId)
    this.scheduleFlush(debounceMs)
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

    if (this.pendingSettingIds.size === 0 && this.pendingDeletedIds.size === 0) return

    this.inflight = this.mirrorPendingNow().finally(() => {
      this.inflight = null
    })

    await this.inflight
  }

  async flushStrict() {
    await this.flush()

    if (this.hasPendingWork() && this.lastError) {
      throw this.lastError instanceof Error
        ? this.lastError
        : new Error('Failed to mirror Dexie settings to Storage v2')
    }
  }

  suspendUntilReload() {
    this.suspended = true
    this.pendingSettingIds.clear()
    this.pendingDeletedIds.clear()
    this.needsFollowUp = false
    this.lastError = null

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
      this.timer = null
    }

    if (debounceMs <= 0) {
      void this.flush()
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, debounceMs)
  }

  private hasPendingWork() {
    return this.pendingSettingIds.size > 0 || this.pendingDeletedIds.size > 0
  }

  private async mirrorPendingNow() {
    const settingIds = Array.from(this.pendingSettingIds)
    const deletedIds = Array.from(this.pendingDeletedIds)
    this.pendingSettingIds.clear()
    this.pendingDeletedIds.clear()

    try {
      const settings = settingIds.length ? await db.settings.where('id').anyOf(settingIds).toArray() : []
      const foundSettingIds = new Set(settings.map((setting) => setting.id))
      const missingSettingIds = settingIds.filter((settingId) => !foundSettingIds.has(settingId))

      for (const setting of settings) {
        await window.api.storageV2.setSetting(
          toStorageV2SettingKey(setting.id),
          setting.value ?? null,
          'dexie-settings'
        )
      }

      for (const settingId of [...missingSettingIds, ...deletedIds]) {
        await window.api.storageV2.setSetting(toStorageV2SettingKey(settingId), null, 'dexie-settings')
      }

      logger.debug(
        `Mirrored ${settings.length} Dexie setting(s) and ${deletedIds.length} delete marker(s) to Storage v2`
      )
      this.lastError = null
    } catch (error) {
      for (const settingId of settingIds) {
        this.pendingSettingIds.add(settingId)
      }
      for (const settingId of deletedIds) {
        this.pendingDeletedIds.add(settingId)
      }
      this.lastError = error
      this.scheduleFlush(RETRY_DEBOUNCE_MS)
      logger.warn('Failed to mirror Dexie settings to Storage v2', error as Error)
    }
  }
}

export const storageV2DexieSettingsMirrorService = new StorageV2DexieSettingsMirrorService()
