import { createSelector } from '@reduxjs/toolkit'
import { isNotSupportTextDeltaModel } from '@renderer/config/models'
import { CHERRYAI_PROVIDER } from '@renderer/config/providers'
import { getDefaultProvider } from '@renderer/services/AssistantService'
import { deleteStorageV2Provider } from '@renderer/services/StorageV2EntityDeleteService'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import { persistStorageV2PartialReduxSnapshot } from '@renderer/services/StorageV2ReduxSliceService'
import { type RootState, useAppDispatch, useAppSelector, useAppStore } from '@renderer/store'
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

function flushProviderMirror(reason: string): void
function flushProviderMirror(reason: string, options: { strict: true }): Promise<void>
function flushProviderMirror(reason: string, options?: { strict?: boolean }) {
  const task = flushStorageV2ReduxMirror(reason, options)
  if (options?.strict) return task
  void task
  return undefined
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

function removeModelsFromLlmState(llmState: RootState['llm'], providerId: string, modelIds: Set<string>) {
  return {
    ...llmState,
    providers: llmState.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            models: provider.models.filter((model) => !modelIds.has(model.id))
          }
        : provider
    )
  }
}

export function useProviders() {
  const providers: Provider[] = useAppSelector(selectEnabledProviders)
  const dispatch = useAppDispatch()

  return {
    providers: providers || [],
    addProvider: (provider: Provider) => {
      dispatch(addProvider(provider))
      flushProviderMirror('llm-add-provider')
    },
    removeProvider: async (provider: Provider) => {
      await deleteStorageV2Provider(provider.id)
      dispatch(removeProvider(provider))
      await flushProviderMirror('llm-remove-provider', { strict: true })
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
  const reduxStore = useAppStore()

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

  const persistModelDeletes = useCallback(
    async (models: Model[]) => {
      const modelIds = new Set(models.map((model) => model.id))
      if (modelIds.size === 0) return

      const llmState = reduxStore.getState().llm
      const providerInState = llmState.providers.find((provider) => provider.id === id)
      if (!providerInState) return

      await persistStorageV2PartialReduxSnapshot({
        llm: removeModelsFromLlmState(llmState, id, modelIds)
      })
    },
    [id, reduxStore]
  )

  const handleRemoveModel = useCallback(
    async (model: Model) => {
      await persistModelDeletes([model])
      dispatch(removeModel({ providerId: id, model }))
      await flushProviderMirror('llm-remove-model', { strict: true })
    },
    [dispatch, id, persistModelDeletes]
  )

  const handleRemoveModels = useCallback(
    async (models: Model[]) => {
      await persistModelDeletes(models)

      models.forEach((model) => {
        dispatch(removeModel({ providerId: id, model }))
      })

      await flushProviderMirror('llm-remove-models', { strict: true })
    },
    [dispatch, id, persistModelDeletes]
  )

  return {
    provider,
    models: provider?.models ?? [],
    updateProvider: (updates: Partial<Provider>) => {
      dispatch(updateProvider({ id, ...updates }))
      flushProviderMirror('llm-update-provider')
    },
    addModel: handleAddModel,
    removeModel: handleRemoveModel,
    removeModels: handleRemoveModels,
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
