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

const VAULT_VERSION = 1
const SECRET_REF_PREFIX = 'storage-v2://secret/'

function encodeSecretId(scope: string, ownerId: string, kind: string) {
  return [scope, ownerId, kind].map((part) => encodeURIComponent(part)).join('/')
}

function decodeSecretRef(secretRef: string) {
  if (!secretRef.startsWith(SECRET_REF_PREFIX)) {
    throw new Error('Invalid Storage v2 secret reference')
  }

  return secretRef
    .slice(SECRET_REF_PREFIX.length)
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join(':')
}

export class StorageV2SecretVaultService {
  isAvailable() {
    return safeStorage.isEncryptionAvailable()
  }

  async setSecret(scope: string, ownerId: string, kind: string, value: string): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('Electron safeStorage encryption is not available')
    }

    const secretId = encodeSecretId(scope, ownerId, kind)
    const secretRef = `${SECRET_REF_PREFIX}${secretId}`
    const vault = await this.readVault()
    const encrypted = safeStorage.encryptString(value).toString('base64')

    vault.secrets[secretId.replace(/\//g, ':')] = {
      encrypted,
      encoding: 'electron-safe-storage',
      updatedAt: new Date().toISOString()
    }

    await this.writeVault(vault)
    return secretRef
  }

  async getSecret(secretRef: string): Promise<string | null> {
    if (!this.isAvailable()) {
      return null
    }

    const secretId = decodeSecretRef(secretRef)
    const vault = await this.readVault()
    const record = vault.secrets[secretId]
    if (!record) return null

    return safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'))
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
    } catch {
      // Missing or unreadable vault starts empty. The caller writes it atomically.
    }

    return {
      version: VAULT_VERSION,
      secrets: {}
    }
  }

  private async writeVault(vault: SecretVaultFile) {
    const vaultPath = this.getVaultPath()
    await fs.mkdir(path.dirname(vaultPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(vaultPath, JSON.stringify(vault, null, 2), { mode: 0o600 })
  }
}

export const storageV2SecretVaultService = new StorageV2SecretVaultService()
