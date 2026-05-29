import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import {
  getStorageV2AutoHydrateEnabled,
  hydrateRuntimeCacheFromStorageV2,
  setStorageV2AutoHydrateEnabled
} from '@renderer/services/StorageV2HydrationService'
import {
  createStorageV2Backup,
  createStorageV2Snapshot,
  getStorageV2DataRoot,
  getStorageV2Health,
  getStorageV2IntegrityReport,
  getStorageV2MigrationAudit,
  getStorageV2Stats,
  listStorageV2MigrationRuns,
  restoreStorageV2Backup,
  runLegacyMigrationToStorageV2,
  type StorageV2BackupValidation,
  type StorageV2LegacyMigrationReport,
  type StorageV2MigrationRun,
  type StorageV2RestoreBackupResult,
  validateStorageV2Backup
} from '@renderer/services/StorageV2Service'
import { persistor, useAppDispatch } from '@renderer/store'
import { Alert, Button, Space, Switch, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import {
  Archive,
  ClipboardCheck,
  Database,
  Download,
  FolderOpen,
  PlayCircle,
  RefreshCw,
  ScanSearch,
  ShieldCheck
} from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

type StorageV2DataRootInfo = {
  dataRoot: string
  source: string
  manifest: {
    profileId: string
    workspaceId: string
    version: number
    updatedAt: string
  } | null
  candidates: Array<{
    path: string
    source: string
    exists: boolean
    hasManifest: boolean
    hasLegacyData: boolean
  }>
}

type StorageV2Health = {
  ok: boolean
  quickCheck?: string
  dbPath?: string
}

type StorageV2MigrationAudit = {
  generatedAt: string
  userDataPath: string
  dataRoot: string
  items: Array<{
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
  }>
  warnings: string[]
}

type StorageV2Stats = {
  generatedAt: string
  counts: Record<string, number>
}

type StorageV2IntegrityReport = {
  ok: boolean
  generatedAt: string
  quickCheck: string
  integrityCheck: string
  foreignKeyIssueCount: number
  issues: Array<{
    id: string
    label: string
    count: number
  }>
}

type LoadingAction =
  | 'refresh'
  | 'dry-run'
  | 'import'
  | 'backup'
  | 'snapshot'
  | 'hydrate'
  | 'verify'
  | 'auto-hydrate'
  | 'validate-backup'
  | 'restore-backup'
  | null

const SOURCE_LABEL_KEYS: Record<string, string> = {
  config: 'settings.data.storage_v2.sources.config',
  'current-user-data': 'settings.data.storage_v2.sources.current_user_data',
  env: 'settings.data.storage_v2.sources.env',
  'legacy-user-data': 'settings.data.storage_v2.sources.legacy_user_data'
}

const REPORT_LABEL_KEYS: Record<string, string> = {
  agentDb: 'settings.data.storage_v2.reports.agent_db',
  appDb: 'settings.data.storage_v2.reports.app_db',
  dexie: 'settings.data.storage_v2.reports.dexie',
  redux: 'settings.data.storage_v2.reports.redux'
}
const AUDIT_ITEM_LABEL_KEYS: Record<string, string> = {
  'agents-db': 'settings.data.storage_v2.audit_items.agents_db',
  'agents-workspaces': 'settings.data.storage_v2.audit_items.agents_workspaces',
  'app-db': 'settings.data.storage_v2.audit_items.app_db',
  data: 'settings.data.storage_v2.audit_items.data',
  files: 'settings.data.storage_v2.audit_items.files',
  indexeddb: 'settings.data.storage_v2.audit_items.indexeddb',
  'knowledge-base': 'settings.data.storage_v2.audit_items.knowledge_base',
  'local-storage': 'settings.data.storage_v2.audit_items.local_storage',
  'redux-local-storage-leveldb': 'settings.data.storage_v2.audit_items.redux_local_storage_leveldb',
  skills: 'settings.data.storage_v2.audit_items.skills',
  'storage-v2-main-db': 'settings.data.storage_v2.audit_items.storage_v2_main_db',
  'storage-v2-manifest': 'settings.data.storage_v2.audit_items.storage_v2_manifest'
}

const REPORT_KEYS = ['redux', 'dexie', 'agentDb', 'appDb'] as const
const COUNT_KEYS = [
  'agentCount',
  'agentSkillCount',
  'assistantCount',
  'blockCount',
  'cacheCount',
  'channelCount',
  'conversationCount',
  'fileCount',
  'knowledgeBaseCount',
  'knowledgeItemCount',
  'messageCount',
  'modelCount',
  'providerCount',
  'recordCount',
  'secretCandidateCount',
  'sessionCount',
  'sessionMessageCount',
  'settingsCount',
  'skillCount',
  'syncConflictCount',
  'syncStateCount',
  'taskCount',
  'taskRunLogCount',
  'workbenchShortcutCount'
] as const
const IMPORTED_COUNT_KEYS = [
  'importedAgentCount',
  'importedAgentSkillCount',
  'importedAssistantCount',
  'importedBlockCount',
  'importedCacheCount',
  'importedChannelCount',
  'importedConversationCount',
  'importedFileCount',
  'importedKnowledgeBaseCount',
  'importedKnowledgeItemCount',
  'importedMessageCount',
  'importedModelCount',
  'importedProviderCount',
  'importedRecordCount',
  'importedSecretCount',
  'importedSessionCount',
  'importedSessionMessageCount',
  'importedSettingsCount',
  'importedSkillCount',
  'importedSyncConflictCount',
  'importedSyncStateCount',
  'importedTaskCount',
  'importedTaskRunLogCount',
  'importedWorkbenchShortcutCount'
] as const
const STATS_KEYS = [
  'settings',
  'providers',
  'models',
  'assistants',
  'agents',
  'agent_sessions',
  'conversations',
  'messages',
  'message_blocks',
  'files',
  'knowledge_bases',
  'knowledge_items',
  'skills',
  'scheduled_tasks',
  'channels',
  'kv_records',
  'sync_changes',
  'sync_conflicts',
  'sync_tombstones',
  'migration_runs'
] as const
const STATS_LABEL_KEYS: Record<(typeof STATS_KEYS)[number], string> = {
  agent_sessions: 'settings.data.storage_v2.entities.agent_sessions',
  agents: 'settings.data.storage_v2.entities.agents',
  assistants: 'settings.data.storage_v2.entities.assistants',
  channels: 'settings.data.storage_v2.entities.channels',
  conversations: 'settings.data.storage_v2.entities.conversations',
  files: 'settings.data.storage_v2.entities.files',
  knowledge_bases: 'settings.data.storage_v2.entities.knowledge_bases',
  knowledge_items: 'settings.data.storage_v2.entities.knowledge_items',
  kv_records: 'settings.data.storage_v2.entities.kv_records',
  message_blocks: 'settings.data.storage_v2.entities.message_blocks',
  messages: 'settings.data.storage_v2.entities.messages',
  migration_runs: 'settings.data.storage_v2.entities.migration_runs',
  models: 'settings.data.storage_v2.entities.models',
  providers: 'settings.data.storage_v2.entities.providers',
  scheduled_tasks: 'settings.data.storage_v2.entities.scheduled_tasks',
  settings: 'settings.data.storage_v2.entities.settings',
  skills: 'settings.data.storage_v2.entities.skills',
  sync_changes: 'settings.data.storage_v2.entities.sync_changes',
  sync_conflicts: 'settings.data.storage_v2.entities.sync_conflicts',
  sync_tombstones: 'settings.data.storage_v2.entities.sync_tombstones'
}
const INTEGRITY_ISSUE_LABEL_KEYS: Record<string, string> = {
  agent_sessions_without_agent: 'settings.data.storage_v2.integrity.issues.agent_sessions_without_agent',
  agent_skills_without_agent: 'settings.data.storage_v2.integrity.issues.agent_skills_without_agent',
  agent_skills_without_skill: 'settings.data.storage_v2.integrity.issues.agent_skills_without_skill',
  agent_avatars_without_blob: 'settings.data.storage_v2.integrity.issues.agent_avatars_without_blob',
  assistant_avatars_without_blob: 'settings.data.storage_v2.integrity.issues.assistant_avatars_without_blob',
  blob_ref_count_mismatch: 'settings.data.storage_v2.integrity.issues.blob_ref_count_mismatch',
  corrupt_blob_files: 'settings.data.storage_v2.integrity.issues.corrupt_blob_files',
  files_without_blob: 'settings.data.storage_v2.integrity.issues.files_without_blob',
  invalid_secret_refs: 'settings.data.storage_v2.integrity.issues.invalid_secret_refs',
  knowledge_items_without_base: 'settings.data.storage_v2.integrity.issues.knowledge_items_without_base',
  message_blocks_without_blob: 'settings.data.storage_v2.integrity.issues.message_blocks_without_blob',
  message_blocks_without_message: 'settings.data.storage_v2.integrity.issues.message_blocks_without_message',
  messages_without_conversation: 'settings.data.storage_v2.integrity.issues.messages_without_conversation',
  missing_blob_files: 'settings.data.storage_v2.integrity.issues.missing_blob_files',
  missing_secret_refs: 'settings.data.storage_v2.integrity.issues.missing_secret_refs',
  models_without_provider: 'settings.data.storage_v2.integrity.issues.models_without_provider',
  orphan_blobs: 'settings.data.storage_v2.integrity.issues.orphan_blobs',
  orphan_secret_vault_entries: 'settings.data.storage_v2.integrity.issues.orphan_secret_vault_entries',
  profile_avatars_without_blob: 'settings.data.storage_v2.integrity.issues.profile_avatars_without_blob',
  provider_credentials_without_provider:
    'settings.data.storage_v2.integrity.issues.provider_credentials_without_provider',
  secret_vault_invalid: 'settings.data.storage_v2.integrity.issues.secret_vault_invalid',
  task_logs_without_task: 'settings.data.storage_v2.integrity.issues.task_logs_without_task',
  tasks_without_agent: 'settings.data.storage_v2.integrity.issues.tasks_without_agent'
}
const BACKUP_ISSUE_LABEL_KEYS: Record<string, string> = {
  db_missing: 'settings.data.storage_v2.backup_restore.issues.db_missing',
  db_open_failed: 'settings.data.storage_v2.backup_restore.issues.db_open_failed',
  corrupt_blob_files: 'settings.data.storage_v2.backup_restore.issues.corrupt_blob_files',
  format_unsupported: 'settings.data.storage_v2.backup_restore.issues.format_unsupported',
  integrity_check_failed: 'settings.data.storage_v2.backup_restore.issues.integrity_check_failed',
  invalid_secret_refs: 'settings.data.storage_v2.backup_restore.issues.invalid_secret_refs',
  metadata_invalid: 'settings.data.storage_v2.backup_restore.issues.metadata_invalid',
  missing_blob_files: 'settings.data.storage_v2.backup_restore.issues.missing_blob_files',
  missing_secret_refs: 'settings.data.storage_v2.backup_restore.issues.missing_secret_refs',
  path_not_directory: 'settings.data.storage_v2.backup_restore.issues.path_not_directory',
  quick_check_failed: 'settings.data.storage_v2.backup_restore.issues.quick_check_failed',
  secret_vault_invalid: 'settings.data.storage_v2.backup_restore.issues.secret_vault_invalid',
  version_unsupported: 'settings.data.storage_v2.backup_restore.issues.version_unsupported'
}
const BACKUP_WARNING_LABEL_KEYS: Record<string, string> = {
  manifest_missing: 'settings.data.storage_v2.backup_restore.warnings.manifest_missing',
  orphan_secret_vault_entries: 'settings.data.storage_v2.backup_restore.warnings.orphan_secret_vault_entries',
  secret_vault_decrypt_unavailable: 'settings.data.storage_v2.backup_restore.warnings.secret_vault_decrypt_unavailable',
  secret_vault_missing: 'settings.data.storage_v2.backup_restore.warnings.secret_vault_missing',
  undecryptable_secret_vault_entries:
    'settings.data.storage_v2.backup_restore.warnings.undecryptable_secret_vault_entries'
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {}
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function sumKeys(record: Record<string, any>, keys: readonly string[]) {
  return keys.reduce((total, key) => total + numberValue(record[key]), 0)
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

const StorageV2Settings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null)
  const [dataRoot, setDataRoot] = useState<StorageV2DataRootInfo | null>(null)
  const [health, setHealth] = useState<StorageV2Health | null>(null)
  const [audit, setAudit] = useState<StorageV2MigrationAudit | null>(null)
  const [stats, setStats] = useState<StorageV2Stats | null>(null)
  const [integrityReport, setIntegrityReport] = useState<StorageV2IntegrityReport | null>(null)
  const [migrationRuns, setMigrationRuns] = useState<StorageV2MigrationRun[]>([])
  const [lastReport, setLastReport] = useState<StorageV2LegacyMigrationReport | null>(null)
  const [autoHydrateEnabled, setAutoHydrateEnabled] = useState(false)
  const [selectedBackupPath, setSelectedBackupPath] = useState<string | null>(null)
  const [backupValidation, setBackupValidation] = useState<StorageV2BackupValidation | null>(null)
  const [lastRestoreResult, setLastRestoreResult] = useState<StorageV2RestoreBackupResult | null>(null)

  const loadOverview = useCallback(
    async (showSpinner = false) => {
      if (showSpinner) {
        setLoadingAction('refresh')
      }

      try {
        const [nextDataRoot, nextAudit, nextHealth, nextStats, nextMigrationRuns, nextAutoHydrateEnabled] =
          await Promise.all([
            getStorageV2DataRoot(),
            getStorageV2MigrationAudit(),
            getStorageV2Health().catch((error) => ({
              ok: false,
              quickCheck: (error as Error).message
            })),
            getStorageV2Stats(),
            listStorageV2MigrationRuns(8),
            getStorageV2AutoHydrateEnabled().catch(() => false)
          ])

        setDataRoot(nextDataRoot as StorageV2DataRootInfo)
        setAudit(nextAudit as StorageV2MigrationAudit)
        setHealth(nextHealth as StorageV2Health)
        setStats(nextStats as StorageV2Stats)
        setMigrationRuns(nextMigrationRuns)
        setAutoHydrateEnabled(nextAutoHydrateEnabled)
      } catch (error) {
        window.toast.error(t('settings.data.storage_v2.toast.refresh_failed', { message: getErrorMessage(error) }))
      } finally {
        if (showSpinner) {
          setLoadingAction(null)
        }
      }
    },
    [t]
  )

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const runAction = useCallback(
    async (action: Exclude<LoadingAction, null | 'refresh'>, callback: () => Promise<unknown>, successKey: string) => {
      setLoadingAction(action)
      try {
        const result = await callback()
        window.toast.success(t(successKey))
        await loadOverview()
        return result
      } catch (error) {
        window.toast.error(t('settings.data.storage_v2.toast.action_failed', { message: getErrorMessage(error) }))
        return null
      } finally {
        setLoadingAction(null)
      }
    },
    [loadOverview, t]
  )

  const runDryRun = useCallback(async () => {
    const report = await runAction(
      'dry-run',
      () => runLegacyMigrationToStorageV2({ dryRun: true }),
      'settings.data.storage_v2.toast.dry_run_success'
    )
    if (report) {
      setLastReport(report as StorageV2LegacyMigrationReport)
    }
  }, [runAction])

  const runImport = useCallback(async () => {
    const report = await runAction(
      'import',
      () => runLegacyMigrationToStorageV2({ dryRun: false }),
      'settings.data.storage_v2.toast.import_success'
    )
    if (report) {
      setLastReport(report as StorageV2LegacyMigrationReport)
    }
  }, [runAction])

  const confirmImport = useCallback(() => {
    window.modal.confirm({
      centered: true,
      title: t('settings.data.storage_v2.confirm_import.title'),
      content: t('settings.data.storage_v2.confirm_import.content'),
      okText: t('settings.data.storage_v2.actions.import'),
      cancelText: t('common.cancel'),
      onOk: runImport
    })
  }, [runImport, t])

  const runBackup = useCallback(async () => {
    await runAction(
      'backup',
      () => createStorageV2Backup('settings-manual'),
      'settings.data.storage_v2.toast.backup_success'
    )
  }, [runAction])

  const runSnapshot = useCallback(async () => {
    await runAction(
      'snapshot',
      () => createStorageV2Snapshot('settings-manual'),
      'settings.data.storage_v2.toast.snapshot_success'
    )
  }, [runAction])

  const runHydrate = useCallback(async () => {
    await runAction(
      'hydrate',
      () =>
        hydrateRuntimeCacheFromStorageV2({
          dispatch,
          flush: () => persistor.flush()
        }),
      'settings.data.storage_v2.toast.hydrate_success'
    )
  }, [dispatch, runAction])

  const toggleAutoHydrate = useCallback(
    async (checked: boolean) => {
      const result = await runAction(
        'auto-hydrate',
        () => setStorageV2AutoHydrateEnabled(checked),
        'settings.data.storage_v2.toast.auto_hydrate_updated'
      )
      if (result !== null) {
        setAutoHydrateEnabled(Boolean(result))
      }
    },
    [runAction]
  )

  const runVerify = useCallback(async () => {
    const report = await runAction(
      'verify',
      () => getStorageV2IntegrityReport(),
      'settings.data.storage_v2.toast.verify_success'
    )
    if (report) {
      setIntegrityReport(report as StorageV2IntegrityReport)
    }
  }, [runAction])

  const selectBackup = useCallback(async () => {
    setLoadingAction('validate-backup')
    try {
      const backupPath = await window.api.file.selectFolder({
        title: t('settings.data.storage_v2.backup_restore.select_title'),
        properties: ['openDirectory']
      })
      if (!backupPath) return

      const validation = await validateStorageV2Backup(backupPath)
      setSelectedBackupPath(validation.backupPath)
      setBackupValidation(validation)

      if (validation.ok) {
        window.toast.success(t('settings.data.storage_v2.toast.backup_validate_success'))
      } else {
        window.toast.error(t('settings.data.storage_v2.toast.backup_validate_failed'))
      }
    } catch (error) {
      window.toast.error(t('settings.data.storage_v2.toast.action_failed', { message: getErrorMessage(error) }))
    } finally {
      setLoadingAction(null)
    }
  }, [t])

  const runRestoreBackup = useCallback(async () => {
    if (!selectedBackupPath) {
      window.toast.error(t('settings.data.storage_v2.backup_restore.no_backup_selected'))
      return
    }

    const result = await runAction(
      'restore-backup',
      () => restoreStorageV2Backup(selectedBackupPath),
      'settings.data.storage_v2.toast.restore_success'
    )

    if (result) {
      const restoreResult = result as StorageV2RestoreBackupResult
      setLastRestoreResult(restoreResult)
      setBackupValidation(restoreResult.validation)
      window.modal.confirm({
        centered: true,
        title: t('settings.data.storage_v2.backup_restore.restart_title'),
        content: t('settings.data.storage_v2.backup_restore.restart_content', {
          preRestoreBackupPath: restoreResult.preRestoreBackupPath
        }),
        okText: t('settings.data.storage_v2.actions.relaunch'),
        cancelText: t('common.cancel'),
        onOk: () => window.api.relaunchApp()
      })
    }
  }, [runAction, selectedBackupPath, t])

  const confirmRestoreBackup = useCallback(() => {
    if (!selectedBackupPath || !backupValidation?.ok) {
      window.toast.error(t('settings.data.storage_v2.backup_restore.no_backup_selected'))
      return
    }

    window.modal.confirm({
      centered: true,
      title: t('settings.data.storage_v2.confirm_restore.title'),
      content: t('settings.data.storage_v2.confirm_restore.content'),
      okText: t('settings.data.storage_v2.actions.restore_backup'),
      cancelText: t('common.cancel'),
      onOk: runRestoreBackup
    })
  }, [backupValidation?.ok, runRestoreBackup, selectedBackupPath, t])

  const confirmHydrate = useCallback(() => {
    window.modal.confirm({
      centered: true,
      title: t('settings.data.storage_v2.confirm_hydrate.title'),
      content: t('settings.data.storage_v2.confirm_hydrate.content'),
      okText: t('settings.data.storage_v2.actions.hydrate'),
      cancelText: t('common.cancel'),
      onOk: runHydrate
    })
  }, [runHydrate, t])

  const reportWarnings = useMemo(() => {
    if (!lastReport) return []

    return REPORT_KEYS.flatMap((key) => {
      const warnings = asRecord(lastReport.reports[key]).warnings
      return Array.isArray(warnings) ? warnings.map((warning) => `${t(REPORT_LABEL_KEYS[key])}: ${warning}`) : []
    })
  }, [lastReport, t])

  const healthOk = Boolean(health?.ok)
  const dataRootPath = dataRoot?.dataRoot
  const sourceLabel = dataRoot?.source
    ? t(SOURCE_LABEL_KEYS[dataRoot.source] ?? 'settings.data.storage_v2.sources.unknown')
    : t('settings.data.storage_v2.empty')

  return (
    <>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.storage_v2.title')}</SettingTitle>
        <SettingDivider />
        <Alert type="info" showIcon message={t('settings.data.storage_v2.banner')} />
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.storage_v2.health')}</SettingRowTitle>
          <HStack alignItems="center" gap="8px">
            <Tag color={healthOk ? 'success' : 'error'}>
              {healthOk ? t('settings.data.storage_v2.health_ok') : t('settings.data.storage_v2.health_failed')}
            </Tag>
            <Typography.Text type="secondary">
              {health?.quickCheck || t('settings.data.storage_v2.empty')}
            </Typography.Text>
          </HStack>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.storage_v2.data_root')}</SettingRowTitle>
          <PathInline>
            <Typography.Text type="secondary" copyable ellipsis>
              {dataRootPath || t('settings.data.storage_v2.empty')}
            </Typography.Text>
            {dataRootPath && (
              <Button size="small" icon={<FolderOpen size={14} />} onClick={() => window.api.openPath(dataRootPath)}>
                {t('settings.data.storage_v2.actions.open')}
              </Button>
            )}
          </PathInline>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.storage_v2.source')}</SettingRowTitle>
          <Typography.Text type="secondary">{sourceLabel}</Typography.Text>
        </SettingRow>
        {dataRoot?.manifest && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.data.storage_v2.manifest')}</SettingRowTitle>
              <ManifestInline>
                <Tag>{t('settings.data.storage_v2.profile', { value: dataRoot.manifest.profileId })}</Tag>
                <Tag>{t('settings.data.storage_v2.version', { value: dataRoot.manifest.version })}</Tag>
                <Typography.Text type="secondary">
                  {dayjs(dataRoot.manifest.updatedAt).format('YYYY-MM-DD HH:mm:ss')}
                </Typography.Text>
              </ManifestInline>
            </SettingRow>
          </>
        )}
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.storage_v2.actions.title')}</SettingTitle>
        <SettingDivider />
        <ActionGrid>
          <Button
            icon={<RefreshCw size={14} />}
            loading={loadingAction === 'refresh'}
            onClick={() => loadOverview(true)}>
            {t('settings.data.storage_v2.actions.refresh')}
          </Button>
          <Button icon={<ShieldCheck size={14} />} loading={loadingAction === 'dry-run'} onClick={runDryRun}>
            {t('settings.data.storage_v2.actions.dry_run')}
          </Button>
          <Button
            type="primary"
            icon={<PlayCircle size={14} />}
            loading={loadingAction === 'import'}
            onClick={confirmImport}>
            {t('settings.data.storage_v2.actions.import')}
          </Button>
          <Button icon={<Archive size={14} />} loading={loadingAction === 'backup'} onClick={runBackup}>
            {t('settings.data.storage_v2.actions.backup')}
          </Button>
          <Button icon={<Database size={14} />} loading={loadingAction === 'snapshot'} onClick={runSnapshot}>
            {t('settings.data.storage_v2.actions.snapshot')}
          </Button>
          <Button icon={<Download size={14} />} loading={loadingAction === 'hydrate'} onClick={confirmHydrate}>
            {t('settings.data.storage_v2.actions.hydrate')}
          </Button>
          <Button icon={<ScanSearch size={14} />} loading={loadingAction === 'verify'} onClick={runVerify}>
            {t('settings.data.storage_v2.actions.verify')}
          </Button>
          <Button icon={<FolderOpen size={14} />} loading={loadingAction === 'validate-backup'} onClick={selectBackup}>
            {t('settings.data.storage_v2.actions.select_backup')}
          </Button>
          <Button
            danger
            disabled={!backupValidation?.ok}
            icon={<Download size={14} />}
            loading={loadingAction === 'restore-backup'}
            onClick={confirmRestoreBackup}>
            {t('settings.data.storage_v2.actions.restore_backup')}
          </Button>
        </ActionGrid>
        <SettingRow>
          <SettingHelpText>{t('settings.data.storage_v2.actions.help')}</SettingHelpText>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.storage_v2.auto_hydrate.title')}</SettingRowTitle>
          <Switch
            checked={autoHydrateEnabled}
            loading={loadingAction === 'auto-hydrate'}
            onChange={toggleAutoHydrate}
          />
        </SettingRow>
        <SettingRow>
          <SettingHelpText>{t('settings.data.storage_v2.auto_hydrate.help')}</SettingHelpText>
        </SettingRow>
        {selectedBackupPath && backupValidation && (
          <BackupSummary>
            <Typography.Text type="secondary" copyable ellipsis>
              {t('settings.data.storage_v2.backup_restore.selected', { path: selectedBackupPath })}
            </Typography.Text>
            <Tag color={backupValidation.ok ? 'success' : 'error'}>
              {backupValidation.ok
                ? t('settings.data.storage_v2.backup_restore.valid')
                : t('settings.data.storage_v2.backup_restore.invalid')}
            </Tag>
            <Typography.Text type="secondary">
              {t('settings.data.storage_v2.backup_restore.summary', {
                quickCheck: backupValidation.quickCheck ?? '-',
                integrityCheck: backupValidation.integrityCheck ?? '-',
                missingBlobFileCount: backupValidation.missingBlobFileCount,
                corruptBlobFileCount: backupValidation.corruptBlobFileCount,
                secretVaultSecretCount: backupValidation.secretVaultSecretCount,
                missingSecretRefCount: backupValidation.missingSecretRefCount,
                invalidSecretRefCount: backupValidation.invalidSecretRefCount,
                orphanSecretVaultEntryCount: backupValidation.orphanSecretVaultEntryCount,
                undecryptableSecretVaultEntryCount: backupValidation.undecryptableSecretVaultEntryCount
              })}
            </Typography.Text>
            {backupValidation.issues.map((issue) => {
              const message = BACKUP_ISSUE_LABEL_KEYS[issue.id]
                ? t(BACKUP_ISSUE_LABEL_KEYS[issue.id], issue.values)
                : issue.message
              return (
                <Typography.Text key={`${issue.id}-${issue.message}`} type="danger">
                  {t('settings.data.storage_v2.backup_restore.issue', { message })}
                </Typography.Text>
              )
            })}
            {backupValidation.warnings.map((warning) => {
              const message = BACKUP_WARNING_LABEL_KEYS[warning.id]
                ? t(BACKUP_WARNING_LABEL_KEYS[warning.id], warning.values)
                : warning.message
              return (
                <Typography.Text key={`${warning.id}-${warning.message}`} type="warning">
                  {t('settings.data.storage_v2.backup_restore.warning', { message })}
                </Typography.Text>
              )
            })}
          </BackupSummary>
        )}
        {lastRestoreResult && (
          <BackupSummary>
            <Typography.Text type="secondary" copyable ellipsis>
              {t('settings.data.storage_v2.backup_restore.pre_restore', {
                path: lastRestoreResult.preRestoreBackupPath
              })}
            </Typography.Text>
            <Typography.Text type="secondary" copyable ellipsis>
              {t('settings.data.storage_v2.backup_restore.archived', {
                path: lastRestoreResult.archivedPath
              })}
            </Typography.Text>
            {lastRestoreResult.warnings.map((warning) => (
              <Typography.Text key={warning} type="warning">
                {t('settings.data.storage_v2.backup_restore.warning', { message: warning })}
              </Typography.Text>
            ))}
          </BackupSummary>
        )}
        {integrityReport && (
          <IntegritySummary>
            <Tag color={integrityReport.ok ? 'success' : 'error'}>
              {integrityReport.ok
                ? t('settings.data.storage_v2.integrity.ok')
                : t('settings.data.storage_v2.integrity.failed')}
            </Tag>
            <Typography.Text type="secondary">
              {t('settings.data.storage_v2.integrity.summary', {
                quickCheck: integrityReport.quickCheck,
                integrityCheck: integrityReport.integrityCheck,
                foreignKeyIssueCount: integrityReport.foreignKeyIssueCount
              })}
            </Typography.Text>
            {integrityReport.issues.map((issue) => (
              <Typography.Text key={issue.id} type="danger">
                {t(INTEGRITY_ISSUE_LABEL_KEYS[issue.id] ?? 'settings.data.storage_v2.integrity.issues.unknown', {
                  label: issue.label,
                  count: issue.count
                })}
              </Typography.Text>
            ))}
          </IntegritySummary>
        )}
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.storage_v2.stats.title')}</SettingTitle>
        <SettingDivider />
        <StatsGrid>
          {STATS_KEYS.map((key) => (
            <StatItem key={key}>
              <span>{t(STATS_LABEL_KEYS[key])}</span>
              <strong>{stats?.counts?.[key] ?? 0}</strong>
            </StatItem>
          ))}
        </StatsGrid>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.storage_v2.audit.title')}</SettingTitle>
        <SettingDivider />
        <AuditHeader>
          <Typography.Text type="secondary">
            {audit?.generatedAt
              ? dayjs(audit.generatedAt).format('YYYY-MM-DD HH:mm:ss')
              : t('settings.data.storage_v2.empty')}
          </Typography.Text>
          <Typography.Text type="secondary" copyable ellipsis>
            {audit?.userDataPath || t('settings.data.storage_v2.empty')}
          </Typography.Text>
        </AuditHeader>
        <AuditList>
          {(audit?.items ?? []).map((item) => (
            <AuditItem key={item.id}>
              <AuditName>
                <ClipboardCheck size={14} />
                <span>{AUDIT_ITEM_LABEL_KEYS[item.id] ? t(AUDIT_ITEM_LABEL_KEYS[item.id]) : item.label}</span>
              </AuditName>
              <AuditMeta>
                <Tag color={item.exists ? 'success' : 'default'}>
                  {item.exists
                    ? t('settings.data.storage_v2.audit.exists')
                    : t('settings.data.storage_v2.audit.missing')}
                </Tag>
                <span>{formatBytes(item.sizeBytes)}</span>
                {typeof item.fileCount === 'number' && (
                  <span>{t('settings.data.storage_v2.audit.files', { value: item.fileCount })}</span>
                )}
              </AuditMeta>
            </AuditItem>
          ))}
        </AuditList>
        {Boolean(audit?.warnings?.length) && (
          <>
            <SettingDivider />
            <WarningList>
              {audit!.warnings.map((warning) => (
                <Typography.Text key={warning} type="warning">
                  {warning}
                </Typography.Text>
              ))}
            </WarningList>
          </>
        )}
      </SettingGroup>

      {lastReport && (
        <SettingGroup theme={theme}>
          <SettingTitle>{t('settings.data.storage_v2.last_report.title')}</SettingTitle>
          <SettingDivider />
          <ReportSummary>
            <Tag color={lastReport.dryRun ? 'blue' : 'success'}>
              {lastReport.dryRun
                ? t('settings.data.storage_v2.last_report.dry_run')
                : t('settings.data.storage_v2.last_report.imported')}
            </Tag>
            <Typography.Text type="secondary">
              {dayjs(lastReport.finishedAt).format('YYYY-MM-DD HH:mm:ss')}
            </Typography.Text>
            {lastReport.snapshotPath && (
              <Typography.Text type="secondary" copyable ellipsis>
                {lastReport.snapshotPath}
              </Typography.Text>
            )}
          </ReportSummary>
          <SettingDivider />
          <ReportGrid>
            {REPORT_KEYS.map((key) => {
              const section = asRecord(lastReport.reports[key])
              const total = sumKeys(section, COUNT_KEYS)
              const imported = sumKeys(section, IMPORTED_COUNT_KEYS)
              return (
                <ReportItem key={key}>
                  <span>{t(REPORT_LABEL_KEYS[key])}</span>
                  <strong>{total}</strong>
                  <Typography.Text type="secondary">
                    {t('settings.data.storage_v2.last_report.imported_count', {
                      value: lastReport.dryRun ? 0 : imported || total
                    })}
                  </Typography.Text>
                </ReportItem>
              )
            })}
          </ReportGrid>
          {reportWarnings.length > 0 && (
            <>
              <SettingDivider />
              <WarningList>
                {reportWarnings.map((warning) => (
                  <Typography.Text key={warning} type="warning">
                    {warning}
                  </Typography.Text>
                ))}
              </WarningList>
            </>
          )}
        </SettingGroup>
      )}

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.storage_v2.history.title')}</SettingTitle>
        <SettingDivider />
        {migrationRuns.length > 0 ? (
          <HistoryList>
            {migrationRuns.map((run) => (
              <HistoryItem key={run.id}>
                <HistoryMain>
                  <span>
                    {run.dryRun
                      ? t('settings.data.storage_v2.history.dry_run')
                      : t('settings.data.storage_v2.history.import')}
                  </span>
                  <Tag color={run.status === 'success' ? 'success' : 'error'}>
                    {run.status === 'success'
                      ? t('settings.data.storage_v2.history.success')
                      : t('settings.data.storage_v2.history.failed')}
                  </Tag>
                </HistoryMain>
                <HistoryMeta>
                  <Typography.Text type="secondary">
                    {run.finishedAt ? dayjs(run.finishedAt).format('YYYY-MM-DD HH:mm:ss') : run.startedAt}
                  </Typography.Text>
                  {run.snapshotPath && (
                    <Typography.Text type="secondary" copyable ellipsis>
                      {run.snapshotPath}
                    </Typography.Text>
                  )}
                  {run.error && <Typography.Text type="danger">{run.error}</Typography.Text>}
                </HistoryMeta>
              </HistoryItem>
            ))}
          </HistoryList>
        ) : (
          <Typography.Text type="secondary">{t('settings.data.storage_v2.history.empty')}</Typography.Text>
        )}
      </SettingGroup>
    </>
  )
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const PathInline = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  max-width: min(680px, 62vw);
`

const ManifestInline = styled(Space)`
  max-width: min(680px, 62vw);
`

const ActionGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
`

const IntegritySummary = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  margin-top: 8px;

  > .ant-typography {
    grid-column: span 2;
  }
`

const BackupSummary = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  margin-top: 8px;

  > .ant-typography:first-child {
    grid-column: 1 / -1;
  }

  > .ant-typography {
    grid-column: 1 / -1;
  }
`

const StatsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 8px;
`

const StatItem = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: 34px;
  padding: 7px 9px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  color: var(--color-text-2);

  strong {
    color: var(--color-text-1);
    font-variant-numeric: tabular-nums;
  }
`

const AuditHeader = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
`

const AuditList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const AuditItem = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 34px;
  padding: 6px 0;
  border-bottom: 0.5px solid var(--color-border);

  &:last-child {
    border-bottom: none;
  }
`

const AuditName = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--color-text-1);
`

const AuditMeta = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  color: var(--color-text-3);
  font-variant-numeric: tabular-nums;
`

const WarningList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const ReportSummary = styled.div`
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 10px;
  align-items: center;
`

const ReportGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
`

const ReportItem = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
  align-items: center;
  min-height: 50px;
  padding: 8px 10px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);

  strong {
    font-variant-numeric: tabular-nums;
  }

  .ant-typography {
    grid-column: 1 / -1;
  }
`

const HistoryList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const HistoryItem = styled.div`
  display: grid;
  grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 38px;
  padding: 6px 0;
  border-bottom: 0.5px solid var(--color-border);

  &:last-child {
    border-bottom: none;
  }
`

const HistoryMain = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const HistoryMeta = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
`

export default StorageV2Settings
