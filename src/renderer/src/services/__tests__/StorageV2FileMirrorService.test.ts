import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filesAnyOf: vi.fn(),
  filesWhere: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    files: {
      where: mocks.filesWhere
    }
  }
}))

describe('StorageV2FileMirrorService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api

    mocks.filesWhere.mockReturnValue({
      anyOf: mocks.filesAnyOf
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

  it('mirrors existing Dexie files into Storage v2', async () => {
    const file = {
      id: 'file-1',
      name: 'file-1.txt',
      origin_name: 'upload.txt',
      path: '/tmp/cherry-files/file-1.txt',
      size: 42,
      ext: '.txt',
      type: 'text',
      created_at: '2026-01-01T00:00:00.000Z',
      count: 1
    }
    const upsertFile = vi.fn().mockResolvedValue(undefined)
    const deleteFile = vi.fn().mockResolvedValue(undefined)

    mocks.filesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([file])
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertFile,
          deleteFile
        }
      }
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('file-1', 1000)
    await storageV2FileMirrorService.flush()

    expect(mocks.filesAnyOf).toHaveBeenCalledWith(['file-1'])
    expect(upsertFile).toHaveBeenCalledWith(file)
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('tombstones missing Dexie files in Storage v2', async () => {
    const upsertFile = vi.fn().mockResolvedValue(undefined)
    const deleteFile = vi.fn().mockResolvedValue(undefined)

    mocks.filesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([])
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertFile,
          deleteFile
        }
      }
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('missing-file', 1000)
    await storageV2FileMirrorService.flush()

    expect(upsertFile).not.toHaveBeenCalled()
    expect(deleteFile).toHaveBeenCalledWith('missing-file')
  })

  it('retries failed file mirrors on a timer', async () => {
    const file = {
      id: 'file-retry',
      name: 'file-retry.txt',
      origin_name: 'retry.txt',
      path: '/tmp/cherry-files/file-retry.txt',
      size: 42,
      ext: '.txt',
      type: 'text',
      created_at: '2026-01-01T00:00:00.000Z',
      count: 1
    }
    const upsertFile = vi.fn().mockRejectedValueOnce(new Error('storage busy')).mockResolvedValueOnce(undefined)

    mocks.filesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([file])
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertFile,
          deleteFile: vi.fn().mockResolvedValue(undefined)
        }
      }
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('file-retry', 1000)
    await storageV2FileMirrorService.flush()

    expect(upsertFile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1499)
    expect(upsertFile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(upsertFile).toHaveBeenCalledTimes(2)
    expect(upsertFile).toHaveBeenLastCalledWith(file)
  })

  it('rejects strict flushes when a file mirror write is still pending after failure', async () => {
    const file = {
      id: 'file-strict',
      name: 'file-strict.txt',
      origin_name: 'strict.txt',
      path: '/tmp/cherry-files/file-strict.txt',
      size: 42,
      ext: '.txt',
      type: 'text',
      created_at: '2026-01-01T00:00:00.000Z',
      count: 1
    }
    const upsertFile = vi.fn().mockRejectedValue(new Error('storage busy'))

    mocks.filesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([file])
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertFile,
          deleteFile: vi.fn().mockResolvedValue(undefined)
        }
      }
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('file-strict', 1000)

    await expect(storageV2FileMirrorService.flushStrict()).rejects.toThrow('storage busy')
    expect(upsertFile).toHaveBeenCalledTimes(1)
  })

  it('rejects strict flushes when Storage v2 API is unavailable with pending file work', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('file-1', 1000)

    await expect(storageV2FileMirrorService.flushStrict()).rejects.toThrow(
      'Storage v2 API unavailable while file mirror work is pending'
    )
  })

  it('retries pending file mirrors when Storage v2 API becomes available later', async () => {
    const file = {
      id: 'file-late-api',
      name: 'file-late-api.txt',
      origin_name: 'late-api.txt',
      path: '/tmp/cherry-files/file-late-api.txt',
      size: 42,
      ext: '.txt',
      type: 'text',
      created_at: '2026-01-01T00:00:00.000Z',
      count: 1
    }
    const upsertFile = vi.fn().mockResolvedValue(undefined)

    mocks.filesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([file])
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('file-late-api', 1000)
    await storageV2FileMirrorService.flush()

    expect(mocks.filesWhere).not.toHaveBeenCalled()

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertFile,
          deleteFile: vi.fn().mockResolvedValue(undefined)
        }
      }
    })

    await vi.advanceTimersByTimeAsync(1499)
    expect(upsertFile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(upsertFile).toHaveBeenCalledWith(file)
  })

  it('falls back to the legacy Dexie snapshot import when direct file upsert is unavailable', async () => {
    const file = {
      id: 'file-fallback',
      name: 'file-fallback.txt',
      origin_name: 'fallback.txt',
      path: '/tmp/cherry-files/file-fallback.txt',
      size: 42,
      ext: '.txt',
      type: 'text',
      created_at: '2026-01-01T00:00:00.000Z',
      count: 1
    }
    const importLegacyDexieSnapshot = vi.fn().mockResolvedValue({ dryRun: false })

    mocks.filesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([file])
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyDexieSnapshot,
          deleteFile: vi.fn().mockResolvedValue(undefined)
        }
      }
    })

    const { storageV2FileMirrorService } = await import('../StorageV2FileMirrorService')

    storageV2FileMirrorService.scheduleFile('file-fallback', 1000)
    await storageV2FileMirrorService.flush()

    expect(importLegacyDexieSnapshot).toHaveBeenCalledWith(
      {
        conversations: [],
        files: [file]
      },
      { dryRun: false }
    )
  })
})
