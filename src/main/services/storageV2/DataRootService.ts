import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { app } from 'electron'

import { getDataPath } from '../../utils'
import type { StorageV2Candidate, StorageV2DataRootInfo, StorageV2Manifest } from './types'

const logger = loggerService.withContext('StorageV2DataRootService')

const STORAGE_FORMAT = 'cherry-studio-pi-storage'
const STORAGE_VERSION = 2

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch (error) {
    logger.warn('Failed to read JSON file', {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function hasLegacyData(dataRoot: string): boolean {
  return ['agents.db', 'app.db', 'Files', 'KnowledgeBase', 'Memory', 'Skills', 'Agents'].some((entry) =>
    fs.existsSync(path.join(dataRoot, entry))
  )
}

function hasManifest(dataRoot: string): boolean {
  return fs.existsSync(path.join(dataRoot, 'manifest.json'))
}

function makeCandidate(
  dataRoot: string,
  source: StorageV2Candidate['source'],
  candidatesByPath: Map<string, StorageV2Candidate>
) {
  const resolved = path.resolve(dataRoot)
  if (candidatesByPath.has(resolved)) return

  candidatesByPath.set(resolved, {
    path: resolved,
    source,
    exists: fs.existsSync(resolved),
    hasManifest: hasManifest(resolved),
    hasLegacyData: hasLegacyData(resolved)
  })
}

function getConfigPath() {
  return path.join(os.homedir(), HOME_CHERRY_DIR, 'config', 'config.json')
}

function getConfiguredDataRoots(): string[] {
  const config = readJson<{
    dataRoots?: Array<{ path?: string; active?: boolean }>
  }>(getConfigPath())

  if (!Array.isArray(config?.dataRoots)) {
    return []
  }

  const activeRoots = config.dataRoots.filter((entry) => entry.active !== false).map((entry) => entry.path)
  return activeRoots.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function getLegacyDataRoots(): string[] {
  const appDataRoot = app.getPath('appData')
  const names = ['Cherry Studio Pi', 'CherryStudioPi', 'Perry Studio', 'PerryStudio', 'Cherry Studio', 'CherryStudio']

  return names.flatMap((name) => {
    const userDataRoot = path.join(appDataRoot, name)
    return [path.join(userDataRoot, 'Data'), path.join(`${userDataRoot}Dev`, 'Data')]
  })
}

function readManifest(dataRoot: string): StorageV2Manifest | null {
  const manifest = readJson<StorageV2Manifest>(path.join(dataRoot, 'manifest.json'))
  if (manifest?.format !== STORAGE_FORMAT || manifest.version !== STORAGE_VERSION) {
    return null
  }
  return manifest
}

export class StorageV2DataRootService {
  resolveDataRoot(): StorageV2DataRootInfo {
    const candidatesByPath = new Map<string, StorageV2Candidate>()

    const envRoot = process.env.CHERRY_STUDIO_STORAGE_V2_ROOT
    if (envRoot) {
      makeCandidate(envRoot, 'env', candidatesByPath)
    }

    for (const configuredRoot of getConfiguredDataRoots()) {
      makeCandidate(configuredRoot, 'config', candidatesByPath)
    }

    makeCandidate(getDataPath(), 'current-user-data', candidatesByPath)

    for (const legacyRoot of getLegacyDataRoots()) {
      makeCandidate(legacyRoot, 'legacy-user-data', candidatesByPath)
    }

    const candidates = Array.from(candidatesByPath.values())
    const selected =
      candidates.find((candidate) => candidate.hasManifest) ??
      candidates.find((candidate) => candidate.source === 'env') ??
      candidates.find((candidate) => candidate.source === 'config' && candidate.exists) ??
      candidates.find((candidate) => candidate.source === 'current-user-data')!

    return {
      dataRoot: selected.path,
      source: selected.source,
      manifest: readManifest(selected.path),
      candidates
    }
  }

  ensureDataRoot(): StorageV2DataRootInfo {
    const info = this.resolveDataRoot()
    fs.mkdirSync(info.dataRoot, { recursive: true })

    const manifest = info.manifest
      ? this.touchManifest(info.dataRoot, info.manifest)
      : this.createManifest(info.dataRoot)
    return {
      ...info,
      manifest
    }
  }

  private createManifest(dataRoot: string): StorageV2Manifest {
    const now = new Date().toISOString()
    const manifest: StorageV2Manifest = {
      format: STORAGE_FORMAT,
      version: STORAGE_VERSION,
      profileId: 'default',
      workspaceId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      lastOpenedBy: {
        appId: 'com.cherryai.cherrystudio-pi',
        productName: app.name || 'Cherry Studio Pi',
        version: app.getVersion()
      }
    }

    fs.writeFileSync(path.join(dataRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return manifest
  }

  private touchManifest(dataRoot: string, manifest: StorageV2Manifest): StorageV2Manifest {
    const nextManifest: StorageV2Manifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      lastOpenedBy: {
        appId: 'com.cherryai.cherrystudio-pi',
        productName: app.name || 'Cherry Studio Pi',
        version: app.getVersion()
      }
    }

    try {
      fs.writeFileSync(path.join(dataRoot, 'manifest.json'), JSON.stringify(nextManifest, null, 2))
      return nextManifest
    } catch (error) {
      logger.warn('Failed to update Storage v2 manifest', {
        dataRoot,
        error: error instanceof Error ? error.message : String(error)
      })
      return manifest
    }
  }
}

export const storageV2DataRootService = new StorageV2DataRootService()
