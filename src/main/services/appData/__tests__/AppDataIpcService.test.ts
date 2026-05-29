import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: any[]) => unknown

const mocks = vi.hoisted(() => ({
  db: {
    getRecordEntry: vi.fn(),
    setRecord: vi.fn(),
    deleteRecord: vi.fn(),
    getCacheEntry: vi.fn(),
    setCache: vi.fn(),
    deleteCache: vi.fn(),
    listRecords: vi.fn(),
    listWorkbenchShortcuts: vi.fn(),
    upsertWorkbenchShortcut: vi.fn(),
    installHtmlArtifact: vi.fn(),
    prepareHtmlArtifactShortcut: vi.fn(),
    hasWorkbenchShortcutRows: vi.fn()
  },
  handlers: new Map<string, IpcHandler>(),
  recovery: {
    projectIfAppRecordMissing: vi.fn(),
    projectIfLegacyAppRecordListEmpty: vi.fn(),
    projectIfLegacyWorkbenchShortcutListEmpty: vi.fn()
  },
  storageV2: {
    getRecord: vi.fn(),
    getRecordEntry: vi.fn(),
    listRecords: vi.fn(),
    upsertRecord: vi.fn(),
    deleteRecord: vi.fn(),
    getCache: vi.fn(),
    upsertCache: vi.fn(),
    deleteCache: vi.fn(),
    listWorkbenchShortcuts: vi.fn(),
    upsertWorkbenchShortcut: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('../AppDataDatabase', () => ({
  createWorkbenchShortcutRecord: vi.fn((shortcut: any, updatedAt: number) => ({
    id: shortcut.id || 'shortcut-generated',
    name: shortcut.name,
    url: shortcut.url,
    sourcePath: shortcut.sourcePath ?? null,
    kind: shortcut.kind || 'url',
    metadata: shortcut.metadata ?? null,
    createdAt: shortcut.createdAt || updatedAt,
    updatedAt: shortcut.updatedAt || updatedAt,
    deletedAt: null
  })),
  getAppDataDatabase: vi.fn(async () => mocks.db)
}))

vi.mock('@main/services/storageV2/AppDataKvMirrorService', () => ({
  storageV2AppDataKvMirrorService: mocks.storageV2
}))

vi.mock('@main/services/storageV2/AppDataRuntimeRecoveryService', () => ({
  storageV2AppDataRuntimeRecoveryService: mocks.recovery
}))

import { registerAppDataIpcHandlers } from '../AppDataIpcService'

function getHandler(channel: IpcChannel) {
  const handler = mocks.handlers.get(channel)
  expect(handler).toBeDefined()
  return handler!
}

describe('AppDataIpcService', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    mocks.db.setRecord.mockImplementation(async (scope: string, key: string, value: unknown, updatedAt: number) => ({
      scope,
      key,
      value,
      valueHash: 'hash',
      updatedAt,
      deletedAt: null,
      deviceId: 'device',
      version: 1
    }))
    mocks.db.deleteRecord.mockResolvedValue(undefined)
    mocks.db.setCache.mockResolvedValue(undefined)
    mocks.db.deleteCache.mockResolvedValue(undefined)
    mocks.db.upsertWorkbenchShortcut.mockImplementation(async (shortcut: any) => shortcut)
    mocks.db.prepareHtmlArtifactShortcut.mockImplementation(async (_input: any, updatedAt: number) => ({
      id: 'html-shortcut',
      name: 'Artifact',
      url: 'file:///tmp/artifact.html',
      sourcePath: '/tmp/artifact.html',
      kind: 'html',
      metadata: { installedFrom: 'agent-html-artifact' },
      createdAt: updatedAt,
      updatedAt,
      deletedAt: null,
      filePath: '/tmp/artifact.html'
    }))
    mocks.storageV2.upsertRecord.mockResolvedValue(undefined)
    mocks.storageV2.deleteRecord.mockResolvedValue(undefined)
    mocks.storageV2.upsertCache.mockResolvedValue(undefined)
    mocks.storageV2.deleteCache.mockResolvedValue(undefined)
    mocks.storageV2.upsertWorkbenchShortcut.mockResolvedValue(undefined)
    mocks.storageV2.getRecordEntry.mockResolvedValue({ found: false, value: null, deletedAt: null })
    mocks.storageV2.listRecords.mockResolvedValue([])
    mocks.recovery.projectIfAppRecordMissing.mockResolvedValue(false)
    mocks.recovery.projectIfLegacyAppRecordListEmpty.mockResolvedValue(false)
    mocks.recovery.projectIfLegacyWorkbenchShortcutListEmpty.mockResolvedValue(false)
    registerAppDataIpcHandlers()
  })

  it('does not read through Storage v2 when legacy app data contains null or a tombstone', async () => {
    mocks.db.getRecordEntry.mockResolvedValueOnce({ found: true, value: null, deletedAt: null })
    mocks.storageV2.getRecordEntry.mockResolvedValue({ found: true, value: { stale: true }, deletedAt: null })

    await expect(getHandler(IpcChannel.AppData_Get)(null, 'settings', 'optional')).resolves.toBeNull()
    expect(mocks.storageV2.getRecordEntry).not.toHaveBeenCalled()

    mocks.db.getRecordEntry.mockResolvedValueOnce({ found: true, value: null, deletedAt: 1760000000000 })

    await expect(getHandler(IpcChannel.AppData_Get)(null, 'settings', 'deleted')).resolves.toBeNull()
    expect(mocks.storageV2.getRecordEntry).not.toHaveBeenCalled()
  })

  it('reads app data from Storage v2 only when the legacy row is missing', async () => {
    mocks.db.getRecordEntry.mockResolvedValue({ found: false, value: null, deletedAt: null })
    mocks.storageV2.getRecordEntry.mockResolvedValue({ found: true, value: { restored: true }, deletedAt: null })

    await expect(getHandler(IpcChannel.AppData_Get)(null, 'settings', 'missing')).resolves.toEqual({ restored: true })
    expect(mocks.storageV2.getRecordEntry).toHaveBeenCalledWith('settings', 'missing')
  })

  it('preserves null and tombstone app records from Storage v2 read-through', async () => {
    mocks.db.getRecordEntry.mockResolvedValue({ found: false, value: null, deletedAt: null })
    mocks.storageV2.getRecordEntry.mockResolvedValueOnce({ found: true, value: null, deletedAt: null })

    await expect(getHandler(IpcChannel.AppData_Get)(null, 'settings', 'optional')).resolves.toBeNull()
    expect(mocks.recovery.projectIfAppRecordMissing).not.toHaveBeenCalled()

    mocks.storageV2.getRecordEntry.mockResolvedValueOnce({
      found: true,
      value: null,
      deletedAt: '2026-01-01T00:00:00.000Z'
    })

    await expect(getHandler(IpcChannel.AppData_Get)(null, 'settings', 'deleted')).resolves.toBeNull()
    expect(mocks.recovery.projectIfAppRecordMissing).not.toHaveBeenCalled()
  })

  it('projects legacy app records from Storage v2 before returning a missing app data key', async () => {
    mocks.db.getRecordEntry
      .mockResolvedValueOnce({ found: false, value: null, deletedAt: null })
      .mockResolvedValueOnce({ found: true, value: { restored: true }, deletedAt: null })
    mocks.storageV2.getRecordEntry.mockResolvedValue({ found: false, value: null, deletedAt: null })
    mocks.recovery.projectIfAppRecordMissing.mockResolvedValueOnce(true)

    await expect(getHandler(IpcChannel.AppData_Get)(null, 'agent-tools', 'github')).resolves.toEqual({
      restored: true
    })
    expect(mocks.recovery.projectIfAppRecordMissing).toHaveBeenCalledWith(
      'agent-tools',
      'github',
      'app-data-get-missing'
    )
    expect(mocks.db.getRecordEntry).toHaveBeenCalledTimes(2)
  })

  it('writes app records to Storage v2 before updating the legacy app database', async () => {
    const events: string[] = []
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000000)
    mocks.storageV2.upsertRecord.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.setRecord.mockImplementation(async (scope: string, key: string, value: unknown, updatedAt: number) => {
      events.push('legacy')
      return {
        scope,
        key,
        value,
        valueHash: 'hash',
        updatedAt,
        deletedAt: null,
        deviceId: 'device',
        version: 1
      }
    })

    try {
      await expect(getHandler(IpcChannel.AppData_Set)(null, 'settings', 'theme', { mode: 'dark' })).resolves.toEqual(
        expect.objectContaining({ updatedAt: 1760000000000 })
      )
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.storageV2.upsertRecord).toHaveBeenCalledWith('settings', 'theme', { mode: 'dark' }, 1760000000000)
    expect(mocks.db.setRecord).toHaveBeenCalledWith('settings', 'theme', { mode: 'dark' }, 1760000000000, undefined, {
      storageV2Mirrored: true
    })
  })

  it('writes app record tombstones to Storage v2 before updating the legacy app database', async () => {
    const events: string[] = []
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000001)
    mocks.storageV2.deleteRecord.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.deleteRecord.mockImplementation(async () => {
      events.push('legacy')
    })

    try {
      await getHandler(IpcChannel.AppData_Delete)(null, 'settings', 'theme')
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.storageV2.deleteRecord).toHaveBeenCalledWith('settings', 'theme', 1760000000001)
    expect(mocks.db.deleteRecord).toHaveBeenCalledWith('settings', 'theme', 1760000000001, {
      storageV2Mirrored: true
    })
  })

  it('projects Storage v2 app records before returning an empty legacy list', async () => {
    const restoredRecord = {
      scope: 'agent-tools',
      key: 'github',
      value: { restored: true },
      valueHash: 'hash',
      updatedAt: 1760000000000,
      deviceId: 'device',
      version: 1
    }
    mocks.db.listRecords.mockResolvedValueOnce([]).mockResolvedValueOnce([restoredRecord])
    mocks.recovery.projectIfLegacyAppRecordListEmpty.mockResolvedValueOnce(true)

    await expect(getHandler(IpcChannel.AppData_List)(null, 'agent-tools', true)).resolves.toEqual([restoredRecord])
    expect(mocks.recovery.projectIfLegacyAppRecordListEmpty).toHaveBeenCalledWith('agent-tools', 'app-data-list-empty')
    expect(mocks.db.listRecords).toHaveBeenCalledTimes(2)
  })

  it('falls back to direct Storage v2 app record lists when runtime projection is unavailable', async () => {
    const restoredRecord = {
      scope: 'agent-tools',
      key: 'github',
      value: { restored: true },
      valueHash: 'hash',
      updatedAt: 1760000000000,
      deviceId: 'device',
      version: 1
    }
    mocks.db.listRecords.mockResolvedValueOnce([])
    mocks.recovery.projectIfLegacyAppRecordListEmpty.mockResolvedValueOnce(false)
    mocks.storageV2.listRecords.mockResolvedValueOnce([restoredRecord])

    await expect(getHandler(IpcChannel.AppData_List)(null, 'agent-tools', true)).resolves.toEqual([restoredRecord])
    expect(mocks.storageV2.listRecords).toHaveBeenCalledWith('agent-tools', true)
  })

  it('merges Storage v2 app records into non-empty legacy app record lists', async () => {
    const legacyRecord = {
      scope: 'settings',
      key: 'theme',
      value: { mode: 'dark' },
      valueHash: 'legacy-theme',
      updatedAt: 1760000000000,
      deletedAt: null,
      deviceId: 'device',
      version: 1
    }
    const storageOnlyRecord = {
      scope: 'settings',
      key: 'agent-tools',
      value: { github: true },
      valueHash: 'storage-agent-tools',
      updatedAt: 1760000001000,
      deletedAt: null,
      deviceId: 'device',
      version: 1
    }

    mocks.db.listRecords.mockResolvedValueOnce([legacyRecord]).mockResolvedValueOnce([legacyRecord])
    mocks.storageV2.listRecords.mockResolvedValueOnce([storageOnlyRecord])

    await expect(getHandler(IpcChannel.AppData_List)(null, 'settings', false)).resolves.toEqual(
      expect.arrayContaining([legacyRecord, storageOnlyRecord])
    )
    expect(mocks.storageV2.listRecords).toHaveBeenCalledWith('settings', true)
    expect(mocks.recovery.projectIfLegacyAppRecordListEmpty).not.toHaveBeenCalled()
  })

  it('does not resurrect legacy app records deleted by a newer Storage v2 tombstone', async () => {
    const legacyRecord = {
      scope: 'settings',
      key: 'theme',
      value: { mode: 'dark' },
      valueHash: 'legacy-theme',
      updatedAt: 1760000000000,
      deletedAt: null,
      deviceId: 'device',
      version: 1
    }
    const storageTombstone = {
      ...legacyRecord,
      value: null,
      valueHash: 'storage-theme-tombstone',
      updatedAt: 1760000001000,
      deletedAt: 1760000001000,
      version: 2
    }

    mocks.db.listRecords.mockResolvedValueOnce([legacyRecord]).mockResolvedValueOnce([legacyRecord])
    mocks.storageV2.listRecords.mockResolvedValueOnce([storageTombstone])

    await expect(getHandler(IpcChannel.AppData_List)(null, 'settings', false)).resolves.toEqual([])
  })

  it('keeps legacy app record tombstones from falling back to older Storage v2 records', async () => {
    const legacyTombstone = {
      scope: 'settings',
      key: 'theme',
      value: null,
      valueHash: 'legacy-theme-tombstone',
      updatedAt: 1760000001000,
      deletedAt: 1760000001000,
      deviceId: 'device',
      version: 2
    }
    const staleStorageRecord = {
      ...legacyTombstone,
      value: { mode: 'dark' },
      valueHash: 'storage-theme',
      updatedAt: 1760000000000,
      deletedAt: null,
      version: 1
    }

    mocks.db.listRecords.mockResolvedValueOnce([]).mockResolvedValueOnce([legacyTombstone])
    mocks.storageV2.listRecords.mockResolvedValueOnce([staleStorageRecord])

    await expect(getHandler(IpcChannel.AppData_List)(null, 'settings', false)).resolves.toEqual([])
    expect(mocks.recovery.projectIfLegacyAppRecordListEmpty).not.toHaveBeenCalled()
  })

  it('preserves null cache entries instead of falling back to stale Storage v2 cache', async () => {
    mocks.db.getCacheEntry.mockResolvedValueOnce({ found: true, value: null, expiresAt: null })
    mocks.storageV2.getCache.mockResolvedValue({ stale: true })

    await expect(getHandler(IpcChannel.AppCache_Get)(null, 'namespace', 'optional')).resolves.toBeNull()
    expect(mocks.storageV2.getCache).not.toHaveBeenCalled()

    mocks.db.getCacheEntry.mockResolvedValueOnce({ found: false, value: null, expiresAt: null })
    mocks.storageV2.getCache.mockResolvedValueOnce({ restored: true })

    await expect(getHandler(IpcChannel.AppCache_Get)(null, 'namespace', 'missing')).resolves.toEqual({ restored: true })
    expect(mocks.storageV2.getCache).toHaveBeenCalledWith('namespace', 'missing')
  })

  it('writes cache entries to Storage v2 before updating the legacy app cache', async () => {
    const events: string[] = []
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000100)
    mocks.storageV2.upsertCache.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.setCache.mockImplementation(async () => {
      events.push('legacy')
    })

    try {
      await getHandler(IpcChannel.AppCache_Set)(null, 'minapp', 'tab-1', { active: true }, 60_000)
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.storageV2.upsertCache).toHaveBeenCalledWith('minapp', 'tab-1', { active: true }, 60_000, 1760000000100)
    expect(mocks.db.setCache).toHaveBeenCalledWith('minapp', 'tab-1', { active: true }, 60_000, 1760000000100, {
      storageV2Mirrored: true
    })
  })

  it('writes cache tombstones to Storage v2 before deleting the legacy app cache row', async () => {
    const events: string[] = []
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000101)
    mocks.storageV2.deleteCache.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.deleteCache.mockImplementation(async () => {
      events.push('legacy')
    })

    try {
      await getHandler(IpcChannel.AppCache_Delete)(null, 'minapp', 'tab-1')
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.storageV2.deleteCache).toHaveBeenCalledWith('minapp', 'tab-1', 1760000000101)
    expect(mocks.db.deleteCache).toHaveBeenCalledWith('minapp', 'tab-1', { storageV2Mirrored: true })
  })

  it('does not resurrect deleted workbench shortcuts from Storage v2', async () => {
    const legacyTombstone = {
      id: 'stale',
      name: 'Deleted Shortcut',
      url: 'https://example.com',
      kind: 'url',
      metadata: null,
      createdAt: 1760000000000,
      updatedAt: 1760000001000,
      deletedAt: 1760000001000
    }
    const staleStorageShortcut = {
      ...legacyTombstone,
      updatedAt: 1760000000000,
      deletedAt: null
    }

    mocks.db.listWorkbenchShortcuts.mockResolvedValueOnce([]).mockResolvedValueOnce([legacyTombstone])
    mocks.db.hasWorkbenchShortcutRows.mockResolvedValueOnce(true)
    mocks.storageV2.listWorkbenchShortcuts.mockResolvedValueOnce([staleStorageShortcut])

    await expect(getHandler(IpcChannel.WorkbenchShortcut_List)(null)).resolves.toEqual([])
    expect(mocks.storageV2.listWorkbenchShortcuts).toHaveBeenCalledWith(true)
    expect(mocks.recovery.projectIfLegacyWorkbenchShortcutListEmpty).not.toHaveBeenCalled()
  })

  it('merges Storage v2 workbench shortcuts into non-empty legacy shortcut lists', async () => {
    const legacyShortcut = {
      id: 'legacy-shortcut',
      name: 'Legacy',
      url: 'https://legacy.example.com',
      kind: 'url',
      metadata: null,
      createdAt: 1760000000000,
      updatedAt: 1760000000000,
      deletedAt: null
    }
    const storageShortcut = {
      id: 'storage-shortcut',
      name: 'Storage',
      url: 'https://storage.example.com',
      kind: 'url',
      metadata: null,
      createdAt: 1760000001000,
      updatedAt: 1760000001000,
      deletedAt: null
    }

    mocks.db.listWorkbenchShortcuts.mockResolvedValueOnce([legacyShortcut]).mockResolvedValueOnce([legacyShortcut])
    mocks.storageV2.listWorkbenchShortcuts.mockResolvedValueOnce([storageShortcut])

    await expect(getHandler(IpcChannel.WorkbenchShortcut_List)(null)).resolves.toEqual(
      expect.arrayContaining([legacyShortcut, storageShortcut])
    )
    expect(mocks.storageV2.listWorkbenchShortcuts).toHaveBeenCalledWith(true)
  })

  it('does not resurrect legacy workbench shortcuts deleted by a newer Storage v2 tombstone', async () => {
    const legacyShortcut = {
      id: 'legacy-shortcut',
      name: 'Legacy',
      url: 'https://legacy.example.com',
      kind: 'url',
      metadata: null,
      createdAt: 1760000000000,
      updatedAt: 1760000000000,
      deletedAt: null
    }
    const storageTombstone = {
      ...legacyShortcut,
      updatedAt: 1760000001000,
      deletedAt: 1760000001000
    }

    mocks.db.listWorkbenchShortcuts.mockResolvedValueOnce([legacyShortcut]).mockResolvedValueOnce([legacyShortcut])
    mocks.storageV2.listWorkbenchShortcuts.mockResolvedValueOnce([storageTombstone])

    await expect(getHandler(IpcChannel.WorkbenchShortcut_List)(null)).resolves.toEqual([])
  })

  it('projects Storage v2 workbench shortcuts before returning an empty legacy list', async () => {
    mocks.db.listWorkbenchShortcuts.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'restored' }])
    mocks.db.hasWorkbenchShortcutRows.mockResolvedValueOnce(false)
    mocks.recovery.projectIfLegacyWorkbenchShortcutListEmpty.mockResolvedValueOnce(true)

    await expect(getHandler(IpcChannel.WorkbenchShortcut_List)(null)).resolves.toEqual([{ id: 'restored' }])
    expect(mocks.recovery.projectIfLegacyWorkbenchShortcutListEmpty).toHaveBeenCalledWith('workbench-list-empty')
    expect(mocks.db.listWorkbenchShortcuts).toHaveBeenCalledTimes(2)
    expect(mocks.storageV2.listWorkbenchShortcuts).not.toHaveBeenCalled()
  })

  it('falls back to direct Storage v2 workbench shortcut reads when runtime projection is unavailable', async () => {
    mocks.db.listWorkbenchShortcuts.mockResolvedValueOnce([])
    mocks.db.hasWorkbenchShortcutRows.mockResolvedValueOnce(false)
    mocks.recovery.projectIfLegacyWorkbenchShortcutListEmpty.mockResolvedValueOnce(false)

    mocks.storageV2.listWorkbenchShortcuts.mockResolvedValueOnce([{ id: 'restored' }])

    await expect(getHandler(IpcChannel.WorkbenchShortcut_List)(null)).resolves.toEqual([{ id: 'restored' }])
    expect(mocks.storageV2.listWorkbenchShortcuts).toHaveBeenCalledTimes(1)
  })

  it('writes workbench shortcuts to Storage v2 before updating the legacy app database', async () => {
    const events: string[] = []
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000200)
    mocks.storageV2.upsertWorkbenchShortcut.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.upsertWorkbenchShortcut.mockImplementation(async (shortcut: any) => {
      events.push('legacy')
      return shortcut
    })

    try {
      await expect(
        getHandler(IpcChannel.WorkbenchShortcut_Upsert)(null, { name: 'Docs', url: 'https://example.com' })
      ).resolves.toEqual(expect.objectContaining({ id: 'shortcut-generated', updatedAt: 1760000000200 }))
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.storageV2.upsertWorkbenchShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shortcut-generated', name: 'Docs', updatedAt: 1760000000200 })
    )
    expect(mocks.db.upsertWorkbenchShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shortcut-generated', name: 'Docs', updatedAt: 1760000000200 }),
      { storageV2Mirrored: true }
    )
  })

  it('writes installed HTML shortcuts to Storage v2 before updating the legacy app database', async () => {
    const events: string[] = []
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000201)
    mocks.storageV2.upsertWorkbenchShortcut.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.upsertWorkbenchShortcut.mockImplementation(async (shortcut: any) => {
      events.push('legacy')
      return shortcut
    })

    try {
      await expect(
        getHandler(IpcChannel.WorkbenchShortcut_InstallHtml)(null, { title: 'Artifact', html: '<main />' })
      ).resolves.toEqual(expect.objectContaining({ id: 'html-shortcut', filePath: '/tmp/artifact.html' }))
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.db.prepareHtmlArtifactShortcut).toHaveBeenCalledWith(
      { title: 'Artifact', html: '<main />' },
      1760000000201
    )
    expect(mocks.storageV2.upsertWorkbenchShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'html-shortcut', filePath: '/tmp/artifact.html' })
    )
    expect(mocks.db.upsertWorkbenchShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'html-shortcut', filePath: '/tmp/artifact.html' }),
      { storageV2Mirrored: true }
    )
  })
})
