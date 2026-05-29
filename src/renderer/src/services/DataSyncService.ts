import { loggerService } from '@logger'
import store from '@renderer/store'
import type { WebDavConfig } from '@renderer/types'

import { flushStorageV2RuntimeMirrors } from './StorageV2Service'

const logger = loggerService.withContext('DataSyncService')

export type DataSyncSummary = {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  skipped: number
  snapshotUploaded?: boolean
  snapshotFileName?: string | null
  snapshotBytes?: number
  lastSyncAt: number
}

let syncTimeout: NodeJS.Timeout | null = null
let autoSyncStarted = false
let syncing = false

function getWebDavConfig(): WebDavConfig {
  const settings = store.getState().settings
  return {
    webdavHost: settings.dataSyncWebdavHost,
    webdavUser: settings.dataSyncWebdavUser,
    webdavPass: settings.dataSyncWebdavPass,
    webdavPath: settings.dataSyncWebdavPath
  }
}

export async function syncAppDataNow(configOverride?: WebDavConfig): Promise<DataSyncSummary | null> {
  if (syncing) {
    logger.info('Data sync already running')
    return null
  }

  const config = configOverride ?? getWebDavConfig()
  if (!config.webdavHost) {
    throw new Error('WebDAV host is required')
  }

  syncing = true
  try {
    await flushStorageV2RuntimeMirrors()
    return await window.api.dataSync.syncNow(config)
  } finally {
    syncing = false
  }
}

export function stopDataSyncAutoSync() {
  autoSyncStarted = false
  if (syncTimeout) {
    clearTimeout(syncTimeout)
    syncTimeout = null
  }
}

export function startDataSyncAutoSync(immediate = false) {
  const settings = store.getState().settings
  if (!settings.dataSyncAutoSync || !settings.dataSyncWebdavHost || settings.dataSyncSyncInterval <= 0) {
    stopDataSyncAutoSync()
    return
  }

  if (autoSyncStarted && syncTimeout) {
    return
  }

  autoSyncStarted = true
  scheduleNextSync(immediate ? 1000 : settings.dataSyncSyncInterval * 60 * 1000)
}

function scheduleNextSync(delayMs: number) {
  if (syncTimeout) {
    clearTimeout(syncTimeout)
  }

  syncTimeout = setTimeout(() => {
    void performAutoSync()
  }, delayMs)

  logger.info('Data sync scheduled', { delayMs })
}

async function performAutoSync() {
  const settings = store.getState().settings
  if (!settings.dataSyncAutoSync || !settings.dataSyncWebdavHost || settings.dataSyncSyncInterval <= 0) {
    stopDataSyncAutoSync()
    return
  }

  try {
    await syncAppDataNow()
  } catch (error) {
    logger.warn('Auto data sync failed', error as Error)
  } finally {
    if (autoSyncStarted) {
      scheduleNextSync(store.getState().settings.dataSyncSyncInterval * 60 * 1000)
    }
  }
}
