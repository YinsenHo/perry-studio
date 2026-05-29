import FileManager from '@renderer/services/FileManager'
import { storageV2MirrorService } from '@renderer/services/StorageV2MirrorService'
import { persistStorageV2ReduxSlice } from '@renderer/services/StorageV2ReduxSliceService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addPainting, removePainting, updatePainting, updatePaintings } from '@renderer/store/paintings'
import type { PaintingAction, PaintingsState } from '@renderer/types'

export function usePaintings() {
  const paintings = useAppSelector((state) => state.paintings)
  const dispatch = useAppDispatch()

  return {
    ...paintings,
    addPainting: (namespace: keyof PaintingsState, painting: PaintingAction) => {
      dispatch(addPainting({ namespace, painting }))
      return painting
    },
    removePainting: async (namespace: keyof PaintingsState, painting: PaintingAction) => {
      const currentPaintings = (paintings[namespace] ?? []) as PaintingAction[]
      const nextPaintings = {
        ...paintings,
        [namespace]: currentPaintings.filter((candidate) => candidate.id !== painting.id)
      } as PaintingsState

      await persistStorageV2ReduxSlice('paintings', nextPaintings)
      dispatch(removePainting({ namespace, painting }))
      await storageV2MirrorService.flushStrict()
      await FileManager.deleteFiles(painting.files)
    },
    updatePainting: (namespace: keyof PaintingsState, painting: PaintingAction) => {
      dispatch(updatePainting({ namespace, painting }))
    },
    updatePaintings: (namespace: keyof PaintingsState, paintings: PaintingAction[]) => {
      dispatch(updatePaintings({ namespace, paintings }))
    }
  }
}
