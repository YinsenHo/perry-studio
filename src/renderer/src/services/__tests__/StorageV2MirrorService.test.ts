import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createState = () => ({
  assistants: {},
  backup: {},
  codeTools: {},
  copilot: {},
  inputTools: {},
  knowledge: {},
  llm: {},
  mcp: {},
  memory: {},
  minapps: {},
  note: {},
  nutstore: {},
  ocr: {},
  openclaw: {},
  paintings: {},
  preprocess: {},
  selectionStore: {},
  settings: { language: 'zh-CN' },
  shortcuts: {},
  translate: {},
  websearch: {}
})

describe('StorageV2MirrorService', () => {
  let importLegacyReduxSnapshot: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    importLegacyReduxSnapshot = vi.fn().mockResolvedValue({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('waits for startup hydration flow instead of mirroring persisted cache on REHYDRATE', async () => {
    const { storageV2MirrorService } = await import('../StorageV2MirrorService')
    const middleware = storageV2MirrorService.createMiddleware()({
      dispatch: vi.fn(),
      getState: createState
    } as any)(vi.fn((action) => action))

    middleware({ type: 'persist/REHYDRATE' })
    await vi.advanceTimersByTimeAsync(1500)

    expect(importLegacyReduxSnapshot).not.toHaveBeenCalled()

    middleware({ type: 'settings/setLanguage' })
    await vi.advanceTimersByTimeAsync(1500)

    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)
  })

  it('pauses startup mirror work until runtime hydration is complete', async () => {
    const { storageV2MirrorService } = await import('../StorageV2MirrorService')
    const middleware = storageV2MirrorService.createMiddleware()({
      dispatch: vi.fn(),
      getState: createState
    } as any)(vi.fn((action) => action))

    storageV2MirrorService.pauseRuntimeMirroring()
    middleware({ type: 'settings/setLanguage' })
    await vi.advanceTimersByTimeAsync(1500)

    expect(importLegacyReduxSnapshot).not.toHaveBeenCalled()

    storageV2MirrorService.resumeRuntimeMirroring()
    storageV2MirrorService.schedule(createState, 0)
    await vi.advanceTimersByTimeAsync(1)

    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)
  })

  it('flushes high-value settings actions without waiting for debounce', async () => {
    const { storageV2MirrorService } = await import('../StorageV2MirrorService')
    const middleware = storageV2MirrorService.createMiddleware()({
      dispatch: vi.fn(),
      getState: createState
    } as any)(vi.fn((action) => action))

    middleware({ type: 'settings/setS3Partial' })

    await vi.waitFor(() => {
      expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)
    })
  })

  it('flushes persisted redux configuration slices without waiting for debounce', async () => {
    const { storageV2MirrorService } = await import('../StorageV2MirrorService')
    const middleware = storageV2MirrorService.createMiddleware()({
      dispatch: vi.fn(),
      getState: createState
    } as any)(vi.fn((action) => action))

    middleware({ type: 'minApps/setPinnedMinApps' })

    await vi.waitFor(() => {
      expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)
    })
  })
})
