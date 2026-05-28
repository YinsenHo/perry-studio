import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'

import { storageV2DataRootService } from './storageV2/DataRootService'
import { storageV2SecretVaultService } from './storageV2/SecretVaultService'
import { storageV2Database } from './storageV2/StorageV2Database'

const logger = loggerService.withContext('AppDataMigrationService')

const RESTORE_STAGING_DIR_NAMES = ['IndexedDB.restore', 'Local Storage.restore', 'Data.restore']

function isSameOrInside(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate)
  const resolvedRoot = path.resolve(root)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

class AppDataMigrationService {
  async copyUserData(oldPath: string, newPath: string, occupiedDirs: string[] = []): Promise<void> {
    const resolvedOldPath = path.resolve(oldPath)
    const resolvedNewPath = path.resolve(newPath)
    const activeDataRoot = path.resolve(storageV2DataRootService.resolveDataRoot().dataRoot)
    const targetDataRoot = path.join(resolvedNewPath, 'Data')

    if (isSameOrInside(targetDataRoot, activeDataRoot)) {
      throw new Error('New app data path cannot be inside the active Storage v2 data root')
    }

    const excludedRoots = [
      path.join(resolvedOldPath, 'Data'),
      ...RESTORE_STAGING_DIR_NAMES.map((name) => path.join(resolvedOldPath, name)),
      ...occupiedDirs.map((dir) => path.resolve(dir))
    ]

    await fs.promises.cp(resolvedOldPath, resolvedNewPath, {
      recursive: true,
      filter: (src) => !excludedRoots.some((excludedRoot) => isSameOrInside(src, excludedRoot))
    })

    await this.copyActiveDataRoot(activeDataRoot, targetDataRoot)
  }

  private async copyActiveDataRoot(activeDataRoot: string, targetDataRoot: string): Promise<void> {
    if (!(await pathExists(activeDataRoot))) {
      await fs.promises.mkdir(targetDataRoot, { recursive: true })
      return
    }

    const snapshotPath = await this.createStorageV2SnapshotIfAvailable(activeDataRoot)

    await fs.promises.rm(targetDataRoot, { recursive: true, force: true })
    await fs.promises.mkdir(path.dirname(targetDataRoot), { recursive: true })
    await fs.promises.cp(activeDataRoot, targetDataRoot, { recursive: true })
    await this.replaceStorageV2DatabaseCopy(targetDataRoot, snapshotPath)
  }

  private async createStorageV2SnapshotIfAvailable(sourceDataRoot: string): Promise<string | null> {
    const mainDbPath = path.join(sourceDataRoot, 'main.db')
    if (!(await pathExists(mainDbPath))) {
      return null
    }

    const activeDataRoot = path.resolve(storageV2DataRootService.resolveDataRoot().dataRoot)
    if (activeDataRoot !== path.resolve(sourceDataRoot)) {
      logger.warn('Skipping Storage v2 snapshot because the copied data root is not active', {
        sourceDataRoot,
        activeDataRoot
      })
      return null
    }

    await storageV2SecretVaultService.waitForIdle()
    const snapshot = await storageV2Database.createSnapshot('app-data-migration')
    logger.info('Created Storage v2 database snapshot for app data migration', {
      snapshotPath: snapshot.path
    })
    return snapshot.path
  }

  private async replaceStorageV2DatabaseCopy(targetDataRoot: string, snapshotPath: string | null): Promise<void> {
    if (!snapshotPath) {
      return
    }

    const targetMainDbPath = path.join(targetDataRoot, 'main.db')
    await fs.promises.copyFile(snapshotPath, targetMainDbPath)
    await Promise.all([
      fs.promises.rm(`${targetMainDbPath}-wal`, { force: true }).catch(() => {}),
      fs.promises.rm(`${targetMainDbPath}-shm`, { force: true }).catch(() => {})
    ])
  }
}

export const appDataMigrationService = new AppDataMigrationService()
export { AppDataMigrationService }
