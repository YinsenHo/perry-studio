import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn()
  },
  fsPromises: {
    chmod: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(),
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
  }
}))

vi.mock('node:fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('node:fs/promises', () => mocks.fsPromises)

vi.mock('electron', () => ({
  net: mocks.net
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

vi.mock('../../../../../storageV2/SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.secretVault
}))

vi.mock('../../../../../storageV2/StorageV2Repositories', () => ({
  storageV2SettingsRepository: mocks.settingsRepository
}))

import { WeixinBot } from '../wechat/WeChatProtocol'

const tokenPath = '/mock/channels/weixin_bot_ch-1.json'
const credentials = {
  accountId: 'account-id',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: 'bot-token',
  userId: 'user-id'
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body)
  }
}

describe('WeixinBot Storage v2 credentials persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fs.existsSync.mockReturnValue(false)
    mocks.fsPromises.chmod.mockResolvedValue(undefined)
    mocks.fsPromises.mkdir.mockResolvedValue(undefined)
    mocks.fsPromises.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    mocks.fsPromises.rm.mockResolvedValue(undefined)
    mocks.fsPromises.writeFile.mockResolvedValue(undefined)
    mocks.net.fetch.mockResolvedValue(jsonResponse({}))
    mocks.secretVault.getSecret.mockResolvedValue(null)
    mocks.secretVault.setSecret.mockResolvedValue('storage-v2://secret/wechat/hash/credentials')
    mocks.settingsRepository.get.mockResolvedValue(null)
    mocks.settingsRepository.set.mockResolvedValue({ key: 'wechat.credentials.hash' })
  })

  it('reads credentials from Storage v2 before the legacy token file', async () => {
    mocks.settingsRepository.get.mockResolvedValue({
      credentialsSecretRef: 'storage-v2://secret/wechat/hash/credentials'
    })
    mocks.secretVault.getSecret.mockResolvedValue(JSON.stringify(credentials))
    const bot = new WeixinBot({ tokenPath })

    await expect(bot.hasCredentials()).resolves.toBe(true)

    expect(mocks.fsPromises.readFile).not.toHaveBeenCalled()
  })

  it('falls back to the legacy token file and mirrors credentials to Storage v2', async () => {
    mocks.fsPromises.readFile.mockResolvedValue(JSON.stringify(credentials))
    const bot = new WeixinBot({ tokenPath })

    await expect(bot.hasCredentials()).resolves.toBe(true)

    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith(
      'wechat',
      expect.any(String),
      'credentials',
      expect.stringContaining('bot-token')
    )
  })

  it('does not resurrect a legacy token file after Storage v2 is cleared', async () => {
    mocks.settingsRepository.get.mockResolvedValue({ clearedAt: '2026-05-28T00:00:00.000Z' })
    mocks.fsPromises.readFile.mockResolvedValue(JSON.stringify(credentials))
    const bot = new WeixinBot({ tokenPath })

    await expect(bot.hasCredentials()).resolves.toBe(false)

    expect(mocks.fsPromises.readFile).not.toHaveBeenCalled()
  })

  it('saves QR login credentials to Storage v2 and the legacy token file', async () => {
    mocks.net.fetch
      .mockResolvedValueOnce(jsonResponse({ qrcode: 'qr-code', qrcode_img_content: 'data:image/png;base64,qr' }))
      .mockResolvedValueOnce(
        jsonResponse({
          baseurl: 'https://ilinkai.weixin.qq.com',
          bot_token: 'bot-token',
          ilink_bot_id: 'account-id',
          ilink_user_id: 'user-id',
          status: 'confirmed'
        })
      )
    const bot = new WeixinBot({ tokenPath })

    await expect(bot.login({ force: true })).resolves.toEqual(credentials)

    expect(mocks.fsPromises.writeFile).toHaveBeenCalledWith(tokenPath, expect.stringContaining('bot-token'), {
      mode: 0o600
    })
    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith(
      'wechat',
      expect.any(String),
      'credentials',
      expect.stringContaining('bot-token')
    )
  })

  it('keeps legacy credential fallback readable if Storage v2 save fails after a previous clear', async () => {
    mocks.secretVault.setSecret.mockRejectedValue(new Error('safeStorage unavailable'))
    mocks.net.fetch
      .mockResolvedValueOnce(jsonResponse({ qrcode: 'qr-code', qrcode_img_content: 'data:image/png;base64,qr' }))
      .mockResolvedValueOnce(
        jsonResponse({
          baseurl: 'https://ilinkai.weixin.qq.com',
          bot_token: 'bot-token',
          ilink_bot_id: 'account-id',
          ilink_user_id: 'user-id',
          status: 'confirmed'
        })
      )
    const bot = new WeixinBot({ tokenPath })

    await expect(bot.login({ force: true })).resolves.toEqual(credentials)

    expect(mocks.settingsRepository.set).toHaveBeenCalledWith(
      expect.stringMatching(/^wechat\.credentials\./),
      {
        legacyFallbackAt: expect.any(String),
        updatedAt: expect.any(String)
      },
      'wechat'
    )
  })
})
