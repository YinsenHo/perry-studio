import { loggerService } from '@logger'
import type { Middleware } from '@reduxjs/toolkit'

import { getStorageV2LocalStorageSnapshot } from './StorageV2LocalStorageSnapshot'

const logger = loggerService.withContext('StorageV2MirrorService')

type ReduxAction = {
  type?: string
  meta?: {
    fromSync?: boolean
  }
}

type StateGetter = () => Record<string, any>

type MirrorScheduleOptions = {
  pruneMissing?: boolean
}

const MIRRORED_ACTION_PREFIXES = [
  'backup/',
  'codeTools/',
  'copilot/',
  'settings/',
  'llm/',
  'assistants/',
  'inputTools/',
  'knowledge/',
  'memory/',
  'minApps/',
  'mcp/',
  'note/',
  'nutstore/',
  'ocr/',
  'openclaw/',
  'paintings/',
  'preprocess/',
  'selectionStore/',
  'shortcuts/',
  'translate/',
  'websearch/'
]
const IMMEDIATE_MIRRORED_ACTION_PREFIXES = [
  'assistants/addAssistant',
  'assistants/addAssistantPreset',
  'assistants/insertAssistant',
  'assistants/removeAssistant',
  'assistants/removeAssistantPreset',
  'assistants/setModel',
  'assistants/updateAssistant',
  'assistants/updateAssistantPreset',
  'assistants/updateAssistantPresetSettings',
  'assistants/updateAssistantSettings',
  'assistants/updateAssistants',
  'assistants/updateDefaultAssistant',
  'backup/',
  'codeTools/',
  'copilot/',
  'inputTools/',
  'knowledge/',
  'llm/',
  'memory/',
  'mcp/',
  'minApps/',
  'note/',
  'nutstore/',
  'ocr/',
  'openclaw/',
  'paintings/',
  'preprocess/',
  'selectionStore/',
  'settings/',
  'shortcuts/',
  'translate/',
  'websearch/'
]
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
      backup: cloneJson(state.backup ?? {}),
      codeTools: cloneJson(state.codeTools ?? {}),
      copilot: cloneJson(state.copilot ?? {}),
      inputTools: cloneJson(state.inputTools ?? {}),
      knowledge: cloneJson(state.knowledge ?? {}),
      memory: cloneJson(state.memory ?? {}),
      minApps: cloneJson(state.minapps ?? {}),
      mcp: cloneJson(state.mcp ?? {}),
      note: cloneJson(state.note ?? {}),
      nutstore: cloneJson(state.nutstore ?? {}),
      ocr: cloneJson(state.ocr ?? {}),
      openclaw: cloneJson(state.openclaw ?? {}),
      paintings: cloneJson(state.paintings ?? {}),
      preprocess: cloneJson(state.preprocess ?? {}),
      selectionStore: cloneJson(state.selectionStore ?? {}),
      shortcuts: cloneJson(state.shortcuts ?? {}),
      translate: cloneJson(state.translate ?? {}),
      websearch: cloneJson(state.websearch ?? {})
    },
    localStorage: getStorageV2LocalStorageSnapshot()
  }
}

function shouldMirrorAction(action: ReduxAction) {
  if (!action.type || action.meta?.fromSync) return false
  return MIRRORED_ACTION_PREFIXES.some((prefix) => action.type!.startsWith(prefix))
}

function shouldMirrorActionImmediately(action: ReduxAction) {
  if (!action.type || action.meta?.fromSync) return false
  return IMMEDIATE_MIRRORED_ACTION_PREFIXES.some((prefix) => action.type!.startsWith(prefix))
}

class StorageV2MirrorService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestGetState: StateGetter | null = null
  private lastSnapshotJson = ''
  private lastSnapshotPruneMissing: boolean | null = null
  private inflight: Promise<void> | null = null
  private needsFollowUp = false
  private suspended = false
  private paused = false
  private pendingPruneMissing: boolean | null = null
  private lastError: unknown = null

  createMiddleware(): Middleware {
    return (storeApi) => (next) => (action) => {
      const result = next(action)
      const reduxAction = action as ReduxAction

      if (!this.suspended && shouldMirrorAction(reduxAction)) {
        const mirrorImmediately = shouldMirrorActionImmediately(reduxAction)
        this.schedule(() => storeApi.getState() as Record<string, any>, mirrorImmediately ? 0 : DEFAULT_DEBOUNCE_MS, {
          pruneMissing: true
        })
        if (mirrorImmediately) {
          void this.flush()
        }
      }

      return result
    }
  }

  schedule(getState: StateGetter, debounceMs = DEFAULT_DEBOUNCE_MS, options: MirrorScheduleOptions = {}) {
    if (this.suspended) return
    this.latestGetState = getState
    if (this.paused) return
    const pruneMissing = options.pruneMissing !== false
    this.pendingPruneMissing =
      this.pendingPruneMissing === null ? pruneMissing : this.pendingPruneMissing || pruneMissing

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, debounceMs)
  }

  scheduleStartupMirror(getState: StateGetter) {
    this.schedule(getState, DEFAULT_DEBOUNCE_MS, { pruneMissing: false })
  }

  async flush() {
    if (this.suspended) return
    if (this.paused) return
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

  async flushStrict() {
    await this.flush()

    if (!this.hasStrictPendingWork()) return

    if (!window.api?.storageV2) {
      throw new Error('Storage v2 API unavailable while Redux settings mirror work is pending')
    }

    if (this.lastError) {
      throw this.lastError instanceof Error
        ? this.lastError
        : new Error('Failed to mirror Redux settings to Storage v2')
    }

    throw new Error('Redux settings mirror work is still pending after strict flush')
  }

  private async mirrorNow() {
    if (!this.latestGetState || !window.api?.storageV2) return

    const snapshot = getMirrorSnapshot(this.latestGetState())
    const snapshotJson = JSON.stringify(snapshot)
    const pruneMissing = this.pendingPruneMissing !== false
    const needsPruneUpgrade = pruneMissing && this.lastSnapshotPruneMissing !== true
    if (snapshotJson === this.lastSnapshotJson && !needsPruneUpgrade) {
      this.pendingPruneMissing = null
      return
    }

    try {
      await window.api.storageV2.importLegacyReduxSnapshot(snapshot, { dryRun: false, pruneMissing })
      this.pendingPruneMissing = null
      this.lastSnapshotJson = snapshotJson
      this.lastSnapshotPruneMissing = pruneMissing
      this.lastError = null
      logger.debug('Mirrored Redux settings to Storage v2')
    } catch (error) {
      this.lastError = error
      this.scheduleRetry()
      logger.warn('Failed to mirror Redux settings to Storage v2', error as Error)
    }
  }

  private scheduleRetry() {
    if (this.suspended || this.paused || this.timer) return

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, DEFAULT_DEBOUNCE_MS)
  }

  private hasStrictPendingWork() {
    return this.timer !== null || this.pendingPruneMissing !== null
  }

  suspendUntilReload() {
    this.suspended = true
    this.paused = false
    this.latestGetState = null
    this.needsFollowUp = false
    this.pendingPruneMissing = null
    this.lastSnapshotPruneMissing = null
    this.lastError = null

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  pauseRuntimeMirroring() {
    if (this.suspended) return
    this.paused = true

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  resumeRuntimeMirroring() {
    if (this.suspended) return
    this.paused = false
  }
}

export const storageV2MirrorService = new StorageV2MirrorService()
