import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  importAgentDb: vi.fn(),
  importAppDb: vi.fn()
}))

vi.mock('../AgentDbMirrorService', () => ({
  storageV2AgentDbMirrorService: {
    flush: mocks.flush
  }
}))

vi.mock('../LegacyAgentDbImportService', () => ({
  storageV2LegacyAgentDbImportService: {
    importSnapshot: mocks.importAgentDb
  }
}))

vi.mock('../LegacyAppDbImportService', () => ({
  storageV2LegacyAppDbImportService: {
    importSnapshot: mocks.importAppDb
  }
}))

import { StorageV2StartupSeedService } from '../StartupSeedService'

function agentReport(overrides: Record<string, unknown> = {}) {
  return {
    dryRun: false,
    sourceDbPath: '/data/agents.db',
    agentCount: 1,
    sessionCount: 1,
    sessionMessageCount: 1,
    skillCount: 0,
    agentSkillCount: 0,
    taskCount: 0,
    taskRunLogCount: 0,
    channelCount: 0,
    importedAgentCount: 1,
    importedSessionCount: 1,
    importedSessionMessageCount: 1,
    importedSkillCount: 0,
    importedAgentSkillCount: 0,
    importedTaskCount: 0,
    importedTaskRunLogCount: 0,
    importedChannelCount: 0,
    secretCandidateCount: 0,
    importedSecretCount: 0,
    skippedSecretCount: 0,
    warnings: [],
    ...overrides
  }
}

function appReport(overrides: Record<string, unknown> = {}) {
  return {
    dryRun: false,
    sourceDbPath: '/data/app.db',
    recordCount: 1,
    cacheCount: 1,
    syncStateCount: 0,
    syncConflictCount: 0,
    workbenchShortcutCount: 0,
    importedRecordCount: 1,
    importedCacheCount: 1,
    importedSyncStateCount: 0,
    importedSyncConflictCount: 0,
    importedWorkbenchShortcutCount: 0,
    secretCandidateCount: 0,
    importedSecretCount: 0,
    skippedSecretCount: 0,
    warnings: [],
    ...overrides
  }
}

describe('StorageV2StartupSeedService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.flush.mockResolvedValue(undefined)
    mocks.importAgentDb.mockResolvedValue(agentReport())
    mocks.importAppDb.mockResolvedValue(appReport())
  })

  it('flushes pending agent mirrors and imports legacy runtime databases sequentially', async () => {
    const events: string[] = []
    mocks.flush.mockImplementation(async () => {
      events.push('flush')
    })
    mocks.importAgentDb.mockImplementation(async () => {
      events.push('agent')
      return agentReport()
    })
    mocks.importAppDb.mockImplementation(async () => {
      events.push('app')
      return appReport()
    })

    const report = await new StorageV2StartupSeedService().seedFromLegacyRuntimeDatabases()

    expect(events).toEqual(['flush', 'agent', 'app'])
    expect(mocks.importAgentDb).toHaveBeenCalledWith({ dryRun: false, createSnapshot: false, pruneMissing: false })
    expect(mocks.importAppDb).toHaveBeenCalledWith({ dryRun: false, createSnapshot: false, pruneMissing: false })
    expect(report.generatedAt).toEqual(expect.any(String))
    expect(report.agent.sourceDbPath).toBe('/data/agents.db')
    expect(report.appData.sourceDbPath).toBe('/data/app.db')
  })

  it('can create snapshots when explicitly requested', async () => {
    await new StorageV2StartupSeedService().seedFromLegacyRuntimeDatabases({ createSnapshot: true })

    expect(mocks.importAgentDb).toHaveBeenCalledWith({ dryRun: false, createSnapshot: true, pruneMissing: false })
    expect(mocks.importAppDb).toHaveBeenCalledWith({ dryRun: false, createSnapshot: true, pruneMissing: false })
  })

  it('deduplicates concurrent startup seed requests', async () => {
    let resolveAgentImport!: (value: ReturnType<typeof agentReport>) => void
    mocks.importAgentDb.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAgentImport = resolve
        })
    )

    const service = new StorageV2StartupSeedService()
    const firstSeed = service.seedFromLegacyRuntimeDatabases()
    const secondSeed = service.seedFromLegacyRuntimeDatabases()

    expect(firstSeed).toBe(secondSeed)
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(mocks.importAgentDb).toHaveBeenCalledTimes(1)

    resolveAgentImport(agentReport())
    await Promise.all([firstSeed, secondSeed])

    expect(mocks.importAppDb).toHaveBeenCalledTimes(1)
  })
})
