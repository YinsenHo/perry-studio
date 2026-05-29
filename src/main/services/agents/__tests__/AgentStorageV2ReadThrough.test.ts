import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentService: {
    createAgent: vi.fn(),
    getAgent: vi.fn(),
    listAgents: vi.fn(),
    updateAgent: vi.fn(),
    reorderAgents: vi.fn(),
    deleteAgent: vi.fn()
  },
  sessionService: {
    createSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    updateSession: vi.fn(),
    reorderSessions: vi.fn(),
    deleteSession: vi.fn()
  },
  sessionMessageService: {
    sessionMessageExists: vi.fn(),
    deleteSessionMessage: vi.fn()
  },
  taskService: {
    createTask: vi.fn(),
    getTask: vi.fn(),
    getTaskById: vi.fn(),
    getTaskLogs: vi.fn(),
    getDueTasks: vi.fn(),
    hasActiveTasks: vi.fn(),
    listTasks: vi.fn(),
    listAllTasks: vi.fn(),
    updateTask: vi.fn(),
    updateTaskById: vi.fn(),
    updateTaskAfterRun: vi.fn(),
    deleteTask: vi.fn(),
    deleteTaskById: vi.fn(),
    logTaskRun: vi.fn(),
    updateTaskRunLog: vi.fn()
  },
  channelService: {
    createChannel: vi.fn(),
    getChannel: vi.fn(),
    listChannels: vi.fn(),
    updateChannel: vi.fn(),
    deleteChannel: vi.fn()
  },
  recovery: {
    projectIfAgentListMissingRows: vi.fn(),
    projectIfAgentMissing: vi.fn(),
    projectIfSessionListEmpty: vi.fn(),
    projectIfSessionMissing: vi.fn(),
    projectIfSessionMissingById: vi.fn(),
    projectIfSessionMessagesEmpty: vi.fn(),
    projectIfTaskListEmpty: vi.fn(),
    projectIfTaskLogsEmpty: vi.fn(),
    projectIfTaskMissing: vi.fn(),
    projectIfChannelListEmpty: vi.fn(),
    projectIfChannelMissing: vi.fn()
  },
  mirror: {
    schedule: vi.fn(),
    flush: vi.fn(),
    flushStrict: vi.fn()
  },
  tombstone: {
    tombstoneAgent: vi.fn(),
    tombstoneSession: vi.fn(),
    tombstoneSessionMessage: vi.fn(),
    tombstoneTask: vi.fn(),
    tombstoneChannel: vi.fn()
  }
}))

vi.mock('@main/services/storageV2/AgentRuntimeRecoveryService', () => ({
  storageV2AgentRuntimeRecoveryService: mocks.recovery
}))

vi.mock('@main/services/storageV2/AgentDbMirrorService', () => ({
  storageV2AgentDbMirrorService: mocks.mirror
}))

vi.mock('@main/services/storageV2/AgentRuntimeTombstoneService', () => ({
  storageV2AgentRuntimeTombstoneService: mocks.tombstone
}))

vi.mock('../services/AgentService', () => ({
  agentService: mocks.agentService
}))

vi.mock('../services/SessionService', () => ({
  sessionService: mocks.sessionService
}))

vi.mock('../services/SessionMessageService', () => ({
  sessionMessageService: mocks.sessionMessageService
}))

vi.mock('../services/TaskService', () => ({
  taskService: mocks.taskService
}))

vi.mock('../services/ChannelService', () => ({
  channelService: mocks.channelService
}))

vi.mock('../database/sessionMessageRepository', () => ({
  agentMessageRepository: {
    persistExchange: vi.fn(),
    getSessionHistory: vi.fn(),
    findRowsByPayloadMessageIds: vi.fn(),
    listRowsForSession: vi.fn(),
    deleteRowsByIds: vi.fn()
  }
}))

import {
  clearAgentSessionMessagesWithStorageV2Recovery,
  createAgentWithStorageV2Recovery,
  createChannelWithStorageV2Recovery,
  createSessionWithStorageV2Recovery,
  createTaskWithStorageV2Recovery,
  deleteAgentSessionMessagesByPayloadIdsWithStorageV2Recovery,
  deleteAgentSessionMessageWithStorageV2Recovery,
  deleteAgentWithStorageV2Recovery,
  deleteChannelWithStorageV2Recovery,
  deleteSessionWithStorageV2Recovery,
  deleteTaskByIdWithStorageV2Recovery,
  deleteTaskWithStorageV2Recovery,
  getAgentSessionHistoryWithStorageV2Recovery,
  getDueTasksWithStorageV2Recovery,
  getTaskLogsWithStorageV2Recovery,
  hasActiveTasksWithStorageV2Recovery,
  listAgentsWithStorageV2Recovery,
  listAllSessionsWithStorageV2Recovery,
  listAllTasksWithStorageV2Recovery,
  listChannelsWithStorageV2Recovery,
  listSessionsWithStorageV2Recovery,
  listTasksWithStorageV2Recovery,
  logTaskRunWithStorageV2Recovery,
  persistAgentMessageExchangeWithStorageV2Recovery,
  reorderAgentsWithStorageV2Recovery,
  reorderSessionsWithStorageV2Recovery,
  updateAgentWithStorageV2Recovery,
  updateChannelWithStorageV2Recovery,
  updateSessionWithStorageV2Recovery,
  updateTaskAfterRunWithStorageV2Recovery,
  updateTaskByIdWithStorageV2Recovery,
  updateTaskRunLogWithStorageV2Recovery,
  updateTaskWithStorageV2Recovery
} from '../AgentStorageV2ReadThrough'
import { agentMessageRepository } from '../database/sessionMessageRepository'

describe('AgentStorageV2ReadThrough mutation wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.mirror.flush.mockResolvedValue(undefined)
    mocks.mirror.flushStrict.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneAgent.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneSession.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneSessionMessage.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneTask.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneChannel.mockResolvedValue(undefined)
    mocks.recovery.projectIfAgentListMissingRows.mockResolvedValue(false)
    mocks.recovery.projectIfAgentMissing.mockResolvedValue(false)
    mocks.recovery.projectIfSessionListEmpty.mockResolvedValue(false)
    mocks.recovery.projectIfSessionMissing.mockResolvedValue(false)
    mocks.recovery.projectIfSessionMissingById.mockResolvedValue(false)
    mocks.recovery.projectIfSessionMessagesEmpty.mockResolvedValue(false)
    mocks.recovery.projectIfTaskListEmpty.mockResolvedValue(false)
    mocks.recovery.projectIfTaskLogsEmpty.mockResolvedValue(false)
    mocks.recovery.projectIfTaskMissing.mockResolvedValue(false)
    mocks.recovery.projectIfChannelListEmpty.mockResolvedValue(false)
    mocks.recovery.projectIfChannelMissing.mockResolvedValue(false)
    vi.mocked(agentMessageRepository.findRowsByPayloadMessageIds).mockResolvedValue([])
    vi.mocked(agentMessageRepository.listRowsForSession).mockResolvedValue([])
    vi.mocked(agentMessageRepository.deleteRowsByIds).mockResolvedValue([])
  })

  it('projects Storage v2 agents when the legacy agent list is partially populated', async () => {
    mocks.agentService.listAgents
      .mockResolvedValueOnce({ agents: [{ id: 'agent-legacy' }], total: 1 })
      .mockResolvedValueOnce({ agents: [{ id: 'agent-storage' }, { id: 'agent-legacy' }], total: 2 })
    mocks.recovery.projectIfAgentListMissingRows.mockResolvedValueOnce(true)

    await expect(listAgentsWithStorageV2Recovery({})).resolves.toEqual({
      agents: [{ id: 'agent-storage' }, { id: 'agent-legacy' }],
      total: 2
    })

    expect(mocks.recovery.projectIfAgentListMissingRows).toHaveBeenCalledWith('agent-list-missing-rows')
    expect(mocks.agentService.listAgents).toHaveBeenCalledTimes(2)
  })

  it('projects Storage v2 runtime rows for empty session, task, task log, due task, and channel lists', async () => {
    mocks.sessionService.listSessions
      .mockResolvedValueOnce({ sessions: [], total: 0 })
      .mockResolvedValueOnce({ sessions: [{ id: 'session-1' }], total: 1 })
      .mockResolvedValueOnce({ sessions: [], total: 0 })
      .mockResolvedValueOnce({ sessions: [{ id: 'session-all' }], total: 1 })
    mocks.taskService.listTasks
      .mockResolvedValueOnce({ tasks: [], total: 0 })
      .mockResolvedValueOnce({ tasks: [{ id: 'task-1' }], total: 1 })
    mocks.taskService.listAllTasks
      .mockResolvedValueOnce({ tasks: [], total: 0 })
      .mockResolvedValueOnce({ tasks: [{ id: 'task-all' }], total: 1 })
    mocks.taskService.getTaskLogs
      .mockResolvedValueOnce({ logs: [], total: 0 })
      .mockResolvedValueOnce({ logs: [{ id: 1 }], total: 1 })
    mocks.taskService.getDueTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'due-task' }])
    mocks.taskService.hasActiveTasks.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mocks.channelService.listChannels.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'channel-1' }])
    mocks.recovery.projectIfSessionListEmpty.mockResolvedValue(true)
    mocks.recovery.projectIfTaskListEmpty.mockResolvedValue(true)
    mocks.recovery.projectIfTaskLogsEmpty.mockResolvedValue(true)
    mocks.recovery.projectIfChannelListEmpty.mockResolvedValue(true)

    await expect(listSessionsWithStorageV2Recovery('agent-1', { limit: 10 })).resolves.toEqual({
      sessions: [{ id: 'session-1' }],
      total: 1
    })
    await expect(listAllSessionsWithStorageV2Recovery({ limit: 10 })).resolves.toEqual({
      sessions: [{ id: 'session-all' }],
      total: 1
    })
    await expect(listTasksWithStorageV2Recovery('agent-1', { includeHeartbeat: true })).resolves.toEqual({
      tasks: [{ id: 'task-1' }],
      total: 1
    })
    await expect(listAllTasksWithStorageV2Recovery({ limit: 10 })).resolves.toEqual({
      tasks: [{ id: 'task-all' }],
      total: 1
    })
    await expect(getTaskLogsWithStorageV2Recovery('task-1', { limit: 5 })).resolves.toEqual({
      logs: [{ id: 1 }],
      total: 1
    })
    await expect(getDueTasksWithStorageV2Recovery()).resolves.toEqual([{ id: 'due-task' }])
    await expect(hasActiveTasksWithStorageV2Recovery()).resolves.toBe(true)
    await expect(listChannelsWithStorageV2Recovery({ agentId: 'agent-1', type: 'telegram' })).resolves.toEqual([
      { id: 'channel-1' }
    ])

    expect(mocks.recovery.projectIfSessionListEmpty).toHaveBeenCalledWith('agent-1', 'agent-session-list-empty')
    expect(mocks.recovery.projectIfSessionListEmpty).toHaveBeenCalledWith(undefined, 'agent-session-list-all-empty')
    expect(mocks.recovery.projectIfTaskListEmpty).toHaveBeenCalledWith(
      { agentId: 'agent-1', includeHeartbeat: true },
      'agent-task-list-empty'
    )
    expect(mocks.recovery.projectIfTaskListEmpty).toHaveBeenCalledWith({}, 'agent-task-list-all-empty')
    expect(mocks.recovery.projectIfTaskLogsEmpty).toHaveBeenCalledWith('task-1', 'agent-task-logs-empty')
    expect(mocks.recovery.projectIfTaskListEmpty).toHaveBeenCalledWith(
      { includeHeartbeat: true },
      'agent-due-task-list-empty'
    )
    expect(mocks.recovery.projectIfTaskListEmpty).toHaveBeenCalledWith(
      { includeHeartbeat: true },
      'agent-active-task-list-empty'
    )
    expect(mocks.recovery.projectIfChannelListEmpty).toHaveBeenCalledWith(
      { agentId: 'agent-1', type: 'telegram' },
      'agent-channel-list-empty'
    )
  })

  it('projects Storage v2 agent session history when the legacy history cache is empty', async () => {
    const recoveredHistory = [{ id: 1, role: 'assistant' }]
    vi.mocked(agentMessageRepository.getSessionHistory)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(recoveredHistory as any)
    mocks.recovery.projectIfSessionMessagesEmpty.mockResolvedValueOnce(true)

    await expect(getAgentSessionHistoryWithStorageV2Recovery('session-1')).resolves.toEqual(recoveredHistory)

    expect(mocks.recovery.projectIfSessionMessagesEmpty).toHaveBeenCalledWith(
      'session-1',
      'agent-message-history-empty'
    )
    expect(agentMessageRepository.getSessionHistory).toHaveBeenCalledTimes(2)
  })

  it('flushes the Storage v2 agent mirror after destructive writes', async () => {
    mocks.agentService.getAgent.mockResolvedValue({ id: 'agent-1' })
    mocks.agentService.deleteAgent.mockResolvedValue(true)
    mocks.sessionService.getSession.mockResolvedValue({ id: 'session-1' })
    mocks.sessionService.deleteSession.mockResolvedValue(true)
    mocks.sessionMessageService.sessionMessageExists.mockResolvedValue(true)
    mocks.sessionMessageService.deleteSessionMessage.mockResolvedValue(true)
    mocks.taskService.getTask.mockResolvedValue({ id: 'task-1' })
    mocks.taskService.getTaskById.mockResolvedValue({ id: 'task-1' })
    mocks.taskService.deleteTask.mockResolvedValue(true)
    mocks.taskService.deleteTaskById.mockResolvedValue(true)
    mocks.channelService.getChannel.mockResolvedValue({ id: 'channel-1' })
    mocks.channelService.deleteChannel.mockResolvedValue(true)

    await expect(deleteAgentWithStorageV2Recovery('agent-1')).resolves.toBe(true)
    await expect(deleteSessionWithStorageV2Recovery('agent-1', 'session-1')).resolves.toBe(true)
    await expect(deleteAgentSessionMessageWithStorageV2Recovery('session-1', 1)).resolves.toBe(true)
    await expect(deleteTaskWithStorageV2Recovery('agent-1', 'task-1')).resolves.toBe(true)
    await expect(deleteTaskByIdWithStorageV2Recovery('task-1')).resolves.toBe(true)
    await expect(deleteChannelWithStorageV2Recovery('channel-1')).resolves.toBe(true)

    expect(mocks.mirror.schedule).not.toHaveBeenCalled()
    expect(mocks.mirror.flush).not.toHaveBeenCalled()
    expect(mocks.mirror.flushStrict).toHaveBeenCalledTimes(6)
    expect(mocks.tombstone.tombstoneAgent).toHaveBeenCalledWith('agent-1')
    expect(mocks.tombstone.tombstoneSession).toHaveBeenCalledWith('session-1')
    expect(mocks.tombstone.tombstoneSessionMessage).toHaveBeenCalledWith(1)
    expect(mocks.tombstone.tombstoneTask).toHaveBeenCalledTimes(2)
    expect(mocks.tombstone.tombstoneChannel).toHaveBeenCalledWith('channel-1')
  })

  it('tombstones Storage v2 rows before deleting agent messages by payload id', async () => {
    const rows = [
      { id: 11, content: JSON.stringify({ message: { id: 'message-1' } }) },
      { id: 12, content: JSON.stringify({ message: { id: 'message-2' } }) }
    ]
    vi.mocked(agentMessageRepository.findRowsByPayloadMessageIds).mockResolvedValue(rows as any)
    vi.mocked(agentMessageRepository.deleteRowsByIds).mockResolvedValue([11, 12])

    await expect(
      deleteAgentSessionMessagesByPayloadIdsWithStorageV2Recovery('session-1', ['message-1', 'message-2'])
    ).resolves.toEqual(['message-1', 'message-2'])

    expect(mocks.tombstone.tombstoneSessionMessage).toHaveBeenCalledWith(11)
    expect(mocks.tombstone.tombstoneSessionMessage).toHaveBeenCalledWith(12)
    expect(agentMessageRepository.deleteRowsByIds).toHaveBeenCalledWith('session-1', [11, 12])
    expect(mocks.tombstone.tombstoneSessionMessage.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(agentMessageRepository.deleteRowsByIds).mock.invocationCallOrder[0]
    )
    expect(mocks.mirror.flushStrict).toHaveBeenCalledTimes(1)
  })

  it('tombstones Storage v2 rows before clearing an agent session history', async () => {
    const rows = [
      { id: 21, content: JSON.stringify({ message: { id: 'message-1' } }) },
      { id: 22, content: JSON.stringify({ message: { id: 'message-2' } }) }
    ]
    vi.mocked(agentMessageRepository.listRowsForSession).mockResolvedValue(rows as any)
    vi.mocked(agentMessageRepository.deleteRowsByIds).mockResolvedValue([21, 22])

    await expect(clearAgentSessionMessagesWithStorageV2Recovery('session-1')).resolves.toBe(2)

    expect(mocks.tombstone.tombstoneSessionMessage).toHaveBeenCalledWith(21)
    expect(mocks.tombstone.tombstoneSessionMessage).toHaveBeenCalledWith(22)
    expect(agentMessageRepository.deleteRowsByIds).toHaveBeenCalledWith('session-1', [21, 22])
    expect(mocks.mirror.flushStrict).toHaveBeenCalledTimes(1)
  })

  it('flushes the Storage v2 agent mirror after low-frequency successful writes', async () => {
    mocks.agentService.createAgent.mockResolvedValue({ id: 'agent-1' })
    mocks.agentService.updateAgent.mockResolvedValue({ id: 'agent-1' })
    mocks.agentService.reorderAgents.mockResolvedValue(undefined)
    mocks.sessionService.createSession.mockResolvedValue({ id: 'session-1' })
    mocks.sessionService.updateSession.mockResolvedValue({ id: 'session-1' })
    mocks.sessionService.reorderSessions.mockResolvedValue(undefined)
    mocks.taskService.createTask.mockResolvedValue({ id: 'task-1' })
    mocks.taskService.updateTask.mockResolvedValue({ id: 'task-1' })
    mocks.taskService.updateTaskById.mockResolvedValue({ id: 'task-1' })
    mocks.taskService.updateTaskAfterRun.mockResolvedValue(undefined)
    mocks.taskService.logTaskRun.mockResolvedValue(42)
    mocks.taskService.updateTaskRunLog.mockResolvedValue(undefined)
    mocks.channelService.createChannel.mockResolvedValue({ id: 'channel-1' })
    mocks.channelService.updateChannel.mockResolvedValue({ id: 'channel-1' })

    await expect(createAgentWithStorageV2Recovery({ name: 'Agent' } as any)).resolves.toEqual({ id: 'agent-1' })
    await expect(updateAgentWithStorageV2Recovery('agent-1', {} as any)).resolves.toEqual({ id: 'agent-1' })
    await expect(reorderAgentsWithStorageV2Recovery(['agent-1'])).resolves.toBeUndefined()
    await expect(createSessionWithStorageV2Recovery('agent-1', {})).resolves.toEqual({ id: 'session-1' })
    await expect(updateSessionWithStorageV2Recovery('agent-1', 'session-1', {} as any)).resolves.toEqual({
      id: 'session-1'
    })
    await expect(reorderSessionsWithStorageV2Recovery('agent-1', ['session-1'])).resolves.toBeUndefined()
    await expect(createTaskWithStorageV2Recovery('agent-1', {} as any)).resolves.toEqual({ id: 'task-1' })
    await expect(updateTaskWithStorageV2Recovery('agent-1', 'task-1', {} as any)).resolves.toEqual({ id: 'task-1' })
    await expect(updateTaskByIdWithStorageV2Recovery('task-1', {} as any)).resolves.toEqual({ id: 'task-1' })
    await expect(updateTaskAfterRunWithStorageV2Recovery('task-1', null, 'Completed')).resolves.toBeUndefined()
    await expect(logTaskRunWithStorageV2Recovery({ task_id: 'task-1' } as any)).resolves.toBe(42)
    await expect(updateTaskRunLogWithStorageV2Recovery(42, { status: 'success' })).resolves.toBeUndefined()
    await expect(createChannelWithStorageV2Recovery({ agentId: 'agent-1' } as any)).resolves.toEqual({
      id: 'channel-1'
    })
    await expect(updateChannelWithStorageV2Recovery('channel-1', {} as any)).resolves.toEqual({ id: 'channel-1' })

    expect(mocks.mirror.schedule).toHaveBeenCalledTimes(14)
    expect(mocks.mirror.schedule).toHaveBeenCalledWith(0)
    expect(mocks.mirror.flush).toHaveBeenCalledTimes(14)
  })

  it('does not flush when a write target is absent from both runtimes', async () => {
    mocks.agentService.updateAgent.mockResolvedValue(null)
    mocks.recovery.projectIfAgentMissing.mockResolvedValue(false)

    await expect(updateAgentWithStorageV2Recovery('agent-1', {} as any)).resolves.toBeNull()

    expect(mocks.mirror.schedule).not.toHaveBeenCalled()
    expect(mocks.mirror.flush).not.toHaveBeenCalled()
  })

  it('recovers from Storage v2 before deleting a missing session and then flushes the tombstone', async () => {
    mocks.sessionService.getSession.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'session-1' })
    mocks.sessionService.deleteSession.mockResolvedValueOnce(true)
    mocks.recovery.projectIfSessionMissing.mockResolvedValueOnce(true)

    await expect(deleteSessionWithStorageV2Recovery('agent-1', 'session-1')).resolves.toBe(true)

    expect(mocks.recovery.projectIfSessionMissing).toHaveBeenCalledWith(
      'agent-1',
      'session-1',
      'agent-session-delete-missing'
    )
    expect(mocks.sessionService.getSession).toHaveBeenCalledTimes(2)
    expect(mocks.sessionService.deleteSession).toHaveBeenCalledTimes(1)
    expect(mocks.mirror.schedule).not.toHaveBeenCalled()
    expect(mocks.mirror.flush).not.toHaveBeenCalled()
    expect(mocks.mirror.flushStrict).toHaveBeenCalledTimes(1)
    expect(mocks.tombstone.tombstoneSession).toHaveBeenCalledWith('session-1')
  })

  it('does not flush when the delete target is absent from both runtimes', async () => {
    mocks.channelService.getChannel.mockResolvedValue(null)
    mocks.recovery.projectIfChannelMissing.mockResolvedValue(false)

    await expect(deleteChannelWithStorageV2Recovery('channel-1')).resolves.toBe(false)

    expect(mocks.channelService.deleteChannel).not.toHaveBeenCalled()
    expect(mocks.mirror.schedule).not.toHaveBeenCalled()
    expect(mocks.mirror.flush).not.toHaveBeenCalled()
    expect(mocks.mirror.flushStrict).not.toHaveBeenCalled()
    expect(mocks.tombstone.tombstoneChannel).not.toHaveBeenCalled()
  })

  it('surfaces strict Storage v2 mirror failures after destructive deletes', async () => {
    const error = new Error('storage unavailable')
    mocks.sessionService.getSession.mockResolvedValue({ id: 'session-1' })
    mocks.sessionService.deleteSession.mockResolvedValue(true)
    mocks.mirror.flushStrict.mockRejectedValueOnce(error)

    await expect(deleteSessionWithStorageV2Recovery('agent-1', 'session-1')).rejects.toThrow('storage unavailable')

    expect(mocks.sessionService.deleteSession).toHaveBeenCalledTimes(1)
    expect(mocks.tombstone.tombstoneSession).toHaveBeenCalledWith('session-1')
    expect(mocks.mirror.flushStrict).toHaveBeenCalledTimes(1)
  })

  it('does not delete legacy runtime rows when the Storage v2 tombstone fails first', async () => {
    const error = new Error('storage unavailable')
    mocks.taskService.getTask.mockResolvedValue({ id: 'task-1' })
    mocks.tombstone.tombstoneTask.mockRejectedValueOnce(error)

    await expect(deleteTaskWithStorageV2Recovery('agent-1', 'task-1')).rejects.toThrow('storage unavailable')

    expect(mocks.taskService.deleteTask).not.toHaveBeenCalled()
    expect(mocks.mirror.flushStrict).not.toHaveBeenCalled()
  })

  it('flushes the Storage v2 agent mirror after persisting a message exchange', async () => {
    const result = { userMessageId: 1, assistantMessageId: 2 }
    vi.mocked(agentMessageRepository.persistExchange).mockResolvedValue(result as any)

    await expect(
      persistAgentMessageExchangeWithStorageV2Recovery({
        sessionId: 'session-1',
        agentSessionId: 'sdk-session-1',
        user: { payload: {}, createdAt: '2026-05-28T00:00:00.000Z' },
        assistant: { payload: {}, createdAt: '2026-05-28T00:00:01.000Z' }
      } as any)
    ).resolves.toBe(result)

    expect(agentMessageRepository.persistExchange).toHaveBeenCalledTimes(1)
    expect(mocks.mirror.schedule).toHaveBeenCalledWith(0)
    expect(mocks.mirror.flush).toHaveBeenCalledTimes(1)
  })

  it('flushes the Storage v2 agent mirror after recovering and retrying message persistence', async () => {
    const result = { userMessageId: 1, assistantMessageId: 2 }
    vi.mocked(agentMessageRepository.persistExchange)
      .mockRejectedValueOnce(new Error('foreign key constraint failed for session'))
      .mockResolvedValueOnce(result as any)
    mocks.recovery.projectIfSessionMissingById.mockResolvedValueOnce(true)

    await expect(
      persistAgentMessageExchangeWithStorageV2Recovery({
        sessionId: 'session-1',
        agentSessionId: 'sdk-session-1',
        user: { payload: {}, createdAt: '2026-05-28T00:00:00.000Z' },
        assistant: { payload: {}, createdAt: '2026-05-28T00:00:01.000Z' }
      } as any)
    ).resolves.toBe(result)

    expect(mocks.recovery.projectIfSessionMissingById).toHaveBeenCalledWith(
      'session-1',
      'agent-message-persist-missing-session'
    )
    expect(agentMessageRepository.persistExchange).toHaveBeenCalledTimes(2)
    expect(mocks.mirror.schedule).toHaveBeenCalledWith(0)
    expect(mocks.mirror.flush).toHaveBeenCalledTimes(1)
  })
})
