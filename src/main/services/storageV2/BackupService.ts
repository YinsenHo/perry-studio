import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createClient } from '@libsql/client'
import { app, safeStorage } from 'electron'

import { configManager } from '../ConfigManager'
import KnowledgeService from '../KnowledgeService'
import MemoryService from '../memory/MemoryService'
import {
  type StorageV2AgentLegacyProjectionReport,
  storageV2AgentLegacyProjectionService
} from './AgentLegacyProjectionService'
import {
  type StorageV2AppDataLegacyProjectionReport,
  storageV2AppDataLegacyProjectionService
} from './AppDataLegacyProjectionService'
import { storageV2DataRootService } from './DataRootService'
import {
  type StorageV2FileLegacyProjectionReport,
  storageV2FileLegacyProjectionService
} from './FileLegacyProjectionService'
import { movePathSync } from './SafeFileMove'
import { scanStorageV2SecretReferences } from './SecretRefIntegrity'
import { storageV2SecretVaultService } from './SecretVaultService'
import { storageV2StatisticsService } from './StatisticsService'
import { storageV2Database } from './StorageV2Database'
import { storageV2SettingsRepository } from './StorageV2Repositories'

export type StorageV2Backup = {
  path: string
  dbPath: string
  manifestPath: string
  reason: string
  createdAt: string
  copiedDirectories: string[]
}

export type StorageV2BackupOverview = {
  backupRoot: string
  backupCount: number
  latestBackupPath: string | null
  latestBackupCreatedAt: string | null
  latestBackupReason: string | null
}

export type StorageV2BackupValidationMessage = {
  id: string
  message: string
  values?: Record<string, number | string>
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
  issues: StorageV2BackupValidationMessage[]
  warnings: StorageV2BackupValidationMessage[]
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
  agentLegacyProjection: StorageV2AgentLegacyProjectionReport
  fileLegacyProjection: StorageV2FileLegacyProjectionReport
  appDataLegacyProjection: StorageV2AppDataLegacyProjectionReport
  validation: StorageV2BackupValidation
  requiresRestart: true
  warnings: string[]
}

const RESTORABLE_DIRECTORIES = [
  'blobs',
  'secrets',
  'KnowledgeBase',
  'Memory',
  'Skills',
  'Agents',
  'Channels',
  'Workbench',
  'Notes',
  'Workspace'
] as const
const RESTORABLE_DB_FILES = ['main.db', 'main.db-wal', 'main.db-shm'] as const
const RESTORABLE_DIRECTORY_SET = new Set<string>(RESTORABLE_DIRECTORIES)
const REQUIRED_BACKUP_TABLES = [
  'storage_meta',
  'profiles',
  'devices',
  'settings',
  'providers',
  'models',
  'provider_credentials',
  'assistants',
  'assistant_versions',
  'agents',
  'agent_versions',
  'agent_sessions',
  'conversations',
  'messages',
  'message_blocks',
  'blobs',
  'files',
  'skills',
  'agent_skills',
  'scheduled_tasks',
  'task_run_logs',
  'channels',
  'channel_task_subscriptions',
  'knowledge_bases',
  'knowledge_items',
  'kv_records',
  'sync_changes',
  'sync_tombstones',
  'sync_state',
  'sync_conflicts',
  'migration_runs'
] as const

function quoteSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'manual'
}

function validationMessage(
  id: string,
  message: string,
  values?: Record<string, number | string>
): StorageV2BackupValidationMessage {
  return {
    id,
    message,
    values
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createProjectionWarning(label: string, error: unknown) {
  return `${label} legacy runtime projection failed after Storage v2 restore: ${errorMessage(error)}`
}

function getRuntimeDataPath(subPath?: string) {
  const dataRoot =
    typeof storageV2DataRootService.resolveDataRoot === 'function'
      ? storageV2DataRootService.resolveDataRoot().dataRoot
      : storageV2DataRootService.ensureDataRoot().dataRoot
  return subPath ? path.join(dataRoot, subPath) : dataRoot
}

function failedAgentProjectionReport(warning: string): StorageV2AgentLegacyProjectionReport {
  return {
    agentDbPath: getRuntimeDataPath('agents.db'),
    archivedFiles: [],
    projectedAgentCount: 0,
    projectedPlaceholderAgentCount: 0,
    projectedSessionCount: 0,
    projectedSessionMessageCount: 0,
    projectedSkillCount: 0,
    projectedPlaceholderSkillCount: 0,
    projectedAgentSkillCount: 0,
    projectedTaskCount: 0,
    projectedTaskRunLogCount: 0,
    projectedChannelCount: 0,
    projectedChannelTaskSubscriptionCount: 0,
    skippedSessionCount: 0,
    skippedSessionMessageCount: 0,
    skippedAgentSkillCount: 0,
    skippedTaskCount: 0,
    skippedTaskRunLogCount: 0,
    skippedChannelCount: 0,
    skippedChannelTaskSubscriptionCount: 0,
    restoredChannelSecretCount: 0,
    missingChannelSecretCount: 0,
    warnings: [warning]
  }
}

function failedFileProjectionReport(warning: string): StorageV2FileLegacyProjectionReport {
  return {
    filesDir: getRuntimeDataPath('Files'),
    projectedFileCount: 0,
    archivedFileCount: 0,
    skippedFileCount: 0,
    missingBlobCount: 0,
    archivedFiles: [],
    warnings: [warning]
  }
}

function failedAppDataProjectionReport(warning: string): StorageV2AppDataLegacyProjectionReport {
  return {
    appDbPath: getRuntimeDataPath('app.db'),
    archivedFiles: [],
    projectedRecordCount: 0,
    projectedCacheCount: 0,
    projectedSyncStateCount: 0,
    projectedSyncConflictCount: 0,
    projectedWorkbenchShortcutCount: 0,
    restoredSecretCount: 0,
    missingSecretCount: 0,
    warnings: [warning]
  }
}

function readJsonFile(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>
  } catch {
    return null
  }
}

function validateSecretVaultFile(vaultPath: string): {
  exists: boolean
  secretCount: number
  secretIds: Set<string>
  decryptabilityChecked: boolean
  undecryptableSecretIds: Set<string>
  issue?: StorageV2BackupValidationMessage
} {
  if (!fs.existsSync(vaultPath)) {
    return {
      exists: false,
      secretCount: 0,
      secretIds: new Set(),
      decryptabilityChecked: safeStorage.isEncryptionAvailable(),
      undecryptableSecretIds: new Set()
    }
  }

  const vault = readJsonFile(vaultPath)
  if (!vault || vault.version !== 1 || !vault.secrets || typeof vault.secrets !== 'object') {
    return {
      exists: true,
      secretCount: 0,
      secretIds: new Set(),
      decryptabilityChecked: safeStorage.isEncryptionAvailable(),
      undecryptableSecretIds: new Set(),
      issue: validationMessage('secret_vault_invalid', 'Backup secret vault is missing required fields.')
    }
  }

  let secretCount = 0
  const secretIds = new Set<string>()
  const decryptabilityChecked = safeStorage.isEncryptionAvailable()
  const undecryptableSecretIds = new Set<string>()
  for (const [secretId, record] of Object.entries(vault.secrets)) {
    if (
      !secretId ||
      !record ||
      typeof record !== 'object' ||
      typeof (record as Record<string, unknown>).encrypted !== 'string' ||
      (record as Record<string, unknown>).encoding !== 'electron-safe-storage'
    ) {
      return {
        exists: true,
        secretCount,
        secretIds,
        decryptabilityChecked,
        undecryptableSecretIds,
        issue: validationMessage(
          'secret_vault_invalid',
          `Backup secret vault contains an invalid record: ${secretId}.`,
          {
            secretId
          }
        )
      }
    }
    secretIds.add(secretId)
    if (decryptabilityChecked) {
      try {
        safeStorage.decryptString(Buffer.from((record as Record<string, string>).encrypted, 'base64'))
      } catch {
        undecryptableSecretIds.add(secretId)
      }
    }
    secretCount++
  }

  return {
    exists: true,
    secretCount,
    secretIds,
    decryptabilityChecked,
    undecryptableSecretIds
  }
}

function normalizeBackupPath(inputPath: string) {
  const resolved = path.resolve(inputPath)
  if (path.basename(resolved) === 'metadata.json') {
    return path.dirname(resolved)
  }
  return resolved
}

function getBackupManifest(metadata: Record<string, any> | null, manifestPath: string | null) {
  if (manifestPath && fs.existsSync(manifestPath)) {
    return readJsonFile(manifestPath)
  }

  const sourceManifest = metadata?.sourceManifest
  return sourceManifest && typeof sourceManifest === 'object' ? sourceManifest : null
}

function getBackupTimeValue(createdAt: string | null) {
  if (!createdAt) return 0

  const time = Date.parse(createdAt)
  return Number.isFinite(time) ? time : 0
}

function readBackupOverviewEntry(backupPath: string) {
  const stat = fs.statSync(backupPath)
  const metadata = readJsonFile(path.join(backupPath, 'metadata.json'))
  const createdAt = typeof metadata?.createdAt === 'string' ? metadata.createdAt : stat.mtime.toISOString()
  const reason = typeof metadata?.reason === 'string' ? metadata.reason : null

  return {
    path: backupPath,
    createdAt,
    reason
  }
}

function copyDirectoryIfExists(source: string, target: string) {
  if (!fs.existsSync(source)) return false
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: false,
    force: true
  })
  return true
}

async function snapshotMemoryDirectoryIfExists(source: string, target: string) {
  if (!fs.existsSync(source)) return false

  fs.mkdirSync(target, { recursive: true })

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'memories.db' || entry.name === 'memories.db-wal' || entry.name === 'memories.db-shm') {
      continue
    }

    const sourceEntry = path.join(source, entry.name)
    const targetEntry = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryIfExists(sourceEntry, targetEntry)
    } else if (entry.isFile()) {
      fs.copyFileSync(sourceEntry, targetEntry)
    }
  }

  const memoryDbPath = path.join(source, 'memories.db')
  if (!fs.existsSync(memoryDbPath)) {
    return true
  }

  const client = createClient({
    url: `file:${memoryDbPath}`,
    intMode: 'number'
  })

  try {
    await client.execute(`VACUUM INTO ${quoteSqlString(path.join(target, 'memories.db'))}`)
  } finally {
    client.close()
  }

  return true
}

async function copyRestorableDirectoryIfExists(
  dirname: (typeof RESTORABLE_DIRECTORIES)[number],
  source: string,
  target: string
) {
  if (dirname === 'Memory') {
    return snapshotMemoryDirectoryIfExists(source, target)
  }

  return copyDirectoryIfExists(source, target)
}

function archivePathIfExists(source: string, archiveRoot: string) {
  if (!fs.existsSync(source)) return false

  const target = path.join(archiveRoot, path.basename(source))
  movePathSync(source, target)
  return true
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

export class StorageV2BackupService {
  async getBackupOverview(): Promise<StorageV2BackupOverview> {
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const backupRoot = path.join(rootInfo.dataRoot, 'backups')

    if (!fs.existsSync(backupRoot)) {
      return {
        backupRoot,
        backupCount: 0,
        latestBackupPath: null,
        latestBackupCreatedAt: null,
        latestBackupReason: null
      }
    }

    const backups = fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readBackupOverviewEntry(path.join(backupRoot, entry.name)))
      .sort((left, right) => {
        const timeDiff = getBackupTimeValue(right.createdAt) - getBackupTimeValue(left.createdAt)
        return timeDiff !== 0 ? timeDiff : right.path.localeCompare(left.path)
      })
    const latestBackup = backups[0]

    return {
      backupRoot,
      backupCount: backups.length,
      latestBackupPath: latestBackup?.path ?? null,
      latestBackupCreatedAt: latestBackup?.createdAt ?? null,
      latestBackupReason: latestBackup?.reason ?? null
    }
  }

  async createBackup(reason = 'manual'): Promise<StorageV2Backup> {
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    await storageV2Database.healthCheck()
    await storageV2Database.waitForIdle()
    await storageV2SecretVaultService.waitForIdle()
    const secretVaultPrune = await storageV2Database.pruneUnreferencedSecretVaultEntries().catch((error) => ({
      error: errorMessage(error)
    }))

    const createdAt = new Date().toISOString()
    const backupDir = path.join(rootInfo.dataRoot, 'backups', `${timestampForFilename()}-${safeName(reason)}`)
    fs.mkdirSync(backupDir, { recursive: true })

    const snapshot = await storageV2Database.createSnapshot(`backup-${reason}`)
    const dbPath = path.join(backupDir, 'main.db')
    fs.copyFileSync(snapshot.path, dbPath)

    const sourceManifestPath = path.join(rootInfo.dataRoot, 'manifest.json')
    if (fs.existsSync(sourceManifestPath)) {
      fs.copyFileSync(sourceManifestPath, path.join(backupDir, 'manifest.json'))
    }

    await KnowledgeService.closeAll().catch(() => undefined)
    await storageV2SecretVaultService.waitForIdle()

    const copiedDirectories: string[] = []
    for (const dirname of RESTORABLE_DIRECTORIES) {
      const source = path.join(rootInfo.dataRoot, dirname)
      if (!fs.existsSync(source)) continue

      await copyRestorableDirectoryIfExists(dirname, source, path.join(backupDir, dirname))
      copiedDirectories.push(dirname)
    }

    const stats = await storageV2StatisticsService.getStats()
    const integrity = await storageV2Database.integrityReport()
    const manifestPath = path.join(backupDir, 'metadata.json')
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          format: 'cherry-studio-pi-storage-backup',
          version: 1,
          reason,
          createdAt,
          app: {
            name: app.name || 'Cherry Studio Pi',
            version: app.getVersion()
          },
          dataRoot: rootInfo.dataRoot,
          sourceManifest: rootInfo.manifest,
          db: {
            path: 'main.db',
            sourceSnapshotPath: snapshot.path
          },
          copiedDirectories,
          secretVaultPrune,
          stats,
          integrity
        },
        null,
        2
      )
    )

    return {
      path: backupDir,
      dbPath,
      manifestPath,
      reason,
      createdAt,
      copiedDirectories
    }
  }

  async validateBackup(inputPath: string): Promise<StorageV2BackupValidation> {
    const backupPath = normalizeBackupPath(inputPath)
    const metadataPath = path.join(backupPath, 'metadata.json')
    const dbPath = path.join(backupPath, 'main.db')
    const nextManifestPath = path.join(backupPath, 'manifest.json')
    const manifestPath = fs.existsSync(nextManifestPath) ? nextManifestPath : null
    const issues: StorageV2BackupValidationMessage[] = []
    const warnings: StorageV2BackupValidationMessage[] = []

    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
      issues.push(validationMessage('path_not_directory', 'Backup path is not a directory.'))
    }

    const metadata = fs.existsSync(metadataPath) ? readJsonFile(metadataPath) : null
    if (!metadata) {
      issues.push(validationMessage('metadata_invalid', 'Backup metadata.json is missing or invalid.'))
    } else {
      if (metadata.format !== 'cherry-studio-pi-storage-backup') {
        issues.push(validationMessage('format_unsupported', 'Backup format is not supported.'))
      }
      if (metadata.version !== 1) {
        issues.push(validationMessage('version_unsupported', 'Backup version is not supported.'))
      }
    }

    if (!getBackupManifest(metadata, manifestPath)) {
      warnings.push(
        validationMessage(
          'manifest_missing',
          'Backup manifest.json is missing or invalid; a new manifest may be created after restore.'
        )
      )
    }

    let quickCheck: string | null = null
    let integrityCheck: string | null = null
    let missingBlobFileCount = 0
    let corruptBlobFileCount = 0
    let secretVaultSecretCount = 0
    let missingSecretRefCount = 0
    let invalidSecretRefCount = 0
    let orphanSecretVaultEntryCount = 0
    let undecryptableSecretVaultEntryCount = 0
    let secretReferenceScan: Awaited<ReturnType<typeof scanStorageV2SecretReferences>> | null = null

    if (!fs.existsSync(dbPath)) {
      issues.push(validationMessage('db_missing', 'Backup main.db is missing.'))
    } else {
      const client = createClient({
        url: `file:${dbPath}`,
        intMode: 'number'
      })

      try {
        const quickCheckResult = await client.execute('PRAGMA quick_check')
        quickCheck = String(Object.values(quickCheckResult.rows[0] ?? {})[0] ?? 'unknown')
        if (quickCheck.toLowerCase() !== 'ok') {
          issues.push(
            validationMessage('quick_check_failed', `Backup quick_check failed: ${quickCheck}`, { quickCheck })
          )
        }

        const integrityCheckResult = await client.execute('PRAGMA integrity_check')
        integrityCheck = String(Object.values(integrityCheckResult.rows[0] ?? {})[0] ?? 'unknown')
        if (integrityCheck.toLowerCase() !== 'ok') {
          issues.push(
            validationMessage('integrity_check_failed', `Backup integrity_check failed: ${integrityCheck}`, {
              integrityCheck
            })
          )
        }

        const tableResult = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        const tableNames = new Set(tableResult.rows.map((row) => String(row.name)).filter(Boolean))
        const missingTables = REQUIRED_BACKUP_TABLES.filter((table) => !tableNames.has(table))
        if (missingTables.length > 0) {
          warnings.push(
            validationMessage(
              'schema_tables_missing',
              `Backup database is missing ${missingTables.length} current Storage v2 table(s): ${missingTables.join(
                ', '
              )}. Missing tables can be recreated after restore, but their records are not present in this backup.`,
              {
                count: missingTables.length,
                tables: missingTables.join(', ')
              }
            )
          )
        }

        const blobsResult = await client.execute(`
          SELECT storage_path, checksum
          FROM blobs
          WHERE storage_path IS NOT NULL AND storage_path != ''
        `)
        for (const row of blobsResult.rows) {
          const storagePath = String(row.storage_path)
          const blobPath = path.join(backupPath, storagePath)
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
          issues.push(
            validationMessage(
              'missing_blob_files',
              `Backup is missing ${missingBlobFileCount} referenced blob file(s).`,
              { count: missingBlobFileCount }
            )
          )
        }

        if (corruptBlobFileCount > 0) {
          issues.push(
            validationMessage(
              'corrupt_blob_files',
              `Backup has ${corruptBlobFileCount} blob file(s) whose checksum does not match the database.`,
              { count: corruptBlobFileCount }
            )
          )
        }

        secretReferenceScan = await scanStorageV2SecretReferences(client)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        issues.push(validationMessage('db_open_failed', `Backup database cannot be opened: ${message}`, { message }))
      } finally {
        client.close()
      }
    }

    const copiedDirectories = Array.isArray(metadata?.copiedDirectories)
      ? metadata.copiedDirectories.filter((entry: unknown): entry is string => typeof entry === 'string')
      : RESTORABLE_DIRECTORIES.filter((dirname) => fs.existsSync(path.join(backupPath, dirname)))
    const copiedDirectorySet = new Set(copiedDirectories)
    const unknownCopiedDirectories = copiedDirectories.filter((dirname) => !RESTORABLE_DIRECTORY_SET.has(dirname))

    if (unknownCopiedDirectories.length > 0) {
      warnings.push(
        validationMessage(
          'unknown_copied_directories',
          `Backup metadata contains unknown copied directory entries: ${unknownCopiedDirectories.join(', ')}.`,
          { count: unknownCopiedDirectories.length, directories: unknownCopiedDirectories.join(', ') }
        )
      )
    }

    const untrackedRestorableDirectories = RESTORABLE_DIRECTORIES.filter(
      (dirname) => !copiedDirectorySet.has(dirname) && fs.existsSync(path.join(backupPath, dirname))
    )
    if (untrackedRestorableDirectories.length > 0) {
      warnings.push(
        validationMessage(
          'restorable_directory_untracked',
          `Backup contains restorable directories not listed in metadata: ${untrackedRestorableDirectories.join(
            ', '
          )}. Restore still considers these directories.`,
          { count: untrackedRestorableDirectories.length, directories: untrackedRestorableDirectories.join(', ') }
        )
      )
    }

    for (const dirname of copiedDirectories) {
      if (dirname === 'secrets' || !RESTORABLE_DIRECTORY_SET.has(dirname)) continue
      if (fs.existsSync(path.join(backupPath, dirname))) continue

      issues.push(
        validationMessage(
          'copied_directory_missing',
          `Backup metadata says ${dirname} was copied, but the directory is missing.`,
          { directory: dirname }
        )
      )
    }

    const vaultValidation = validateSecretVaultFile(path.join(backupPath, 'secrets', 'vault.json'))
    secretVaultSecretCount = vaultValidation.secretCount
    undecryptableSecretVaultEntryCount = vaultValidation.undecryptableSecretIds.size
    if (vaultValidation.issue) {
      issues.push(vaultValidation.issue)
    } else if (!vaultValidation.exists && copiedDirectories.includes('secrets')) {
      warnings.push(
        validationMessage(
          'secret_vault_missing',
          'Backup metadata says secrets were copied, but secrets/vault.json is missing.'
        )
      )
    } else if (vaultValidation.secretCount > 0 && !vaultValidation.decryptabilityChecked) {
      warnings.push(
        validationMessage(
          'secret_vault_decrypt_unavailable',
          'Current system encryption is unavailable, so backup secret values cannot be verified on this device.'
        )
      )
    } else if (undecryptableSecretVaultEntryCount > 0) {
      warnings.push(
        validationMessage(
          'undecryptable_secret_vault_entries',
          `Backup contains ${undecryptableSecretVaultEntryCount} secret value(s) that cannot be decrypted on this device.`,
          { count: undecryptableSecretVaultEntryCount }
        )
      )
    }

    if (secretReferenceScan) {
      invalidSecretRefCount = secretReferenceScan.invalidRefs.size
      missingSecretRefCount = Array.from(secretReferenceScan.refs).filter(
        (secretId) => !vaultValidation.secretIds.has(secretId)
      ).length
      orphanSecretVaultEntryCount = Array.from(vaultValidation.secretIds).filter(
        (secretId) => !secretReferenceScan.refs.has(secretId)
      ).length

      if (secretReferenceScan.skippedSources.length > 0) {
        warnings.push(
          validationMessage(
            'secret_ref_scan_skipped_sources',
            `Skipped ${secretReferenceScan.skippedSources.length} missing backup schema source(s) while scanning secret references.`,
            { count: secretReferenceScan.skippedSources.length }
          )
        )
      }

      if (invalidSecretRefCount > 0) {
        issues.push(
          validationMessage(
            'invalid_secret_refs',
            `Backup contains ${invalidSecretRefCount} invalid secret reference(s).`,
            { count: invalidSecretRefCount }
          )
        )
      }

      if (missingSecretRefCount > 0) {
        issues.push(
          validationMessage(
            'missing_secret_refs',
            `Backup is missing ${missingSecretRefCount} secret value(s) referenced by the database.`,
            { count: missingSecretRefCount }
          )
        )
      }

      if (orphanSecretVaultEntryCount > 0) {
        warnings.push(
          validationMessage(
            'orphan_secret_vault_entries',
            `Backup contains ${orphanSecretVaultEntryCount} secret value(s) that are no longer referenced by the database.`,
            { count: orphanSecretVaultEntryCount }
          )
        )
      }
    }

    return {
      ok: issues.length === 0,
      backupPath,
      metadataPath,
      dbPath,
      manifestPath,
      reason: typeof metadata?.reason === 'string' ? metadata.reason : null,
      createdAt: typeof metadata?.createdAt === 'string' ? metadata.createdAt : null,
      copiedDirectories,
      quickCheck,
      integrityCheck,
      missingBlobFileCount,
      corruptBlobFileCount,
      secretVaultSecretCount,
      missingSecretRefCount,
      invalidSecretRefCount,
      orphanSecretVaultEntryCount,
      undecryptableSecretVaultEntryCount,
      issues,
      warnings,
      metadata
    }
  }

  async restoreBackup(inputPath: string): Promise<StorageV2RestoreBackupResult> {
    const validation = await this.validateBackup(inputPath)
    if (!validation.ok) {
      throw new Error(`Invalid Storage v2 backup: ${validation.issues.map((issue) => issue.message).join('; ')}`)
    }

    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const restoredAt = new Date().toISOString()
    const restoreId = `${timestampForFilename()}-restore`
    const preRestoreBackup = await this.createBackup('pre-restore')
    const archiveRoot = path.join(rootInfo.dataRoot, 'legacy', `pre-restore-${restoreId}`)
    const stagingDir = path.join(rootInfo.dataRoot, 'temp', restoreId)
    const restoredFiles: string[] = []
    const restoredDirectories: string[] = []
    const warnings: string[] = []

    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.mkdirSync(stagingDir, { recursive: true })
    fs.mkdirSync(archiveRoot, { recursive: true })

    try {
      fs.copyFileSync(validation.dbPath, path.join(stagingDir, 'main.db'))

      const manifest = getBackupManifest(validation.metadata, validation.manifestPath)
      if (manifest) {
        fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      }

      for (const dirname of RESTORABLE_DIRECTORIES) {
        copyDirectoryIfExists(path.join(validation.backupPath, dirname), path.join(stagingDir, dirname))
      }

      await Promise.allSettled([KnowledgeService.closeAll(), MemoryService.getInstance().close()])
      await storageV2Database.waitForIdle()
      storageV2Database.close()

      for (const filename of RESTORABLE_DB_FILES) {
        archivePathIfExists(path.join(rootInfo.dataRoot, filename), archiveRoot)
      }
      archivePathIfExists(path.join(rootInfo.dataRoot, 'manifest.json'), archiveRoot)

      fs.copyFileSync(path.join(stagingDir, 'main.db'), path.join(rootInfo.dataRoot, 'main.db'))
      restoredFiles.push('main.db')

      const stagedManifestPath = path.join(stagingDir, 'manifest.json')
      if (fs.existsSync(stagedManifestPath)) {
        fs.copyFileSync(stagedManifestPath, path.join(rootInfo.dataRoot, 'manifest.json'))
        restoredFiles.push('manifest.json')
      }

      for (const dirname of RESTORABLE_DIRECTORIES) {
        archivePathIfExists(path.join(rootInfo.dataRoot, dirname), archiveRoot)
        if (copyDirectoryIfExists(path.join(stagingDir, dirname), path.join(rootInfo.dataRoot, dirname))) {
          restoredDirectories.push(dirname)
        }
      }

      storageV2DataRootService.activateDataRoot(rootInfo.dataRoot)
      await storageV2Database.initialize()
      await storageV2SettingsRepository
        .set(
          'storage_v2.runtime.auto_hydrate',
          {
            enabled: true,
            reason: 'restore',
            updatedAt: restoredAt
          },
          'storage-v2'
        )
        .catch((error) => {
          warnings.push(`Storage v2 auto hydrate flag update failed after restore: ${errorMessage(error)}`)
        })
      await configManager.hydrateFromStorageV2({ overwrite: true, pruneMissing: true }).catch((error) => {
        warnings.push(`Main process config hydration failed after Storage v2 restore: ${errorMessage(error)}`)
      })

      const agentLegacyProjection = await storageV2AgentLegacyProjectionService
        .projectToLegacyRuntime({
          archiveRoot
        })
        .catch((error) => {
          const warning = createProjectionWarning('Agent', error)
          warnings.push(warning)
          return failedAgentProjectionReport(warning)
        })
      const fileLegacyProjection = await storageV2FileLegacyProjectionService
        .projectToLegacyRuntime({
          archiveRoot
        })
        .catch((error) => {
          const warning = createProjectionWarning('File', error)
          warnings.push(warning)
          return failedFileProjectionReport(warning)
        })
      const appDataLegacyProjection = await storageV2AppDataLegacyProjectionService
        .projectToLegacyRuntime({
          archiveRoot
        })
        .catch((error) => {
          const warning = createProjectionWarning('App data', error)
          warnings.push(warning)
          return failedAppDataProjectionReport(warning)
        })

      return {
        backupPath: validation.backupPath,
        dataRoot: rootInfo.dataRoot,
        restoredAt,
        preRestoreBackupPath: preRestoreBackup.path,
        archivedPath: archiveRoot,
        restoredFiles,
        restoredDirectories,
        agentLegacyProjection,
        fileLegacyProjection,
        appDataLegacyProjection,
        validation,
        requiresRestart: true,
        warnings
      }
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true })
    }
  }
}

export const storageV2BackupService = new StorageV2BackupService()
