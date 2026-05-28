import FileManager from '@renderer/services/FileManager'
import { storageV2MirrorService } from '@renderer/services/StorageV2MirrorService'
import type { FileMetadata } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanupReplacedPaintingFiles, findPaintingByFiles } from '../index'

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFiles: vi.fn()
  }
}))

vi.mock('@renderer/services/StorageV2MirrorService', () => ({
  storageV2MirrorService: {
    flushStrict: vi.fn()
  }
}))

describe('findPaintingByFiles', () => {
  const createPainting = (id: string, providerId: string, fileIds: string[]) => ({
    id,
    providerId,
    files: fileIds.map((fileId) => ({ id: fileId }))
  })

  it('returns a painting with the same provider and file order', () => {
    const paintings = [
      createPainting('1', 'provider-a', ['file-1', 'file-2']),
      createPainting('2', 'provider-a', ['file-3'])
    ]

    expect(findPaintingByFiles(paintings, 'provider-a', [{ id: 'file-1' }, { id: 'file-2' }])).toMatchObject({
      id: '1'
    })
  })

  it('ignores paintings from other providers or different file sequences', () => {
    const paintings = [
      createPainting('1', 'provider-b', ['file-1', 'file-2']),
      createPainting('2', 'provider-a', ['file-2', 'file-1'])
    ]

    expect(findPaintingByFiles(paintings, 'provider-a', [{ id: 'file-1' }, { id: 'file-2' }])).toBeUndefined()
  })
})

describe('cleanupReplacedPaintingFiles', () => {
  const oldFiles = [
    { id: 'old-1', ext: '.png', name: 'old-1.png' },
    { id: 'old-2', ext: '.png', name: 'old-2.png' }
  ] as FileMetadata[]

  beforeEach(() => {
    vi.mocked(FileManager.deleteFiles).mockReset()
    vi.mocked(storageV2MirrorService.flushStrict).mockReset()
  })

  it('flushes the painting mirror before deleting replaced files', async () => {
    await cleanupReplacedPaintingFiles(oldFiles, [{ id: 'new-1' }])

    expect(storageV2MirrorService.flushStrict).toHaveBeenCalledOnce()
    expect(FileManager.deleteFiles).toHaveBeenCalledWith(oldFiles)
    expect(vi.mocked(storageV2MirrorService.flushStrict).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(FileManager.deleteFiles).mock.invocationCallOrder[0]
    )
  })

  it('keeps files that are still referenced by the replacement painting', async () => {
    await cleanupReplacedPaintingFiles(oldFiles, [{ id: 'old-2' }])

    expect(FileManager.deleteFiles).toHaveBeenCalledWith([oldFiles[0]])
  })

  it('does not flush or delete when no files were replaced', async () => {
    await cleanupReplacedPaintingFiles(oldFiles, [{ id: 'old-1' }, { id: 'old-2' }])

    expect(storageV2MirrorService.flushStrict).not.toHaveBeenCalled()
    expect(FileManager.deleteFiles).not.toHaveBeenCalled()
  })
})
