import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  client: {
    execute: vi.fn()
  },
  secretVault: {
    isAvailable: vi.fn(),
    setSecret: vi.fn()
  },
  recordChange: vi.fn(),
  withTransaction: vi.fn(async (_client: unknown, fn: () => Promise<void>) => fn())
}))

vi.mock('../StorageV2Database', () => ({
  storageV2Database: {
    getClient: vi.fn(async () => mocks.client),
    withTransaction: mocks.withTransaction
  }
}))

vi.mock('../SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.secretVault
}))

vi.mock('../SyncLogService', () => ({
  storageV2SyncLogService: {
    recordChange: mocks.recordChange
  }
}))

import { StorageV2AgentRuntimeWriteService } from '../AgentRuntimeWriteService'

describe('StorageV2AgentRuntimeWriteService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.client.execute.mockResolvedValue({ rows: [{ version: 3 }], columns: [], columnTypes: [] })
    mocks.secretVault.isAvailable.mockReturnValue(true)
    mocks.secretVault.setSecret.mockResolvedValue('storage-v2://secret/channel/channel-1/bot_token')
  })

  it('upserts agents through Storage v2 and records sync metadata', async () => {
    await new StorageV2AgentRuntimeWriteService().upsertAgent({
      id: 'agent-1',
      type: 'claude-code',
      name: 'Agent',
      description: 'Helpful agent',
      instructions: 'Be useful',
      model: 'openai:gpt-4o',
      plan_model: null,
      small_model: null,
      accessible_paths: ['/tmp/agent-1'],
      mcps: ['filesystem'],
      allowed_tools: ['Read'],
      configuration: { permission_mode: 'plan' },
      sort_order: 2,
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:01.000Z'
    })

    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO agents'),
        args: expect.arrayContaining([
          'agent-1',
          'claude-code',
          'Agent',
          'Helpful agent',
          'Be useful',
          'openai:gpt-4o',
          JSON.stringify(['/tmp/agent-1']),
          JSON.stringify(['filesystem']),
          JSON.stringify(['Read']),
          JSON.stringify({ permission_mode: 'plan' }),
          2,
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T00:00:01.000Z'
        ])
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'agent',
        entityId: 'agent-1',
        payload: expect.objectContaining({
          id: 'agent-1',
          type: 'claude-code',
          name: 'Agent'
        }),
        version: 3
      })
    )
  })

  it('upserts agent sessions and their Storage v2 conversation metadata', async () => {
    await new StorageV2AgentRuntimeWriteService().upsertAgentSession({
      id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'claude-code',
      name: 'Session',
      description: 'Working session',
      accessible_paths: JSON.stringify(['/tmp/session-1']),
      instructions: 'Keep going',
      model: 'openai:gpt-4o',
      plan_model: null,
      small_model: null,
      mcps: JSON.stringify(['filesystem']),
      allowed_tools: JSON.stringify(['Read']),
      slash_commands: JSON.stringify([{ command: '/test', description: 'Test' }]),
      configuration: JSON.stringify({ permission_mode: 'plan' }),
      sort_order: 0,
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:01.000Z'
    })

    const sessionUpsertCall = mocks.client.execute.mock.calls.find(([arg]) => {
      return typeof arg === 'object' && String(arg.sql).includes('INSERT INTO agent_sessions')
    })
    expect(sessionUpsertCall).toBeTruthy()

    const sessionArgs = sessionUpsertCall?.[0].args as unknown[]
    expect(sessionArgs).toEqual(
      expect.arrayContaining([
        'session-1',
        'agent-1',
        'Session',
        JSON.stringify({ permission_mode: 'plan' }),
        0,
        '2026-05-29T00:00:00.000Z',
        '2026-05-29T00:00:01.000Z'
      ])
    )
    expect(JSON.parse(sessionArgs[4] as string)).toEqual(
      expect.objectContaining({
        agentType: 'claude-code',
        accessiblePaths: ['/tmp/session-1'],
        mcps: ['filesystem'],
        allowedTools: ['Read'],
        slashCommands: [{ command: '/test', description: 'Test' }],
        configuration: { permission_mode: 'plan' }
      })
    )
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO conversations'),
        args: expect.arrayContaining(['agent-session:session-1', 'agent-1', 'session-1', 'Session'])
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'agent_session',
        entityId: 'session-1',
        version: 3
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'conversation',
        entityId: 'agent-session:session-1',
        version: 3
      })
    )
  })

  it('upserts channels through Storage v2 and moves credentials into the secret vault first', async () => {
    await new StorageV2AgentRuntimeWriteService().upsertChannel({
      id: 'channel-1',
      type: 'telegram',
      name: 'Telegram',
      agentId: 'agent-1',
      sessionId: 'session-1',
      config: {
        type: 'telegram',
        bot_token: 'secret-token',
        allowed_chat_ids: ['chat-1']
      },
      isActive: true,
      activeChatIds: ['chat-1'],
      permissionMode: 'default',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_001_000
    })

    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith('channel', 'channel-1', 'bot_token', 'secret-token')

    const upsertCall = mocks.client.execute.mock.calls.find(([arg]) => {
      return typeof arg === 'object' && String(arg.sql).includes('INSERT INTO channels')
    })
    expect(upsertCall).toBeTruthy()

    const args = upsertCall?.[0].args as unknown[]
    const storedConfig = JSON.parse(args[5] as string)
    expect(storedConfig).toEqual({
      type: 'telegram',
      allowed_chat_ids: ['chat-1'],
      bot_token_secret_ref: 'storage-v2://secret/channel/channel-1/bot_token'
    })
    expect(storedConfig.bot_token).toBeUndefined()
    expect(args).toEqual(
      expect.arrayContaining([
        'channel-1',
        'telegram',
        'Telegram',
        'agent-1',
        'session-1',
        'default',
        '2027-01-15T08:00:00.000Z',
        '2027-01-15T08:00:01.000Z'
      ])
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'channel',
        entityId: 'channel-1',
        payload: expect.objectContaining({
          id: 'channel-1',
          agentId: 'agent-1',
          sessionId: 'session-1'
        }),
        version: 3
      })
    )
  })

  it('upserts scheduled tasks and syncs channel subscriptions through Storage v2 first', async () => {
    mocks.client.execute
      .mockResolvedValueOnce({ rows: [], columns: [], columnTypes: [] })
      .mockResolvedValueOnce({ rows: [{ version: 7 }], columns: [], columnTypes: [] })
      .mockResolvedValueOnce({ rows: [{ channel_id: 'channel-old' }], columns: [], columnTypes: [] })
      .mockResolvedValue({ rows: [], columns: [], columnTypes: [] })

    await new StorageV2AgentRuntimeWriteService().upsertScheduledTask(
      {
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
        created_at: '2026-05-29T00:00:00.000Z',
        updated_at: '2026-05-29T00:00:01.000Z'
      },
      ['channel-1', 'channel-1', 'channel-2']
    )

    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO scheduled_tasks'),
        args: expect.arrayContaining([
          'task-1',
          'agent-1',
          'Daily check',
          'Check status',
          'interval',
          '30',
          5,
          '2026-05-29T01:00:00.000Z',
          'active'
        ])
      })
    )
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('DELETE FROM channel_task_subscriptions'),
        args: ['task-1', 'channel-1', 'channel-2']
      })
    )
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO channel_task_subscriptions'),
        args: ['channel-1', 'task-1', '2026-05-29T00:00:01.000Z', '2026-05-29T00:00:01.000Z']
      })
    )
    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO channel_task_subscriptions'),
        args: ['channel-2', 'task-1', '2026-05-29T00:00:01.000Z', '2026-05-29T00:00:01.000Z']
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'scheduled_task',
        entityId: 'task-1',
        version: 7
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'channel_task_subscription',
        entityId: 'channel-old:task-1',
        operation: 'delete'
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'channel_task_subscription',
        entityId: 'channel-1:task-1'
      })
    )
  })

  it('creates task run logs through Storage v2 and returns the generated id', async () => {
    mocks.client.execute
      .mockResolvedValueOnce({ rows: [], columns: [], columnTypes: [], lastInsertRowid: 42n })
      .mockResolvedValueOnce({ rows: [{ version: 5 }], columns: [], columnTypes: [] })

    await expect(
      new StorageV2AgentRuntimeWriteService().createTaskRunLog({
        task_id: 'task-1',
        session_id: null,
        run_at: '2026-05-29T00:00:00.000Z',
        duration_ms: 0,
        status: 'running',
        result: null,
        error: null
      })
    ).resolves.toBe(42)

    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO task_run_logs'),
        args: ['task-1', null, '2026-05-29T00:00:00.000Z', 0, 'running', JSON.stringify(null), null]
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'task_run_log',
        entityId: '42',
        payload: expect.objectContaining({
          id: 42,
          taskId: 'task-1',
          status: 'running'
        }),
        version: 5
      })
    )
  })

  it('updates task run logs through Storage v2 before legacy cache updates', async () => {
    mocks.client.execute
      .mockResolvedValueOnce({ rows: [], columns: [], columnTypes: [], rowsAffected: 1 })
      .mockResolvedValueOnce({ rows: [{ version: 6 }], columns: [], columnTypes: [] })

    await new StorageV2AgentRuntimeWriteService().updateTaskRunLog(42, {
      session_id: 'session-1',
      duration_ms: 123,
      status: 'success',
      result: 'Completed',
      error: null
    })

    expect(mocks.client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('UPDATE task_run_logs'),
        args: ['session-1', 123, 'success', JSON.stringify('Completed'), null, 42]
      })
    )
    expect(mocks.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'task_run_log',
        entityId: '42',
        payload: expect.objectContaining({
          id: 42,
          status: 'success',
          sessionId: 'session-1'
        }),
        version: 6
      })
    )
  })

  it('does not persist plaintext channel secrets when safeStorage is unavailable', async () => {
    mocks.secretVault.isAvailable.mockReturnValue(false)

    await new StorageV2AgentRuntimeWriteService().upsertChannel({
      id: 'channel-1',
      type: 'slack',
      name: 'Slack',
      agentId: null,
      sessionId: null,
      config: {
        type: 'slack',
        bot_token: '',
        app_token: 'xapp-secret',
        allowed_channel_ids: []
      },
      isActive: false,
      activeChatIds: [],
      permissionMode: null
    })

    expect(mocks.secretVault.setSecret).not.toHaveBeenCalled()

    const upsertCall = mocks.client.execute.mock.calls.find(([arg]) => {
      return typeof arg === 'object' && String(arg.sql).includes('INSERT INTO channels')
    })
    const args = upsertCall?.[0].args as unknown[]
    const storedConfig = JSON.parse(args[5] as string)
    expect(storedConfig).toEqual({
      type: 'slack',
      bot_token: '',
      allowed_channel_ids: [],
      app_token_secret_unmigrated: true
    })
    expect(storedConfig.app_token).toBeUndefined()
    expect(args[6]).toBe(0)
  })
})
