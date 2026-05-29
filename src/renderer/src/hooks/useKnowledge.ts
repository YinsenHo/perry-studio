import { loggerService } from '@logger'
import { db } from '@renderer/databases'
import KnowledgeQueue from '@renderer/queue/KnowledgeQueue'
import FileManager from '@renderer/services/FileManager'
import { getKnowledgeBaseParams } from '@renderer/services/KnowledgeService'
import { storageV2DexieTableMirrorService } from '@renderer/services/StorageV2DexieTableMirrorService'
import { storageV2DexieTableRecoveryService } from '@renderer/services/StorageV2DexieTableRecoveryService'
import { storageV2MirrorService } from '@renderer/services/StorageV2MirrorService'
import {
  persistStorageV2PartialReduxSnapshot,
  persistStorageV2ReduxSlice
} from '@renderer/services/StorageV2ReduxSliceService'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import {
  addBase,
  clearAllProcessing,
  clearCompletedProcessing,
  deleteBase,
  removeItem as removeItemAction,
  renameBase,
  updateBase,
  updateBases,
  updateItem as updateItemAction,
  updateItemProcessingStatus,
  updateNotes
} from '@renderer/store/knowledge'
import { addFilesThunk, addItemThunk, addNoteThunk, addVedioThunk } from '@renderer/store/thunk/knowledgeThunk'
import type { FileMetadata, KnowledgeBase, KnowledgeItem, KnowledgeNoteItem, ProcessingStatus } from '@renderer/types'
import { isKnowledgeFileItem, isKnowledgeNoteItem, isKnowledgeVideoItem } from '@renderer/types'
import { runAsyncFunction, uuid } from '@renderer/utils'
import dayjs from 'dayjs'
import { cloneDeep } from 'lodash'
import { useCallback, useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'

import { useAssistants } from './useAssistant'
import { useAssistantPresets } from './useAssistantPresets'
import { useTimer } from './useTimer'

const logger = loggerService.withContext('useKnowledge')

async function flushStorageV2KnowledgeMirror(reason: string, options: { strict?: boolean } = {}) {
  try {
    if (options.strict) {
      await storageV2MirrorService.flushStrict()
    } else {
      await storageV2MirrorService.flush()
    }
  } catch (error) {
    logger.warn(`Failed to flush Storage v2 knowledge mirror: ${reason}`, error as Error)
    if (options.strict) {
      throw error
    }
  }
}

async function getKnowledgeNoteWithStorageV2Fallback(noteId: string, reason: string) {
  let note = await db.knowledge_notes.get(noteId)
  if (!note) {
    const restored = await storageV2DexieTableRecoveryService.projectRowIfMissing('knowledge_notes', noteId, reason)
    if (restored) {
      note = await db.knowledge_notes.get(noteId)
    }
  }
  return note
}

async function deleteKnowledgeNotesAfterMetadataFlush(noteIds: string[]) {
  if (noteIds.length === 0) return

  storageV2DexieTableMirrorService.scheduleDeletes('knowledge_notes', noteIds)
  await storageV2DexieTableMirrorService.flushStrict()
  await db.knowledge_notes.bulkDelete(noteIds)
}

async function cleanupKnowledgeIndex(reason: string, cleanup: () => Promise<void>) {
  try {
    await cleanup()
  } catch (error) {
    logger.warn(`Failed to cleanup knowledge index after Storage v2 metadata flush: ${reason}`, error as Error)
  }
}

export const useKnowledge = (baseId: string) => {
  const dispatch = useAppDispatch()
  const knowledgeState = useSelector((state: RootState) => state.knowledge)
  const base = useSelector((state: RootState) => state.knowledge.bases.find((b) => b.id === baseId))
  const { setTimeoutTimer } = useTimer()

  const getNextKnowledgeStateWithBaseItems = (items: KnowledgeItem[]) => ({
    ...knowledgeState,
    bases: knowledgeState.bases.map((candidate) => (candidate.id === baseId ? { ...candidate, items } : candidate))
  })

  // 重命名知识库
  const renameKnowledgeBase = async (name: string) => {
    dispatch(renameBase({ baseId, name }))
    await flushStorageV2KnowledgeMirror('rename-knowledge-base')
  }

  // 更新知识库
  const updateKnowledgeBase = async (base: KnowledgeBase) => {
    dispatch(updateBase(base))
    await flushStorageV2KnowledgeMirror('update-knowledge-base')
  }

  // 检查知识库
  const checkAllBases = () => {
    // 这个也许也会多任务？
    const id = uuid()
    setTimeoutTimer(id, () => KnowledgeQueue.checkAllBases(), 0)
  }

  // 批量添加文件
  const addFiles = async (files: FileMetadata[]) => {
    await dispatch(addFilesThunk(baseId, files))
    await flushStorageV2KnowledgeMirror('add-files')
    checkAllBases()
  }

  // 添加笔记
  const addNote = async (content: string) => {
    await dispatch(addNoteThunk(baseId, content))
    await flushStorageV2KnowledgeMirror('add-note')
    // 确保数据库写入完成后再触发队列检查
    setTimeout(() => KnowledgeQueue.checkAllBases(), 100)
  }

  // 添加URL
  const addUrl = async (url: string) => {
    await dispatch(addItemThunk(baseId, 'url', url))
    await flushStorageV2KnowledgeMirror('add-url')
    checkAllBases()
  }

  // 添加 Sitemap
  const addSitemap = async (url: string) => {
    await dispatch(addItemThunk(baseId, 'sitemap', url))
    await flushStorageV2KnowledgeMirror('add-sitemap')
    checkAllBases()
  }

  // Add directory support
  const addDirectory = async (path: string) => {
    await dispatch(addItemThunk(baseId, 'directory', path))
    await flushStorageV2KnowledgeMirror('add-directory')
    checkAllBases()
  }

  // add video support
  const addVideo = async (files: FileMetadata[]) => {
    await dispatch(addVedioThunk(baseId, 'video', files))
    await flushStorageV2KnowledgeMirror('add-video')
    checkAllBases()
  }

  // 更新笔记内容
  const updateNoteContent = async (noteId: string, content: string) => {
    const note = await getKnowledgeNoteWithStorageV2Fallback(noteId, 'knowledge-note-update-missing')
    if (note) {
      const updatedNote = {
        ...note,
        content,
        updated_at: Date.now()
      }
      await db.knowledge_notes.put(updatedNote)
      storageV2DexieTableMirrorService.scheduleRow('knowledge_notes', updatedNote.id, 0)
      await storageV2DexieTableMirrorService.flush()
      dispatch(updateNotes({ baseId, item: updatedNote }))
      await flushStorageV2KnowledgeMirror('update-note-content')
    }
    const noteItem = base?.items.find((item) => item.id === noteId)
    void (noteItem && refreshItem(noteItem))
  }

  // 获取笔记内容
  const getNoteContent = async (noteId: string) => {
    return await getKnowledgeNoteWithStorageV2Fallback(noteId, 'knowledge-note-get-missing')
  }

  const updateItem = async (item: KnowledgeItem) => {
    dispatch(updateItemAction({ baseId, item }))
    await flushStorageV2KnowledgeMirror('update-item')
  }

  // 移除项目
  const removeItem = async (item: KnowledgeItem) => {
    if (!base) {
      return
    }

    const noteIds = isKnowledgeNoteItem(item) ? [item.id] : []
    if (item?.uniqueId && item?.uniqueIds) {
      const removalParams = {
        uniqueId: item.uniqueId,
        uniqueIds: item.uniqueIds,
        base: getKnowledgeBaseParams(base)
      }
      await persistStorageV2ReduxSlice(
        'knowledge',
        getNextKnowledgeStateWithBaseItems(base.items.filter((candidate) => candidate.id !== item.id))
      )
      dispatch(removeItemAction({ baseId, item }))
      await flushStorageV2KnowledgeMirror('remove-item', { strict: true })
      await deleteKnowledgeNotesAfterMetadataFlush(noteIds)
      await cleanupKnowledgeIndex('remove-item', () => window.api.knowledgeBase.remove(removalParams))
    } else {
      await persistStorageV2ReduxSlice(
        'knowledge',
        getNextKnowledgeStateWithBaseItems(base.items.filter((candidate) => candidate.id !== item.id))
      )
      dispatch(removeItemAction({ baseId, item }))
      await flushStorageV2KnowledgeMirror('remove-item', { strict: true })
      await deleteKnowledgeNotesAfterMetadataFlush(noteIds)
    }

    const filesToDelete =
      isKnowledgeFileItem(item) && typeof item.content === 'object' && !Array.isArray(item.content)
        ? [item.content]
        : isKnowledgeVideoItem(item)
          ? item.content
          : []

    await FileManager.deleteFiles(filesToDelete)
  }
  // 刷新项目
  const refreshItem = async (item: KnowledgeItem) => {
    const status = getProcessingStatus(item.id)

    if (status === 'pending' || status === 'processing') {
      return
    }

    if (!base || !item?.uniqueId || !item?.uniqueIds) {
      return
    }

    const removalParams = {
      uniqueId: item.uniqueId,
      uniqueIds: item.uniqueIds,
      base: getKnowledgeBaseParams(base)
    }

    const refreshedItem: KnowledgeItem = {
      ...item,
      processingStatus: 'pending',
      processingProgress: 0,
      processingError: '',
      uniqueId: undefined,
      retryCount: 0,
      updated_at: Date.now()
    }

    await persistStorageV2ReduxSlice(
      'knowledge',
      getNextKnowledgeStateWithBaseItems(
        base.items.map((candidate) => (candidate.id === refreshedItem.id ? refreshedItem : candidate))
      )
    )
    dispatch(updateItemAction({ baseId, item: refreshedItem }))
    await flushStorageV2KnowledgeMirror('refresh-item', { strict: true })
    await cleanupKnowledgeIndex('refresh-item', () => window.api.knowledgeBase.remove(removalParams))
    checkAllBases()
  }

  // 更新处理状态
  const updateItemStatus = (itemId: string, status: ProcessingStatus, progress?: number, error?: string) => {
    dispatch(
      updateItemProcessingStatus({
        baseId,
        itemId,
        status,
        progress,
        error
      })
    )
  }

  // 获取特定项目的处理状态
  const getProcessingStatus = useCallback(
    (itemId: string) => {
      return base?.items.find((item) => item.id === itemId)?.processingStatus
    },
    [base?.items]
  )

  // 获取特定类型的所有处理项
  const getProcessingItemsByType = (type: 'file' | 'url' | 'note') => {
    return base?.items.filter((item) => item.type === type && item.processingStatus !== undefined) || []
  }

  // 清除已完成的项目
  const clearCompleted = () => {
    dispatch(clearCompletedProcessing({ baseId }))
  }

  // 清除所有处理状态
  const clearAll = () => {
    dispatch(clearAllProcessing({ baseId }))
  }

  // 迁移知识库（保留原知识库）
  const migrateBase = async (newBase: KnowledgeBase) => {
    if (!base) return

    const timestamp = dayjs().format('YYMMDDHHmmss')
    const newName = `${newBase.name || base.name}-${timestamp}`

    const migratedBase = {
      ...cloneDeep(base), // 深拷贝原始知识库
      ...newBase,
      id: newBase.id, // 确保使用新的ID
      name: newName,
      created_at: Date.now(),
      updated_at: Date.now(),
      items: []
    } satisfies KnowledgeBase

    dispatch(addBase(migratedBase))
    await flushStorageV2KnowledgeMirror('migrate-base-create')

    const files: FileMetadata[] = []

    // 遍历原知识库的 items，重新添加到新知识库
    for (const item of base.items) {
      switch (item.type) {
        case 'file':
          if (typeof item.content === 'object' && item.content !== null && 'path' in item.content) {
            files.push(item.content)
          }
          break
        case 'note':
          try {
            const note = await getKnowledgeNoteWithStorageV2Fallback(item.id, 'knowledge-note-migrate-missing')
            const content = note?.content || ''
            await dispatch(addNoteThunk(newBase.id, content))
            await flushStorageV2KnowledgeMirror('migrate-base-add-note')
          } catch (error) {
            throw new Error(`Failed to migrate note item ${item.id}: ${error}`)
          }
          break
        default:
          if (typeof item.content === 'string') {
            try {
              dispatch(addItemThunk(newBase.id, item.type, item.content))
              await flushStorageV2KnowledgeMirror('migrate-base-add-item')
            } catch (error) {
              throw new Error(`Failed to migrate item ${item.id}: ${error}`)
            }
          } else {
            throw new Error(`Not a valid item: ${JSON.stringify(item)}`)
          }
          break
      }
    }

    try {
      if (files.length > 0) {
        dispatch(addFilesThunk(newBase.id, files))
        await flushStorageV2KnowledgeMirror('migrate-base-add-files')
      }
    } catch (error) {
      throw new Error(`Failed to migrate files ${files}: ${error}`)
    }

    checkAllBases()
  }

  const fileItems = base?.items.filter((item) => item.type === 'file') || []
  const directoryItems = base?.items.filter((item) => item.type === 'directory') || []
  const urlItems = base?.items.filter((item) => item.type === 'url') || []
  const sitemapItems = base?.items.filter((item) => item.type === 'sitemap') || []
  const [noteItems, setNoteItems] = useState<KnowledgeItem[]>([])
  const videoItems = base?.items.filter((item) => item.type === 'video') || []

  useEffect(() => {
    const notes = base?.items.filter(isKnowledgeNoteItem) ?? []
    void runAsyncFunction(async () => {
      const newNoteItems = await Promise.all(
        notes.map(async (item) => {
          const note = await getKnowledgeNoteWithStorageV2Fallback(item.id, 'knowledge-note-list-missing')
          return { ...item, content: note?.content ?? '' } satisfies KnowledgeNoteItem
        })
      )
      setNoteItems(newNoteItems)
    })
  }, [base?.items])

  return {
    base,
    fileItems,
    urlItems,
    sitemapItems,
    noteItems,
    videoItems,
    renameKnowledgeBase,
    updateKnowledgeBase,
    migrateBase,
    addFiles,
    addUrl,
    addSitemap,
    addNote,
    addVideo,
    updateNoteContent,
    getNoteContent,
    updateItem,
    updateItemStatus,
    refreshItem,
    getProcessingStatus,
    getProcessingItemsByType,
    clearCompleted,
    clearAll,
    removeItem,
    directoryItems,
    addDirectory
  }
}

export const useKnowledgeBases = () => {
  const dispatch = useDispatch()
  const knowledgeState = useSelector((state: RootState) => state.knowledge)
  const assistantsState = useSelector((state: RootState) => state.assistants)
  const bases = knowledgeState.bases
  const { assistants, updateAssistants } = useAssistants()
  const { presets, setAssistantPresets } = useAssistantPresets()

  const addKnowledgeBase = async (base: KnowledgeBase) => {
    dispatch(addBase(base))
    await flushStorageV2KnowledgeMirror('add-knowledge-base')
  }

  const renameKnowledgeBase = async (baseId: string, name: string) => {
    dispatch(renameBase({ baseId, name }))
    await flushStorageV2KnowledgeMirror('rename-knowledge-base')
  }

  const deleteKnowledgeBase = async (baseId: string) => {
    const base = bases.find((b) => b.id === baseId)
    if (!base) return

    const files = base.items.filter(isKnowledgeFileItem).map((item) => item.content as FileMetadata)

    const noteIds = base.items.filter(isKnowledgeNoteItem).map((item) => item.id)

    // remove assistant knowledge_base
    const _assistants = assistants.map((assistant) => {
      if (assistant.knowledge_bases?.find((kb) => kb.id === baseId)) {
        return {
          ...assistant,
          knowledge_bases: assistant.knowledge_bases.filter((kb) => kb.id !== baseId)
        }
      }
      return assistant
    })

    // remove agent knowledge_base
    const _presets = presets.map((agent) => {
      if (agent.knowledge_bases?.find((kb) => kb.id === baseId)) {
        return {
          ...agent,
          knowledge_bases: agent.knowledge_bases.filter((kb) => kb.id !== baseId)
        }
      }
      return agent
    })

    const nextKnowledgeState = {
      ...knowledgeState,
      bases: bases.filter((candidate) => candidate.id !== baseId)
    }
    const nextAssistantsState = {
      ...assistantsState,
      assistants: _assistants,
      presets: _presets
    }

    await persistStorageV2PartialReduxSnapshot({
      redux: {
        knowledge: nextKnowledgeState
      },
      assistants: nextAssistantsState
    })

    storageV2MirrorService.pauseRuntimeMirroring()
    try {
      dispatch(deleteBase({ baseId }))
      await updateAssistants(_assistants)
      setAssistantPresets(_presets)
    } finally {
      storageV2MirrorService.resumeRuntimeMirroring({ scheduleLatest: true })
    }

    await flushStorageV2KnowledgeMirror('delete-knowledge-base', { strict: true })
    await deleteKnowledgeNotesAfterMetadataFlush(noteIds)
    await cleanupKnowledgeIndex('delete-knowledge-base', () => window.api.knowledgeBase.delete(baseId))
    await FileManager.deleteFiles(files)
  }

  const updateKnowledgeBases = async (bases: KnowledgeBase[], options: { strict?: boolean } = {}) => {
    dispatch(updateBases(bases))
    await flushStorageV2KnowledgeMirror('update-knowledge-bases', options)
  }

  return {
    bases,
    addKnowledgeBase,
    renameKnowledgeBase,
    deleteKnowledgeBase,
    updateKnowledgeBases
  }
}
