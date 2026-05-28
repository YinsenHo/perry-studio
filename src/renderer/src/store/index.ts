/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { IpcChannel } from '@shared/IpcChannel'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from 'redux-persist'
import storage from 'redux-persist/lib/storage'

import { storageV2AgentMirrorService } from '../services/StorageV2AgentMirrorService'
import { storageV2ConversationMirrorService } from '../services/StorageV2ConversationMirrorService'
import { storageV2DexieSettingsMirrorService } from '../services/StorageV2DexieSettingsMirrorService'
import { storageV2DexieTableMirrorService } from '../services/StorageV2DexieTableMirrorService'
import { storageV2FileMirrorService } from '../services/StorageV2FileMirrorService'
import { maybeHydrateRuntimeCacheFromStorageV2 } from '../services/StorageV2HydrationService'
import { flushStorageV2LocalStorageMirrorStrict } from '../services/StorageV2LocalStorageSnapshot'
import { storageV2MirrorService } from '../services/StorageV2MirrorService'
import storeSyncService from '../services/StoreSyncService'
import assistants from './assistants'
import backup from './backup'
import codeTools from './codeTools'
import copilot from './copilot'
import inputToolsReducer from './inputTools'
import knowledge from './knowledge'
import llm from './llm'
import mcp from './mcp'
import memory from './memory'
import messageBlocksReducer from './messageBlock'
import migrate from './migrate'
import minapps from './minapps'
import newMessagesReducer from './newMessage'
import { setNotesPath } from './note'
import note from './note'
import nutstore from './nutstore'
import ocr from './ocr'
import openclaw from './openclaw'
import paintings from './paintings'
import preprocess from './preprocess'
import runtime from './runtime'
import selectionStore from './selectionStore'
import settings from './settings'
import shortcuts from './shortcuts'
import tabs from './tabs'
import toolPermissions from './toolPermissions'
import translate from './translate'
import websearch from './websearch'

const logger = loggerService.withContext('Store')

const rootReducer = combineReducers({
  assistants,
  backup,
  codeTools,
  nutstore,
  paintings,
  llm,
  settings,
  runtime,
  shortcuts,
  knowledge,
  minapps,
  websearch,
  mcp,
  memory,
  copilot,
  openclaw,
  selectionStore,
  tabs,
  preprocess,
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  inputTools: inputToolsReducer,
  translate,
  ocr,
  note,
  toolPermissions
})

const persistedReducer = persistReducer(
  {
    key: 'cherry-studio',
    storage,
    version: 210,
    blacklist: ['runtime', 'messages', 'messageBlocks', 'tabs', 'toolPermissions'],
    migrate
  },
  rootReducer
)

const REDUX_PERSIST_STORAGE_KEY = 'persist:cherry-studio'

function isReduxPersistCacheMissing() {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(REDUX_PERSIST_STORAGE_KEY) == null
}

/**
 * Configures the store sync service to synchronize specific state slices across all windows.
 * For detailed implementation, see @renderer/services/StoreSyncService.ts
 *
 * Usage:
 * - 'xxxx/' - Synchronizes the entire state slice
 * - 'xxxx/sliceName' - Synchronizes a specific slice within the state
 *
 * To listen for store changes in a window:
 * Call storeSyncService.subscribe() in the window's entryPoint.tsx
 */
storeSyncService.setOptions({
  syncList: ['assistants/', 'settings/', 'llm/', 'selectionStore/', 'note/']
})

const store = configureStore({
  // @ts-ignore store type is unknown
  reducer: persistedReducer as typeof rootReducer,
  middleware: (getDefaultMiddleware) => {
    return getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER]
      }
    }).concat(storeSyncService.createMiddleware(), storageV2MirrorService.createMiddleware())
  },
  devTools: true
})

export type RootState = ReturnType<typeof rootReducer>
export type AppDispatch = typeof store.dispatch

storageV2MirrorService.pauseRuntimeMirroring()
storageV2DexieSettingsMirrorService.install()
storageV2DexieTableMirrorService.install()

export const persistor = persistStore(store, undefined, () => {
  // Initialize notes path after rehydration if empty
  const state = store.getState()
  if (!state.note.notesPath) {
    // Use setTimeout to ensure this runs after the store is fully initialized
    setTimeout(async () => {
      try {
        const info = await window.api.getAppInfo()
        store.dispatch(setNotesPath(info.notesPath))
        logger.info('Initialized notes path on startup:', info.notesPath)
      } catch (error) {
        logger.error('Failed to initialize notes path on startup:', error as Error)
      }
    }, 0)
  }

  const notifyReduxReady = () => {
    storageV2MirrorService.resumeRuntimeMirroring()
    storageV2MirrorService.scheduleStartupMirror(() => store.getState())
    void window.electron?.ipcRenderer?.invoke(IpcChannel.ReduxStoreReady)
    logger.info('Redux store ready, notified main process')
  }

  void maybeHydrateRuntimeCacheFromStorageV2({
    dispatch: store.dispatch,
    flush: () => persistor.flush(),
    shouldHydrateWhenDisabled: isReduxPersistCacheMissing
  })
    .then((result) => {
      if (result.hydrated) {
        logger.info('Storage v2 runtime cache restored before Redux ready')
      }
    })
    .catch((error) => {
      logger.warn('Storage v2 auto hydrate skipped or failed', error as Error)
    })
    .finally(notifyReduxReady)
})

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
export const useAppStore = useStore.withTypes<typeof store>()
window.store = store

export async function handleSaveData() {
  logger.info('Flushing redux persistor data')
  await persistor.flush()
  await storageV2MirrorService.flushStrict()
  await flushStorageV2LocalStorageMirrorStrict()
  await storageV2ConversationMirrorService.flushStrict()
  await storageV2FileMirrorService.flushStrict()
  await storageV2DexieSettingsMirrorService.flushStrict()
  await storageV2DexieTableMirrorService.flushStrict()
  await storageV2AgentMirrorService.flushStrict()
  logger.info('Flushed redux persistor data')
}

export default store
