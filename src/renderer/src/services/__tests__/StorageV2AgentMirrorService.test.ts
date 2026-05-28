import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('StorageV2AgentMirrorService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('rejects strict flushes when the agent database mirror is still pending after failure', async () => {
    const importLegacyAgentDb = vi.fn().mockRejectedValue(new Error('agents.db locked'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyAgentDb
        }
      }
    })

    const { storageV2AgentMirrorService } = await import('../StorageV2AgentMirrorService')

    storageV2AgentMirrorService.schedule(1000)

    await expect(storageV2AgentMirrorService.flushStrict()).rejects.toThrow('agents.db locked')
    expect(importLegacyAgentDb).toHaveBeenCalledWith({ dryRun: false, createSnapshot: false })
  })

  it('rejects strict flushes when Storage v2 API is unavailable with pending agent work', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { storageV2AgentMirrorService } = await import('../StorageV2AgentMirrorService')

    storageV2AgentMirrorService.schedule(1000)

    await expect(storageV2AgentMirrorService.flushStrict()).rejects.toThrow(
      'Storage v2 API unavailable while agent database mirror work is pending'
    )
  })
})
