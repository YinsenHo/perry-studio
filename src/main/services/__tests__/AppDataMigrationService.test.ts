import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn()
  },
  storageV2DataRootService: {
    resolveDataRoot: vi.fn()
  },
  storageV2Database: {
    createSnapshot: vi.fn()
  },
  storageV2SecretVaultService: {
    waitForIdle: vi.fn()
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    default: actual
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('../storageV2/DataRootService', () => ({
  storageV2DataRootService: mocks.storageV2DataRootService
}))

vi.mock('../storageV2/StorageV2Database', () => ({
  storageV2Database: mocks.storageV2Database
}))

vi.mock('../storageV2/SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.storageV2SecretVaultService
}))

import { AppDataMigrationService } from '../AppDataMigrationService'

describe('AppDataMigrationService', () => {
  let tmpDir: string
  let oldPath: string
  let newPath: string
  let service: AppDataMigrationService

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-migration-'))
    oldPath = path.join(tmpDir, 'old-user-data')
    newPath = path.join(tmpDir, 'new-user-data')
    service = new AppDataMigrationService()
    fs.mkdirSync(oldPath, { recursive: true })
    mocks.storageV2SecretVaultService.waitForIdle.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('copies the active Data root through a Storage v2 snapshot and skips restore staging markers', async () => {
    const activeDataRoot = path.join(oldPath, 'Data')
    const snapshotPath = path.join(tmpDir, 'snapshot-main.db')
    fs.mkdirSync(activeDataRoot, { recursive: true })
    fs.writeFileSync(path.join(activeDataRoot, 'main.db'), 'live-main-db')
    fs.writeFileSync(path.join(activeDataRoot, 'main.db-wal'), 'wal')
    fs.writeFileSync(path.join(activeDataRoot, 'main.db-shm'), 'shm')
    fs.writeFileSync(snapshotPath, 'snapshot-main-db')
    fs.mkdirSync(path.join(oldPath, 'IndexedDB'), { recursive: true })
    fs.writeFileSync(path.join(oldPath, 'IndexedDB', 'db.leveldb'), 'indexed-db')
    fs.mkdirSync(path.join(oldPath, 'Data.restore'), { recursive: true })
    fs.writeFileSync(path.join(oldPath, 'Data.restore', 'stale.db'), 'stale')
    fs.mkdirSync(path.join(oldPath, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(oldPath, 'logs', 'app.log'), 'log')
    fs.mkdirSync(path.join(oldPath, 'logs2'), { recursive: true })
    fs.writeFileSync(path.join(oldPath, 'logs2', 'keep.log'), 'keep')

    mocks.storageV2DataRootService.resolveDataRoot.mockReturnValue({ dataRoot: activeDataRoot })
    mocks.storageV2Database.createSnapshot.mockResolvedValue({
      path: snapshotPath,
      reason: 'app-data-migration',
      createdAt: '2026-01-01T00:00:00.000Z'
    })

    await service.copyUserData(oldPath, newPath, [path.join(oldPath, 'logs')])

    expect(fs.readFileSync(path.join(newPath, 'Data', 'main.db'), 'utf-8')).toBe('snapshot-main-db')
    expect(fs.existsSync(path.join(newPath, 'Data', 'main.db-wal'))).toBe(false)
    expect(fs.existsSync(path.join(newPath, 'Data', 'main.db-shm'))).toBe(false)
    expect(fs.existsSync(path.join(newPath, 'Data.restore'))).toBe(false)
    expect(fs.existsSync(path.join(newPath, 'logs'))).toBe(false)
    expect(fs.readFileSync(path.join(newPath, 'logs2', 'keep.log'), 'utf-8')).toBe('keep')
    expect(fs.readFileSync(path.join(newPath, 'IndexedDB', 'db.leveldb'), 'utf-8')).toBe('indexed-db')
    expect(mocks.storageV2SecretVaultService.waitForIdle).toHaveBeenCalledTimes(1)
    expect(mocks.storageV2Database.createSnapshot).toHaveBeenCalledWith('app-data-migration')
  })

  it('copies an external active Data root instead of a stale Data directory under old userData', async () => {
    const staleDataRoot = path.join(oldPath, 'Data')
    const externalDataRoot = path.join(tmpDir, 'external-active-data-root')
    fs.mkdirSync(staleDataRoot, { recursive: true })
    fs.writeFileSync(path.join(staleDataRoot, 'agents.db'), 'stale-agent-data')
    fs.mkdirSync(externalDataRoot, { recursive: true })
    fs.writeFileSync(path.join(externalDataRoot, 'agents.db'), 'active-agent-data')
    fs.mkdirSync(path.join(oldPath, 'Local Storage'), { recursive: true })
    fs.writeFileSync(path.join(oldPath, 'Local Storage', 'leveldb'), 'local-storage')

    mocks.storageV2DataRootService.resolveDataRoot.mockReturnValue({ dataRoot: externalDataRoot })

    await service.copyUserData(oldPath, newPath, [])

    expect(fs.readFileSync(path.join(newPath, 'Data', 'agents.db'), 'utf-8')).toBe('active-agent-data')
    expect(fs.readFileSync(path.join(newPath, 'Local Storage', 'leveldb'), 'utf-8')).toBe('local-storage')
  })

  it('rejects custom app data paths inside the active Storage v2 data root', async () => {
    const activeDataRoot = path.join(oldPath, 'Data')
    const nestedAppDataPath = path.join(activeDataRoot, 'nested-user-data')
    fs.mkdirSync(activeDataRoot, { recursive: true })
    fs.writeFileSync(path.join(activeDataRoot, 'main.db'), 'live-main-db')

    mocks.storageV2DataRootService.resolveDataRoot.mockReturnValue({ dataRoot: activeDataRoot })

    await expect(service.copyUserData(oldPath, nestedAppDataPath)).rejects.toThrow(
      'New app data path cannot be inside the active Storage v2 data root'
    )

    expect(fs.existsSync(nestedAppDataPath)).toBe(false)
    expect(mocks.storageV2Database.createSnapshot).not.toHaveBeenCalled()
  })
})
