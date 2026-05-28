import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  },
  secretVault: {
    getSecret: vi.fn(),
    setSecret: vi.fn()
  },
  settingsRepository: {
    get: vi.fn(),
    set: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('../../../storageV2/SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.secretVault
}))

vi.mock('../../../storageV2/StorageV2Repositories', () => ({
  storageV2SettingsRepository: mocks.settingsRepository
}))

import { JsonFileStorage } from '../storage'

const serverUrlHash = 'server-hash'
const secretRef = 'storage-v2://secret/mcp-oauth/server-hash/storage'
const tokenFileName = `${serverUrlHash}_oauth.json`

describe('JsonFileStorage Storage v2 OAuth persistence', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join('/tmp', 'mcp-oauth-storage-'))
    vi.clearAllMocks()
    mocks.settingsRepository.get.mockResolvedValue(null)
    mocks.settingsRepository.set.mockResolvedValue({ key: `mcp.oauth.${serverUrlHash}` })
    mocks.secretVault.getSecret.mockResolvedValue(null)
    mocks.secretVault.setSecret.mockResolvedValue(secretRef)
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { force: true, recursive: true })
    }
  })

  it('writes OAuth state to Storage v2 secret vault and the legacy JSON file', async () => {
    const storage = new JsonFileStorage(serverUrlHash, tempDir)
    const tokens: OAuthTokens = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer'
    }

    await storage.saveTokens(tokens)

    const legacyFile = JSON.parse(await fs.readFile(path.join(tempDir, tokenFileName), 'utf-8'))
    expect(legacyFile.tokens).toEqual(tokens)

    expect(mocks.secretVault.setSecret).toHaveBeenLastCalledWith(
      'mcp-oauth',
      serverUrlHash,
      'storage',
      expect.any(String)
    )
    const storageJson = mocks.secretVault.setSecret.mock.calls.at(-1)?.[3]
    expect(JSON.parse(storageJson)).toMatchObject({ tokens })
    expect(mocks.settingsRepository.set).toHaveBeenLastCalledWith(
      `mcp.oauth.${serverUrlHash}`,
      expect.objectContaining({
        storageSecretRef: secretRef,
        updatedAt: expect.any(String)
      }),
      'mcp-oauth'
    )
  })

  it('reads OAuth state from Storage v2 before the legacy JSON file', async () => {
    await fs.writeFile(
      path.join(tempDir, tokenFileName),
      JSON.stringify({
        codeVerifier: 'legacy-code-verifier',
        lastUpdated: 1,
        tokens: { access_token: 'legacy-token' }
      })
    )
    mocks.settingsRepository.get.mockResolvedValue({ storageSecretRef: secretRef })
    mocks.secretVault.getSecret.mockResolvedValue(
      JSON.stringify({
        codeVerifier: 'storage-v2-code-verifier',
        lastUpdated: 2,
        tokens: { access_token: 'storage-v2-token' }
      })
    )

    const storage = new JsonFileStorage(serverUrlHash, tempDir)

    await expect(storage.getTokens()).resolves.toEqual({ access_token: 'storage-v2-token' })
    await expect(storage.getCodeVerifier()).resolves.toBe('storage-v2-code-verifier')
    expect(mocks.secretVault.setSecret).not.toHaveBeenCalled()
  })

  it('falls back to the legacy JSON file and mirrors it to Storage v2', async () => {
    await fs.writeFile(
      path.join(tempDir, tokenFileName),
      JSON.stringify({
        codeVerifier: 'legacy-code-verifier',
        lastUpdated: 1,
        tokens: { access_token: 'legacy-token' }
      })
    )

    const storage = new JsonFileStorage(serverUrlHash, tempDir)

    await expect(storage.getTokens()).resolves.toEqual({ access_token: 'legacy-token' })
    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith(
      'mcp-oauth',
      serverUrlHash,
      'storage',
      expect.stringContaining('legacy-token')
    )
  })

  it('keeps legacy OAuth fallback readable if Storage v2 write fails after a previous clear', async () => {
    mocks.settingsRepository.get.mockResolvedValue({ clearedAt: '2026-05-28T00:00:00.000Z' })
    mocks.secretVault.setSecret.mockRejectedValue(new Error('safeStorage unavailable'))
    const storage = new JsonFileStorage(serverUrlHash, tempDir)

    await storage.saveTokens({ access_token: 'new-token', token_type: 'Bearer' })

    const legacyFile = JSON.parse(await fs.readFile(path.join(tempDir, tokenFileName), 'utf-8'))
    expect(legacyFile.tokens).toEqual({ access_token: 'new-token', token_type: 'Bearer' })
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      `mcp.oauth.${serverUrlHash}`,
      expect.objectContaining({
        legacyFallbackAt: expect.any(String),
        updatedAt: expect.any(String)
      }),
      'mcp-oauth'
    )
  })

  it('does not resurrect legacy OAuth data after Storage v2 is cleared', async () => {
    await fs.writeFile(
      path.join(tempDir, tokenFileName),
      JSON.stringify({
        codeVerifier: 'stale-code-verifier',
        lastUpdated: 1,
        tokens: { access_token: 'stale-token' }
      })
    )
    mocks.settingsRepository.get.mockResolvedValue({ clearedAt: '2026-05-28T00:00:00.000Z' })

    const storage = new JsonFileStorage(serverUrlHash, tempDir)

    await expect(storage.getTokens()).resolves.toBeUndefined()
    await expect(storage.getCodeVerifier()).rejects.toThrow('No code verifier saved for session')
    expect(mocks.secretVault.getSecret).not.toHaveBeenCalled()
  })

  it('clears Storage v2 state and removes the legacy JSON file', async () => {
    await fs.writeFile(
      path.join(tempDir, tokenFileName),
      JSON.stringify({
        lastUpdated: 1,
        tokens: { access_token: 'legacy-token' }
      })
    )

    await JsonFileStorage.clearByServerUrlHash(serverUrlHash, tempDir)

    await expect(fs.access(path.join(tempDir, tokenFileName))).rejects.toThrow()
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      `mcp.oauth.${serverUrlHash}`,
      expect.objectContaining({
        clearedAt: expect.any(String),
        updatedAt: expect.any(String)
      }),
      'mcp-oauth'
    )
  })
})
