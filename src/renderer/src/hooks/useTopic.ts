import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { safeDeleteFiles } from '@renderer/services/MessagesService'
import { mutateStorageV2AssistantFirst } from '@renderer/services/StorageV2AssistantWriteService'
import {
  fetchStorageV2TopicMessages,
  hydrateStorageV2ConversationsIfDexieEmpty
} from '@renderer/services/StorageV2ConversationHydrationService'
import { storageV2ConversationMirrorService } from '@renderer/services/StorageV2ConversationMirrorService'
import store from '@renderer/store'
import { updateTopic } from '@renderer/store/assistants'
import { setNewlyRenamedTopics, setRenamingTopics } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { findMainTextBlocks } from '@renderer/utils/messageUtils/find'
import { truncateText } from '@renderer/utils/naming'
import { find, isEmpty } from 'lodash'
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'

import { useAssistant } from './useAssistant'
import { getStoreSetting } from './useSettings'

let _activeTopic: Topic
let _setActiveTopic: Dispatch<SetStateAction<Topic>>

const logger = loggerService.withContext('useTopic')

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const [activeTopic, setActiveTopic] = useState(topic || _activeTopic || assistant?.topics[0])

  _activeTopic = activeTopic
  _setActiveTopic = setActiveTopic

  useEffect(() => {
    if (activeTopic) {
      void store.dispatch(loadTopicMessagesThunk(activeTopic.id))
      void EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
    }
  }, [activeTopic])

  useEffect(() => {
    // activeTopic not in assistant.topics
    // 确保 assistant 和 assistant.topics 存在，避免在数据未完全加载时访问属性
    if (
      assistant &&
      assistant.topics &&
      Array.isArray(assistant.topics) &&
      assistant.topics.length > 0 &&
      !find(assistant.topics, { id: activeTopic?.id })
    ) {
      setActiveTopic(assistant.topics[0])
    }
  }, [activeTopic?.id, assistant])

  useEffect(() => {
    if (!assistant?.topics?.length || !activeTopic) {
      return
    }

    const latestTopic = assistant.topics.find((item) => item.id === activeTopic.id)
    if (latestTopic && latestTopic !== activeTopic) {
      setActiveTopic(latestTopic)
    }
  }, [assistant?.topics, activeTopic])

  return { activeTopic, setActiveTopic }
}

export function useTopic(assistant: Assistant, topicId?: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export function getTopic(assistant: Assistant, topicId: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export async function getTopicById(topicId: string) {
  const assistants = store.getState().assistants.assistants
  const topics = assistants.map((assistant) => assistant.topics).flat()
  const topic = topics.find((topic) => topic.id === topicId)
  const messages = await TopicManager.getTopicMessages(topicId)
  return { ...topic, messages } as Topic
}

/**
 * 开始重命名指定话题
 */
export const startTopicRenaming = (topicId: string) => {
  const currentIds = store.getState().runtime.chat.renamingTopics
  if (!currentIds.includes(topicId)) {
    store.dispatch(setRenamingTopics([...currentIds, topicId]))
  }
}

/**
 * 完成重命名指定话题
 */
export const finishTopicRenaming = (topicId: string) => {
  const state = store.getState()

  // 1. 立即从 renamingTopics 移除
  const currentRenaming = state.runtime.chat.renamingTopics
  store.dispatch(setRenamingTopics(currentRenaming.filter((id) => id !== topicId)))

  // 2. 立即添加到 newlyRenamedTopics
  const currentNewlyRenamed = state.runtime.chat.newlyRenamedTopics
  store.dispatch(setNewlyRenamedTopics([...currentNewlyRenamed, topicId]))

  // 3. 延迟从 newlyRenamedTopics 移除
  setTimeout(() => {
    const current = store.getState().runtime.chat.newlyRenamedTopics
    store.dispatch(setNewlyRenamedTopics(current.filter((id) => id !== topicId)))
  }, 700)
}

const topicRenamingLocks = new Set<string>()

export const autoRenameTopic = async (assistant: Assistant, topicId: string) => {
  if (topicRenamingLocks.has(topicId)) {
    return
  }

  try {
    topicRenamingLocks.add(topicId)

    const topic = await getTopicById(topicId)
    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    if (isEmpty(topic.messages)) {
      return
    }

    if (topic.isNameManuallyEdited) {
      return
    }

    const applyTopicName = async (name: string) => {
      const data = { ...topic, name } as Topic
      if (topic.id === _activeTopic.id) {
        _setActiveTopic(data)
      }
      await mutateStorageV2AssistantFirst(assistant.id, store.getState().assistants.assistants, (assistant) => ({
        ...assistant,
        topics: (assistant.topics || []).map((currentTopic) =>
          currentTopic.id === data.id ? { ...data, messages: [] } : currentTopic
        )
      }))
      store.dispatch(updateTopic({ assistantId: assistant.id, topic: data }))
      storageV2ConversationMirrorService.scheduleTopic(topicId, () => store.getState())
    }

    const getFirstMessageName = () => {
      const message = topic.messages[0]
      const blocks = findMainTextBlocks(message)
      const text = blocks
        .map((block) => block.content)
        .join('\n\n')
        .trim()

      return truncateText(text)
    }

    if (!enableTopicNaming) {
      const topicName = getFirstMessageName()
      if (topicName) {
        try {
          startTopicRenaming(topicId)
          await applyTopicName(topicName)
        } finally {
          finishTopicRenaming(topicId)
        }
      }
      return
    }

    if (topic && topic.name === i18n.t('chat.default.topic.name') && topic.messages.length >= 2) {
      startTopicRenaming(topicId)
      try {
        const { text: summaryText, error } = await fetchMessagesSummary({ messages: topic.messages })
        if (summaryText) {
          await applyTopicName(summaryText)
        } else {
          if (error) {
            window.toast?.error(`${i18n.t('message.error.fetchTopicName')}: ${error}`)
          }
          const fallbackName = getFirstMessageName()
          if (fallbackName) {
            await applyTopicName(fallbackName)
          }
        }
      } finally {
        finishTopicRenaming(topicId)
      }
    }
  } finally {
    topicRenamingLocks.delete(topicId)
  }
}

// Convert class to object with functions since class only has static methods
// 只有静态方法,没必要用class，可以export {}
export const TopicManager = {
  async getTopic(id: string) {
    let topic = await db.topics.get(id)
    if (topic) {
      return topic
    }

    const restored = await fetchStorageV2TopicMessages(id)
    if (!restored) {
      return undefined
    }

    topic = await db.topics.get(id)
    return topic ?? { id, messages: restored.messages }
  },

  async getAllTopics() {
    let topics = await db.topics.toArray()
    if (topics.length > 0) {
      return topics
    }

    await hydrateStorageV2ConversationsIfDexieEmpty('topic-manager-empty-list')
    topics = await db.topics.toArray()
    return topics
  },

  /**
   * 加载并返回指定话题的消息
   */
  async getTopicMessages(id: string) {
    const topic = await TopicManager.getTopic(id)
    if (!topic) return []

    await store.dispatch(loadTopicMessagesThunk(id))

    // 获取更新后的话题
    const updatedTopic = await TopicManager.getTopic(id)
    return updatedTopic?.messages || []
  },

  async removeTopic(id: string) {
    await TopicManager.clearTopicMessages(id)
    if (typeof window.api?.storageV2?.deleteConversation !== 'function') {
      throw new Error('Storage v2 conversation delete API unavailable')
    }

    try {
      await window.api.storageV2.deleteConversation(id)
    } catch (error) {
      logger.warn(`Failed to tombstone topic ${id} in Storage v2:`, error as Error)
      throw error
    }
    await db.topics.delete(id)
  },

  async clearTopicMessages(id: string): Promise<void> {
    // 暂存需要删除的文件信息
    let filesToDelete: FileMetadata[] = []
    const topic = await db.topics.get(id)

    if (!topic || !topic.messages || topic.messages.length === 0) {
      return
    }

    try {
      const blockIds = topic.messages.flatMap((message) => message.blocks || [])

      if (blockIds.length > 0) {
        const blocks = await db.message_blocks.where('id').anyOf(blockIds).toArray()

        filesToDelete = blocks
          .filter(
            (block): block is ImageMessageBlock | FileMessageBlock =>
              block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE
          )
          .map((block) => block.file)
          .filter((file) => file !== undefined)
      }

      await storageV2ConversationMirrorService.flushTopicMessagesSnapshot(id, () => store.getState(), [], {
        topic,
        destructive: true
      })

      await db.transaction('rw', [db.topics, db.message_blocks], async () => {
        if (blockIds.length > 0) {
          await db.message_blocks.bulkDelete(blockIds)
        }

        await db.topics.update(id, { messages: [] })
      })
    } catch (dbError) {
      logger.error(`Failed to clear database records for topic ${id}:`, dbError as Error)
      throw dbError
    }

    if (filesToDelete.length > 0) {
      await safeDeleteFiles(filesToDelete)
    }
  }
}
