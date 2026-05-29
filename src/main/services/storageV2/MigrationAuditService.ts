import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { app } from 'electron'

import { storageV2DataRootService } from './DataRootService'
import type { StorageV2AuditItem, StorageV2MigrationAudit } from './types'

type PathStats = {
  sizeBytes: number
  fileCount: number
  directoryCount: number
}

type AuditPathOptions = Pick<StorageV2AuditItem, 'actionRequired' | 'category' | 'coverage' | 'notes' | 'risk'>

const KNOWN_DATA_ROOT_ENTRIES = new Set([
  'main.db',
  'main.db-wal',
  'main.db-shm',
  'manifest.json',
  'agents.db',
  'agents.db-wal',
  'agents.db-shm',
  'app.db',
  'app.db-wal',
  'app.db-shm',
  'blobs',
  'secrets',
  'Files',
  'KnowledgeBase',
  'Memory',
  'Skills',
  'Agents',
  'Channels',
  'Workbench',
  'Notes',
  'Workspace',
  'backups',
  'snapshots',
  'legacy',
  'temp'
])

function safeAuditIdSegment(value: string) {
  return (
    value
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'entry'
  )
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

async function auditPath(
  id: string,
  label: string,
  targetPath: string,
  options: AuditPathOptions = {}
): Promise<StorageV2AuditItem> {
  try {
    const stats = await collectStats(targetPath)
    return {
      id,
      label,
      path: targetPath,
      exists: true,
      ...options,
      ...stats
    }
  } catch {
    return {
      id,
      label,
      path: targetPath,
      exists: false,
      ...options,
      sizeBytes: 0
    }
  }
}

async function auditUnclassifiedDataRootEntries(dataRoot: string): Promise<StorageV2AuditItem[]> {
  try {
    const entries = await fs.readdir(dataRoot, { withFileTypes: true })
    const unknownEntries = entries.filter((entry) => !KNOWN_DATA_ROOT_ENTRIES.has(entry.name))

    return Promise.all(
      unknownEntries.map((entry, index) =>
        auditPath(
          `data-root-unclassified-${safeAuditIdSegment(entry.name)}-${index + 1}`,
          `Unclassified Data entry: ${entry.name}`,
          path.join(dataRoot, entry.name),
          {
            actionRequired: true,
            category: 'user-asset',
            coverage: 'legacy-only',
            risk: 'medium',
            notes:
              'Top-level Data entry is not part of the known Storage v2 inventory yet. Classify it before final cutover.'
          }
        )
      )
    )
  } catch {
    return []
  }
}

export class StorageV2MigrationAuditService {
  async runAudit(): Promise<StorageV2MigrationAudit> {
    const userDataPath = app.getPath('userData')
    const homePath = app.getPath('home') || os.homedir()
    const dataRootInfo = storageV2DataRootService.resolveDataRoot()
    const dataPath = dataRootInfo.dataRoot
    const homeCherryPath = path.join(homePath, HOME_CHERRY_DIR)

    const knownItems = await Promise.all([
      auditPath('indexeddb', 'Chromium IndexedDB', path.join(userDataPath, 'IndexedDB'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'medium',
        notes:
          'Legacy renderer database; Storage v2 migration imports the supported tables and keeps the legacy store readable.'
      }),
      auditPath('local-storage', 'Chromium Local Storage', path.join(userDataPath, 'Local Storage'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'medium',
        notes: 'Legacy Redux/localStorage runtime cache; Storage v2 keeps read-through and hydration coverage.'
      }),
      auditPath(
        'redux-local-storage-leveldb',
        'Chromium Local Storage LevelDB',
        path.join(userDataPath, 'Local Storage', 'leveldb'),
        {
          category: 'user-asset',
          coverage: 'covered',
          risk: 'medium',
          notes: 'Legacy Redux persist store under Chromium Local Storage.'
        }
      ),
      auditPath('data', 'Current Data directory', dataPath, {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'low'
      }),
      auditPath('files', 'Uploaded files', path.join(dataPath, 'Files'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high'
      }),
      auditPath('knowledge-base', 'Knowledge bases', path.join(dataPath, 'KnowledgeBase'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high'
      }),
      auditPath('memory', 'Memory database', path.join(dataPath, 'Memory'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'medium'
      }),
      auditPath('skills', 'Global skills', path.join(dataPath, 'Skills'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'medium'
      }),
      auditPath('channels', 'Channel runtime files', path.join(dataPath, 'Channels'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'medium',
        notes:
          'Channel credentials are mirrored through Storage v2 secret-backed settings; runtime files stay restorable.'
      }),
      auditPath('workbench', 'Workbench artifacts', path.join(dataPath, 'Workbench'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'medium',
        notes: 'HTML artifacts are copied by Storage v2 backups and path-rewritten on restore.'
      }),
      auditPath('notes', 'Default notes directory', path.join(dataPath, 'Notes'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high',
        notes:
          'Default notes live under the active Storage v2 data root and are copied by Storage v2 backups; custom external notes paths still need separate authority metadata.'
      }),
      auditPath('workspace', 'Default agent workspace', path.join(dataPath, 'Workspace'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high',
        notes: 'Default filesystem MCP workspace is copied by Storage v2 backups.'
      }),
      auditPath('agents-workspaces', 'Agent workspaces', path.join(dataPath, 'Agents'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high'
      }),
      auditPath('agents-db', 'Pi agent database', path.join(dataPath, 'agents.db'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high'
      }),
      auditPath('app-db', 'App scoped data database', path.join(dataPath, 'app.db'), {
        category: 'user-asset',
        coverage: 'covered',
        risk: 'high'
      }),
      auditPath('legacy-user-data-agents-db', 'Legacy userData agents.db', path.join(userDataPath, 'agents.db'), {
        actionRequired: true,
        category: 'user-asset',
        coverage: 'legacy-only',
        risk: 'high',
        notes: 'Old top-level Pi agent database. It should be migrated or archived before a final Storage v2 cutover.'
      }),
      auditPath('legacy-user-data-memory-db', 'Legacy userData memories.db', path.join(userDataPath, 'memories.db'), {
        actionRequired: true,
        category: 'user-asset',
        coverage: 'legacy-only',
        risk: 'high',
        notes: 'Old top-level memory database. It should be migrated or archived before a final Storage v2 cutover.'
      }),
      auditPath(
        'legacy-user-data-copilot-token',
        'Legacy userData Copilot token',
        path.join(userDataPath, '.copilot_token'),
        {
          category: 'external-projection',
          coverage: 'covered',
          risk: 'medium',
          notes: 'Legacy token fallback; Copilot token values are mirrored into Storage v2 secrets when read or saved.'
        }
      ),
      auditPath('home-config', 'Home config.json', path.join(homeCherryPath, 'config', 'config.json'), {
        category: 'bootstrap',
        coverage: 'covered',
        risk: 'low',
        notes: 'Bootstrap configuration can point the app at a custom Storage v2 data root.'
      }),
      auditPath(
        'anthropic-oauth-legacy',
        'Anthropic OAuth token file',
        path.join(homeCherryPath, 'config', 'oauth', 'anthropic.json'),
        {
          category: 'external-projection',
          coverage: 'covered',
          risk: 'medium',
          notes: 'OAuth token projection under the home config directory; should retain Storage v2 secret coverage.'
        }
      ),
      auditPath('mcp-memory-json', 'MCP memory.json', path.join(homeCherryPath, 'config', 'memory.json'), {
        category: 'external-projection',
        coverage: 'covered',
        risk: 'medium',
        notes: 'MCP memory graph is mirrored into Storage v2 secrets.'
      }),
      auditPath('mcp-oauth-legacy', 'MCP OAuth token directory', path.join(homeCherryPath, 'config', 'mcp', 'oauth'), {
        category: 'external-projection',
        coverage: 'covered',
        risk: 'medium',
        notes: 'MCP OAuth token projection under the home config directory.'
      }),
      auditPath('copilot-token-legacy', 'Config Copilot token', path.join(homeCherryPath, 'config', '.copilot_token'), {
        category: 'external-projection',
        coverage: 'covered',
        risk: 'medium',
        notes: 'Current Copilot token projection; Storage v2 secret is the preferred authority.'
      }),
      auditPath('openclaw-config', 'OpenClaw config', path.join(homePath, '.openclaw', 'openclaw.json'), {
        category: 'external-projection',
        coverage: 'covered',
        risk: 'medium',
        notes: 'OpenClaw config is mirrored into Storage v2 secrets and can be rebuilt.'
      }),
      auditPath(
        'openclaw-legacy-config',
        'Legacy OpenClaw config',
        path.join(homePath, '.openclaw', 'openclaw.cherry.json'),
        {
          actionRequired: true,
          category: 'external-projection',
          coverage: 'legacy-only',
          risk: 'medium',
          notes:
            'Old OpenClaw config path. The runtime migrates it to openclaw.json, but an existing file should be reviewed.'
        }
      ),
      auditPath(
        'ovms-config',
        'OVMS model config',
        path.join(homeCherryPath, 'ovms', 'ovms', 'models', 'config.json'),
        {
          actionRequired: true,
          category: 'external-projection',
          coverage: 'legacy-only',
          risk: 'medium',
          notes: 'OVMS model config is still maintained as an external JSON projection and needs an authority decision.'
        }
      ),
      auditPath('trace-cache', 'Trace cache', path.join(homeCherryPath, 'trace'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Developer trace cache; not part of the user-data restore promise.'
      }),
      auditPath('logs', 'Runtime logs', path.join(userDataPath, 'logs'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Runtime log files; not part of the user-data restore promise.'
      }),
      auditPath('user-data-cache', 'Chromium runtime cache', path.join(userDataPath, 'Cache'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Rebuildable Chromium/runtime cache; not part of the user-data restore promise.'
      }),
      auditPath('version-log', 'Version history log', path.join(userDataPath, 'version.log'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Diagnostic version and migration log; not part of the user-data restore promise.'
      }),
      auditPath('tesseract-cache', 'Tesseract cache', path.join(userDataPath, 'tesseract'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'OCR language cache; it is rebuildable and should remain outside backup guarantees.'
      }),
      auditPath('storage-v2-backups', 'Storage v2 backup history', path.join(dataPath, 'backups'), {
        category: 'bootstrap',
        coverage: 'covered',
        risk: 'medium',
        notes: 'Backup history is tracked but not recursively copied into new backups.'
      }),
      auditPath('storage-v2-snapshots', 'Storage v2 snapshots', path.join(dataPath, 'snapshots'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Database snapshots are generated safety artifacts and are not part of normal restore projection.'
      }),
      auditPath('storage-v2-legacy-archives', 'Storage v2 legacy archives', path.join(dataPath, 'legacy'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Pre-migration and pre-restore archives are safety artifacts; fresh backups should be used for recovery.'
      }),
      auditPath('storage-v2-temp', 'Storage v2 temp directory', path.join(dataPath, 'temp'), {
        category: 'runtime-cache',
        coverage: 'cache',
        risk: 'low',
        notes: 'Temporary restore and migration staging files; safe to rebuild.'
      }),
      auditPath('storage-v2-main-db', 'Storage v2 main database', path.join(dataRootInfo.dataRoot, 'main.db'), {
        category: 'user-asset',
        coverage: 'storage-v2-authoritative',
        risk: 'high'
      }),
      auditPath('storage-v2-manifest', 'Storage v2 manifest', path.join(dataRootInfo.dataRoot, 'manifest.json'), {
        category: 'bootstrap',
        coverage: 'storage-v2-authoritative',
        risk: 'medium'
      })
    ])
    const items = [...knownItems, ...(await auditUnclassifiedDataRootEntries(dataPath))]

    const warnings: string[] = []
    const manifestCandidates = dataRootInfo.candidates.filter((candidate) => candidate.hasManifest)
    const legacyDataCandidates = dataRootInfo.candidates.filter(
      (candidate) =>
        candidate.source === 'legacy-user-data' &&
        candidate.hasLegacyData &&
        path.resolve(candidate.path) !== path.resolve(dataRootInfo.dataRoot)
    )
    const missingConfiguredCandidates = dataRootInfo.candidates.filter(
      (candidate) => candidate.source === 'config' && !candidate.exists
    )

    if (manifestCandidates.length > 1) {
      warnings.push(
        `Multiple Storage v2 data roots were detected. The active root is ${dataRootInfo.dataRoot}; review the candidate list before migrating or restoring data.`
      )
    }
    if (legacyDataCandidates.length > 0) {
      warnings.push(
        `Legacy data roots were detected outside the active root (${legacyDataCandidates
          .map((candidate) => candidate.path)
          .join(', ')}). Review them before switching roots or creating a fresh profile.`
      )
    }
    if (missingConfiguredCandidates.length > 0) {
      warnings.push(
        `Configured Storage v2 data root(s) are missing on disk: ${missingConfiguredCandidates
          .map((candidate) => candidate.path)
          .join(', ')}.`
      )
    }
    if (!items.find((item) => item.id === 'indexeddb')?.exists) {
      warnings.push('IndexedDB directory was not found. This may be normal for a fresh profile.')
    }
    if (!items.find((item) => item.id === 'local-storage')?.exists) {
      warnings.push('Local Storage directory was not found. This may be normal for a fresh profile.')
    }
    const legacyOnlyItems = items.filter(
      (item) => item.exists && item.coverage === 'legacy-only' && item.actionRequired
    )
    if (legacyOnlyItems.length > 0) {
      warnings.push(
        `Legacy-only data paths were detected: ${legacyOnlyItems
          .map((item) => `${item.label} (${item.path})`)
          .join(', ')}. Classify, migrate, or archive them before finalizing the Storage v2 cutover.`
      )
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
