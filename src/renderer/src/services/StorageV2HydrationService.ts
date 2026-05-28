import { loggerService } from '@logger'
import { type AssistantsState, hydrateAssistantsState } from '@renderer/store/assistants'
import { hydrateKnowledgeState, type KnowledgeState } from '@renderer/store/knowledge'
import { hydrateLlmState, type LlmState } from '@renderer/store/llm'
import { hydrateMcpState } from '@renderer/store/mcp'
import { hydrateMemoryState, type MemoryState } from '@renderer/store/memory'
import { hydrateNoteState, type NoteState } from '@renderer/store/note'
import { hydratePreprocessState, type PreprocessState } from '@renderer/store/preprocess'
import { hydrateSettingsState, type SettingsState } from '@renderer/store/settings'
import { hydrateWebSearchState, type WebSearchState } from '@renderer/store/websearch'
import type { MCPConfig } from '@renderer/types'

import { getStorageV2CoreSnapshot } from './StorageV2Service'

const logger = loggerService.withContext('StorageV2HydrationService')
const AUTO_HYDRATE_SETTING_KEY = 'storage_v2.runtime.auto_hydrate'

type RuntimeHydrationTarget = {
  dispatch: (
    action:
      | ReturnType<typeof hydrateAssistantsState>
      | ReturnType<typeof hydrateKnowledgeState>
      | ReturnType<typeof hydrateLlmState>
      | ReturnType<typeof hydrateMemoryState>
      | ReturnType<typeof hydrateMcpState>
      | ReturnType<typeof hydrateNoteState>
      | ReturnType<typeof hydratePreprocessState>
      | ReturnType<typeof hydrateSettingsState>
      | ReturnType<typeof hydrateWebSearchState>
  ) => unknown
  flush?: () => Promise<unknown>
}

type StorageV2CoreSnapshot = {
  generatedAt: string
  settings?: Partial<SettingsState>
  llm?: Partial<LlmState>
  assistants?: Partial<AssistantsState>
  redux?: {
    knowledge?: Partial<KnowledgeState>
    memory?: Partial<MemoryState>
    mcp?: Partial<MCPConfig>
    note?: Partial<NoteState>
    preprocess?: Partial<PreprocessState>
    websearch?: Partial<WebSearchState>
  }
  metadata?: {
    includeSecrets?: boolean
    settingCount?: number
    providerCount?: number
    assistantCount?: number
    topicCount?: number
    reduxSliceCount?: number
    missingSecretCount?: number
  }
}

type AutoHydrateResult =
  | {
      hydrated: true
      snapshot: StorageV2CoreSnapshot
    }
  | {
      hydrated: false
      reason: 'disabled' | 'empty'
    }

function parseAutoHydrateSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value && typeof value === 'object' && 'enabled' in value) {
    return (value as { enabled?: unknown }).enabled === true
  }
  return false
}

function hasCoreData(snapshot: StorageV2CoreSnapshot): boolean {
  const metadata = snapshot.metadata ?? {}
  return (
    Number(metadata.settingCount ?? 0) > 0 ||
    Number(metadata.providerCount ?? 0) > 0 ||
    Number(metadata.assistantCount ?? 0) > 0 ||
    Number(metadata.reduxSliceCount ?? 0) > 0
  )
}

async function getRuntimeSnapshot() {
  const snapshot = (await getStorageV2CoreSnapshot({ includeSecrets: true })) as StorageV2CoreSnapshot

  if (!hasCoreData(snapshot)) {
    throw new Error('Storage v2 has no core runtime data to restore.')
  }

  return snapshot
}

async function applyRuntimeSnapshot(snapshot: StorageV2CoreSnapshot, target: RuntimeHydrationTarget) {
  if (snapshot.settings) {
    target.dispatch(hydrateSettingsState(snapshot.settings))
  }

  if (snapshot.llm) {
    target.dispatch(hydrateLlmState(snapshot.llm))
  }

  if (snapshot.assistants) {
    target.dispatch(hydrateAssistantsState(snapshot.assistants))
  }

  if (snapshot.redux?.knowledge) {
    target.dispatch(hydrateKnowledgeState(snapshot.redux.knowledge))
  }

  if (snapshot.redux?.memory) {
    target.dispatch(hydrateMemoryState(snapshot.redux.memory))
  }

  if (snapshot.redux?.mcp) {
    target.dispatch(hydrateMcpState(snapshot.redux.mcp))
  }

  if (snapshot.redux?.note) {
    target.dispatch(hydrateNoteState(snapshot.redux.note))
  }

  if (snapshot.redux?.preprocess) {
    target.dispatch(hydratePreprocessState(snapshot.redux.preprocess))
  }

  if (snapshot.redux?.websearch) {
    target.dispatch(hydrateWebSearchState(snapshot.redux.websearch))
  }

  await target.flush?.()
}

export async function getStorageV2AutoHydrateEnabled(): Promise<boolean> {
  const value = await window.api.storageV2.getSetting(AUTO_HYDRATE_SETTING_KEY)
  return parseAutoHydrateSetting(value)
}

export async function setStorageV2AutoHydrateEnabled(enabled: boolean): Promise<boolean> {
  await window.api.storageV2.setSetting(
    AUTO_HYDRATE_SETTING_KEY,
    {
      enabled,
      updatedAt: new Date().toISOString()
    },
    'storage-v2'
  )
  return enabled
}

export async function hydrateRuntimeCacheFromStorageV2(target: RuntimeHydrationTarget): Promise<StorageV2CoreSnapshot> {
  const snapshot = await getRuntimeSnapshot()

  await applyRuntimeSnapshot(snapshot, target)
  logger.info('Hydrated runtime cache from Storage v2', snapshot.metadata ?? {})

  return snapshot
}

export async function maybeHydrateRuntimeCacheFromStorageV2(
  target: RuntimeHydrationTarget
): Promise<AutoHydrateResult> {
  if (!(await getStorageV2AutoHydrateEnabled())) {
    return {
      hydrated: false,
      reason: 'disabled'
    }
  }

  const snapshot = (await getStorageV2CoreSnapshot({ includeSecrets: true })) as StorageV2CoreSnapshot
  if (!hasCoreData(snapshot)) {
    return {
      hydrated: false,
      reason: 'empty'
    }
  }

  await applyRuntimeSnapshot(snapshot, target)
  logger.info('Auto hydrated runtime cache from Storage v2', snapshot.metadata ?? {})

  return {
    hydrated: true,
    snapshot
  }
}
