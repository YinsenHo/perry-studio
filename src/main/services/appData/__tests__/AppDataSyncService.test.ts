import type { WebDavConfig } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    listRecords: vi.fn(),
    getSyncState: vi.fn(),
    setSyncState: vi.fn(),
    applyRemoteRecord: vi.fn(),
    createConflict: vi.fn(),
    getDeviceId: vi.fn(),
    listConflicts: vi.fn()
  },
  storageV2: {
    upsertRecordSnapshot: vi.fn(),
    upsertSyncState: vi.fn(),
    getSyncState: vi.fn(),
    upsertSyncConflict: vi.fn(),
    listSyncConflicts: vi.fn(),
    listRecords: vi.fn()
  },
  recovery: {
    projectIfLegacyAppRecordListEmpty: vi.fn()
  },
  webdav: {
    exists: vi.fn(),
    createDirectory: vi.fn(),
    getFileContents: vi.fn(),
    putFileContents: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('webdav', () => ({
  createClient: vi.fn(() => mocks.webdav)
}))

vi.mock('../AppDataDatabase', () => ({
  getAppDataDatabase: vi.fn(async () => mocks.db)
}))

vi.mock('@main/services/storageV2/AppDataKvMirrorService', () => ({
  storageV2AppDataKvMirrorService: mocks.storageV2
}))

vi.mock('@main/services/storageV2/AppDataRuntimeRecoveryService', () => ({
  storageV2AppDataRuntimeRecoveryService: mocks.recovery
}))

import { AppDataSyncService } from '../AppDataSyncService'

const config: WebDavConfig = {
  webdavHost: 'https://dav.example.com',
  webdavUser: 'user',
  webdavPass: 'pass',
  webdavPath: '/remote-root'
}

const remoteRecord = {
  scope: 'settings',
  key: 'theme',
  value: { mode: 'dark' },
  valueHash: 'remote-hash',
  updatedAt: 1760000000000,
  deletedAt: null,
  deviceId: 'remote-device',
  version: 3
}

const remoteManifest = {
  version: 1,
  updatedAt: 1760000000000,
  records: {
    'settings:theme': {
      scope: remoteRecord.scope,
      key: remoteRecord.key,
      valueHash: remoteRecord.valueHash,
      updatedAt: remoteRecord.updatedAt,
      deletedAt: remoteRecord.deletedAt,
      deviceId: remoteRecord.deviceId,
      version: remoteRecord.version,
      path: 'records/settings/theme.json'
    }
  }
}

describe('AppDataSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.db.listRecords.mockResolvedValue([])
    mocks.db.getSyncState.mockResolvedValue(null)
    mocks.db.setSyncState.mockResolvedValue(undefined)
    mocks.db.applyRemoteRecord.mockResolvedValue(undefined)
    mocks.db.createConflict.mockResolvedValue('settings:theme:1760000000000')
    mocks.db.getDeviceId.mockReturnValue('local-device')
    mocks.db.listConflicts.mockResolvedValue([])
    mocks.storageV2.upsertRecordSnapshot.mockResolvedValue(undefined)
    mocks.storageV2.upsertSyncState.mockResolvedValue(undefined)
    mocks.storageV2.getSyncState.mockResolvedValue(null)
    mocks.storageV2.upsertSyncConflict.mockResolvedValue(undefined)
    mocks.storageV2.listSyncConflicts.mockResolvedValue([])
    mocks.storageV2.listRecords.mockResolvedValue([])
    mocks.recovery.projectIfLegacyAppRecordListEmpty.mockResolvedValue(false)
    mocks.webdav.exists.mockResolvedValue(true)
    mocks.webdav.createDirectory.mockResolvedValue(undefined)
    mocks.webdav.putFileContents.mockResolvedValue(undefined)
    mocks.webdav.getFileContents.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('/manifest.json')) {
        return JSON.stringify(remoteManifest)
      }

      if (filePath.endsWith('/records/settings/theme.json')) {
        return JSON.stringify(remoteRecord)
      }

      throw new Error(`Unexpected WebDAV read: ${filePath}`)
    })
  })

  it('applies downloaded remote app records to Storage v2 before legacy app.db', async () => {
    const events: string[] = []
    mocks.storageV2.upsertRecordSnapshot.mockImplementation(async () => {
      events.push('storage-v2')
    })
    mocks.db.applyRemoteRecord.mockImplementation(async () => {
      events.push('legacy')
    })

    const summary = await new AppDataSyncService().syncNow(config)

    expect(summary.downloaded).toBe(1)
    expect(events).toEqual(['storage-v2', 'legacy'])
    expect(mocks.storageV2.upsertRecordSnapshot).toHaveBeenCalledWith(remoteRecord)
    expect(mocks.db.applyRemoteRecord).toHaveBeenCalledWith(remoteRecord)
  })

  it('does not write downloaded remote records to legacy app.db when Storage v2 rejects them', async () => {
    mocks.storageV2.upsertRecordSnapshot.mockRejectedValueOnce(new Error('storage-v2 failed'))

    await expect(new AppDataSyncService().syncNow(config)).rejects.toThrow('storage-v2 failed')
    expect(mocks.db.applyRemoteRecord).not.toHaveBeenCalled()
  })

  it('writes sync state to Storage v2 before legacy app.db state', async () => {
    const events: string[] = []
    mocks.storageV2.upsertSyncState.mockImplementation(async () => {
      events.push('storage-v2-sync-state')
    })
    mocks.db.setSyncState.mockImplementation(async () => {
      events.push('legacy-sync-state')
    })

    await new AppDataSyncService().syncNow(config)

    expect(events.slice(0, 2)).toEqual(['storage-v2-sync-state', 'legacy-sync-state'])
    expect(mocks.storageV2.upsertSyncState).toHaveBeenCalledWith('record:settings:theme:hash', 'remote-hash')
    expect(mocks.db.setSyncState).toHaveBeenCalledWith('record:settings:theme:hash', 'remote-hash')
  })

  it('writes sync conflicts to Storage v2 before legacy app.db conflicts', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1760000000999)
    const localRecord = {
      ...remoteRecord,
      value: { mode: 'light' },
      valueHash: 'local-hash',
      updatedAt: 1760000000001,
      deviceId: 'local-device'
    }
    const events: string[] = []
    mocks.db.listRecords.mockResolvedValue([localRecord])
    mocks.db.getSyncState.mockImplementation(async (id: string) =>
      id === 'record:settings:theme:hash' ? 'base-hash' : null
    )
    mocks.storageV2.upsertSyncConflict.mockImplementation(async () => {
      events.push('storage-v2-conflict')
    })
    mocks.db.createConflict.mockImplementation(async () => {
      events.push('legacy-conflict')
      return 'settings:theme:1760000000999'
    })

    try {
      const summary = await new AppDataSyncService().syncNow(config)

      expect(summary.conflicts).toBe(1)
    } finally {
      nowSpy.mockRestore()
    }

    expect(events).toEqual(['storage-v2-conflict', 'legacy-conflict'])
    expect(mocks.storageV2.upsertSyncConflict).toHaveBeenCalledWith(
      'settings:theme:1760000000999',
      expect.objectContaining({
        scope: 'settings',
        key: 'theme',
        localRecord,
        remoteRecord,
        baseHash: 'base-hash'
      })
    )
    expect(mocks.db.createConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'settings:theme:1760000000999',
        localRecord,
        remoteRecord,
        baseHash: 'base-hash'
      })
    )
  })

  it('falls back to Storage v2 sync state when legacy app.db is missing the last hash', async () => {
    const localRecord = {
      ...remoteRecord,
      value: { mode: 'light' },
      valueHash: 'local-hash',
      updatedAt: 1760000000001,
      deviceId: 'local-device'
    }
    mocks.db.listRecords.mockResolvedValue([localRecord])
    mocks.db.getSyncState.mockResolvedValue(null)
    mocks.storageV2.getSyncState.mockImplementation(async (id: string) =>
      id === 'record:settings:theme:hash' ? 'local-hash' : null
    )

    const summary = await new AppDataSyncService().syncNow(config)

    expect(summary.downloaded).toBe(1)
    expect(summary.conflicts).toBe(0)
    expect(mocks.storageV2.getSyncState).toHaveBeenCalledWith('record:settings:theme:hash')
    expect(mocks.storageV2.upsertRecordSnapshot).toHaveBeenCalledWith(remoteRecord)
    expect(mocks.db.createConflict).not.toHaveBeenCalled()
  })

  it('uploads Storage v2 app records when legacy runtime projection is unavailable', async () => {
    const localRecord = {
      ...remoteRecord,
      valueHash: 'local-hash',
      updatedAt: 1760000000001,
      deviceId: 'storage-v2-device'
    }
    mocks.webdav.getFileContents.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('/manifest.json')) {
        return JSON.stringify({ version: 1, updatedAt: 0, records: {} })
      }
      throw new Error(`Unexpected WebDAV read: ${filePath}`)
    })
    mocks.db.listRecords.mockResolvedValue([])
    mocks.recovery.projectIfLegacyAppRecordListEmpty.mockResolvedValueOnce(false)
    mocks.storageV2.listRecords.mockResolvedValueOnce([localRecord])

    const summary = await new AppDataSyncService().syncNow(config)

    expect(summary.uploaded).toBe(1)
    expect(mocks.storageV2.listRecords).toHaveBeenCalledWith(undefined, true)
    expect(mocks.webdav.putFileContents).toHaveBeenCalledWith(
      expect.stringContaining('/records/settings/theme.json'),
      expect.stringContaining('"local-hash"'),
      { overwrite: true }
    )
  })

  it('reads sync status summary from Storage v2 when the legacy app database is missing it', async () => {
    const storageSummary = {
      uploaded: 1,
      downloaded: 2,
      deleted: 0,
      conflicts: 0,
      skipped: 3,
      lastSyncAt: 1760000000300
    }
    mocks.db.getSyncState.mockResolvedValue(null)
    mocks.storageV2.getSyncState.mockImplementation(async (id: string) =>
      id === 'last-sync-summary' ? storageSummary : null
    )

    await expect(new AppDataSyncService().getStatus()).resolves.toEqual({
      deviceId: 'local-device',
      lastSummary: storageSummary,
      conflicts: []
    })
    expect(mocks.storageV2.getSyncState).toHaveBeenCalledWith('last-sync-summary')
  })

  it('uses the Storage v2 app sync device id when legacy app.db is missing the original one', async () => {
    mocks.storageV2.getSyncState.mockImplementation(async (id: string) =>
      id === 'device-id' ? 'storage-device' : null
    )

    await expect(new AppDataSyncService().getStatus()).resolves.toEqual({
      deviceId: 'storage-device',
      lastSummary: expect.any(Object),
      conflicts: []
    })
    expect(mocks.storageV2.getSyncState).toHaveBeenCalledWith('device-id')
  })

  it('reads unresolved sync conflicts from Storage v2 when legacy app.db has none', async () => {
    const storageConflict = {
      id: 'settings:theme:1760000000999',
      scope: 'settings',
      key: 'theme',
      local_value: { mode: 'light' },
      remote_value: { mode: 'dark' },
      base_hash: 'base-hash',
      local_hash: 'local-hash',
      remote_hash: 'remote-hash',
      created_at: 1760000000999,
      resolved_at: null
    }
    mocks.db.listConflicts.mockResolvedValueOnce([])
    mocks.storageV2.listSyncConflicts.mockResolvedValueOnce([storageConflict])

    await expect(new AppDataSyncService().getStatus()).resolves.toEqual({
      deviceId: 'local-device',
      lastSummary: expect.any(Object),
      conflicts: [storageConflict]
    })
    expect(mocks.storageV2.listSyncConflicts).toHaveBeenCalledWith(true)
  })
})
