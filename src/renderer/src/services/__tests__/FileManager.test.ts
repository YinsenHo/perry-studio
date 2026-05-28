import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filesAdd: vi.fn(),
  filesDelete: vi.fn(),
  filesGet: vi.fn(),
  filesUpdate: vi.fn(),
  localFileDelete: vi.fn(),
  mirrorFlush: vi.fn(),
  mirrorScheduleFile: vi.fn(),
  storageV2DeleteFile: vi.fn(),
  storageV2UpsertFile: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    files: {
      add: mocks.filesAdd,
      delete: mocks.filesDelete,
      get: mocks.filesGet,
      update: mocks.filesUpdate
    }
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      runtime: {
        filesPath: '/mock/files'
      }
    })
  }
}))

vi.mock('@renderer/services/StorageV2FileRecoveryService', () => ({
  storageV2FileRecoveryService: {
    projectFileIfMissing: vi.fn()
  }
}))

vi.mock('@renderer/services/StorageV2FileMirrorService', () => ({
  storageV2FileMirrorService: {
    flush: mocks.mirrorFlush,
    scheduleFile: mocks.mirrorScheduleFile
  }
}))

describe('FileManager', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        file: {
          delete: mocks.localFileDelete
        },
        storageV2: {
          deleteFile: mocks.storageV2DeleteFile,
          upsertFile: mocks.storageV2UpsertFile
        }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('stops deleting file metadata when the Storage v2 tombstone fails', async () => {
    const error = new Error('storage unavailable')
    mocks.filesGet.mockResolvedValue({
      id: 'file-1',
      ext: '.txt',
      count: 1,
      origin_name: 'note.txt'
    })
    mocks.storageV2DeleteFile.mockRejectedValue(error)

    const { default: FileManager } = await import('../FileManager')

    await expect(FileManager.deleteFile('file-1', true)).rejects.toThrow(error)

    expect(mocks.storageV2DeleteFile).toHaveBeenCalledWith('file-1')
    expect(mocks.filesDelete).not.toHaveBeenCalled()
    expect(mocks.localFileDelete).not.toHaveBeenCalled()
  })

  it('deletes legacy metadata and the local file after the Storage v2 tombstone succeeds', async () => {
    mocks.filesGet.mockResolvedValue({
      id: 'file-1',
      ext: '.txt',
      count: 1,
      origin_name: 'note.txt'
    })
    mocks.storageV2DeleteFile.mockResolvedValue({ deleted: true })
    mocks.filesDelete.mockResolvedValue(undefined)
    mocks.localFileDelete.mockResolvedValue(undefined)

    const { default: FileManager } = await import('../FileManager')

    await expect(FileManager.deleteFile('file-1', true)).resolves.toBeUndefined()

    expect(mocks.storageV2DeleteFile).toHaveBeenCalledWith('file-1')
    expect(mocks.filesDelete).toHaveBeenCalledWith('file-1')
    expect(mocks.localFileDelete).toHaveBeenCalledWith('file-1.txt')
  })

  it('queues file metadata for retry when the direct Storage v2 mirror fails', async () => {
    const file = {
      id: 'file-2',
      ext: '.txt',
      count: 1,
      origin_name: 'draft.txt'
    }
    mocks.filesGet.mockResolvedValue(undefined)
    mocks.filesAdd.mockResolvedValue('file-2')
    mocks.storageV2UpsertFile.mockRejectedValue(new Error('temporary storage failure'))
    mocks.mirrorFlush.mockResolvedValue(undefined)

    const { default: FileManager } = await import('../FileManager')

    await expect(FileManager.addFile(file as any)).resolves.toBe(file)

    expect(mocks.filesAdd).toHaveBeenCalledWith(file)
    expect(mocks.storageV2UpsertFile).toHaveBeenCalledWith(file)
    expect(mocks.mirrorScheduleFile).toHaveBeenCalledWith('file-2', 0)
    expect(mocks.mirrorFlush).toHaveBeenCalled()
  })
})
