import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  client: {
    execute: vi.fn(),
    close: vi.fn()
  },
  fs: {
    existsSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn()
  },
  app: {
    getPath: vi.fn()
  },
  utils: {
    getDataPath: vi.fn(),
    makeSureDirExists: vi.fn()
  }
}))

vi.mock('fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('electron', () => ({
  app: mocks.app
}))

vi.mock('@main/utils', () => mocks.utils)

vi.mock('@libsql/client', () => ({
  createClient: vi.fn(() => mocks.client)
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('@main/knowledge/embedjs/embeddings/Embeddings', () => ({
  default: vi.fn()
}))

import { createClient } from '@libsql/client'

import MemoryService from '../MemoryService'

describe('MemoryService migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(17_000)
    mocks.app.getPath.mockImplementation((key: string) => {
      if (key === 'userData') return '/mock/userData'
      return '/mock/unknown'
    })
    mocks.utils.getDataPath.mockImplementation((subPath?: string) => (subPath ? `/mock/data/${subPath}` : '/mock/data'))
    mocks.fs.existsSync.mockReturnValue(false)
    mocks.fs.renameSync.mockReturnValue(undefined)
    mocks.fs.copyFileSync.mockReturnValue(undefined)
    mocks.fs.unlinkSync.mockReturnValue(undefined)
    mocks.client.execute.mockResolvedValue({ rows: [], columns: [], columnTypes: [] })
    mocks.client.close.mockReturnValue(undefined)
  })

  it('migrates the legacy memory database and sidecars into the stable data root', () => {
    mocks.fs.existsSync.mockImplementation((candidate) =>
      ['/mock/userData/memories.db', '/mock/userData/memories.db-wal', '/mock/userData/memories.db-shm'].includes(
        String(candidate)
      )
    )

    MemoryService.getInstance().migrateMemoryDb()

    expect(mocks.fs.renameSync).toHaveBeenCalledWith('/mock/userData/memories.db', '/mock/data/Memory/memories.db')
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/memories.db-wal',
      '/mock/data/Memory/memories.db-wal'
    )
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/memories.db-shm',
      '/mock/data/Memory/memories.db-shm'
    )
  })

  it('archives the legacy memory database when the stable database already exists', () => {
    mocks.fs.existsSync.mockImplementation((candidate) =>
      ['/mock/userData/memories.db', '/mock/userData/memories.db-wal', '/mock/data/Memory/memories.db'].includes(
        String(candidate)
      )
    )

    MemoryService.getInstance().migrateMemoryDb()

    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/memories.db',
      '/mock/data/Memory/legacy/pre-storage-v2-memory-17000/memories.db'
    )
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/memories.db-wal',
      '/mock/data/Memory/legacy/pre-storage-v2-memory-17000/memories.db-wal'
    )
    expect(mocks.fs.renameSync).not.toHaveBeenCalledWith('/mock/userData/memories.db', '/mock/data/Memory/memories.db')
  })

  it('falls back to copy and unlink when moving across devices', () => {
    mocks.fs.existsSync.mockImplementation((candidate) => String(candidate) === '/mock/userData/memories.db')
    mocks.fs.renameSync.mockImplementationOnce(() => {
      const error = new Error('Cross-device link')
      ;(error as NodeJS.ErrnoException).code = 'EXDEV'
      throw error
    })

    MemoryService.getInstance().migrateMemoryDb()

    expect(mocks.fs.copyFileSync).toHaveBeenCalledWith('/mock/userData/memories.db', '/mock/data/Memory/memories.db')
    expect(mocks.fs.unlinkSync).toHaveBeenCalledWith('/mock/userData/memories.db')
  })

  it('runs the legacy memory migration before opening the stable database', async () => {
    mocks.fs.existsSync.mockImplementation((candidate) => String(candidate) === '/mock/userData/memories.db')

    await (MemoryService.reload() as unknown as { init: () => Promise<void> }).init()

    expect(mocks.fs.renameSync).toHaveBeenCalledWith('/mock/userData/memories.db', '/mock/data/Memory/memories.db')
    expect(createClient).toHaveBeenCalledWith({
      url: 'file:/mock/data/Memory/memories.db',
      intMode: 'number'
    })
  })
})
