import db from '@renderer/databases'
import store from '@renderer/store'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'

import { storageV2AgentMirrorService } from './StorageV2AgentMirrorService'
import { storageV2ConversationMirrorService } from './StorageV2ConversationMirrorService'
import { storageV2DexieSettingsMirrorService } from './StorageV2DexieSettingsMirrorService'
import { STORAGE_V2_DEXIE_TABLE_NAMES, storageV2DexieTableMirrorService } from './StorageV2DexieTableMirrorService'
import { storageV2FileMirrorService } from './StorageV2FileMirrorService'
import {
  flushStorageV2LocalStorageMirrorStrict,
  getStorageV2LocalStorageSnapshot,
  suspendStorageV2LocalStorageMirrorUntilReload
} from './StorageV2LocalStorageSnapshot'
import { storageV2MirrorService } from './StorageV2MirrorService'

export type StorageV2LegacyImportOptions = {
  dryRun?: boolean
  pruneMissing?: boolean
}

type StorageV2LegacyDexieSnapshotOptions = {
  includeReduxOnlyTopics?: boolean
  preferMessageAssistantId?: boolean
}

export type StorageV2LegacyDexieImportOptions = StorageV2LegacyImportOptions & StorageV2LegacyDexieSnapshotOptions

export type StorageV2LegacyAgentDbImportOptions = StorageV2LegacyImportOptions & {
  dbPath?: string
  createSnapshot?: boolean
}

export type StorageV2LegacyAppDbImportOptions = StorageV2LegacyImportOptions & {
  dbPath?: string
  createSnapshot?: boolean
}

type StorageV2LegacyDexieConversationSnapshot = {
  assistantId: string
  topic: Omit<Topic, 'messages'> & { messages: [] }
  messages: Message[]
  blocks: MessageBlock[]
}

type StorageV2LegacyDexieSnapshot = {
  conversations: StorageV2LegacyDexieConversationSnapshot[]
  files: FileMetadata[]
  settings: Array<{ id: string; value: unknown }>
  dexieTables: Record<(typeof STORAGE_V2_DEXIE_TABLE_NAMES)[number], Array<{ id: string } & object>>
}

export type StorageV2LegacyMigrationOptions = StorageV2LegacyImportOptions & {
  createSnapshot?: boolean
}

export type StorageV2LegacyMigrationReport = {
  dryRun: boolean
  startedAt: string
  finishedAt: string
  snapshotPath?: string
  reports: {
    redux: unknown
    dexie: unknown
    agentDb: unknown
    appDb: unknown
  }
  health: unknown
  stats: unknown
}

export type StorageV2MigrationRun = {
  id: string
  kind: string
  status: 'success' | 'failed'
  dryRun: boolean
  startedAt: string
  finishedAt: string | null
  snapshotPath: string | null
  report: unknown
  error: string | null
  createdAt: string
}

export type StorageV2BackupValidation = {
  ok: boolean
  backupPath: string
  metadataPath: string
  dbPath: string
  manifestPath: string | null
  reason: string | null
  createdAt: string | null
  copiedDirectories: string[]
  quickCheck: string | null
  integrityCheck: string | null
  missingBlobFileCount: number
  corruptBlobFileCount: number
  secretVaultSecretCount: number
  missingSecretRefCount: number
  invalidSecretRefCount: number
  orphanSecretVaultEntryCount: number
  undecryptableSecretVaultEntryCount: number
  issues: Array<{
    id: string
    message: string
    values?: Record<string, number | string>
  }>
  warnings: Array<{
    id: string
    message: string
    values?: Record<string, number | string>
  }>
  metadata: Record<string, any> | null
}

export type StorageV2RestoreBackupResult = {
  backupPath: string
  dataRoot: string
  restoredAt: string
  preRestoreBackupPath: string
  archivedPath: string
  restoredFiles: string[]
  restoredDirectories: string[]
  agentLegacyProjection: {
    agentDbPath: string
    archivedFiles: string[]
    projectedAgentCount: number
    projectedPlaceholderAgentCount: number
    projectedSessionCount: number
    projectedSessionMessageCount: number
    projectedSkillCount: number
    projectedPlaceholderSkillCount: number
    projectedAgentSkillCount: number
    projectedTaskCount: number
    projectedTaskRunLogCount: number
    projectedChannelCount: number
    skippedSessionCount: number
    skippedSessionMessageCount: number
    skippedAgentSkillCount: number
    skippedTaskCount: number
    skippedTaskRunLogCount: number
    skippedChannelCount: number
    restoredChannelSecretCount: number
    missingChannelSecretCount: number
    warnings: string[]
  }
  fileLegacyProjection: {
    filesDir: string
    projectedFileCount: number
    archivedFileCount: number
    skippedFileCount: number
    missingBlobCount: number
    archivedFiles: string[]
    warnings: string[]
  }
  appDataLegacyProjection: {
    appDbPath: string
    archivedFiles: string[]
    projectedRecordCount: number
    projectedCacheCount: number
    projectedSyncStateCount: number
    projectedSyncConflictCount: number
    projectedWorkbenchShortcutCount: number
    restoredSecretCount: number
    missingSecretCount: number
    warnings: string[]
  }
  validation: StorageV2BackupValidation
  requiresRestart: true
  warnings: string[]
}

export function getStorageV2DataRoot() {
  return window.api.storageV2.getDataRoot()
}

export function getStorageV2Health() {
  return window.api.storageV2.healthCheck()
}

export function getStorageV2MigrationAudit() {
  return window.api.storageV2.getMigrationAudit()
}

export function getStorageV2Stats() {
  return window.api.storageV2.getStats()
}

export function getStorageV2IntegrityReport() {
  return window.api.storageV2.getIntegrityReport()
}

export function getStorageV2CoreSnapshot(options?: { includeSecrets?: boolean }) {
  return window.api.storageV2.getCoreSnapshot(options)
}

export function listStorageV2MigrationRuns(limit?: number): Promise<StorageV2MigrationRun[]> {
  return window.api.storageV2.listMigrationRuns(limit)
}

export function recordStorageV2MigrationRun(input: {
  kind?: string
  status: 'success' | 'failed'
  dryRun: boolean
  startedAt: string
  finishedAt?: string
  snapshotPath?: string
  report?: unknown
  error?: string
}) {
  return window.api.storageV2.recordMigrationRun(input)
}

export async function createStorageV2Snapshot(reason?: string) {
  await flushStorageV2RuntimeMirrors()
  return window.api.storageV2.createSnapshot(reason)
}

export function getLegacyReduxSnapshotForStorageV2() {
  const state = store.getState()
  return {
    settings: state.settings,
    llm: state.llm,
    assistants: {
      ...state.assistants,
      defaultAssistant: stripAssistantRuntimeData(state.assistants.defaultAssistant),
      assistants: state.assistants.assistants.map(stripAssistantRuntimeData),
      presets: state.assistants.presets.map(stripAssistantRuntimeData)
    },
    redux: {
      backup: state.backup,
      codeTools: state.codeTools,
      copilot: state.copilot,
      inputTools: state.inputTools,
      knowledge: state.knowledge,
      memory: state.memory,
      minApps: state.minapps,
      mcp: state.mcp,
      note: state.note,
      nutstore: state.nutstore,
      ocr: state.ocr,
      openclaw: state.openclaw,
      paintings: state.paintings,
      preprocess: state.preprocess,
      selectionStore: state.selectionStore,
      shortcuts: state.shortcuts,
      translate: state.translate,
      websearch: state.websearch
    },
    localStorage: getStorageV2LocalStorageSnapshot()
  }
}

function getUniqueAssistants(): Assistant[] {
  const state = store.getState()
  const assistantsById = new Map<string, Assistant>()

  if (state.assistants.defaultAssistant?.id) {
    assistantsById.set(state.assistants.defaultAssistant.id, state.assistants.defaultAssistant)
  }

  for (const assistant of state.assistants.assistants ?? []) {
    assistantsById.set(assistant.id, assistant)
  }

  return Array.from(assistantsById.values())
}

function stripTopicMessages(topic: Topic): Omit<Topic, 'messages'> & { messages: [] } {
  return {
    ...topic,
    messages: []
  }
}

function stripAssistantRuntimeData<T extends { topics?: unknown }>(assistant: T): T & { topics: [] } {
  return {
    ...assistant,
    topics: []
  }
}

export async function getLegacyDexieSnapshotForStorageV2(
  options: StorageV2LegacyDexieSnapshotOptions = {}
): Promise<StorageV2LegacyDexieSnapshot> {
  const conversations: StorageV2LegacyDexieConversationSnapshot[] = []
  const includedTopicIds = new Set<string>()
  const state = store.getState()
  const fallbackAssistantId = state.assistants.defaultAssistant?.id ?? getUniqueAssistants()[0]?.id
  const includeReduxOnlyTopics = options.includeReduxOnlyTopics ?? true
  const preferMessageAssistantId = options.preferMessageAssistantId === true

  for (const assistant of getUniqueAssistants()) {
    for (const topic of assistant.topics ?? []) {
      const persistedTopic = await db.topics.get(topic.id)
      if (!persistedTopic && !includeReduxOnlyTopics) continue

      const persistedTopicMetadata = persistedTopic as Partial<Topic> | undefined
      const messages = persistedTopic?.messages ?? topic.messages ?? []
      const messageAssistantId = messages.find((message) => message.assistantId)?.assistantId
      const assistantId = preferMessageAssistantId
        ? (persistedTopicMetadata?.assistantId ?? messageAssistantId ?? topic.assistantId ?? assistant.id)
        : (topic.assistantId ?? persistedTopicMetadata?.assistantId ?? messageAssistantId ?? assistant.id)
      const messageIds = messages
        .map((message) => message.id)
        .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0)
      const blocks = messageIds.length ? await db.message_blocks.where('messageId').anyOf(messageIds).toArray() : []
      const topicSnapshot = {
        ...topic,
        ...(persistedTopic ?? {}),
        id: topic.id,
        assistantId,
        messages: []
      } as Topic

      conversations.push({
        assistantId,
        topic: stripTopicMessages(topicSnapshot),
        messages,
        blocks
      })
      includedTopicIds.add(topic.id)
    }
  }

  const persistedTopics = await db.topics.toArray()
  for (const persistedTopic of persistedTopics) {
    if (!persistedTopic?.id || includedTopicIds.has(persistedTopic.id)) continue

    const messages = persistedTopic.messages ?? []
    const assistantId = messages.find((message) => message.assistantId)?.assistantId ?? fallbackAssistantId
    if (!assistantId) continue

    const messageIds = messages
      .map((message) => message.id)
      .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0)
    const blocks = messageIds.length ? await db.message_blocks.where('messageId').anyOf(messageIds).toArray() : []
    const firstMessage = messages[0]
    const lastMessage = messages[messages.length - 1] ?? firstMessage

    conversations.push({
      assistantId,
      topic: {
        id: persistedTopic.id,
        assistantId,
        name: persistedTopic.id,
        createdAt: firstMessage?.createdAt ?? new Date().toISOString(),
        updatedAt:
          lastMessage?.updatedAt ?? lastMessage?.createdAt ?? firstMessage?.createdAt ?? new Date().toISOString(),
        messages: []
      },
      messages,
      blocks
    })
  }

  return {
    conversations,
    files: await db.files.toArray(),
    settings: await db.settings.toArray(),
    dexieTables: {
      knowledge_notes: await db.knowledge_notes.toArray(),
      quick_phrases: await db.quick_phrases.toArray(),
      translate_history: await db.translate_history.toArray(),
      translate_languages: await db.translate_languages.toArray()
    }
  }
}

export function dryRunLegacyReduxImportToStorageV2() {
  return window.api.storageV2.importLegacyReduxSnapshot(getLegacyReduxSnapshotForStorageV2(), { dryRun: true })
}

export function importLegacyReduxToStorageV2(options: StorageV2LegacyImportOptions = {}) {
  return window.api.storageV2.importLegacyReduxSnapshot(getLegacyReduxSnapshotForStorageV2(), {
    ...options,
    dryRun: options.dryRun ?? false
  })
}

export async function dryRunLegacyDexieImportToStorageV2() {
  return window.api.storageV2.importLegacyDexieSnapshot(await getLegacyDexieSnapshotForStorageV2(), { dryRun: true })
}

export async function importLegacyDexieToStorageV2(options: StorageV2LegacyDexieImportOptions = {}) {
  const { includeReduxOnlyTopics, preferMessageAssistantId, ...importOptions } = options

  return window.api.storageV2.importLegacyDexieSnapshot(
    await getLegacyDexieSnapshotForStorageV2({
      includeReduxOnlyTopics,
      preferMessageAssistantId
    }),
    {
      ...importOptions,
      dryRun: importOptions.dryRun ?? false,
      pruneMissing: importOptions.pruneMissing ?? true
    }
  )
}

export function dryRunLegacyAgentDbImportToStorageV2() {
  return window.api.storageV2.importLegacyAgentDb({ dryRun: true })
}

export function importLegacyAgentDbToStorageV2(options: StorageV2LegacyAgentDbImportOptions = {}) {
  return window.api.storageV2.importLegacyAgentDb({
    ...options,
    dryRun: options.dryRun ?? false
  })
}

export function dryRunLegacyAppDbImportToStorageV2() {
  return window.api.storageV2.importLegacyAppDb({ dryRun: true })
}

export function importLegacyAppDbToStorageV2(options: StorageV2LegacyAppDbImportOptions = {}) {
  return window.api.storageV2.importLegacyAppDb({
    ...options,
    dryRun: options.dryRun ?? false
  })
}

export function listStorageV2Conversations(filter?: { ownerType?: string; ownerId?: string }) {
  return window.api.storageV2.listConversations(filter)
}

export function listStorageV2Messages(conversationId: string, options?: { limit?: number; offset?: number }) {
  return window.api.storageV2.listMessages(conversationId, options)
}

export function syncStorageV2Conversation(
  conversation: Record<string, unknown>,
  options?: { pruneMissingMessages?: boolean; pruneMissingBlocks?: boolean }
) {
  return window.api.storageV2.syncConversation(conversation, options)
}

export function upsertStorageV2Conversation(
  conversation: Record<string, unknown>,
  options?: { pruneMissingMessages?: boolean; activeMessageIds?: string[] }
) {
  return window.api.storageV2.upsertConversation(conversation, options)
}

export function upsertStorageV2Message(conversationId: string, message: Record<string, unknown>) {
  return window.api.storageV2.upsertMessage(conversationId, message)
}

export function upsertStorageV2MessageBlocks(
  messageId: string,
  blocks: Array<Record<string, unknown>>,
  options?: { pruneMissing?: boolean }
) {
  return window.api.storageV2.upsertMessageBlocks(messageId, blocks, options)
}

export function deleteStorageV2Conversation(conversationId: string): Promise<{ deleted: boolean }> {
  return window.api.storageV2.deleteConversation(conversationId)
}

export function listStorageV2Files(): Promise<FileMetadata[]> {
  return window.api.storageV2.listFiles()
}

export function getStorageV2File(fileId: string): Promise<FileMetadata | null> {
  return window.api.storageV2.getFile(fileId)
}

export function projectStorageV2FilesToLegacyRuntime(): Promise<unknown> {
  return window.api.storageV2.projectFilesToLegacyRuntime()
}

export function upsertStorageV2File(file: FileMetadata): Promise<{ imported: boolean; skippedReason?: string }> {
  return window.api.storageV2.upsertFile(file)
}

export function deleteStorageV2File(fileId: string): Promise<{ deleted: boolean }> {
  return window.api.storageV2.deleteFile(fileId)
}

async function flushStorageV2RuntimeMirrors() {
  await storageV2MirrorService.flushStrict()
  await flushStorageV2LocalStorageMirrorStrict()
  await storageV2ConversationMirrorService.flushStrict()
  await storageV2FileMirrorService.flushStrict()
  await storageV2DexieSettingsMirrorService.flushStrict()
  await storageV2DexieTableMirrorService.flushStrict()
  await storageV2AgentMirrorService.flushStrict()
}

export async function createStorageV2Backup(reason?: string) {
  await flushStorageV2RuntimeMirrors()
  return window.api.storageV2.createBackup(reason)
}

export function validateStorageV2Backup(backupPath: string): Promise<StorageV2BackupValidation> {
  return window.api.storageV2.validateBackup(backupPath)
}

export async function restoreStorageV2Backup(backupPath: string): Promise<StorageV2RestoreBackupResult> {
  await flushStorageV2RuntimeMirrors()

  const result = await window.api.storageV2.restoreBackup(backupPath)

  suspendStorageV2RuntimeMirrorsUntilReload()

  return result
}

export function suspendStorageV2RuntimeMirrorsUntilReload() {
  storageV2MirrorService.suspendUntilReload()
  storageV2ConversationMirrorService.suspendUntilReload()
  storageV2FileMirrorService.suspendUntilReload()
  storageV2DexieSettingsMirrorService.suspendUntilReload()
  storageV2DexieTableMirrorService.suspendUntilReload()
  storageV2AgentMirrorService.suspendUntilReload()
  suspendStorageV2LocalStorageMirrorUntilReload()
}

export async function runLegacyMigrationToStorageV2(
  options: StorageV2LegacyMigrationOptions = {}
): Promise<StorageV2LegacyMigrationReport> {
  const dryRun = options.dryRun !== false
  const startedAt = new Date().toISOString()
  const createSnapshot = !dryRun && options.createSnapshot !== false
  let snapshotPath: string | undefined

  try {
    if (!dryRun) {
      await flushStorageV2RuntimeMirrors()
    }

    const snapshot = createSnapshot ? await window.api.storageV2.createSnapshot('before-full-legacy-import') : undefined
    snapshotPath = snapshot?.path

    const reduxSnapshot = getLegacyReduxSnapshotForStorageV2()
    const dexieSnapshot = await getLegacyDexieSnapshotForStorageV2()

    const reports = {
      redux: await window.api.storageV2.importLegacyReduxSnapshot(reduxSnapshot, { dryRun }),
      dexie: await window.api.storageV2.importLegacyDexieSnapshot(dexieSnapshot, {
        dryRun,
        pruneMissing: !dryRun
      }),
      agentDb: await window.api.storageV2.importLegacyAgentDb({ dryRun, createSnapshot: false }),
      appDb: await window.api.storageV2.importLegacyAppDb({ dryRun, createSnapshot: false })
    }

    const health = await window.api.storageV2.healthCheck()
    const stats = await window.api.storageV2.getStats()
    const report = {
      dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      snapshotPath,
      reports,
      health,
      stats
    }

    await recordStorageV2MigrationRun({
      kind: 'full-legacy-import',
      status: 'success',
      dryRun,
      startedAt,
      finishedAt: report.finishedAt,
      snapshotPath,
      report
    }).catch(() => undefined)

    return report
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await recordStorageV2MigrationRun({
      kind: 'full-legacy-import',
      status: 'failed',
      dryRun,
      startedAt,
      finishedAt,
      snapshotPath,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined)
    throw error
  }
}

export function dryRunLegacyMigrationToStorageV2() {
  return runLegacyMigrationToStorageV2({ dryRun: true })
}

export function importLegacyMigrationToStorageV2(options: Omit<StorageV2LegacyMigrationOptions, 'dryRun'> = {}) {
  return runLegacyMigrationToStorageV2({
    ...options,
    dryRun: false
  })
}
