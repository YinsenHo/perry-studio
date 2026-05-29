import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storageWrite: {
    upsertScheduledTask: vi.fn()
  },
  tombstone: {
    tombstoneTask: vi.fn()
  }
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

import { TaskService } from '../TaskService'

const makeTask = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'task-1',
    agent_id: 'agent-1',
    name: 'Daily check',
    prompt: 'Check status',
    schedule_type: 'interval',
    schedule_value: '30',
    timeout_minutes: 5,
    next_run: '2026-05-29T01:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    channel_ids: ['channel-1'],
    created_at: '2026-05-29T00:00:00.000Z',
    updated_at: '2026-05-29T00:00:00.000Z',
    ...overrides
  }) as any

describe('TaskService Storage v2 first writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storageWrite.upsertScheduledTask.mockResolvedValue(undefined)
    mocks.tombstone.tombstoneTask.mockResolvedValue(undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('upserts Storage v2 before inserting a legacy scheduled task row', async () => {
    const taskValues = vi.fn().mockResolvedValue(undefined)
    const subscriptionOnConflict = vi.fn().mockResolvedValue(undefined)
    const subscriptionValues = vi.fn(() => ({ onConflictDoNothing: subscriptionOnConflict }))
    const insert = vi
      .fn()
      .mockReturnValueOnce({ values: taskValues })
      .mockReturnValueOnce({ values: subscriptionValues })
    const database = { insert }
    const service = new TaskService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service as any, 'getTaskWithChannels').mockResolvedValue(makeTask())

    await expect(
      service.createTask('agent-1', {
        name: 'Daily check',
        prompt: 'Check status',
        schedule_type: 'interval',
        schedule_value: '30',
        timeout_minutes: 5,
        channel_ids: ['channel-1']
      })
    ).resolves.toEqual(makeTask())

    expect(mocks.storageWrite.upsertScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'agent-1',
        name: 'Daily check',
        prompt: 'Check status',
        schedule_type: 'interval',
        schedule_value: '30',
        timeout_minutes: 5,
        status: 'active'
      }),
      ['channel-1']
    )
    expect(mocks.storageWrite.upsertScheduledTask.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]
    )
    expect(subscriptionValues).toHaveBeenCalledWith([{ channelId: 'channel-1', taskId: expect.any(String) }])
  })

  it('does not insert a legacy task row when the Storage v2 first write fails', async () => {
    const insert = vi.fn()
    const service = new TaskService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue({ insert } as never)
    mocks.storageWrite.upsertScheduledTask.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(
      service.createTask('agent-1', {
        name: 'Daily check',
        prompt: 'Check status',
        schedule_type: 'interval',
        schedule_value: '30'
      })
    ).rejects.toThrow('storage unavailable')

    expect(insert).not.toHaveBeenCalled()
  })

  it('upserts Storage v2 before updating a legacy task row and its channel subscriptions', async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn(() => ({ where }))
    const update = vi.fn(() => ({ set }))
    const database = { update }
    const service = new TaskService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service, 'getTask').mockResolvedValue(makeTask())
    vi.spyOn(service as any, 'getTaskWithChannels').mockResolvedValue(makeTask({ name: 'Updated task' }))
    vi.spyOn(service as any, 'syncTaskChannels').mockResolvedValue(undefined)

    await expect(
      service.updateTask('agent-1', 'task-1', {
        name: 'Updated task',
        channel_ids: ['channel-2']
      })
    ).resolves.toEqual(makeTask({ name: 'Updated task' }))

    expect(mocks.storageWrite.upsertScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        name: 'Updated task'
      }),
      ['channel-2']
    )
    expect(mocks.storageWrite.upsertScheduledTask.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]
    )
  })

  it('upserts Storage v2 before updating task run state in the legacy cache', async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn(() => ({ where }))
    const update = vi.fn(() => ({ set }))
    const database = { update }
    const service = new TaskService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service, 'getTaskById').mockResolvedValue(makeTask())

    await expect(service.updateTaskAfterRun('task-1', null, 'Completed')).resolves.toBeUndefined()

    expect(mocks.storageWrite.upsertScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        next_run: null,
        last_result: 'Completed',
        status: 'completed'
      })
    )
    expect(mocks.storageWrite.upsertScheduledTask.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]
    )
  })

  it('tombstones Storage v2 before deleting a legacy task row directly', async () => {
    const where = vi.fn().mockResolvedValue({ rowsAffected: 1 })
    const deleteFrom = vi.fn(() => ({ where }))
    const database = { delete: deleteFrom }
    const service = new TaskService()
    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service, 'getTask').mockResolvedValue(makeTask())

    await expect(service.deleteTask('agent-1', 'task-1')).resolves.toBe(true)

    expect(mocks.tombstone.tombstoneTask).toHaveBeenCalledWith('task-1')
    expect(mocks.tombstone.tombstoneTask.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFrom.mock.invocationCallOrder[0]
    )
  })
})
