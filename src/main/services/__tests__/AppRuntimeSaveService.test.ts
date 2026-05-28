import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  configManager: {
    flushPendingStorageV2ConfigStrict: vi.fn(),
    mirrorAllToStorageV2: vi.fn()
  },
  ipcMain: {
    off: vi.fn(),
    on: vi.fn()
  },
  mirror: {
    flushStrict: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain
}))

vi.mock('../ConfigManager', () => ({
  configManager: mocks.configManager
}))

vi.mock('../storageV2/AgentDbMirrorService', () => ({
  storageV2AgentDbMirrorService: mocks.mirror
}))

function createWindow(send?: (channel: IpcChannel, requestId: string) => void) {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 10,
      send: vi.fn((channel: IpcChannel, requestId: string) => {
        send?.(channel, requestId)
      })
    }
  } as any
}

describe('AppRuntimeSaveService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.configManager.flushPendingStorageV2ConfigStrict.mockResolvedValue(undefined)
    mocks.configManager.mirrorAllToStorageV2.mockResolvedValue(undefined)
    mocks.mirror.flushStrict.mockResolvedValue(undefined)
  })

  it('strictly flushes main runtime mirrors in order', async () => {
    const { flushMainStorageV2RuntimeMirrors } = await import('../AppRuntimeSaveService')

    await flushMainStorageV2RuntimeMirrors()

    expect(mocks.configManager.flushPendingStorageV2ConfigStrict).toHaveBeenCalledTimes(1)
    expect(mocks.configManager.mirrorAllToStorageV2).toHaveBeenCalledTimes(1)
    expect(mocks.mirror.flushStrict).toHaveBeenCalledTimes(1)
    expect(mocks.configManager.flushPendingStorageV2ConfigStrict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.configManager.mirrorAllToStorageV2.mock.invocationCallOrder[0]
    )
    expect(mocks.configManager.mirrorAllToStorageV2.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mirror.flushStrict.mock.invocationCallOrder[0]
    )
  })

  it('waits for renderer save data acknowledgement', async () => {
    const { requestRendererSaveData } = await import('../AppRuntimeSaveService')
    let listener: any
    mocks.ipcMain.on.mockImplementation((_channel, cb) => {
      listener = cb
    })
    const window = createWindow((_channel, requestId) => {
      listener({ sender: { id: 10 } }, { requestId, ok: true })
    })

    await expect(requestRendererSaveData(window)).resolves.toBe(true)

    expect(mocks.ipcMain.on).toHaveBeenCalledWith(IpcChannel.App_SaveDataAck, expect.any(Function))
    expect(window.webContents.send).toHaveBeenCalledWith(IpcChannel.App_SaveData, expect.stringMatching(/^save-/))
    expect(mocks.ipcMain.off).toHaveBeenCalledWith(IpcChannel.App_SaveDataAck, expect.any(Function))
  })

  it('continues renderer save when a main flush fails and reports the failure', async () => {
    const { flushAppRuntimeData } = await import('../AppRuntimeSaveService')
    mocks.configManager.flushPendingStorageV2ConfigStrict.mockRejectedValueOnce(new Error('config locked'))
    let listener: any
    mocks.ipcMain.on.mockImplementation((_channel, cb) => {
      listener = cb
    })
    const window = createWindow((_channel, requestId) => {
      listener({ sender: { id: 10 } }, { requestId, ok: true })
    })

    await expect(flushAppRuntimeData({ window })).rejects.toThrow('config locked')

    expect(window.webContents.send).toHaveBeenCalledWith(IpcChannel.App_SaveData, expect.any(String))
  })
})
