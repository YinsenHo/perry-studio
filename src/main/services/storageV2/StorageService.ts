import type { Assistant, Provider } from '@types'

import { storageV2BackupService } from './BackupService'
import { storageV2DataRootService } from './DataRootService'
import { storageV2LegacyAgentDbImportService } from './LegacyAgentDbImportService'
import { storageV2LegacyAppDbImportService } from './LegacyAppDbImportService'
import { type StorageV2LegacyDexieImportOptions, storageV2LegacyDexieImportService } from './LegacyDexieImportService'
import { type StorageV2LegacyImportOptions, storageV2LegacyReduxImportService } from './LegacyReduxImportService'
import { storageV2MigrationAuditService } from './MigrationAuditService'
import { type StorageV2MigrationRunInput, storageV2MigrationRunService } from './MigrationRunService'
import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2StatisticsService } from './StatisticsService'
import { storageV2Database } from './StorageV2Database'
import {
  storageV2AssistantRepository,
  storageV2ConversationRepository,
  storageV2FileRepository,
  storageV2ProviderRepository,
  storageV2SettingsRepository
} from './StorageV2Repositories'

export type StorageV2CoreSnapshotOptions = {
  includeSecrets?: boolean
}

const LLM_SETTINGS_SECRET_FIELDS = [
  {
    path: ['vertexai', 'serviceAccount', 'privateKey'],
    secretRefKey: 'privateKeySecretRef'
  },
  {
    path: ['awsBedrock', 'secretAccessKey'],
    secretRefKey: 'secretAccessKeySecretRef'
  },
  {
    path: ['awsBedrock', 'apiKey'],
    secretRefKey: 'apiKeySecretRef'
  },
  {
    path: ['cherryIn', 'accessToken'],
    secretRefKey: 'accessTokenSecretRef'
  },
  {
    path: ['cherryIn', 'refreshToken'],
    secretRefKey: 'refreshTokenSecretRef'
  }
] as const

function cloneRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object') return {}
  return JSON.parse(JSON.stringify(value)) as Record<string, any>
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getNestedRecord(root: Record<string, any>, path: readonly string[]): Record<string, any> | null {
  let current: unknown = root
  for (const segment of path) {
    if (!current || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment]
  }
  return current && typeof current === 'object' ? (current as Record<string, any>) : null
}

function setNestedValue(root: Record<string, any>, path: readonly string[], value: unknown) {
  let current = root
  for (const segment of path.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== 'object') {
      current[segment] = {}
    }
    current = current[segment]
  }
  current[path[path.length - 1]] = value
}

function deleteNestedValue(root: Record<string, any>, path: readonly string[]) {
  let current = root
  for (const segment of path.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== 'object') return
    current = current[segment]
  }
  delete current[path[path.length - 1]]
}

async function restoreMcpStateSecrets(
  value: unknown,
  includeSecrets: boolean
): Promise<{
  value: unknown
  missingSecretCount: number
}> {
  const restored = cloneRecord(value)
  const servers = Array.isArray(restored.servers) ? restored.servers : []
  let missingSecretCount = 0

  for (const server of servers) {
    if (!isRecord(server)) continue

    const envSecretRefs = isRecord(server.envSecretRefs) ? server.envSecretRefs : null
    if (envSecretRefs) {
      if (!isRecord(server.env)) {
        server.env = {}
      }

      for (const [key, secretRef] of Object.entries(envSecretRefs)) {
        if (typeof secretRef !== 'string' || !secretRef) continue
        if (!includeSecrets) continue

        const secret = await storageV2SecretVaultService.getSecret(secretRef)
        if (secret) {
          server.env[key] = secret
        } else {
          missingSecretCount++
        }
      }
    }

    delete server.envSecretRefs
    delete server.envSecretUnavailable

    if (isRecord(server.env) && Object.keys(server.env).length === 0) {
      delete server.env
    }
  }

  return {
    value: restored,
    missingSecretCount
  }
}

async function restoreSecretField(owner: Record<string, any>, field: string, includeSecrets: boolean): Promise<number> {
  const secretRefKey = `${field}SecretRef`
  const unavailableKey = `${field}SecretUnavailable`
  const secretRef = owner[secretRefKey]
  let missingSecretCount = 0

  if (typeof secretRef === 'string' && secretRef && includeSecrets) {
    const secret = await storageV2SecretVaultService.getSecret(secretRef)
    if (secret) {
      owner[field] = secret
    } else {
      missingSecretCount++
    }
  }

  delete owner[secretRefKey]
  delete owner[unavailableKey]

  return missingSecretCount
}

async function restoreKnowledgeStateSecrets(
  value: unknown,
  includeSecrets: boolean
): Promise<{
  value: unknown
  missingSecretCount: number
}> {
  const restored = cloneRecord(value)
  const bases = Array.isArray(restored.bases) ? restored.bases : []
  let missingSecretCount = 0

  for (const base of bases) {
    if (!isRecord(base)) continue

    const provider = base.preprocessProvider?.provider
    if (!isRecord(provider)) continue

    missingSecretCount += await restoreSecretField(provider, 'apiKey', includeSecrets)
  }

  return {
    value: restored,
    missingSecretCount
  }
}

async function restoreProviderListSecrets(
  value: unknown,
  fields: string[],
  includeSecrets: boolean
): Promise<{
  value: unknown
  missingSecretCount: number
}> {
  const restored = cloneRecord(value)
  const providers = Array.isArray(restored.providers) ? restored.providers : []
  let missingSecretCount = 0

  for (const provider of providers) {
    if (!isRecord(provider)) continue

    for (const field of fields) {
      missingSecretCount += await restoreSecretField(provider, field, includeSecrets)
    }
  }

  return {
    value: restored,
    missingSecretCount
  }
}

function assignSettingRecord(
  target: {
    settings: Record<string, unknown>
    llm: Record<string, unknown>
    assistants: Record<string, unknown>
    redux: Record<string, unknown>
  },
  key: string,
  value: unknown
) {
  if (key.startsWith('settings.')) {
    target.settings[key.slice('settings.'.length)] = value
    return
  }

  if (key.startsWith('llm.')) {
    target.llm[key.slice('llm.'.length)] = value
    return
  }

  if (key.startsWith('assistants.')) {
    target.assistants[key.slice('assistants.'.length)] = value
    return
  }

  if (key.startsWith('redux.')) {
    target.redux[key.slice('redux.'.length)] = value
  }
}

export class StorageV2Service {
  getDataRoot() {
    return storageV2DataRootService.resolveDataRoot()
  }

  async healthCheck() {
    return storageV2Database.healthCheck()
  }

  async createSnapshot(reason: string = 'manual') {
    return storageV2Database.createSnapshot(reason)
  }

  async createBackup(reason: string = 'manual') {
    return storageV2BackupService.createBackup(reason)
  }

  async validateBackup(backupPath: string) {
    return storageV2BackupService.validateBackup(backupPath)
  }

  async restoreBackup(backupPath: string) {
    return storageV2BackupService.restoreBackup(backupPath)
  }

  async getMigrationAudit() {
    return storageV2MigrationAuditService.runAudit()
  }

  async getStats() {
    return storageV2StatisticsService.getStats()
  }

  async getIntegrityReport() {
    return storageV2Database.integrityReport()
  }

  async getCoreSnapshot(options: StorageV2CoreSnapshotOptions = {}) {
    const [settingsRecords, providers, assistants, conversations] = await Promise.all([
      storageV2SettingsRepository.list(),
      storageV2ProviderRepository.list(),
      storageV2AssistantRepository.list(),
      storageV2ConversationRepository.list({ ownerType: 'assistant' })
    ])
    const state = {
      settings: {} as Record<string, unknown>,
      llm: {} as Record<string, unknown>,
      assistants: {} as Record<string, unknown>,
      redux: {} as Record<string, unknown>
    }
    const includeSecrets = options.includeSecrets === true
    const credentialRefsByProvider = includeSecrets
      ? await storageV2ProviderRepository.listCredentialRefs()
      : new Map<string, Record<string, string>>()
    let missingSecretCount = 0

    for (const record of settingsRecords) {
      assignSettingRecord(state, record.key, record.value)
    }

    const llmSettings = cloneRecord(state.llm.settings)
    if (includeSecrets) {
      for (const field of LLM_SETTINGS_SECRET_FIELDS) {
        const parent = getNestedRecord(llmSettings, field.path.slice(0, -1))
        const secretRef = parent?.[field.secretRefKey]
        if (typeof secretRef === 'string' && secretRef) {
          const secret = await storageV2SecretVaultService.getSecret(secretRef)
          if (secret) {
            setNestedValue(llmSettings, field.path, secret)
          } else {
            missingSecretCount++
          }
        }
      }
    }

    for (const field of LLM_SETTINGS_SECRET_FIELDS) {
      deleteNestedValue(llmSettings, [...field.path.slice(0, -1), field.secretRefKey])
      deleteNestedValue(llmSettings, [...field.path.slice(0, -1), `${field.path.at(-1)}SecretUnavailable`])
    }

    if (Object.keys(llmSettings).length > 0) {
      state.llm.settings = llmSettings
    }

    const providerSnapshots = await Promise.all(
      providers.map(async (provider) => {
        const snapshot: Record<string, unknown> = provider.config ? { ...provider.config } : {}
        Object.assign(snapshot, {
          id: provider.id,
          type: provider.type,
          name: provider.name,
          apiHost: provider.apiHost ?? undefined,
          enabled: provider.enabled,
          models: provider.models
        })

        if (includeSecrets) {
          const apiKeyRef = credentialRefsByProvider.get(provider.id)?.apiKey
          if (apiKeyRef) {
            const apiKey = await storageV2SecretVaultService.getSecret(apiKeyRef)
            if (apiKey) {
              snapshot.apiKey = apiKey
            } else {
              missingSecretCount++
            }
          }
        }

        return snapshot
      })
    )
    state.llm.providers = providerSnapshots

    if (state.redux.mcp) {
      const restoredMcpState = await restoreMcpStateSecrets(state.redux.mcp, includeSecrets)
      state.redux.mcp = restoredMcpState.value
      missingSecretCount += restoredMcpState.missingSecretCount
    }

    if (state.redux.knowledge) {
      const restoredKnowledgeState = await restoreKnowledgeStateSecrets(state.redux.knowledge, includeSecrets)
      state.redux.knowledge = restoredKnowledgeState.value
      missingSecretCount += restoredKnowledgeState.missingSecretCount
    }

    if (state.redux.preprocess) {
      const restoredPreprocessState = await restoreProviderListSecrets(
        state.redux.preprocess,
        ['apiKey'],
        includeSecrets
      )
      state.redux.preprocess = restoredPreprocessState.value
      missingSecretCount += restoredPreprocessState.missingSecretCount
    }

    if (state.redux.websearch) {
      const restoredWebSearchState = await restoreProviderListSecrets(
        state.redux.websearch,
        ['apiKey', 'basicAuthPassword'],
        includeSecrets
      )
      state.redux.websearch = restoredWebSearchState.value
      missingSecretCount += restoredWebSearchState.missingSecretCount
    }

    const topicsByAssistantId = new Map<string, Array<Record<string, unknown>>>()
    for (const conversation of conversations) {
      const topics = topicsByAssistantId.get(conversation.ownerId) ?? []
      topics.push({
        id: conversation.id,
        type: 'chat',
        assistantId: conversation.ownerId,
        name: conversation.title ?? conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: [],
        pinned: conversation.pinned
      })
      topicsByAssistantId.set(conversation.ownerId, topics)
    }

    const assistantSnapshots = assistants.map((assistant) => ({
      ...(Object.keys(assistant.snapshot).length > 0
        ? assistant.snapshot
        : {
            id: assistant.id,
            name: assistant.name,
            description: assistant.description,
            prompt: assistant.prompt,
            settings: assistant.settings,
            tags: assistant.tags
          }),
      topics: topicsByAssistantId.get(assistant.id) ?? []
    }))
    state.assistants.assistants = assistantSnapshots

    if (state.assistants.defaultAssistant && typeof state.assistants.defaultAssistant === 'object') {
      const defaultAssistant = state.assistants.defaultAssistant as Record<string, any>
      defaultAssistant.topics = topicsByAssistantId.get(String(defaultAssistant.id)) ?? []
    }

    if (Array.isArray(state.assistants.presets)) {
      state.assistants.presets = state.assistants.presets.map((preset) =>
        preset && typeof preset === 'object' ? { ...preset, topics: [] } : preset
      )
    }

    return {
      generatedAt: new Date().toISOString(),
      settings: state.settings,
      llm: state.llm,
      assistants: state.assistants,
      redux: state.redux,
      metadata: {
        includeSecrets,
        settingCount: settingsRecords.length,
        providerCount: providers.length,
        assistantCount: assistants.length,
        topicCount: conversations.length,
        reduxSliceCount: Object.keys(state.redux).length,
        missingSecretCount
      }
    }
  }

  async recordMigrationRun(input: StorageV2MigrationRunInput) {
    return storageV2MigrationRunService.recordRun(input)
  }

  async listMigrationRuns(limit?: number) {
    return storageV2MigrationRunService.listRuns(limit)
  }

  async getSetting(key: string) {
    return storageV2SettingsRepository.get(key)
  }

  async setSetting(key: string, value: unknown, scope?: string) {
    return storageV2SettingsRepository.set(key, value, scope)
  }

  async listSettings(scope?: string) {
    return storageV2SettingsRepository.list(scope)
  }

  async listProviders() {
    return storageV2ProviderRepository.list()
  }

  async upsertProvider(provider: Provider, sortOrder?: number, credentialRef?: string) {
    const nextCredentialRef =
      credentialRef ??
      (provider.apiKey
        ? await storageV2SecretVaultService.setSecret('provider', provider.id, 'apiKey', provider.apiKey)
        : undefined)
    return storageV2ProviderRepository.upsert(provider, sortOrder, nextCredentialRef)
  }

  async listAssistants() {
    return storageV2AssistantRepository.list()
  }

  async upsertAssistant(assistant: Assistant, sortOrder?: number) {
    return storageV2AssistantRepository.upsert(assistant, sortOrder)
  }

  async listConversations(filter?: { ownerType?: string; ownerId?: string }) {
    return storageV2ConversationRepository.list(filter)
  }

  async listMessages(conversationId: string, options?: { limit?: number; offset?: number }) {
    return storageV2ConversationRepository.listMessages(conversationId, options)
  }

  async deleteConversation(conversationId: string) {
    return storageV2ConversationRepository.delete(conversationId)
  }

  async deleteFile(fileId: string) {
    return storageV2FileRepository.delete(fileId)
  }

  async importLegacyReduxSnapshot(snapshot: unknown, options?: StorageV2LegacyImportOptions) {
    return storageV2LegacyReduxImportService.importSnapshot(snapshot as any, options)
  }

  async importLegacyDexieSnapshot(snapshot: unknown, options?: StorageV2LegacyDexieImportOptions) {
    return storageV2LegacyDexieImportService.importSnapshot(snapshot as any, options)
  }

  async importLegacyAgentDb(options?: { dryRun?: boolean; dbPath?: string }) {
    return storageV2LegacyAgentDbImportService.importSnapshot(options)
  }

  async importLegacyAppDb(options?: { dryRun?: boolean; dbPath?: string }) {
    return storageV2LegacyAppDbImportService.importSnapshot(options)
  }
}

export const storageV2Service = new StorageV2Service()
