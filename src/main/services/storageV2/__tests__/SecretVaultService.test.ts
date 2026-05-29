import fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dataRootService: {
    ensureDataRoot: vi.fn()
  },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: vi.fn()
  }
}))

vi.mock('electron', () => ({
  safeStorage: mocks.safeStorage
}))

vi.mock('../DataRootService', () => ({
  storageV2DataRootService: mocks.dataRootService
}))

import { storageV2SecretVaultService } from '../SecretVaultService'

describe('StorageV2SecretVaultService', () => {
  let tmpDir: string
  let dataRoot: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await fs.mkdtemp('/tmp/storage-v2-vault-')
    dataRoot = path.join(tmpDir, 'Data')
    mocks.dataRootService.ensureDataRoot.mockReturnValue({
      dataRoot,
      manifest: null,
      source: 'env',
      candidates: []
    })
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true)
    mocks.safeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`sealed:${value}`))
    mocks.safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString().replace(/^sealed:/, ''))
  })

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses encoded vault ids so encoded refs can be read back', async () => {
    const secretRef = await storageV2SecretVaultService.setSecret('provider', 'provider 1/alpha', 'api key', 'token')

    expect(secretRef).toBe('storage-v2://secret/provider/provider%201%2Falpha/api%20key')
    await expect(storageV2SecretVaultService.getSecret(secretRef)).resolves.toBe('token')

    const vault = JSON.parse(await fs.readFile(path.join(dataRoot, 'secrets', 'vault.json'), 'utf-8'))
    expect(Object.keys(vault.secrets)).toEqual(['provider:provider%201%2Falpha:api%20key'])
  })

  it('does not create a vault entry when safeStorage encryption is unavailable', async () => {
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(storageV2SecretVaultService.setSecret('provider', 'provider-1', 'apiKey', 'token')).rejects.toThrow(
      'Electron safeStorage encryption is not available'
    )

    expect(mocks.safeStorage.encryptString).not.toHaveBeenCalled()
    await expect(fs.access(path.join(dataRoot, 'secrets', 'vault.json'))).rejects.toThrow()
  })

  it('returns null without reading the vault when safeStorage encryption is unavailable', async () => {
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(storageV2SecretVaultService.getSecret('storage-v2://secret/provider/provider-1/apiKey')).resolves.toBe(
      null
    )

    expect(mocks.dataRootService.ensureDataRoot).not.toHaveBeenCalled()
    expect(mocks.safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('treats undecryptable secret values as unavailable instead of throwing', async () => {
    const secretRef = await storageV2SecretVaultService.setSecret('provider', 'provider-1', 'apiKey', 'token')
    mocks.safeStorage.decryptString.mockImplementation(() => {
      throw new Error('different keychain')
    })

    await expect(storageV2SecretVaultService.getSecret(secretRef)).resolves.toBeNull()
  })

  it('prunes vault secrets that are no longer referenced by Storage v2 records', async () => {
    await storageV2SecretVaultService.setSecret('provider', 'keep', 'apiKey', 'keep-token')
    const dropRef = await storageV2SecretVaultService.setSecret('provider', 'drop', 'apiKey', 'drop-token')

    const result = await storageV2SecretVaultService.pruneUnreferencedSecretIds(['provider:keep:apiKey'])

    expect(result).toEqual({
      beforeCount: 2,
      afterCount: 1,
      prunedCount: 1,
      prunedSecretIds: ['provider:drop:apiKey']
    })
    await expect(storageV2SecretVaultService.getSecret(dropRef)).resolves.toBeNull()

    const vault = JSON.parse(await fs.readFile(path.join(dataRoot, 'secrets', 'vault.json'), 'utf-8'))
    expect(Object.keys(vault.secrets)).toEqual(['provider:keep:apiKey'])
  })
})
