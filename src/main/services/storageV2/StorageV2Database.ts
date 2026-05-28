import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { type Client, createClient } from '@libsql/client'
import { loggerService } from '@logger'

import { storageV2DataRootService } from './DataRootService'
import { scanStorageV2SecretReferences } from './SecretRefIntegrity'
import { storageV2SecretVaultService } from './SecretVaultService'
import type {
  StorageV2HealthCheck,
  StorageV2IntegrityIssue,
  StorageV2IntegrityReport,
  StorageV2SecretVaultPruneReport,
  StorageV2Snapshot
} from './types'

const logger = loggerService.withContext('StorageV2Database')
const DB_SCHEMA_VERSION = '2'

type ColumnMigration = {
  table: string
  column: string
  definition: string
}

const COLUMN_MIGRATIONS: ColumnMigration[] = [
  { table: 'files', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'skills', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'scheduled_tasks', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'task_run_logs', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'channels', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'knowledge_bases', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'knowledge_items', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' }
]

function quoteSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

const INTEGRITY_ISSUE_CHECKS: Array<{ id: string; label: string; sql: string }> = [
  {
    id: 'models_without_provider',
    label: 'Models without provider',
    sql: 'SELECT COUNT(*) AS count FROM models m LEFT JOIN providers p ON p.id = m.provider_id WHERE p.id IS NULL'
  },
  {
    id: 'provider_credentials_without_provider',
    label: 'Provider credentials without provider',
    sql: `
      SELECT COUNT(*) AS count
      FROM provider_credentials c
      LEFT JOIN providers p ON p.id = c.provider_id
      WHERE p.id IS NULL
    `
  },
  {
    id: 'agent_sessions_without_agent',
    label: 'Agent sessions without agent',
    sql: 'SELECT COUNT(*) AS count FROM agent_sessions s LEFT JOIN agents a ON a.id = s.agent_id WHERE a.id IS NULL'
  },
  {
    id: 'messages_without_conversation',
    label: 'Messages without conversation',
    sql: `
      SELECT COUNT(*) AS count
      FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE c.id IS NULL
    `
  },
  {
    id: 'message_blocks_without_message',
    label: 'Message blocks without message',
    sql: `
      SELECT COUNT(*) AS count
      FROM message_blocks b
      LEFT JOIN messages m ON m.id = b.message_id
      WHERE m.id IS NULL
    `
  },
  {
    id: 'files_without_blob',
    label: 'Files without blob',
    sql: 'SELECT COUNT(*) AS count FROM files f LEFT JOIN blobs b ON b.id = f.blob_id WHERE b.id IS NULL'
  },
  {
    id: 'agent_skills_without_agent',
    label: 'Agent skills without agent',
    sql: 'SELECT COUNT(*) AS count FROM agent_skills s LEFT JOIN agents a ON a.id = s.agent_id WHERE a.id IS NULL'
  },
  {
    id: 'agent_skills_without_skill',
    label: 'Agent skills without skill',
    sql: 'SELECT COUNT(*) AS count FROM agent_skills a LEFT JOIN skills s ON s.id = a.skill_id WHERE s.id IS NULL'
  },
  {
    id: 'tasks_without_agent',
    label: 'Scheduled tasks without agent',
    sql: 'SELECT COUNT(*) AS count FROM scheduled_tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE a.id IS NULL'
  },
  {
    id: 'task_logs_without_task',
    label: 'Task logs without task',
    sql: `
      SELECT COUNT(*) AS count
      FROM task_run_logs l
      LEFT JOIN scheduled_tasks t ON t.id = l.task_id
      WHERE t.id IS NULL
    `
  },
  {
    id: 'knowledge_items_without_base',
    label: 'Knowledge items without knowledge base',
    sql: `
      SELECT COUNT(*) AS count
      FROM knowledge_items i
      LEFT JOIN knowledge_bases b ON b.id = i.knowledge_base_id
      WHERE b.id IS NULL
    `
  }
]

function getSinglePragmaValue(result: Awaited<ReturnType<Client['execute']>>) {
  return String(Object.values(result.rows[0] ?? {})[0] ?? 'unknown')
}

function getCountValue(result: Awaited<ReturnType<Client['execute']>>) {
  return Number(Object.values(result.rows[0] ?? {})[0] ?? 0)
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

function readVaultSecretIds(vaultPath: string): {
  secretIds: Set<string>
  invalid: boolean
} {
  if (!fs.existsSync(vaultPath)) {
    return {
      secretIds: new Set(),
      invalid: false
    }
  }

  try {
    const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf-8')) as Record<string, any>
    if (vault.version !== 1 || !vault.secrets || typeof vault.secrets !== 'object') {
      return {
        secretIds: new Set(),
        invalid: true
      }
    }

    const secretIds = new Set<string>()
    for (const [secretId, record] of Object.entries(vault.secrets)) {
      if (
        !secretId ||
        !record ||
        typeof record !== 'object' ||
        typeof (record as Record<string, unknown>).encrypted !== 'string' ||
        (record as Record<string, unknown>).encoding !== 'electron-safe-storage'
      ) {
        return {
          secretIds,
          invalid: true
        }
      }
      secretIds.add(secretId)
    }

    return {
      secretIds,
      invalid: false
    }
  } catch {
    return {
      secretIds: new Set(),
      invalid: true
    }
  }
}

async function columnExists(client: Client, table: string, column: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`)
  return result.rows.some((row) => row.name === column)
}

async function applyColumnMigrations(client: Client) {
  for (const migration of COLUMN_MIGRATIONS) {
    if (await columnExists(client, migration.table, migration.column)) continue

    await client.execute(
      `ALTER TABLE ${quoteIdentifier(migration.table)} ADD COLUMN ${quoteIdentifier(migration.column)} ${
        migration.definition
      }`
    )
  }
}

export class StorageV2Database {
  private client: Client | null = null
  private dbPath: string | null = null
  private initializing: Promise<void> | null = null
  private exclusiveQueue: Promise<unknown> = Promise.resolve()

  async getClient(): Promise<Client> {
    if (!this.client) {
      await this.initialize()
    }
    return this.client!
  }

  close() {
    if (!this.client) return

    try {
      this.client.close()
    } finally {
      this.client = null
      this.dbPath = null
      this.initializing = null
    }
  }

  async initialize() {
    if (this.client) return
    if (this.initializing) {
      await this.initializing
      return
    }

    this.initializing = this.initializeInternal().finally(() => {
      this.initializing = null
    })

    await this.initializing
  }

  async withTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
    return this.enqueueExclusive(async () => {
      await client.execute('BEGIN IMMEDIATE')
      try {
        const result = await fn()
        await client.execute('COMMIT')
        return result
      } catch (error) {
        await client.execute('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async waitForIdle(): Promise<void> {
    await this.exclusiveQueue
  }

  private async enqueueExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.exclusiveQueue.then(operation, operation)
    this.exclusiveQueue = result.catch(() => undefined)
    return result
  }

  private async initializeInternal() {
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const dbPath = path.join(rootInfo.dataRoot, 'main.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    this.client = createClient({
      url: `file:${dbPath}`,
      intMode: 'number'
    })
    this.dbPath = dbPath

    await this.client.executeMultiple(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS storage_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar_blob_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        public_key TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT,
        scope TEXT NOT NULL DEFAULT 'app',
        updated_at TEXT NOT NULL,
        updated_by_device_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        api_host TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        group_name TEXT,
        capabilities_json TEXT,
        config_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_credentials (
        provider_id TEXT NOT NULL,
        credential_kind TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_device_id TEXT,
        PRIMARY KEY (provider_id, credential_kind),
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS assistants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        prompt TEXT,
        model_id TEXT,
        settings_json TEXT,
        avatar_blob_id TEXT,
        tags_json TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS assistant_versions (
        id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_device_id TEXT,
        FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        model_id TEXT,
        plan_model_id TEXT,
        small_model_id TEXT,
        accessible_paths_json TEXT,
        mcps_json TEXT,
        allowed_tools_json TEXT,
        configuration_json TEXT,
        avatar_blob_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS agent_versions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_device_id TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        inherited_config_json TEXT,
        current_config_json TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        session_id TEXT,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT,
        parent_id TEXT,
        request_id TEXT,
        model_id TEXT,
        provider_id TEXT,
        token_usage_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS message_blocks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0,
        text TEXT,
        payload_json TEXT,
        blob_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS blobs (
        id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL DEFAULT 'sha256',
        size INTEGER NOT NULL,
        mime TEXT,
        ext TEXT,
        storage_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ref_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        blob_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        display_name TEXT,
        source TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (blob_id) REFERENCES blobs(id)
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        folder_name TEXT NOT NULL,
        source TEXT NOT NULL,
        source_url TEXT,
        namespace TEXT,
        author TEXT,
        tags_json TEXT,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, skill_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timeout_minutes INTEGER NOT NULL DEFAULT 2,
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT,
        run_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        config_json TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        active_chat_ids_json TEXT,
        permission_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model_id TEXT,
        embedding_model_id TEXT,
        rerank_model_id TEXT,
        settings_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_uri TEXT,
        file_id TEXT,
        content_hash TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS kv_records (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT,
        source TEXT,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS sync_changes (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT,
        base_version INTEGER,
        version INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_tombstones (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        device_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        local_snapshot_json TEXT,
        remote_snapshot_json TEXT,
        base_version INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS migration_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        snapshot_path TEXT,
        report_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_settings_scope ON settings(scope);
      CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_id ON agent_sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_message_blocks_message_id ON message_blocks(message_id);
      CREATE INDEX IF NOT EXISTS idx_files_blob_id ON files(blob_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_folder_name ON skills(folder_name);
      CREATE INDEX IF NOT EXISTS idx_agent_skills_agent_id ON agent_skills(agent_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent_id ON scheduled_tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_channels_agent_id ON channels(agent_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_base_id ON knowledge_items(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_migration_runs_created_at ON migration_runs(created_at);
    `)

    await applyColumnMigrations(this.client)

    const now = new Date().toISOString()
    await this.client.execute({
      sql: `
        INSERT INTO storage_meta (key, value, updated_at)
        VALUES ('schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
      args: [DB_SCHEMA_VERSION, now]
    })

    logger.info('Storage v2 database initialized', { dbPath })
  }

  async healthCheck(): Promise<StorageV2HealthCheck> {
    const client = await this.getClient()
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const result = await client.execute('PRAGMA quick_check')
    const quickCheck = getSinglePragmaValue(result)

    return {
      ok: quickCheck.toLowerCase() === 'ok',
      dataRoot: rootInfo.dataRoot,
      dbPath: this.dbPath ?? path.join(rootInfo.dataRoot, 'main.db'),
      manifest: rootInfo.manifest!,
      quickCheck
    }
  }

  async integrityReport(): Promise<StorageV2IntegrityReport> {
    const client = await this.getClient()
    const [quickCheckResult, integrityCheckResult, foreignKeyCheckResult] = await Promise.all([
      client.execute('PRAGMA quick_check'),
      client.execute('PRAGMA integrity_check'),
      client.execute('PRAGMA foreign_key_check')
    ])
    const issues: StorageV2IntegrityIssue[] = []
    const rootInfo = storageV2DataRootService.ensureDataRoot()

    for (const check of INTEGRITY_ISSUE_CHECKS) {
      const result = await client.execute(check.sql)
      const count = getCountValue(result)
      if (count > 0) {
        issues.push({
          id: check.id,
          label: check.label,
          count
        })
      }
    }

    const blobsResult = await client.execute(`
      SELECT id, storage_path, checksum
      FROM blobs
      WHERE storage_path IS NOT NULL AND storage_path != ''
    `)
    let missingBlobFileCount = 0
    let corruptBlobFileCount = 0

    for (const row of blobsResult.rows) {
      const storagePath = String(row.storage_path)
      const blobPath = path.join(rootInfo.dataRoot, storagePath)
      if (!fs.existsSync(blobPath)) {
        missingBlobFileCount++
        continue
      }

      const checksum = typeof row.checksum === 'string' ? row.checksum : null
      if (checksum && (await sha256File(blobPath)) !== checksum) {
        corruptBlobFileCount++
      }
    }

    if (missingBlobFileCount > 0) {
      issues.push({
        id: 'missing_blob_files',
        label: 'Blob files missing on disk',
        count: missingBlobFileCount
      })
    }

    if (corruptBlobFileCount > 0) {
      issues.push({
        id: 'corrupt_blob_files',
        label: 'Blob checksum mismatches',
        count: corruptBlobFileCount
      })
    }

    const secretReferenceScan = await scanStorageV2SecretReferences(client)
    const vault = readVaultSecretIds(path.join(rootInfo.dataRoot, 'secrets', 'vault.json'))
    const missingSecretRefCount = Array.from(secretReferenceScan.refs).filter(
      (secretId) => !vault.secretIds.has(secretId)
    ).length

    if (secretReferenceScan.invalidRefs.size > 0) {
      issues.push({
        id: 'invalid_secret_refs',
        label: 'Invalid secret references',
        count: secretReferenceScan.invalidRefs.size
      })
    }

    if (missingSecretRefCount > 0) {
      issues.push({
        id: 'missing_secret_refs',
        label: 'Secret references missing vault entries',
        count: missingSecretRefCount
      })
    }

    if (vault.invalid) {
      issues.push({
        id: 'secret_vault_invalid',
        label: 'Secret vault file is invalid',
        count: 1
      })
    }

    const quickCheck = getSinglePragmaValue(quickCheckResult)
    const integrityCheck = getSinglePragmaValue(integrityCheckResult)
    const foreignKeyIssueCount = foreignKeyCheckResult.rows.length

    return {
      ok:
        quickCheck.toLowerCase() === 'ok' &&
        integrityCheck.toLowerCase() === 'ok' &&
        foreignKeyIssueCount === 0 &&
        issues.length === 0,
      generatedAt: new Date().toISOString(),
      quickCheck,
      integrityCheck,
      foreignKeyIssueCount,
      issues
    }
  }

  async pruneUnreferencedSecretVaultEntries(): Promise<StorageV2SecretVaultPruneReport> {
    const client = await this.getClient()
    const secretReferenceScan = await scanStorageV2SecretReferences(client)
    const pruneResult = await storageV2SecretVaultService.pruneUnreferencedSecretIds(secretReferenceScan.refs)

    return {
      ...pruneResult,
      referencedSecretCount: secretReferenceScan.refs.size,
      invalidSecretRefCount: secretReferenceScan.invalidRefs.size,
      skippedSources: secretReferenceScan.skippedSources
    }
  }

  async createSnapshot(reason: string): Promise<StorageV2Snapshot> {
    return this.enqueueExclusive(async () => {
      const client = await this.getClient()
      const rootInfo = storageV2DataRootService.ensureDataRoot()
      const snapshotsDir = path.join(rootInfo.dataRoot, 'snapshots')
      fs.mkdirSync(snapshotsDir, { recursive: true })

      const createdAt = new Date().toISOString()
      const safeReason = reason.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'manual'
      const snapshotPath = path.join(snapshotsDir, `${timestampForFilename()}-${safeReason}.db`)

      await client.execute(`VACUUM INTO ${quoteSqlString(snapshotPath)}`)

      return {
        path: snapshotPath,
        reason,
        createdAt
      }
    })
  }
}

export const storageV2Database = new StorageV2Database()
