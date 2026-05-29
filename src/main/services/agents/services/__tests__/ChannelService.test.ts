import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storageWrite: {
    upsertChannel: vi.fn()
  },
  tombstone: {
    tombstoneChannel: vi.fn()
  },
  uuid: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }))
  }
}))

vi.mock('@main/apiServer/services/mcp', () => ({
  mcpApiService: {
    getServerInfo: vi.fn()
  }
}))

vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn()
}))

vi.mock('@main/utils', () => ({
  getDataPath: vi.fn(() => '/mock/data')
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/app')
  },
  BrowserWindow: vi.fn(),
  dialog: {},
  ipcMain: {},
  nativeTheme: {
    on: vi.fn(),
    themeSource: 'system',
    shouldUseDarkColors: false
  },
  screen: {},
  session: {},
  shell: {}
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: {
    dev: true,
    macOS: false,
    windows: false,
    linux: true
  }
}))

vi.mock('@main/services/storageV2/AgentRuntimeWriteService', () => ({
  storageV2AgentRuntimeWriteService: mocks.storageWrite
}))

vi.mock('@main/services/storageV2/AgentRuntimeTombstoneService', () => ({
  storageV2AgentRuntimeTombstoneService: mocks.tombstone
}))

vi.mock('uuid', () => ({
  v4: mocks.uuid
}))

import { ChannelService } from '../ChannelService'

const makeChannel = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'channel-1',
    type: 'telegram',
    name: 'Telegram',
    agentId: 'agent-1',
    sessionId: null,
    config: { bot_token: 'secret-token' },
    isActive: true,
    activeChatIds: [],
    permissionMode: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...overrides
  }) as any

describe('ChannelService Storage v2 first writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.uuid.mockReturnValue('channel-1')
    mocks.storageWrite.upsertChannel.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneChannel.mockResolvedValue(undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('upserts Storage v2 before inserting a legacy channel row', async () => {
    const inserted = makeChannel()
    const returning = vi.fn().mockResolvedValue([inserted])
    const values = vi.fn(() => ({ returning }))
    const insert = vi.fn(() => ({ values }))
    const database = { insert }
    const service = new ChannelService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)

    await expect(
      service.createChannel({
        type: 'telegram',
        name: 'Telegram',
        agentId: 'agent-1',
        config: { bot_token: 'secret-token' } as any
      })
    ).resolves.toEqual(inserted)

    expect(mocks.storageWrite.upsertChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'channel-1',
        type: 'telegram',
        name: 'Telegram',
        agentId: 'agent-1',
        config: { bot_token: 'secret-token' },
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_000
      })
    )
    expect(mocks.storageWrite.upsertChannel.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]
    )
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: 'channel-1' }))
  })

  it('does not insert a legacy channel row when the Storage v2 first write fails', async () => {
    const insert = vi.fn()
    const database = { insert }
    const service = new ChannelService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    mocks.storageWrite.upsertChannel.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(
      service.createChannel({
        type: 'telegram',
        name: 'Telegram',
        config: { bot_token: 'secret-token' } as any
      })
    ).rejects.toThrow('storage unavailable')

    expect(insert).not.toHaveBeenCalled()
  })

  it('upserts Storage v2 before updating a legacy channel row', async () => {
    const existing = makeChannel()
    const updated = makeChannel({ name: 'New Telegram', updatedAt: 1_800_000_000_000 })
    const returning = vi.fn().mockResolvedValue([updated])
    const where = vi.fn(() => ({ returning }))
    const set = vi.fn(() => ({ where }))
    const update = vi.fn(() => ({ set }))
    const database = { update }
    const service = new ChannelService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service, 'getChannel').mockResolvedValue(existing)

    await expect(service.updateChannel('channel-1', { name: 'New Telegram' })).resolves.toEqual(updated)

    expect(mocks.storageWrite.upsertChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'channel-1',
        name: 'New Telegram',
        config: { bot_token: 'secret-token' }
      })
    )
    expect(mocks.storageWrite.upsertChannel.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]
    )
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Telegram', updatedAt: 1_800_000_000_000 }))
  })

  it('tombstones Storage v2 before deleting a legacy channel row', async () => {
    const returning = vi.fn().mockResolvedValue([makeChannel()])
    const where = vi.fn(() => ({ returning }))
    const deleteFrom = vi.fn(() => ({ where }))
    const database = { delete: deleteFrom }
    const service = new ChannelService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service, 'getChannel').mockResolvedValue(makeChannel())

    await expect(service.deleteChannel('channel-1')).resolves.toBe(true)

    expect(mocks.tombstone.tombstoneChannel).toHaveBeenCalledWith('channel-1')
    expect(mocks.tombstone.tombstoneChannel.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFrom.mock.invocationCallOrder[0]
    )
  })

  it('skips duplicate tombstone when the caller already tombstoned Storage v2', async () => {
    const returning = vi.fn().mockResolvedValue([makeChannel()])
    const where = vi.fn(() => ({ returning }))
    const deleteFrom = vi.fn(() => ({ where }))
    const database = { delete: deleteFrom }
    const service = new ChannelService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service, 'getChannel').mockResolvedValue(makeChannel())

    await expect(service.deleteChannel('channel-1', { storageV2Tombstoned: true })).resolves.toBe(true)

    expect(mocks.tombstone.tombstoneChannel).not.toHaveBeenCalled()
    expect(deleteFrom).toHaveBeenCalledTimes(1)
  })
})
