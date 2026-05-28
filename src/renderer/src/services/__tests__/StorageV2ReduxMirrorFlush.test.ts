import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  flushStrict: vi.fn()
}))

vi.mock('../StorageV2MirrorService', () => ({
  storageV2MirrorService: {
    flush: mocks.flush,
    flushStrict: mocks.flushStrict
  }
}))

describe('flushStorageV2ReduxMirror', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.flush.mockResolvedValue(undefined)
    mocks.flushStrict.mockResolvedValue(undefined)
  })

  it('uses the normal mirror flush by default', async () => {
    const { flushStorageV2ReduxMirror } = await import('../StorageV2ReduxMirrorFlush')

    await flushStorageV2ReduxMirror('settings-update')

    expect(mocks.flush).toHaveBeenCalledTimes(1)
    expect(mocks.flushStrict).not.toHaveBeenCalled()
  })

  it('rethrows strict mirror failures', async () => {
    const { flushStorageV2ReduxMirror } = await import('../StorageV2ReduxMirrorFlush')
    mocks.flushStrict.mockRejectedValueOnce(new Error('storage locked'))

    await expect(flushStorageV2ReduxMirror('provider-delete', { strict: true })).rejects.toThrow('storage locked')

    expect(mocks.flushStrict).toHaveBeenCalledTimes(1)
    expect(mocks.flush).not.toHaveBeenCalled()
  })
})
