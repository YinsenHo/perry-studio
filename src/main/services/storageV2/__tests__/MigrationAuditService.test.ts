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
  }
}))

vi.mock('node:fs/promises', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('../DataRootService', () => ({
  storageV2DataRootService: mocks.dataRootService
}))

describe('StorageV2MigrationAuditService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(app.getPath).mockImplementation((key: string) => (key === 'userData' ? '/mock/current-user-data' : ''))
    mocks.dataRootService.resolveDataRoot.mockReturnValue({
      dataRoot: '/mock/stable-data-root',
      candidates: []
    })
    vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
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
    expect(itemPath('agents-db')).toBe('/mock/stable-data-root/agents.db')
  })
})
