import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, default: actual }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, default: actual }
})

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual, default: actual }
})

const mocks = vi.hoisted(() => ({
  agentProjection: {
    projectToLegacyRuntime: vi.fn()
  },
  appDataProjection: {
    projectToLegacyRuntime: vi.fn()
  },
  configManager: {
    hydrateFromStorageV2: vi.fn()
  },
  dataRootService: {
    activateDataRoot: vi.fn(),
    ensureDataRoot: vi.fn()
  },
  database: {
    close: vi.fn(),
    createSnapshot: vi.fn(),
    healthCheck: vi.fn(),
    initialize: vi.fn(),
    integrityReport: vi.fn(),
    pruneUnreferencedSecretVaultEntries: vi.fn(),
    waitForIdle: vi.fn()
  },
  fileProjection: {
    projectToLegacyRuntime: vi.fn()
  },
  knowledgeService: {
    closeAll: vi.fn()
  },
  memoryService: {
    close: vi.fn()
  },
  secretVault: {
    waitForIdle: vi.fn()
  },
  settingsRepository: {
    set: vi.fn()
  },
  statisticsService: {
    getStats: vi.fn()
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => (key === 'userData' ? '/mock/userData' : '/mock/unknown')),
    getVersion: vi.fn(() => '1.0.0'),
    name: 'Cherry Studio Pi'
  }
}))

vi.mock('../../ConfigManager', () => ({
  configManager: mocks.configManager
}))

vi.mock('../../KnowledgeService', () => ({
  default: mocks.knowledgeService
}))

vi.mock('../../memory/MemoryService', () => ({
  default: {
    getInstance: vi.fn(() => mocks.memoryService)
  }
}))

vi.mock('../AgentLegacyProjectionService', () => ({
  storageV2AgentLegacyProjectionService: mocks.agentProjection
}))

vi.mock('../AppDataLegacyProjectionService', () => ({
  storageV2AppDataLegacyProjectionService: mocks.appDataProjection
}))

vi.mock('../DataRootService', () => ({
  storageV2DataRootService: mocks.dataRootService
}))

vi.mock('../FileLegacyProjectionService', () => ({
  storageV2FileLegacyProjectionService: mocks.fileProjection
}))

vi.mock('../SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.secretVault
}))

vi.mock('../StatisticsService', () => ({
  storageV2StatisticsService: mocks.statisticsService
}))

vi.mock('../StorageV2Database', () => ({
  storageV2Database: mocks.database
}))

vi.mock('../StorageV2Repositories', () => ({
  storageV2SettingsRepository: mocks.settingsRepository
}))

import { StorageV2BackupService, type StorageV2BackupValidation } from '../BackupService'

function createValidation(backupPath: string): StorageV2BackupValidation {
  return {
    ok: true,
    backupPath,
    metadataPath: path.join(backupPath, 'metadata.json'),
    dbPath: path.join(backupPath, 'main.db'),
    manifestPath: path.join(backupPath, 'manifest.json'),
    reason: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    copiedDirectories: [],
    quickCheck: 'ok',
    integrityCheck: 'ok',
    missingBlobFileCount: 0,
    corruptBlobFileCount: 0,
    secretVaultSecretCount: 0,
    missingSecretRefCount: 0,
    invalidSecretRefCount: 0,
    orphanSecretVaultEntryCount: 0,
    issues: [],
    warnings: [],
    metadata: {
      format: 'cherry-studio-pi-storage-backup',
      version: 1
    }
  }
}

describe('StorageV2BackupService.createBackup', () => {
  let tmpDir: string
  let dataRoot: string
  let snapshotPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-v2-backup-'))
    dataRoot = path.join(tmpDir, 'Data')
    snapshotPath = path.join(tmpDir, 'snapshot.db')
    fs.mkdirSync(path.join(dataRoot, 'secrets'), { recursive: true })
    fs.writeFileSync(snapshotPath, 'snapshot-db')
    fs.writeFileSync(path.join(dataRoot, 'secrets', 'vault.json'), JSON.stringify({ version: 1, secrets: {} }))

    mocks.dataRootService.ensureDataRoot.mockReturnValue({
      dataRoot,
      manifest: { workspaceId: 'workspace-1' },
      source: 'current-user-data',
      candidates: []
    })
    mocks.database.healthCheck.mockResolvedValue({ ok: true })
    mocks.database.waitForIdle.mockResolvedValue(undefined)
    mocks.secretVault.waitForIdle.mockResolvedValue(undefined)
    mocks.database.pruneUnreferencedSecretVaultEntries.mockResolvedValue({
      beforeCount: 2,
      afterCount: 1,
      prunedCount: 1,
      prunedSecretIds: ['provider:stale:apiKey'],
      referencedSecretCount: 1,
      invalidSecretRefCount: 0,
      skippedSources: []
    })
    mocks.database.createSnapshot.mockResolvedValue({
      path: snapshotPath,
      reason: 'backup-test',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    mocks.knowledgeService.closeAll.mockResolvedValue(undefined)
    mocks.statisticsService.getStats.mockResolvedValue({ generatedAt: '2026-01-01T00:00:00.000Z', counts: {} })
    mocks.database.integrityReport.mockResolvedValue({
      ok: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
      quickCheck: 'ok',
      integrityCheck: 'ok',
      foreignKeyIssueCount: 0,
      issues: []
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('prunes unreferenced secrets before copying the vault into the backup', async () => {
    const result = await new StorageV2BackupService().createBackup('manual')

    expect(mocks.database.pruneUnreferencedSecretVaultEntries).toHaveBeenCalledTimes(1)
    expect(mocks.database.pruneUnreferencedSecretVaultEntries.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.database.createSnapshot.mock.invocationCallOrder[0]
    )

    const metadata = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'))
    expect(metadata.secretVaultPrune).toMatchObject({
      prunedCount: 1,
      prunedSecretIds: ['provider:stale:apiKey']
    })
  })
})

describe('StorageV2BackupService.restoreBackup', () => {
  let tmpDir: string
  let dataRoot: string
  let backupPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-v2-restore-'))
    dataRoot = path.join(tmpDir, 'Data')
    backupPath = path.join(tmpDir, 'backup')
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.mkdirSync(backupPath, { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'main.db'), 'current-db')
    fs.writeFileSync(path.join(dataRoot, 'manifest.json'), JSON.stringify({ workspaceId: 'current-workspace' }))
    fs.writeFileSync(path.join(backupPath, 'main.db'), 'backup-db')
    fs.writeFileSync(
      path.join(backupPath, 'manifest.json'),
      JSON.stringify({
        format: 'cherry-studio-pi-storage',
        version: 2,
        profileId: 'default',
        workspaceId: 'restored-workspace',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastOpenedBy: {
          appId: 'com.cherryai.cherrystudio-pi',
          productName: 'Cherry Studio Pi',
          version: '1.0.0'
        }
      })
    )

    mocks.dataRootService.ensureDataRoot.mockReturnValue({
      dataRoot,
      manifest: { workspaceId: 'current-workspace' },
      source: 'current-user-data',
      candidates: []
    })
    mocks.dataRootService.activateDataRoot.mockReturnValue({ workspaceId: 'restored-workspace' })
    mocks.database.waitForIdle.mockResolvedValue(undefined)
    mocks.database.initialize.mockResolvedValue(undefined)
    mocks.settingsRepository.set.mockResolvedValue(undefined)
    mocks.configManager.hydrateFromStorageV2.mockResolvedValue(undefined)
    mocks.knowledgeService.closeAll.mockResolvedValue(undefined)
    mocks.memoryService.close.mockResolvedValue(undefined)
    mocks.agentProjection.projectToLegacyRuntime.mockResolvedValue({ warnings: [] })
    mocks.fileProjection.projectToLegacyRuntime.mockResolvedValue({ warnings: [] })
    mocks.appDataProjection.projectToLegacyRuntime.mockResolvedValue({ warnings: [] })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reactivates the restored data root before reopening Storage v2', async () => {
    const service = new StorageV2BackupService()
    vi.spyOn(service, 'validateBackup').mockResolvedValue(createValidation(backupPath))
    vi.spyOn(service, 'createBackup').mockResolvedValue({
      path: path.join(tmpDir, 'pre-restore'),
      dbPath: path.join(tmpDir, 'pre-restore', 'main.db'),
      manifestPath: path.join(tmpDir, 'pre-restore', 'metadata.json'),
      reason: 'pre-restore',
      createdAt: '2026-01-01T00:00:00.000Z',
      copiedDirectories: []
    })

    const result = await service.restoreBackup(backupPath)

    expect(fs.readFileSync(path.join(dataRoot, 'main.db'), 'utf-8')).toBe('backup-db')
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'manifest.json'), 'utf-8')).workspaceId).toBe(
      'restored-workspace'
    )
    expect(mocks.dataRootService.activateDataRoot).toHaveBeenCalledWith(dataRoot)
    expect(mocks.dataRootService.activateDataRoot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.database.initialize.mock.invocationCallOrder[0]
    )
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'storage_v2.runtime.auto_hydrate',
      expect.objectContaining({
        enabled: true,
        reason: 'restore'
      }),
      'storage-v2'
    )
    expect(result.restoredFiles).toEqual(['main.db', 'manifest.json'])
    expect(result.requiresRestart).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('returns restore warnings instead of failing when legacy projection fails after main restore', async () => {
    const service = new StorageV2BackupService()
    vi.spyOn(service, 'validateBackup').mockResolvedValue(createValidation(backupPath))
    vi.spyOn(service, 'createBackup').mockResolvedValue({
      path: path.join(tmpDir, 'pre-restore'),
      dbPath: path.join(tmpDir, 'pre-restore', 'main.db'),
      manifestPath: path.join(tmpDir, 'pre-restore', 'metadata.json'),
      reason: 'pre-restore',
      createdAt: '2026-01-01T00:00:00.000Z',
      copiedDirectories: []
    })
    mocks.agentProjection.projectToLegacyRuntime.mockRejectedValueOnce(new Error('agents.db locked'))

    const result = await service.restoreBackup(backupPath)

    expect(result.warnings).toEqual([
      'Agent legacy runtime projection failed after Storage v2 restore: agents.db locked'
    ])
    expect(result.agentLegacyProjection.warnings).toEqual(result.warnings)
    expect(result.agentLegacyProjection.agentDbPath).toBe(path.join(result.dataRoot, 'agents.db'))
  })

  it('returns restore warnings instead of failing when the auto hydrate flag cannot be written', async () => {
    const service = new StorageV2BackupService()
    vi.spyOn(service, 'validateBackup').mockResolvedValue(createValidation(backupPath))
    vi.spyOn(service, 'createBackup').mockResolvedValue({
      path: path.join(tmpDir, 'pre-restore'),
      dbPath: path.join(tmpDir, 'pre-restore', 'main.db'),
      manifestPath: path.join(tmpDir, 'pre-restore', 'metadata.json'),
      reason: 'pre-restore',
      createdAt: '2026-01-01T00:00:00.000Z',
      copiedDirectories: []
    })
    mocks.settingsRepository.set.mockRejectedValueOnce(new Error('readonly database'))

    const result = await service.restoreBackup(backupPath)

    expect(result.warnings).toEqual(['Storage v2 auto hydrate flag update failed after restore: readonly database'])
    expect(result.requiresRestart).toBe(true)
  })
})
