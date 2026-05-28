import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { type Client, createClient } from '@libsql/client'
import { loggerService } from '@logger'
import { app } from 'electron'

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
    return path.join(app.getPath('userData'), 'Data', DB_NAME)
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
      return existing
    }

    const id = randomUUID()
    await this.setSyncState('device-id', id)
    return id
  }

  getDeviceId() {
    if (!this.deviceId) {
      throw new Error('App data database is not initialized')
    }

    return this.deviceId
  }

  async getRecord<T = unknown>(scope: string, key: string): Promise<T | null> {
    const client = await this.getClient()
    const result = await client.execute({
      sql: 'SELECT * FROM app_records WHERE scope = ? AND key = ? AND deleted_at IS NULL',
      args: [scope, key]
    })
    const row = result.rows[0] as Row | undefined
    return row ? (parseJson(row.value, null) as T) : null
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

  async setRecord(scope: string, key: string, value: unknown, updatedAt = now(), deviceId = this.getDeviceId()) {
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

  async applyRemoteRecord(record: AppDataRecord) {
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

  async deleteRecord(scope: string, key: string) {
    const timestamp = now()
    const valueHash = hashValue(null, timestamp)
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
      args: [scope, key, valueHash, timestamp, timestamp, this.getDeviceId()]
    })
  }

  async setCache(namespace: string, key: string, value: unknown, ttlMs?: number) {
    const client = await this.getClient()
    const timestamp = now()
    await client.execute({
      sql: `
        INSERT INTO app_cache (namespace, key, value, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      args: [namespace, key, JSON.stringify(value ?? null), ttlMs ? timestamp + ttlMs : null, timestamp]
    })
  }

  async getCache<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const client = await this.getClient()
    const timestamp = now()
    const result = await client.execute({
      sql: 'SELECT value, expires_at FROM app_cache WHERE namespace = ? AND key = ?',
      args: [namespace, key]
    })
    const row = result.rows[0] as Row | undefined

    if (!row) {
      return null
    }

    if (row.expires_at && Number(row.expires_at) <= timestamp) {
      await client.execute({ sql: 'DELETE FROM app_cache WHERE namespace = ? AND key = ?', args: [namespace, key] })
      return null
    }

    return parseJson(row.value, null) as T
  }

  async deleteCache(namespace: string, key: string) {
    const client = await this.getClient()
    await client.execute({ sql: 'DELETE FROM app_cache WHERE namespace = ? AND key = ?', args: [namespace, key] })
  }

  async getSyncState<T = unknown>(id: string): Promise<T | null> {
    const client = await this.getClient()
    const result = await client.execute({ sql: 'SELECT value FROM sync_state WHERE id = ?', args: [id] })
    const row = result.rows[0] as Row | undefined
    return row ? (parseJson(row.value, null) as T) : null
  }

  async setSyncState(id: string, value: unknown) {
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

  async createConflict(input: {
    scope: string
    key: string
    localRecord?: AppDataRecord
    remoteRecord: AppDataRecord
    baseHash?: string | null
  }) {
    const client = await this.getClient()
    const id = `${input.scope}:${input.key}:${now()}`

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

  async upsertWorkbenchShortcut(shortcut: Partial<WorkbenchShortcut> & Pick<WorkbenchShortcut, 'name' | 'url'>) {
    const client = await this.getClient()
    const timestamp = now()
    const fullShortcut: WorkbenchShortcut = {
      id: shortcut.id || randomUUID(),
      name: shortcut.name,
      url: shortcut.url,
      sourcePath: shortcut.sourcePath ?? null,
      kind: shortcut.kind || 'url',
      metadata: shortcut.metadata ?? null,
      createdAt: shortcut.createdAt || timestamp,
      updatedAt: timestamp,
      deletedAt: null
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

    await this.setRecord('workbench.shortcuts', fullShortcut.id, fullShortcut, fullShortcut.updatedAt)

    return fullShortcut
  }

  async listWorkbenchShortcuts() {
    const client = await this.getClient()
    const result = await client.execute({
      sql: 'SELECT * FROM workbench_shortcuts WHERE deleted_at IS NULL ORDER BY updated_at DESC',
      args: []
    })
    return result.rows.map((row) => toShortcut(row as Row))
  }

  async installHtmlArtifact(input: { title?: string; html: string }) {
    const id = randomUUID()
    const safeName = `${(input.title || 'HTML Artifact').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}-${id.slice(0, 8)}.html`
    const dir = path.join(app.getPath('userData'), 'Data', 'Workbench')
    const filePath = path.join(dir, safeName)

    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, input.html, 'utf8')

    const shortcut = await this.upsertWorkbenchShortcut({
      id,
      name: input.title || 'HTML Artifact',
      url: pathToFileURL(filePath).toString(),
      sourcePath: filePath,
      kind: 'html',
      metadata: { installedFrom: 'agent-html-artifact' }
    })

    return { ...shortcut, filePath }
  }
}

export const getAppDataDatabase = () => AppDataDatabase.getInstance()
