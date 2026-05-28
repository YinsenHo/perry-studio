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
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import type { AssistantIconType, SendMessageShortcut, SettingsState } from '@renderer/store/settings'
import {
  setAssistantIconType,
  setAutoCheckUpdate as _setAutoCheckUpdate,
  setDisableHardwareAcceleration,
  setEnableDeveloperMode,
  setLaunchOnBoot,
  setLaunchToTray,
  setNavbarPosition,
  setPinTopicsToTop,
  setSendMessageShortcut as _setSendMessageShortcut,
  setSidebarIcons,
  setTargetLanguage,
  setTestChannel as _setTestChannel,
  setTestPlan as _setTestPlan,
  setTheme,
  setTopicPosition,
  setTray as _setTray,
  setTrayOnClose,
  setUseSystemTitleBar as _setUseSystemTitleBar,
  setWindowStyle
} from '@renderer/store/settings'
import type { SidebarIcon, ThemeMode, TranslateLanguageCode } from '@renderer/types'
import type { UpgradeChannel } from '@shared/config/constant'

const flushSettingsMirror = (reason: string) => {
  void flushStorageV2ReduxMirror(reason)
}

export function useSettings() {
  const settings = useAppSelector((state) => state.settings)
  const dispatch = useAppDispatch()

  return {
    ...settings,
    setSendMessageShortcut(shortcut: SendMessageShortcut) {
      dispatch(_setSendMessageShortcut(shortcut))
      flushSettingsMirror('settings-send-message-shortcut')
    },

    setLaunch(isLaunchOnBoot: boolean | undefined, isLaunchToTray: boolean | undefined = undefined) {
      let didUpdate = false
      if (isLaunchOnBoot !== undefined) {
        dispatch(setLaunchOnBoot(isLaunchOnBoot))
        void window.api.setLaunchOnBoot(isLaunchOnBoot)
        didUpdate = true
      }

      if (isLaunchToTray !== undefined) {
        dispatch(setLaunchToTray(isLaunchToTray))
        void window.api.setLaunchToTray(isLaunchToTray)
        didUpdate = true
      }

      if (didUpdate) {
        flushSettingsMirror('settings-launch')
      }
    },

    setTray(isShowTray: boolean | undefined, isTrayOnClose: boolean | undefined = undefined) {
      let didUpdate = false
      if (isShowTray !== undefined) {
        dispatch(_setTray(isShowTray))
        void window.api.setTray(isShowTray)
        didUpdate = true
      }
      if (isTrayOnClose !== undefined) {
        dispatch(setTrayOnClose(isTrayOnClose))
        void window.api.setTrayOnClose(isTrayOnClose)
        didUpdate = true
      }

      if (didUpdate) {
        flushSettingsMirror('settings-tray')
      }
    },

    setAutoCheckUpdate(isAutoUpdate: boolean) {
      dispatch(_setAutoCheckUpdate(isAutoUpdate))
      void window.api.setAutoUpdate(isAutoUpdate)
      flushSettingsMirror('settings-auto-check-update')
    },

    setTestPlan(isTestPlan: boolean) {
      dispatch(_setTestPlan(isTestPlan))
      void window.api.setTestPlan(isTestPlan)
      flushSettingsMirror('settings-test-plan')
    },

    setTestChannel(channel: UpgradeChannel) {
      dispatch(_setTestChannel(channel))
      void window.api.setTestChannel(channel)
      flushSettingsMirror('settings-test-channel')
    },

    setTheme(theme: ThemeMode) {
      dispatch(setTheme(theme))
      flushSettingsMirror('settings-theme')
    },
    setWindowStyle(windowStyle: 'transparent' | 'opaque') {
      dispatch(setWindowStyle(windowStyle))
      flushSettingsMirror('settings-window-style')
    },
    setTargetLanguage(targetLanguage: TranslateLanguageCode) {
      dispatch(setTargetLanguage(targetLanguage))
      flushSettingsMirror('settings-target-language')
    },
    setTopicPosition(topicPosition: 'left' | 'right') {
      dispatch(setTopicPosition(topicPosition))
      flushSettingsMirror('settings-topic-position')
    },
    setPinTopicsToTop(pinTopicsToTop: boolean) {
      dispatch(setPinTopicsToTop(pinTopicsToTop))
      flushSettingsMirror('settings-pin-topics-to-top')
    },
    updateSidebarIcons(icons: { visible: SidebarIcon[]; disabled: SidebarIcon[] }) {
      dispatch(setSidebarIcons(icons))
      flushSettingsMirror('settings-sidebar-icons')
    },
    updateSidebarVisibleIcons(icons: SidebarIcon[]) {
      dispatch(setSidebarIcons({ visible: icons }))
      flushSettingsMirror('settings-sidebar-visible-icons')
    },
    updateSidebarDisabledIcons(icons: SidebarIcon[]) {
      dispatch(setSidebarIcons({ disabled: icons }))
      flushSettingsMirror('settings-sidebar-disabled-icons')
    },
    setAssistantIconType(assistantIconType: AssistantIconType) {
      dispatch(setAssistantIconType(assistantIconType))
      flushSettingsMirror('settings-assistant-icon-type')
    },
    setDisableHardwareAcceleration(disableHardwareAcceleration: boolean) {
      dispatch(setDisableHardwareAcceleration(disableHardwareAcceleration))
      void window.api.setDisableHardwareAcceleration(disableHardwareAcceleration)
      flushSettingsMirror('settings-disable-hardware-acceleration')
    },
    setUseSystemTitleBar(useSystemTitleBar: boolean) {
      dispatch(_setUseSystemTitleBar(useSystemTitleBar))
      void window.api.setUseSystemTitleBar(useSystemTitleBar)
      flushSettingsMirror('settings-use-system-title-bar')
    }
  }
}

export function useMessageStyle() {
  const { messageStyle } = useSettings()
  const isBubbleStyle = messageStyle === 'bubble'

  return {
    isBubbleStyle
  }
}

export const getStoreSetting = <K extends keyof SettingsState>(key: K): SettingsState[K] => {
  return store.getState().settings[key]
}

export const useEnableDeveloperMode = () => {
  const enableDeveloperMode = useAppSelector((state) => state.settings.enableDeveloperMode)
  const dispatch = useAppDispatch()

  return {
    enableDeveloperMode,
    setEnableDeveloperMode: (enableDeveloperMode: boolean) => {
      dispatch(setEnableDeveloperMode(enableDeveloperMode))
      void window.api.config.set('enableDeveloperMode', enableDeveloperMode)
      flushSettingsMirror('settings-developer-mode')
    }
  }
}

export const getEnableDeveloperMode = () => {
  return store.getState().settings.enableDeveloperMode
}

export const useNavbarPosition = () => {
  const navbarPosition = useAppSelector((state) => state.settings.navbarPosition)
  const dispatch = useAppDispatch()
  const isLeftNavbar = navbarPosition === 'left'

  return {
    navbarPosition,
    isLeftNavbar,
    // Cherry Studio Pi keeps the primary navigation on the left, while tabs are always handled by the top tab shell.
    isTopNavbar: navbarPosition === 'top' || isLeftNavbar,
    setNavbarPosition: (position: 'left' | 'top') => {
      dispatch(setNavbarPosition(position))
      flushSettingsMirror('settings-navbar-position')
    }
  }
}
