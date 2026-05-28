import * as AppDataDatabaseModule from '@main/services/appData/AppDataDatabase'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { storageV2AppDataLegacyProjectionService } from '../AppDataLegacyProjectionService'
import { StorageV2AppDataRuntimeRecoveryService } from '../AppDataRuntimeRecoveryService'
import { storageV2LegacyAppDbImportService } from '../LegacyAppDbImportService'
import { storageV2Database } from '../StorageV2Database'

function createCountClient(count: number) {
  return {
    execute: vi.fn(async () => ({
      rows: [{ count }],
      columns: [],
      columnTypes: []
    }))
  }
}

function createCountSequenceClient(counts: number[]) {
  let index = 0
  return {
    execute: vi.fn(async () => {
      const count = counts[Math.min(index, counts.length - 1)] ?? 0
      index++
      return {
        rows: [{ count }],
        columns: [],
        columnTypes: []
      }
    })
  }
}

function mockProjection() {
  return vi.spyOn(storageV2AppDataLegacyProjectionService, 'projectToLegacyRuntime').mockResolvedValue({
    appDbPath: '/tmp/app.db',
    archivedFiles: [],
    projectedRecordCount: 1,
    projectedCacheCount: 0,
    projectedSyncStateCount: 0,
    projectedSyncConflictCount: 0,
    projectedWorkbenchShortcutCount: 0,
    restoredSecretCount: 0,
    missingSecretCount: 0,
    warnings: []
  })
}

describe('StorageV2AppDataRuntimeRecoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('projects Storage v2 app records when the legacy app record list is empty', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(AppDataDatabaseModule, 'getAppDataDatabase').mockResolvedValue({
      getRawClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AppDataRuntimeRecoveryService().projectIfLegacyAppRecordListEmpty(
      undefined,
      'test'
    )

    expect(recovered).toBe(true)
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('seeds Storage v2 from the selected legacy app database before projecting an empty runtime', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountSequenceClient([0, 1])
    const projection = mockProjection()
    const importSnapshot = vi.spyOn(storageV2LegacyAppDbImportService, 'importSnapshot').mockResolvedValue({
      dryRun: false,
      sourceDbPath: '/tmp/old/app.db',
      recordCount: 1,
      cacheCount: 0,
      syncStateCount: 0,
      syncConflictCount: 0,
      workbenchShortcutCount: 0,
      importedRecordCount: 1,
      importedCacheCount: 0,
      importedSyncStateCount: 0,
      importedSyncConflictCount: 0,
      importedWorkbenchShortcutCount: 0,
      secretCandidateCount: 0,
      importedSecretCount: 0,
      skippedSecretCount: 0,
      warnings: []
    })
    vi.spyOn(AppDataDatabaseModule, 'getAppDataDatabase').mockResolvedValue({
      getRawClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AppDataRuntimeRecoveryService().projectIfLegacyAppRecordListEmpty(
      undefined,
      'test'
    )

    expect(recovered).toBe(true)
    expect(importSnapshot).toHaveBeenCalledWith({ dryRun: false, createSnapshot: false })
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('does not project when legacy app records already exist for the requested scope', async () => {
    const legacyClient = createCountClient(1)
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(AppDataDatabaseModule, 'getAppDataDatabase').mockResolvedValue({
      getRawClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AppDataRuntimeRecoveryService().projectIfLegacyAppRecordListEmpty(
      'agent-tools',
      'test'
    )

    expect(recovered).toBe(false)
    expect(storageClient.execute).not.toHaveBeenCalled()
    expect(projection).not.toHaveBeenCalled()
  })

  it('projects a specific missing app record when Storage v2 has that key', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    vi.spyOn(AppDataDatabaseModule, 'getAppDataDatabase').mockResolvedValue({
      getRawClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await new StorageV2AppDataRuntimeRecoveryService().projectIfAppRecordMissing(
      'agent-tools',
      'github',
      'test'
    )

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('key = ?'),
        args: ['legacy-app-record', 'app-record', 'agent-tools', 'github']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })

  it('rechecks a specific app record after an unrelated inflight projection found no rows', async () => {
    const legacyClient = createCountClient(0)
    const storageClient = createCountClient(1)
    const projection = mockProjection()
    const service = new StorageV2AppDataRuntimeRecoveryService()
    ;(service as any).projection = Promise.resolve(false).finally(() => {
      ;(service as any).projection = null
    })
    vi.spyOn(AppDataDatabaseModule, 'getAppDataDatabase').mockResolvedValue({
      getRawClient: async () => legacyClient
    } as any)
    vi.spyOn(storageV2Database, 'getClient').mockResolvedValue(storageClient as any)

    const recovered = await service.projectIfAppRecordMissing('agent-tools', 'github', 'test')

    expect(recovered).toBe(true)
    expect(storageClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('key = ?'),
        args: ['legacy-app-record', 'app-record', 'agent-tools', 'github']
      })
    )
    expect(projection).toHaveBeenCalledTimes(1)
  })
})
