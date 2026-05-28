import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fs: {
    existsSync: vi.fn(),
    promises: {
      access: vi.fn(),
      mkdir: vi.fn(),
      readFile: vi.fn(),
      unlink: vi.fn(),
      writeFile: vi.fn()
    }
  },
  app: {
    getPath: vi.fn()
  },
  net: {
    fetch: vi.fn()
  },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn()
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

vi.mock('fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('electron', () => ({
  app: mocks.app,
  net: mocks.net,
  safeStorage: mocks.safeStorage
}))

vi.mock('../../utils/file', () => ({
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
      warn: vi.fn()
    })
  }
}))

async function loadCopilotService() {
  vi.resetModules()
  return (await import('../CopilotService')).default
}

describe('CopilotService Storage v2 token persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.app.getPath.mockImplementation((key: string) => (key === 'userData' ? '/mock/userData' : '/mock/unknown'))
    mocks.fs.existsSync.mockReturnValue(false)
    mocks.fs.promises.access.mockResolvedValue(undefined)
    mocks.fs.promises.mkdir.mockResolvedValue(undefined)
    mocks.fs.promises.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    mocks.fs.promises.unlink.mockResolvedValue(undefined)
    mocks.fs.promises.writeFile.mockResolvedValue(undefined)
    mocks.safeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`))
    mocks.safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString().replace(/^encrypted:/, ''))
    mocks.secretVault.getSecret.mockResolvedValue(null)
    mocks.secretVault.setSecret.mockResolvedValue('storage-v2://secret/copilot/github/accessToken')
    mocks.settingsRepository.get.mockResolvedValue(null)
    mocks.settingsRepository.set.mockResolvedValue({ key: 'copilot.accessToken' })
    mocks.net.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'copilot-session-token' })
    })
  })

  it('saves Copilot access tokens to Storage v2 secret vault and the legacy token file', async () => {
    const service = await loadCopilotService()

    await service.saveCopilotToken({} as Electron.IpcMainInvokeEvent, 'github-access-token')

    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith('copilot', 'github', 'accessToken', 'github-access-token')
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'copilot.accessToken',
      {
        accessTokenSecretRef: 'storage-v2://secret/copilot/github/accessToken',
        updatedAt: expect.any(String)
      },
      'copilot'
    )
    expect(mocks.fs.promises.writeFile).toHaveBeenCalledWith(
      '/mock/config/.copilot_token',
      Buffer.from('encrypted:github-access-token')
    )
  })

  it('keeps legacy token fallback readable if Storage v2 save fails after a previous clear', async () => {
    mocks.secretVault.setSecret.mockRejectedValue(new Error('safeStorage unavailable'))
    const service = await loadCopilotService()

    await service.saveCopilotToken({} as Electron.IpcMainInvokeEvent, 'github-access-token')

    expect(mocks.fs.promises.writeFile).toHaveBeenCalledWith(
      '/mock/config/.copilot_token',
      Buffer.from('encrypted:github-access-token')
    )
    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'copilot.accessToken',
      {
        legacyFallbackAt: expect.any(String),
        updatedAt: expect.any(String)
      },
      'copilot'
    )
  })

  it('reads Copilot access tokens from Storage v2 before the legacy token file', async () => {
    mocks.settingsRepository.get.mockResolvedValue({
      accessTokenSecretRef: 'storage-v2://secret/copilot/github/accessToken'
    })
    mocks.secretVault.getSecret.mockResolvedValue('github-access-token')
    const service = await loadCopilotService()

    const token = await service.getToken({} as Electron.IpcMainInvokeEvent, { 'user-agent': 'test' })

    expect(token).toEqual({ token: 'copilot-session-token' })
    expect(mocks.fs.promises.readFile).not.toHaveBeenCalled()
    expect(mocks.net.fetch).toHaveBeenCalledWith(
      'https://api.github.com/copilot_internal/v2/token',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'token github-access-token'
        })
      })
    )
  })

  it('falls back to the legacy token file and mirrors the token into Storage v2', async () => {
    mocks.fs.promises.readFile.mockImplementation(async (candidate) => {
      if (String(candidate) === '/mock/config/.copilot_token') {
        return Buffer.from('encrypted:legacy-access-token')
      }
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const service = await loadCopilotService()

    await service.getToken({} as Electron.IpcMainInvokeEvent)

    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith('copilot', 'github', 'accessToken', 'legacy-access-token')
    expect(mocks.net.fetch).toHaveBeenCalledWith(
      'https://api.github.com/copilot_internal/v2/token',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'token legacy-access-token'
        })
      })
    )
  })

  it('clears the Storage v2 token marker and removes both legacy token paths on logout', async () => {
    const service = await loadCopilotService()

    await service.logout()

    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      'copilot.accessToken',
      {
        clearedAt: expect.any(String),
        updatedAt: expect.any(String)
      },
      'copilot'
    )
    expect(mocks.fs.promises.unlink).toHaveBeenCalledWith('/mock/userData/.copilot_token')
    expect(mocks.fs.promises.unlink).toHaveBeenCalledWith('/mock/config/.copilot_token')
  })

  it('does not resurrect a legacy token file after the Storage v2 token was cleared', async () => {
    mocks.settingsRepository.get.mockResolvedValue({
      clearedAt: '2026-01-01T00:00:00.000Z'
    })
    mocks.fs.promises.readFile.mockResolvedValue(Buffer.from('encrypted:stale-token'))
    const service = await loadCopilotService()

    await expect(service.getToken({} as Electron.IpcMainInvokeEvent)).rejects.toThrow('无法获取Copilot令牌，请重新授权')

    expect(mocks.fs.promises.readFile).not.toHaveBeenCalled()
    expect(mocks.net.fetch).not.toHaveBeenCalled()
  })
})
