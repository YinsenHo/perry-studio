import fs from 'node:fs/promises'
import path from 'node:path'

import { safeStorage } from 'electron'

import { storageV2DataRootService } from './DataRootService'

type SecretVaultFile = {
  version: 1
  secrets: Record<
    string,
    {
      encrypted: string
      encoding: 'electron-safe-storage'
      updatedAt: string
    }
  >
}

export type StorageV2SecretVaultPruneResult = {
  beforeCount: number
  afterCount: number
  prunedCount: number
  prunedSecretIds: string[]
}

const VAULT_VERSION = 1
const SECRET_REF_PREFIX = 'storage-v2://secret/'

function encodeSecretId(scope: string, ownerId: string, kind: string) {
  return [scope, ownerId, kind].map((part) => encodeURIComponent(part)).join('/')
}

function decodeSecretRef(secretRef: string) {
  if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
    throw new Error('Invalid Storage v2 secret reference')
  }

  const parts = secretRef.slice(SECRET_REF_PREFIX.length).split('/')
  for (const part of parts) {
    decodeURIComponent(part)
  }
  return parts.join(':')
}

export class StorageV2SecretVaultService {
  private writeQueue: Promise<unknown> = Promise.resolve()

  isAvailable() {
    return safeStorage.isEncryptionAvailable()
  }

  async setSecret(scope: string, ownerId: string, kind: string, value: string): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('Electron safeStorage encryption is not available')
    }

    const secretId = encodeSecretId(scope, ownerId, kind)
    const secretRef = `${SECRET_REF_PREFIX}${secretId}`
    await this.enqueueVaultWrite(async () => {
      const vault = await this.readVault()
      const encrypted = safeStorage.encryptString(value).toString('base64')

      vault.secrets[secretId.replace(/\//g, ':')] = {
        encrypted,
        encoding: 'electron-safe-storage',
        updatedAt: new Date().toISOString()
      }

      await this.writeVault(vault)
    })
    return secretRef
  }

  async getSecret(secretRef: string): Promise<string | null> {
    if (!this.isAvailable()) {
      return null
    }

    await this.waitForIdle()

    const secretId = decodeSecretRef(secretRef)
    const vault = await this.readVault().catch(() => null)
    if (!vault) return null

    const record = vault.secrets[secretId]
    if (!record) return null

    try {
      return safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'))
    } catch {
      return null
    }
  }

  async waitForIdle(): Promise<void> {
    await this.writeQueue
  }

  async pruneUnreferencedSecretIds(referencedSecretIds: Iterable<string>): Promise<StorageV2SecretVaultPruneResult> {
    const referenced = new Set(referencedSecretIds)

    return this.enqueueVaultWrite(async () => {
      const vault = await this.readVault()
      const secretIds = Object.keys(vault.secrets)
      const prunedSecretIds = secretIds.filter((secretId) => !referenced.has(secretId))

      if (prunedSecretIds.length === 0) {
        return {
          beforeCount: secretIds.length,
          afterCount: secretIds.length,
          prunedCount: 0,
          prunedSecretIds: []
        }
      }

      for (const secretId of prunedSecretIds) {
        delete vault.secrets[secretId]
      }

      await this.writeVault(vault)

      return {
        beforeCount: secretIds.length,
        afterCount: secretIds.length - prunedSecretIds.length,
        prunedCount: prunedSecretIds.length,
        prunedSecretIds
      }
    })
  }

  private getVaultPath() {
    const rootInfo = storageV2DataRootService.ensureDataRoot()
    return path.join(rootInfo.dataRoot, 'secrets', 'vault.json')
  }

  private async readVault(): Promise<SecretVaultFile> {
    const vaultPath = this.getVaultPath()
    try {
      const raw = await fs.readFile(vaultPath, 'utf-8')
      const parsed = JSON.parse(raw) as SecretVaultFile
      if (parsed.version === VAULT_VERSION && parsed.secrets && typeof parsed.secrets === 'object') {
        return parsed
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return {
          version: VAULT_VERSION,
          secrets: {}
        }
      }

      throw new Error('Storage v2 secret vault is unreadable or invalid')
    }

    throw new Error('Storage v2 secret vault is invalid')
  }

  private async writeVault(vault: SecretVaultFile) {
    const vaultPath = this.getVaultPath()
    const tempPath = `${vaultPath}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(path.dirname(vaultPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(tempPath, JSON.stringify(vault, null, 2), { mode: 0o600 })
    await fs.rename(tempPath, vaultPath)
    await fs.chmod(vaultPath, 0o600).catch(() => undefined)
  }

  private async enqueueVaultWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.catch(() => undefined)
    return result
  }
}

export const storageV2SecretVaultService = new StorageV2SecretVaultService()
