import { loggerService } from '@logger'
import {
  getThinkModelType,
  isSupportedReasoningEffortModel,
  isSupportedThinkingTokenModel,
  MODEL_SUPPORTED_OPTIONS,
  MODEL_SUPPORTED_REASONING_EFFORT
} from '@renderer/config/models'
import { db } from '@renderer/databases'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { storageV2ConversationMirrorService } from '@renderer/services/StorageV2ConversationMirrorService'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addAssistant,
  addTopic,
  insertAssistant,
  removeAllTopics,
  removeAssistant,
  removeTopic,
  setModel,
  updateAssistant,
  updateAssistants,
  updateAssistantSettings as _updateAssistantSettings,
  updateDefaultAssistant,
  updateTopic,
  updateTopics
} from '@renderer/store/assistants'
import { setDefaultModel, setQuickModel, setTranslateModel } from '@renderer/store/llm'
import type { Assistant, AssistantSettings, Model, Provider, ThinkingOption, Topic } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { TopicManager } from './useTopic'

const LOCAL_MODEL_PROVIDERS = new Set(['ollama', 'lmstudio', 'gpustack'])
const logger = loggerService.withContext('useAssistant')

async function removeTopicsFromRuntime(topicIds: Iterable<string>, reason: string) {
  const uniqueTopicIds = Array.from(new Set(Array.from(topicIds).filter(Boolean)))
  if (uniqueTopicIds.length === 0) return

  const results = await Promise.allSettled(uniqueTopicIds.map((topicId) => TopicManager.removeTopic(topicId)))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

  if (failures.length > 0) {
    logger.error(`Failed to remove ${failures.length} topic(s) from runtime before ${reason}`, failures[0].reason)
    throw failures[0].reason instanceof Error
      ? failures[0].reason
      : new Error(`Failed to remove ${failures.length} topic(s) before ${reason}`)
  }
}

const flushStorageV2TopicMirror = (topicId: string | undefined) => {
  if (!topicId) return
  void storageV2ConversationMirrorService.flushTopic(topicId, () => store.getState())
}

const flushStorageV2TopicMirrors = (topicIds: Iterable<string | undefined>) => {
  void storageV2ConversationMirrorService.flushTopics(topicIds, () => store.getState())
}

function flushAssistantMirror(reason: string): void
function flushAssistantMirror(reason: string, options: { strict: true }): Promise<void>
function flushAssistantMirror(reason: string, options?: { strict?: boolean }) {
  const task = flushStorageV2ReduxMirror(reason, options)
  if (options?.strict) return task
  void task
  return undefined
}

const pickFallbackModel = (providers: Provider[]): Model | undefined => {
  const provider = providers.find(
    (provider) =>
      provider.enabled &&
      provider.id !== 'cherryai' &&
      provider.models?.length &&
      (provider.apiKey?.trim() || provider.isAuthed || LOCAL_MODEL_PROVIDERS.has(provider.id))
  )
  const model = provider?.models?.[0]
  return model ? { ...model, provider: model.provider || provider.id } : undefined
}

export function useAssistants() {
  const { t } = useTranslation()
  const { assistants } = useAppSelector((state) => state.assistants)
  const dispatch = useAppDispatch()

  return {
    assistants,
    updateAssistants: (assistants: Assistant[]) => {
      dispatch(updateAssistants(assistants))
      flushAssistantMirror('assistants-update-list')
    },
    addAssistant: (assistant: Assistant) => {
      dispatch(addAssistant(assistant))
      flushAssistantMirror('assistants-add')
    },
    insertAssistant: (index: number, assistant: Assistant) => {
      dispatch(insertAssistant({ index, assistant }))
      flushAssistantMirror('assistants-insert')
    },
    copyAssistant: (assistant: Assistant): Assistant | undefined => {
      if (!assistant) {
        logger.error("assistant doesn't exists.")
        return
      }
      const index = assistants.findIndex((_assistant) => _assistant.id === assistant.id)
      const _assistant: Assistant = { ...assistant, id: uuid(), topics: [getDefaultTopic(assistant.id)] }
      if (index === -1) {
        logger.warn("Origin assistant's id not found. Fallback to addAssistant.")
        dispatch(addAssistant(_assistant))
        flushAssistantMirror('assistants-copy')
      } else {
        // 插入到后面
        try {
          dispatch(insertAssistant({ index: index + 1, assistant: _assistant }))
          flushAssistantMirror('assistants-copy')
        } catch (e) {
          logger.error('Failed to insert assistant', e as Error)
          window.toast.error(t('message.error.copy'))
        }
      }
      return _assistant
    },
    removeAssistant: async (id: string) => {
      const assistant = assistants.find((a) => a.id === id)
      const topics = assistant?.topics || []
      await removeTopicsFromRuntime(
        topics.map((topic) => topic.id),
        'assistant removal'
      )
      dispatch(removeAssistant({ id }))
      await flushAssistantMirror('assistants-remove', { strict: true })
    }
  }
}

export function useAssistant(id: string) {
  const assistant = useAppSelector((state) => state.assistants.assistants.find((a) => a.id === id) as Assistant)
  const fallbackModel = useAppSelector((state) => pickFallbackModel(state.llm.providers))
  const dispatch = useAppDispatch()
  const { defaultModel } = useDefaultModel()

  const model = useMemo(
    () => assistant?.model ?? assistant?.defaultModel ?? defaultModel ?? fallbackModel,
    [assistant, defaultModel, fallbackModel]
  )

  const normalizedTopics = useMemo(
    () => (Array.isArray(assistant?.topics) ? assistant.topics : []),
    [assistant?.topics]
  )
  const assistantWithModel = useMemo(
    () => ({ ...assistant, model, topics: normalizedTopics }),
    [assistant, model, normalizedTopics]
  )

  const settingsRef = useRef(assistant?.settings)

  useEffect(() => {
    settingsRef.current = assistant?.settings
  }, [assistant?.settings])

  const updateAssistantSettings = useCallback(
    (settings: Partial<AssistantSettings>) => {
      if (!assistant?.id) return

      dispatch(_updateAssistantSettings({ assistantId: assistant.id, settings }))
      flushAssistantMirror('assistant-settings-update')
    },
    [assistant?.id, dispatch]
  )

  // 当model变化时，同步reasoning effort为模型支持的合法值
  useEffect(() => {
    const settings = settingsRef.current
    if (settings) {
      const currentReasoningEffort = settings.reasoning_effort
      if (isSupportedThinkingTokenModel(model) || isSupportedReasoningEffortModel(model)) {
        const modelType = getThinkModelType(model)
        const supportedOptions = MODEL_SUPPORTED_OPTIONS[modelType]
        if (supportedOptions.every((option) => option !== currentReasoningEffort)) {
          const cache = settings.reasoning_effort_cache
          let fallbackOption: ThinkingOption

          // 选项不支持时，首先尝试恢复到上次使用的值
          if (cache && supportedOptions.includes(cache)) {
            fallbackOption = cache
          } else {
            // 灵活回退到支持的值
            // 注意：这里假设可用的options不会为空
            const enableThinking = currentReasoningEffort !== undefined
            fallbackOption = enableThinking
              ? MODEL_SUPPORTED_REASONING_EFFORT[modelType][0]
              : MODEL_SUPPORTED_OPTIONS[modelType][0]
          }

          updateAssistantSettings({
            reasoning_effort: fallbackOption === 'none' ? undefined : fallbackOption,
            reasoning_effort_cache: fallbackOption === 'none' ? undefined : fallbackOption,
            qwenThinkMode: fallbackOption === 'none' ? undefined : true
          })
        } else {
          // 对于支持的选项, 不再更新 cache.
        }
      } else {
        // 切换到非思考模型时保留cache
        updateAssistantSettings({
          reasoning_effort: undefined,
          reasoning_effort_cache: currentReasoningEffort,
          qwenThinkMode: undefined
        })
      }
    }
  }, [model, updateAssistantSettings])

  return {
    assistant: assistantWithModel,
    model,
    addTopic: (topic: Topic) => {
      dispatch(addTopic({ assistantId: assistant.id, topic }))
      flushStorageV2TopicMirror(topic.id)
    },
    removeTopic: async (topic: Topic) => {
      await removeTopicsFromRuntime([topic.id], 'topic removal')
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
      await flushAssistantMirror('assistant-topic-remove', { strict: true })
    },
    moveTopic: (topic: Topic, toAssistant: Assistant) => {
      dispatch(addTopic({ assistantId: toAssistant.id, topic: { ...topic, assistantId: toAssistant.id } }))
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
      // update topic messages in database
      void db.topics
        .where('id')
        .equals(topic.id)
        .modify((dbTopic) => {
          if (dbTopic.messages) {
            dbTopic.messages = dbTopic.messages.map((message) => ({
              ...message,
              assistantId: toAssistant.id
            }))
          }
        })
        .then(() => {
          flushStorageV2TopicMirror(topic.id)
        })
    },
    updateTopic: (topic: Topic) => {
      dispatch(updateTopic({ assistantId: assistant.id, topic }))
      flushStorageV2TopicMirror(topic.id)
    },
    updateTopics: (topics: Topic[]) => {
      dispatch(updateTopics({ assistantId: assistant.id, topics }))
      flushStorageV2TopicMirrors(topics.map((topic) => topic.id))
    },
    removeAllTopics: async () => {
      const replacementTopic = getDefaultTopic(assistant.id)
      await removeTopicsFromRuntime(
        normalizedTopics.map((topic) => topic.id),
        'topic reset'
      )
      await db.topics.put({ id: replacementTopic.id, messages: [] })
      dispatch(removeAllTopics({ assistantId: assistant.id, replacementTopic }))
      await flushAssistantMirror('assistant-topics-reset', { strict: true })
      flushStorageV2TopicMirror(replacementTopic.id)
    },
    setModel: useCallback(
      (model: Model) => {
        if (!assistant) return

        dispatch(setModel({ assistantId: assistant.id, model }))
        flushAssistantMirror('assistant-set-model')
      },
      [assistant, dispatch]
    ),
    updateAssistant: useCallback(
      (update: Partial<Omit<Assistant, 'id'>>) => {
        dispatch(updateAssistant({ id, ...update }))
        flushAssistantMirror('assistant-update')
      },
      [dispatch, id]
    ),
    updateAssistantSettings
  }
}

export function useDefaultAssistant() {
  const defaultAssistant = useAppSelector((state) => state.assistants.defaultAssistant)
  const dispatch = useAppDispatch()
  const memoizedTopics = useMemo(() => [getDefaultTopic(defaultAssistant.id)], [defaultAssistant.id])

  return {
    defaultAssistant: {
      ...defaultAssistant,
      topics: memoizedTopics
    },
    updateDefaultAssistant: (assistant: Assistant) => {
      dispatch(updateDefaultAssistant({ assistant }))
      flushAssistantMirror('default-assistant-update')
    }
  }
}

export function useDefaultModel() {
  const { defaultModel, quickModel, translateModel, providers } = useAppSelector((state) => state.llm)
  const fallbackModel = useMemo(() => pickFallbackModel(providers), [providers])
  const dispatch = useAppDispatch()

  return {
    defaultModel: defaultModel ?? fallbackModel,
    quickModel: quickModel ?? fallbackModel,
    translateModel: translateModel ?? fallbackModel,
    setDefaultModel: (model: Model) => {
      dispatch(setDefaultModel({ model }))
      flushAssistantMirror('llm-default-model')
    },
    setQuickModel: (model: Model) => {
      dispatch(setQuickModel({ model }))
      flushAssistantMirror('llm-quick-model')
    },
    setTranslateModel: (model: Model) => {
      dispatch(setTranslateModel({ model }))
      flushAssistantMirror('llm-translate-model')
    }
  }
}
