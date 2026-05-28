import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { storageV2Service } from './StorageService'

let registered = false

export function registerStorageV2IpcHandlers() {
  if (registered) return
  registered = true

  ipcMain.handle(IpcChannel.StorageV2_GetDataRoot, () => storageV2Service.getDataRoot())
  ipcMain.handle(IpcChannel.StorageV2_HealthCheck, () => storageV2Service.healthCheck())
  ipcMain.handle(IpcChannel.StorageV2_CreateSnapshot, (_event, reason?: string) =>
    storageV2Service.createSnapshot(reason)
  )
  ipcMain.handle(IpcChannel.StorageV2_CreateBackup, (_event, reason?: string) => storageV2Service.createBackup(reason))
  ipcMain.handle(IpcChannel.StorageV2_ValidateBackup, (_event, backupPath: string) =>
    storageV2Service.validateBackup(backupPath)
  )
  ipcMain.handle(IpcChannel.StorageV2_RestoreBackup, (_event, backupPath: string) =>
    storageV2Service.restoreBackup(backupPath)
  )
  ipcMain.handle(IpcChannel.StorageV2_GetMigrationAudit, () => storageV2Service.getMigrationAudit())
  ipcMain.handle(IpcChannel.StorageV2_GetStats, () => storageV2Service.getStats())
  ipcMain.handle(IpcChannel.StorageV2_GetIntegrityReport, () => storageV2Service.getIntegrityReport())
  ipcMain.handle(IpcChannel.StorageV2_GetCoreSnapshot, (_event, options?: unknown) =>
    storageV2Service.getCoreSnapshot(options as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_RecordMigrationRun, (_event, input: unknown) =>
    storageV2Service.recordMigrationRun(input as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_ListMigrationRuns, (_event, limit?: number) =>
    storageV2Service.listMigrationRuns(limit)
  )
  ipcMain.handle(IpcChannel.StorageV2_SettingsGet, (_event, key: string) => storageV2Service.getSetting(key))
  ipcMain.handle(IpcChannel.StorageV2_SettingsSet, (_event, key: string, value: unknown, scope?: string) =>
    storageV2Service.setSetting(key, value, scope)
  )
  ipcMain.handle(IpcChannel.StorageV2_SettingsList, (_event, scope?: string) => storageV2Service.listSettings(scope))
  ipcMain.handle(IpcChannel.StorageV2_ProvidersList, () => storageV2Service.listProviders())
  ipcMain.handle(IpcChannel.StorageV2_ProviderUpsert, (_event, provider, sortOrder?: number, credentialRef?: string) =>
    storageV2Service.upsertProvider(provider, sortOrder, credentialRef)
  )
  ipcMain.handle(IpcChannel.StorageV2_AssistantsList, () => storageV2Service.listAssistants())
  ipcMain.handle(IpcChannel.StorageV2_AssistantUpsert, (_event, assistant, sortOrder?: number) =>
    storageV2Service.upsertAssistant(assistant, sortOrder)
  )
  ipcMain.handle(IpcChannel.StorageV2_ConversationsList, (_event, filter?: unknown) =>
    storageV2Service.listConversations(filter as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_MessagesList, (_event, conversationId: string, options?: unknown) =>
    storageV2Service.listMessages(conversationId, options as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_ConversationDelete, (_event, conversationId: string) =>
    storageV2Service.deleteConversation(conversationId)
  )
  ipcMain.handle(IpcChannel.StorageV2_FileDelete, (_event, fileId: string) => storageV2Service.deleteFile(fileId))
  ipcMain.handle(IpcChannel.StorageV2_ImportLegacyReduxSnapshot, (_event, snapshot: unknown, options?: unknown) =>
    storageV2Service.importLegacyReduxSnapshot(snapshot, options as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_ImportLegacyDexieSnapshot, (_event, snapshot: unknown, options?: unknown) =>
    storageV2Service.importLegacyDexieSnapshot(snapshot, options as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_ImportLegacyAgentDb, (_event, options?: unknown) =>
    storageV2Service.importLegacyAgentDb(options as any)
  )
  ipcMain.handle(IpcChannel.StorageV2_ImportLegacyAppDb, (_event, options?: unknown) =>
    storageV2Service.importLegacyAppDb(options as any)
  )
}
