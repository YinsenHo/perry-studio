import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { app } from 'electron'

import { getDefaultDataPath } from '../../utils'
import type { StorageV2Candidate, StorageV2DataRootInfo, StorageV2Manifest } from './types'

const logger = loggerService.withContext('StorageV2DataRootService')

const STORAGE_FORMAT = 'cherry-studio-pi-storage'
const STORAGE_VERSION = 2
const STORAGE_APP_ID = 'cherry-studio-pi'
const STORAGE_PRODUCT_NAME = 'Cherry Studio Pi'
const COMPATIBLE_STORAGE_APP_IDS = new Set([STORAGE_APP_ID, 'perry-studio', 'cherry-studio'])

type DataRootConfigEntry = {
  app?: string
  profileId?: string
  path?: string
  active?: boolean
  createdAt?: string
  updatedAt?: string
}

type CherryConfig = {
  appDataPath?: unknown
  dataRoots?: DataRootConfigEntry[]
  [key: string]: unknown
}

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

function hasDataEntry(entryPath: string): boolean {
  if (!fs.existsSync(entryPath)) return false

  try {
    const stats = fs.statSync(entryPath)
    if (stats.isDirectory()) {
      return fs.readdirSync(entryPath).length > 0
    }
    if (stats.isFile()) {
      return stats.size > 0
    }
    return true
  } catch {
    return true
  }
}

function hasLegacyData(dataRoot: string): boolean {
  return [
    'main.db',
    'agents.db',
    'app.db',
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
    'Workspace'
  ].some((entry) => hasDataEntry(path.join(dataRoot, entry)))
}

function hasManifest(dataRoot: string): boolean {
  const manifest = readJson<StorageV2Manifest>(path.join(dataRoot, 'manifest.json'))
  return manifest?.format === STORAGE_FORMAT && manifest.version === STORAGE_VERSION
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
  return path.join(app.getPath('home'), HOME_CHERRY_DIR, 'config', 'config.json')
}

function getConfiguredDataRoots(): string[] {
  const config = readJson<CherryConfig>(getConfigPath())

  if (!Array.isArray(config?.dataRoots)) {
    return []
  }

  const activeRoots = config.dataRoots
    .filter((entry) => entry.active !== false)
    .filter((entry) => !entry.app || COMPATIBLE_STORAGE_APP_IDS.has(entry.app))
    .map((entry) => entry.path)
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

function writeJsonAtomic(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2))
  fs.renameSync(tempPath, filePath)
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

    makeCandidate(getDefaultDataPath(), 'current-user-data', candidatesByPath)

    for (const legacyRoot of getLegacyDataRoots()) {
      makeCandidate(legacyRoot, 'legacy-user-data', candidatesByPath)
    }

    const candidates = Array.from(candidatesByPath.values())
    const selected =
      candidates.find((candidate) => candidate.source === 'env') ??
      candidates.find((candidate) => candidate.hasManifest) ??
      candidates.find((candidate) => candidate.source === 'config' && candidate.hasLegacyData) ??
      candidates.find((candidate) => candidate.source === 'current-user-data' && candidate.hasLegacyData) ??
      candidates.find((candidate) => candidate.source === 'legacy-user-data' && candidate.hasLegacyData) ??
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
    this.registerActiveDataRoot(info.dataRoot, manifest, info.source)
    return {
      ...info,
      manifest
    }
  }

  activateDataRoot(dataRoot: string): StorageV2Manifest | null {
    const resolvedDataRoot = path.resolve(dataRoot)
    if (!fs.existsSync(resolvedDataRoot)) {
      return null
    }

    const manifest = readManifest(resolvedDataRoot)
    if (!manifest) {
      return null
    }

    const nextManifest = this.touchManifest(resolvedDataRoot, manifest)
    this.registerActiveDataRoot(resolvedDataRoot, nextManifest, 'current-user-data')
    return nextManifest
  }

  activateAppDataRoot(appDataPath: string): StorageV2Manifest {
    const dataRoot = path.resolve(appDataPath, 'Data')
    fs.mkdirSync(dataRoot, { recursive: true })

    const manifest = readManifest(dataRoot)
    const nextManifest = manifest ? this.touchManifest(dataRoot, manifest) : this.createManifest(dataRoot)
    this.registerActiveDataRoot(dataRoot, nextManifest, 'current-user-data')
    return nextManifest
  }

  createFreshDataRootManifest(dataRoot: string): StorageV2Manifest {
    fs.mkdirSync(dataRoot, { recursive: true })
    return this.createManifest(path.resolve(dataRoot))
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
        productName: app.name || STORAGE_PRODUCT_NAME,
        version: app.getVersion()
      }
    }

    writeJsonAtomic(path.join(dataRoot, 'manifest.json'), manifest)
    return manifest
  }

  private touchManifest(dataRoot: string, manifest: StorageV2Manifest): StorageV2Manifest {
    const nextManifest: StorageV2Manifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      lastOpenedBy: {
        appId: 'com.cherryai.cherrystudio-pi',
        productName: app.name || STORAGE_PRODUCT_NAME,
        version: app.getVersion()
      }
    }

    try {
      writeJsonAtomic(path.join(dataRoot, 'manifest.json'), nextManifest)
      return nextManifest
    } catch (error) {
      logger.warn('Failed to update Storage v2 manifest', {
        dataRoot,
        error: error instanceof Error ? error.message : String(error)
      })
      return manifest
    }
  }

  private registerActiveDataRoot(dataRoot: string, manifest: StorageV2Manifest, source: StorageV2Candidate['source']) {
    if (source === 'env') return

    const configPath = getConfigPath()
    const config = readJson<CherryConfig>(configPath) ?? {}
    const dataRoots = Array.isArray(config.dataRoots) ? [...config.dataRoots] : []
    const resolvedPath = path.resolve(dataRoot)
    const now = new Date().toISOString()
    const existingIndex = dataRoots.findIndex((entry) => {
      if (typeof entry.path !== 'string') return false
      return path.resolve(entry.path) === resolvedPath
    })

    const nextEntry: DataRootConfigEntry = {
      ...(existingIndex >= 0 ? dataRoots[existingIndex] : {}),
      app: STORAGE_APP_ID,
      profileId: manifest.profileId,
      path: resolvedPath,
      active: true,
      createdAt: existingIndex >= 0 ? dataRoots[existingIndex].createdAt : manifest.createdAt,
      updatedAt: now
    }

    const nextRoots = dataRoots.map((entry, index) => {
      if (index === existingIndex) {
        return nextEntry
      }

      if (
        (!entry.app || COMPATIBLE_STORAGE_APP_IDS.has(entry.app)) &&
        (entry.profileId ?? 'default') === manifest.profileId
      ) {
        return {
          ...entry,
          active: false,
          updatedAt: now
        }
      }

      return entry
    })

    if (existingIndex < 0) {
      nextRoots.push(nextEntry)
    }

    try {
      writeJsonAtomic(configPath, {
        ...config,
        dataRoots: nextRoots
      })
    } catch (error) {
      logger.warn('Failed to persist Storage v2 data root config', {
        configPath,
        dataRoot: resolvedPath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export const storageV2DataRootService = new StorageV2DataRootService()
