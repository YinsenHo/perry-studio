import type { Assistant } from '@renderer/types'

const pendingAssistantById = new Map<string, Assistant>()
const assistantWriteQueueById = new Map<string, Promise<unknown>>()

function getUpsertAssistantApi() {
  const upsertAssistant = window.api?.storageV2?.upsertAssistant

  if (typeof upsertAssistant !== 'function') {
    throw new Error('Storage v2 assistant upsert API unavailable')
  }

  return upsertAssistant
}

function getSortOrder(assistantId: string, assistants: Assistant[]) {
  const index = assistants.findIndex((assistant) => assistant.id === assistantId)
  return index === -1 ? 0 : index
}

export async function upsertStorageV2Assistant(assistant: Assistant, sortOrder = 0) {
  return getUpsertAssistantApi()(assistant, sortOrder)
}

export async function upsertStorageV2AssistantList(assistants: Assistant[]) {
  const upsertAssistant = getUpsertAssistantApi()

  for (const [index, assistant] of assistants.entries()) {
    await upsertAssistant(assistant, index)
  }
}

export async function mutateStorageV2AssistantFirst(
  assistantId: string,
  assistants: Assistant[],
  mutate: (assistant: Assistant) => Assistant
) {
  const baseAssistant =
    pendingAssistantById.get(assistantId) ?? assistants.find((assistant) => assistant.id === assistantId)

  if (!baseAssistant) {
    return null
  }

  const nextAssistant = mutate(baseAssistant)
  const sortOrder = getSortOrder(assistantId, assistants)
  pendingAssistantById.set(assistantId, nextAssistant)

  const previousQueue = assistantWriteQueueById.get(assistantId) ?? Promise.resolve()
  const writeTask = previousQueue.catch(() => undefined).then(() => upsertStorageV2Assistant(nextAssistant, sortOrder))
  const queuedTask = writeTask.finally(() => {
    if (pendingAssistantById.get(assistantId) === nextAssistant) {
      pendingAssistantById.delete(assistantId)
    }

    if (assistantWriteQueueById.get(assistantId) === queuedTask) {
      assistantWriteQueueById.delete(assistantId)
    }
  })

  assistantWriteQueueById.set(assistantId, queuedTask)
  await queuedTask

  return nextAssistant
}
