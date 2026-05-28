import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyStorageV2LocalStorageSnapshot,
  flushStorageV2LocalStorageMirror,
  getStorageV2LocalStorageSnapshot,
  scheduleStorageV2LocalStorageMirror
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
})
