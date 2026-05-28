import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStorageV2CoreSnapshot: vi.fn(),
  knowledgeNotesDelete: vi.fn(),
  knowledgeNotesPut: vi.fn(),
  quickPhrasesDelete: vi.fn(),
  quickPhrasesPut: vi.fn(),
  settingsDelete: vi.fn(),
  settingsPut: vi.fn(),
  translateHistoryDelete: vi.fn(),
  translateHistoryPut: vi.fn(),
  translateLanguagesDelete: vi.fn(),
  translateLanguagesPut: vi.fn(),
  transaction: vi.fn(async (...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      await callback()
    }
  }),
  createHydrateAction:
    (type: string) =>
    (payload: unknown): { type: string; payload: unknown } => ({ type, payload })
}))

vi.mock('@renderer/databases', () => ({
  default: {
    knowledge_notes: {
      delete: mocks.knowledgeNotesDelete,
      put: mocks.knowledgeNotesPut
    },
    quick_phrases: {
      delete: mocks.quickPhrasesDelete,
      put: mocks.quickPhrasesPut
    },
    settings: {
      delete: mocks.settingsDelete,
      put: mocks.settingsPut
    },
    translate_history: {
      delete: mocks.translateHistoryDelete,
      put: mocks.translateHistoryPut
    },
    translate_languages: {
      delete: mocks.translateLanguagesDelete,
      put: mocks.translateLanguagesPut
    },
    transaction: mocks.transaction
  }
}))

vi.mock('../StorageV2Service', () => ({
  getStorageV2CoreSnapshot: mocks.getStorageV2CoreSnapshot
}))

vi.mock('@renderer/store/assistants', () => ({
  hydrateAssistantsState: mocks.createHydrateAction('assistants/hydrate')
}))

vi.mock('@renderer/store/backup', () => ({
  hydrateBackupState: mocks.createHydrateAction('backup/hydrate')
}))

vi.mock('@renderer/store/codeTools', () => ({
  hydrateCodeToolsState: mocks.createHydrateAction('codeTools/hydrate')
}))

vi.mock('@renderer/store/copilot', () => ({
  hydrateCopilotState: mocks.createHydrateAction('copilot/hydrate')
}))

vi.mock('@renderer/store/inputTools', () => ({
  hydrateInputToolsState: mocks.createHydrateAction('inputTools/hydrate')
}))

vi.mock('@renderer/store/knowledge', () => ({
  hydrateKnowledgeState: mocks.createHydrateAction('knowledge/hydrate')
}))

vi.mock('@renderer/store/llm', () => ({
  hydrateLlmState: mocks.createHydrateAction('llm/hydrate')
}))

vi.mock('@renderer/store/mcp', () => ({
  hydrateMcpState: mocks.createHydrateAction('mcp/hydrate')
}))

vi.mock('@renderer/store/memory', () => ({
  hydrateMemoryState: mocks.createHydrateAction('memory/hydrate')
}))

vi.mock('@renderer/store/minapps', () => ({
  hydrateMinAppsState: mocks.createHydrateAction('minApps/hydrate')
}))

vi.mock('@renderer/store/note', () => ({
  hydrateNoteState: mocks.createHydrateAction('note/hydrate')
}))

vi.mock('@renderer/store/nutstore', () => ({
  hydrateNutstoreState: mocks.createHydrateAction('nutstore/hydrate')
}))

vi.mock('@renderer/store/ocr', () => ({
  hydrateOcrState: mocks.createHydrateAction('ocr/hydrate')
}))

vi.mock('@renderer/store/openclaw', () => ({
  hydrateOpenClawState: mocks.createHydrateAction('openclaw/hydrate')
}))

vi.mock('@renderer/store/paintings', () => ({
  hydratePaintingsState: mocks.createHydrateAction('paintings/hydrate')
}))

vi.mock('@renderer/store/preprocess', () => ({
  hydratePreprocessState: mocks.createHydrateAction('preprocess/hydrate')
}))

vi.mock('@renderer/store/selectionStore', () => ({
  hydrateSelectionState: mocks.createHydrateAction('selectionStore/hydrate')
}))

vi.mock('@renderer/store/settings', () => ({
  hydrateSettingsState: mocks.createHydrateAction('settings/hydrate')
}))

vi.mock('@renderer/store/shortcuts', () => ({
  hydrateShortcutsState: mocks.createHydrateAction('shortcuts/hydrate')
}))

vi.mock('@renderer/store/translate', () => ({
  hydrateTranslateState: mocks.createHydrateAction('translate/hydrate')
}))

vi.mock('@renderer/store/websearch', () => ({
  hydrateWebSearchState: mocks.createHydrateAction('websearch/hydrate')
}))

import { maybeHydrateRuntimeCacheFromStorageV2 } from '../StorageV2HydrationService'

describe('StorageV2HydrationService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.clearAllMocks()
    originalApi = window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          getCoreSnapshot: vi.fn(),
          getSetting: vi.fn().mockResolvedValue({ enabled: true })
        }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('does not treat internal Storage v2 settings as recoverable runtime data', async () => {
    mocks.getStorageV2CoreSnapshot.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      settings: {},
      llm: { providers: [] },
      assistants: { assistants: [] },
      redux: {},
      localStorage: {},
      metadata: {
        includeSecrets: true,
        settingCount: 1,
        providerCount: 0,
        assistantCount: 0,
        topicCount: 0,
        reduxSliceCount: 0,
        missingSecretCount: 0
      }
    })
    const target = { dispatch: vi.fn(), flush: vi.fn() }

    await expect(maybeHydrateRuntimeCacheFromStorageV2(target)).resolves.toEqual({
      hydrated: false,
      reason: 'empty'
    })
    expect(target.dispatch).not.toHaveBeenCalled()
    expect(target.flush).not.toHaveBeenCalled()
  })

  it('does not read the Storage v2 snapshot when auto hydrate is disabled and bootstrap is not requested', async () => {
    ;(window.api.storageV2.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: false })
    const target = { dispatch: vi.fn(), flush: vi.fn(), shouldHydrateWhenDisabled: vi.fn(() => false) }

    await expect(maybeHydrateRuntimeCacheFromStorageV2(target)).resolves.toEqual({
      hydrated: false,
      reason: 'disabled'
    })

    expect(target.shouldHydrateWhenDisabled).toHaveBeenCalled()
    expect(mocks.getStorageV2CoreSnapshot).not.toHaveBeenCalled()
    expect(target.dispatch).not.toHaveBeenCalled()
  })

  it('bootstraps from Storage v2 when auto hydrate is disabled but the Redux persist cache is missing', async () => {
    ;(window.api.storageV2.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: false })
    mocks.getStorageV2CoreSnapshot.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      settings: { language: 'zh-CN' },
      llm: {
        providers: [
          {
            id: 'openai',
            name: 'OpenAI'
          }
        ]
      },
      assistants: { assistants: [] },
      redux: {},
      localStorage: {},
      metadata: {
        includeSecrets: true,
        settingCount: 1,
        providerCount: 1,
        assistantCount: 0,
        topicCount: 0,
        reduxSliceCount: 0,
        missingSecretCount: 0
      }
    })
    const target = { dispatch: vi.fn(), flush: vi.fn(), shouldHydrateWhenDisabled: vi.fn(() => true) }

    await expect(maybeHydrateRuntimeCacheFromStorageV2(target)).resolves.toEqual({
      hydrated: true,
      snapshot: expect.objectContaining({
        settings: { language: 'zh-CN' }
      })
    })

    expect(target.shouldHydrateWhenDisabled).toHaveBeenCalled()
    expect(mocks.getStorageV2CoreSnapshot).toHaveBeenCalledWith({ includeSecrets: true })
    expect(target.dispatch).toHaveBeenCalledWith({ type: 'settings/hydrate', payload: { language: 'zh-CN' } })
    expect(target.dispatch).toHaveBeenCalledWith({
      type: 'llm/hydrate',
      payload: {
        providers: [
          {
            id: 'openai',
            name: 'OpenAI'
          }
        ]
      }
    })
    expect(target.flush).toHaveBeenCalled()
  })

  it('does not treat localStorage token clear markers alone as recoverable runtime data', async () => {
    mocks.getStorageV2CoreSnapshot.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      settings: {},
      llm: { providers: [] },
      assistants: { assistants: [] },
      redux: {},
      localStorage: {
        clearedMcpProviderTokenKeys: ['mcprouter_token', 'modelscope_token'],
        durableValues: {},
        mcpProviderTokens: {}
      },
      metadata: {
        includeSecrets: true,
        settingCount: 2,
        providerCount: 0,
        assistantCount: 0,
        topicCount: 0,
        reduxSliceCount: 0,
        missingSecretCount: 0
      }
    })
    const target = { dispatch: vi.fn(), flush: vi.fn() }

    await expect(maybeHydrateRuntimeCacheFromStorageV2(target)).resolves.toEqual({
      hydrated: false,
      reason: 'empty'
    })
    expect(target.dispatch).not.toHaveBeenCalled()
    expect(target.flush).not.toHaveBeenCalled()
  })

  it('hydrates Dexie settings from Storage v2 into the legacy runtime cache', async () => {
    mocks.getStorageV2CoreSnapshot.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      settings: {},
      llm: { providers: [] },
      assistants: { assistants: [] },
      redux: {},
      localStorage: {},
      dexieSettings: {
        'pinned:models': ['openai:gpt-4o'],
        'image://avatar': null
      },
      metadata: {
        includeSecrets: true,
        settingCount: 2,
        providerCount: 0,
        assistantCount: 0,
        topicCount: 0,
        reduxSliceCount: 0,
        missingSecretCount: 0
      }
    })
    const target = { dispatch: vi.fn(), flush: vi.fn() }

    await expect(maybeHydrateRuntimeCacheFromStorageV2(target)).resolves.toEqual({
      hydrated: true,
      snapshot: expect.objectContaining({
        dexieSettings: expect.any(Object)
      })
    })

    expect(mocks.transaction).toHaveBeenCalled()
    expect(mocks.settingsPut).toHaveBeenCalledWith({
      id: 'pinned:models',
      value: ['openai:gpt-4o']
    })
    expect(mocks.settingsDelete).toHaveBeenCalledWith('image://avatar')
  })

  it('hydrates Dexie auxiliary tables from Storage v2 into the legacy runtime cache', async () => {
    mocks.getStorageV2CoreSnapshot.mockResolvedValue({
      generatedAt: '2026-01-01T00:00:00.000Z',
      settings: {},
      llm: { providers: [] },
      assistants: { assistants: [] },
      redux: {},
      localStorage: {},
      dexieTables: {
        quick_phrases: {
          'phrase-1': {
            id: 'phrase-1',
            title: 'Greeting',
            content: 'Hello',
            createdAt: 1760000000000,
            updatedAt: 1760000000000
          }
        },
        knowledge_notes: {
          'note-1': null
        }
      },
      metadata: {
        includeSecrets: true,
        settingCount: 2,
        providerCount: 0,
        assistantCount: 0,
        topicCount: 0,
        reduxSliceCount: 0,
        dexieTableRowCount: 2,
        missingSecretCount: 0
      }
    })
    const target = { dispatch: vi.fn(), flush: vi.fn() }

    await expect(maybeHydrateRuntimeCacheFromStorageV2(target)).resolves.toEqual({
      hydrated: true,
      snapshot: expect.objectContaining({
        dexieTables: expect.any(Object)
      })
    })

    expect(mocks.quickPhrasesPut).toHaveBeenCalledWith({
      id: 'phrase-1',
      title: 'Greeting',
      content: 'Hello',
      createdAt: 1760000000000,
      updatedAt: 1760000000000
    })
    expect(mocks.knowledgeNotesDelete).toHaveBeenCalledWith('note-1')
  })
})
