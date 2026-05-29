import type { Assistant, Provider } from '@types'

import { configManager } from '../ConfigManager'
import { storageV2AgentDbMirrorService } from './AgentDbMirrorService'
import { storageV2BackupService } from './BackupService'
import { storageV2DataRootService } from './DataRootService'
import { storageV2FileLegacyProjectionService } from './FileLegacyProjectionService'
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
  type StorageV2ConversationImport,
  type StorageV2ConversationImportOptions,
  storageV2ConversationRepository,
  type StorageV2ConversationUpsert,
  type StorageV2ConversationUpsertOptions,
  storageV2FileRepository,
  storageV2KnowledgeRepository,
  type StorageV2MessageBlocksUpsertOptions,
  storageV2ProviderRepository,
  storageV2SettingsRepository
} from './StorageV2Repositories'
import type { StorageV2HealthSummaryCheck } from './types'

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

const MCP_PROVIDER_TOKEN_KEYS = new Set([
  'mcprouter_token',
  'modelscope_token',
  'tokenLanyunToken',
  'tokenflux_token',
  'ai302_token',
  'bailian_token'
])

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

function isSensitiveHeaderName(headerName: string) {
  return /(authorization|cookie|token|secret|api[-_]?key|x[-_].*key)/i.test(headerName)
}

function countStorageV2StatsRecords(counts: Record<string, number>) {
  return Object.values(counts).reduce((total, count) => total + (Number.isFinite(count) ? count : 0), 0)
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
      if (!includeSecrets) {
        delete server.env
      } else if (!isRecord(server.env)) {
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

    if (!includeSecrets) {
      delete server.env
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

async function restoreMcpProviderTokens(
  value: unknown,
  includeSecrets: boolean
): Promise<{
  value: Record<string, string>
  missingSecretCount: number
  knownTokenKeys: string[]
}> {
  const restored: Record<string, string> = {}
  const tokens = cloneRecord(value)
  const knownTokenKeys: string[] = []
  let missingSecretCount = 0

  for (const [tokenKey, tokenRecord] of Object.entries(tokens)) {
    if (!MCP_PROVIDER_TOKEN_KEYS.has(tokenKey)) continue
    knownTokenKeys.push(tokenKey)

    if (typeof tokenRecord === 'string' && tokenRecord) {
      if (includeSecrets) {
        restored[tokenKey] = tokenRecord
      }
      continue
    }

    if (!isRecord(tokenRecord)) continue
    const secretRef = tokenRecord.tokenSecretRef
    if (typeof secretRef !== 'string' || !secretRef || !includeSecrets) continue

    const token = await storageV2SecretVaultService.getSecret(secretRef)
    if (token) {
      restored[tokenKey] = token
    } else {
      missingSecretCount++
    }
  }

  return {
    value: restored,
    missingSecretCount,
    knownTokenKeys
  }
}

function sanitizeClearedMcpProviderTokenKeys(value: unknown, knownTokenKeys: Set<string>): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(
    new Set(
      value.filter(
        (item): item is string =>
          typeof item === 'string' && MCP_PROVIDER_TOKEN_KEYS.has(item) && !knownTokenKeys.has(item)
      )
    )
  )
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

  if (!includeSecrets && typeof owner[field] === 'string' && owner[field]) {
    delete owner[field]
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

async function restoreOcrStateSecrets(
  value: unknown,
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

    const apiConfig = provider.config?.api
    if (!isRecord(apiConfig)) continue

    missingSecretCount += await restoreSecretField(apiConfig, 'apiKey', includeSecrets)
  }

  return {
    value: restored,
    missingSecretCount
  }
}

async function restoreCodeToolsStateSecrets(
  value: unknown,
  includeSecrets: boolean
): Promise<{
  value: unknown
  missingSecretCount: number
}> {
  const restored = cloneRecord(value)
  const environmentVariableSecretRefs = isRecord(restored.environmentVariableSecretRefs)
    ? restored.environmentVariableSecretRefs
    : null
  let missingSecretCount = 0

  if (environmentVariableSecretRefs) {
    if (!includeSecrets) {
      delete restored.environmentVariables
    } else if (!isRecord(restored.environmentVariables)) {
      restored.environmentVariables = {}
    }

    for (const [toolId, secretRef] of Object.entries(environmentVariableSecretRefs)) {
      if (typeof secretRef !== 'string' || !secretRef || !includeSecrets) continue

      const secret = await storageV2SecretVaultService.getSecret(secretRef)
      if (secret) {
        restored.environmentVariables[toolId] = secret
      } else {
        missingSecretCount++
      }
    }
  }

  delete restored.environmentVariableSecretRefs
  delete restored.environmentVariableSecretUnavailable

  if (!includeSecrets) {
    delete restored.environmentVariables
  }

  return {
    value: restored,
    missingSecretCount
  }
}

async function restoreCopilotStateSecrets(
  value: unknown,
  includeSecrets: boolean
): Promise<{
  value: unknown
  missingSecretCount: number
}> {
  const restored = cloneRecord(value)
  const defaultHeaderSecretRefs = isRecord(restored.defaultHeaderSecretRefs) ? restored.defaultHeaderSecretRefs : null
  let missingSecretCount = 0

  if (!includeSecrets && isRecord(restored.defaultHeaders)) {
    for (const headerName of Object.keys(restored.defaultHeaders)) {
      if (isSensitiveHeaderName(headerName)) {
        delete restored.defaultHeaders[headerName]
      }
    }
  }

  if (defaultHeaderSecretRefs) {
    if (!includeSecrets && isRecord(restored.defaultHeaders)) {
      for (const headerName of Object.keys(defaultHeaderSecretRefs)) {
        delete restored.defaultHeaders[headerName]
      }
    } else if (!isRecord(restored.defaultHeaders)) {
      restored.defaultHeaders = {}
    }

    for (const [headerName, secretRef] of Object.entries(defaultHeaderSecretRefs)) {
      if (typeof secretRef !== 'string' || !secretRef || !includeSecrets) continue

      const secret = await storageV2SecretVaultService.getSecret(secretRef)
      if (secret) {
        restored.defaultHeaders[headerName] = secret
      } else {
        missingSecretCount++
      }
    }
  }

  delete restored.defaultHeaderSecretRefs
  delete restored.defaultHeaderSecretUnavailable

  return {
    value: restored,
    missingSecretCount
  }
}

const DEXIE_AUXILIARY_TABLE_NAMES = [
  'knowledge_notes',
  'quick_phrases',
  'translate_history',
  'translate_languages'
] as const

function assignSettingRecord(
  target: {
    settings: Record<string, unknown>
    llm: Record<string, unknown>
    assistants: Record<string, unknown>
    redux: Record<string, unknown>
    localStorage: Record<string, unknown>
    dexieSettings: Record<string, unknown>
    dexieTables: Record<string, Record<string, unknown>>
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
    return
  }

  if (key.startsWith('localStorage.')) {
    target.localStorage[key.slice('localStorage.'.length)] = value
    return
  }

  if (key.startsWith('dexie.settings.')) {
    target.dexieSettings[key.slice('dexie.settings.'.length)] = value
    return
  }

  for (const tableName of DEXIE_AUXILIARY_TABLE_NAMES) {
    const prefix = `dexie.table.${tableName}.`
    if (key.startsWith(prefix)) {
      const rowId = key.slice(prefix.length)
      target.dexieTables[tableName] = target.dexieTables[tableName] ?? {}
      target.dexieTables[tableName][rowId] = value
      return
    }
  }
}

export class StorageV2Service {
  private async flushPendingRuntimeMirrors() {
    await configManager.flushPendingStorageV2ConfigStrict()
    await configManager.mirrorAllToStorageV2()
    await storageV2AgentDbMirrorService.flushStrict()
  }

  getDataRoot() {
    return storageV2DataRootService.resolveDataRoot()
  }

  async healthCheck() {
    return storageV2Database.healthCheck()
  }

  async createSnapshot(reason: string = 'manual') {
    await this.flushPendingRuntimeMirrors()
    return storageV2Database.createSnapshot(reason)
  }

  async createBackup(reason: string = 'manual') {
    await this.flushPendingRuntimeMirrors()
    return storageV2BackupService.createBackup(reason)
  }

  async validateBackup(backupPath: string) {
    return storageV2BackupService.validateBackup(backupPath)
  }

  async restoreBackup(backupPath: string) {
    await this.flushPendingRuntimeMirrors()
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

  async getHealthSummary() {
    const checks: StorageV2HealthSummaryCheck[] = []
    const dataRootInfo = this.getDataRoot()

    try {
      const health = await this.healthCheck()
      checks.push({
        id: 'storage_health',
        label: 'Storage health',
        status: health.ok ? 'ok' : 'error',
        message: health.ok ? 'Storage quick_check passed.' : `Storage quick_check failed: ${health.quickCheck}`,
        values: {
          quickCheck: health.quickCheck
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({
        id: 'storage_health',
        label: 'Storage health',
        status: 'error',
        message: `Storage health check failed: ${message}`,
        values: { message }
      })
    }

    try {
      const integrity = await this.getIntegrityReport()
      checks.push({
        id: 'integrity',
        label: 'Integrity',
        status: integrity.ok ? 'ok' : 'error',
        message: integrity.ok
          ? 'Storage integrity report is clean.'
          : `Storage integrity report has ${integrity.issues.length} issue(s).`,
        values: {
          count: integrity.issues.length,
          foreignKeyIssueCount: integrity.foreignKeyIssueCount
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({
        id: 'integrity',
        label: 'Integrity',
        status: 'error',
        message: `Storage integrity report failed: ${message}`,
        values: { message }
      })
    }

    try {
      const audit = await this.getMigrationAudit()
      const legacyOnlyCount = audit.items.filter(
        (item) => item.exists && item.coverage === 'legacy-only' && item.actionRequired
      ).length
      checks.push({
        id: 'legacy_only_paths',
        label: 'Legacy-only paths',
        status: legacyOnlyCount > 0 ? 'warning' : 'ok',
        message:
          legacyOnlyCount > 0
            ? `${legacyOnlyCount} legacy-only path(s) need handling before final migration.`
            : 'No action-required legacy-only paths were detected.',
        values: { count: legacyOnlyCount }
      })
      checks.push({
        id: 'audit_warnings',
        label: 'Audit warnings',
        status: audit.warnings.length > 0 ? 'warning' : 'ok',
        message:
          audit.warnings.length > 0
            ? `${audit.warnings.length} migration audit warning(s) need review.`
            : 'Migration audit has no warnings.',
        values: { count: audit.warnings.length }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({
        id: 'audit_warnings',
        label: 'Audit warnings',
        status: 'error',
        message: `Migration audit failed: ${message}`,
        values: { message }
      })
    }

    try {
      const stats = await this.getStats()
      const recordCount = countStorageV2StatsRecords(stats.counts)
      checks.push({
        id: 'record_coverage',
        label: 'Record coverage',
        status: recordCount > 0 ? 'ok' : 'warning',
        message:
          recordCount > 0
            ? `Storage v2 contains ${recordCount} record(s).`
            : 'Storage v2 has no records yet; run migration before relying on backup or restore.',
        values: { count: recordCount }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({
        id: 'record_coverage',
        label: 'Record coverage',
        status: 'warning',
        message: `Storage v2 stats failed: ${message}`,
        values: { message }
      })
    }

    const issueCount = checks.filter((check) => check.status === 'error').length
    const warningCount = checks.filter((check) => check.status === 'warning').length
    const legacyOnlyCheck = checks.find((check) => check.id === 'legacy_only_paths')
    const status = issueCount > 0 ? 'blocked' : warningCount > 0 ? 'warning' : 'ready'

    return {
      generatedAt: new Date().toISOString(),
      status,
      canBackup: issueCount === 0,
      canMigrate: issueCount === 0 && legacyOnlyCheck?.status !== 'warning',
      dataRoot: dataRootInfo.dataRoot,
      issueCount,
      warningCount,
      checks
    }
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
      redux: {} as Record<string, unknown>,
      localStorage: {} as Record<string, unknown>,
      dexieSettings: {} as Record<string, unknown>,
      dexieTables: {} as Record<string, Record<string, unknown>>
    }
    const includeSecrets = options.includeSecrets === true
    const credentialRefsByProvider = includeSecrets
      ? await storageV2ProviderRepository.listCredentialRefs()
      : new Map<string, Record<string, string>>()
    let missingSecretCount = 0

    for (const record of settingsRecords) {
      assignSettingRecord(state, record.key, record.value)
    }

    if (isRecord(state.settings.s3)) {
      missingSecretCount += await restoreSecretField(state.settings.s3, 'secretAccessKey', includeSecrets)
    }

    if (isRecord(state.settings.apiServer)) {
      missingSecretCount += await restoreSecretField(state.settings.apiServer, 'apiKey', includeSecrets)
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
      if (!includeSecrets) {
        deleteNestedValue(llmSettings, field.path)
      }
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

    if (state.redux.codeTools) {
      const restoredCodeToolsState = await restoreCodeToolsStateSecrets(state.redux.codeTools, includeSecrets)
      state.redux.codeTools = restoredCodeToolsState.value
      missingSecretCount += restoredCodeToolsState.missingSecretCount
    }

    if (state.redux.copilot) {
      const restoredCopilotState = await restoreCopilotStateSecrets(state.redux.copilot, includeSecrets)
      state.redux.copilot = restoredCopilotState.value
      missingSecretCount += restoredCopilotState.missingSecretCount
    }

    if (state.redux.mcp) {
      const restoredMcpState = await restoreMcpStateSecrets(state.redux.mcp, includeSecrets)
      state.redux.mcp = restoredMcpState.value
      missingSecretCount += restoredMcpState.missingSecretCount
    }

    const hasRecoverableReduxKnowledge =
      isRecord(state.redux.knowledge) &&
      Array.isArray(state.redux.knowledge.bases) &&
      state.redux.knowledge.bases.length > 0

    if (!hasRecoverableReduxKnowledge) {
      const knowledgeBases = await storageV2KnowledgeRepository.listBases()
      if (knowledgeBases.length > 0) {
        state.redux.knowledge = { bases: knowledgeBases }
      }
    }

    if (state.redux.knowledge) {
      const restoredKnowledgeState = await restoreKnowledgeStateSecrets(state.redux.knowledge, includeSecrets)
      state.redux.knowledge = restoredKnowledgeState.value
      missingSecretCount += restoredKnowledgeState.missingSecretCount
    }

    if (state.redux.nutstore) {
      const restoredNutstoreState = cloneRecord(state.redux.nutstore)
      missingSecretCount += await restoreSecretField(restoredNutstoreState, 'nutstoreToken', includeSecrets)
      state.redux.nutstore = restoredNutstoreState
    }

    if (state.redux.ocr) {
      const restoredOcrState = await restoreOcrStateSecrets(state.redux.ocr, includeSecrets)
      state.redux.ocr = restoredOcrState.value
      missingSecretCount += restoredOcrState.missingSecretCount
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

    let knownMcpProviderTokenKeys = new Set<string>()
    if (state.localStorage.mcpProviderTokens) {
      const restoredMcpProviderTokens = await restoreMcpProviderTokens(
        state.localStorage.mcpProviderTokens,
        includeSecrets
      )
      state.localStorage.mcpProviderTokens = restoredMcpProviderTokens.value
      knownMcpProviderTokenKeys = new Set(restoredMcpProviderTokens.knownTokenKeys)
      missingSecretCount += restoredMcpProviderTokens.missingSecretCount
    }

    if (state.localStorage.clearedMcpProviderTokenKeys) {
      state.localStorage.clearedMcpProviderTokenKeys = sanitizeClearedMcpProviderTokenKeys(
        state.localStorage.clearedMcpProviderTokenKeys,
        knownMcpProviderTokenKeys
      )
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
      localStorage: state.localStorage,
      dexieSettings: state.dexieSettings,
      dexieTables: state.dexieTables,
      metadata: {
        includeSecrets,
        settingCount: settingsRecords.length,
        providerCount: providers.length,
        assistantCount: assistants.length,
        topicCount: conversations.length,
        reduxSliceCount: Object.keys(state.redux).length,
        dexieTableRowCount: Object.values(state.dexieTables).reduce(
          (count, rowsById) => count + Object.keys(rowsById).length,
          0
        ),
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

  async deleteProvider(providerId: string) {
    return storageV2ProviderRepository.delete(providerId)
  }

  async listAssistants() {
    return storageV2AssistantRepository.list()
  }

  async upsertAssistant(assistant: Assistant, sortOrder?: number) {
    return storageV2AssistantRepository.upsert(assistant, sortOrder)
  }

  async deleteAssistant(assistantId: string) {
    return storageV2AssistantRepository.delete(assistantId)
  }

  async listConversations(filter?: { ownerType?: string; ownerId?: string }) {
    return storageV2ConversationRepository.list(filter)
  }

  async listMessages(conversationId: string, options?: { limit?: number; offset?: number }) {
    return storageV2ConversationRepository.listMessages(conversationId, options)
  }

  async syncConversation(conversation: StorageV2ConversationImport, options?: StorageV2ConversationImportOptions) {
    return storageV2ConversationRepository.importConversation(conversation, options)
  }

  async upsertConversation(conversation: StorageV2ConversationUpsert, options?: StorageV2ConversationUpsertOptions) {
    return storageV2ConversationRepository.upsertConversation(conversation, options)
  }

  async upsertMessage(conversationId: string, message: Record<string, any>) {
    return storageV2ConversationRepository.upsertMessage(conversationId, message)
  }

  async upsertMessageBlocks(
    messageId: string,
    blocks: Array<Record<string, any>>,
    options?: StorageV2MessageBlocksUpsertOptions
  ) {
    return storageV2ConversationRepository.upsertMessageBlocks(messageId, blocks, options)
  }

  async deleteConversation(conversationId: string) {
    return storageV2ConversationRepository.delete(conversationId)
  }

  async listFiles() {
    return storageV2FileRepository.list()
  }

  async getFile(fileId: string) {
    return storageV2FileRepository.get(fileId)
  }

  async projectFilesToLegacyRuntime() {
    return storageV2FileLegacyProjectionService.projectToLegacyRuntime()
  }

  async upsertFile(file: Record<string, any>) {
    return storageV2FileRepository.importFile(file)
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

  async importLegacyAgentDb(options?: { dryRun?: boolean; dbPath?: string; createSnapshot?: boolean }) {
    return storageV2LegacyAgentDbImportService.importSnapshot(options)
  }

  async importLegacyAppDb(options?: { dryRun?: boolean; dbPath?: string; createSnapshot?: boolean }) {
    return storageV2LegacyAppDbImportService.importSnapshot(options)
  }
}

export const storageV2Service = new StorageV2Service()
