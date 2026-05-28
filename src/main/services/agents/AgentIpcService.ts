import { loggerService } from '@logger'
import { modelsService } from '@main/apiServer/services/models'
import { storageV2AgentDbMirrorService } from '@main/services/storageV2/AgentDbMirrorService'
import { IpcChannel } from '@shared/IpcChannel'
import type { ApiModelsFilter, CreateSessionMessageRequest, ListOptions, ScheduledTaskEntity } from '@types'
import type { TextStreamPart } from 'ai'
import { ipcMain, type WebContents } from 'electron'

import { agentService, sessionMessageService, sessionService } from './services'
import { channelManager } from './services/channels'
import { channelService } from './services/ChannelService'
import { schedulerService } from './services/SchedulerService'
import { taskService } from './services/TaskService'

const logger = loggerService.withContext('AgentIpcService')

type MessageStreamStartPayload = {
  requestId: string
  agentId: string
  sessionId: string
  message: CreateSessionMessageRequest
}

type MessageStreamChunk =
  | {
      requestId: string
      agentId: string
      sessionId: string
      type: 'chunk'
      chunk: TextStreamPart<Record<string, any>>
    }
  | {
      requestId: string
      agentId: string
      sessionId: string
      type: 'done' | 'aborted'
    }
  | {
      requestId: string
      agentId: string
      sessionId: string
      type: 'error'
      error: { message: string; name?: string; stack?: string }
    }

const activeMessageStreams = new Map<string, AbortController>()
let registered = false

const serializeError = (error: unknown): { message: string; name?: string; stack?: string } => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack
    }
  }
  return { message: typeof error === 'string' ? error : 'Unknown error' }
}

const emitMessageStreamChunk = (sender: WebContents, chunk: MessageStreamChunk) => {
  if (!sender.isDestroyed()) {
    sender.send(IpcChannel.AgentMessageStream_Chunk, chunk)
  }
}

const getCherryClawConfig = (agent: { configuration?: unknown }) =>
  (agent.configuration ?? {}) as {
    heartbeat_enabled?: boolean
    scheduler_enabled?: boolean
    heartbeat_interval?: number
  }

const syncSchedulerIfNeeded = (agentId: string, agent: { configuration?: unknown }) => {
  const config = getCherryClawConfig(agent)
  if (!config.heartbeat_enabled && !config.scheduler_enabled) return

  void schedulerService.syncScheduler()
  schedulerService.ensureHeartbeatTask(agentId, config.heartbeat_interval ?? 30).catch((error) => {
    logger.warn('Failed to sync heartbeat task', {
      agentId,
      error: error instanceof Error ? error.message : String(error)
    })
  })
}

const scheduleStorageV2AgentMirror = () => {
  storageV2AgentDbMirrorService.schedule()
}

const ensureDefaultSession = async (agentId: string) => {
  await sessionService.createSession(agentId, {})
}

const createAgentWithDefaultSession = async (form: any) => {
  const agent = await agentService.createAgent(form)

  try {
    await ensureDefaultSession(agent.id)
    const config = getCherryClawConfig(agent)
    if (config.heartbeat_enabled) {
      await schedulerService.ensureHeartbeatTask(agent.id, config.heartbeat_interval ?? 30)
    }
    return agent
  } catch (error) {
    logger.error('Failed to create default session for new agent, rolling back agent creation', {
      agentId: agent.id,
      error
    })
    await agentService.deleteAgent(agent.id).catch((rollbackError) => {
      logger.error('Failed to roll back agent after session creation failure', {
        agentId: agent.id,
        error: rollbackError
      })
    })
    throw error
  }
}

const deleteSessionWithFallback = async (agentId: string, sessionId: string) => {
  const existing = await sessionService.getSession(agentId, sessionId)
  if (!existing || existing.agent_id !== agentId) {
    throw new Error('Session not found for this agent')
  }

  const deleted = await sessionService.deleteSession(agentId, sessionId)
  if (!deleted) {
    throw new Error('Session not found')
  }

  const { total } = await sessionService.listSessions(agentId, { limit: 1 })
  if (total === 0) {
    await ensureDefaultSession(agentId)
  }
}

const startMessageStream = async (sender: WebContents, payload: MessageStreamStartPayload) => {
  const { requestId, agentId, sessionId, message } = payload
  const session = await sessionService.getSession(agentId, sessionId)
  if (!session || session.agent_id !== agentId) {
    throw new Error('Session not found for this agent')
  }

  const abortController = new AbortController()
  activeMessageStreams.set(requestId, abortController)

  try {
    const { stream, completion } = await sessionMessageService.createSessionMessage(session, message, abortController)
    const reader = stream.getReader()

    completion.catch((error) => {
      logger.warn('Agent message stream completion rejected', {
        requestId,
        agentId,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          emitMessageStreamChunk(sender, {
            requestId,
            agentId,
            sessionId,
            type: 'chunk',
            chunk: value
          })
        }

        emitMessageStreamChunk(sender, {
          requestId,
          agentId,
          sessionId,
          type: abortController.signal.aborted ? 'aborted' : 'done'
        })
      } catch (error) {
        if (abortController.signal.aborted) {
          emitMessageStreamChunk(sender, { requestId, agentId, sessionId, type: 'aborted' })
          return
        }

        logger.error('Agent message stream failed', { requestId, agentId, sessionId, error })
        emitMessageStreamChunk(sender, {
          requestId,
          agentId,
          sessionId,
          type: 'error',
          error: serializeError(error)
        })
      } finally {
        activeMessageStreams.delete(requestId)
        reader.releaseLock()
      }
    })()

    return { success: true }
  } catch (error) {
    activeMessageStreams.delete(requestId)
    throw error
  }
}

export function registerAgentIpcHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle(IpcChannel.Agent_List, async (_event, options?: ListOptions) => {
    const limit = options?.limit ?? 1000
    const offset = options?.offset ?? 0
    const sortBy = options?.sortBy ?? 'sort_order'
    const orderBy = options?.orderBy ?? (sortBy === 'sort_order' ? 'asc' : 'desc')
    const result = await agentService.listAgents({ limit, offset, sortBy, orderBy })
    return { data: result.agents, total: result.total, limit, offset }
  })

  ipcMain.handle(IpcChannel.Agent_Create, async (_event, form: any) => {
    const agent = await createAgentWithDefaultSession(form)
    scheduleStorageV2AgentMirror()
    return agent
  })
  ipcMain.handle(IpcChannel.Agent_Get, (_event, id: string) => agentService.getAgent(id))
  ipcMain.handle(IpcChannel.Agent_Update, async (_event, id: string, updates: any, options?: { replace?: boolean }) => {
    const agent = await agentService.updateAgent(id, updates, { replace: options?.replace === true })
    if (!agent) throw new Error('Agent not found')
    syncSchedulerIfNeeded(id, agent)
    scheduleStorageV2AgentMirror()
    return agent
  })
  ipcMain.handle(IpcChannel.Agent_Delete, async (_event, id: string) => {
    const deleted = await agentService.deleteAgent(id)
    if (!deleted) throw new Error('Agent not found')
    void channelManager.disconnectAgent(id)
    scheduleStorageV2AgentMirror()
    return { success: true }
  })
  ipcMain.handle(IpcChannel.Agent_Reorder, async (_event, orderedIds: string[]) => {
    await agentService.reorderAgents(orderedIds)
    scheduleStorageV2AgentMirror()
    return { success: true }
  })

  ipcMain.handle(IpcChannel.AgentSession_List, async (_event, agentId: string, options?: ListOptions) => {
    const limit = options?.limit ?? 20
    const offset = options?.offset ?? 0
    const result = await sessionService.listSessions(agentId, { limit, offset })
    return { data: result.sessions, total: result.total, limit, offset }
  })
  ipcMain.handle(IpcChannel.AgentSession_Create, async (_event, agentId: string, form: any) => {
    const session = await sessionService.createSession(agentId, form)
    scheduleStorageV2AgentMirror()
    return session
  })
  ipcMain.handle(IpcChannel.AgentSession_Get, (_event, agentId: string, sessionId: string) =>
    sessionService.getSession(agentId, sessionId)
  )
  ipcMain.handle(IpcChannel.AgentSession_Update, async (_event, agentId: string, sessionId: string, updates: any) => {
    const session = await sessionService.updateSession(agentId, sessionId, updates)
    if (!session) throw new Error('Session not found')
    scheduleStorageV2AgentMirror()
    return session
  })
  ipcMain.handle(IpcChannel.AgentSession_Delete, async (_event, agentId: string, sessionId: string) => {
    await deleteSessionWithFallback(agentId, sessionId)
    scheduleStorageV2AgentMirror()
  })
  ipcMain.handle(IpcChannel.AgentSession_Reorder, async (_event, agentId: string, orderedIds: string[]) => {
    await sessionService.reorderSessions(agentId, orderedIds)
    scheduleStorageV2AgentMirror()
    return { success: true }
  })
  ipcMain.handle(IpcChannel.AgentSessionMessage_Delete, async (_event, sessionId: string, messageId: number) => {
    const deleted = await sessionMessageService.deleteSessionMessage(sessionId, messageId)
    if (!deleted) throw new Error('Session message not found')
    scheduleStorageV2AgentMirror()
    return { success: true }
  })

  ipcMain.handle(IpcChannel.AgentModels_List, (_event, filter?: ApiModelsFilter) =>
    modelsService.getModels(filter ?? {})
  )

  ipcMain.handle(IpcChannel.AgentTasks_List, async (_event, options?: ListOptions) => {
    const limit = options?.limit ?? 100
    const offset = options?.offset ?? 0
    const result = await taskService.listAllTasks({ limit, offset })
    return { data: result.tasks, total: result.total, limit, offset }
  })
  ipcMain.handle(IpcChannel.AgentTask_Create, async (_event, agentId: string, task: any) => {
    const created = await taskService.createTask(agentId, task)
    schedulerService.startLoop()
    scheduleStorageV2AgentMirror()
    return created
  })
  ipcMain.handle(IpcChannel.AgentTask_Get, async (_event, taskId: string): Promise<ScheduledTaskEntity> => {
    const task = await taskService.getTaskById(taskId)
    if (!task) throw new Error('Task not found')
    return task
  })
  ipcMain.handle(IpcChannel.AgentTask_Update, async (_event, taskId: string, updates: any) => {
    const task = await taskService.updateTaskById(taskId, updates)
    if (!task) throw new Error('Task not found')
    void schedulerService.syncScheduler()
    scheduleStorageV2AgentMirror()
    return task
  })
  ipcMain.handle(IpcChannel.AgentTask_Delete, async (_event, taskId: string) => {
    const deleted = await taskService.deleteTaskById(taskId)
    if (!deleted) throw new Error('Task not found')
    void schedulerService.syncScheduler()
    scheduleStorageV2AgentMirror()
    return { success: true }
  })
  ipcMain.handle(IpcChannel.AgentTask_Run, async (_event, taskId: string) => {
    const task = await taskService.getTaskById(taskId)
    if (!task) throw new Error('Task not found')
    await schedulerService.runTaskNow(task.agent_id, taskId)
    scheduleStorageV2AgentMirror()
    return { success: true }
  })
  ipcMain.handle(IpcChannel.AgentTaskLogs_List, async (_event, taskId: string, options?: ListOptions) => {
    const task = await taskService.getTaskById(taskId)
    if (!task) throw new Error('Task not found')
    const limit = options?.limit ?? 20
    const offset = options?.offset ?? 0
    const result = await taskService.getTaskLogs(taskId, { limit, offset })
    return { data: result.logs, total: result.total, limit, offset }
  })

  ipcMain.handle(IpcChannel.AgentChannels_List, async (_event, filters?: { agent_id?: string; type?: string }) => {
    const channels = await channelService.listChannels({ agentId: filters?.agent_id, type: filters?.type })
    return { data: channels, total: channels.length }
  })
  ipcMain.handle(IpcChannel.AgentChannel_Create, async (_event, data: Record<string, any>) => {
    const { type, name, agent_id, config, is_active, permission_mode } = data
    const channel = await channelService.createChannel({
      type,
      name,
      agentId: agent_id,
      config: { type, ...config },
      isActive: is_active,
      permissionMode: permission_mode
    })
    await channelManager.syncChannel(channel.id)
    scheduleStorageV2AgentMirror()
    return channel
  })
  ipcMain.handle(IpcChannel.AgentChannel_Update, async (_event, id: string, data: Record<string, any>) => {
    const updates: Record<string, unknown> = {}
    if (data.name !== undefined) updates.name = data.name
    if (data.agent_id !== undefined) updates.agentId = data.agent_id
    if (data.session_id !== undefined) updates.sessionId = data.session_id
    if (data.config !== undefined) updates.config = data.config
    if (data.is_active !== undefined) updates.isActive = data.is_active
    if (data.permission_mode !== undefined) updates.permissionMode = data.permission_mode

    const channel = await channelService.updateChannel(id, updates)
    if (!channel) throw new Error('Channel not found')
    await channelManager.syncChannel(id)
    scheduleStorageV2AgentMirror()
    return channel
  })
  ipcMain.handle(IpcChannel.AgentChannel_Delete, async (_event, id: string) => {
    const channel = await channelService.getChannel(id)
    if (!channel) throw new Error('Channel not found')
    await channelService.deleteChannel(id)
    await channelManager.disconnectChannel(id)
    scheduleStorageV2AgentMirror()
    return { success: true }
  })

  ipcMain.handle(IpcChannel.AgentMessageStream_Start, (event, payload: MessageStreamStartPayload) =>
    startMessageStream(event.sender, payload)
  )
  ipcMain.handle(IpcChannel.AgentMessageStream_Abort, (_event, requestId: string) => {
    const controller = activeMessageStreams.get(requestId)
    if (!controller) return { success: false }
    controller.abort('Renderer aborted agent message stream')
    activeMessageStreams.delete(requestId)
    return { success: true }
  })
}
