import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Client, Row } from '@libsql/client'
import { loggerService } from '@logger'
import { getFilesDir } from '@main/utils/file'

import { storageV2DataRootService } from './DataRootService'
import { storageV2Database } from './StorageV2Database'

export type StorageV2FileLegacyProjectionReport = {
  filesDir: string
  projectedFileCount: number
  archivedFileCount: number
  skippedFileCount: number
  missingBlobCount: number
  archivedFiles: string[]
  warnings: string[]
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value as T

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key]
  return value == null ? null : String(value)
}

function numberValue(row: Row, key: string, fallback = 0): number {
  const value = row[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function normalizeExt(ext: string | null, originalName: string | null) {
  const resolvedExt = ext || (originalName ? path.extname(originalName) : '')
  if (!resolvedExt) return ''
  return resolvedExt.startsWith('.') ? resolvedExt : `.${resolvedExt}`
}

function createEmptyReport(filesDir: string): StorageV2FileLegacyProjectionReport {
  return {
    filesDir,
    projectedFileCount: 0,
    archivedFileCount: 0,
    skippedFileCount: 0,
    missingBlobCount: 0,
    archivedFiles: [],
    warnings: []
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

async function fileMatchesBlob(
  target: string,
  expectedSize: number,
  expectedChecksum: string | null
): Promise<boolean> {
  if (!fs.existsSync(target)) return false

  const targetStats = fs.statSync(target)
  if (targetStats.size !== expectedSize) return false
  if (!expectedChecksum) return true

  return (await sha256File(target)) === expectedChecksum
}

async function archiveExistingFileIfDifferent(
  target: string,
  archiveRoot: string,
  report: StorageV2FileLegacyProjectionReport,
  expectedSize: number,
  expectedChecksum: string | null
) {
  if (!fs.existsSync(target)) return

  if (await fileMatchesBlob(target, expectedSize, expectedChecksum)) return

  const archivePath = path.join(archiveRoot, 'file-runtime', 'Files', path.basename(target))
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  fs.renameSync(target, archivePath)
  report.archivedFileCount++
  report.archivedFiles.push(archivePath)
}

async function readFileRows(client: Client) {
  const result = await client.execute(`
    SELECT
      f.id,
      f.original_name,
      f.display_name,
      f.metadata_json,
      f.deleted_at,
      b.ext AS blob_ext,
      b.size AS blob_size,
      b.checksum AS blob_checksum,
      b.storage_path
    FROM files f
    INNER JOIN blobs b ON b.id = f.blob_id
    WHERE f.deleted_at IS NULL
    ORDER BY f.created_at ASC, f.id ASC
  `)
  return result.rows
}

export class StorageV2FileLegacyProjectionService {
  private logger = loggerService.withContext('StorageV2FileLegacyProjectionService')

  async projectToLegacyRuntime(options: { archiveRoot?: string } = {}): Promise<StorageV2FileLegacyProjectionReport> {
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    const filesDir = getFilesDir()
    const report = createEmptyReport(filesDir)
    const archiveRoot = options.archiveRoot ?? path.join(rootInfo.dataRoot, 'legacy', 'file-projection')
    const client = await storageV2Database.getClient()
    const rows = await readFileRows(client)

    fs.mkdirSync(filesDir, { recursive: true })

    for (const row of rows) {
      const id = text(row, 'id')
      const storagePath = text(row, 'storage_path')
      if (!id || !storagePath) {
        report.skippedFileCount++
        continue
      }

      const metadata = parseJson<Record<string, unknown>>(text(row, 'metadata_json'), {})
      const originalName = text(row, 'original_name') ?? text(row, 'display_name')
      const ext = normalizeExt(typeof metadata.ext === 'string' ? metadata.ext : text(row, 'blob_ext'), originalName)
      const source = path.join(rootInfo.dataRoot, storagePath)
      const target = path.join(filesDir, `${id}${ext}`)

      if (!fs.existsSync(source)) {
        report.missingBlobCount++
        report.warnings.push(`Storage v2 blob for file ${id} is missing: ${storagePath}`)
        continue
      }

      const blobSize = numberValue(row, 'blob_size', fs.statSync(source).size)
      const blobChecksum = text(row, 'blob_checksum')

      await archiveExistingFileIfDifferent(target, archiveRoot, report, blobSize, blobChecksum)

      if (!(await fileMatchesBlob(target, blobSize, blobChecksum))) {
        fs.copyFileSync(source, target)
      }

      report.projectedFileCount++
    }

    this.logger.info('Projected Storage v2 blobs to legacy file storage', {
      filesDir,
      projectedFileCount: report.projectedFileCount,
      missingBlobCount: report.missingBlobCount
    })

    return report
  }
}

export const storageV2FileLegacyProjectionService = new StorageV2FileLegacyProjectionService()
