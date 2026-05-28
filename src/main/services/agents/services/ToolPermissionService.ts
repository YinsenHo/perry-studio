import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import type { AgentPermissionUpdate } from '@shared/agents/types'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { windowService } from '../../WindowService'

const logger = loggerService.withContext('AgentToolPermissionService')
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export type ToolPermissionBehavior = 'allow' | 'deny'

export type ToolPermissionResult = {
  behavior: ToolPermissionBehavior
  updatedInput?: Record<string, unknown>
  updatedPermissions?: AgentPermissionUpdate[]
  message?: string
}

type ToolPermissionResponsePayload = {
  requestId: string
  behavior: ToolPermissionBehavior
  updatedInput?: unknown
  message?: string
  updatedPermissions?: AgentPermissionUpdate[]
}

type RendererPermissionRequestPayload = {
  requestId: string
  toolName: string
  toolId: string
  toolCallId: string
  description?: string
  requiresPermissions: boolean
  input: Record<string, unknown>
  inputPreview: string
  createdAt: number
  suggestions: AgentPermissionUpdate[]
  autoApprove?: boolean
}

type RendererPermissionResultPayload = {
  requestId: string
  behavior: ToolPermissionBehavior
  message?: string
  reason: 'response' | 'timeout' | 'aborted' | 'no-window'
  toolCallId?: string
  updatedInput?: Record<string, unknown>
}

type PendingPermissionRequest = {
  fulfill: (update: ToolPermissionResult) => void
  signal?: AbortSignal
  abortListener?: () => void
  timeout?: NodeJS.Timeout
  originalInput: Record<string, unknown>
  toolName: string
  toolCallId?: string
}

type PromptForToolApprovalOptions = {
  signal?: AbortSignal
  suggestions?: AgentPermissionUpdate[]
  autoApprove?: boolean
  toolCallId: string
  description?: string
  timeoutMs?: number
}

const pendingRequests = new Map<string, PendingPermissionRequest>()
let ipcHandlersInitialized = false

const jsonReplacer = (_key: string, value: unknown) => {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Map) return Object.fromEntries(value.entries())
  if (value instanceof Set) return Array.from(value.values())
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'function') return undefined
  if (value === undefined) return undefined
  return value
}

const sanitizeStructuredData = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value, jsonReplacer)) as T
  } catch (error) {
    logger.warn('Failed to sanitize structured data for tool permission payload', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
    })
    return value
  }
}

const buildInputPreview = (value: unknown): string => {
  let preview: string

  try {
    preview = JSON.stringify(value, null, 2)
  } catch {
    preview = typeof value === 'string' ? value : String(value)
  }

  return preview.length > 2_000 ? `${preview.slice(0, 2_000)}...` : preview
}

const broadcastToRenderer = (
  channel: IpcChannel,
  payload: RendererPermissionRequestPayload | RendererPermissionResultPayload
): boolean => {
  const mainWindow = typeof windowService.getMainWindow === 'function' ? windowService.getMainWindow() : null

  if (!mainWindow) {
    logger.warn('Unable to send agent tool permission payload because main window is unavailable', {
      channel,
      requestId: 'requestId' in payload ? payload.requestId : undefined
    })
    return false
  }

  mainWindow.webContents.send(channel, payload)
  return true
}

const finalizeRequest = (
  requestId: string,
  update: ToolPermissionResult,
  reason: RendererPermissionResultPayload['reason']
) => {
  const pending = pendingRequests.get(requestId)

  if (!pending) {
    logger.debug('Attempted to finalize unknown tool permission request', { requestId, reason })
    return false
  }

  pendingRequests.delete(requestId)

  if (pending.timeout) {
    clearTimeout(pending.timeout)
  }
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener('abort', pending.abortListener)
  }

  pending.fulfill(update)

  const resultPayload: RendererPermissionResultPayload = {
    requestId,
    behavior: update.behavior,
    message: update.behavior === 'deny' ? update.message : undefined,
    reason,
    toolCallId: pending.toolCallId,
    updatedInput: update.behavior === 'allow' ? update.updatedInput : undefined
  }

  broadcastToRenderer(IpcChannel.AgentToolPermission_Result, resultPayload)
  return true
}

const ensureIpcHandlersRegistered = () => {
  if (ipcHandlersInitialized) return

  ipcHandlersInitialized = true

  ipcMain.handle(IpcChannel.AgentToolPermission_Response, async (_event, payload: ToolPermissionResponsePayload) => {
    const { requestId, behavior, updatedInput, message } = payload
    const pending = pendingRequests.get(requestId)

    if (!pending) {
      logger.warn('Received renderer tool permission response for unknown request', { requestId })
      return { success: false, error: 'unknown-request' }
    }

    const maybeUpdatedInput =
      updatedInput && typeof updatedInput === 'object' && !Array.isArray(updatedInput)
        ? (updatedInput as Record<string, unknown>)
        : pending.originalInput

    const finalUpdate: ToolPermissionResult =
      behavior === 'allow'
        ? {
            behavior: 'allow',
            updatedInput: sanitizeStructuredData(maybeUpdatedInput),
            updatedPermissions: Array.isArray(payload.updatedPermissions)
              ? payload.updatedPermissions.map((perm) => sanitizeStructuredData(perm))
              : undefined
          }
        : {
            behavior: 'deny',
            message: message ?? 'User denied permission for this tool'
          }

    finalizeRequest(requestId, finalUpdate, 'response')
    return { success: true }
  })
}

export async function promptForToolApproval(
  toolName: string,
  input: Record<string, unknown>,
  options: PromptForToolApprovalOptions
): Promise<ToolPermissionResult> {
  ensureIpcHandlersRegistered()

  if (options.signal?.aborted) {
    return { behavior: 'deny', message: 'Tool request was cancelled before prompting the user' }
  }

  const mainWindow = typeof windowService.getMainWindow === 'function' ? windowService.getMainWindow() : null
  if (!mainWindow) {
    return { behavior: 'deny', message: 'Unable to request approval because the renderer window is unavailable' }
  }

  const sanitizedInput = sanitizeStructuredData(input)
  const requestId = randomUUID()
  const requestPayload: RendererPermissionRequestPayload = {
    requestId,
    toolName,
    toolId: toolName,
    toolCallId: options.toolCallId,
    description: options.description,
    requiresPermissions: true,
    input: sanitizedInput,
    inputPreview: buildInputPreview(sanitizedInput),
    createdAt: Date.now(),
    suggestions: (options.suggestions ?? []).map((suggestion) => sanitizeStructuredData(suggestion)),
    autoApprove: options.autoApprove
  }

  return new Promise<ToolPermissionResult>((resolve) => {
    const pending: PendingPermissionRequest = {
      fulfill: resolve,
      originalInput: sanitizedInput,
      toolName,
      signal: options.signal,
      toolCallId: options.toolCallId
    }

    if (options.signal) {
      const abortListener = () => {
        finalizeRequest(
          requestId,
          { behavior: 'deny', message: 'Tool request aborted before user decision' },
          'aborted'
        )
      }
      pending.abortListener = abortListener
      options.signal.addEventListener('abort', abortListener, { once: true })
    }

    pending.timeout = setTimeout(() => {
      finalizeRequest(requestId, { behavior: 'deny', message: 'Tool permission request timed out' }, 'timeout')
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    pendingRequests.set(requestId, pending)

    const sent = broadcastToRenderer(IpcChannel.AgentToolPermission_Request, requestPayload)
    if (!sent) {
      finalizeRequest(
        requestId,
        { behavior: 'deny', message: 'Unable to request approval because the renderer window is unavailable' },
        'no-window'
      )
    }
  })
}
