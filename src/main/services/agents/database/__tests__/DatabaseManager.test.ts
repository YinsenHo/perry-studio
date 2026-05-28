import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: {
    getPath: vi.fn()
  },
  fs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn()
  },
  utils: {
    getDataPath: vi.fn()
  }
}))

vi.mock('fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

vi.mock('electron', () => ({
  app: mocks.app
}))

vi.mock('../../../../utils', () => mocks.utils)

vi.mock('@main/constant', () => ({
  isDev: false
}))

vi.mock('@libsql/client', () => ({
  createClient: vi.fn()
}))

vi.mock('drizzle-orm/libsql', () => ({
  drizzle: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

import { DatabaseManager } from '../DatabaseManager'

function migrateFromOldPath() {
  ;(DatabaseManager as unknown as { migrateFromOldPath: () => void }).migrateFromOldPath()
}

describe('DatabaseManager legacy path migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(17_000)
    mocks.app.getPath.mockImplementation((key: string) => {
      if (key === 'userData') return '/mock/userData'
      return '/mock/unknown'
    })
    mocks.utils.getDataPath.mockReturnValue('/mock/userData/Data')
    mocks.fs.existsSync.mockReturnValue(false)
    mocks.fs.mkdirSync.mockReturnValue(undefined as never)
    mocks.fs.renameSync.mockReturnValue(undefined)
    mocks.fs.copyFileSync.mockReturnValue(undefined)
    mocks.fs.unlinkSync.mockReturnValue(undefined)
  })

  it('migrates the legacy agents database and sidecars into the stable data root', () => {
    mocks.fs.existsSync.mockImplementation((candidate) =>
      [
        '/mock/userData/agents.db',
        '/mock/userData/agents.db-wal',
        '/mock/userData/agents.db-shm',
        '/mock/userData/Data'
      ].includes(String(candidate))
    )

    migrateFromOldPath()

    expect(mocks.fs.renameSync).toHaveBeenCalledWith('/mock/userData/agents.db', '/mock/userData/Data/agents.db')
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/agents.db-wal',
      '/mock/userData/Data/agents.db-wal'
    )
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/agents.db-shm',
      '/mock/userData/Data/agents.db-shm'
    )
  })

  it('archives the legacy agents database when the stable database already exists', () => {
    mocks.fs.existsSync.mockImplementation((candidate) =>
      [
        '/mock/userData/agents.db',
        '/mock/userData/agents.db-wal',
        '/mock/userData/Data',
        '/mock/userData/Data/agents.db'
      ].includes(String(candidate))
    )

    migrateFromOldPath()

    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/agents.db',
      '/mock/userData/Data/legacy/pre-storage-v2-agents-17000/agents.db'
    )
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(
      '/mock/userData/agents.db-wal',
      '/mock/userData/Data/legacy/pre-storage-v2-agents-17000/agents.db-wal'
    )
    expect(mocks.fs.renameSync).not.toHaveBeenCalledWith('/mock/userData/agents.db', '/mock/userData/Data/agents.db')
  })

  it('falls back to copy and unlink when moving across devices', () => {
    mocks.fs.existsSync.mockImplementation((candidate) =>
      ['/mock/userData/agents.db', '/mock/userData/Data'].includes(String(candidate))
    )
    mocks.fs.renameSync.mockImplementationOnce(() => {
      const error = new Error('Cross-device link')
      ;(error as NodeJS.ErrnoException).code = 'EXDEV'
      throw error
    })

    migrateFromOldPath()

    expect(mocks.fs.copyFileSync).toHaveBeenCalledWith('/mock/userData/agents.db', '/mock/userData/Data/agents.db')
    expect(mocks.fs.unlinkSync).toHaveBeenCalledWith('/mock/userData/agents.db')
  })
})
