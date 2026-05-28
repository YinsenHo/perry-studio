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
import { loggerService } from '@logger'
import type { UpgradeChannel } from '@shared/config/constant'
import { defaultLanguage, ZOOM_SHORTCUTS } from '@shared/config/constant'
import type { LanguageVarious, Shortcut } from '@types'
import { ThemeMode } from '@types'
import { app } from 'electron'
import Store from 'electron-store'
import { v7 as uuid } from 'uuid'

import { locales } from '../utils/locales'
import { storageV2SettingsRepository } from './storageV2/StorageV2Repositories'

const logger = loggerService.withContext('ConfigManager')
const STORAGE_V2_CONFIG_SCOPE = 'config'
const STORAGE_V2_CONFIG_PREFIX = 'config.'
const STORAGE_V2_CONFIG_RETRY_MS = 5000

export enum ConfigKeys {
  Language = 'language',
  Theme = 'theme',
  LaunchToTray = 'launchToTray',
  Tray = 'tray',
  TrayOnClose = 'trayOnClose',
  ZoomFactor = 'ZoomFactor',
  Shortcuts = 'shortcuts',
  ClickTrayToShowQuickAssistant = 'clickTrayToShowQuickAssistant',
  EnableQuickAssistant = 'enableQuickAssistant',
  AutoUpdate = 'autoUpdate',
  TestPlan = 'testPlan',
  TestChannel = 'testChannel',
  EnableDataCollection = 'enableDataCollection',
  SelectionAssistantEnabled = 'selectionAssistantEnabled',
  SelectionAssistantTriggerMode = 'selectionAssistantTriggerMode',
  SelectionAssistantFollowToolbar = 'selectionAssistantFollowToolbar',
  SelectionAssistantRemeberWinSize = 'selectionAssistantRemeberWinSize',
  SelectionAssistantFilterMode = 'selectionAssistantFilterMode',
  SelectionAssistantFilterList = 'selectionAssistantFilterList',
  DisableHardwareAcceleration = 'disableHardwareAcceleration',
  UseSystemTitleBar = 'useSystemTitleBar',
  Proxy = 'proxy',
  EnableDeveloperMode = 'enableDeveloperMode',
  ClientId = 'clientId',
  GitBashPath = 'gitBashPath',
  GitBashPathSource = 'gitBashPathSource' // 'manual' | 'auto' | null
}

export class ConfigManager {
  private store: Store
  private subscribers: Map<string, Array<(newValue: any) => void>> = new Map()
  private pendingStorageV2Config = new Map<string, unknown>()
  private storageV2ConfigTimer: ReturnType<typeof setTimeout> | null = null
  private storageV2ConfigInflight: Promise<void> | null = null
  private storageV2ConfigNeedsFollowUp = false
  private lastStorageV2ConfigError: unknown = null

  constructor() {
    this.store = new Store()
  }

  getLanguage(): LanguageVarious {
    const locale = Object.keys(locales).includes(app.getLocale()) ? app.getLocale() : defaultLanguage
    return this.get(ConfigKeys.Language, locale) as LanguageVarious
  }

  setLanguage(lang: LanguageVarious) {
    this.setAndNotify(ConfigKeys.Language, lang)
  }

  getTheme(): ThemeMode {
    return this.get(ConfigKeys.Theme, ThemeMode.system)
  }

  setTheme(theme: ThemeMode) {
    this.set(ConfigKeys.Theme, theme)
  }

  getLaunchToTray(): boolean {
    return !!this.get(ConfigKeys.LaunchToTray, false)
  }

  setLaunchToTray(value: boolean) {
    this.set(ConfigKeys.LaunchToTray, value)
  }

  getTray(): boolean {
    return !!this.get(ConfigKeys.Tray, true)
  }

  setTray(value: boolean) {
    this.setAndNotify(ConfigKeys.Tray, value)
  }

  getTrayOnClose(): boolean {
    return !!this.get(ConfigKeys.TrayOnClose, true)
  }

  setTrayOnClose(value: boolean) {
    this.set(ConfigKeys.TrayOnClose, value)
  }

  getZoomFactor(): number {
    return this.get<number>(ConfigKeys.ZoomFactor, 1)
  }

  setZoomFactor(factor: number) {
    this.setAndNotify(ConfigKeys.ZoomFactor, factor)
  }

  subscribe<T>(key: string, callback: (newValue: T) => void) {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, [])
    }
    this.subscribers.get(key)!.push(callback)
  }

  unsubscribe<T>(key: string, callback: (newValue: T) => void) {
    const subscribers = this.subscribers.get(key)
    if (subscribers) {
      this.subscribers.set(
        key,
        subscribers.filter((subscriber) => subscriber !== callback)
      )
    }
  }

  private notifySubscribers<T>(key: string, newValue: T) {
    const subscribers = this.subscribers.get(key)
    if (subscribers) {
      subscribers.forEach((subscriber) => subscriber(newValue))
    }
  }

  getShortcuts() {
    return this.get(ConfigKeys.Shortcuts, ZOOM_SHORTCUTS) as Shortcut[] | []
  }

  setShortcuts(shortcuts: Shortcut[]) {
    this.setAndNotify(
      ConfigKeys.Shortcuts,
      shortcuts.filter((shortcut) => shortcut.system)
    )
  }

  getClickTrayToShowQuickAssistant(): boolean {
    return this.get<boolean>(ConfigKeys.ClickTrayToShowQuickAssistant, false)
  }

  setClickTrayToShowQuickAssistant(value: boolean) {
    this.set(ConfigKeys.ClickTrayToShowQuickAssistant, value)
  }

  getEnableQuickAssistant(): boolean {
    return this.get(ConfigKeys.EnableQuickAssistant, false)
  }

  setEnableQuickAssistant(value: boolean) {
    this.setAndNotify(ConfigKeys.EnableQuickAssistant, value)
  }

  getAutoUpdate(): boolean {
    return this.get<boolean>(ConfigKeys.AutoUpdate, true)
  }

  setAutoUpdate(value: boolean) {
    this.set(ConfigKeys.AutoUpdate, value)
  }

  getTestPlan(): boolean {
    return this.get<boolean>(ConfigKeys.TestPlan, false)
  }

  setTestPlan(value: boolean) {
    this.set(ConfigKeys.TestPlan, value)
  }

  getTestChannel(): UpgradeChannel {
    return this.get<UpgradeChannel>(ConfigKeys.TestChannel)
  }

  setTestChannel(value: UpgradeChannel) {
    this.set(ConfigKeys.TestChannel, value)
  }

  getEnableDataCollection(): boolean {
    return this.get<boolean>(ConfigKeys.EnableDataCollection, false)
  }

  setEnableDataCollection(value: boolean) {
    this.set(ConfigKeys.EnableDataCollection, value)
  }

  // Selection Assistant: is enabled the selection assistant
  getSelectionAssistantEnabled(): boolean {
    return this.get<boolean>(ConfigKeys.SelectionAssistantEnabled, false)
  }

  setSelectionAssistantEnabled(value: boolean) {
    this.setAndNotify(ConfigKeys.SelectionAssistantEnabled, value)
  }

  // Selection Assistant: trigger mode (selected, ctrlkey)
  getSelectionAssistantTriggerMode(): string {
    return this.get<string>(ConfigKeys.SelectionAssistantTriggerMode, 'selected')
  }

  setSelectionAssistantTriggerMode(value: string) {
    this.setAndNotify(ConfigKeys.SelectionAssistantTriggerMode, value)
  }

  // Selection Assistant: if action window position follow toolbar
  getSelectionAssistantFollowToolbar(): boolean {
    return this.get<boolean>(ConfigKeys.SelectionAssistantFollowToolbar, true)
  }

  setSelectionAssistantFollowToolbar(value: boolean) {
    this.setAndNotify(ConfigKeys.SelectionAssistantFollowToolbar, value)
  }

  getSelectionAssistantRemeberWinSize(): boolean {
    return this.get<boolean>(ConfigKeys.SelectionAssistantRemeberWinSize, false)
  }

  setSelectionAssistantRemeberWinSize(value: boolean) {
    this.setAndNotify(ConfigKeys.SelectionAssistantRemeberWinSize, value)
  }

  getSelectionAssistantFilterMode(): string {
    return this.get<string>(ConfigKeys.SelectionAssistantFilterMode, 'default')
  }

  setSelectionAssistantFilterMode(value: string) {
    this.setAndNotify(ConfigKeys.SelectionAssistantFilterMode, value)
  }

  getSelectionAssistantFilterList(): string[] {
    return this.get<string[]>(ConfigKeys.SelectionAssistantFilterList, [])
  }

  setSelectionAssistantFilterList(value: string[]) {
    this.setAndNotify(ConfigKeys.SelectionAssistantFilterList, value)
  }

  getDisableHardwareAcceleration(): boolean {
    return this.get<boolean>(ConfigKeys.DisableHardwareAcceleration, false)
  }

  setDisableHardwareAcceleration(value: boolean) {
    this.set(ConfigKeys.DisableHardwareAcceleration, value)
  }

  getUseSystemTitleBar(): boolean {
    return this.get<boolean>(ConfigKeys.UseSystemTitleBar, false)
  }

  setUseSystemTitleBar(value: boolean) {
    this.set(ConfigKeys.UseSystemTitleBar, value)
  }

  setAndNotify(key: string, value: unknown) {
    this.set(key, value, true)
  }

  getEnableDeveloperMode(): boolean {
    return this.get<boolean>(ConfigKeys.EnableDeveloperMode, false)
  }

  setEnableDeveloperMode(value: boolean) {
    this.set(ConfigKeys.EnableDeveloperMode, value)
  }

  getClientId(): string {
    let clientId = this.get<string>(ConfigKeys.ClientId)

    if (!clientId) {
      clientId = uuid()
      this.set(ConfigKeys.ClientId, clientId)
    }

    return clientId
  }

  async hydrateFromStorageV2(
    options: { overwrite?: boolean; pruneMissing?: boolean } = {}
  ): Promise<{ restoredCount: number; prunedCount: number }> {
    const records = await storageV2SettingsRepository.list(STORAGE_V2_CONFIG_SCOPE)
    const restoredKeys = new Set<string>()
    let restoredCount = 0
    let prunedCount = 0

    for (const record of records) {
      if (!record.key.startsWith(STORAGE_V2_CONFIG_PREFIX)) continue

      const key = record.key.slice(STORAGE_V2_CONFIG_PREFIX.length)
      if (!key) continue
      restoredKeys.add(key)
      if (!options.overwrite && this.store.has(key)) continue

      this.store.set(key, record.value)
      restoredCount++
    }

    if (options.pruneMissing && restoredKeys.size > 0) {
      for (const key of Object.keys(this.store.store)) {
        if (restoredKeys.has(key)) continue

        this.store.delete(key)
        prunedCount++
      }
    }

    return { restoredCount, prunedCount }
  }

  async mirrorAllToStorageV2(): Promise<{ mirroredCount: number }> {
    const entries = Object.entries(this.store.store)

    try {
      await Promise.all(entries.map(([key, value]) => this.setStorageV2Config(key, value)))
      for (const [key] of entries) {
        this.pendingStorageV2Config.delete(key)
      }
      this.lastStorageV2ConfigError = null
    } catch (error) {
      for (const [key, value] of entries) {
        if (!this.pendingStorageV2Config.has(key)) {
          this.pendingStorageV2Config.set(key, value)
        }
      }
      this.lastStorageV2ConfigError = error
      this.scheduleStorageV2ConfigRetry()
      throw error
    }

    return {
      mirroredCount: entries.length
    }
  }

  set(key: string, value: unknown, isNotify: boolean = false) {
    this.store.set(key, value)
    this.pendingStorageV2Config.set(key, value)
    void this.flushPendingStorageV2Config()
    isNotify && this.notifySubscribers(key, value)
  }

  get<T>(key: string, defaultValue?: T) {
    return this.store.get(key, defaultValue) as T
  }

  async flushPendingStorageV2Config() {
    if (this.storageV2ConfigTimer) {
      clearTimeout(this.storageV2ConfigTimer)
      this.storageV2ConfigTimer = null
    }

    if (this.storageV2ConfigInflight) {
      this.storageV2ConfigNeedsFollowUp = true
      await this.storageV2ConfigInflight
      if (this.storageV2ConfigNeedsFollowUp) {
        this.storageV2ConfigNeedsFollowUp = false
        await this.flushPendingStorageV2Config()
      }
      return
    }

    if (this.pendingStorageV2Config.size === 0) return

    const entries = Array.from(this.pendingStorageV2Config.entries())
    this.pendingStorageV2Config.clear()
    this.storageV2ConfigInflight = this.mirrorPendingStorageV2Config(entries).finally(() => {
      this.storageV2ConfigInflight = null
    })

    await this.storageV2ConfigInflight
  }

  async flushPendingStorageV2ConfigStrict() {
    await this.flushPendingStorageV2Config()

    if (this.pendingStorageV2Config.size > 0 && this.lastStorageV2ConfigError) {
      throw this.lastStorageV2ConfigError instanceof Error
        ? this.lastStorageV2ConfigError
        : new Error('Failed to mirror config settings to Storage v2')
    }
  }

  private async mirrorPendingStorageV2Config(entries: Array<[string, unknown]>) {
    try {
      await Promise.all(entries.map(([key, value]) => this.setStorageV2Config(key, value)))
      this.lastStorageV2ConfigError = null
    } catch (error) {
      for (const [key, value] of entries) {
        if (!this.pendingStorageV2Config.has(key)) {
          this.pendingStorageV2Config.set(key, value)
        }
      }
      this.lastStorageV2ConfigError = error
      this.scheduleStorageV2ConfigRetry()
      logger.warn('Failed to mirror config settings to Storage v2', {
        count: entries.length,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private scheduleStorageV2ConfigRetry() {
    if (this.storageV2ConfigTimer) return

    this.storageV2ConfigTimer = setTimeout(() => {
      this.storageV2ConfigTimer = null
      void this.flushPendingStorageV2Config()
    }, STORAGE_V2_CONFIG_RETRY_MS)
  }

  private async setStorageV2Config(key: string, value: unknown) {
    await storageV2SettingsRepository.set(`${STORAGE_V2_CONFIG_PREFIX}${key}`, value, STORAGE_V2_CONFIG_SCOPE)
  }
}

export const configManager = new ConfigManager()
