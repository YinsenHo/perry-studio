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
    const agent = await storageV2LegacyAgentDbImportService.importSnapshot({
      dryRun: false,
      createSnapshot,
      pruneMissing: false
    })
    const appData = await storageV2LegacyAppDbImportService.importSnapshot({
      dryRun: false,
      createSnapshot,
      pruneMissing: false
    })

    return {
      generatedAt: new Date().toISOString(),
      agent,
      appData
    }
  }
}

export const storageV2StartupSeedService = new StorageV2StartupSeedService()
