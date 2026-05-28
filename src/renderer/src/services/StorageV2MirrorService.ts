import { loggerService } from '@logger'
import type { Middleware } from '@reduxjs/toolkit'

const logger = loggerService.withContext('StorageV2MirrorService')

type ReduxAction = {
  type?: string
  meta?: {
    fromSync?: boolean
  }
}

type StateGetter = () => Record<string, any>

const MIRRORED_ACTION_PREFIXES = [
  'settings/',
  'llm/',
  'assistants/',
  'knowledge/',
  'memory/',
  'mcp/',
  'note/',
  'preprocess/',
  'websearch/'
]
const REHYDRATE_ACTION = 'persist/REHYDRATE'
const DEFAULT_DEBOUNCE_MS = 1200

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stripAssistantTopics<T extends Record<string, any> | undefined>(assistant: T): T {
  if (!assistant || typeof assistant !== 'object') return assistant
  return {
    ...assistant,
    topics: []
  }
}

function sanitizeAssistantsState(assistants: Record<string, any>) {
  return {
    ...assistants,
    defaultAssistant: stripAssistantTopics(assistants.defaultAssistant),
    assistants: Array.isArray(assistants.assistants) ? assistants.assistants.map(stripAssistantTopics) : [],
    presets: Array.isArray(assistants.presets) ? assistants.presets.map(stripAssistantTopics) : []
  }
}

function getMirrorSnapshot(state: Record<string, any>) {
  return {
    settings: cloneJson(state.settings ?? {}),
    llm: cloneJson(state.llm ?? {}),
    assistants: sanitizeAssistantsState(cloneJson(state.assistants ?? {})),
    redux: {
      knowledge: cloneJson(state.knowledge ?? {}),
      memory: cloneJson(state.memory ?? {}),
      mcp: cloneJson(state.mcp ?? {}),
      note: cloneJson(state.note ?? {}),
      preprocess: cloneJson(state.preprocess ?? {}),
      websearch: cloneJson(state.websearch ?? {})
    }
  }
}

function shouldMirrorAction(action: ReduxAction) {
  if (!action.type || action.meta?.fromSync) return false
  if (action.type === REHYDRATE_ACTION) return true
  return MIRRORED_ACTION_PREFIXES.some((prefix) => action.type!.startsWith(prefix))
}

class StorageV2MirrorService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestGetState: StateGetter | null = null
  private lastSnapshotJson = ''
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false

  createMiddleware(): Middleware {
    return (storeApi) => (next) => (action) => {
      const result = next(action)
      const reduxAction = action as ReduxAction

      if (!this.suspended && shouldMirrorAction(reduxAction)) {
        this.schedule(() => storeApi.getState() as Record<string, any>)
      }

      return result
    }
  }

  schedule(getState: StateGetter, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (this.suspended) return
    this.latestGetState = getState

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
    if (!this.latestGetState) return

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

    this.inflight = this.mirrorNow().finally(() => {
      this.inflight = null
    })

    await this.inflight
  }

  private async mirrorNow() {
    if (!this.latestGetState || !window.api?.storageV2) return

    const snapshot = getMirrorSnapshot(this.latestGetState())
    const snapshotJson = JSON.stringify(snapshot)
    if (snapshotJson === this.lastSnapshotJson) return

    try {
      await window.api.storageV2.importLegacyReduxSnapshot(snapshot, { dryRun: false })
      this.lastSnapshotJson = snapshotJson
      logger.debug('Mirrored Redux settings to Storage v2')
    } catch (error) {
      logger.warn('Failed to mirror Redux settings to Storage v2', error as Error)
    }
  }

  suspendUntilReload() {
    this.suspended = true
    this.latestGetState = null
    this.needsFollowUp = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

export const storageV2MirrorService = new StorageV2MirrorService()
