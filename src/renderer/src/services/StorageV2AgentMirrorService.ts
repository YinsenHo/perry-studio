import { loggerService } from '@logger'

const logger = loggerService.withContext('StorageV2AgentMirrorService')

const DEFAULT_DEBOUNCE_MS = 4000

class StorageV2AgentMirrorService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false
  private lastError: unknown = null

  schedule(debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended) return
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
    if (this.suspended) return
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

    if (!this.pending || !window.api?.storageV2) return

    this.pending = false
    this.inflight = this.mirrorNow().finally(() => {
      this.inflight = null
    })

    await this.inflight
  }

  async flushStrict() {
    await this.flush()

    if (!this.pending) return

    if (!window.api?.storageV2) {
      throw new Error('Storage v2 API unavailable while agent database mirror work is pending')
    }

    if (this.lastError) {
      throw this.lastError instanceof Error
        ? this.lastError
        : new Error('Failed to mirror agent database to Storage v2')
    }

    throw new Error('Agent database mirror work is still pending after strict flush')
  }

  private async mirrorNow() {
    try {
      await window.api.storageV2.importLegacyAgentDb({ dryRun: false, createSnapshot: false })
      this.lastError = null
      logger.debug('Mirrored agent database to Storage v2')
    } catch (error) {
      this.pending = true
      this.lastError = error
      this.schedule()
      logger.warn('Failed to mirror agent database to Storage v2', error as Error)
    }
  }

  suspendUntilReload() {
    this.suspended = true
    this.pending = false
    this.needsFollowUp = false
    this.lastError = null

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

export const storageV2AgentMirrorService = new StorageV2AgentMirrorService()
