import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import { persistStorageV2ReduxSlice } from '@renderer/services/StorageV2ReduxSliceService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addSubscribeSource as _addSubscribeSource,
  type CompressionConfig,
  removeSubscribeSource as _removeSubscribeSource,
  setCompressionConfig,
  setDefaultProvider as _setDefaultProvider,
  setSubscribeSources as _setSubscribeSources,
  updateCompressionConfig,
  updateSubscribeBlacklist as _updateSubscribeBlacklist,
  updateWebSearchProvider,
  updateWebSearchProviders
} from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderId } from '@renderer/types'

function flushWebSearchMirror(reason: string): void
function flushWebSearchMirror(reason: string, options: { strict: true }): Promise<void>
function flushWebSearchMirror(reason: string, options?: { strict?: boolean }) {
  const task = flushStorageV2ReduxMirror(reason, options)
  if (options?.strict) return task
  void task
  return undefined
}

export const useDefaultWebSearchProvider = () => {
  const defaultProvider = useAppSelector((state) => state.websearch.defaultProvider)
  const { providers } = useWebSearchProviders()
  const provider = defaultProvider ? providers.find((provider) => provider.id === defaultProvider) : undefined
  const dispatch = useAppDispatch()

  const setDefaultProvider = (provider: WebSearchProvider) => {
    dispatch(_setDefaultProvider(provider.id))
    flushWebSearchMirror('websearch-default-provider')
  }

  const updateDefaultProvider = (provider: WebSearchProvider) => {
    dispatch(updateWebSearchProvider(provider))
    flushWebSearchMirror('websearch-update-default-provider')
  }

  return { provider, setDefaultProvider, updateDefaultProvider }
}

export const useWebSearchProviders = () => {
  const providers = useAppSelector((state) => state.websearch.providers)

  const dispatch = useAppDispatch()

  return {
    providers,
    updateWebSearchProviders: (providers: WebSearchProvider[]) => {
      dispatch(updateWebSearchProviders(providers))
      flushWebSearchMirror('websearch-update-providers')
    },
    addWebSearchProvider: (provider: WebSearchProvider) => {
      // Check if provider exists
      const exists = providers.some((p) => p.id === provider.id)
      if (!exists) {
        // Use the existing update action to add the new provider
        dispatch(updateWebSearchProviders([...providers, provider]))
        flushWebSearchMirror('websearch-add-provider')
      }
    }
  }
}

export const useWebSearchProvider = (id: WebSearchProviderId) => {
  const providers = useAppSelector((state) => state.websearch.providers)
  const provider = providers.find((provider) => provider.id === id)
  const dispatch = useAppDispatch()

  if (!provider) {
    throw new Error(`Web search provider with id ${id} not found`)
  }

  return {
    provider,
    updateProvider: (updates: Partial<WebSearchProvider>) => {
      dispatch(updateWebSearchProvider({ id, ...updates }))
      flushWebSearchMirror('websearch-update-provider')
    }
  }
}

export const useBlacklist = () => {
  const dispatch = useAppDispatch()
  const websearch = useAppSelector((state) => state.websearch)

  const addSubscribeSource = ({ url, name, blacklist }) => {
    dispatch(_addSubscribeSource({ url, name, blacklist }))
    flushWebSearchMirror('websearch-add-subscribe-source')
  }

  const removeSubscribeSource = async (key: number) => {
    await persistStorageV2ReduxSlice('websearch', {
      ...websearch,
      subscribeSources: websearch.subscribeSources.filter((source) => source.key !== key)
    })
    dispatch(_removeSubscribeSource(key))
    await flushWebSearchMirror('websearch-remove-subscribe-source', { strict: true })
  }

  const updateSubscribeBlacklist = (key: number, blacklist: string[]) => {
    dispatch(_updateSubscribeBlacklist({ key, blacklist }))
    flushWebSearchMirror('websearch-update-subscribe-blacklist')
  }

  const setSubscribeSources = async (sources: { key: number; url: string; name: string; blacklist?: string[] }[]) => {
    await persistStorageV2ReduxSlice('websearch', {
      ...websearch,
      subscribeSources: sources
    })
    dispatch(_setSubscribeSources(sources))
    await flushWebSearchMirror('websearch-set-subscribe-sources', { strict: true })
  }

  return {
    websearch,
    addSubscribeSource,
    removeSubscribeSource,
    updateSubscribeBlacklist,
    setSubscribeSources
  }
}

export const useWebSearchSettings = () => {
  const state = useAppSelector((state) => state.websearch)
  const dispatch = useAppDispatch()

  return {
    ...state,
    setCompressionConfig: (config: CompressionConfig) => {
      dispatch(setCompressionConfig(config))
      flushWebSearchMirror('websearch-set-compression-config')
    },
    updateCompressionConfig: (config: Partial<CompressionConfig>) => {
      dispatch(updateCompressionConfig(config))
      flushWebSearchMirror('websearch-update-compression-config')
    }
  }
}
