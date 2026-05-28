import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  knowledgeNotesAnyOf: vi.fn(),
  knowledgeNotesHook: vi.fn(),
  knowledgeNotesWhere: vi.fn(),
  quickPhrasesAnyOf: vi.fn(),
  quickPhrasesHook: vi.fn(),
  quickPhrasesWhere: vi.fn(),
  translateHistoryHook: vi.fn(),
  translateHistoryWhere: vi.fn(),
  translateLanguagesHook: vi.fn(),
  translateLanguagesWhere: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  default: {
    knowledge_notes: {
      hook: mocks.knowledgeNotesHook,
      where: mocks.knowledgeNotesWhere
    },
    quick_phrases: {
      hook: mocks.quickPhrasesHook,
      where: mocks.quickPhrasesWhere
    },
    translate_history: {
      hook: mocks.translateHistoryHook,
      where: mocks.translateHistoryWhere
    },
    translate_languages: {
      hook: mocks.translateLanguagesHook,
      where: mocks.translateLanguagesWhere
    }
  }
}))

describe('StorageV2DexieTableMirrorService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api
    mocks.quickPhrasesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          id: 'phrase-1',
          title: 'Greeting',
          content: 'Hello',
          createdAt: 1760000000000,
          updatedAt: 1760000000000
        }
      ])
    })
    mocks.quickPhrasesWhere.mockReturnValue({
      anyOf: mocks.quickPhrasesAnyOf
    })
    mocks.knowledgeNotesAnyOf.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([])
    })
    mocks.knowledgeNotesWhere.mockReturnValue({
      anyOf: mocks.knowledgeNotesAnyOf
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('mirrors auxiliary Dexie rows and delete markers into Storage v2 settings', async () => {
    const setSetting = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          setSetting
        }
      }
    })

    const { storageV2DexieTableMirrorService } = await import('../StorageV2DexieTableMirrorService')

    storageV2DexieTableMirrorService.scheduleRow('quick_phrases', 'phrase-1', 0)
    storageV2DexieTableMirrorService.scheduleDelete('knowledge_notes', 'note-1', 0)
    await storageV2DexieTableMirrorService.flush()

    expect(setSetting).toHaveBeenCalledWith('dexie.table.knowledge_notes.note-1', null, 'dexie-table:knowledge_notes')
    expect(setSetting).toHaveBeenCalledWith(
      'dexie.table.quick_phrases.phrase-1',
      {
        id: 'phrase-1',
        title: 'Greeting',
        content: 'Hello',
        createdAt: 1760000000000,
        updatedAt: 1760000000000
      },
      'dexie-table:quick_phrases'
    )
  })

  it('rejects strict flushes when an auxiliary table mirror write is still pending after failure', async () => {
    vi.useFakeTimers()
    const setSetting = vi.fn().mockRejectedValue(new Error('storage busy'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          setSetting
        }
      }
    })

    try {
      const { storageV2DexieTableMirrorService } = await import('../StorageV2DexieTableMirrorService')

      storageV2DexieTableMirrorService.scheduleRow('quick_phrases', 'phrase-1', 1000)

      await expect(storageV2DexieTableMirrorService.flushStrict()).rejects.toThrow('storage busy')
      expect(setSetting).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
