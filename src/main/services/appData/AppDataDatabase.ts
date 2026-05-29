import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { type Client, createClient } from '@libsql/client'
import { loggerService } from '@logger'
import { storageV2AppDataKvMirrorService } from '@main/services/storageV2/AppDataKvMirrorService'
import { getDataPath } from '@main/utils'

const logger = loggerService.withContext('AppDataDatabase')

export type AppDataRecord = {
  scope: string
  key: string
  value: unknown
  valueHash: string
  updatedAt: number
  deletedAt?: number | null
  deviceId: string
  version: number
}

export type WorkbenchShortcut = {
  id: string
  name: string
  url: string
  sourcePath?: string | null
  kind: 'html' | 'file' | 'url'
  metadata?: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

export type WorkbenchShortcutInput = Partial<WorkbenchShortcut> & Pick<WorkbenchShortcut, 'name' | 'url'>

export type InstalledHtmlArtifactShortcut = WorkbenchShortcut & {
  filePath: string
}

export type AppDataValueEntry<T = unknown> = {
  found: boolean
  value: T | null
  deletedAt?: number | null
}

export type AppDataCacheEntry<T = unknown> = {
  found: boolean
  value: T | null
  expiresAt?: number | null
}

type StorageV2WriteOptions = {
  storageV2Mirrored?: boolean
}

type Row = Record<string, any>

const DB_NAME = 'app.db'

function now() {
  return Date.now()
}

function hashValue(value: unknown, deletedAt?: number | null) {
  const payload = deletedAt ? { deletedAt } : value
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toRecord(row: Row): AppDataRecord {
  return {
    scope: row.scope,
    key: row.key,
    value: parseJson(row.value, null),
    valueHash: row.value_hash,
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
    deviceId: row.device_id,
    version: Number(row.version)
  }
}

function toShortcut(row: Row): WorkbenchShortcut {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    sourcePath: row.source_path,
    kind: row.kind,
    metadata: parseJson(row.metadata, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null
  }
}

export function createWorkbenchShortcutRecord(shortcut: WorkbenchShortcutInput, updatedAt = now()): WorkbenchShortcut {
  return {
    id: shortcut.id || randomUUID(),
    name: shortcut.name,
    url: shortcut.url,
    sourcePath: shortcut.sourcePath ?? null,
    kind: shortcut.kind || 'url',
    metadata: shortcut.metadata ?? null,
    createdAt: shortcut.createdAt || updatedAt,
    updatedAt: shortcut.updatedAt || updatedAt,
    deletedAt: null
  }
}

export class AppDataDatabase {
  private static instance: AppDataDatabase | null = null

  private client: Client | null = null
  private deviceId: string | null = null

  static async getInstance() {
    if (!AppDataDatabase.instance) {
      const instance = new AppDataDatabase()
      await instance.initialize()
      AppDataDatabase.instance = instance
    }

    return AppDataDatabase.instance
  }

  static async close() {
    const instance = AppDataDatabase.instance
    if (!instance) return

    AppDataDatabase.instance = null

    if (instance.client) {
      try {
        instance.client.close()
      } catch (error) {
        logger.warn('Failed to close app data database connection', error as Error)
      }
    }
  }

  private get dbPath() {
    return path.join(getDataPath(), DB_NAME)
  }

  private async initialize() {
    const dbDir = path.dirname(this.dbPath)
    await fs.promises.mkdir(dbDir, { recursive: true })

    this.client = createClient({
      url: `file:${this.dbPath}`,
      intMode: 'number'
    })

    await this.client.executeMultiple(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS app_records (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        value_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        device_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS app_cache (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        local_value TEXT,
        remote_value TEXT,
        base_hash TEXT,
        local_hash TEXT,
        remote_hash TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS workbench_shortcuts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        source_path TEXT,
        kind TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_app_records_scope_updated ON app_records(scope, updated_at);
      CREATE INDEX IF NOT EXISTS idx_app_records_updated ON app_records(updated_at);
      CREATE INDEX IF NOT EXISTS idx_app_cache_expires ON app_cache(expires_at);
    `)

    this.deviceId = await this.ensureDeviceId()
    logger.info(`App data database initialized at ${this.dbPath}`)
  }

  private async getClient() {
    if (!this.client) {
      await this.initialize()
    }

    return this.client!
  }

  async getRawClient() {
    return this.getClient()
  }

  private async ensureDeviceId() {
    const existing = await this.getSyncState<string>('device-id')
    if (existing) {
      await storageV2AppDataKvMirrorService.upsertSyncState('device-id', existing).catch((error) => {
        logger.warn('Failed to mirror existing app data device id to Storage v2', error as Error)
      })
      return existing
    }

    const storageDeviceId = await storageV2AppDataKvMirrorService.getSyncState<string>('device-id').catch((error) => {
      logger.warn('Failed to read app data device id from Storage v2', error as Error)
      return null
    })
    if (storageDeviceId) {
      await this.setSyncState('device-id', storageDeviceId, { storageV2Mirrored: true })
      return storageDeviceId
    }

    const id = randomUUID()
    await storageV2AppDataKvMirrorService.upsertSyncState('device-id', id).catch((error) => {
      logger.warn('Failed to mirror generated app data device id to Storage v2', error as Error)
    })
    await this.setSyncState('device-id', id, { storageV2Mirrored: true })
    return id
  }

  getDeviceId() {
    if (!this.deviceId) {
      throw new Error('App data database is not initialized')
    }

    return this.deviceId
  }

  async getRecord<T = unknown>(scope: string, key: string): Promise<T | null> {
    const entry = await this.getRecordEntry<T>(scope, key)
    return entry.found && entry.deletedAt == null ? entry.value : null
  }

  async getRecordEntry<T = unknown>(scope: string, key: string): Promise<AppDataValueEntry<T>> {
    const client = await this.getClient()
    const result = await client.execute({
      sql: 'SELECT value, deleted_at FROM app_records WHERE scope = ? AND key = ?',
      args: [scope, key]
    })
    const row = result.rows[0] as Row | undefined

    if (!row) {
      return { found: false, value: null, deletedAt: null }
    }

    const deletedAt = row.deleted_at == null ? null : Number(row.deleted_at)
    return {
      found: true,
      value: deletedAt == null ? (parseJson(row.value, null) as T) : null,
      deletedAt
    }
  }

  async listRecords(scope?: string, includeDeleted = false): Promise<AppDataRecord[]> {
    const client = await this.getClient()
    const clauses = scope ? ['scope = ?'] : []
    const args = scope ? [scope] : []

    if (!includeDeleted) {
      clauses.push('deleted_at IS NULL')
    }

    const result = await client.execute({
      sql: `SELECT * FROM app_records${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`,
      args
    })

    return result.rows.map((row) => toRecord(row as Row))
  }

  async setRecord(
    scope: string,
    key: string,
    value: unknown,
    updatedAt = now(),
    deviceId = this.getDeviceId(),
    options: StorageV2WriteOptions = {}
  ) {
    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.upsertRecord(scope, key, value, updatedAt)
    }

    const client = await this.getClient()
    const serialized = JSON.stringify(value ?? null)
    const valueHash = hashValue(value)

    await client.execute({
      sql: `
        INSERT INTO app_records (scope, key, value, value_hash, updated_at, deleted_at, device_id, version)
        VALUES (?, ?, ?, ?, ?, NULL, ?, 1)
        ON CONFLICT(scope, key) DO UPDATE SET
          value = excluded.value,
          value_hash = excluded.value_hash,
          updated_at = excluded.updated_at,
          deleted_at = NULL,
          device_id = excluded.device_id,
          version = app_records.version + 1
      `,
      args: [scope, key, serialized, valueHash, updatedAt, deviceId]
    })

    return { scope, key, value, valueHash, updatedAt, deletedAt: null, deviceId, version: 1 } satisfies AppDataRecord
  }

  async applyRemoteRecord(record: AppDataRecord, options: StorageV2WriteOptions = {}) {
    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.upsertRecordSnapshot(record)
    }

    const client = await this.getClient()
    await client.execute({
      sql: `
        INSERT INTO app_records (scope, key, value, value_hash, updated_at, deleted_at, device_id, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET
          value = excluded.value,
          value_hash = excluded.value_hash,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          device_id = excluded.device_id,
          version = excluded.version
      `,
      args: [
        record.scope,
        record.key,
        JSON.stringify(record.value ?? null),
        record.valueHash,
        record.updatedAt,
        record.deletedAt ?? null,
        record.deviceId,
        record.version
      ]
    })
  }

  async deleteRecord(scope: string, key: string, deletedAt = now(), options: StorageV2WriteOptions = {}) {
    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.deleteRecord(scope, key, deletedAt)
    }

    const valueHash = hashValue(null, deletedAt)
    const client = await this.getClient()

    await client.execute({
      sql: `
        INSERT INTO app_records (scope, key, value, value_hash, updated_at, deleted_at, device_id, version)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 1)
        ON CONFLICT(scope, key) DO UPDATE SET
          value = NULL,
          value_hash = excluded.value_hash,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          device_id = excluded.device_id,
          version = app_records.version + 1
      `,
      args: [scope, key, valueHash, deletedAt, deletedAt, this.getDeviceId()]
    })
  }

  async setCache(
    namespace: string,
    key: string,
    value: unknown,
    ttlMs?: number,
    updatedAt = now(),
    options: StorageV2WriteOptions = {}
  ) {
    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.upsertCache(namespace, key, value, ttlMs, updatedAt)
    }

    const client = await this.getClient()
    await client.execute({
      sql: `
        INSERT INTO app_cache (namespace, key, value, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      args: [namespace, key, JSON.stringify(value ?? null), ttlMs ? updatedAt + ttlMs : null, updatedAt]
    })
  }

  async getCache<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const entry = await this.getCacheEntry<T>(namespace, key)
    return entry.found ? entry.value : null
  }

  async getCacheEntry<T = unknown>(namespace: string, key: string): Promise<AppDataCacheEntry<T>> {
    const client = await this.getClient()
    const timestamp = now()
    const result = await client.execute({
      sql: 'SELECT value, expires_at FROM app_cache WHERE namespace = ? AND key = ?',
      args: [namespace, key]
    })
    const row = result.rows[0] as Row | undefined

    if (!row) {
      return { found: false, value: null, expiresAt: null }
    }

    const expiresAt = row.expires_at == null ? null : Number(row.expires_at)

    if (expiresAt != null && expiresAt <= timestamp) {
      await client.execute({ sql: 'DELETE FROM app_cache WHERE namespace = ? AND key = ?', args: [namespace, key] })
      return { found: false, value: null, expiresAt }
    }

    return {
      found: true,
      value: parseJson(row.value, null) as T,
      expiresAt
    }
  }

  async deleteCache(namespace: string, key: string, options: StorageV2WriteOptions = {}) {
    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.deleteCache(namespace, key)
    }

    const client = await this.getClient()
    await client.execute({ sql: 'DELETE FROM app_cache WHERE namespace = ? AND key = ?', args: [namespace, key] })
  }

  async getSyncState<T = unknown>(id: string): Promise<T | null> {
    const client = await this.getClient()
    const result = await client.execute({ sql: 'SELECT value FROM sync_state WHERE id = ?', args: [id] })
    const row = result.rows[0] as Row | undefined
    return row ? (parseJson(row.value, null) as T) : null
  }

  async setSyncState(id: string, value: unknown, options: StorageV2WriteOptions = {}) {
    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.upsertSyncState(id, value)
    }

    const client = await this.getClient()
    await client.execute({
      sql: `
        INSERT INTO sync_state (id, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      args: [id, JSON.stringify(value ?? null), now()]
    })
  }

  async createConflict(
    input: {
      id?: string
      scope: string
      key: string
      localRecord?: AppDataRecord
      remoteRecord: AppDataRecord
      baseHash?: string | null
    },
    options: StorageV2WriteOptions = {}
  ) {
    const client = await this.getClient()
    const id = input.id ?? `${input.scope}:${input.key}:${now()}`

    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.upsertSyncConflict(id, input)
    }

    await client.execute({
      sql: `
        INSERT INTO sync_conflicts
          (id, scope, key, local_value, remote_value, base_hash, local_hash, remote_hash, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      args: [
        id,
        input.scope,
        input.key,
        JSON.stringify(input.localRecord?.value ?? null),
        JSON.stringify(input.remoteRecord.value ?? null),
        input.baseHash ?? null,
        input.localRecord?.valueHash ?? null,
        input.remoteRecord.valueHash,
        now()
      ]
    })

    return id
  }

  async listConflicts(unresolvedOnly = true) {
    const client = await this.getClient()
    const result = await client.execute({
      sql: `SELECT * FROM sync_conflicts${unresolvedOnly ? ' WHERE resolved_at IS NULL' : ''} ORDER BY created_at DESC`,
      args: []
    })
    return result.rows
  }

  async upsertWorkbenchShortcut(shortcut: WorkbenchShortcutInput, options: StorageV2WriteOptions = {}) {
    const client = await this.getClient()
    const fullShortcut = createWorkbenchShortcutRecord(shortcut)

    if (!options.storageV2Mirrored) {
      await storageV2AppDataKvMirrorService.upsertWorkbenchShortcut(fullShortcut)
    }

    await client.execute({
      sql: `
        INSERT INTO workbench_shortcuts
          (id, name, url, source_path, kind, metadata, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          url = excluded.url,
          source_path = excluded.source_path,
          kind = excluded.kind,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `,
      args: [
        fullShortcut.id,
        fullShortcut.name,
        fullShortcut.url,
        fullShortcut.sourcePath ?? null,
        fullShortcut.kind,
        JSON.stringify(fullShortcut.metadata ?? null),
        fullShortcut.createdAt,
        fullShortcut.updatedAt
      ]
    })

    await this.setRecord(
      'workbench.shortcuts',
      fullShortcut.id,
      fullShortcut,
      fullShortcut.updatedAt,
      this.getDeviceId(),
      options
    )

    return fullShortcut
  }

  async listWorkbenchShortcuts(includeDeleted = false) {
    const client = await this.getClient()
    const result = await client.execute({
      sql: `SELECT * FROM workbench_shortcuts${includeDeleted ? '' : ' WHERE deleted_at IS NULL'} ORDER BY updated_at DESC`,
      args: []
    })
    return result.rows.map((row) => toShortcut(row as Row))
  }

  async hasWorkbenchShortcutRows() {
    const client = await this.getClient()
    const result = await client.execute({
      sql: 'SELECT 1 FROM workbench_shortcuts LIMIT 1',
      args: []
    })
    return result.rows.length > 0
  }

  async prepareHtmlArtifactShortcut(
    input: { title?: string; html: string },
    updatedAt = now()
  ): Promise<InstalledHtmlArtifactShortcut> {
    const id = randomUUID()
    const safeName = `${(input.title || 'HTML Artifact').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}-${id.slice(0, 8)}.html`
    const dir = getDataPath('Workbench')
    const filePath = path.join(dir, safeName)

    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, input.html, 'utf8')

    return {
      ...createWorkbenchShortcutRecord(
        {
          id,
          name: input.title || 'HTML Artifact',
          url: pathToFileURL(filePath).toString(),
          sourcePath: filePath,
          kind: 'html',
          metadata: { installedFrom: 'agent-html-artifact' }
        },
        updatedAt
      ),
      filePath
    }
  }

  async installHtmlArtifact(input: { title?: string; html: string }) {
    const shortcut = await this.prepareHtmlArtifactShortcut(input)
    await this.upsertWorkbenchShortcut({
      id: shortcut.id,
      name: shortcut.name,
      url: shortcut.url,
      sourcePath: shortcut.sourcePath,
      kind: shortcut.kind,
      metadata: shortcut.metadata,
      createdAt: shortcut.createdAt,
      updatedAt: shortcut.updatedAt
    })

    return shortcut
  }
}

export const getAppDataDatabase = () => AppDataDatabase.getInstance()
