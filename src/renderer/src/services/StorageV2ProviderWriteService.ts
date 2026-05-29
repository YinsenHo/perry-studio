import type { Provider } from '@renderer/types'

const pendingProviderById = new Map<string, Provider>()
const providerWriteQueueById = new Map<string, Promise<unknown>>()

function getUpsertProviderApi() {
  const upsertProvider = window.api?.storageV2?.upsertProvider

  if (typeof upsertProvider !== 'function') {
    throw new Error('Storage v2 provider upsert API unavailable')
  }

  return upsertProvider
}

function getSortOrder(providerId: string, providers: Provider[]) {
  const index = providers.findIndex((provider) => provider.id === providerId)
  return index === -1 ? 0 : index
}

export async function upsertStorageV2Provider(provider: Provider, sortOrder = 0) {
  return getUpsertProviderApi()(provider, sortOrder)
}

export async function upsertStorageV2ProviderList(providers: Provider[]) {
  const upsertProvider = getUpsertProviderApi()

  for (const [index, provider] of providers.entries()) {
    await upsertProvider(provider, index)
  }
}

export async function mutateStorageV2ProviderFirst(
  providerId: string,
  providers: Provider[],
  mutate: (provider: Provider) => Provider
) {
  const baseProvider = pendingProviderById.get(providerId) ?? providers.find((provider) => provider.id === providerId)

  if (!baseProvider) {
    return null
  }

  const nextProvider = mutate(baseProvider)
  const sortOrder = getSortOrder(providerId, providers)
  pendingProviderById.set(providerId, nextProvider)

  const previousQueue = providerWriteQueueById.get(providerId) ?? Promise.resolve()
  const writeTask = previousQueue.catch(() => undefined).then(() => upsertStorageV2Provider(nextProvider, sortOrder))
  const queuedTask = writeTask.finally(() => {
    if (pendingProviderById.get(providerId) === nextProvider) {
      pendingProviderById.delete(providerId)
    }

    if (providerWriteQueueById.get(providerId) === queuedTask) {
      providerWriteQueueById.delete(providerId)
    }
  })

  providerWriteQueueById.set(providerId, queuedTask)
  await queuedTask

  return nextProvider
}
