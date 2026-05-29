export type StorageV2Manifest = {
  format: 'cherry-studio-pi-storage'
  version: 2
  profileId: string
  workspaceId: string
  createdAt: string
  updatedAt: string
  lastOpenedBy: {
    appId: string
    productName: string
    version: string
  }
}

export type StorageV2Candidate = {
  path: string
  source: 'env' | 'config' | 'current-user-data' | 'legacy-user-data'
  exists: boolean
  hasManifest: boolean
  hasLegacyData: boolean
}

export type StorageV2DataRootInfo = {
  dataRoot: string
  source: StorageV2Candidate['source']
  manifest: StorageV2Manifest | null
  candidates: StorageV2Candidate[]
}

export type StorageV2HealthCheck = {
  ok: boolean
  dataRoot: string
  dbPath: string
  manifest: StorageV2Manifest
  quickCheck: string
}

export type StorageV2HealthSummaryCheck = {
  id: string
  label: string
  status: 'error' | 'ok' | 'warning'
  message: string
  values?: Record<string, number | string>
}

export type StorageV2HealthSummary = {
  generatedAt: string
  status: 'blocked' | 'ready' | 'warning'
  canBackup: boolean
  canMigrate: boolean
  dataRoot: string
  issueCount: number
  warningCount: number
  checks: StorageV2HealthSummaryCheck[]
}

export type StorageV2IntegrityIssue = {
  id: string
  label: string
  count: number
}

export type StorageV2IntegrityReport = {
  ok: boolean
  generatedAt: string
  quickCheck: string
  integrityCheck: string
  foreignKeyIssueCount: number
  issues: StorageV2IntegrityIssue[]
}

export type StorageV2SecretVaultPruneReport = {
  beforeCount: number
  afterCount: number
  prunedCount: number
  prunedSecretIds: string[]
  referencedSecretCount: number
  invalidSecretRefCount: number
  skippedSources: string[]
}

export type StorageV2Snapshot = {
  path: string
  reason: string
  createdAt: string
}

export type StorageV2AuditItem = {
  id: string
  label: string
  path: string
  exists: boolean
  sizeBytes: number
  fileCount?: number
  directoryCount?: number
  category?: 'bootstrap' | 'external-projection' | 'runtime-cache' | 'user-asset'
  coverage?: 'cache' | 'covered' | 'legacy-only' | 'storage-v2-authoritative'
  risk?: 'high' | 'low' | 'medium'
  notes?: string
  actionRequired?: boolean
}

export type StorageV2MigrationAudit = {
  generatedAt: string
  userDataPath: string
  dataRoot: string
  items: StorageV2AuditItem[]
  warnings: string[]
}
