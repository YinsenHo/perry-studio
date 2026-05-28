export async function deleteStorageV2Provider(providerId: string) {
  const deleteProvider = window.api?.storageV2?.deleteProvider

  if (typeof deleteProvider !== 'function') {
    throw new Error('Storage v2 provider delete API unavailable')
  }

  return deleteProvider(providerId)
}

export async function deleteStorageV2Assistant(assistantId: string) {
  const deleteAssistant = window.api?.storageV2?.deleteAssistant

  if (typeof deleteAssistant !== 'function') {
    throw new Error('Storage v2 assistant delete API unavailable')
  }

  return deleteAssistant(assistantId)
}
