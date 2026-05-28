import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settingsAnyOf: vi.fn(),
  settingsHook: vi.fn(),
  settingsWhere: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    settings: {
      hook: mocks.settingsHook,
      where: mocks.settingsWhere
    }
  }
}))

describe('StorageV2DexieSettingsMirrorService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api

    mocks.settingsAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          id: 'language',
          value: 'zh-CN'
        }
      ])
    })
    mocks.settingsWhere.mockReturnValue({
      anyOf: mocks.settingsAnyOf
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('mirrors Dexie settings and delete markers into Storage v2 settings', async () => {
    const setSetting = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          setSetting
        }
      }
    })

    const { storageV2DexieSettingsMirrorService } = await import('../StorageV2DexieSettingsMirrorService')

    storageV2DexieSettingsMirrorService.scheduleSetting('language', 1000)
    storageV2DexieSettingsMirrorService.scheduleDelete('image://avatar', 1000)
    await storageV2DexieSettingsMirrorService.flush()

    expect(setSetting).toHaveBeenCalledWith('dexie.settings.language', 'zh-CN', 'dexie-settings')
    expect(setSetting).toHaveBeenCalledWith('dexie.settings.image://avatar', null, 'dexie-settings')
  })

  it('delays retry after a transient Storage v2 settings mirror failure', async () => {
    const setSetting = vi.fn().mockRejectedValueOnce(new Error('storage busy')).mockResolvedValueOnce(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          setSetting
        }
      }
    })

    const { storageV2DexieSettingsMirrorService } = await import('../StorageV2DexieSettingsMirrorService')

    storageV2DexieSettingsMirrorService.scheduleSetting('language', 1000)
    await storageV2DexieSettingsMirrorService.flush()

    expect(setSetting).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4999)
    expect(setSetting).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(setSetting).toHaveBeenCalledTimes(2)
  })

  it('rejects strict flushes when a settings mirror write is still pending after failure', async () => {
    const setSetting = vi.fn().mockRejectedValue(new Error('storage busy'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          setSetting
        }
      }
    })

    const { storageV2DexieSettingsMirrorService } = await import('../StorageV2DexieSettingsMirrorService')

    storageV2DexieSettingsMirrorService.scheduleSetting('language', 1000)

    await expect(storageV2DexieSettingsMirrorService.flushStrict()).rejects.toThrow('storage busy')
    expect(setSetting).toHaveBeenCalledTimes(1)
  })
})
