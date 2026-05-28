import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  client: {
    close: vi.fn(),
    execute: vi.fn(),
    executeMultiple: vi.fn()
  },
  storageV2: {
    getSyncState: vi.fn(),
    upsertSyncState: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn() })
  }
}))

vi.mock('@libsql/client', () => ({
  createClient: vi.fn(() => mocks.client)
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/cherry-studio-pi-test')
  }
}))

vi.mock('@main/services/storageV2/AppDataKvMirrorService', () => ({
  storageV2AppDataKvMirrorService: mocks.storageV2
}))

import { AppDataDatabase } from '../AppDataDatabase'

describe('AppDataDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.client.executeMultiple.mockResolvedValue(undefined)
    mocks.client.execute.mockResolvedValue({ rows: [], columns: [], columnTypes: [] })
    mocks.storageV2.getSyncState.mockResolvedValue(null)
    mocks.storageV2.upsertSyncState.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await AppDataDatabase.close()
  })

  it('restores the app sync device id from Storage v2 when legacy app.db is missing it', async () => {
    mocks.storageV2.getSyncState.mockResolvedValueOnce('storage-device')

    const db = await AppDataDatabase.getInstance()

    expect(db.getDeviceId()).toBe('storage-device')
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO sync_state'),
        args: ['device-id', JSON.stringify('storage-device'), expect.any(Number)]
      })
    )
    expect(mocks.storageV2.upsertSyncState).not.toHaveBeenCalled()
  })

  it('mirrors a generated app sync device id into Storage v2', async () => {
    const db = await AppDataDatabase.getInstance()

    expect(db.getDeviceId()).toEqual(expect.any(String))
    expect(mocks.storageV2.upsertSyncState).toHaveBeenCalledWith('device-id', db.getDeviceId())
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO sync_state'),
        args: ['device-id', JSON.stringify(db.getDeviceId()), expect.any(Number)]
      })
    )
  })

  it('repairs the Storage v2 app sync device id from an existing legacy value', async () => {
    mocks.client.execute.mockImplementation(async (input: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof input === 'string' ? input : input.sql
      if (sql.includes('SELECT value FROM sync_state')) {
        return { rows: [{ value: JSON.stringify('legacy-device') }], columns: [], columnTypes: [] }
      }
      return { rows: [], columns: [], columnTypes: [] }
    })

    const db = await AppDataDatabase.getInstance()

    expect(db.getDeviceId()).toBe('legacy-device')
    expect(mocks.storageV2.getSyncState).not.toHaveBeenCalled()
    expect(mocks.storageV2.upsertSyncState).toHaveBeenCalledWith('device-id', 'legacy-device')
  })
})
