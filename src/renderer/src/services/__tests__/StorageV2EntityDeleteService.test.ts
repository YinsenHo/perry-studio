import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('StorageV2EntityDeleteService', () => {
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

  it('deletes provider metadata through the direct Storage v2 tombstone API', async () => {
    const deleteProvider = vi.fn().mockResolvedValue({ deleted: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          deleteProvider
        }
      }
    })

    const { deleteStorageV2Provider } = await import('../StorageV2EntityDeleteService')

    await expect(deleteStorageV2Provider('provider-1')).resolves.toEqual({ deleted: true })
    expect(deleteProvider).toHaveBeenCalledWith('provider-1')
  })

  it('rejects provider deletion when the Storage v2 tombstone API is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { deleteStorageV2Provider } = await import('../StorageV2EntityDeleteService')

    await expect(deleteStorageV2Provider('provider-1')).rejects.toThrow('Storage v2 provider delete API unavailable')
  })

  it('deletes assistant metadata through the direct Storage v2 tombstone API', async () => {
    const deleteAssistant = vi.fn().mockResolvedValue({ deleted: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          deleteAssistant
        }
      }
    })

    const { deleteStorageV2Assistant } = await import('../StorageV2EntityDeleteService')

    await expect(deleteStorageV2Assistant('assistant-1')).resolves.toEqual({ deleted: true })
    expect(deleteAssistant).toHaveBeenCalledWith('assistant-1')
  })

  it('rejects assistant deletion when the Storage v2 tombstone API is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { deleteStorageV2Assistant } = await import('../StorageV2EntityDeleteService')

    await expect(deleteStorageV2Assistant('assistant-1')).rejects.toThrow('Storage v2 assistant delete API unavailable')
  })
})
