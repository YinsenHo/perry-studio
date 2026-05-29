import type { Provider } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentDbMirrorService: {
    flush: vi.fn(),
    flushStrict: vi.fn()
  },
  backupService: {
    createBackup: vi.fn(),
    getBackupOverview: vi.fn(),
    restoreBackup: vi.fn(),
    validateBackup: vi.fn()
  },
  configManager: {
    flushPendingStorageV2ConfigStrict: vi.fn(),
    mirrorAllToStorageV2: vi.fn()
  },
  dataRootService: {
    resolveDataRoot: vi.fn()
  },
  fileProjectionService: {
    projectToLegacyRuntime: vi.fn()
  },
  legacyAgentDbImportService: {
    importSnapshot: vi.fn()
  },
  legacyAppDbImportService: {
    importSnapshot: vi.fn()
  },
  legacyDexieImportService: {
    importSnapshot: vi.fn()
  },
  legacyReduxImportService: {
    importSnapshot: vi.fn()
  },
  migrationAuditService: {
    runAudit: vi.fn()
  },
  migrationRunService: {
    listRuns: vi.fn(),
    recordRun: vi.fn()
  },
  secretVault: {
    getSecret: vi.fn(),
    setSecret: vi.fn()
  },
  statisticsService: {
    getStats: vi.fn()
  },
  database: {
    createSnapshot: vi.fn(),
    healthCheck: vi.fn(),
    integrityReport: vi.fn()
  },
  settingsRepository: {
    get: vi.fn(),
    list: vi.fn(),
    set: vi.fn()
  },
  providerRepository: {
    delete: vi.fn(),
    list: vi.fn(),
    listCredentialRefs: vi.fn(),
    upsert: vi.fn()
  },
  assistantRepository: {
    list: vi.fn(),
    upsert: vi.fn()
  },
  conversationRepository: {
    delete: vi.fn(),
    importConversation: vi.fn(),
    list: vi.fn(),
    listMessages: vi.fn(),
    upsertConversation: vi.fn(),
    upsertMessage: vi.fn(),
    upsertMessageBlocks: vi.fn()
  },
  fileRepository: {
    delete: vi.fn(),
    get: vi.fn(),
    importFile: vi.fn(),
    list: vi.fn()
  },
  knowledgeRepository: {
    listBases: vi.fn()
  }
}))

vi.mock('../AgentDbMirrorService', () => ({
  storageV2AgentDbMirrorService: mocks.agentDbMirrorService
}))

vi.mock('../BackupService', () => ({
  storageV2BackupService: mocks.backupService
}))

vi.mock('../../ConfigManager', () => ({
  configManager: mocks.configManager
}))

vi.mock('../DataRootService', () => ({
  storageV2DataRootService: mocks.dataRootService
}))

vi.mock('../FileLegacyProjectionService', () => ({
  storageV2FileLegacyProjectionService: mocks.fileProjectionService
}))

vi.mock('../LegacyAgentDbImportService', () => ({
  storageV2LegacyAgentDbImportService: mocks.legacyAgentDbImportService
}))

vi.mock('../LegacyAppDbImportService', () => ({
  storageV2LegacyAppDbImportService: mocks.legacyAppDbImportService
}))

vi.mock('../LegacyDexieImportService', () => ({
  storageV2LegacyDexieImportService: mocks.legacyDexieImportService
}))

vi.mock('../LegacyReduxImportService', () => ({
  storageV2LegacyReduxImportService: mocks.legacyReduxImportService
}))

vi.mock('../MigrationAuditService', () => ({
  storageV2MigrationAuditService: mocks.migrationAuditService
}))

vi.mock('../MigrationRunService', () => ({
  storageV2MigrationRunService: mocks.migrationRunService
}))

vi.mock('../SecretVaultService', () => ({
  storageV2SecretVaultService: mocks.secretVault
}))

vi.mock('../StatisticsService', () => ({
  storageV2StatisticsService: mocks.statisticsService
}))

vi.mock('../StorageV2Database', () => ({
  storageV2Database: mocks.database
}))

vi.mock('../StorageV2Repositories', () => ({
  storageV2AssistantRepository: mocks.assistantRepository,
  storageV2ConversationRepository: mocks.conversationRepository,
  storageV2FileRepository: mocks.fileRepository,
  storageV2KnowledgeRepository: mocks.knowledgeRepository,
  storageV2ProviderRepository: mocks.providerRepository,
  storageV2SettingsRepository: mocks.settingsRepository
}))

import { StorageV2Service } from '../StorageService'

describe('StorageV2Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settingsRepository.list.mockResolvedValue([])
    mocks.configManager.flushPendingStorageV2ConfigStrict.mockResolvedValue(undefined)
    mocks.configManager.mirrorAllToStorageV2.mockResolvedValue({ mirroredCount: 0 })
    mocks.agentDbMirrorService.flushStrict.mockResolvedValue(undefined)
    mocks.providerRepository.list.mockResolvedValue([])
    mocks.providerRepository.listCredentialRefs.mockResolvedValue(new Map())
    mocks.providerRepository.upsert.mockResolvedValue({ skippedSecret: false })
    mocks.providerRepository.delete.mockResolvedValue({ deleted: true })
    mocks.assistantRepository.list.mockResolvedValue([])
    mocks.conversationRepository.list.mockResolvedValue([])
    mocks.fileRepository.get.mockResolvedValue(null)
    mocks.fileRepository.list.mockResolvedValue([])
    mocks.knowledgeRepository.listBases.mockResolvedValue([])
    mocks.dataRootService.resolveDataRoot.mockReturnValue({ dataRoot: '/mock/Data', candidates: [] })
    mocks.database.healthCheck.mockResolvedValue({ ok: true, quickCheck: 'ok' })
    mocks.database.integrityReport.mockResolvedValue({
      ok: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
      quickCheck: 'ok',
      integrityCheck: 'ok',
      foreignKeyIssueCount: 0,
      issues: []
    })
    mocks.migrationAuditService.runAudit.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      userDataPath: '/mock/userData',
      dataRoot: '/mock/Data',
      items: [],
      warnings: []
    })
    mocks.statisticsService.getStats.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      counts: { settings: 1 }
    })
  })

  it('strictly flushes main-process config and agent mirrors before snapshots', async () => {
    mocks.database.createSnapshot.mockResolvedValue({ path: '/tmp/main.db' })

    await expect(new StorageV2Service().createSnapshot('manual')).resolves.toEqual({ path: '/tmp/main.db' })

    expect(mocks.configManager.flushPendingStorageV2ConfigStrict).toHaveBeenCalledTimes(1)
    expect(mocks.configManager.mirrorAllToStorageV2).toHaveBeenCalledTimes(1)
    expect(mocks.agentDbMirrorService.flushStrict).toHaveBeenCalledTimes(1)
    expect(mocks.database.createSnapshot).toHaveBeenCalledWith('manual')
  })

  it('returns backup overview without forcing a runtime mirror flush', async () => {
    const overview = {
      backupRoot: '/mock/Data/backups',
      backupCount: 1,
      latestBackupPath: '/mock/Data/backups/latest',
      latestBackupCreatedAt: '2026-01-02T00:00:00.000Z',
      latestBackupReason: 'settings-manual'
    }
    mocks.backupService.getBackupOverview.mockResolvedValue(overview)

    await expect(new StorageV2Service().getBackupOverview()).resolves.toEqual(overview)

    expect(mocks.backupService.getBackupOverview).toHaveBeenCalledTimes(1)
    expect(mocks.configManager.flushPendingStorageV2ConfigStrict).not.toHaveBeenCalled()
    expect(mocks.agentDbMirrorService.flushStrict).not.toHaveBeenCalled()
  })

  it('projects legacy Dexie auxiliary table rows into core snapshots', async () => {
    mocks.settingsRepository.list.mockResolvedValue([
      {
        key: 'dexie.table.quick_phrases.phrase-1',
        value: {
          id: 'phrase-1',
          title: 'Greeting',
          content: 'Hello',
          createdAt: 1760000000000,
          updatedAt: 1760000000000
        },
        scope: 'dexie-table:quick_phrases',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'dexie.table.knowledge_notes.note-1',
        value: null,
        scope: 'dexie-table:knowledge_notes',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      }
    ])

    const snapshot = await new StorageV2Service().getCoreSnapshot()

    expect(snapshot.dexieTables.quick_phrases).toEqual({
      'phrase-1': {
        id: 'phrase-1',
        title: 'Greeting',
        content: 'Hello',
        createdAt: 1760000000000,
        updatedAt: 1760000000000
      }
    })
    expect(snapshot.dexieTables.knowledge_notes).toEqual({
      'note-1': null
    })
    expect(snapshot.metadata.dexieTableRowCount).toBe(2)
  })

  it('rebuilds Redux knowledge state from structured knowledge tables when the Redux snapshot is missing', async () => {
    mocks.knowledgeRepository.listBases.mockResolvedValue([
      {
        id: 'base-1',
        name: 'Docs',
        items: [{ id: 'item-1', type: 'url', content: 'https://example.com/docs' }]
      }
    ])

    const snapshot = await new StorageV2Service().getCoreSnapshot()

    expect(snapshot.redux.knowledge).toEqual({
      bases: [
        {
          id: 'base-1',
          name: 'Docs',
          items: [{ id: 'item-1', type: 'url', content: 'https://example.com/docs' }]
        }
      ]
    })
    expect(mocks.knowledgeRepository.listBases).toHaveBeenCalled()
  })

  it('rebuilds Redux knowledge state from structured knowledge tables when the Redux snapshot is empty', async () => {
    mocks.settingsRepository.list.mockResolvedValue([
      {
        key: 'redux.knowledge',
        value: { bases: [] },
        scope: 'redux',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1
      }
    ])
    mocks.knowledgeRepository.listBases.mockResolvedValue([
      {
        id: 'base-1',
        name: 'Docs',
        items: [{ id: 'item-1', type: 'url', content: 'https://example.com/docs' }]
      }
    ])

    const snapshot = await new StorageV2Service().getCoreSnapshot()

    expect(snapshot.redux.knowledge).toEqual({
      bases: [
        {
          id: 'base-1',
          name: 'Docs',
          items: [{ id: 'item-1', type: 'url', content: 'https://example.com/docs' }]
        }
      ]
    })
  })

  it('delegates Storage v2 file read-through and projection helpers', async () => {
    const file = {
      id: 'file-1',
      name: 'file-1.txt',
      origin_name: 'notes.txt',
      path: '',
      size: 128,
      ext: '.txt',
      type: 'text',
      created_at: '2026-01-01T00:00:00.000Z',
      count: 1
    }
    const projectionReport = {
      filesDir: '/tmp/Files',
      projectedFileCount: 1,
      archivedFileCount: 0,
      skippedFileCount: 0,
      missingBlobCount: 0,
      archivedFiles: [],
      warnings: []
    }
    mocks.fileRepository.get.mockResolvedValue(file)
    mocks.fileRepository.list.mockResolvedValue([file])
    mocks.fileProjectionService.projectToLegacyRuntime.mockResolvedValue(projectionReport)

    const service = new StorageV2Service()

    await expect(service.getFile('file-1')).resolves.toEqual(file)
    await expect(service.listFiles()).resolves.toEqual([file])
    await expect(service.projectFilesToLegacyRuntime()).resolves.toEqual(projectionReport)
    expect(mocks.fileRepository.get).toHaveBeenCalledWith('file-1')
    expect(mocks.fileProjectionService.projectToLegacyRuntime).toHaveBeenCalled()
  })

  it('stores provider API keys in the secret vault before upserting provider metadata', async () => {
    const provider: Provider = {
      id: 'provider-1',
      type: 'openai',
      name: 'OpenAI',
      apiKey: 'sk-test',
      apiHost: 'https://api.openai.com',
      models: []
    }
    mocks.secretVault.setSecret.mockResolvedValue('storage-v2://secret/provider/provider-1/apiKey')
    mocks.providerRepository.upsert.mockResolvedValue({ skippedSecret: false })

    await expect(new StorageV2Service().upsertProvider(provider, 2)).resolves.toEqual({ skippedSecret: false })

    expect(mocks.secretVault.setSecret).toHaveBeenCalledWith('provider', 'provider-1', 'apiKey', 'sk-test')
    expect(mocks.providerRepository.upsert).toHaveBeenCalledWith(
      provider,
      2,
      'storage-v2://secret/provider/provider-1/apiKey'
    )
  })

  it('uses explicit provider credential refs without rewriting secrets', async () => {
    const provider: Provider = {
      id: 'provider-1',
      type: 'openai',
      name: 'OpenAI',
      apiKey: 'sk-test',
      apiHost: 'https://api.openai.com',
      models: []
    }

    await expect(
      new StorageV2Service().upsertProvider(provider, 3, 'storage-v2://secret/provider/provider-1/apiKey')
    ).resolves.toEqual({ skippedSecret: false })

    expect(mocks.secretVault.setSecret).not.toHaveBeenCalled()
    expect(mocks.providerRepository.upsert).toHaveBeenCalledWith(
      provider,
      3,
      'storage-v2://secret/provider/provider-1/apiKey'
    )
  })

  it('deletes providers through the Storage v2 tombstone repository path', async () => {
    mocks.providerRepository.delete.mockResolvedValue({ deleted: true })

    await expect(new StorageV2Service().deleteProvider('provider-1')).resolves.toEqual({ deleted: true })

    expect(mocks.providerRepository.delete).toHaveBeenCalledWith('provider-1')
  })

  it('summarizes whether the current profile is ready for backup and migration', async () => {
    mocks.migrationAuditService.runAudit.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      userDataPath: '/mock/userData',
      dataRoot: '/mock/Data',
      items: [
        {
          id: 'legacy-user-data-agents-db',
          label: 'Legacy agents.db',
          path: '/mock/userData/agents.db',
          exists: true,
          sizeBytes: 128,
          coverage: 'legacy-only',
          actionRequired: true
        }
      ],
      warnings: ['Legacy-only data paths were detected.']
    })

    const summary = await new StorageV2Service().getHealthSummary()

    expect(summary).toMatchObject({
      status: 'warning',
      canBackup: true,
      canMigrate: false,
      dataRoot: '/mock/Data',
      issueCount: 0,
      warningCount: 2
    })
    expect(summary.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'storage_health', status: 'ok' }),
        expect.objectContaining({ id: 'integrity', status: 'ok' }),
        expect.objectContaining({ id: 'legacy_only_paths', status: 'warning', values: { count: 1 } }),
        expect.objectContaining({ id: 'audit_warnings', status: 'warning', values: { count: 1 } })
      ])
    )
  })

  it('restores localStorage MCP provider tokens from secret refs in core snapshots', async () => {
    const secretRef = 'storage-v2://secret/mcp-provider-token/mcprouter_token/token'
    mocks.settingsRepository.list.mockResolvedValue([
      {
        key: 'localStorage.durableValues',
        value: {
          language: 'zh-CN',
          'onboarding-completed': 'true'
        },
        scope: 'localStorage',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'localStorage.clearedMcpProviderTokenKeys',
        value: ['ai302_token', 'mcprouter_token', 'unexpected_token'],
        scope: 'localStorage',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'localStorage.mcpProviderTokens',
        value: {
          mcprouter_token: {
            tokenSecretRef: secretRef
          },
          modelscope_token: 'legacy-clear-token'
        },
        scope: 'localStorage',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      }
    ])
    mocks.secretVault.getSecret.mockResolvedValue('restored-token')

    const snapshot = await new StorageV2Service().getCoreSnapshot({ includeSecrets: true })

    expect(snapshot.localStorage.durableValues).toEqual({
      language: 'zh-CN',
      'onboarding-completed': 'true'
    })
    expect(snapshot.localStorage.mcpProviderTokens).toEqual({
      mcprouter_token: 'restored-token',
      modelscope_token: 'legacy-clear-token'
    })
    expect(snapshot.localStorage.clearedMcpProviderTokenKeys).toEqual(['ai302_token'])
    expect(snapshot.metadata.missingSecretCount).toBe(0)
    expect(mocks.secretVault.getSecret).toHaveBeenCalledWith(secretRef)
  })

  it('omits localStorage MCP provider tokens when exporting without secrets', async () => {
    mocks.settingsRepository.list.mockResolvedValue([
      {
        key: 'settings.s3',
        value: {
          bucket: 'user-bucket',
          secretAccessKey: 'legacy-s3-secret'
        },
        scope: 'settings',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'llm.settings',
        value: {
          awsBedrock: {
            apiKey: 'legacy-bedrock-key',
            region: 'us-east-1'
          }
        },
        scope: 'llm',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'redux.mcp',
        value: {
          servers: [
            {
              id: 'server-1',
              env: {
                API_TOKEN: 'legacy-env-token'
              },
              envSecretRefs: {
                API_TOKEN: 'storage-v2://secret/mcp-server/server-1/env.API_TOKEN'
              }
            }
          ]
        },
        scope: 'redux',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'redux.codeTools',
        value: {
          environmentVariables: {
            tool: 'legacy-tool-secret'
          },
          environmentVariableSecretRefs: {
            tool: 'storage-v2://secret/code-tools/tool/environmentVariable'
          }
        },
        scope: 'redux',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'redux.copilot',
        value: {
          defaultHeaders: {
            Authorization: 'Bearer legacy-token',
            'X-Client': 'desktop'
          }
        },
        scope: 'redux',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'localStorage.mcpProviderTokens',
        value: {
          mcprouter_token: {
            tokenSecretRef: 'storage-v2://secret/mcp-provider-token/mcprouter_token/token'
          },
          modelscope_token: 'legacy-clear-token'
        },
        scope: 'localStorage',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      },
      {
        key: 'localStorage.clearedMcpProviderTokenKeys',
        value: ['ai302_token', 'mcprouter_token', 'unexpected_token'],
        scope: 'localStorage',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        deletedAt: null
      }
    ])

    const snapshot = await new StorageV2Service().getCoreSnapshot()

    expect(snapshot.settings.s3).toEqual({ bucket: 'user-bucket' })
    expect(snapshot.llm.settings).toEqual({ awsBedrock: { region: 'us-east-1' } })
    expect(snapshot.redux.mcp).toEqual({ servers: [{ id: 'server-1' }] })
    expect(snapshot.redux.codeTools).toEqual({})
    expect(snapshot.redux.copilot).toEqual({
      defaultHeaders: {
        'X-Client': 'desktop'
      }
    })
    expect(snapshot.localStorage.mcpProviderTokens).toEqual({})
    expect(snapshot.localStorage.clearedMcpProviderTokenKeys).toEqual(['ai302_token'])
    expect(snapshot.metadata.includeSecrets).toBe(false)
    expect(mocks.secretVault.getSecret).not.toHaveBeenCalled()
  })
})
