import fs from 'node:fs'
import fsAsync from 'node:fs/promises'
import path from 'node:path'

import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { app } from 'electron'

const STORAGE_FORMAT = 'cherry-studio-pi-storage'
const STORAGE_VERSION = 2
const STORAGE_APP_ID = 'cherry-studio-pi'
const COMPATIBLE_STORAGE_APP_IDS = new Set([STORAGE_APP_ID, 'perry-studio', 'cherry-studio'])
const KNOWN_DATA_ROOT_NAMES = [
  'Cherry Studio Pi',
  'CherryStudioPi',
  'Perry Studio',
  'PerryStudio',
  'Cherry Studio',
  'CherryStudio'
]

type DataRootConfigEntry = {
  app?: string
  path?: string
  active?: boolean
}

type CherryConfig = {
  dataRoots?: DataRootConfigEntry[]
}

export function getResourcePath() {
  return path.join(app.getAppPath(), 'resources')
}

export function toAsarUnpackedPath(filePath: string): string {
  if (!app.isPackaged) {
    return filePath
  }

  const appPath = app.getAppPath()
  if (!appPath.endsWith('.asar')) {
    return filePath
  }

  const unpackedAppPath = appPath.replace(/\.asar$/, '.asar.unpacked')
  if (filePath === appPath) {
    return unpackedAppPath
  }

  const appPathPrefix = `${appPath}${path.sep}`
  if (!filePath.startsWith(appPathPrefix)) {
    return filePath
  }

  return path.join(unpackedAppPath, path.relative(appPath, filePath))
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

function getDefaultDataRootPath() {
  return path.join(app.getPath('userData'), 'Data')
}

function hasStorageV2Manifest(dataRoot: string) {
  const manifest = readJson<{ format?: unknown; version?: unknown }>(path.join(dataRoot, 'manifest.json'))
  return manifest?.format === STORAGE_FORMAT && manifest.version === STORAGE_VERSION
}

function hasDataEntry(entryPath: string) {
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

function hasLegacyRuntimeData(dataRoot: string) {
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
    'Agents'
  ].some((entry) => hasDataEntry(path.join(dataRoot, entry)))
}

function getGlobalConfigPath() {
  return path.join(app.getPath('home'), HOME_CHERRY_DIR, 'config', 'config.json')
}

function getConfiguredDataRoots(): string[] {
  const config = readJson<CherryConfig>(getGlobalConfigPath())
  if (!Array.isArray(config?.dataRoots)) return []

  return config.dataRoots
    .filter((entry) => entry.active !== false)
    .filter((entry) => !entry.app || COMPATIBLE_STORAGE_APP_IDS.has(entry.app))
    .map((entry) => entry.path)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function getKnownLegacyDataRoots() {
  const appDataRoot = app.getPath('appData')

  return KNOWN_DATA_ROOT_NAMES.flatMap((name) => {
    const userDataRoot = path.join(appDataRoot, name)
    return [path.join(userDataRoot, 'Data'), path.join(`${userDataRoot}Dev`, 'Data')]
  })
}

function resolveRuntimeDataRoot() {
  const envRoot = process.env.CHERRY_STUDIO_STORAGE_V2_ROOT
  if (envRoot) return path.resolve(envRoot)

  const defaultDataRoot = getDefaultDataRootPath()
  const configuredDataRoots = getConfiguredDataRoots().map((candidate) => path.resolve(candidate))
  const configuredDataRootSet = new Set(configuredDataRoots)
  const resolvedDefaultDataRoot = path.resolve(defaultDataRoot)
  const candidates = [...configuredDataRoots, defaultDataRoot, ...getKnownLegacyDataRoots()].map((candidate) =>
    path.resolve(candidate)
  )
  const uniqueCandidates = Array.from(new Set(candidates))

  return (
    uniqueCandidates.find((candidate) => hasStorageV2Manifest(candidate)) ??
    uniqueCandidates.find((candidate) => configuredDataRootSet.has(candidate) && hasLegacyRuntimeData(candidate)) ??
    uniqueCandidates.find((candidate) => candidate === resolvedDefaultDataRoot && hasLegacyRuntimeData(candidate)) ??
    uniqueCandidates.find((candidate) => candidate !== resolvedDefaultDataRoot && hasLegacyRuntimeData(candidate)) ??
    uniqueCandidates.find((candidate) => configuredDataRootSet.has(candidate) && fs.existsSync(candidate)) ??
    defaultDataRoot
  )
}

function ensureDataPath(dataPath: string, subPath?: string) {
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true })
  }

  if (subPath) {
    const fullPath = path.join(dataPath, subPath)
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true })
    }
    return fullPath
  }

  return dataPath
}

export function getDefaultDataPath(subPath?: string) {
  return ensureDataPath(getDefaultDataRootPath(), subPath)
}

export function getDataPath(subPath?: string) {
  return ensureDataPath(resolveRuntimeDataRoot(), subPath)
}

export function getInstanceName(baseURL: string) {
  try {
    return new URL(baseURL).host.split('.')[0]
  } catch (error) {
    return ''
  }
}

export function debounce(func: (...args: any[]) => void, wait: number, immediate: boolean = false) {
  let timeout: NodeJS.Timeout | null = null
  return function (...args: any[]) {
    if (timeout) clearTimeout(timeout)
    if (immediate) {
      func(...args)
    } else {
      timeout = setTimeout(() => func(...args), wait)
    }
  }
}

// NOTE: It's an unused function. localStorage should not be accessed in main process.
// export function dumpPersistState() {
//   const persistState = JSON.parse(localStorage.getItem('persist:cherry-studio') || '{}')
//   for (const key in persistState) {
//     persistState[key] = JSON.parse(persistState[key])
//   }
//   return JSON.stringify(persistState)
// }

export const runAsyncFunction = async (fn: () => Promise<void>) => {
  await fn()
}

export function makeSureDirExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export async function calculateDirectorySize(directoryPath: string): Promise<number> {
  let totalSize = 0
  const items = await fsAsync.readdir(directoryPath)

  for (const item of items) {
    const itemPath = path.join(directoryPath, item)
    const stats = await fsAsync.stat(itemPath)

    if (stats.isFile()) {
      totalSize += stats.size
    } else if (stats.isDirectory()) {
      totalSize += await calculateDirectorySize(itemPath)
    }
  }
  return totalSize
}

export const removeEnvProxy = (env: Record<string, string>) => {
  delete env.HTTPS_PROXY
  delete env.HTTP_PROXY
  delete env.grpc_proxy
  delete env.http_proxy
  delete env.https_proxy
}
