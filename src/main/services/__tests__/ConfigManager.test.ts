import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeData: {} as Record<string, unknown>,
  settingsRepository: {
    list: vi.fn(),
    set: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ warn: vi.fn() })
  }
}))

vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en-US')
  }
}))

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get store() {
      return mocks.storeData
    },
    get: vi.fn((key: string, defaultValue?: unknown) =>
      Object.hasOwn(mocks.storeData, key) ? mocks.storeData[key] : defaultValue
    ),
    has: vi.fn((key: string) => Object.hasOwn(mocks.storeData, key)),
    set: vi.fn((key: string, value: unknown) => {
      mocks.storeData[key] = value
    }),
    delete: vi.fn((key: string) => {
      delete mocks.storeData[key]
    })
  }))
}))

vi.mock('../storageV2/StorageV2Repositories', () => ({
  storageV2SettingsRepository: mocks.settingsRepository
}))

import { ConfigManager } from '../ConfigManager'

describe('ConfigManager Storage v2 mirror', () => {
  beforeEach(() => {
    mocks.storeData = {}
    mocks.settingsRepository.list.mockReset()
    mocks.settingsRepository.set.mockReset()
    mocks.settingsRepository.set.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mirrors config set operations into Storage v2', async () => {
    const manager = new ConfigManager()

    manager.set('tray', false)

    await vi.waitFor(() => {
      expect(mocks.settingsRepository.set).toHaveBeenCalledWith('config.tray', false, 'config')
    })

    expect(mocks.storeData.tray).toBe(false)
  })

  it('retries failed config mirrors on a timer', async () => {
    vi.useFakeTimers()
    mocks.settingsRepository.set.mockRejectedValueOnce(new Error('storage locked')).mockResolvedValueOnce(undefined)
    const manager = new ConfigManager()

    manager.set('tray', false)

    await vi.waitFor(() => {
      expect(mocks.settingsRepository.set).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(5000)

    expect(mocks.settingsRepository.set).toHaveBeenCalledTimes(2)
  })

  it('rejects strict config flushes while mirror writes are still failing', async () => {
    vi.useFakeTimers()
    mocks.settingsRepository.set.mockRejectedValue(new Error('storage locked'))
    const manager = new ConfigManager()

    manager.set('tray', false)

    await expect(manager.flushPendingStorageV2ConfigStrict()).rejects.toThrow('storage locked')
    expect(mocks.settingsRepository.set).toHaveBeenCalledTimes(2)
  })

  it('hydrates missing electron-store settings from Storage v2 without overwriting local values by default', async () => {
    mocks.storeData.tray = true
    mocks.settingsRepository.list.mockResolvedValue([
      { key: 'config.tray', value: false },
      { key: 'config.launchToTray', value: true }
    ])
    const manager = new ConfigManager()

    await expect(manager.hydrateFromStorageV2()).resolves.toEqual({ restoredCount: 1, prunedCount: 0 })

    expect(mocks.storeData.tray).toBe(true)
    expect(mocks.storeData.launchToTray).toBe(true)
  })

  it('can overwrite electron-store settings during backup restore', async () => {
    mocks.storeData.tray = true
    mocks.settingsRepository.list.mockResolvedValue([{ key: 'config.tray', value: false }])
    const manager = new ConfigManager()

    await expect(manager.hydrateFromStorageV2({ overwrite: true })).resolves.toEqual({
      restoredCount: 1,
      prunedCount: 0
    })

    expect(mocks.storeData.tray).toBe(false)
  })

  it('can prune electron-store settings that are absent from Storage v2 during backup restore', async () => {
    mocks.storeData.tray = true
    mocks.storeData.launchToTray = true
    mocks.settingsRepository.list.mockResolvedValue([{ key: 'config.tray', value: false }])
    const manager = new ConfigManager()

    await expect(manager.hydrateFromStorageV2({ overwrite: true, pruneMissing: true })).resolves.toEqual({
      restoredCount: 1,
      prunedCount: 1
    })

    expect(mocks.storeData.tray).toBe(false)
    expect(mocks.storeData.launchToTray).toBeUndefined()
  })

  it('does not prune electron-store settings when an older backup has no config records', async () => {
    mocks.storeData.tray = true
    mocks.settingsRepository.list.mockResolvedValue([])
    const manager = new ConfigManager()

    await expect(manager.hydrateFromStorageV2({ overwrite: true, pruneMissing: true })).resolves.toEqual({
      restoredCount: 0,
      prunedCount: 0
    })

    expect(mocks.storeData.tray).toBe(true)
  })

  it('mirrors the current electron-store snapshot into Storage v2', async () => {
    mocks.storeData.tray = true
    mocks.storeData.testChannel = 'latest'
    const manager = new ConfigManager()

    await expect(manager.mirrorAllToStorageV2()).resolves.toEqual({ mirroredCount: 2 })

    expect(mocks.settingsRepository.set).toHaveBeenCalledWith('config.tray', true, 'config')
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith('config.testChannel', 'latest', 'config')
  })
})
