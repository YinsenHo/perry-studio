import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createClient } from '@libsql/client'
import { app } from 'electron'

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
}

const RESTORABLE_DIRECTORIES = ['blobs', 'secrets', 'KnowledgeBase', 'Memory', 'Skills', 'Agents'] as const
const RESTORABLE_DB_FILES = ['main.db', 'main.db-wal', 'main.db-shm'] as const

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

function readJsonFile(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>
  } catch {
    return null
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
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(source, target)
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
  async createBackup(reason = 'manual'): Promise<StorageV2Backup> {
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    await storageV2Database.healthCheck()

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

      await storageV2Database.initialize()
      await storageV2SettingsRepository.set(
        'storage_v2.runtime.auto_hydrate',
        {
          enabled: true,
          reason: 'restore',
          updatedAt: restoredAt
        },
        'storage-v2'
      )

      const agentLegacyProjection = await storageV2AgentLegacyProjectionService.projectToLegacyRuntime({
        archiveRoot
      })
      const fileLegacyProjection = await storageV2FileLegacyProjectionService.projectToLegacyRuntime({
        archiveRoot
      })
      const appDataLegacyProjection = await storageV2AppDataLegacyProjectionService.projectToLegacyRuntime({
        archiveRoot
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
        requiresRestart: true
      }
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true })
    }
  }
}

export const storageV2BackupService = new StorageV2BackupService()
