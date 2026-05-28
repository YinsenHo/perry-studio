import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import store, { useAppSelector } from '@renderer/store'
import {
  setAwsBedrockAccessKeyId,
  setAwsBedrockApiKey,
  setAwsBedrockAuthType,
  setAwsBedrockRegion,
  setAwsBedrockSecretAccessKey
} from '@renderer/store/llm'
import type { AwsBedrockAuthType } from '@renderer/types'
import { useDispatch } from 'react-redux'

export function useAwsBedrockSettings() {
  const settings = useAppSelector((state) => state.llm.settings.awsBedrock)
  const dispatch = useDispatch()

  return {
    ...settings,
    setAuthType: (authType: AwsBedrockAuthType) => {
      dispatch(setAwsBedrockAuthType(authType))
      void flushStorageV2ReduxMirror('aws-bedrock-auth-type')
    },
    setAccessKeyId: (accessKeyId: string) => {
      dispatch(setAwsBedrockAccessKeyId(accessKeyId))
      void flushStorageV2ReduxMirror('aws-bedrock-access-key-id')
    },
    setSecretAccessKey: (secretAccessKey: string) => {
      dispatch(setAwsBedrockSecretAccessKey(secretAccessKey))
      void flushStorageV2ReduxMirror('aws-bedrock-secret-access-key')
    },
    setApiKey: (apiKey: string) => {
      dispatch(setAwsBedrockApiKey(apiKey))
      void flushStorageV2ReduxMirror('aws-bedrock-api-key')
    },
    setRegion: (region: string) => {
      dispatch(setAwsBedrockRegion(region))
      void flushStorageV2ReduxMirror('aws-bedrock-region')
    }
  }
}

export function getAwsBedrockSettings() {
  return store.getState().llm.settings.awsBedrock
}

export function getAwsBedrockAuthType() {
  return store.getState().llm.settings.awsBedrock.authType
}

export function getAwsBedrockAccessKeyId() {
  return store.getState().llm.settings.awsBedrock.accessKeyId
}

export function getAwsBedrockSecretAccessKey() {
  return store.getState().llm.settings.awsBedrock.secretAccessKey
}

export function getAwsBedrockApiKey() {
  return store.getState().llm.settings.awsBedrock.apiKey
}

export function getAwsBedrockRegion() {
  return store.getState().llm.settings.awsBedrock.region
}
