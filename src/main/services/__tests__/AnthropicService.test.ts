import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fsPromises: {
    chmod: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn()
  },
  net: {
    fetch: vi.fn()
  },
  secretVault: {
    getSecret: vi.fn(),
    setSecret: vi.fn()
  },
  settingsRepository: {
    get: vi.fn(),
    set: vi.fn()
  },
  shell: {
    openExternal: vi.fn()
  }
}))

vi.mock('fs', () => ({
  promises: mocks.fsPromises
}))

vi.mock('electron', () => ({
  net: mocks.net,
  shell: mocks.shell
}))

vi.mock('@main/utils/file', () => ({
  getConfigDir: () => '/mock/config'
}))

vi.mock('../storageV2/SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.secretVault
}))

vi.mock('../storageV2/StorageV2Repositories', () => ({
  storageV2SettingsRepository: mocks.settingsRepository
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

async function loadAnthropicService() {
  vi.resetModules()
  return (await import('../AnthropicService')).default
}

const credentials = {
  access_token: 'access-token',
  expires_at: Date.now() + 3600_000,
  refresh_token: 'refresh-token'
}

describe('AnthropicService Storage v2 OAuth credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fsPromises.chmod.mockResolvedValue(undefined)
    mocks.fsPromises.mkdir.mockResolvedValue(undefined)
    mocks.fsPromises.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    mocks.fsPromises.unlink.mockResolvedValue(undefined)
    mocks.fsPromises.writeFile.mockResolvedValue(undefined)
    mocks.net.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 3600,
        refresh_token: 'new-refresh-token'
      })
    })
    mocks.secretVault.getSecret.mockResolvedValue(null)
    mocks.secretVault.setSecret.mockResolvedValue('storage-v2://secret/anthropic-oauth/default/credentials')
    mocks.settingsRepository.get.mockResolvedValue(null)
    mocks.settingsRepository.set.mockResolvedValue({ key: 'anthropic.oauth.credentials' })
    mocks.shell.openExternal.mockResolvedValue(undefined)
  })

  it('saves OAuth credentials to Storage v2 secret vault and the legacy JSON file', async () => {
    const service = await loadAnthropicService()

    await service.startOAuthFlow()
    await service.completeOAuthWithCode('auth-code')

    expect(mocks.fsPromises.writeFile).toHaveBeenCalledWith(
      '/mock/config/oauth/anthropic.json',
      expect.stringContaining('new-access-token')
    )
    expect(mocks.fsPromises.chmod).toHaveBeenCalledWith('/mock/config/oauth/anthropic.json', 0o600)
    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith(
      'anthropic-oauth',
      'default',
      'credentials',
      expect.stringContaining('new-refresh-token')
    )
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'anthropic.oauth.credentials',
      {
        credentialsSecretRef: 'storage-v2://secret/anthropic-oauth/default/credentials',
        updatedAt: expect.any(String)
      },
      'anthropic-oauth'
    )
  })

  it('reads OAuth credentials from Storage v2 before the legacy JSON file', async () => {
    mocks.settingsRepository.get.mockResolvedValue({
      credentialsSecretRef: 'storage-v2://secret/anthropic-oauth/default/credentials'
    })
    mocks.secretVault.getSecret.mockResolvedValue(JSON.stringify(credentials))
    const service = await loadAnthropicService()

    await expect(service.getValidAccessToken()).resolves.toBe('access-token')

    expect(mocks.fsPromises.readFile).not.toHaveBeenCalled()
  })

  it('falls back to the legacy JSON file and mirrors credentials to Storage v2', async () => {
    mocks.fsPromises.readFile.mockResolvedValue(JSON.stringify(credentials))
    const service = await loadAnthropicService()

    await expect(service.getValidAccessToken()).resolves.toBe('access-token')

    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith(
      'anthropic-oauth',
      'default',
      'credentials',
      expect.stringContaining('refresh-token')
    )
  })

  it('does not resurrect legacy credentials after Storage v2 is cleared', async () => {
    mocks.settingsRepository.get.mockResolvedValue({ clearedAt: '2026-05-28T00:00:00.000Z' })
    mocks.fsPromises.readFile.mockResolvedValue(JSON.stringify(credentials))
    const service = await loadAnthropicService()

    await expect(service.getValidAccessToken()).resolves.toBeNull()

    expect(mocks.fsPromises.readFile).not.toHaveBeenCalled()
  })

  it('clears Storage v2 state and removes the legacy JSON file', async () => {
    const service = await loadAnthropicService()

    await service.clearCredentials()

    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'anthropic.oauth.credentials',
      {
        clearedAt: expect.any(String),
        updatedAt: expect.any(String)
      },
      'anthropic-oauth'
    )
    expect(mocks.fsPromises.unlink).toHaveBeenCalledWith('/mock/config/oauth/anthropic.json')
  })

  it('keeps the legacy JSON file when the Storage v2 clear marker cannot be written', async () => {
    mocks.settingsRepository.set.mockRejectedValueOnce(new Error('storage locked'))
    const service = await loadAnthropicService()

    await expect(service.clearCredentials()).rejects.toThrow('storage locked')

    expect(mocks.fsPromises.unlink).not.toHaveBeenCalled()
  })

  it('keeps legacy credentials fallback readable if Storage v2 save fails after a previous clear', async () => {
    mocks.secretVault.setSecret.mockRejectedValue(new Error('safeStorage unavailable'))
    const service = await loadAnthropicService()

    await service.startOAuthFlow()
    await service.completeOAuthWithCode('auth-code')

    expect(mocks.fsPromises.writeFile).toHaveBeenCalledWith(
      '/mock/config/oauth/anthropic.json',
      expect.stringContaining('new-access-token')
    )
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'anthropic.oauth.credentials',
      {
        legacyFallbackAt: expect.any(String),
        updatedAt: expect.any(String)
      },
      'anthropic-oauth'
    )
  })
})
