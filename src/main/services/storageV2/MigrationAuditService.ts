import fs from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { storageV2DataRootService } from './DataRootService'
import type { StorageV2AuditItem, StorageV2MigrationAudit } from './types'

type PathStats = {
  sizeBytes: number
  fileCount: number
  directoryCount: number
}

async function collectStats(targetPath: string): Promise<PathStats> {
  const stats = await fs.stat(targetPath)

  if (stats.isFile()) {
    return {
      sizeBytes: stats.size,
      fileCount: 1,
      directoryCount: 0
    }
  }

  if (!stats.isDirectory()) {
    return {
      sizeBytes: 0,
      fileCount: 0,
      directoryCount: 0
    }
  }

  let sizeBytes = 0
  let fileCount = 0
  let directoryCount = 1
  const entries = await fs.readdir(targetPath, { withFileTypes: true })

  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name)
    try {
      const childStats = await collectStats(childPath)
      sizeBytes += childStats.sizeBytes
      fileCount += childStats.fileCount
      directoryCount += childStats.directoryCount
    } catch {
      // Ignore unreadable files for audit; this report is informational only.
    }
  }

  return {
    sizeBytes,
    fileCount,
    directoryCount
  }
}

async function auditPath(id: string, label: string, targetPath: string): Promise<StorageV2AuditItem> {
  try {
    const stats = await collectStats(targetPath)
    return {
      id,
      label,
      path: targetPath,
      exists: true,
      ...stats
    }
  } catch {
    return {
      id,
      label,
      path: targetPath,
      exists: false,
      sizeBytes: 0
    }
  }
}

export class StorageV2MigrationAuditService {
  async runAudit(): Promise<StorageV2MigrationAudit> {
    const userDataPath = app.getPath('userData')
    const dataRootInfo = storageV2DataRootService.resolveDataRoot()
    const dataPath = path.join(userDataPath, 'Data')

    const items = await Promise.all([
      auditPath('indexeddb', 'Chromium IndexedDB', path.join(userDataPath, 'IndexedDB')),
      auditPath('local-storage', 'Chromium Local Storage', path.join(userDataPath, 'Local Storage')),
      auditPath(
        'redux-local-storage-leveldb',
        'Chromium Local Storage LevelDB',
        path.join(userDataPath, 'Local Storage', 'leveldb')
      ),
      auditPath('data', 'Current Data directory', dataPath),
      auditPath('files', 'Uploaded files', path.join(dataPath, 'Files')),
      auditPath('knowledge-base', 'Knowledge bases', path.join(dataPath, 'KnowledgeBase')),
      auditPath('memory', 'Memory database', path.join(dataPath, 'Memory')),
      auditPath('skills', 'Global skills', path.join(dataPath, 'Skills')),
      auditPath('agents-workspaces', 'Agent workspaces', path.join(dataPath, 'Agents')),
      auditPath('agents-db', 'Pi agent database', path.join(dataPath, 'agents.db')),
      auditPath('app-db', 'App scoped data database', path.join(dataPath, 'app.db')),
      auditPath('storage-v2-main-db', 'Storage v2 main database', path.join(dataRootInfo.dataRoot, 'main.db')),
      auditPath('storage-v2-manifest', 'Storage v2 manifest', path.join(dataRootInfo.dataRoot, 'manifest.json'))
    ])

    const warnings: string[] = []
    if (
      dataRootInfo.candidates.some((candidate) => candidate.source === 'legacy-user-data' && candidate.hasLegacyData)
    ) {
      warnings.push(
        'Legacy data roots were detected. A future migration UI should ask the user before switching roots.'
      )
    }
    if (!items.find((item) => item.id === 'indexeddb')?.exists) {
      warnings.push('IndexedDB directory was not found. This may be normal for a fresh profile.')
    }
    if (!items.find((item) => item.id === 'local-storage')?.exists) {
      warnings.push('Local Storage directory was not found. This may be normal for a fresh profile.')
    }

    return {
      generatedAt: new Date().toISOString(),
      userDataPath,
      dataRoot: dataRootInfo.dataRoot,
      items,
      warnings
    }
  }
}

export const storageV2MigrationAuditService = new StorageV2MigrationAuditService()
