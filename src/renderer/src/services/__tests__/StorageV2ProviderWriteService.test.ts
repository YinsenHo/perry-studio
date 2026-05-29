import type { Provider } from '@renderer/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const provider = (id: string, models: Provider['models'] = []): Provider => ({
  id,
  type: 'openai',
  name: id,
  apiKey: '',
  apiHost: '',
  models,
  enabled: true
})

const waitForCallCount = async (mock: ReturnType<typeof vi.fn>, count: number) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (mock.mock.calls.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('StorageV2ProviderWriteService', () => {
  let originalApi: unknown

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    originalApi = window.api
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi
    })
  })

  it('upserts provider lists with stable sort order before Redux state is changed', async () => {
    const upsertProvider = vi.fn().mockResolvedValue({ skippedSecret: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertProvider
        }
      }
    })

    const { upsertStorageV2ProviderList } = await import('../StorageV2ProviderWriteService')

    await upsertStorageV2ProviderList([provider('provider-a'), provider('provider-b')])

    expect(upsertProvider).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'provider-a' }), 0)
    expect(upsertProvider).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'provider-b' }), 1)
  })

  it('queues model mutations for the same provider so rapid writes build on pending state', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    const upsertProvider = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertProvider
        }
      }
    })

    const { mutateStorageV2ProviderFirst } = await import('../StorageV2ProviderWriteService')
    const providers = [provider('provider-a', [{ id: 'base', name: 'Base' } as Provider['models'][number]])]

    const firstWrite = mutateStorageV2ProviderFirst('provider-a', providers, (current) => ({
      ...current,
      models: current.models.concat({ id: 'model-a', name: 'Model A' } as Provider['models'][number])
    }))
    const secondWrite = mutateStorageV2ProviderFirst('provider-a', providers, (current) => ({
      ...current,
      models: current.models.concat({ id: 'model-b', name: 'Model B' } as Provider['models'][number])
    }))

    await waitForCallCount(upsertProvider, 1)

    expect(upsertProvider).toHaveBeenCalledTimes(1)
    const providerWrites = upsertProvider.mock.calls as unknown as Array<[Provider, number]>
    expect(providerWrites[0]?.[0].models.map((model) => model.id)).toEqual(['base', 'model-a'])

    resolvers[0]({ skippedSecret: false })
    await waitForCallCount(upsertProvider, 2)

    expect(upsertProvider).toHaveBeenCalledTimes(2)
    expect(providerWrites[1]?.[0].models.map((model) => model.id)).toEqual(['base', 'model-a', 'model-b'])

    resolvers[1]({ skippedSecret: false })
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([
      expect.objectContaining({ id: 'provider-a' }),
      expect.objectContaining({ id: 'provider-a' })
    ])
  })

  it('rejects provider upserts when the Storage v2 API is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { upsertStorageV2Provider } = await import('../StorageV2ProviderWriteService')

    await expect(upsertStorageV2Provider(provider('provider-a'))).rejects.toThrow(
      'Storage v2 provider upsert API unavailable'
    )
  })
})
