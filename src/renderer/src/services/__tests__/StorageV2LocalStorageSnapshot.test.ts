import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyStorageV2LocalStorageSnapshot,
  flushStorageV2LocalStorageMirror,
  flushStorageV2LocalStorageMirrorStrict,
  getStorageV2LocalStorageSnapshot,
  scheduleStorageV2LocalStorageMirror,
  suspendStorageV2LocalStorageMirrorUntilReload
} from '../StorageV2LocalStorageSnapshot'

describe('StorageV2LocalStorageSnapshot', () => {
  let originalApi: unknown

  beforeEach(() => {
    originalApi = window.api
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('captures only durable localStorage values and MCP provider tokens', () => {
    localStorage.setItem('language', 'zh-CN')
    localStorage.setItem('memory_currentUserId', 'user-1')
    localStorage.setItem('privacy-popup-accepted', 'true')
    localStorage.setItem('mcprouter_token', 'mcprouter-secret')
    localStorage.setItem('modelscope_token', 'modelscope-secret')
    localStorage.setItem('unrelated-cache-key', 'ignore-me')

    expect(getStorageV2LocalStorageSnapshot()).toEqual({
      clearedMcpProviderTokenKeys: ['tokenLanyunToken', 'tokenflux_token', 'ai302_token', 'bailian_token'],
      durableValues: {
        language: 'zh-CN',
        memory_currentUserId: 'user-1',
        'privacy-popup-accepted': 'true'
      },
      mcpProviderTokens: {
        mcprouter_token: 'mcprouter-secret',
        modelscope_token: 'modelscope-secret'
      }
    })
  })

  it('restores durable localStorage values and MCP provider tokens into localStorage', () => {
    localStorage.setItem('mcprouter_token', 'old-token')

    applyStorageV2LocalStorageSnapshot({
      clearedMcpProviderTokenKeys: ['mcprouter_token', 'unexpected_token'],
      durableValues: {
        language: 'zh-CN',
        'onboarding-completed': 'true',
        unexpected_key: 'ignored'
      },
      mcpProviderTokens: {
        ai302_token: 'ai302-secret',
        bailian_token: 'bailian-secret',
        unexpected_token: 'ignored'
      }
    })

    expect(localStorage.getItem('language')).toBe('zh-CN')
    expect(localStorage.getItem('onboarding-completed')).toBe('true')
    expect(localStorage.getItem('unexpected_key')).toBeNull()
    expect(localStorage.getItem('mcprouter_token')).toBeNull()
    expect(localStorage.getItem('ai302_token')).toBe('ai302-secret')
    expect(localStorage.getItem('bailian_token')).toBe('bailian-secret')
    expect(localStorage.getItem('unexpected_token')).toBeNull()
  })

  it('mirrors the current localStorage snapshot to Storage v2 on demand', async () => {
    const importLegacyReduxSnapshot = vi.fn().mockResolvedValue({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })
    localStorage.setItem('onboarding-completed', 'true')
    localStorage.setItem('bailian_token', 'bailian-secret')

    await flushStorageV2LocalStorageMirror()

    expect(importLegacyReduxSnapshot).toHaveBeenCalledWith(
      {
        localStorage: {
          clearedMcpProviderTokenKeys: [
            'mcprouter_token',
            'modelscope_token',
            'tokenLanyunToken',
            'tokenflux_token',
            'ai302_token'
          ],
          durableValues: {
            'onboarding-completed': 'true'
          },
          mcpProviderTokens: {
            bailian_token: 'bailian-secret'
          }
        }
      },
      { dryRun: false }
    )
  })

  it('flushes scheduled durable localStorage mirrors immediately by default', async () => {
    const importLegacyReduxSnapshot = vi.fn().mockResolvedValue({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })
    localStorage.setItem('privacy-popup-accepted', 'true')

    scheduleStorageV2LocalStorageMirror()

    await vi.waitFor(() => {
      expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)
    })
  })

  it('retries durable localStorage mirrors after a transient Storage v2 failure', async () => {
    vi.useFakeTimers()
    const importLegacyReduxSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })
    localStorage.setItem('memory_currentUserId', 'user-retry')

    await flushStorageV2LocalStorageMirror()
    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(2)
    expect(importLegacyReduxSnapshot).toHaveBeenLastCalledWith(
      {
        localStorage: expect.objectContaining({
          durableValues: {
            memory_currentUserId: 'user-retry'
          }
        })
      },
      { dryRun: false }
    )
  })

  it('rejects strict durable localStorage flushes while a failed mirror is pending retry', async () => {
    vi.useFakeTimers()
    const importLegacyReduxSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })
    localStorage.setItem('language', 'strict-zh')

    await expect(flushStorageV2LocalStorageMirrorStrict()).rejects.toThrow('database busy')
    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(2)
  })

  it('rejects strict durable localStorage flushes when Storage v2 API is unavailable after scheduling', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })
    localStorage.setItem('language', 'api-missing')

    scheduleStorageV2LocalStorageMirror()

    await expect(flushStorageV2LocalStorageMirrorStrict()).rejects.toThrow(
      'Storage v2 API unavailable while durable localStorage mirror work is pending'
    )

    const importLegacyReduxSnapshot = vi.fn().mockResolvedValue({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })

    await flushStorageV2LocalStorageMirror()
    expect(importLegacyReduxSnapshot).toHaveBeenCalledTimes(1)
  })

  it('suspends scheduled durable localStorage mirrors until reload after restore', async () => {
    vi.useFakeTimers()
    const importLegacyReduxSnapshot = vi.fn().mockResolvedValue({ dryRun: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          importLegacyReduxSnapshot
        }
      }
    })
    localStorage.setItem('privacy-popup-accepted', 'restore-safe')

    scheduleStorageV2LocalStorageMirror(1000)
    suspendStorageV2LocalStorageMirrorUntilReload()
    await vi.advanceTimersByTimeAsync(1000)
    await flushStorageV2LocalStorageMirrorStrict()

    expect(importLegacyReduxSnapshot).not.toHaveBeenCalled()
  })
})
