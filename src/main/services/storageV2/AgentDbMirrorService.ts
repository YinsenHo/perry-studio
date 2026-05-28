import { loggerService } from '@logger'

import { storageV2AgentRuntimeRecoveryService } from './AgentRuntimeRecoveryService'
import { storageV2LegacyAgentDbImportService } from './LegacyAgentDbImportService'

const logger = loggerService.withContext('StorageV2AgentDbMirrorService')

const DEFAULT_DEBOUNCE_MS = 3000

class StorageV2AgentDbMirrorService {
  private timer: NodeJS.Timeout | null = null
  private pending = false
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private lastError: unknown = null

  schedule(debounceMs = DEFAULT_DEBOUNCE_MS) {
    this.pending = true

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, debounceMs)
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.inflight) {
      this.needsFollowUp = true
      await this.inflight
      if (this.needsFollowUp) {
        this.needsFollowUp = false
        await this.flush()
      }
      return
    }

    if (!this.pending) return

    this.pending = false
    this.inflight = this.mirrorNow().finally(() => {
      this.inflight = null
    })

    await this.inflight
  }

  async flushStrict() {
    this.schedule(0)
    await this.flush()

    if (this.pending) {
      throw this.lastError instanceof Error ? this.lastError : new Error('Failed to mirror agents.db to Storage v2')
    }
  }

  private async mirrorNow() {
    try {
      await storageV2AgentRuntimeRecoveryService.projectIfStorageHasAnyAgentRuntimeRows('agent-mirror-before-prune')
      await storageV2LegacyAgentDbImportService.importSnapshot({ dryRun: false, createSnapshot: false })
      this.lastError = null
      logger.debug('Mirrored agents.db to Storage v2')
    } catch (error) {
      this.pending = true
      this.lastError = error
      logger.warn('Failed to mirror agents.db to Storage v2', error as Error)
    }
  }
}

export const storageV2AgentDbMirrorService = new StorageV2AgentDbMirrorService()
