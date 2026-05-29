import fs from 'node:fs/promises'

import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dataRootService: {
    resolveDataRoot: vi.fn()
  },
  fs: {
    stat: vi.fn(),
    readdir: vi.fn()
  },
  settingsRepository: {
    get: vi.fn()
  }
}))

vi.mock('node:fs/promises', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('../DataRootService', () => ({
  storageV2DataRootService: mocks.dataRootService
}))

vi.mock('../StorageV2Repositories', () => ({
  storageV2SettingsRepository: mocks.settingsRepository
}))

describe('StorageV2MigrationAuditService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(app.getPath).mockImplementation((key: string) => {
      if (key === 'userData') return '/mock/current-user-data'
      if (key === 'home') return '/mock/home'
      return ''
    })
    mocks.dataRootService.resolveDataRoot.mockReturnValue({
      dataRoot: '/mock/stable-data-root',
      candidates: []
    })
    vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mocks.settingsRepository.get.mockResolvedValue(null)
  })

  it('audits legacy runtime directories under the active Storage v2 data root', async () => {
    const { StorageV2MigrationAuditService } = await import('../MigrationAuditService')
    const audit = await new StorageV2MigrationAuditService().runAudit()
    const itemPath = (id: string) => audit.items.find((item) => item.id === id)?.path

    expect(audit.dataRoot).toBe('/mock/stable-data-root')
    expect(itemPath('indexeddb')).toBe('/mock/current-user-data/IndexedDB')
    expect(itemPath('local-storage')).toBe('/mock/current-user-data/Local Storage')
    expect(itemPath('data')).toBe('/mock/stable-data-root')
    expect(itemPath('files')).toBe('/mock/stable-data-root/Files')
    expect(itemPath('knowledge-base')).toBe('/mock/stable-data-root/KnowledgeBase')
    expect(itemPath('notes')).toBe('/mock/stable-data-root/Notes')
    expect(itemPath('workspace')).toBe('/mock/stable-data-root/Workspace')
    expect(itemPath('channels')).toBe('/mock/stable-data-root/Channels')
    expect(itemPath('workbench')).toBe('/mock/stable-data-root/Workbench')
    expect(itemPath('agents-db')).toBe('/mock/stable-data-root/agents.db')
    expect(itemPath('legacy-user-data-agents-db')).toBe('/mock/current-user-data/agents.db')
    expect(itemPath('legacy-user-data-memory-db')).toBe('/mock/current-user-data/memories.db')
    expect(itemPath('home-config')).toBe('/mock/home/.cherrystudio/config/config.json')
    expect(itemPath('mcp-memory-json')).toBe('/mock/home/.cherrystudio/config/memory.json')
    expect(itemPath('mcp-oauth-legacy')).toBe('/mock/home/.cherrystudio/config/mcp/oauth')
    expect(itemPath('code-tools-bin')).toBe('/mock/home/.cherrystudio/bin')
    expect(itemPath('code-tools-install')).toBe('/mock/home/.cherrystudio/install')
    expect(itemPath('openclaw-config')).toBe('/mock/home/.openclaw/openclaw.json')
    expect(itemPath('ovms-config')).toBe('/mock/home/.cherrystudio/ovms/ovms/models/config.json')
    expect(itemPath('trace-cache')).toBe('/mock/home/.cherrystudio/trace')
    expect(itemPath('logs')).toBe('/mock/current-user-data/logs')
    expect(itemPath('user-data-cache')).toBe('/mock/current-user-data/Cache')
    expect(itemPath('version-log')).toBe('/mock/current-user-data/version.log')
    expect(itemPath('tesseract-cache')).toBe('/mock/current-user-data/tesseract')
    expect(itemPath('storage-v2-backups')).toBe('/mock/stable-data-root/backups')
    expect(itemPath('storage-v2-snapshots')).toBe('/mock/stable-data-root/snapshots')
    expect(itemPath('storage-v2-legacy-archives')).toBe('/mock/stable-data-root/legacy')
    expect(itemPath('storage-v2-temp')).toBe('/mock/stable-data-root/temp')
  })

  it('surfaces unclassified top-level Data entries as action-required audit items', async () => {
    vi.mocked(fs.readdir).mockImplementation(async (targetPath) => {
      if (String(targetPath) === '/mock/stable-data-root') {
        return [
          {
            name: 'MysteryStore',
            isDirectory: () => true,
            isFile: () => false
          }
        ] as any
      }
      if (String(targetPath) === '/mock/stable-data-root/MysteryStore') {
        return [] as any
      }
      return [] as any
    })
    vi.mocked(fs.stat).mockImplementation(async (targetPath) => {
      if (String(targetPath) === '/mock/stable-data-root/MysteryStore') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          size: 0
        } as any
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { StorageV2MigrationAuditService } = await import('../MigrationAuditService')
    const audit = await new StorageV2MigrationAuditService().runAudit()
    const item = audit.items.find((entry) => entry.id === 'data-root-unclassified-mysterystore-1')

    expect(item).toMatchObject({
      actionRequired: true,
      category: 'user-asset',
      coverage: 'legacy-only',
      exists: true,
      path: '/mock/stable-data-root/MysteryStore',
      risk: 'medium'
    })
    expect(audit.warnings.some((warning) => warning.includes('Unclassified Data entry'))).toBe(true)
  })

  it('warns when a configured notes directory lives outside the Storage v2 data root', async () => {
    mocks.settingsRepository.get.mockResolvedValue({
      notesPath: '/mock/external-notes'
    })
    vi.mocked(fs.stat).mockImplementation(async (targetPath) => {
      if (String(targetPath) === '/mock/external-notes') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          size: 0
        } as any
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    vi.mocked(fs.readdir).mockImplementation(async (targetPath) => {
      if (String(targetPath) === '/mock/external-notes') {
        return [
          {
            name: 'note.md',
            isDirectory: () => false,
            isFile: () => true
          }
        ] as any
      }
      return [] as any
    })

    const { StorageV2MigrationAuditService } = await import('../MigrationAuditService')
    const audit = await new StorageV2MigrationAuditService().runAudit()
    const item = audit.items.find((entry) => entry.id === 'external-notes-path')

    expect(item).toMatchObject({
      actionRequired: true,
      category: 'user-asset',
      coverage: 'legacy-only',
      exists: true,
      path: '/mock/external-notes',
      risk: 'high'
    })
    expect(audit.warnings.some((warning) => warning.includes('/mock/external-notes'))).toBe(true)
  })

  it('does not warn for the default notes directory under the Storage v2 data root', async () => {
    mocks.settingsRepository.get.mockResolvedValue({
      notesPath: '/mock/stable-data-root/Notes'
    })

    const { StorageV2MigrationAuditService } = await import('../MigrationAuditService')
    const audit = await new StorageV2MigrationAuditService().runAudit()

    expect(audit.items.some((entry) => entry.id === 'external-notes-path')).toBe(false)
  })

  it('warns when legacy-only action-required paths still exist', async () => {
    vi.mocked(fs.stat).mockImplementation(async (targetPath) => {
      if (String(targetPath) === '/mock/current-user-data/agents.db') {
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 64
        } as any
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { StorageV2MigrationAuditService } = await import('../MigrationAuditService')
    const audit = await new StorageV2MigrationAuditService().runAudit()
    const legacyAgentDb = audit.items.find((item) => item.id === 'legacy-user-data-agents-db')

    expect(legacyAgentDb).toMatchObject({
      actionRequired: true,
      coverage: 'legacy-only',
      exists: true,
      fileCount: 1,
      risk: 'high',
      sizeBytes: 64
    })
    expect(audit.warnings.some((warning) => warning.includes('Legacy-only data paths were detected'))).toBe(true)
    expect(audit.warnings.some((warning) => warning.includes('/mock/current-user-data/agents.db'))).toBe(true)
  })
})
