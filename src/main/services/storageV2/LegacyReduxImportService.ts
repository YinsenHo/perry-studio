import type { Assistant, Provider } from '@types'

import { storageV2SecretVaultService } from './SecretVaultService'
import {
  storageV2AssistantRepository,
  storageV2KnowledgeRepository,
  storageV2ProviderRepository,
  storageV2SettingsRepository
} from './StorageV2Repositories'

type LegacyReduxSnapshot = {
  settings?: Record<string, unknown> | string
  llm?:
    | {
        providers?: Provider[]
        defaultModel?: unknown
        topicNamingModel?: unknown
        quickModel?: unknown
        translateModel?: unknown
        quickAssistantId?: unknown
        settings?: unknown
      }
    | string
  assistants?:
    | {
        defaultAssistant?: Assistant
        assistants?: Assistant[]
        tagsOrder?: unknown
        collapsedTags?: unknown
        presets?: unknown
        unifiedListOrder?: unknown
      }
    | string
  redux?:
    | {
        knowledge?: unknown
        memory?: unknown
        mcp?: unknown
        note?: unknown
        preprocess?: unknown
        websearch?: unknown
      }
    | string
}

type SecretField = {
  path: string[]
  kind: string
}

export type StorageV2LegacyImportOptions = {
  dryRun?: boolean
}

export type StorageV2LegacyImportReport = {
  dryRun: boolean
  settingsCount: number
  providerCount: number
  modelCount: number
  assistantCount: number
  deletedProviderCount: number
  deletedAssistantCount: number
  knowledgeBaseCount: number
  knowledgeItemCount: number
  importedKnowledgeBaseCount: number
  importedKnowledgeItemCount: number
  deletedKnowledgeBaseCount: number
  deletedKnowledgeItemCount: number
  secretCandidateCount: number
  importedSecretCount: number
  skippedSecretCount: number
  warnings: string[]
}

function parseMaybeJson<T>(value: T | string | undefined): T | undefined {
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function normalizeSnapshot(input: LegacyReduxSnapshot | string): LegacyReduxSnapshot {
  const snapshot = parseMaybeJson<LegacyReduxSnapshot>(input) ?? {}
  return {
    settings: parseMaybeJson<Record<string, unknown>>(snapshot.settings),
    llm: parseMaybeJson<Exclude<LegacyReduxSnapshot['llm'], string>>(snapshot.llm),
    assistants: parseMaybeJson<Exclude<LegacyReduxSnapshot['assistants'], string>>(snapshot.assistants),
    redux: parseMaybeJson<Exclude<LegacyReduxSnapshot['redux'], string>>(snapshot.redux)
  }
}

const LLM_SETTINGS_SECRET_FIELDS: SecretField[] = [
  {
    path: ['vertexai', 'serviceAccount', 'privateKey'],
    kind: 'vertexai.serviceAccount.privateKey'
  },
  {
    path: ['awsBedrock', 'secretAccessKey'],
    kind: 'awsBedrock.secretAccessKey'
  },
  {
    path: ['awsBedrock', 'apiKey'],
    kind: 'awsBedrock.apiKey'
  },
  {
    path: ['cherryIn', 'accessToken'],
    kind: 'cherryIn.accessToken'
  },
  {
    path: ['cherryIn', 'refreshToken'],
    kind: 'cherryIn.refreshToken'
  }
]

function cloneJsonObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object') return {}
  return JSON.parse(JSON.stringify(value)) as Record<string, any>
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getNestedValue(root: Record<string, any>, path: string[]): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setNestedValue(root: Record<string, any>, path: string[], value: unknown) {
  let current = root
  for (const segment of path.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== 'object') {
      current[segment] = {}
    }
    current = current[segment]
  }
  current[path[path.length - 1]] = value
}

function deleteNestedValue(root: Record<string, any>, path: string[]) {
  let current = root
  for (const segment of path.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== 'object') {
      return
    }
    current = current[segment]
  }
  delete current[path[path.length - 1]]
}

function stripAssistantRuntimeData<T extends { topics?: unknown }>(assistant: T): T & { topics: [] } {
  return {
    ...assistant,
    topics: []
  }
}

function sanitizeAssistantSetting(key: string, value: unknown) {
  if (key === 'defaultAssistant' && value && typeof value === 'object') {
    return stripAssistantRuntimeData(value as Record<string, unknown>)
  }

  if (key === 'presets' && Array.isArray(value)) {
    return value.map((preset) =>
      preset && typeof preset === 'object' ? stripAssistantRuntimeData(preset as Record<string, unknown>) : preset
    )
  }

  return value
}

async function sanitizeLlmSettings(
  value: unknown,
  options: {
    dryRun: boolean
    canImportSecrets: boolean
    warnings: string[]
  }
): Promise<{
  value: unknown
  secretCandidateCount: number
  importedSecretCount: number
}> {
  const sanitized = cloneJsonObject(value)
  let secretCandidateCount = 0
  let importedSecretCount = 0

  for (const field of LLM_SETTINGS_SECRET_FIELDS) {
    const secretValue = getNestedValue(sanitized, field.path)
    if (typeof secretValue !== 'string' || !secretValue) continue

    secretCandidateCount++

    if (!options.dryRun && options.canImportSecrets) {
      const secretRef = await storageV2SecretVaultService.setSecret('llm-settings', 'default', field.kind, secretValue)
      setNestedValue(sanitized, [...field.path.slice(0, -1), `${field.path.at(-1)}SecretRef`], secretRef)
      importedSecretCount++
    } else if (!options.dryRun) {
      setNestedValue(sanitized, [...field.path.slice(0, -1), `${field.path.at(-1)}SecretUnavailable`], true)
    }

    if (!options.dryRun) {
      deleteNestedValue(sanitized, field.path)
    }
  }

  if (secretCandidateCount > 0 && options.dryRun) {
    options.warnings.push(
      'Sensitive LLM settings were detected. Dry run did not write them to the Storage v2 secret vault.'
    )
  } else if (secretCandidateCount > 0 && !options.canImportSecrets) {
    options.warnings.push(
      'Sensitive LLM settings were detected but safeStorage encryption is unavailable on this system.'
    )
  }

  return {
    value: options.dryRun ? value : sanitized,
    secretCandidateCount,
    importedSecretCount
  }
}

async function sanitizeMcpState(
  value: unknown,
  options: {
    dryRun: boolean
    canImportSecrets: boolean
    warnings: string[]
  }
): Promise<{
  value: unknown
  secretCandidateCount: number
  importedSecretCount: number
}> {
  const sanitized = cloneJsonObject(value)
  const servers = Array.isArray(sanitized.servers) ? sanitized.servers : []
  let secretCandidateCount = 0
  let importedSecretCount = 0

  for (const [index, server] of servers.entries()) {
    if (!isRecord(server.env)) continue

    const serverId =
      typeof server.id === 'string' && server.id
        ? server.id
        : typeof server.name === 'string' && server.name
          ? server.name
          : `server-${index}`
    const envSecretRefs = isRecord(server.envSecretRefs) ? { ...server.envSecretRefs } : {}
    const envSecretUnavailable = isRecord(server.envSecretUnavailable) ? { ...server.envSecretUnavailable } : {}

    for (const [key, item] of Object.entries(server.env)) {
      if (typeof item !== 'string' || !item) continue

      secretCandidateCount++

      if (!options.dryRun && options.canImportSecrets) {
        envSecretRefs[key] = await storageV2SecretVaultService.setSecret('mcp-server', serverId, `env.${key}`, item)
        importedSecretCount++
      } else if (!options.dryRun) {
        envSecretUnavailable[key] = true
      }

      if (!options.dryRun) {
        delete server.env[key]
      }
    }

    if (!options.dryRun) {
      if (Object.keys(envSecretRefs).length > 0) {
        server.envSecretRefs = envSecretRefs
      }
      if (Object.keys(envSecretUnavailable).length > 0) {
        server.envSecretUnavailable = envSecretUnavailable
      }
      if (Object.keys(server.env).length === 0) {
        delete server.env
      }
    }
  }

  if (secretCandidateCount > 0 && options.dryRun) {
    options.warnings.push(
      'MCP server environment values were detected. Dry run did not write them to the secret vault.'
    )
  } else if (secretCandidateCount > 0 && !options.canImportSecrets) {
    options.warnings.push(
      'MCP server environment values were detected but safeStorage encryption is unavailable on this system.'
    )
  }

  return {
    value: options.dryRun ? value : sanitized,
    secretCandidateCount,
    importedSecretCount
  }
}

type SecretSanitizerOptions = {
  dryRun: boolean
  canImportSecrets: boolean
  warnings: string[]
}

type SecretSanitizerResult = {
  value: unknown
  secretCandidateCount: number
  importedSecretCount: number
}

async function moveStringSecretField(
  owner: Record<string, any>,
  options: SecretSanitizerOptions & {
    scope: string
    ownerId: string
    field: string
    kind: string
  }
): Promise<{
  detected: boolean
  imported: boolean
}> {
  const secretValue = owner[options.field]
  if (typeof secretValue !== 'string' || !secretValue) {
    return {
      detected: false,
      imported: false
    }
  }

  let imported = false

  if (!options.dryRun && options.canImportSecrets) {
    owner[`${options.field}SecretRef`] = await storageV2SecretVaultService.setSecret(
      options.scope,
      options.ownerId,
      options.kind,
      secretValue
    )
    imported = true
  } else if (!options.dryRun) {
    owner[`${options.field}SecretUnavailable`] = true
  }

  if (!options.dryRun) {
    delete owner[options.field]
  }

  return {
    detected: true,
    imported
  }
}

function pushSecretWarning(
  options: SecretSanitizerOptions,
  secretCandidateCount: number,
  dryRunMessage: string,
  unavailableMessage: string
) {
  if (secretCandidateCount > 0 && options.dryRun) {
    options.warnings.push(dryRunMessage)
  } else if (secretCandidateCount > 0 && !options.canImportSecrets) {
    options.warnings.push(unavailableMessage)
  }
}

async function sanitizeKnowledgeState(value: unknown, options: SecretSanitizerOptions): Promise<SecretSanitizerResult> {
  const sanitized = cloneJsonObject(value)
  const bases = Array.isArray(sanitized.bases) ? sanitized.bases : []
  let secretCandidateCount = 0
  let importedSecretCount = 0

  for (const [index, base] of bases.entries()) {
    if (!isRecord(base)) continue

    const provider = base.preprocessProvider?.provider
    if (!isRecord(provider)) continue

    const ownerId = typeof base.id === 'string' && base.id ? base.id : `knowledge-base-${index}`
    const result = await moveStringSecretField(provider, {
      ...options,
      scope: 'knowledge-base',
      ownerId,
      field: 'apiKey',
      kind: 'preprocessProvider.apiKey'
    })

    if (result.detected) secretCandidateCount++
    if (result.imported) importedSecretCount++
  }

  pushSecretWarning(
    options,
    secretCandidateCount,
    'Knowledge base preprocess provider API keys were detected. Dry run did not write them to the secret vault.',
    'Knowledge base preprocess provider API keys were detected but safeStorage encryption is unavailable on this system.'
  )

  return {
    value: options.dryRun ? value : sanitized,
    secretCandidateCount,
    importedSecretCount
  }
}

async function sanitizePreprocessState(
  value: unknown,
  options: SecretSanitizerOptions
): Promise<SecretSanitizerResult> {
  const sanitized = cloneJsonObject(value)
  const providers = Array.isArray(sanitized.providers) ? sanitized.providers : []
  let secretCandidateCount = 0
  let importedSecretCount = 0

  for (const [index, provider] of providers.entries()) {
    if (!isRecord(provider)) continue

    const ownerId = typeof provider.id === 'string' && provider.id ? provider.id : `preprocess-provider-${index}`
    const result = await moveStringSecretField(provider, {
      ...options,
      scope: 'preprocess-provider',
      ownerId,
      field: 'apiKey',
      kind: 'apiKey'
    })

    if (result.detected) secretCandidateCount++
    if (result.imported) importedSecretCount++
  }

  pushSecretWarning(
    options,
    secretCandidateCount,
    'Document preprocess provider API keys were detected. Dry run did not write them to the secret vault.',
    'Document preprocess provider API keys were detected but safeStorage encryption is unavailable on this system.'
  )

  return {
    value: options.dryRun ? value : sanitized,
    secretCandidateCount,
    importedSecretCount
  }
}

async function sanitizeWebSearchState(value: unknown, options: SecretSanitizerOptions): Promise<SecretSanitizerResult> {
  const sanitized = cloneJsonObject(value)
  const providers = Array.isArray(sanitized.providers) ? sanitized.providers : []
  let secretCandidateCount = 0
  let importedSecretCount = 0

  for (const [index, provider] of providers.entries()) {
    if (!isRecord(provider)) continue

    const ownerId = typeof provider.id === 'string' && provider.id ? provider.id : `websearch-provider-${index}`
    for (const field of ['apiKey', 'basicAuthPassword']) {
      const result = await moveStringSecretField(provider, {
        ...options,
        scope: 'websearch-provider',
        ownerId,
        field,
        kind: field
      })

      if (result.detected) secretCandidateCount++
      if (result.imported) importedSecretCount++
    }
  }

  pushSecretWarning(
    options,
    secretCandidateCount,
    'Web search provider credentials were detected. Dry run did not write them to the secret vault.',
    'Web search provider credentials were detected but safeStorage encryption is unavailable on this system.'
  )

  return {
    value: options.dryRun ? value : sanitized,
    secretCandidateCount,
    importedSecretCount
  }
}

export class StorageV2LegacyReduxImportService {
  async importSnapshot(
    input: LegacyReduxSnapshot | string,
    options: StorageV2LegacyImportOptions = {}
  ): Promise<StorageV2LegacyImportReport> {
    const dryRun = options.dryRun !== false
    const snapshot = normalizeSnapshot(input)
    const warnings: string[] = []

    const settings = snapshot.settings && typeof snapshot.settings === 'object' ? snapshot.settings : {}
    const llm = snapshot.llm && typeof snapshot.llm === 'object' ? snapshot.llm : {}
    const assistants = snapshot.assistants && typeof snapshot.assistants === 'object' ? snapshot.assistants : {}
    const redux = snapshot.redux && typeof snapshot.redux === 'object' ? snapshot.redux : {}
    const providers = Array.isArray(llm.providers) ? llm.providers : []
    const assistantList = Array.isArray(assistants.assistants) ? assistants.assistants : []

    const settingsEntries: Array<[string, unknown, string]> = Object.entries(settings).map(([key, value]) => [
      `settings.${key}`,
      value,
      'settings'
    ])

    const canImportSecrets = storageV2SecretVaultService.isAvailable()
    let llmSettingsSecretCandidateCount = 0
    let llmSettingsImportedSecretCount = 0
    let reduxSecretCandidateCount = 0
    let reduxImportedSecretCount = 0

    for (const key of ['defaultModel', 'topicNamingModel', 'quickModel', 'translateModel', 'quickAssistantId']) {
      if (Object.hasOwn(llm, key)) {
        settingsEntries.push([`llm.${key}`, (llm as Record<string, unknown>)[key], 'llm'])
      }
    }

    if (Object.hasOwn(llm, 'settings')) {
      const sanitizedLlmSettings = await sanitizeLlmSettings((llm as Record<string, unknown>).settings, {
        dryRun,
        canImportSecrets,
        warnings
      })
      settingsEntries.push(['llm.settings', sanitizedLlmSettings.value, 'llm'])
      llmSettingsSecretCandidateCount = sanitizedLlmSettings.secretCandidateCount
      llmSettingsImportedSecretCount = sanitizedLlmSettings.importedSecretCount
    }

    for (const key of ['tagsOrder', 'collapsedTags', 'presets', 'unifiedListOrder', 'defaultAssistant']) {
      if (Object.hasOwn(assistants, key)) {
        settingsEntries.push([
          `assistants.${key}`,
          sanitizeAssistantSetting(key, (assistants as Record<string, unknown>)[key]),
          'assistants'
        ])
      }
    }

    for (const key of ['knowledge', 'memory', 'mcp', 'note', 'preprocess', 'websearch']) {
      if (Object.hasOwn(redux, key)) {
        let value = (redux as Record<string, unknown>)[key]

        if (key === 'knowledge') {
          const sanitizedKnowledgeState = await sanitizeKnowledgeState(value, {
            dryRun,
            canImportSecrets,
            warnings
          })
          value = sanitizedKnowledgeState.value
          reduxSecretCandidateCount += sanitizedKnowledgeState.secretCandidateCount
          reduxImportedSecretCount += sanitizedKnowledgeState.importedSecretCount
        } else if (key === 'mcp') {
          const sanitizedMcpState = await sanitizeMcpState(value, {
            dryRun,
            canImportSecrets,
            warnings
          })
          value = sanitizedMcpState.value
          reduxSecretCandidateCount += sanitizedMcpState.secretCandidateCount
          reduxImportedSecretCount += sanitizedMcpState.importedSecretCount
        } else if (key === 'preprocess') {
          const sanitizedPreprocessState = await sanitizePreprocessState(value, {
            dryRun,
            canImportSecrets,
            warnings
          })
          value = sanitizedPreprocessState.value
          reduxSecretCandidateCount += sanitizedPreprocessState.secretCandidateCount
          reduxImportedSecretCount += sanitizedPreprocessState.importedSecretCount
        } else if (key === 'websearch') {
          const sanitizedWebSearchState = await sanitizeWebSearchState(value, {
            dryRun,
            canImportSecrets,
            warnings
          })
          value = sanitizedWebSearchState.value
          reduxSecretCandidateCount += sanitizedWebSearchState.secretCandidateCount
          reduxImportedSecretCount += sanitizedWebSearchState.importedSecretCount
        }

        settingsEntries.push([`redux.${key}`, value, 'redux'])
      }
    }

    const providerSecretCandidateCount = providers.filter((provider) => Boolean(provider.apiKey)).length
    const secretCandidateCount =
      providerSecretCandidateCount + llmSettingsSecretCandidateCount + reduxSecretCandidateCount
    const modelCount = providers.reduce((count, provider) => count + (provider.models?.length ?? 0), 0)
    let importedSecretCount = llmSettingsImportedSecretCount + reduxImportedSecretCount
    let deletedProviderCount = 0
    let deletedAssistantCount = 0
    let knowledgeBaseCount = 0
    let knowledgeItemCount = 0
    let importedKnowledgeBaseCount = 0
    let importedKnowledgeItemCount = 0
    let deletedKnowledgeBaseCount = 0
    let deletedKnowledgeItemCount = 0
    const knowledgeSettingValue = settingsEntries.find(([key]) => key === 'redux.knowledge')?.[1]
    const knowledgeBases =
      isRecord(knowledgeSettingValue) && Array.isArray(knowledgeSettingValue.bases)
        ? (knowledgeSettingValue.bases as Array<Record<string, any>>)
        : []
    knowledgeBaseCount = knowledgeBases.length
    knowledgeItemCount = knowledgeBases.reduce(
      (count, base) => count + (Array.isArray(base.items) ? base.items.length : 0),
      0
    )

    if (providerSecretCandidateCount > 0 && dryRun) {
      warnings.push('Provider API keys were detected. Dry run did not write them to the Storage v2 secret vault.')
    } else if (providerSecretCandidateCount > 0 && !canImportSecrets) {
      warnings.push('Provider API keys were detected but safeStorage encryption is unavailable on this system.')
    }

    if (!dryRun) {
      for (const [key, value, scope] of settingsEntries) {
        await storageV2SettingsRepository.set(key, value, scope)
      }

      for (const [index, provider] of providers.entries()) {
        const credentialRef =
          provider.apiKey && canImportSecrets
            ? await storageV2SecretVaultService.setSecret('provider', provider.id, 'apiKey', provider.apiKey)
            : undefined
        if (credentialRef) importedSecretCount++
        await storageV2ProviderRepository.upsert(provider, index, credentialRef)
      }

      for (const [index, assistant] of assistantList.entries()) {
        await storageV2AssistantRepository.upsert(assistant, index)
      }

      if (Object.hasOwn(redux, 'knowledge')) {
        const knowledgeImportReport = await storageV2KnowledgeRepository.importBases(knowledgeBases)
        knowledgeBaseCount = knowledgeImportReport.baseCount
        knowledgeItemCount = knowledgeImportReport.itemCount
        importedKnowledgeBaseCount = knowledgeImportReport.baseCount
        importedKnowledgeItemCount = knowledgeImportReport.itemCount
        deletedKnowledgeBaseCount = knowledgeImportReport.deletedBaseCount
        deletedKnowledgeItemCount = knowledgeImportReport.deletedItemCount
      }

      deletedProviderCount = await storageV2ProviderRepository.deleteMissing(providers.map((provider) => provider.id))
      deletedAssistantCount = await storageV2AssistantRepository.deleteMissing(
        assistantList.map((assistant) => assistant.id)
      )
    }

    return {
      dryRun,
      settingsCount: settingsEntries.length,
      providerCount: providers.length,
      modelCount,
      assistantCount: assistantList.length,
      deletedProviderCount,
      deletedAssistantCount,
      knowledgeBaseCount,
      knowledgeItemCount,
      importedKnowledgeBaseCount,
      importedKnowledgeItemCount,
      deletedKnowledgeBaseCount,
      deletedKnowledgeItemCount,
      secretCandidateCount,
      importedSecretCount,
      skippedSecretCount: secretCandidateCount - importedSecretCount,
      warnings
    }
  }
}

export const storageV2LegacyReduxImportService = new StorageV2LegacyReduxImportService()
