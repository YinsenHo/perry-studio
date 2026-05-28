import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { ipcMain } from 'electron'

import { configManager } from './ConfigManager'
import { storageV2AgentDbMirrorService } from './storageV2/AgentDbMirrorService'

const logger = loggerService.withContext('AppRuntimeSaveService')
const DEFAULT_RENDERER_SAVE_TIMEOUT_MS = 8000

type RendererSaveAck = {
  requestId: string
  ok: boolean
  error?: string
}

function createSaveDataRequestId() {
  return `save-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function flushMainStorageV2RuntimeMirrors() {
  await configManager.flushPendingStorageV2ConfigStrict()
  await configManager.mirrorAllToStorageV2()
  await storageV2AgentDbMirrorService.flushStrict()
}

export async function requestRendererSaveData(
  window: BrowserWindow | null | undefined,
  timeoutMs = DEFAULT_RENDERER_SAVE_TIMEOUT_MS
) {
  if (!window || window.isDestroyed()) return false

  const targetWindow = window
  const requestId = createSaveDataRequestId()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for renderer save data ack after ${timeoutMs}ms`))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      ipcMain.off(IpcChannel.App_SaveDataAck, onAck)
    }

    function finish(error?: Error) {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    function onAck(event: IpcMainEvent, ack?: RendererSaveAck) {
      if (event.sender.id !== targetWindow.webContents.id || ack?.requestId !== requestId) return
      if (ack.ok) {
        finish()
      } else {
        finish(new Error(ack.error || 'Renderer save data failed'))
      }
    }

    ipcMain.on(IpcChannel.App_SaveDataAck, onAck)
    timeout.unref?.()

    try {
      targetWindow.webContents.send(IpcChannel.App_SaveData, requestId)
    } catch (error) {
      finish(error as Error)
    }
  })

  return true
}

export async function flushAppRuntimeData({
  window,
  timeoutMs = DEFAULT_RENDERER_SAVE_TIMEOUT_MS
}: {
  window?: BrowserWindow | null
  timeoutMs?: number
} = {}) {
  const errors: Error[] = []

  try {
    await flushMainStorageV2RuntimeMirrors()
  } catch (error) {
    errors.push(error as Error)
  }

  try {
    await requestRendererSaveData(window, timeoutMs)
  } catch (error) {
    errors.push(error as Error)
  }

  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join('; '))
  }

  logger.info('App runtime data flushed')
}
