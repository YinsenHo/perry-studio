import type { PaintingAction } from '@renderer/types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteFiles: vi.fn(),
  dispatch: vi.fn(),
  flush: vi.fn(),
  flushStrict: vi.fn(),
  paintingsState: {
    aihubmix_image_edit: [],
    aihubmix_image_generate: [],
    aihubmix_image_remix: [],
    aihubmix_image_upscale: [],
    dmxapi_paintings: [],
    openai_image_edit: [],
    openai_image_generate: [],
    ovms_paintings: [],
    ppio_draw: [],
    ppio_edit: [],
    siliconflow_paintings: [],
    tokenflux_paintings: [],
    zhipu_paintings: []
  }
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFiles: mocks.deleteFiles
  }
}))

vi.mock('@renderer/services/StorageV2MirrorService', () => ({
  storageV2MirrorService: {
    flush: mocks.flush,
    flushStrict: mocks.flushStrict
  }
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (selector: (state: any) => unknown) => selector({ paintings: mocks.paintingsState })
}))

describe('usePaintings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteFiles.mockResolvedValue(undefined)
    mocks.flushStrict.mockResolvedValue(undefined)
  })

  it('strictly flushes Storage v2 before deleting painting files', async () => {
    const { usePaintings } = await import('../usePaintings')
    const files = [{ id: 'file-1', ext: '.png' }] as PaintingAction['files']
    const painting = { id: 'painting-1', files, urls: [] } satisfies PaintingAction
    const { result } = renderHook(() => usePaintings())

    await act(async () => {
      await result.current.removePainting('siliconflow_paintings', painting)
    })

    expect(mocks.deleteFiles).toHaveBeenCalledWith(files)
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'paintings/removePainting',
      payload: { namespace: 'siliconflow_paintings', painting }
    })
    expect(mocks.flushStrict).toHaveBeenCalledTimes(1)
    expect(mocks.flush).not.toHaveBeenCalled()
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.flushStrict.mock.invocationCallOrder[0])
    expect(mocks.flushStrict.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteFiles.mock.invocationCallOrder[0])
  })
})
