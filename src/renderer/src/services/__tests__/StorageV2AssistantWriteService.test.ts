import type { Assistant } from '@renderer/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const assistant = (id: string, topics: Assistant['topics'] = []): Assistant => ({
  id,
  name: id,
  prompt: '',
  topics,
  type: 'assistant'
})

const waitForCallCount = async (mock: ReturnType<typeof vi.fn>, count: number) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (mock.mock.calls.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('StorageV2AssistantWriteService', () => {
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

  it('upserts assistant lists with stable sort order before Redux state is changed', async () => {
    const upsertAssistant = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertAssistant
        }
      }
    })

    const { upsertStorageV2AssistantList } = await import('../StorageV2AssistantWriteService')

    await upsertStorageV2AssistantList([assistant('assistant-a'), assistant('assistant-b')])

    expect(upsertAssistant).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'assistant-a' }), 0)
    expect(upsertAssistant).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'assistant-b' }), 1)
  })

  it('queues mutations for the same assistant so rapid writes build on pending state', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    const upsertAssistant = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        storageV2: {
          upsertAssistant
        }
      }
    })

    const { mutateStorageV2AssistantFirst } = await import('../StorageV2AssistantWriteService')
    const assistants = [assistant('assistant-a')]

    const firstWrite = mutateStorageV2AssistantFirst('assistant-a', assistants, (current) => ({
      ...current,
      prompt: 'first'
    }))
    const secondWrite = mutateStorageV2AssistantFirst('assistant-a', assistants, (current) => ({
      ...current,
      name: 'Second'
    }))

    await waitForCallCount(upsertAssistant, 1)

    expect(upsertAssistant).toHaveBeenCalledTimes(1)
    const assistantWrites = upsertAssistant.mock.calls as unknown as Array<[Assistant, number]>
    expect(assistantWrites[0]?.[0]).toEqual(expect.objectContaining({ prompt: 'first', name: 'assistant-a' }))

    resolvers[0](undefined)
    await waitForCallCount(upsertAssistant, 2)

    expect(upsertAssistant).toHaveBeenCalledTimes(2)
    expect(assistantWrites[1]?.[0]).toEqual(expect.objectContaining({ prompt: 'first', name: 'Second' }))

    resolvers[1](undefined)
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([
      expect.objectContaining({ id: 'assistant-a' }),
      expect.objectContaining({ id: 'assistant-a' })
    ])
  })

  it('rejects assistant upserts when the Storage v2 API is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })

    const { upsertStorageV2Assistant } = await import('../StorageV2AssistantWriteService')

    await expect(upsertStorageV2Assistant(assistant('assistant-a'))).rejects.toThrow(
      'Storage v2 assistant upsert API unavailable'
    )
  })
})
