import { validateModelId } from '@main/apiServer/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockTombstoneSession, mockUpsertAgentSession } = vi.hoisted(() => ({
  mockTombstoneSession: vi.fn(),
  mockUpsertAgentSession: vi.fn()
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
  storageV2AgentRuntimeWriteService: {
    upsertAgentSession: mockUpsertAgentSession
  }
}))

vi.mock('@main/services/storageV2/AgentRuntimeTombstoneService', () => ({
  storageV2AgentRuntimeTombstoneService: {
    tombstoneSession: mockTombstoneSession
  }
}))

import { SessionService } from '../SessionService'

function createSelectQuery(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows)
      }))
    }))
  }
}

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    agent_id: 'agent-1',
    agent_type: 'claude-code',
    name: 'Session',
    description: null,
    accessible_paths: JSON.stringify(['/tmp/agent-1']),
    instructions: 'Instructions',
    model: 'openai:gpt-4o',
    plan_model: null,
    small_model: null,
    mcps: JSON.stringify([]),
    allowed_tools: JSON.stringify([]),
    slash_commands: JSON.stringify([{ command: '/test', description: 'Test' }]),
    configuration: JSON.stringify({ permission_mode: 'plan' }),
    sort_order: 0,
    created_at: '2026-05-29T00:00:00.000Z',
    updated_at: '2026-05-29T00:00:00.000Z',
    ...overrides
  }
}

describe('SessionService Storage v2-first writes', () => {
  const service = SessionService.getInstance()

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpsertAgentSession.mockResolvedValue(undefined)
    mockTombstoneSession.mockResolvedValue(undefined)
    vi.mocked(validateModelId).mockResolvedValue({
      valid: true,
      provider: {
        id: 'openai',
        apiKey: 'key'
      }
    } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('upserts Storage v2 before inserting a legacy session row', async () => {
    const agentRow = {
      id: 'agent-1',
      type: 'claude-code',
      name: 'Agent',
      description: null,
      accessible_paths: JSON.stringify(['/tmp/agent-1']),
      instructions: 'Agent instructions',
      model: 'openai:gpt-4o',
      plan_model: null,
      small_model: null,
      mcps: JSON.stringify([]),
      allowed_tools: JSON.stringify([]),
      configuration: JSON.stringify({ permission_mode: 'plan' }),
      sort_order: 0,
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:00.000Z',
      deleted_at: null
    }
    const sessionRow = createSessionRow({ id: 'session-created' })
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const txUpdateSet = vi.fn(() => ({ where: updateWhere }))
    const txUpdate = vi.fn(() => ({ set: txUpdateSet }))
    const txInsertValues = vi.fn().mockResolvedValue(undefined)
    const txInsert = vi.fn(() => ({ values: txInsertValues }))
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({ update: txUpdate, insert: txInsert })
    )
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(createSelectQuery([agentRow]))
        .mockReturnValueOnce(createSelectQuery([sessionRow]))
        .mockReturnValueOnce(createSelectQuery([sessionRow])),
      transaction
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service as any, 'ensurePathsExist').mockReturnValue(['/tmp/agent-1'])

    await expect(service.createSession('agent-1')).resolves.toEqual(
      expect.objectContaining({ id: 'session-created', accessible_paths: ['/tmp/agent-1'] })
    )

    expect(mockUpsertAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'agent-1',
        agent_type: 'claude-code',
        name: 'Agent',
        model: 'openai:gpt-4o',
        sort_order: 0
      }),
      { shiftExistingForAgent: true }
    )
    expect(mockUpsertAgentSession.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder[0])
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'agent-1' }))
  })

  it('does not insert a legacy session row when the Storage v2 first write fails', async () => {
    const database = {
      select: vi.fn().mockReturnValueOnce(
        createSelectQuery([
          {
            id: 'agent-1',
            type: 'claude-code',
            name: 'Agent',
            accessible_paths: JSON.stringify(['/tmp/agent-1']),
            model: 'openai:gpt-4o',
            deleted_at: null
          }
        ])
      ),
      transaction: vi.fn()
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service as any, 'ensurePathsExist').mockReturnValue(['/tmp/agent-1'])
    mockUpsertAgentSession.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(service.createSession('agent-1')).rejects.toThrow('storage unavailable')

    expect(database.transaction).not.toHaveBeenCalled()
  })

  it('upserts Storage v2 before updating a legacy session row', async () => {
    const existingRow = createSessionRow()
    const updatedRow = createSessionRow({
      name: 'Updated session',
      updated_at: '2026-05-29T00:00:01.000Z'
    })
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const updateSet = vi.fn(() => ({ where: updateWhere }))
    const update = vi.fn(() => ({ set: updateSet }))
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(createSelectQuery([existingRow]))
        .mockReturnValueOnce(createSelectQuery([existingRow]))
        .mockReturnValueOnce(createSelectQuery([updatedRow])),
      update
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)

    await expect(service.updateSession('agent-1', 'session-1', { name: 'Updated session' })).resolves.toEqual(
      expect.objectContaining({ id: 'session-1', name: 'Updated session' })
    )

    expect(mockUpsertAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        agent_id: 'agent-1',
        name: 'Updated session'
      })
    )
    expect(mockUpsertAgentSession.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0])
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ name: 'Updated session' }))
  })

  it('tombstones Storage v2 before deleting a legacy session row', async () => {
    const deleteWhere = vi.fn().mockResolvedValue({ rowsAffected: 1 })
    const legacyDelete = vi.fn(() => ({ where: deleteWhere }))
    const database = {
      delete: legacyDelete
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)

    await expect(service.deleteSession('agent-1', 'session-1')).resolves.toBe(true)

    expect(mockTombstoneSession).toHaveBeenCalledWith('session-1')
    expect(mockTombstoneSession.mock.invocationCallOrder[0]).toBeLessThan(legacyDelete.mock.invocationCallOrder[0])
  })
})
