import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('StorageV2ReduxSliceService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('imports a single Redux slice through the Storage v2 snapshot importer', async () => {
    const importLegacyReduxSnapshot = vi.fn().mockResolvedValue({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })

    const { persistStorageV2ReduxSlice } = await import('../StorageV2ReduxSliceService')
    const mcpState = { servers: [{ id: 'server-1' }], isUvInstalled: true }

    await persistStorageV2ReduxSlice('mcp', mcpState)

    expect(importLegacyReduxSnapshot).toHaveBeenCalledWith(
      {
        redux: {
          mcp: mcpState
        }
      },
      { dryRun: false, pruneMissing: true }
    )
  })

  it('rejects when the Storage v2 Redux slice importer is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { persistStorageV2ReduxSlice } = await import('../StorageV2ReduxSliceService')

    await expect(persistStorageV2ReduxSlice('mcp', { servers: [] })).rejects.toThrow(
      'Storage v2 Redux slice import API unavailable'
    )
  })
})
