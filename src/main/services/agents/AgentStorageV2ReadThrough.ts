import { storageV2AgentDbMirrorService } from '@main/services/storageV2/AgentDbMirrorService'
import { storageV2AgentRuntimeRecoveryService } from '@main/services/storageV2/AgentRuntimeRecoveryService'
import { storageV2AgentRuntimeTombstoneService } from '@main/services/storageV2/AgentRuntimeTombstoneService'
import type {
  AgentMessagePersistExchangePayload,
  AgentMessagePersistExchangeResult,
  AgentPersistedMessage,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateSessionRequest,
  CreateTaskRequest,
  GetAgentResponse,
  GetAgentSessionResponse,
  ListOptions,
  UpdateAgentRequest,
  UpdateAgentResponse,
  UpdateSessionRequest,
  UpdateSessionResponse,
  UpdateTaskRequest
} from '@types'

import { agentMessageRepository } from './database/sessionMessageRepository'
import { agentService } from './services/AgentService'
import { channelService } from './services/ChannelService'
import { sessionMessageService } from './services/SessionMessageService'
import { sessionService } from './services/SessionService'
import { taskService } from './services/TaskService'

export type ChannelUpdateInput = Parameters<typeof channelService.updateChannel>[1]
export type ChannelCreateInput = Parameters<typeof channelService.createChannel>[0]
export type TaskRunLogInput = Parameters<typeof taskService.logTaskRun>[0]
export type TaskRunLogUpdateInput = Parameters<typeof taskService.updateTaskRunLog>[1]

async function recoverAgentRuntimeForWrite(agentId: string | undefined, reason: string) {
  if (!agentId) return
  await storageV2AgentRuntimeRecoveryService.projectIfAgentMissing(agentId, reason)
}

async function flushAgentRuntimeMutationToStorageV2(options: { strict?: boolean } = {}) {
  if (options.strict) {
    await storageV2AgentDbMirrorService.flushStrict()
    return
  }

  storageV2AgentDbMirrorService.schedule(0)
  await storageV2AgentDbMirrorService.flush()
}

export async function listAgentsWithStorageV2Recovery(options: ListOptions) {
  const result = await agentService.listAgents(options)
  if (result.total > 0) return result

  if (await storageV2AgentRuntimeRecoveryService.projectIfLegacyAgentListEmpty('agent-list-empty')) {
    return agentService.listAgents(options)
  }

  return result
}

export async function createAgentWithStorageV2Recovery(form: CreateAgentRequest): Promise<CreateAgentResponse> {
  const agent = await agentService.createAgent(form)
  await flushAgentRuntimeMutationToStorageV2()
  return agent
}

export async function getAgentWithStorageV2Recovery(id: string): Promise<GetAgentResponse | null> {
  const agent = await agentService.getAgent(id)
  if (agent) return agent

  if (await storageV2AgentRuntimeRecoveryService.projectIfAgentMissing(id, 'agent-get-missing')) {
    return agentService.getAgent(id)
  }

  return null
}

export async function updateAgentWithStorageV2Recovery(
  id: string,
  updates: UpdateAgentRequest,
  options: { replace?: boolean } = {}
): Promise<UpdateAgentResponse | null> {
  let agent = await agentService.updateAgent(id, updates, options)
  if (!agent && (await storageV2AgentRuntimeRecoveryService.projectIfAgentMissing(id, 'agent-update-missing'))) {
    agent = await agentService.updateAgent(id, updates, options)
  }
  if (agent) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return agent
}

export async function reorderAgentsWithStorageV2Recovery(orderedIds: string[]): Promise<void> {
  await agentService.reorderAgents(orderedIds)
  await flushAgentRuntimeMutationToStorageV2()
}

export async function deleteAgentWithStorageV2Recovery(id: string): Promise<boolean> {
  let agent = await agentService.getAgent(id)
  if (!agent && (await storageV2AgentRuntimeRecoveryService.projectIfAgentMissing(id, 'agent-delete-missing'))) {
    agent = await agentService.getAgent(id)
  }

  if (!agent) return false

  await storageV2AgentRuntimeTombstoneService.tombstoneAgent(id)
  const deleted = await agentService.deleteAgent(id)
  if (deleted) {
    await flushAgentRuntimeMutationToStorageV2({ strict: true })
  }
  return deleted
}

export async function createSessionWithStorageV2Recovery(
  agentId: string,
  form: Partial<CreateSessionRequest> = {}
): Promise<GetAgentSessionResponse | null> {
  try {
    const session = await sessionService.createSession(agentId, form)
    if (session) {
      await flushAgentRuntimeMutationToStorageV2()
    }
    return session
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Agent not found' &&
      (await storageV2AgentRuntimeRecoveryService.projectIfAgentMissing(agentId, 'agent-session-create-missing-agent'))
    ) {
      const session = await sessionService.createSession(agentId, form)
      if (session) {
        await flushAgentRuntimeMutationToStorageV2()
      }
      return session
    }
    throw error
  }
}

export async function listSessionsWithStorageV2Recovery(agentId: string, options: ListOptions) {
  const result = await sessionService.listSessions(agentId, options)
  if (result.total > 0) return result

  if (await storageV2AgentRuntimeRecoveryService.projectIfSessionListEmpty(agentId, 'agent-session-list-empty')) {
    return sessionService.listSessions(agentId, options)
  }

  return result
}

export async function listAllSessionsWithStorageV2Recovery(options: ListOptions) {
  const result = await sessionService.listSessions(undefined, options)
  if (result.total > 0) return result

  if (await storageV2AgentRuntimeRecoveryService.projectIfSessionListEmpty(undefined, 'agent-session-list-all-empty')) {
    return sessionService.listSessions(undefined, options)
  }

  return result
}

export async function getSessionWithStorageV2Recovery(
  agentId: string,
  sessionId: string
): Promise<GetAgentSessionResponse | null> {
  const session = await sessionService.getSession(agentId, sessionId)
  if (session) return session

  if (await storageV2AgentRuntimeRecoveryService.projectIfSessionMissing(agentId, sessionId, 'agent-session-missing')) {
    return sessionService.getSession(agentId, sessionId)
  }

  return null
}

export async function updateSessionWithStorageV2Recovery(
  agentId: string,
  sessionId: string,
  updates: UpdateSessionRequest
): Promise<UpdateSessionResponse | null> {
  let session = await sessionService.updateSession(agentId, sessionId, updates)
  if (
    !session &&
    (await storageV2AgentRuntimeRecoveryService.projectIfSessionMissing(
      agentId,
      sessionId,
      'agent-session-update-missing'
    ))
  ) {
    session = await sessionService.updateSession(agentId, sessionId, updates)
  }
  if (session) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return session
}

export async function deleteSessionWithStorageV2Recovery(agentId: string, sessionId: string): Promise<boolean> {
  let session = await sessionService.getSession(agentId, sessionId)
  if (
    !session &&
    (await storageV2AgentRuntimeRecoveryService.projectIfSessionMissing(
      agentId,
      sessionId,
      'agent-session-delete-missing'
    ))
  ) {
    session = await sessionService.getSession(agentId, sessionId)
  }

  if (!session) return false

  await storageV2AgentRuntimeTombstoneService.tombstoneSession(sessionId)
  const deleted = await sessionService.deleteSession(agentId, sessionId)
  if (deleted) {
    await flushAgentRuntimeMutationToStorageV2({ strict: true })
  }
  return deleted
}

export async function reorderSessionsWithStorageV2Recovery(agentId: string, orderedIds: string[]): Promise<void> {
  await sessionService.reorderSessions(agentId, orderedIds)
  await flushAgentRuntimeMutationToStorageV2()
}

function shouldRetryAgentMessagePersistence(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /foreign key|constraint|session/i.test(message)
}

export async function persistAgentMessageExchangeWithStorageV2Recovery(
  payload: AgentMessagePersistExchangePayload
): Promise<AgentMessagePersistExchangeResult> {
  try {
    const result = await agentMessageRepository.persistExchange(payload)
    await flushAgentRuntimeMutationToStorageV2()
    return result
  } catch (error) {
    if (
      payload.sessionId &&
      shouldRetryAgentMessagePersistence(error) &&
      (await storageV2AgentRuntimeRecoveryService.projectIfSessionMissingById(
        payload.sessionId,
        'agent-message-persist-missing-session'
      ))
    ) {
      const result = await agentMessageRepository.persistExchange(payload)
      await flushAgentRuntimeMutationToStorageV2()
      return result
    }

    throw error
  }
}

export async function getAgentSessionHistoryWithStorageV2Recovery(sessionId: string): Promise<AgentPersistedMessage[]> {
  const messages = await agentMessageRepository.getSessionHistory(sessionId)
  if (messages.length > 0) return messages

  if (
    await storageV2AgentRuntimeRecoveryService.projectIfSessionMessagesEmpty(sessionId, 'agent-message-history-empty')
  ) {
    return agentMessageRepository.getSessionHistory(sessionId)
  }

  return messages
}

export async function deleteAgentSessionMessageWithStorageV2Recovery(
  sessionId: string,
  messageId: number
): Promise<boolean> {
  let messageExists = await sessionMessageService.sessionMessageExists(messageId)
  if (
    !messageExists &&
    (await storageV2AgentRuntimeRecoveryService.projectIfSessionMessagesEmpty(
      sessionId,
      'agent-message-delete-missing'
    ))
  ) {
    messageExists = await sessionMessageService.sessionMessageExists(messageId)
  }

  if (!messageExists) return false

  await storageV2AgentRuntimeTombstoneService.tombstoneSessionMessage(messageId)
  const deleted = await sessionMessageService.deleteSessionMessage(sessionId, messageId)
  if (deleted) {
    await flushAgentRuntimeMutationToStorageV2({ strict: true })
  }
  return deleted
}

export async function listTasksWithStorageV2Recovery(
  agentId: string,
  options: ListOptions & { includeHeartbeat?: boolean } = {}
) {
  const result = await taskService.listTasks(agentId, options)
  if (result.total > 0) return result

  if (
    await storageV2AgentRuntimeRecoveryService.projectIfTaskListEmpty(
      { agentId, includeHeartbeat: options.includeHeartbeat },
      'agent-task-list-empty'
    )
  ) {
    return taskService.listTasks(agentId, options)
  }

  return result
}

export async function createTaskWithStorageV2Recovery(agentId: string, task: CreateTaskRequest) {
  await recoverAgentRuntimeForWrite(agentId, 'agent-task-create-missing-agent')
  const createdTask = await taskService.createTask(agentId, task)
  if (createdTask) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return createdTask
}

export async function listAllTasksWithStorageV2Recovery(options: ListOptions = {}) {
  const result = await taskService.listAllTasks(options)
  if (result.total > 0) return result

  if (await storageV2AgentRuntimeRecoveryService.projectIfTaskListEmpty({}, 'agent-task-list-all-empty')) {
    return taskService.listAllTasks(options)
  }

  return result
}

export async function getTaskWithStorageV2Recovery(agentId: string, taskId: string) {
  const task = await taskService.getTask(agentId, taskId)
  if (task) return task

  if (await storageV2AgentRuntimeRecoveryService.projectIfTaskMissing(taskId, 'agent-task-missing')) {
    return taskService.getTask(agentId, taskId)
  }

  return null
}

export async function getTaskByIdWithStorageV2Recovery(taskId: string) {
  const task = await taskService.getTaskById(taskId)
  if (task) return task

  if (await storageV2AgentRuntimeRecoveryService.projectIfTaskMissing(taskId, 'agent-task-by-id-missing')) {
    return taskService.getTaskById(taskId)
  }

  return null
}

export async function updateTaskWithStorageV2Recovery(agentId: string, taskId: string, updates: UpdateTaskRequest) {
  let task = await taskService.updateTask(agentId, taskId, updates)
  if (!task && (await storageV2AgentRuntimeRecoveryService.projectIfTaskMissing(taskId, 'agent-task-update-missing'))) {
    task = await taskService.updateTask(agentId, taskId, updates)
  }
  if (task) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return task
}

export async function updateTaskByIdWithStorageV2Recovery(taskId: string, updates: UpdateTaskRequest) {
  let task = await taskService.updateTaskById(taskId, updates)
  if (
    !task &&
    (await storageV2AgentRuntimeRecoveryService.projectIfTaskMissing(taskId, 'agent-task-update-by-id-missing'))
  ) {
    task = await taskService.updateTaskById(taskId, updates)
  }
  if (task) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return task
}

export async function updateTaskAfterRunWithStorageV2Recovery(
  taskId: string,
  nextRun: string | null,
  lastResult: string
): Promise<void> {
  await taskService.updateTaskAfterRun(taskId, nextRun, lastResult)
  await flushAgentRuntimeMutationToStorageV2()
}

export async function deleteTaskWithStorageV2Recovery(agentId: string, taskId: string): Promise<boolean> {
  let task = await taskService.getTask(agentId, taskId)
  if (!task && (await storageV2AgentRuntimeRecoveryService.projectIfTaskMissing(taskId, 'agent-task-delete-missing'))) {
    task = await taskService.getTask(agentId, taskId)
  }

  if (!task) return false

  await storageV2AgentRuntimeTombstoneService.tombstoneTask(taskId)
  const deleted = await taskService.deleteTask(agentId, taskId)
  if (deleted) {
    await flushAgentRuntimeMutationToStorageV2({ strict: true })
  }
  return deleted
}

export async function deleteTaskByIdWithStorageV2Recovery(taskId: string): Promise<boolean> {
  let task = await taskService.getTaskById(taskId)
  if (
    !task &&
    (await storageV2AgentRuntimeRecoveryService.projectIfTaskMissing(taskId, 'agent-task-delete-by-id-missing'))
  ) {
    task = await taskService.getTaskById(taskId)
  }

  if (!task) return false

  await storageV2AgentRuntimeTombstoneService.tombstoneTask(taskId)
  const deleted = await taskService.deleteTaskById(taskId)
  if (deleted) {
    await flushAgentRuntimeMutationToStorageV2({ strict: true })
  }
  return deleted
}

export async function logTaskRunWithStorageV2Recovery(log: TaskRunLogInput): Promise<number> {
  const logId = await taskService.logTaskRun(log)
  await flushAgentRuntimeMutationToStorageV2()
  return logId
}

export async function updateTaskRunLogWithStorageV2Recovery(
  logId: number,
  updates: TaskRunLogUpdateInput
): Promise<void> {
  await taskService.updateTaskRunLog(logId, updates)
  await flushAgentRuntimeMutationToStorageV2()
}

export async function getTaskLogsWithStorageV2Recovery(taskId: string, options: ListOptions = {}) {
  const result = await taskService.getTaskLogs(taskId, options)
  if (result.total > 0) return result

  if (await storageV2AgentRuntimeRecoveryService.projectIfTaskLogsEmpty(taskId, 'agent-task-logs-empty')) {
    return taskService.getTaskLogs(taskId, options)
  }

  return result
}

export async function getDueTasksWithStorageV2Recovery() {
  const tasks = await taskService.getDueTasks()
  if (tasks.length > 0) return tasks

  if (
    await storageV2AgentRuntimeRecoveryService.projectIfTaskListEmpty(
      { includeHeartbeat: true },
      'agent-due-task-list-empty'
    )
  ) {
    return taskService.getDueTasks()
  }

  return tasks
}

export async function hasActiveTasksWithStorageV2Recovery(): Promise<boolean> {
  const hasActive = await taskService.hasActiveTasks()
  if (hasActive) return true

  if (
    await storageV2AgentRuntimeRecoveryService.projectIfTaskListEmpty(
      { includeHeartbeat: true },
      'agent-active-task-list-empty'
    )
  ) {
    return taskService.hasActiveTasks()
  }

  return false
}

export async function listChannelsWithStorageV2Recovery(filters: { agentId?: string; type?: string } = {}) {
  const channels = await channelService.listChannels(filters)
  if (channels.length > 0) return channels

  if (await storageV2AgentRuntimeRecoveryService.projectIfChannelListEmpty(filters, 'agent-channel-list-empty')) {
    return channelService.listChannels(filters)
  }

  return channels
}

export async function createChannelWithStorageV2Recovery(data: ChannelCreateInput) {
  await recoverAgentRuntimeForWrite(data.agentId, 'agent-channel-create-missing-agent')
  const channel = await channelService.createChannel(data)
  if (channel) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return channel
}

export async function getChannelWithStorageV2Recovery(channelId: string) {
  const channel = await channelService.getChannel(channelId)
  if (channel) return channel

  if (await storageV2AgentRuntimeRecoveryService.projectIfChannelMissing(channelId, 'agent-channel-missing')) {
    return channelService.getChannel(channelId)
  }

  return null
}

export async function updateChannelWithStorageV2Recovery(channelId: string, updates: ChannelUpdateInput) {
  let channel = await channelService.updateChannel(channelId, updates)
  if (
    !channel &&
    (await storageV2AgentRuntimeRecoveryService.projectIfChannelMissing(channelId, 'agent-channel-update-missing'))
  ) {
    channel = await channelService.updateChannel(channelId, updates)
  }
  if (channel) {
    await flushAgentRuntimeMutationToStorageV2()
  }
  return channel
}

export async function deleteChannelWithStorageV2Recovery(channelId: string): Promise<boolean> {
  let channel = await channelService.getChannel(channelId)
  if (
    !channel &&
    (await storageV2AgentRuntimeRecoveryService.projectIfChannelMissing(channelId, 'agent-channel-delete-missing'))
  ) {
    channel = await channelService.getChannel(channelId)
  }

  if (!channel) return false

  await storageV2AgentRuntimeTombstoneService.tombstoneChannel(channelId)
  const deleted = await channelService.deleteChannel(channelId)
  if (deleted) {
    await flushAgentRuntimeMutationToStorageV2({ strict: true })
  }
  return deleted
}
