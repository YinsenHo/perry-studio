import { loggerService } from '@logger'

import { storageV2LegacyAgentDbImportService } from './LegacyAgentDbImportService'

const logger = loggerService.withContext('StorageV2AgentDbMirrorService')

const DEFAULT_DEBOUNCE_MS = 3000

class StorageV2AgentDbMirrorService {
  private timer: NodeJS.Timeout | null = null
  private pending = false
  private inflight: Promise<void> | null = null
  private needsFollowUp = false

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

  private async mirrorNow() {
    try {
      await storageV2LegacyAgentDbImportService.importSnapshot({ dryRun: false })
      logger.debug('Mirrored agents.db to Storage v2')
    } catch (error) {
      this.pending = true
      logger.warn('Failed to mirror agents.db to Storage v2', error as Error)
    }
  }
}

export const storageV2AgentDbMirrorService = new StorageV2AgentDbMirrorService()
