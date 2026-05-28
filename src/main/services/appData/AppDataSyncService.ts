import https from 'node:https'
import path from 'node:path'

import { loggerService } from '@logger'
import { storageV2AppDataKvMirrorService } from '@main/services/storageV2/AppDataKvMirrorService'
import { storageV2AppDataRuntimeRecoveryService } from '@main/services/storageV2/AppDataRuntimeRecoveryService'
import type { WebDavConfig } from '@types'
import { createClient, type WebDAVClient } from 'webdav'

import { type AppDataDatabase, type AppDataRecord, getAppDataDatabase } from './AppDataDatabase'

const logger = loggerService.withContext('AppDataSyncService')

type RemoteRecordMeta = {
  scope: string
  key: string
  valueHash: string
  updatedAt: number
  deletedAt?: number | null
  deviceId: string
  version: number
  path: string
}

type RemoteManifest = {
  version: 1
  updatedAt: number
  records: Record<string, RemoteRecordMeta>
}

export type DataSyncSummary = {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  skipped: number
  lastSyncAt: number
}

const EMPTY_SUMMARY: DataSyncSummary = {
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  skipped: 0,
  lastSyncAt: 0
}

function recordId(scope: string, key: string) {
  return `${scope}:${key}`
}

function encodePart(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function recordPath(record: Pick<AppDataRecord, 'scope' | 'key'>) {
  return `records/${encodePart(record.scope)}/${encodePart(record.key)}.json`
}

function normalizeBasePath(webdavPath?: string) {
  const basePath = webdavPath?.trim() || '/cherry-studio-pi'
  return path.posix.join(basePath.startsWith('/') ? basePath : `/${basePath}`, 'sync', 'v1')
}

function makeManifest(): RemoteManifest {
  return { version: 1, updatedAt: Date.now(), records: {} }
}

function bufferToString(value: string | Buffer | ArrayBuffer | unknown) {
  if (typeof value === 'string') {
    return value
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8')
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('utf8')
  }

  return String(value)
}

export class AppDataSyncService {
  private static instance: AppDataSyncService | null = null

  static getInstance() {
    if (!AppDataSyncService.instance) {
      AppDataSyncService.instance = new AppDataSyncService()
    }

    return AppDataSyncService.instance
  }

  private createWebDavClient(config: WebDavConfig) {
    const client = createClient(config.webdavHost, {
      username: config.webdavUser,
      password: config.webdavPass,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    })

    return {
      client,
      basePath: normalizeBasePath(config.webdavPath)
    }
  }

  private async ensureDirectory(client: WebDAVClient, dirPath: string) {
    if (await client.exists(dirPath)) {
      return
    }

    await client.createDirectory(dirPath, { recursive: true })
  }

  private async readJson<T>(client: WebDAVClient, filePath: string): Promise<T | null> {
    try {
      if (!(await client.exists(filePath))) {
        return null
      }

      const contents = await client.getFileContents(filePath, { format: 'binary' })
      return JSON.parse(bufferToString(contents)) as T
    } catch (error) {
      logger.warn(`Failed to read remote json ${filePath}`, error as Error)
      return null
    }
  }

  private async writeJson(client: WebDAVClient, filePath: string, data: unknown) {
    await this.ensureDirectory(client, path.posix.dirname(filePath))
    await client.putFileContents(filePath, JSON.stringify(data, null, 2), { overwrite: true })
  }

  private async pullRemoteRecord(client: WebDAVClient, basePath: string, meta: RemoteRecordMeta) {
    return this.readJson<AppDataRecord>(client, path.posix.join(basePath, meta.path))
  }

  private async pushRecord(client: WebDAVClient, basePath: string, record: AppDataRecord, manifest: RemoteManifest) {
    const relativePath = recordPath(record)
    await this.writeJson(client, path.posix.join(basePath, relativePath), record)

    manifest.records[recordId(record.scope, record.key)] = {
      scope: record.scope,
      key: record.key,
      valueHash: record.valueHash,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt ?? null,
      deviceId: record.deviceId,
      version: record.version,
      path: relativePath
    }
  }

  private async applyRemoteRecord(db: AppDataDatabase, record: AppDataRecord) {
    await storageV2AppDataKvMirrorService.upsertRecordSnapshot(record)
    await db.applyRemoteRecord(record)
  }

  private async setSyncState(db: AppDataDatabase, id: string, value: unknown) {
    await storageV2AppDataKvMirrorService.upsertSyncState(id, value)
    await db.setSyncState(id, value)
  }

  private async getSyncState<T = unknown>(db: AppDataDatabase, id: string): Promise<T | null> {
    const legacyValue = await db.getSyncState<T>(id)
    return legacyValue ?? storageV2AppDataKvMirrorService.getSyncState<T>(id)
  }

  private async createConflict(
    db: AppDataDatabase,
    input: {
      scope: string
      key: string
      localRecord?: AppDataRecord
      remoteRecord: AppDataRecord
      baseHash?: string | null
    }
  ) {
    const id = `${input.scope}:${input.key}:${Date.now()}`
    await storageV2AppDataKvMirrorService.upsertSyncConflict(id, input)
    await db.createConflict({ ...input, id })
    return id
  }

  async syncNow(config: WebDavConfig): Promise<DataSyncSummary> {
    if (!config.webdavHost) {
      throw new Error('WebDAV host is required')
    }

    let db = await getAppDataDatabase()
    const { client, basePath } = this.createWebDavClient(config)
    const manifestPath = path.posix.join(basePath, 'manifest.json')
    const summary: DataSyncSummary = { ...EMPTY_SUMMARY, lastSyncAt: Date.now() }

    await this.ensureDirectory(client, basePath)

    let localRecords = await db.listRecords(undefined, true)
    if (
      localRecords.length === 0 &&
      (await storageV2AppDataRuntimeRecoveryService.projectIfLegacyAppRecordListEmpty(undefined, 'app-data-sync-empty'))
    ) {
      db = await getAppDataDatabase()
      localRecords = await db.listRecords(undefined, true)
    }
    if (localRecords.length === 0) {
      localRecords = await storageV2AppDataKvMirrorService.listRecords(undefined, true)
    }
    const localById = new Map(localRecords.map((record) => [recordId(record.scope, record.key), record]))
    const manifest = (await this.readJson<RemoteManifest>(client, manifestPath)) || makeManifest()
    const allIds = new Set([...localById.keys(), ...Object.keys(manifest.records)])

    for (const id of allIds) {
      const localRecord = localById.get(id)
      const remoteMeta = manifest.records[id]
      const lastHash = await this.getSyncState<string>(db, `record:${id}:hash`)

      if (localRecord && !remoteMeta) {
        await this.pushRecord(client, basePath, localRecord, manifest)
        await this.setSyncState(db, `record:${id}:hash`, localRecord.valueHash)
        summary.uploaded += localRecord.deletedAt ? 0 : 1
        summary.deleted += localRecord.deletedAt ? 1 : 0
        continue
      }

      if (!localRecord && remoteMeta) {
        const remoteRecord = await this.pullRemoteRecord(client, basePath, remoteMeta)
        if (remoteRecord) {
          await this.applyRemoteRecord(db, remoteRecord)
          await this.setSyncState(db, `record:${id}:hash`, remoteRecord.valueHash)
          summary.downloaded += remoteRecord.deletedAt ? 0 : 1
          summary.deleted += remoteRecord.deletedAt ? 1 : 0
        }
        continue
      }

      if (!localRecord || !remoteMeta) {
        summary.skipped += 1
        continue
      }

      if (localRecord.valueHash === remoteMeta.valueHash) {
        await this.setSyncState(db, `record:${id}:hash`, localRecord.valueHash)
        summary.skipped += 1
        continue
      }

      const localChanged = localRecord.valueHash !== lastHash
      const remoteChanged = remoteMeta.valueHash !== lastHash

      if (localChanged && !remoteChanged) {
        await this.pushRecord(client, basePath, localRecord, manifest)
        await this.setSyncState(db, `record:${id}:hash`, localRecord.valueHash)
        summary.uploaded += localRecord.deletedAt ? 0 : 1
        summary.deleted += localRecord.deletedAt ? 1 : 0
        continue
      }

      const remoteRecord = await this.pullRemoteRecord(client, basePath, remoteMeta)
      if (!remoteRecord) {
        summary.skipped += 1
        continue
      }

      if (!localChanged && remoteChanged) {
        await this.applyRemoteRecord(db, remoteRecord)
        await this.setSyncState(db, `record:${id}:hash`, remoteRecord.valueHash)
        summary.downloaded += remoteRecord.deletedAt ? 0 : 1
        summary.deleted += remoteRecord.deletedAt ? 1 : 0
        continue
      }

      await this.createConflict(db, {
        scope: localRecord.scope,
        key: localRecord.key,
        localRecord,
        remoteRecord,
        baseHash: lastHash
      })

      const winner = localRecord.updatedAt >= remoteRecord.updatedAt ? localRecord : remoteRecord
      if (winner === localRecord) {
        await this.pushRecord(client, basePath, localRecord, manifest)
        summary.uploaded += localRecord.deletedAt ? 0 : 1
      } else {
        await this.applyRemoteRecord(db, remoteRecord)
        summary.downloaded += remoteRecord.deletedAt ? 0 : 1
      }
      await this.setSyncState(db, `record:${id}:hash`, winner.valueHash)
      summary.conflicts += 1
    }

    manifest.updatedAt = summary.lastSyncAt
    await this.writeJson(client, manifestPath, manifest)
    await this.setSyncState(db, 'last-sync-summary', summary)

    return summary
  }

  async getStatus() {
    const db = await getAppDataDatabase()
    const storageDeviceId = await storageV2AppDataKvMirrorService.getSyncState<string>('device-id')
    const lastSummary =
      (await db.getSyncState<DataSyncSummary>('last-sync-summary')) ??
      (await storageV2AppDataKvMirrorService.getSyncState<DataSyncSummary>('last-sync-summary')) ??
      EMPTY_SUMMARY
    const conflicts = await db.listConflicts(true)

    return {
      deviceId: storageDeviceId ?? db.getDeviceId(),
      lastSummary,
      conflicts: conflicts.length > 0 ? conflicts : await storageV2AppDataKvMirrorService.listSyncConflicts(true)
    }
  }
}

export const appDataSyncService = AppDataSyncService.getInstance()
