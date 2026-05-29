export const STORAGE_V2_SYNC_POLICY_VERSION = 1
export const STORAGE_V2_SYNC_DEVICE_ID_META_KEY = 'device_id'

export const STORAGE_V2_SYNC_CONFLICT_UI_FIELDS = [
  'entityType',
  'entityId',
  'localSnapshot',
  'remoteSnapshot',
  'baseVersion',
  'localDeviceId',
  'remoteDeviceId',
  'createdAt',
  'resolvedAt'
] as const

export type StorageV2SyncEntityType =
  | 'agent'
  | 'agent_session'
  | 'agent_skill'
  | 'assistant'
  | 'channel'
  | 'channel_task_subscription'
  | 'conversation'
  | 'file'
  | 'knowledge_base'
  | 'knowledge_item'
  | 'kv_record'
  | 'message'
  | 'message_block'
  | 'provider'
  | 'scheduled_task'
  | 'settings'
  | 'skill'
  | 'task_run_log'

export type StorageV2SyncMergeStrategy =
  | 'append-only'
  | 'content-addressed'
  | 'last-write-wins'
  | 'last-write-wins-with-secret-ref'
  | 'manual-conflict'
  | 'parent-child-ordered'
  | 'source-scoped-last-write-wins'

export type StorageV2SyncSecretMode = 'none' | 'secret-ref-only'

export type StorageV2SyncDeletionSemantics = 'append-only' | 'soft-delete-with-tombstone' | 'sync-ledger-delete-only'

export type StorageV2SyncClearSemantics = 'deleted-at-tombstone' | 'explicit-cleared-marker' | 'not-clearable'

export type StorageV2SyncPolicy = {
  entityType: StorageV2SyncEntityType
  table: string
  idColumns: readonly string[]
  versioned: boolean
  updatedAtColumn?: string
  deletedAtColumn?: string
  deletionSemantics: StorageV2SyncDeletionSemantics
  mergeStrategy: StorageV2SyncMergeStrategy
  secretMode: StorageV2SyncSecretMode
  clearSemantics: StorageV2SyncClearSemantics
  conflictUi: 'auto' | 'diff' | 'timeline' | 'none'
  notes: string
}

const STORAGE_V2_SYNC_POLICIES = [
  {
    entityType: 'settings',
    table: 'settings',
    idColumns: ['key'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'source-scoped-last-write-wins',
    secretMode: 'secret-ref-only',
    clearSemantics: 'explicit-cleared-marker',
    conflictUi: 'diff',
    notes:
      'Settings keep scope-specific JSON values; credential values must be represented by secret refs or unavailable markers.'
  },
  {
    entityType: 'provider',
    table: 'providers',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins-with-secret-ref',
    secretMode: 'secret-ref-only',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Provider metadata can sync, but API keys remain local-only secrets referenced by provider_credentials.'
  },
  {
    entityType: 'assistant',
    table: 'assistants',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Assistant versions preserve historical snapshots; the active assistant row is last-writer-wins.'
  },
  {
    entityType: 'agent',
    table: 'agents',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins',
    secretMode: 'secret-ref-only',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Agent metadata syncs separately from local workspace files; tool credentials must remain secret refs.'
  },
  {
    entityType: 'agent_session',
    table: 'agent_sessions',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Session config follows the session row; message history is synced through conversation/message entities.'
  },
  {
    entityType: 'conversation',
    table: 'conversations',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'parent-child-ordered',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'timeline',
    notes: 'Conversation metadata is the parent for ordered message and block children.'
  },
  {
    entityType: 'message',
    table: 'messages',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'parent-child-ordered',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'timeline',
    notes: 'Messages retain parent/request ordering; conflicts should be shown in conversation context.'
  },
  {
    entityType: 'message_block',
    table: 'message_blocks',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'parent-child-ordered',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'timeline',
    notes: 'Blocks are ordered within a message and may reference blob records.'
  },
  {
    entityType: 'file',
    table: 'files',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'content-addressed',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'File metadata syncs by row; blob bytes are content-addressed and verified by checksum.'
  },
  {
    entityType: 'skill',
    table: 'skills',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'content-addressed',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Skill metadata syncs with content_hash; package files remain restorable through the data root.'
  },
  {
    entityType: 'agent_skill',
    table: 'agent_skills',
    idColumns: ['agent_id', 'skill_id'],
    versioned: false,
    updatedAtColumn: 'updated_at',
    deletionSemantics: 'sync-ledger-delete-only',
    mergeStrategy: 'last-write-wins',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'auto',
    notes: 'Composite join rows do not carry deleted_at; deletes must remain in sync_tombstones.'
  },
  {
    entityType: 'scheduled_task',
    table: 'scheduled_tasks',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Task schedule metadata is mutable; run history is append-only.'
  },
  {
    entityType: 'task_run_log',
    table: 'task_run_logs',
    idColumns: ['id'],
    versioned: true,
    deletionSemantics: 'append-only',
    mergeStrategy: 'append-only',
    secretMode: 'none',
    clearSemantics: 'not-clearable',
    conflictUi: 'none',
    notes: 'Task run logs are historical records and should not be merged by overwriting older runs.'
  },
  {
    entityType: 'channel',
    table: 'channels',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins-with-secret-ref',
    secretMode: 'secret-ref-only',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes:
      'Channel credentials stay in the local secret vault; synced channel config carries refs or unavailable markers.'
  },
  {
    entityType: 'channel_task_subscription',
    table: 'channel_task_subscriptions',
    idColumns: ['channel_id', 'task_id'],
    versioned: false,
    updatedAtColumn: 'updated_at',
    deletionSemantics: 'sync-ledger-delete-only',
    mergeStrategy: 'last-write-wins',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'auto',
    notes: 'Composite join rows rely on sync_tombstones for deletes.'
  },
  {
    entityType: 'knowledge_base',
    table: 'knowledge_bases',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'last-write-wins',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Knowledge base metadata syncs; indexed artifacts can be regenerated from items/files.'
  },
  {
    entityType: 'knowledge_item',
    table: 'knowledge_items',
    idColumns: ['id'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'content-addressed',
    secretMode: 'none',
    clearSemantics: 'deleted-at-tombstone',
    conflictUi: 'diff',
    notes: 'Knowledge items use source_uri/content_hash to avoid duplicate restored content.'
  },
  {
    entityType: 'kv_record',
    table: 'kv_records',
    idColumns: ['scope', 'key'],
    versioned: true,
    updatedAtColumn: 'updated_at',
    deletedAtColumn: 'deleted_at',
    deletionSemantics: 'soft-delete-with-tombstone',
    mergeStrategy: 'source-scoped-last-write-wins',
    secretMode: 'secret-ref-only',
    clearSemantics: 'explicit-cleared-marker',
    conflictUi: 'diff',
    notes:
      'App data records and caches are source-scoped; explicit cleared markers must not be treated as missing secrets.'
  }
] as const satisfies readonly StorageV2SyncPolicy[]

const STORAGE_V2_SYNC_POLICY_BY_ENTITY = new Map(STORAGE_V2_SYNC_POLICIES.map((policy) => [policy.entityType, policy]))

export function listStorageV2SyncPolicies(): readonly StorageV2SyncPolicy[] {
  return STORAGE_V2_SYNC_POLICIES
}

export function getStorageV2SyncPolicy(entityType: string): StorageV2SyncPolicy | null {
  return STORAGE_V2_SYNC_POLICY_BY_ENTITY.get(entityType as StorageV2SyncEntityType) ?? null
}

export function assertStorageV2SyncPolicy(entityType: string): StorageV2SyncPolicy {
  const policy = getStorageV2SyncPolicy(entityType)
  if (!policy) {
    throw new Error(`Unknown Storage v2 sync entity type: ${entityType}`)
  }
  return policy
}
