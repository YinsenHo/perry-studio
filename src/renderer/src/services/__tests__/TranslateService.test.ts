import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  clearHistory: vi.fn(),
  db: {
    settings: {
      hook: vi.fn()
    },
    translate_history: {
      clear: vi.fn(),
      delete: vi.fn(),
      toArray: vi.fn()
    },
    translate_languages: {
      delete: vi.fn()
    }
  },
  deleteHistory: vi.fn(),
  deleteLanguage: vi.fn(),
  flushStrict: vi.fn(),
  projectMissingRows: vi.fn(),
  scheduleDelete: vi.fn(),
  scheduleDeletes: vi.fn(),
  toArrayHistory: vi.fn()
}))

mocks.db.translate_history.clear = mocks.clearHistory
mocks.db.translate_history.delete = mocks.deleteHistory
mocks.db.translate_history.toArray = mocks.toArrayHistory
mocks.db.translate_languages.delete = mocks.deleteLanguage

vi.mock('@renderer/databases', () => ({
  db: mocks.db,
  default: mocks.db
}))

vi.mock('@renderer/utils', () => ({
  uuid: vi.fn(() => 'uuid-1')
}))

vi.mock('@renderer/utils/abortController', () => ({
  readyToAbort: vi.fn()
}))

vi.mock('@renderer/utils/error', () => ({
  isAbortError: vi.fn(() => false)
}))

vi.mock('@renderer/types/chunk', () => ({
  ChunkType: {
    ERROR: 'error',
    TEXT_COMPLETE: 'text_complete',
    TEXT_DELTA: 'text_delta'
  }
}))

vi.mock('@renderer/types', () => ({}))

vi.mock('i18next', () => ({
  t: vi.fn((key: string) => key)
}))

vi.mock('ai', () => ({
  NoOutputGeneratedError: {
    isInstance: vi.fn(() => false)
  }
}))

vi.mock('../StorageV2DexieTableMirrorService', () => ({
  storageV2DexieTableMirrorService: {
    flushStrict: mocks.flushStrict,
    scheduleDelete: mocks.scheduleDelete,
    scheduleDeletes: mocks.scheduleDeletes
  }
}))

vi.mock('../StorageV2DexieTableRecoveryService', () => ({
  storageV2DexieTableRecoveryService: {
    projectMissingRows: mocks.projectMissingRows
  }
}))

vi.mock('../ApiService', () => ({
  fetchChatCompletion: vi.fn()
}))

vi.mock('../AssistantService', () => ({
  getDefaultAssistant: vi.fn(() => ({ id: 'default-assistant', topics: [] })),
  getDefaultTranslateAssistant: vi.fn()
}))

describe('TranslateService Storage v2 deletes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.flushStrict.mockResolvedValue(undefined)
    mocks.projectMissingRows.mockResolvedValue(false)
  })

  it('writes a custom language tombstone before deleting the legacy row', async () => {
    mocks.deleteLanguage.mockResolvedValue(undefined)
    const { deleteCustomLanguage } = await import('../TranslateService')

    await deleteCustomLanguage('language-1')

    expect(mocks.scheduleDelete).toHaveBeenCalledWith('translate_languages', 'language-1')
    expect(mocks.flushStrict).toHaveBeenCalled()
    expect(mocks.deleteLanguage).toHaveBeenCalledWith('language-1')
    expect(mocks.flushStrict.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteLanguage.mock.invocationCallOrder[0])
  })

  it('writes a history tombstone before deleting the legacy row', async () => {
    mocks.deleteHistory.mockResolvedValue(undefined)
    const { deleteHistory } = await import('../TranslateService')

    await deleteHistory('history-1')

    expect(mocks.scheduleDelete).toHaveBeenCalledWith('translate_history', 'history-1')
    expect(mocks.flushStrict).toHaveBeenCalled()
    expect(mocks.deleteHistory).toHaveBeenCalledWith('history-1')
    expect(mocks.flushStrict.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteHistory.mock.invocationCallOrder[0])
  })

  it('recovers missing Storage v2 history rows before clearing all history tombstones', async () => {
    mocks.toArrayHistory.mockResolvedValue([{ id: 'history-a' }, { id: 'history-b' }])
    mocks.clearHistory.mockResolvedValue(undefined)
    const { clearHistory } = await import('../TranslateService')

    await clearHistory()

    expect(mocks.projectMissingRows).toHaveBeenCalledWith('translate_history', 'translate-history-list')
    expect(mocks.scheduleDeletes).toHaveBeenCalledWith('translate_history', ['history-a', 'history-b'])
    expect(mocks.flushStrict).toHaveBeenCalled()
    expect(mocks.clearHistory).toHaveBeenCalled()
  })
})
