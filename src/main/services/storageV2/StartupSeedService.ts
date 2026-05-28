import { storageV2AgentDbMirrorService } from './AgentDbMirrorService'
import {
  type StorageV2LegacyAgentDbImportReport,
  storageV2LegacyAgentDbImportService
} from './LegacyAgentDbImportService'
import { type StorageV2LegacyAppDbImportReport, storageV2LegacyAppDbImportService } from './LegacyAppDbImportService'

export type StorageV2StartupSeedOptions = {
  createSnapshot?: boolean
}

export type StorageV2StartupSeedReport = {
  generatedAt: string
  agent: StorageV2LegacyAgentDbImportReport
  appData: StorageV2LegacyAppDbImportReport
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function failedAgentReport(error: unknown): StorageV2LegacyAgentDbImportReport {
  return {
    dryRun: false,
    sourceDbPath: null,
    agentCount: 0,
    sessionCount: 0,
    sessionMessageCount: 0,
    skillCount: 0,
    agentSkillCount: 0,
    taskCount: 0,
    taskRunLogCount: 0,
    channelCount: 0,
    importedAgentCount: 0,
    importedSessionCount: 0,
    importedSessionMessageCount: 0,
    importedSkillCount: 0,
    importedAgentSkillCount: 0,
    importedTaskCount: 0,
    importedTaskRunLogCount: 0,
    importedChannelCount: 0,
    secretCandidateCount: 0,
    importedSecretCount: 0,
    skippedSecretCount: 0,
    warnings: [`Legacy agents.db startup seed failed: ${errorMessage(error)}`]
  }
}

function failedAppDataReport(error: unknown): StorageV2LegacyAppDbImportReport {
  return {
    dryRun: false,
    sourceDbPath: null,
    recordCount: 0,
    cacheCount: 0,
    syncStateCount: 0,
    syncConflictCount: 0,
    workbenchShortcutCount: 0,
    importedRecordCount: 0,
    importedCacheCount: 0,
    importedSyncStateCount: 0,
    importedSyncConflictCount: 0,
    importedWorkbenchShortcutCount: 0,
    secretCandidateCount: 0,
    importedSecretCount: 0,
    skippedSecretCount: 0,
    warnings: [`Legacy app.db startup seed failed: ${errorMessage(error)}`]
  }
}

export class StorageV2StartupSeedService {
  private inFlight: Promise<StorageV2StartupSeedReport> | null = null

  seedFromLegacyRuntimeDatabases(options: StorageV2StartupSeedOptions = {}): Promise<StorageV2StartupSeedReport> {
    if (!this.inFlight) {
      this.inFlight = this.run(options).finally(() => {
        this.inFlight = null
      })
    }

    return this.inFlight
  }

  private async run(options: StorageV2StartupSeedOptions): Promise<StorageV2StartupSeedReport> {
    const createSnapshot = options.createSnapshot === true

    await storageV2AgentDbMirrorService.flush()
    const agent = await storageV2LegacyAgentDbImportService
      .importSnapshot({
        dryRun: false,
        createSnapshot,
        pruneMissing: false
      })
      .catch(failedAgentReport)
    const appData = await storageV2LegacyAppDbImportService
      .importSnapshot({
        dryRun: false,
        createSnapshot,
        pruneMissing: false
      })
      .catch(failedAppDataReport)

    return {
      generatedAt: new Date().toISOString(),
      agent,
      appData
    }
  }
}

export const storageV2StartupSeedService = new StorageV2StartupSeedService()
