export type StorageV2RuntimeMirrorStatusId =
  | 'agents'
  | 'conversations'
  | 'dexie_settings'
  | 'dexie_tables'
  | 'files'
  | 'local_storage'
  | 'redux'

export type StorageV2RuntimeMirrorStatusEntry = {
  id: StorageV2RuntimeMirrorStatusId
  pendingCount: number
  inflight: boolean
  suspended: boolean
  lastError: string | null
}

export type StorageV2RuntimeMirrorStatus = {
  generatedAt: string
  pendingCount: number
  failureCount: number
  mirrors: StorageV2RuntimeMirrorStatusEntry[]
}

export function serializeStorageV2MirrorError(error: unknown) {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}
