import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Client } from '@libsql/client'
import type { Assistant, Model, Provider } from '@types'

import { storageV2DataRootService } from './DataRootService'
import { storageV2Database } from './StorageV2Database'
import { storageV2SyncLogService } from './SyncLogService'

type SettingRecord = {
  key: string
  value: unknown
  scope: string
  updatedAt: string
  version: number
  deletedAt: string | null
}

type StoredProvider = {
  id: string
  type: string
  name: string
  apiHost: string | null
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown> | null
  models: Model[]
  hasCredentialRef: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  version: number
}

type StoredAssistant = {
  id: string
  name: string
  description: string | null
  prompt: string | null
  modelId: string | null
  settings: Record<string, unknown> | null
  tags: string[] | null
  snapshot: Record<string, unknown>
  sortOrder: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  version: number
}

type StoredConversation = {
  id: string
  kind: string
  ownerType: string
  ownerId: string
  sessionId: string | null
  title: string | null
  pinned: boolean
  archived: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  version: number
}

type StoredMessageBlock = {
  id: string
  messageId: string
  type: string
  ordinal: number
  text: string | null
  payload: Record<string, unknown> | null
  blobId: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  version: number
}

type StoredMessage = {
  id: string
  conversationId: string
  role: string
  status: string | null
  parentId: string | null
  requestId: string | null
  modelId: string | null
  providerId: string | null
  tokenUsage: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  version: number
  blocks: StoredMessageBlock[]
}

const LEGACY_FILE_TYPES = new Set(['image', 'video', 'audio', 'text', 'document', 'other'])

export type StorageV2ConversationImport = {
  id: string
  kind?: string
  ownerType?: string
  ownerId: string
  sessionId?: string | null
  title?: string
  pinned?: boolean
  archived?: boolean
  sortOrder?: number
  createdAt?: string
  updatedAt?: string
  messages: Array<Record<string, any>>
  blocks: Array<Record<string, any>>
}

export type StorageV2ConversationUpsert = Omit<StorageV2ConversationImport, 'messages' | 'blocks'>

export type StorageV2ConversationUpsertOptions = {
  pruneMissingMessages?: boolean
  activeMessageIds?: string[]
}

export type StorageV2MessageBlocksUpsertOptions = {
  pruneMissing?: boolean
}

export type StorageV2FileImport = Record<string, any> & {
  id?: string
  name?: string
  origin_name?: string
  path?: string
  size?: number
  ext?: string
  type?: string
  created_at?: string
}

export type StorageV2KnowledgeBaseImport = Record<string, any> & {
  id?: string
  name?: string
  model?: Model
  rerankModel?: Model
  items?: Array<Record<string, any>>
  created_at?: number | string
  updated_at?: number | string
}

function now() {
  return new Date().toISOString()
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function toIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  if (typeof value === 'string' && value) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
  }

  return fallback
}

function toEpochMs(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.length >= 10) {
      return numeric
    }

    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return fallback
}

function stripProviderConfig(provider: Provider): Record<string, unknown> {
  const config = { ...provider } as Record<string, unknown>
  delete config.apiKey
  delete config.models
  delete config.isAnthropicModel
  return config
}

function normalizeModelProvider(model: Model, providerId: string): Model {
  return {
    ...model,
    provider: model.provider || providerId
  }
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function getKnowledgeItemFileId(item: Record<string, any>): string | null {
  const content = item.content
  if (content && typeof content === 'object' && !Array.isArray(content) && typeof content.id === 'string') {
    return content.id
  }

  if (Array.isArray(content)) {
    const file = content.find((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    return file?.id ?? null
  }

  return null
}

function getKnowledgeItemSourceUri(item: Record<string, any>): string | null {
  if (typeof item.content === 'string') {
    return item.content
  }

  const content = item.content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (typeof content.path === 'string') return content.path
    if (typeof content.origin_name === 'string') return content.origin_name
    if (typeof content.name === 'string') return content.name
  }

  return null
}

function normalizeLegacyFileType(value: unknown): string | null {
  return typeof value === 'string' && LEGACY_FILE_TYPES.has(value) ? value : null
}

function inferLegacyFileType(type: unknown, mime: unknown, ext: string): string {
  const normalizedType = normalizeLegacyFileType(type)
  if (normalizedType) return normalizedType

  const normalizedMime = normalizeLegacyFileType(mime)
  if (normalizedMime) return normalizedMime

  if (typeof mime === 'string') {
    const lowerMime = mime.toLowerCase()
    if (lowerMime.startsWith('image/')) return 'image'
    if (lowerMime.startsWith('video/')) return 'video'
    if (lowerMime.startsWith('audio/')) return 'audio'
    if (lowerMime.startsWith('text/')) return 'text'
    if (lowerMime === 'application/json' || lowerMime.endsWith('+json')) return 'text'
    if (lowerMime === 'application/pdf' || lowerMime.startsWith('application/')) return 'document'
  }

  const lowerExt = ext.toLowerCase()
  if (['.txt', '.md', '.markdown', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.py'].includes(lowerExt)) {
    return 'text'
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(lowerExt)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(lowerExt)) return 'video'
  if (['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'].includes(lowerExt)) return 'audio'

  return 'document'
}

function getImportMessageId(conversationId: string, message: Record<string, any>, index: number) {
  return typeof message.id === 'string' ? message.id : `${conversationId}:message:${index}`
}

function getMessageCreatedAt(message: Record<string, any>, fallback: string) {
  return typeof message.createdAt === 'string'
    ? message.createdAt
    : typeof message.created_at === 'string'
      ? message.created_at
      : fallback
}

function getMessageUpdatedAt(message: Record<string, any>, fallback: string) {
  return typeof message.updatedAt === 'string'
    ? message.updatedAt
    : typeof message.updated_at === 'string'
      ? message.updated_at
      : fallback
}

function getMessageModel(message: Record<string, any>) {
  return message.model && typeof message.model === 'object' ? (message.model as Record<string, any>) : null
}

function getMessageRequestId(message: Record<string, any>) {
  return typeof message.askId === 'string'
    ? message.askId
    : typeof message.requestId === 'string'
      ? message.requestId
      : null
}

function getMessageRole(message: Record<string, any>) {
  return typeof message.role === 'string' ? message.role : 'user'
}

function getBlockCreatedAt(block: Record<string, any>, fallback: string) {
  return typeof block.createdAt === 'string'
    ? block.createdAt
    : typeof block.created_at === 'string'
      ? block.created_at
      : fallback
}

function getBlockUpdatedAt(block: Record<string, any>, fallback: string) {
  return typeof block.updatedAt === 'string'
    ? block.updatedAt
    : typeof block.updated_at === 'string'
      ? block.updated_at
      : fallback
}

function getBlockText(block: Record<string, any>) {
  if (typeof block.content === 'string') return block.content
  if (typeof block.text === 'string') return block.text
  return null
}

async function withTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  return storageV2Database.withTransaction(client, fn)
}

async function getVersion(
  client: Client,
  table:
    | 'settings'
    | 'providers'
    | 'assistants'
    | 'conversations'
    | 'messages'
    | 'message_blocks'
    | 'files'
    | 'knowledge_bases'
    | 'knowledge_items',
  entityId: string
): Promise<number> {
  const idColumn = table === 'settings' ? 'key' : 'id'
  const result = await client.execute({
    sql: `SELECT version FROM ${table} WHERE ${idColumn} = ?`,
    args: [entityId]
  })
  return Number(result.rows[0]?.version ?? 1)
}

async function softDeleteMissingMessageBlocks(
  client: Client,
  messageId: string,
  activeBlockIds: Iterable<string>,
  deletedAt: string
) {
  const activeIds = Array.from(new Set(activeBlockIds))
  const args = [messageId, ...activeIds]
  const result = await client.execute({
    sql: `
      SELECT id, version
      FROM message_blocks
      WHERE message_id = ? AND deleted_at IS NULL
        ${activeIds.length > 0 ? `AND id NOT IN (${activeIds.map(() => '?').join(', ')})` : ''}
    `,
    args
  })

  for (const row of result.rows) {
    const blockId = String(row.id)
    const version = Number(row.version ?? 0) + 1
    await client.execute({
      sql: `
        UPDATE message_blocks
        SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `,
      args: [deletedAt, deletedAt, blockId]
    })
    await storageV2SyncLogService.recordChange({
      client,
      entityType: 'message_block',
      entityId: blockId,
      operation: 'delete',
      payload: { id: blockId, messageId, deletedAt },
      version
    })
  }
}

async function softDeleteMissingConversationMessages(
  client: Client,
  conversationId: string,
  activeMessageIds: Iterable<string>,
  deletedAt: string
) {
  const activeIds = Array.from(new Set(activeMessageIds))
  const args = [conversationId, ...activeIds]
  const result = await client.execute({
    sql: `
      SELECT id, version
      FROM messages
      WHERE conversation_id = ? AND deleted_at IS NULL
        ${activeIds.length > 0 ? `AND id NOT IN (${activeIds.map(() => '?').join(', ')})` : ''}
    `,
    args
  })

  for (const row of result.rows) {
    const messageId = String(row.id)
    const version = Number(row.version ?? 0) + 1

    await softDeleteMissingMessageBlocks(client, messageId, [], deletedAt)
    await client.execute({
      sql: `
        UPDATE messages
        SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `,
      args: [deletedAt, deletedAt, messageId]
    })
    await storageV2SyncLogService.recordChange({
      client,
      entityType: 'message',
      entityId: messageId,
      operation: 'delete',
      payload: { id: messageId, conversationId, deletedAt },
      version
    })
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })

  return hash.digest('hex')
}

export class StorageV2SettingsRepository {
  async get(key: string): Promise<unknown | null> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: 'SELECT value_json FROM settings WHERE key = ? AND deleted_at IS NULL',
      args: [key]
    })
    const row = result.rows[0]
    return row ? parseJson(row.value_json, null) : null
  }

  async set(key: string, value: unknown, scope = 'app'): Promise<SettingRecord> {
    const client = await storageV2Database.getClient()
    const updatedAt = now()
    const valueJson = toJson(value)
    let version = 1

    await withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO settings (key, value_json, scope, updated_at, version, deleted_at)
          VALUES (?, ?, ?, ?, 1, NULL)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            scope = excluded.scope,
            updated_at = excluded.updated_at,
            version = settings.version + 1,
            deleted_at = NULL
        `,
        args: [key, valueJson, scope, updatedAt]
      })

      version = await getVersion(client, 'settings', key)
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'settings',
        entityId: key,
        payload: { key, value, scope },
        version
      })
    })

    return {
      key,
      value,
      scope,
      updatedAt,
      version,
      deletedAt: null
    }
  }

  async list(scope?: string): Promise<SettingRecord[]> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT key, value_json, scope, updated_at, version, deleted_at
        FROM settings
        WHERE deleted_at IS NULL ${scope ? 'AND scope = ?' : ''}
        ORDER BY scope ASC, key ASC
      `,
      args: scope ? [scope] : []
    })

    return result.rows.map((row) => ({
      key: String(row.key),
      value: parseJson(row.value_json, null),
      scope: String(row.scope),
      updatedAt: String(row.updated_at),
      version: Number(row.version),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null
    }))
  }
}

export class StorageV2ProviderRepository {
  async upsert(provider: Provider, sortOrder = 0, credentialRef?: string): Promise<{ skippedSecret: boolean }> {
    const client = await storageV2Database.getClient()
    const timestamp = now()
    const config = stripProviderConfig(provider)
    const models = provider.models.map((model) => normalizeModelProvider(model, provider.id))

    await withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO providers (
            id, type, name, api_host, enabled, sort_order, config_json, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            type = excluded.type,
            name = excluded.name,
            api_host = excluded.api_host,
            enabled = excluded.enabled,
            sort_order = excluded.sort_order,
            config_json = excluded.config_json,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = providers.version + 1
        `,
        args: [
          provider.id,
          provider.type,
          provider.name,
          provider.apiHost || null,
          provider.enabled === false ? 0 : 1,
          sortOrder,
          toJson(config),
          timestamp,
          timestamp
        ]
      })

      await client.execute({
        sql: 'DELETE FROM models WHERE provider_id = ?',
        args: [provider.id]
      })

      for (const [modelIndex, model] of models.entries()) {
        await client.execute({
          sql: `
            INSERT INTO models (
              id, provider_id, name, group_name, capabilities_json, config_json, enabled, sort_order,
              created_at, updated_at, deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)
          `,
          args: [
            `${provider.id}:${model.id}`,
            provider.id,
            model.name || model.id,
            model.group || null,
            toJson(model.capabilities ?? model.type ?? null),
            toJson(model),
            modelIndex,
            timestamp,
            timestamp
          ]
        })
      }

      if (credentialRef) {
        await client.execute({
          sql: `
            INSERT INTO provider_credentials (provider_id, credential_kind, secret_ref, updated_at)
            VALUES (?, 'apiKey', ?, ?)
            ON CONFLICT(provider_id, credential_kind) DO UPDATE SET
              secret_ref = excluded.secret_ref,
              updated_at = excluded.updated_at
          `,
          args: [provider.id, credentialRef, timestamp]
        })
      } else {
        await client.execute({
          sql: "DELETE FROM provider_credentials WHERE provider_id = ? AND credential_kind = 'apiKey'",
          args: [provider.id]
        })
      }

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'provider',
        entityId: provider.id,
        payload: {
          provider: config,
          modelCount: models.length,
          hasCredentialRef: Boolean(credentialRef)
        },
        version: await getVersion(client, 'providers', provider.id)
      })
    })

    return {
      skippedSecret: Boolean(provider.apiKey && !credentialRef)
    }
  }

  async list(): Promise<StoredProvider[]> {
    const client = await storageV2Database.getClient()
    const [providersResult, modelsResult, credentialsResult] = await Promise.all([
      client.execute(`
        SELECT id, type, name, api_host, enabled, sort_order, config_json, created_at, updated_at, deleted_at, version
        FROM providers
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, name ASC
      `),
      client.execute(`
        SELECT provider_id, config_json
        FROM models
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, name ASC
      `),
      client.execute('SELECT provider_id FROM provider_credentials')
    ])

    const modelsByProvider = new Map<string, Model[]>()
    for (const row of modelsResult.rows) {
      const providerId = String(row.provider_id)
      const models = modelsByProvider.get(providerId) ?? []
      models.push(parseJson<Model>(row.config_json, { id: '', provider: providerId, name: '', group: '' }))
      modelsByProvider.set(providerId, models)
    }

    const providersWithCredential = new Set(credentialsResult.rows.map((row) => String(row.provider_id)))

    return providersResult.rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      name: String(row.name),
      apiHost: row.api_host ? String(row.api_host) : null,
      enabled: Boolean(row.enabled),
      sortOrder: Number(row.sort_order),
      config: parseJson<Record<string, unknown> | null>(row.config_json, null),
      models: modelsByProvider.get(String(row.id)) ?? [],
      hasCredentialRef: providersWithCredential.has(String(row.id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
      version: Number(row.version)
    }))
  }

  async listCredentialRefs(): Promise<Map<string, Record<string, string>>> {
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT provider_id, credential_kind, secret_ref
      FROM provider_credentials
    `)
    const credentialRefsByProvider = new Map<string, Record<string, string>>()

    for (const row of result.rows) {
      const providerId = String(row.provider_id)
      const credentialKind = String(row.credential_kind)
      const secretRef = String(row.secret_ref)
      const refs = credentialRefsByProvider.get(providerId) ?? {}
      refs[credentialKind] = secretRef
      credentialRefsByProvider.set(providerId, refs)
    }

    return credentialRefsByProvider
  }

  async delete(providerId: string): Promise<{ deleted: boolean }> {
    const client = await storageV2Database.getClient()
    const deletedAt = now()
    let deleted = false

    await withTransaction(client, async () => {
      const existingResult = await client.execute({
        sql: 'SELECT version FROM providers WHERE id = ? AND deleted_at IS NULL',
        args: [providerId]
      })
      const existingVersion = Number(existingResult.rows[0]?.version ?? 0)
      deleted = existingVersion > 0

      await client.execute({
        sql: `
          UPDATE providers
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, providerId]
      })
      await client.execute({
        sql: `
          UPDATE models
          SET deleted_at = ?, updated_at = ?
          WHERE provider_id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, providerId]
      })
      await client.execute({
        sql: 'DELETE FROM provider_credentials WHERE provider_id = ?',
        args: [providerId]
      })
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'provider',
        entityId: providerId,
        operation: 'delete',
        payload: { id: providerId, deletedAt },
        version: existingVersion > 0 ? existingVersion + 1 : 1
      })
    })

    return {
      deleted
    }
  }

  async deleteMissing(activeProviderIds: Iterable<string>): Promise<number> {
    const activeIds = new Set(activeProviderIds)
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT id
      FROM providers
      WHERE deleted_at IS NULL
    `)
    let deletedCount = 0

    for (const row of result.rows) {
      const providerId = String(row.id)
      if (activeIds.has(providerId)) continue

      const result = await this.delete(providerId)
      if (result.deleted) {
        deletedCount++
      }
    }

    return deletedCount
  }
}

export class StorageV2AssistantRepository {
  async upsert(assistant: Assistant, sortOrder = 0): Promise<void> {
    const client = await storageV2Database.getClient()
    const timestamp = now()
    const snapshot = {
      ...assistant,
      topics: Array.isArray(assistant.topics)
        ? assistant.topics.map((topic) => ({
            ...topic,
            messages: []
          }))
        : []
    }

    await withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO assistants (
            id, name, description, prompt, model_id, settings_json, tags_json, sort_order,
            created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            prompt = excluded.prompt,
            model_id = excluded.model_id,
            settings_json = excluded.settings_json,
            tags_json = excluded.tags_json,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = assistants.version + 1
        `,
        args: [
          assistant.id,
          assistant.name,
          assistant.description ?? null,
          assistant.prompt ?? null,
          assistant.model?.id ?? assistant.defaultModel?.id ?? null,
          toJson({
            settings: assistant.settings ?? null,
            snapshot
          }),
          toJson(assistant.tags ?? null),
          sortOrder,
          timestamp,
          timestamp
        ]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'assistant',
        entityId: assistant.id,
        payload: {
          id: assistant.id,
          name: assistant.name,
          modelId: assistant.model?.id ?? assistant.defaultModel?.id ?? null,
          tags: assistant.tags ?? null
        },
        version: await getVersion(client, 'assistants', assistant.id)
      })
    })
  }

  async list(): Promise<StoredAssistant[]> {
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT id, name, description, prompt, model_id, settings_json, tags_json, sort_order,
             created_at, updated_at, deleted_at, version
      FROM assistants
      WHERE deleted_at IS NULL
      ORDER BY sort_order ASC, name ASC
    `)

    return result.rows.map((row) => {
      const settingsPayload = parseJson<{
        settings?: Record<string, unknown> | null
        snapshot?: Record<string, unknown>
      }>(row.settings_json, {})

      return {
        id: String(row.id),
        name: String(row.name),
        description: row.description ? String(row.description) : null,
        prompt: row.prompt ? String(row.prompt) : null,
        modelId: row.model_id ? String(row.model_id) : null,
        settings: settingsPayload.settings ?? null,
        tags: parseJson<string[] | null>(row.tags_json, null),
        snapshot: settingsPayload.snapshot ?? {},
        sortOrder: Number(row.sort_order),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        deletedAt: row.deleted_at ? String(row.deleted_at) : null,
        version: Number(row.version)
      }
    })
  }

  async delete(assistantId: string): Promise<{ deleted: boolean }> {
    const client = await storageV2Database.getClient()
    const deletedAt = now()
    let deleted = false

    await withTransaction(client, async () => {
      const existingResult = await client.execute({
        sql: 'SELECT version FROM assistants WHERE id = ? AND deleted_at IS NULL',
        args: [assistantId]
      })
      const existingVersion = Number(existingResult.rows[0]?.version ?? 0)
      deleted = existingVersion > 0

      await client.execute({
        sql: `
          UPDATE assistants
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, assistantId]
      })
      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'assistant',
        entityId: assistantId,
        operation: 'delete',
        payload: { id: assistantId, deletedAt },
        version: existingVersion > 0 ? existingVersion + 1 : 1
      })
    })

    return {
      deleted
    }
  }

  async deleteMissing(activeAssistantIds: Iterable<string>): Promise<number> {
    const activeIds = new Set(activeAssistantIds)
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT id
      FROM assistants
      WHERE deleted_at IS NULL
    `)
    let deletedCount = 0

    for (const row of result.rows) {
      const assistantId = String(row.id)
      if (activeIds.has(assistantId)) continue

      const result = await this.delete(assistantId)
      if (result.deleted) {
        deletedCount++
      }
    }

    return deletedCount
  }
}

export class StorageV2ConversationRepository {
  private async upsertConversationRow(
    client: Client,
    conversation: StorageV2ConversationUpsert,
    summary: {
      messageCount?: number
      blockCount?: number
    } = {},
    timestamp = now()
  ) {
    const createdAt = conversation.createdAt ?? timestamp
    const updatedAt = conversation.updatedAt ?? createdAt
    const kind = conversation.kind ?? 'assistant_chat'
    const ownerType = conversation.ownerType ?? 'assistant'
    const sessionId = conversation.sessionId ?? null

    await client.execute({
      sql: `
        INSERT INTO conversations (
          id, kind, owner_type, owner_id, session_id, title, pinned, archived, sort_order,
          created_at, updated_at, deleted_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          session_id = excluded.session_id,
          title = excluded.title,
          pinned = excluded.pinned,
          archived = excluded.archived,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at,
          deleted_at = NULL,
          version = conversations.version + 1
      `,
      args: [
        conversation.id,
        kind,
        ownerType,
        conversation.ownerId,
        sessionId,
        conversation.title ?? null,
        conversation.pinned ? 1 : 0,
        conversation.archived ? 1 : 0,
        conversation.sortOrder ?? 0,
        createdAt,
        updatedAt
      ]
    })

    await storageV2SyncLogService.recordChange({
      client,
      entityType: 'conversation',
      entityId: conversation.id,
      payload: {
        kind,
        ownerType,
        ownerId: conversation.ownerId,
        sessionId,
        ...summary
      },
      version: await getVersion(client, 'conversations', conversation.id)
    })

    return {
      createdAt,
      updatedAt
    }
  }

  private async upsertMessageRow(
    client: Client,
    conversationId: string,
    message: Record<string, any>,
    messageId: string,
    fallbackCreatedAt: string,
    blockCount = 0
  ) {
    const messageCreatedAt = getMessageCreatedAt(message, fallbackCreatedAt)
    const messageUpdatedAt = getMessageUpdatedAt(message, messageCreatedAt)
    const model = getMessageModel(message)
    const role = getMessageRole(message)

    await client.execute({
      sql: `
        INSERT INTO messages (
          id, conversation_id, role, status, parent_id, request_id, model_id, provider_id,
          token_usage_json, metadata_json, created_at, updated_at, deleted_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          role = excluded.role,
          status = excluded.status,
          parent_id = excluded.parent_id,
          request_id = excluded.request_id,
          model_id = excluded.model_id,
          provider_id = excluded.provider_id,
          token_usage_json = excluded.token_usage_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at,
          deleted_at = NULL,
          version = messages.version + 1
      `,
      args: [
        messageId,
        conversationId,
        role,
        typeof message.status === 'string' ? message.status : null,
        typeof message.parentId === 'string' ? message.parentId : null,
        getMessageRequestId(message),
        typeof message.modelId === 'string' ? message.modelId : typeof model?.id === 'string' ? model.id : null,
        typeof model?.provider === 'string' ? model.provider : null,
        toJson(message.usage ?? null),
        toJson(message),
        messageCreatedAt,
        messageUpdatedAt
      ]
    })

    await storageV2SyncLogService.recordChange({
      client,
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId,
        role,
        blockCount
      },
      version: await getVersion(client, 'messages', messageId)
    })

    return {
      id: messageId,
      createdAt: messageCreatedAt,
      updatedAt: messageUpdatedAt
    }
  }

  private async upsertMessageBlockRow(
    client: Client,
    messageId: string,
    block: Record<string, any>,
    blockId: string,
    ordinal: number,
    fallbackCreatedAt: string
  ) {
    const blockCreatedAt = getBlockCreatedAt(block, fallbackCreatedAt)
    const blockUpdatedAt = getBlockUpdatedAt(block, blockCreatedAt)
    const type = typeof block.type === 'string' ? block.type : 'unknown'

    await client.execute({
      sql: `
        INSERT INTO message_blocks (
          id, message_id, type, ordinal, text, payload_json, blob_id,
          created_at, updated_at, deleted_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
        ON CONFLICT(id) DO UPDATE SET
          message_id = excluded.message_id,
          type = excluded.type,
          ordinal = excluded.ordinal,
          text = excluded.text,
          payload_json = excluded.payload_json,
          blob_id = excluded.blob_id,
          updated_at = excluded.updated_at,
          deleted_at = NULL,
          version = message_blocks.version + 1
      `,
      args: [
        blockId,
        messageId,
        type,
        ordinal,
        getBlockText(block),
        toJson(block),
        typeof block.blobId === 'string' ? block.blobId : typeof block.blob_id === 'string' ? block.blob_id : null,
        blockCreatedAt,
        blockUpdatedAt
      ]
    })

    await storageV2SyncLogService.recordChange({
      client,
      entityType: 'message_block',
      entityId: blockId,
      payload: {
        messageId,
        type,
        ordinal
      },
      version: await getVersion(client, 'message_blocks', blockId)
    })

    return {
      id: blockId,
      createdAt: blockCreatedAt,
      updatedAt: blockUpdatedAt
    }
  }

  async list(filter: { ownerType?: string; ownerId?: string } = {}): Promise<StoredConversation[]> {
    const client = await storageV2Database.getClient()
    const clauses = ['deleted_at IS NULL']
    const args: string[] = []

    if (filter.ownerType) {
      clauses.push('owner_type = ?')
      args.push(filter.ownerType)
    }

    if (filter.ownerId) {
      clauses.push('owner_id = ?')
      args.push(filter.ownerId)
    }

    const result = await client.execute({
      sql: `
        SELECT id, kind, owner_type, owner_id, session_id, title, pinned, archived, sort_order,
               created_at, updated_at, deleted_at, version
        FROM conversations
        WHERE ${clauses.join(' AND ')}
        ORDER BY pinned DESC, updated_at DESC, sort_order ASC
      `,
      args
    })

    return result.rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      ownerType: String(row.owner_type),
      ownerId: String(row.owner_id),
      sessionId: row.session_id ? String(row.session_id) : null,
      title: row.title ? String(row.title) : null,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      sortOrder: Number(row.sort_order),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
      version: Number(row.version)
    }))
  }

  async listMessages(
    conversationId: string,
    options: {
      limit?: number
      offset?: number
    } = {}
  ): Promise<StoredMessage[]> {
    const client = await storageV2Database.getClient()
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
    const offset = Math.max(options.offset ?? 0, 0)
    const messagesResult = await client.execute({
      sql: `
        SELECT id, conversation_id, role, status, parent_id, request_id, model_id, provider_id,
               token_usage_json, metadata_json, created_at, updated_at, deleted_at, version
        FROM messages
        WHERE conversation_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT ? OFFSET ?
      `,
      args: [conversationId, limit, offset]
    })
    const messageIds = messagesResult.rows.map((row) => String(row.id))
    const blocksByMessage = new Map<string, StoredMessageBlock[]>()

    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => '?').join(', ')
      const blocksResult = await client.execute({
        sql: `
          SELECT id, message_id, type, ordinal, text, payload_json, blob_id,
                 created_at, updated_at, deleted_at, version
          FROM message_blocks
          WHERE message_id IN (${placeholders}) AND deleted_at IS NULL
          ORDER BY message_id ASC, ordinal ASC, created_at ASC
        `,
        args: messageIds
      })

      for (const row of blocksResult.rows) {
        const messageId = String(row.message_id)
        const blocks = blocksByMessage.get(messageId) ?? []
        blocks.push({
          id: String(row.id),
          messageId,
          type: String(row.type),
          ordinal: Number(row.ordinal),
          text: row.text ? String(row.text) : null,
          payload: parseJson<Record<string, unknown> | null>(row.payload_json, null),
          blobId: row.blob_id ? String(row.blob_id) : null,
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          deletedAt: row.deleted_at ? String(row.deleted_at) : null,
          version: Number(row.version)
        })
        blocksByMessage.set(messageId, blocks)
      }
    }

    return messagesResult.rows.map((row) => {
      const id = String(row.id)
      return {
        id,
        conversationId: String(row.conversation_id),
        role: String(row.role),
        status: row.status ? String(row.status) : null,
        parentId: row.parent_id ? String(row.parent_id) : null,
        requestId: row.request_id ? String(row.request_id) : null,
        modelId: row.model_id ? String(row.model_id) : null,
        providerId: row.provider_id ? String(row.provider_id) : null,
        tokenUsage: parseJson<Record<string, unknown> | null>(row.token_usage_json, null),
        metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        deletedAt: row.deleted_at ? String(row.deleted_at) : null,
        version: Number(row.version),
        blocks: blocksByMessage.get(id) ?? []
      }
    })
  }

  async upsertConversation(
    conversation: StorageV2ConversationUpsert,
    options: StorageV2ConversationUpsertOptions = {}
  ): Promise<{ id: string }> {
    const client = await storageV2Database.getClient()
    const timestamp = now()

    await withTransaction(client, async () => {
      await this.upsertConversationRow(client, conversation, undefined, timestamp)

      if (options.pruneMissingMessages) {
        await softDeleteMissingConversationMessages(client, conversation.id, options.activeMessageIds ?? [], timestamp)
      }
    })

    return {
      id: conversation.id
    }
  }

  async upsertMessage(conversationId: string, message: Record<string, any>): Promise<{ id: string }> {
    const messageId = typeof message.id === 'string' && message.id ? message.id : ''
    if (!messageId) {
      throw new Error('Storage v2 message upsert requires message.id')
    }

    const client = await storageV2Database.getClient()
    const timestamp = now()

    await withTransaction(client, async () => {
      await this.upsertMessageRow(
        client,
        conversationId,
        message,
        messageId,
        timestamp,
        Array.isArray(message.blocks) ? message.blocks.length : 0
      )
    })

    return {
      id: messageId
    }
  }

  async upsertMessageBlocks(
    messageId: string,
    blocks: Array<Record<string, any>>,
    options: StorageV2MessageBlocksUpsertOptions = {}
  ): Promise<{ messageId: string; blockCount: number }> {
    const client = await storageV2Database.getClient()
    const timestamp = now()
    const blockIds = blocks.map((block, blockIndex) =>
      typeof block.id === 'string' && block.id ? block.id : `${messageId}:block:${blockIndex}`
    )

    await withTransaction(client, async () => {
      if (options.pruneMissing) {
        await softDeleteMissingMessageBlocks(client, messageId, blockIds, timestamp)
      }

      for (const [blockIndex, block] of blocks.entries()) {
        await this.upsertMessageBlockRow(client, messageId, block, blockIds[blockIndex], blockIndex, timestamp)
      }
    })

    return {
      messageId,
      blockCount: blocks.length
    }
  }

  async importConversation(conversation: StorageV2ConversationImport): Promise<{
    messageCount: number
    blockCount: number
  }> {
    const client = await storageV2Database.getClient()
    const timestamp = now()
    const blocksByMessage = new Map<string, Array<Record<string, any>>>()
    const importedMessageIds = conversation.messages.map((message, index) =>
      getImportMessageId(conversation.id, message, index)
    )

    for (const block of conversation.blocks) {
      const messageId = typeof block.messageId === 'string' ? block.messageId : ''
      if (!messageId) continue
      const blocks = blocksByMessage.get(messageId) ?? []
      blocks.push(block)
      blocksByMessage.set(messageId, blocks)
    }

    await withTransaction(client, async () => {
      const { createdAt } = await this.upsertConversationRow(
        client,
        conversation,
        {
          messageCount: conversation.messages.length,
          blockCount: conversation.blocks.length
        },
        timestamp
      )

      await softDeleteMissingConversationMessages(client, conversation.id, importedMessageIds, timestamp)

      for (const [messageIndex, message] of conversation.messages.entries()) {
        const messageId = getImportMessageId(conversation.id, message, messageIndex)
        const messageBlocks = blocksByMessage.get(messageId) ?? []
        const importedBlockIds = messageBlocks.map((block, blockIndex) =>
          typeof block.id === 'string' ? block.id : `${messageId}:block:${blockIndex}`
        )
        const messageResult = await this.upsertMessageRow(
          client,
          conversation.id,
          message,
          messageId,
          createdAt,
          messageBlocks.length
        )

        await softDeleteMissingMessageBlocks(client, messageId, importedBlockIds, timestamp)

        for (const [blockIndex, block] of messageBlocks.entries()) {
          const blockId = importedBlockIds[blockIndex]
          await this.upsertMessageBlockRow(client, messageId, block, blockId, blockIndex, messageResult.createdAt)
        }
      }
    })

    return {
      messageCount: conversation.messages.length,
      blockCount: conversation.blocks.length
    }
  }

  async delete(conversationId: string): Promise<{ deleted: boolean }> {
    const client = await storageV2Database.getClient()
    const deletedAt = now()
    let deleted = false

    await withTransaction(client, async () => {
      const existingResult = await client.execute({
        sql: 'SELECT version FROM conversations WHERE id = ? AND deleted_at IS NULL',
        args: [conversationId]
      })
      const existingVersion = Number(existingResult.rows[0]?.version ?? 0)
      deleted = existingVersion > 0

      const messagesResult = await client.execute({
        sql: `
          SELECT id, version
          FROM messages
          WHERE conversation_id = ? AND deleted_at IS NULL
        `,
        args: [conversationId]
      })
      const blocksResult = await client.execute({
        sql: `
          SELECT b.id, b.message_id, b.version
          FROM message_blocks b
          INNER JOIN messages m ON m.id = b.message_id
          WHERE m.conversation_id = ? AND b.deleted_at IS NULL
        `,
        args: [conversationId]
      })

      await client.execute({
        sql: `
          UPDATE message_blocks
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE message_id IN (
            SELECT id FROM messages WHERE conversation_id = ?
          ) AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, conversationId]
      })
      await client.execute({
        sql: `
          UPDATE messages
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE conversation_id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, conversationId]
      })
      await client.execute({
        sql: `
          UPDATE conversations
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, conversationId]
      })

      for (const row of blocksResult.rows) {
        const blockId = String(row.id)
        await storageV2SyncLogService.recordChange({
          client,
          entityType: 'message_block',
          entityId: blockId,
          operation: 'delete',
          payload: {
            id: blockId,
            messageId: String(row.message_id),
            conversationId,
            deletedAt
          },
          version: Number(row.version ?? 0) + 1
        })
      }

      for (const row of messagesResult.rows) {
        const messageId = String(row.id)
        await storageV2SyncLogService.recordChange({
          client,
          entityType: 'message',
          entityId: messageId,
          operation: 'delete',
          payload: {
            id: messageId,
            conversationId,
            deletedAt
          },
          version: Number(row.version ?? 0) + 1
        })
      }

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'conversation',
        entityId: conversationId,
        operation: 'delete',
        payload: { id: conversationId, deletedAt },
        version: existingVersion > 0 ? existingVersion + 1 : 1
      })
    })

    return {
      deleted
    }
  }

  async deleteMissingAssistantConversations(activeConversationIds: Iterable<string>): Promise<number> {
    const activeIds = new Set(activeConversationIds)
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT id
      FROM conversations
      WHERE owner_type = 'assistant' AND deleted_at IS NULL
    `)
    let deletedCount = 0

    for (const row of result.rows) {
      const conversationId = String(row.id)
      if (activeIds.has(conversationId)) continue

      const result = await this.delete(conversationId)
      if (result.deleted) {
        deletedCount++
      }
    }

    return deletedCount
  }
}

export class StorageV2KnowledgeRepository {
  async listBases(): Promise<Array<Record<string, any>>> {
    const client = await storageV2Database.getClient()
    const [basesResult, itemsResult] = await Promise.all([
      client.execute(`
        SELECT id, name, model_id, embedding_model_id, rerank_model_id, settings_json,
               created_at, updated_at, version
        FROM knowledge_bases
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
      `),
      client.execute(`
        SELECT id, knowledge_base_id, source_type, source_uri, file_id, content_hash,
               status, metadata_json, created_at, updated_at, version
        FROM knowledge_items
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC
      `)
    ])

    const itemsByBaseId = new Map<string, Array<Record<string, any>>>()

    for (const row of itemsResult.rows) {
      const baseId = typeof row.knowledge_base_id === 'string' ? row.knowledge_base_id : null
      const itemId = typeof row.id === 'string' ? row.id : null
      if (!baseId || !itemId) continue

      const itemSnapshot = parseJson<Record<string, any>>(row.metadata_json, {})
      const item = isRecord(itemSnapshot) ? { ...itemSnapshot } : {}
      item.id = typeof item.id === 'string' && item.id ? item.id : itemId
      item.baseId = typeof item.baseId === 'string' && item.baseId ? item.baseId : baseId
      item.type =
        typeof item.type === 'string' && item.type
          ? item.type
          : typeof row.source_type === 'string' && row.source_type
            ? row.source_type
            : 'unknown'
      item.content =
        item.content ??
        (typeof row.source_uri === 'string' && row.source_uri
          ? row.source_uri
          : typeof row.file_id === 'string'
            ? row.file_id
            : '')
      item.uniqueId =
        typeof item.uniqueId === 'string' && item.uniqueId
          ? item.uniqueId
          : typeof row.content_hash === 'string' && row.content_hash
            ? row.content_hash
            : undefined
      item.processingStatus =
        typeof item.processingStatus === 'string' && item.processingStatus
          ? item.processingStatus
          : typeof row.status === 'string'
            ? row.status
            : undefined
      item.created_at = toEpochMs(item.created_at ?? row.created_at)
      item.updated_at = toEpochMs(item.updated_at ?? row.updated_at, item.created_at)

      const items = itemsByBaseId.get(baseId) ?? []
      items.push(item)
      itemsByBaseId.set(baseId, items)
    }

    return basesResult.rows.flatMap((row) => {
      const baseId = typeof row.id === 'string' ? row.id : null
      if (!baseId) return []

      const baseSnapshot = parseJson<Record<string, any>>(row.settings_json, {})
      const base = isRecord(baseSnapshot) ? { ...baseSnapshot } : {}
      base.id = typeof base.id === 'string' && base.id ? base.id : baseId
      base.name =
        typeof base.name === 'string' && base.name ? base.name : typeof row.name === 'string' ? row.name : baseId
      base.created_at = toEpochMs(base.created_at ?? row.created_at)
      base.updated_at = toEpochMs(base.updated_at ?? row.updated_at, base.created_at)
      base.version = typeof base.version === 'number' ? base.version : Number(row.version ?? 1)
      base.items = itemsByBaseId.get(baseId) ?? []

      if (!base.model && typeof row.model_id === 'string' && row.model_id) {
        base.model = { id: row.model_id }
      }

      if (!base.rerankModel && typeof row.rerank_model_id === 'string' && row.rerank_model_id) {
        base.rerankModel = { id: row.rerank_model_id }
      }

      return [base]
    })
  }

  async importBases(bases: StorageV2KnowledgeBaseImport[]): Promise<{
    baseCount: number
    itemCount: number
    deletedBaseCount: number
    deletedItemCount: number
  }> {
    const client = await storageV2Database.getClient()
    const timestamp = now()
    const activeBaseIds = new Set<string>()
    const activeItemIdsByBase = new Map<string, Set<string>>()
    let itemCount = 0
    let deletedBaseCount = 0
    let deletedItemCount = 0

    await withTransaction(client, async () => {
      for (const [baseIndex, base] of bases.entries()) {
        const baseId = typeof base.id === 'string' && base.id ? base.id : `knowledge-base:${baseIndex}`
        const createdAt = toIsoTimestamp(base.created_at, timestamp)
        const updatedAt = toIsoTimestamp(base.updated_at, createdAt)
        const baseSnapshot = cloneJsonValue(base)
        baseSnapshot.items = []
        activeBaseIds.add(baseId)

        await client.execute({
          sql: `
            INSERT INTO knowledge_bases (
              id, name, model_id, embedding_model_id, rerank_model_id, settings_json,
              created_at, updated_at, deleted_at, version
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              model_id = excluded.model_id,
              embedding_model_id = excluded.embedding_model_id,
              rerank_model_id = excluded.rerank_model_id,
              settings_json = excluded.settings_json,
              updated_at = excluded.updated_at,
              deleted_at = NULL,
              version = knowledge_bases.version + 1
          `,
          args: [
            baseId,
            base.name ?? baseId,
            base.model?.id ?? null,
            base.model?.id ?? null,
            base.rerankModel?.id ?? null,
            toJson(baseSnapshot),
            createdAt,
            updatedAt
          ]
        })

        const activeItemIds = new Set<string>()
        activeItemIdsByBase.set(baseId, activeItemIds)

        for (const [itemIndex, item] of (Array.isArray(base.items) ? base.items : []).entries()) {
          const itemId = typeof item.id === 'string' && item.id ? item.id : `${baseId}:knowledge-item:${itemIndex}`
          const itemCreatedAt = toIsoTimestamp(item.created_at, createdAt)
          const itemUpdatedAt = toIsoTimestamp(item.updated_at, itemCreatedAt)
          activeItemIds.add(itemId)
          itemCount++

          await client.execute({
            sql: `
            INSERT INTO knowledge_items (
              id, knowledge_base_id, source_type, source_uri, file_id, content_hash,
              status, metadata_json, created_at, updated_at, deleted_at, version
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
            ON CONFLICT(id) DO UPDATE SET
              knowledge_base_id = excluded.knowledge_base_id,
              source_type = excluded.source_type,
              source_uri = excluded.source_uri,
              file_id = excluded.file_id,
              content_hash = excluded.content_hash,
              status = excluded.status,
              metadata_json = excluded.metadata_json,
              updated_at = excluded.updated_at,
              deleted_at = NULL,
              version = knowledge_items.version + 1
          `,
            args: [
              itemId,
              baseId,
              typeof item.type === 'string' ? item.type : 'unknown',
              getKnowledgeItemSourceUri(item),
              getKnowledgeItemFileId(item),
              typeof item.uniqueId === 'string' ? item.uniqueId : null,
              typeof item.processingStatus === 'string' ? item.processingStatus : 'completed',
              toJson(item),
              itemCreatedAt,
              itemUpdatedAt
            ]
          })

          await storageV2SyncLogService.recordChange({
            client,
            entityType: 'knowledge_item',
            entityId: itemId,
            payload: {
              id: itemId,
              knowledgeBaseId: baseId,
              sourceType: typeof item.type === 'string' ? item.type : 'unknown',
              fileId: getKnowledgeItemFileId(item),
              status: typeof item.processingStatus === 'string' ? item.processingStatus : 'completed'
            },
            version: await getVersion(client, 'knowledge_items', itemId)
          })
        }

        await storageV2SyncLogService.recordChange({
          client,
          entityType: 'knowledge_base',
          entityId: baseId,
          payload: {
            id: baseId,
            name: base.name ?? baseId,
            itemCount: activeItemIds.size
          },
          version: await getVersion(client, 'knowledge_bases', baseId)
        })
      }

      for (const [baseId, activeItemIds] of activeItemIdsByBase.entries()) {
        const existingItems = await client.execute({
          sql: `
            SELECT id, version
            FROM knowledge_items
            WHERE knowledge_base_id = ? AND deleted_at IS NULL
          `,
          args: [baseId]
        })

        for (const row of existingItems.rows) {
          const itemId = String(row.id)
          if (activeItemIds.has(itemId)) continue

          await client.execute({
            sql: `
              UPDATE knowledge_items
              SET deleted_at = ?, updated_at = ?, version = version + 1
              WHERE id = ? AND deleted_at IS NULL
            `,
            args: [timestamp, timestamp, itemId]
          })
          await storageV2SyncLogService.recordChange({
            client,
            entityType: 'knowledge_item',
            entityId: itemId,
            operation: 'delete',
            payload: { id: itemId, knowledgeBaseId: baseId, deletedAt: timestamp },
            version: Number(row.version ?? 0) + 1
          })
          deletedItemCount++
        }
      }

      const existingBases = await client.execute(`
        SELECT id, version
        FROM knowledge_bases
        WHERE deleted_at IS NULL
      `)
      for (const row of existingBases.rows) {
        const baseId = String(row.id)
        if (activeBaseIds.has(baseId)) continue

        const existingItems = await client.execute({
          sql: `
            SELECT id, version
            FROM knowledge_items
            WHERE knowledge_base_id = ? AND deleted_at IS NULL
          `,
          args: [baseId]
        })

        await client.execute({
          sql: `
            UPDATE knowledge_bases
            SET deleted_at = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND deleted_at IS NULL
          `,
          args: [timestamp, timestamp, baseId]
        })
        await client.execute({
          sql: `
            UPDATE knowledge_items
            SET deleted_at = ?, updated_at = ?, version = version + 1
            WHERE knowledge_base_id = ? AND deleted_at IS NULL
          `,
          args: [timestamp, timestamp, baseId]
        })
        for (const itemRow of existingItems.rows) {
          const itemId = String(itemRow.id)
          await storageV2SyncLogService.recordChange({
            client,
            entityType: 'knowledge_item',
            entityId: itemId,
            operation: 'delete',
            payload: { id: itemId, knowledgeBaseId: baseId, deletedAt: timestamp },
            version: Number(itemRow.version ?? 0) + 1
          })
          deletedItemCount++
        }
        await storageV2SyncLogService.recordChange({
          client,
          entityType: 'knowledge_base',
          entityId: baseId,
          operation: 'delete',
          payload: { id: baseId, deletedAt: timestamp },
          version: Number(row.version ?? 0) + 1
        })
        deletedBaseCount++
      }
    })

    return {
      baseCount: bases.length,
      itemCount,
      deletedBaseCount,
      deletedItemCount
    }
  }
}

export class StorageV2FileRepository {
  private toLegacyFile(row: Record<string, any>): Record<string, any> {
    const metadata = parseJson<Record<string, any>>(row.metadata_json, {})
    const id = String(row.id)
    const originalName = String(row.original_name ?? row.display_name ?? metadata.origin_name ?? metadata.name ?? id)
    const extCandidate = metadata.ext ?? row.blob_ext ?? path.extname(originalName)
    const ext =
      typeof extCandidate === 'string' && extCandidate
        ? extCandidate.startsWith('.')
          ? extCandidate
          : `.${extCandidate}`
        : ''

    return {
      ...metadata,
      id,
      name: metadata.name ?? `${id}${ext}`,
      origin_name: metadata.origin_name ?? originalName,
      path: metadata.path ?? '',
      size: typeof metadata.size === 'number' ? metadata.size : Number(row.blob_size ?? 0),
      ext,
      type: inferLegacyFileType(metadata.type, row.blob_mime, ext),
      created_at: metadata.created_at ?? row.created_at,
      count: typeof metadata.count === 'number' ? metadata.count : 1
    }
  }

  async get(fileId: string): Promise<Record<string, any> | null> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT
          f.id,
          f.original_name,
          f.display_name,
          f.metadata_json,
          f.created_at,
          b.ext AS blob_ext,
          b.mime AS blob_mime,
          b.size AS blob_size
        FROM files f
        INNER JOIN blobs b ON b.id = f.blob_id
        WHERE f.id = ? AND f.deleted_at IS NULL
      `,
      args: [fileId]
    })

    const row = result.rows[0] as Record<string, any> | undefined
    return row ? this.toLegacyFile(row) : null
  }

  async list(): Promise<Array<Record<string, any>>> {
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT
        f.id,
        f.original_name,
        f.display_name,
        f.metadata_json,
        f.created_at,
        b.ext AS blob_ext,
        b.mime AS blob_mime,
        b.size AS blob_size
      FROM files f
      INNER JOIN blobs b ON b.id = f.blob_id
      WHERE f.deleted_at IS NULL
      ORDER BY f.created_at ASC, f.id ASC
    `)

    return result.rows.map((row) => this.toLegacyFile(row as Record<string, any>))
  }

  async importFile(file: StorageV2FileImport): Promise<{
    imported: boolean
    skippedReason?: string
  }> {
    const sourcePath = typeof file.path === 'string' ? file.path : ''
    if (!sourcePath) {
      return { imported: false, skippedReason: 'missing path' }
    }

    if (!fs.existsSync(sourcePath)) {
      return { imported: false, skippedReason: `missing source file: ${sourcePath}` }
    }

    const stats = fs.statSync(sourcePath)
    if (!stats.isFile()) {
      return { imported: false, skippedReason: `source path is not a file: ${sourcePath}` }
    }

    const client = await storageV2Database.getClient()
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const checksum = await sha256File(sourcePath)
    const blobDir = path.join(rootInfo.dataRoot, 'blobs', 'sha256', checksum.slice(0, 2))
    const blobPath = path.join(blobDir, checksum)
    const storagePath = path.relative(rootInfo.dataRoot, blobPath)
    const timestamp = now()
    const fileId = file.id ?? checksum

    fs.mkdirSync(blobDir, { recursive: true })
    if (!fs.existsSync(blobPath)) {
      const tempPath = `${blobPath}.${process.pid}.${Date.now()}.tmp`
      fs.copyFileSync(sourcePath, tempPath)
      try {
        fs.renameSync(tempPath, blobPath)
      } catch (error) {
        fs.rmSync(tempPath, { force: true })
        if (!fs.existsSync(blobPath)) throw error
      }
    }

    await withTransaction(client, async () => {
      await client.execute({
        sql: `
          INSERT INTO blobs (id, algorithm, size, mime, ext, storage_path, checksum, created_at, ref_count)
          VALUES (?, 'sha256', ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET
            size = excluded.size,
            mime = excluded.mime,
            ext = excluded.ext,
            storage_path = excluded.storage_path,
            checksum = excluded.checksum
        `,
        args: [
          checksum,
          stats.size,
          typeof file.type === 'string' ? file.type : null,
          typeof file.ext === 'string' ? file.ext : path.extname(sourcePath),
          storagePath,
          checksum,
          timestamp
        ]
      })

      await client.execute({
        sql: `
          INSERT INTO files (
            id, blob_id, original_name, display_name, source, metadata_json, created_at, updated_at, deleted_at, version
          )
          VALUES (?, ?, ?, ?, 'legacy-dexie', ?, ?, ?, NULL, 1)
          ON CONFLICT(id) DO UPDATE SET
            blob_id = excluded.blob_id,
            original_name = excluded.original_name,
            display_name = excluded.display_name,
            source = excluded.source,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            version = files.version + 1
        `,
        args: [
          fileId,
          checksum,
          file.origin_name ?? file.name ?? path.basename(sourcePath),
          file.name ?? file.origin_name ?? path.basename(sourcePath),
          toJson(file),
          file.created_at ?? timestamp,
          timestamp
        ]
      })

      await client.execute({
        sql: `
          UPDATE blobs
          SET ref_count = (
            SELECT COUNT(*) FROM files WHERE blob_id = ? AND deleted_at IS NULL
          )
          WHERE id = ?
        `,
        args: [checksum, checksum]
      })

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'file',
        entityId: fileId,
        payload: {
          blobId: checksum,
          originalName: file.origin_name ?? file.name ?? path.basename(sourcePath),
          size: stats.size,
          source: 'legacy-dexie'
        },
        version: await getVersion(client, 'files', fileId)
      })
    })

    return { imported: true }
  }

  async delete(fileId: string): Promise<{ deleted: boolean }> {
    const client = await storageV2Database.getClient()
    const deletedAt = now()
    let deleted = false

    await withTransaction(client, async () => {
      const existingResult = await client.execute({
        sql: 'SELECT blob_id, version FROM files WHERE id = ? AND deleted_at IS NULL',
        args: [fileId]
      })
      const blobId = existingResult.rows[0]?.blob_id ? String(existingResult.rows[0].blob_id) : null
      const existingVersion = Number(existingResult.rows[0]?.version ?? 0)
      deleted = Boolean(blobId)

      await client.execute({
        sql: `
          UPDATE files
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        args: [deletedAt, deletedAt, fileId]
      })

      if (blobId) {
        await client.execute({
          sql: `
            UPDATE blobs
            SET ref_count = (
              SELECT COUNT(*) FROM files WHERE blob_id = ? AND deleted_at IS NULL
            )
            WHERE id = ?
          `,
          args: [blobId, blobId]
        })
      }

      await storageV2SyncLogService.recordChange({
        client,
        entityType: 'file',
        entityId: fileId,
        operation: 'delete',
        payload: { id: fileId, blobId, deletedAt },
        version: existingVersion > 0 ? existingVersion + 1 : 1
      })
    })

    return {
      deleted
    }
  }

  async deleteMissingLegacyFiles(activeFileIds: Iterable<string>): Promise<number> {
    const activeIds = new Set(activeFileIds)
    const client = await storageV2Database.getClient()
    const result = await client.execute(`
      SELECT id
      FROM files
      WHERE source = 'legacy-dexie' AND deleted_at IS NULL
    `)
    let deletedCount = 0

    for (const row of result.rows) {
      const fileId = String(row.id)
      if (activeIds.has(fileId)) continue

      const result = await this.delete(fileId)
      if (result.deleted) {
        deletedCount++
      }
    }

    return deletedCount
  }
}

export const storageV2SettingsRepository = new StorageV2SettingsRepository()
export const storageV2ProviderRepository = new StorageV2ProviderRepository()
export const storageV2AssistantRepository = new StorageV2AssistantRepository()
export const storageV2ConversationRepository = new StorageV2ConversationRepository()
export const storageV2KnowledgeRepository = new StorageV2KnowledgeRepository()
export const storageV2FileRepository = new StorageV2FileRepository()
