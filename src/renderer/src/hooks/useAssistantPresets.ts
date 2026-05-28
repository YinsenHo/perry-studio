import { loggerService } from '@logger'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addAssistantPreset,
  removeAssistantPreset,
  setAssistantPresets,
  updateAssistantPreset,
  updateAssistantPresetSettings
} from '@renderer/store/assistants'
import type { AssistantPreset, AssistantSettings } from '@renderer/types'

const logger = loggerService.withContext('useAssistantPresets')

function flushPresetMirror(reason: string): void
function flushPresetMirror(reason: string, options: { strict: true }): Promise<void>
function flushPresetMirror(reason: string, options?: { strict?: boolean }) {
  const task = flushStorageV2ReduxMirror(reason, options)
  if (options?.strict) return task
  void task
  return undefined
}

function ensurePresetsArray(storedPresets: unknown): AssistantPreset[] {
  if (Array.isArray(storedPresets)) {
    return storedPresets
  }
  logger.warn('Unexpected data type from state.assistants.presets, falling back to empty list.', {
    type: typeof storedPresets,
    value: storedPresets
  })
  return []
}

export function useAssistantPresets() {
  const storedPresets = useAppSelector((state) => state.assistants.presets)
  const presets = ensurePresetsArray(storedPresets)
  const dispatch = useAppDispatch()

  return {
    presets,
    setAssistantPresets: (presets: AssistantPreset[]) => {
      dispatch(setAssistantPresets(presets))
      flushPresetMirror('assistant-presets-set')
    },
    addAssistantPreset: (preset: AssistantPreset) => {
      dispatch(addAssistantPreset(preset))
      flushPresetMirror('assistant-preset-add')
    },
    removeAssistantPreset: async (id: string) => {
      dispatch(removeAssistantPreset({ id }))
      await flushPresetMirror('assistant-preset-remove', { strict: true })
    }
  }
}

export function useAssistantPreset(id: string) {
  const storedPresets = useAppSelector((state) => state.assistants.presets)
  const presets = ensurePresetsArray(storedPresets)
  const preset = presets.find((a) => a.id === id)
  const dispatch = useAppDispatch()

  if (!preset) {
    logger.warn(`Assistant preset with id ${id} not found in state.`)
  }

  return {
    preset: preset,
    updateAssistantPreset: (preset: AssistantPreset) => {
      dispatch(updateAssistantPreset(preset))
      flushPresetMirror('assistant-preset-update')
    },
    updateAssistantPresetSettings: (settings: Partial<AssistantSettings>) => {
      if (!preset) {
        logger.warn(`Failed to update assistant preset settings because preset with id ${id} is missing.`)
        return
      }
      dispatch(updateAssistantPresetSettings({ assistantId: preset.id, settings }))
      flushPresetMirror('assistant-preset-settings-update')
    }
  }
}
