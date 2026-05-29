import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetModels, mockInitSkillsForAgent, mockTombstoneAgent, mockUpsertAgent } = vi.hoisted(() => ({
  mockGetModels: vi.fn(),
  mockInitSkillsForAgent: vi.fn(),
  mockTombstoneAgent: vi.fn(),
  mockUpsertAgent: vi.fn()
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

vi.mock('@main/apiServer/services/models', () => ({
  modelsService: {
    getModels: mockGetModels
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

vi.mock('../../skills/SkillService', () => ({
  skillService: {
    initSkillsForAgent: mockInitSkillsForAgent
  }
}))

vi.mock('@main/services/storageV2/AgentRuntimeWriteService', () => ({
  storageV2AgentRuntimeWriteService: {
    upsertAgent: mockUpsertAgent
  }
}))

vi.mock('@main/services/storageV2/AgentRuntimeTombstoneService', () => ({
  storageV2AgentRuntimeTombstoneService: {
    tombstoneAgent: mockTombstoneAgent
  }
}))

import { validateModelId } from '@main/apiServer/utils'

import { AgentService } from '../AgentService'

function createSelectQuery(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows)
      }))
    }))
  }
}

function createWhereQuery(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(rows)
    }))
  }
}

describe('AgentService built-in agent lifecycle', () => {
  const service = AgentService.getInstance()

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpsertAgent.mockResolvedValue(undefined)
    mockTombstoneAgent.mockResolvedValue(undefined)
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

  it('skips recreating a built-in agent that was soft-deleted by the user', async () => {
    const database = {
      select: vi.fn(() =>
        createSelectQuery([{ id: 'cherry-assistant-default', deleted_at: '2026-04-15T00:00:00.000Z' }])
      )
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)

    const result = await service.initBuiltinAgent({
      id: 'cherry-assistant-default',
      builtinRole: 'assistant',
      provisionWorkspace: vi.fn()
    })

    expect(result).toEqual({ agentId: null, skippedReason: 'deleted' })
    expect(mockGetModels).not.toHaveBeenCalled()
  })

  it('upserts Storage v2 before inserting a legacy agent row', async () => {
    const agentRow = {
      id: 'agent-created',
      type: 'claude-code',
      name: 'Agent',
      description: undefined,
      instructions: 'Instructions',
      model: 'openai:gpt-4o',
      plan_model: undefined,
      small_model: undefined,
      accessible_paths: JSON.stringify(['/tmp/agent-created']),
      mcps: undefined,
      allowed_tools: undefined,
      configuration: undefined,
      sort_order: -1,
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:00.000Z'
    }
    const values = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn(() => ({ values }))
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(createWhereQuery([{ min: 0 }]))
        .mockReturnValueOnce(createSelectQuery([agentRow])),
      insert
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service as any, 'resolveAccessiblePaths').mockReturnValue(['/tmp/agent-created'])

    await expect(
      service.createAgent({
        type: 'claude-code',
        name: 'Agent',
        instructions: 'Instructions',
        model: 'openai:gpt-4o',
        accessible_paths: []
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'agent-created', accessible_paths: ['/tmp/agent-created'] }))

    expect(mockUpsertAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'claude-code',
        name: 'Agent',
        model: 'openai:gpt-4o',
        accessible_paths: JSON.stringify(['/tmp/agent-created']),
        sort_order: -1
      })
    )
    expect(mockUpsertAgent.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0])
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ sort_order: -1 }))
  })

  it('does not insert a legacy agent row when the Storage v2 first write fails', async () => {
    const insert = vi.fn()
    const database = {
      select: vi.fn().mockReturnValueOnce(createWhereQuery([{ min: 0 }])),
      insert
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)
    vi.spyOn(service as any, 'resolveAccessiblePaths').mockReturnValue(['/tmp/agent-created'])
    mockUpsertAgent.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(
      service.createAgent({
        type: 'claude-code',
        name: 'Agent',
        model: 'openai:gpt-4o',
        accessible_paths: []
      })
    ).rejects.toThrow('storage unavailable')

    expect(insert).not.toHaveBeenCalled()
  })

  it('soft-deletes built-in agents while preserving the row', async () => {
    const deleteWhere = vi.fn().mockResolvedValue({ rowsAffected: 1 })
    const txDelete = vi.fn(() => ({ where: deleteWhere }))
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const txUpdateSet = vi.fn(() => ({ where: updateWhere }))
    const txUpdate = vi.fn(() => ({ set: txUpdateSet }))
    const database = {
      select: vi.fn(() => createSelectQuery([{ id: 'cherry-claw-default', deleted_at: null }])),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({ delete: txDelete, update: txUpdate })
      ),
      delete: vi.fn(() => ({ where: deleteWhere }))
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)

    const deleted = await service.deleteAgent('cherry-claw-default')

    expect(deleted).toBe(true)
    expect(mockTombstoneAgent).toHaveBeenCalledWith('cherry-claw-default')
    expect(mockTombstoneAgent.mock.invocationCallOrder[0]).toBeLessThan(
      database.transaction.mock.invocationCallOrder[0]
    )
    expect(database.transaction).toHaveBeenCalledTimes(1)
    expect(txDelete).toHaveBeenCalledTimes(3)
    expect(txUpdate).toHaveBeenCalledTimes(2)
    expect(database.delete).not.toHaveBeenCalled()
    expect(txUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }))
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        deleted_at: expect.any(String),
        updated_at: expect.any(String)
      })
    )
  })

  it('soft-deletes user-created agents so Storage v2 recovery cannot resurrect them', async () => {
    const deleteWhere = vi.fn().mockResolvedValue({ rowsAffected: 1 })
    const txDelete = vi.fn(() => ({ where: deleteWhere }))
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const txUpdateSet = vi.fn(() => ({ where: updateWhere }))
    const txUpdate = vi.fn(() => ({ set: txUpdateSet }))
    const database = {
      select: vi.fn(() => createSelectQuery([{ id: 'agent-user-1', deleted_at: null }])),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({ delete: txDelete, update: txUpdate })
      ),
      delete: vi.fn(() => ({ where: deleteWhere }))
    }

    vi.spyOn(service as never, 'getDatabase').mockResolvedValue(database as never)

    const deleted = await service.deleteAgent('agent-user-1')

    expect(deleted).toBe(true)
    expect(mockTombstoneAgent).toHaveBeenCalledWith('agent-user-1')
    expect(mockTombstoneAgent.mock.invocationCallOrder[0]).toBeLessThan(
      database.transaction.mock.invocationCallOrder[0]
    )
    expect(database.transaction).toHaveBeenCalledTimes(1)
    expect(txDelete).toHaveBeenCalledTimes(3)
    expect(txUpdate).toHaveBeenCalledTimes(2)
    expect(database.delete).not.toHaveBeenCalled()
    expect(txUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }))
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        deleted_at: expect.any(String),
        updated_at: expect.any(String)
      })
    )
  })
})
