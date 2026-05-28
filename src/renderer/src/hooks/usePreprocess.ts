import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import type { RootState } from '@renderer/store'
import { syncPreprocessProvider as _syncPreprocessProvider } from '@renderer/store/knowledge'
import {
  setDefaultPreprocessProvider as _setDefaultPreprocessProvider,
  updatePreprocessProvider as _updatePreprocessProvider,
  updatePreprocessProviders as _updatePreprocessProviders
} from '@renderer/store/preprocess'
import type { PreprocessProvider, PreprocessProviderId } from '@renderer/types'
import { useDispatch, useSelector } from 'react-redux'

const flushPreprocessMirror = (reason: string) => {
  void flushStorageV2ReduxMirror(reason)
}

export const usePreprocessProvider = (id: PreprocessProviderId) => {
  const dispatch = useDispatch()
  const preprocessProviders = useSelector((state: RootState) => state.preprocess.providers)
  const provider = preprocessProviders.find((provider) => provider.id === id)
  if (!provider) {
    throw new Error(`preprocess provider with id ${id} not found`)
  }

  return {
    provider,
    updateProvider: (updates: Partial<PreprocessProvider>) => {
      const payload = { id, ...updates }
      dispatch(_updatePreprocessProvider(payload))
      // 将更新同步到所有知识库中的引用
      if (updates.apiHost || updates.apiKey || updates.model) {
        dispatch(_syncPreprocessProvider(payload))
      }
      flushPreprocessMirror('preprocess-update-provider')
    }
  }
}

export const usePreprocessProviders = () => {
  const dispatch = useDispatch()
  const preprocessProviders = useSelector((state: RootState) => state.preprocess.providers)
  return {
    preprocessProviders: preprocessProviders,
    updatePreprocessProviders: (preprocessProviders: PreprocessProvider[]) => {
      dispatch(_updatePreprocessProviders(preprocessProviders))
      flushPreprocessMirror('preprocess-update-providers')
    }
  }
}

export const useDefaultPreprocessProvider = () => {
  const defaultProviderId = useSelector((state: RootState) => state.preprocess.defaultProvider)
  const { preprocessProviders } = usePreprocessProviders()
  const dispatch = useDispatch()
  const provider = defaultProviderId
    ? preprocessProviders.find((provider) => provider.id === defaultProviderId)
    : undefined

  const setDefaultPreprocessProvider = (preprocessProvider: PreprocessProvider) => {
    dispatch(_setDefaultPreprocessProvider(preprocessProvider.id))
    flushPreprocessMirror('preprocess-default-provider')
  }
  const updateDefaultPreprocessProvider = (preprocessProvider: PreprocessProvider) => {
    dispatch(_updatePreprocessProvider(preprocessProvider))
    flushPreprocessMirror('preprocess-update-default-provider')
  }
  return { provider, setDefaultPreprocessProvider, updateDefaultPreprocessProvider }
}
