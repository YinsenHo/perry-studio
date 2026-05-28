import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    tables: [] as Array<{ name: string }>,
    transaction: vi.fn(async (_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn()),
    table: vi.fn()
  },
  handleSaveData: vi.fn(),
  i18nT: vi.fn((key: string) => key),
  logger: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn()
  },
  importLegacyDexieToStorageV2: vi.fn(),
  suspendStorageV2RuntimeMirrorsUntilReload: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('@renderer/databases', () => ({
  default: mocks.db
}))

vi.mock('@renderer/databases/upgrades', () => ({
  upgradeToV7: vi.fn(),
  upgradeToV8: vi.fn()
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    t: mocks.i18nT
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: vi.fn(() => ({
      backup: {},
      messages: {
        loadingByTopic: {}
      },
      settings: {
        s3: {}
      }
    }))
  },
  handleSaveData: mocks.handleSaveData
}))

vi.mock('@renderer/store/backup', () => ({
  setLocalBackupSyncState: vi.fn((payload) => payload),
  setS3SyncState: vi.fn((payload) => payload),
  setWebDAVSyncState: vi.fn((payload) => payload)
}))

vi.mock('@renderer/utils', () => ({
  uuid: vi.fn(() => 'notification-id')
}))

vi.mock('../NotificationService', () => ({
  NotificationService: {
    getInstance: vi.fn(() => ({
      send: vi.fn()
    }))
  }
}))

vi.mock('../StorageV2Service', () => ({
  importLegacyDexieToStorageV2: mocks.importLegacyDexieToStorageV2,
  suspendStorageV2RuntimeMirrorsUntilReload: mocks.suspendStorageV2RuntimeMirrorsUntilReload
}))

import { handleData, reset } from '../BackupService'

describe('BackupService legacy restore', () => {
  let originalApi: unknown
  let originalModal: unknown
  let originalToast: unknown

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.db.tables = []
    mocks.db.table.mockReset()
    localStorage.clear()
    originalApi = window.api
    originalModal = window.modal
    originalToast = window.toast
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        relaunchApp: vi.fn(),
        resetData: vi.fn().mockResolvedValue(undefined),
        storageV2: {
          setSetting: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
    Object.defineProperty(window, 'modal', {
      configurable: true,
      value: {
        confirm: vi.fn()
      }
    })
    Object.defineProperty(window, 'toast', {
      configurable: true,
      value: {
        error: vi.fn(),
        success: vi.fn()
      }
    })
    mocks.importLegacyDexieToStorageV2.mockResolvedValue({ dryRun: false })
  })

  afterEach(() => {
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
    Object.defineProperty(window, 'modal', {
      configurable: true,
      value: originalModal
    })
    Object.defineProperty(window, 'toast', {
      configurable: true,
      value: originalToast
    })
  })

  it('disables Storage v2 auto hydrate after restoring a legacy backup', async () => {
    await handleData({
      version: 2,
      localStorage: {
        'persist:cherry-studio': '{"settings":"{}"}'
      },
      indexedDB: {}
    })

    expect(localStorage.getItem('persist:cherry-studio')).toBe('{"settings":"{}"}')
    expect(window.api.storageV2.setSetting).toHaveBeenCalledWith(
      'storage_v2.runtime.auto_hydrate',
      expect.objectContaining({
        enabled: false,
        reason: 'legacy-backup-restore',
        updatedAt: expect.any(String)
      }),
      'storage-v2'
    )
    expect(mocks.importLegacyDexieToStorageV2).toHaveBeenCalledWith({
      includeReduxOnlyTopics: false,
      preferMessageAssistantId: true,
      pruneMissing: true
    })
    expect(window.toast.success).toHaveBeenCalledWith('message.restore.success')

    vi.advanceTimersByTime(1000)
    expect(window.api.relaunchApp).toHaveBeenCalledTimes(1)
  })

  it('continues legacy restore when the Storage v2 Dexie mirror fails', async () => {
    mocks.importLegacyDexieToStorageV2.mockRejectedValueOnce(new Error('storage unavailable'))

    await handleData({
      version: 2,
      localStorage: {
        'persist:cherry-studio': '{"settings":"{}"}'
      },
      indexedDB: {}
    })

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Failed to mirror restored legacy IndexedDB to Storage v2',
      expect.any(Error)
    )
    expect(window.api.storageV2.setSetting).toHaveBeenCalledWith(
      'storage_v2.runtime.auto_hydrate',
      expect.objectContaining({
        enabled: false,
        reason: 'legacy-backup-restore'
      }),
      'storage-v2'
    )
    expect(window.toast.success).toHaveBeenCalledWith('message.restore.success')
  })

  it('clears all current IndexedDB tables before restoring backup tables', async () => {
    const topicsTable = {
      clear: vi.fn().mockResolvedValue(undefined),
      bulkAdd: vi.fn().mockResolvedValue(undefined)
    }
    const messageBlocksTable = {
      clear: vi.fn().mockResolvedValue(undefined),
      bulkAdd: vi.fn().mockResolvedValue(undefined)
    }
    mocks.db.tables = [{ name: 'topics' }, { name: 'message_blocks' }]
    mocks.db.table.mockImplementation((tableName: string) => {
      if (tableName === 'topics') return topicsTable
      if (tableName === 'message_blocks') return messageBlocksTable
      throw new Error(`Unexpected table ${tableName}`)
    })

    await handleData({
      version: 2,
      localStorage: {
        'persist:cherry-studio': '{"settings":"{}"}'
      },
      indexedDB: {
        topics: [{ id: 'topic-1', messages: [] }]
      }
    })

    expect(topicsTable.clear).toHaveBeenCalledTimes(1)
    expect(messageBlocksTable.clear).toHaveBeenCalledTimes(1)
    expect(topicsTable.bulkAdd).toHaveBeenCalledWith([{ id: 'topic-1', messages: [] }])
    expect(messageBlocksTable.bulkAdd).not.toHaveBeenCalled()
  })

  it('stages factory reset before clearing renderer storage and suspends mirrors until relaunch', async () => {
    const localStorageClear = vi.spyOn(Storage.prototype, 'clear')
    const tableClear = vi.fn().mockResolvedValue(undefined)
    mocks.db.tables = [{ name: 'topics' }, { name: 'settings' }]
    ;(mocks.db as any).topics = { clear: tableClear }
    ;(mocks.db as any).settings = { clear: tableClear }

    reset()

    const confirmCalls = vi.mocked(window.modal.confirm).mock.calls
    expect(confirmCalls).toHaveLength(1)
    await confirmCalls[0][0].onOk?.()
    expect(confirmCalls).toHaveLength(2)
    await confirmCalls[1][0].onOk?.()

    expect(vi.mocked(window.api.resetData).mock.invocationCallOrder[0]).toBeLessThan(
      localStorageClear.mock.invocationCallOrder[0]
    )
    expect(mocks.suspendStorageV2RuntimeMirrorsUntilReload.mock.invocationCallOrder[0]).toBeLessThan(
      localStorageClear.mock.invocationCallOrder[0]
    )
    expect(tableClear).toHaveBeenCalledTimes(2)
    expect(window.toast.success).toHaveBeenCalledWith('message.reset.success')

    vi.advanceTimersByTime(1000)
    expect(window.api.relaunchApp).toHaveBeenCalledTimes(1)
  })

  it('does not clear renderer storage when factory reset staging fails', async () => {
    vi.mocked(window.api.resetData).mockRejectedValueOnce(new Error('stage failed'))
    const localStorageClear = vi.spyOn(Storage.prototype, 'clear')
    const tableClear = vi.fn().mockResolvedValue(undefined)
    mocks.db.tables = [{ name: 'topics' }]
    ;(mocks.db as any).topics = { clear: tableClear }

    reset()

    const confirmCalls = vi.mocked(window.modal.confirm).mock.calls
    await confirmCalls[0][0].onOk?.()
    await confirmCalls[1][0].onOk?.()

    expect(localStorageClear).not.toHaveBeenCalled()
    expect(tableClear).not.toHaveBeenCalled()
    expect(mocks.suspendStorageV2RuntimeMirrorsUntilReload).not.toHaveBeenCalled()
    expect(window.toast.error).toHaveBeenCalledWith('notes.settings.data.reset_failed')
  })
})
