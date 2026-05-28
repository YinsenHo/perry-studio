import { createSelector } from '@reduxjs/toolkit'
import { isNotSupportTextDeltaModel } from '@renderer/config/models'
import { CHERRYAI_PROVIDER } from '@renderer/config/providers'
import { getDefaultProvider } from '@renderer/services/AssistantService'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addModel,
  addProvider,
  removeModel,
  removeProvider,
  updateModel,
  updateProvider,
  updateProviders
} from '@renderer/store/llm'
import type { Assistant, Model, Provider } from '@renderer/types'
import { isSystemProvider } from '@renderer/types'
import { withoutTrailingSlash } from '@renderer/utils/api'
import { isNewApiProvider } from '@renderer/utils/provider'
import { useCallback, useMemo } from 'react'

import { useDefaultModel } from './useAssistant'

/**
 * Normalizes provider apiHost by removing trailing slashes.
 * This ensures consistent URL concatenation across the application.
 */
function normalizeProvider<T extends Provider>(provider: T): T {
  return {
    ...provider,
    apiHost: withoutTrailingSlash(provider.apiHost)
  }
}

const flushProviderMirror = (reason: string) => {
  void flushStorageV2ReduxMirror(reason)
}

const selectProviders = (state: RootState) => state.llm.providers

const selectEnabledProviders = createSelector(selectProviders, (providers) =>
  providers
    .map(normalizeProvider)
    .filter((p) => p.enabled)
    .concat(CHERRYAI_PROVIDER)
)

const selectSystemProviders = createSelector(selectProviders, (providers) =>
  providers.filter((p) => isSystemProvider(p)).map(normalizeProvider)
)

const selectUserProviders = createSelector(selectProviders, (providers) =>
  providers.filter((p) => !isSystemProvider(p)).map(normalizeProvider)
)

const selectAllProviders = createSelector(selectProviders, (providers) => providers.map(normalizeProvider))

const selectAllProvidersWithCherryAI = createSelector(selectProviders, (providers) =>
  [...providers, CHERRYAI_PROVIDER].map(normalizeProvider)
)

export function useProviders() {
  const providers: Provider[] = useAppSelector(selectEnabledProviders)
  const dispatch = useAppDispatch()

  return {
    providers: providers || [],
    addProvider: (provider: Provider) => {
      dispatch(addProvider(provider))
      flushProviderMirror('llm-add-provider')
    },
    removeProvider: (provider: Provider) => {
      dispatch(removeProvider(provider))
      flushProviderMirror('llm-remove-provider')
    },
    updateProvider: (updates: Partial<Provider> & { id: string }) => {
      dispatch(updateProvider(updates))
      flushProviderMirror('llm-update-provider')
    },
    updateProviders: (providers: Provider[]) => {
      dispatch(updateProviders(providers))
      flushProviderMirror('llm-update-providers')
    }
  }
}

export function useSystemProviders() {
  return useAppSelector(selectSystemProviders)
}

export function useUserProviders() {
  return useAppSelector(selectUserProviders)
}

export function useAllProviders() {
  return useAppSelector(selectAllProviders)
}

export function useProvider(id: string) {
  const allProviders = useAppSelector(selectAllProvidersWithCherryAI)
  const provider = useMemo(() => allProviders.find((p) => p.id === id) || getDefaultProvider(), [allProviders, id])
  const dispatch = useAppDispatch()

  const handleAddModel = useCallback(
    (model: Model) => {
      let processedModel = { ...model, supported_text_delta: !isNotSupportTextDeltaModel(model) }

      if (isNewApiProvider(provider)) {
        const endpointTypes = model.supported_endpoint_types
        if (endpointTypes && endpointTypes.length > 0) {
          processedModel = {
            ...processedModel,
            endpoint_type: endpointTypes.includes('image-generation') ? 'image-generation' : endpointTypes[0]
          }
        }
      }

      dispatch(addModel({ providerId: id, model: processedModel }))
      flushProviderMirror('llm-add-model')
    },
    [dispatch, id, provider]
  )

  return {
    provider,
    models: provider?.models ?? [],
    updateProvider: (updates: Partial<Provider>) => {
      dispatch(updateProvider({ id, ...updates }))
      flushProviderMirror('llm-update-provider')
    },
    addModel: handleAddModel,
    removeModel: (model: Model) => {
      dispatch(removeModel({ providerId: id, model }))
      flushProviderMirror('llm-remove-model')
    },
    updateModel: (model: Model) => {
      dispatch(updateModel({ providerId: id, model }))
      flushProviderMirror('llm-update-model')
    }
  }
}

export function useProviderByAssistant(assistant: Assistant) {
  const { defaultModel } = useDefaultModel()
  const model = assistant.model || defaultModel
  const { provider } = useProvider(model?.provider ?? '')
  return provider
}
