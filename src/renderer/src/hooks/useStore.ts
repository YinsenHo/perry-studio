/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { CHERRYAI_PROVIDER } from '@renderer/config/providers'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  setAssistantsTabSortType,
  setShowAssistants,
  setShowTopics,
  toggleShowAssistants,
  toggleShowTopics
} from '@renderer/store/settings'
import type { AssistantsSortType } from '@renderer/types'

const flushStoreSettingsMirror = (reason: string) => {
  void flushStorageV2ReduxMirror(reason)
}

export function useShowAssistants() {
  const showAssistants = useAppSelector((state) => state.settings.showAssistants)
  const dispatch = useAppDispatch()

  return {
    showAssistants,
    setShowAssistants: (show: boolean) => {
      dispatch(setShowAssistants(show))
      flushStoreSettingsMirror('settings-show-assistants')
    },
    toggleShowAssistants: () => {
      dispatch(toggleShowAssistants())
      flushStoreSettingsMirror('settings-toggle-show-assistants')
    }
  }
}

export function useShowTopics() {
  const showTopics = useAppSelector((state) => state.settings.showTopics)
  const dispatch = useAppDispatch()

  return {
    showTopics,
    setShowTopics: (show: boolean) => {
      dispatch(setShowTopics(show))
      flushStoreSettingsMirror('settings-show-topics')
    },
    toggleShowTopics: () => {
      dispatch(toggleShowTopics())
      flushStoreSettingsMirror('settings-toggle-show-topics')
    }
  }
}

export function useAssistantsTabSortType() {
  const assistantsTabSortType = useAppSelector((state) => state.settings.assistantsTabSortType)
  const dispatch = useAppDispatch()

  return {
    assistantsTabSortType,
    setAssistantsTabSortType: (sortType: AssistantsSortType) => {
      dispatch(setAssistantsTabSortType(sortType))
      flushStoreSettingsMirror('settings-assistants-tab-sort-type')
    }
  }
}

export function getStoreProviders() {
  return store.getState().llm.providers.concat([CHERRYAI_PROVIDER])
}
