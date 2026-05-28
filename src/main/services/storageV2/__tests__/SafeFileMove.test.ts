import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn()
  }
}))

vi.mock('node:fs', () => ({
  ...mocks.fs,
  default: mocks.fs
}))

import { getAvailablePathSync, movePathSync } from '../SafeFileMove'

describe('movePathSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fs.existsSync.mockReturnValue(false)
    mocks.fs.mkdirSync.mockReturnValue(undefined as never)
    mocks.fs.renameSync.mockReturnValue(undefined)
    mocks.fs.statSync.mockReturnValue({ isDirectory: () => false } as never)
    mocks.fs.cpSync.mockReturnValue(undefined)
    mocks.fs.rmSync.mockReturnValue(undefined)
    mocks.fs.copyFileSync.mockReturnValue(undefined)
    mocks.fs.unlinkSync.mockReturnValue(undefined)
  })

  it('moves paths with rename when source and target are on the same device', () => {
    movePathSync('/mock/source.db', '/mock/archive/source.db')

    expect(mocks.fs.renameSync).toHaveBeenCalledWith('/mock/source.db', '/mock/archive/source.db')
    expect(mocks.fs.copyFileSync).not.toHaveBeenCalled()
    expect(mocks.fs.cpSync).not.toHaveBeenCalled()
  })

  it('falls back to file copy and unlink when rename crosses devices', () => {
    mocks.fs.renameSync.mockImplementationOnce(() => {
      const error = new Error('Cross-device link')
      ;(error as NodeJS.ErrnoException).code = 'EXDEV'
      throw error
    })

    movePathSync('/mock/source.db', '/mock/archive/source.db')

    expect(mocks.fs.copyFileSync).toHaveBeenCalledWith('/mock/source.db', '/mock/archive/source.db')
    expect(mocks.fs.unlinkSync).toHaveBeenCalledWith('/mock/source.db')
  })

  it('falls back to directory copy and remove when rename crosses devices', () => {
    mocks.fs.renameSync.mockImplementationOnce(() => {
      const error = new Error('Cross-device link')
      ;(error as NodeJS.ErrnoException).code = 'EXDEV'
      throw error
    })
    mocks.fs.statSync.mockReturnValue({ isDirectory: () => true } as never)

    movePathSync('/mock/Files', '/mock/archive/Files')

    expect(mocks.fs.cpSync).toHaveBeenCalledWith('/mock/Files', '/mock/archive/Files', {
      recursive: true,
      force: false,
      errorOnExist: true
    })
    expect(mocks.fs.rmSync).toHaveBeenCalledWith('/mock/Files', { recursive: true, force: true })
  })

  it('refuses to overwrite an existing target path', () => {
    mocks.fs.existsSync.mockReturnValue(true)

    expect(() => movePathSync('/mock/source.db', '/mock/archive/source.db')).toThrow(
      'Refusing to overwrite existing path'
    )
    expect(mocks.fs.renameSync).not.toHaveBeenCalled()
  })

  it('returns a numbered archive path when the preferred target already exists', () => {
    mocks.fs.existsSync.mockImplementation((candidate) =>
      ['/mock/archive/source.db', '/mock/archive/source.1.db'].includes(String(candidate))
    )

    expect(getAvailablePathSync('/mock/archive/source.db')).toBe('/mock/archive/source.2.db')
  })
})
