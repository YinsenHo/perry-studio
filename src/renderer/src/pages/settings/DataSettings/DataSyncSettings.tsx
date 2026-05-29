import { SyncOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import Selector from '@renderer/components/Selector'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { startDataSyncAutoSync, stopDataSyncAutoSync, syncAppDataNow } from '@renderer/services/DataSyncService'
import { useAppDispatch } from '@renderer/store'
import {
  setDataSyncAutoSync,
  setDataSyncSyncInterval,
  setDataSyncWebdavHost,
  setDataSyncWebdavPass,
  setDataSyncWebdavPath,
  setDataSyncWebdavUser
} from '@renderer/store/settings'
import { Button, Input, Modal, Typography } from 'antd'
import dayjs from 'dayjs'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

type SyncSummary = {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  skipped: number
  snapshotUploaded?: boolean
  snapshotFileName?: string | null
  snapshotBytes?: number
  lastSyncAt: number
}

type SyncStatus = {
  deviceId: string
  lastSummary: SyncSummary
  conflicts: unknown[]
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

const DataSyncSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { dataSyncWebdavHost, dataSyncWebdavUser, dataSyncWebdavPass, dataSyncWebdavPath, dataSyncSyncInterval } =
    useSettings()
  const dispatch = useAppDispatch()
  const [webdavHost, setWebdavHost] = useState(dataSyncWebdavHost)
  const [webdavUser, setWebdavUser] = useState(dataSyncWebdavUser)
  const [webdavPass, setWebdavPass] = useState(dataSyncWebdavPass)
  const [webdavPath, setWebdavPath] = useState(dataSyncWebdavPath)
  const [syncInterval, setSyncInterval] = useState(dataSyncSyncInterval)
  const [syncing, setSyncing] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [status, setStatus] = useState<SyncStatus | null>(null)

  const refreshStatus = async () => {
    const nextStatus = await window.api.dataSync.getStatus()
    setStatus(nextStatus)
  }

  useEffect(() => {
    void refreshStatus()
  }, [])

  const syncNow = async () => {
    if (!webdavHost) {
      window.toast.warning(t('settings.data.data_sync.toast.webdav_required'))
      return
    }

    dispatch(setDataSyncWebdavHost(webdavHost || ''))
    dispatch(setDataSyncWebdavUser(webdavUser || ''))
    dispatch(setDataSyncWebdavPass(webdavPass || ''))
    dispatch(setDataSyncWebdavPath(webdavPath || '/cherry-studio-pi'))

    setSyncing(true)
    try {
      const summary = await syncAppDataNow({ webdavHost, webdavUser, webdavPass, webdavPath })
      if (summary) {
        setStatus((prev) => ({
          deviceId: prev?.deviceId || '',
          conflicts: prev?.conflicts || [],
          lastSummary: summary
        }))
      }
      await refreshStatus()
      window.toast.success(t('settings.data.data_sync.toast.sync_success'))
    } catch (error) {
      window.toast.error(t('settings.data.data_sync.toast.sync_failed', { message: (error as Error).message }))
    } finally {
      setSyncing(false)
    }
  }

  const restoreLatestSnapshot = () => {
    if (!webdavHost) {
      window.toast.warning(t('settings.data.data_sync.toast.webdav_required'))
      return
    }

    dispatch(setDataSyncWebdavHost(webdavHost || ''))
    dispatch(setDataSyncWebdavUser(webdavUser || ''))
    dispatch(setDataSyncWebdavPass(webdavPass || ''))
    dispatch(setDataSyncWebdavPath(webdavPath || '/cherry-studio-pi'))

    Modal.confirm({
      title: t('settings.data.data_sync.restore_confirm_title'),
      content: t('settings.data.data_sync.restore_confirm_content'),
      okText: t('settings.data.data_sync.restore_latest'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setRestoring(true)
        try {
          await window.api.dataSync.restoreLatestSnapshot({ webdavHost, webdavUser, webdavPass, webdavPath })
          window.toast.success(t('settings.data.data_sync.toast.restore_success'))
        } catch (error) {
          window.toast.error(t('settings.data.data_sync.toast.restore_failed', { message: (error as Error).message }))
        } finally {
          setRestoring(false)
        }
      }
    })
  }

  const summary = status?.lastSummary
  const onSyncIntervalChange = (value: number) => {
    setSyncInterval(value)
    dispatch(setDataSyncWebdavHost(webdavHost || ''))
    dispatch(setDataSyncWebdavUser(webdavUser || ''))
    dispatch(setDataSyncWebdavPass(webdavPass || ''))
    dispatch(setDataSyncWebdavPath(webdavPath || '/cherry-studio-pi'))
    dispatch(setDataSyncSyncInterval(value))
    dispatch(setDataSyncAutoSync(value > 0))

    if (value > 0) {
      startDataSyncAutoSync(false)
    } else {
      stopDataSyncAutoSync()
    }
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.data.data_sync.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.method')}</SettingRowTitle>
        <Typography.Text type="secondary">{t('settings.data.data_sync.method_value')}</Typography.Text>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.webdav_host')}</SettingRowTitle>
        <Input
          placeholder="https://example.com/dav"
          value={webdavHost}
          onChange={(event) => setWebdavHost(event.target.value)}
          onBlur={() => {
            dispatch(setDataSyncWebdavHost(webdavHost || ''))
            if (!webdavHost) {
              setSyncInterval(0)
              dispatch(setDataSyncSyncInterval(0))
              dispatch(setDataSyncAutoSync(false))
              stopDataSyncAutoSync()
            }
          }}
          style={{ width: 280 }}
          type="url"
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.username')}</SettingRowTitle>
        <Input
          placeholder={t('settings.data.data_sync.username_placeholder')}
          value={webdavUser}
          onChange={(event) => setWebdavUser(event.target.value)}
          onBlur={() => dispatch(setDataSyncWebdavUser(webdavUser || ''))}
          style={{ width: 280 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.password')}</SettingRowTitle>
        <Input.Password
          placeholder={t('settings.data.data_sync.password_placeholder')}
          value={webdavPass}
          onChange={(event) => setWebdavPass(event.target.value)}
          onBlur={() => dispatch(setDataSyncWebdavPass(webdavPass || ''))}
          style={{ width: 280 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.remote_path')}</SettingRowTitle>
        <Input
          placeholder="/cherry-studio-pi"
          value={webdavPath}
          onChange={(event) => setWebdavPath(event.target.value)}
          onBlur={() => dispatch(setDataSyncWebdavPath(webdavPath || '/cherry-studio-pi'))}
          style={{ width: 280 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.auto_sync')}</SettingRowTitle>
        <Selector
          size={14}
          value={syncInterval}
          onChange={onSyncIntervalChange}
          disabled={!webdavHost}
          options={[
            { label: t('settings.data.data_sync.interval.off'), value: 0 },
            { label: t('settings.data.data_sync.interval.minute_one'), value: 1 },
            { label: t('settings.data.data_sync.interval.minute_other', { count: 5 }), value: 5 },
            { label: t('settings.data.data_sync.interval.minute_other', { count: 15 }), value: 15 },
            { label: t('settings.data.data_sync.interval.minute_other', { count: 30 }), value: 30 },
            { label: t('settings.data.data_sync.interval.hour_one'), value: 60 },
            { label: t('settings.data.data_sync.interval.hour_other', { count: 2 }), value: 120 },
            { label: t('settings.data.data_sync.interval.hour_other', { count: 6 }), value: 360 },
            { label: t('settings.data.data_sync.interval.hour_other', { count: 12 }), value: 720 },
            { label: t('settings.data.data_sync.interval.day_one'), value: 1440 }
          ]}
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.data_sync.help')}</SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.current_device')}</SettingRowTitle>
        <Typography.Text type="secondary" copyable>
          {status?.deviceId || t('settings.data.data_sync.uninitialized')}
        </Typography.Text>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.sync_now')}</SettingRowTitle>
        <HStack gap="8px">
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            disabled={!webdavHost || restoring}
            onClick={syncNow}>
            {t('settings.data.data_sync.sync')}
          </Button>
          <Button loading={restoring} disabled={!webdavHost || syncing} onClick={restoreLatestSnapshot}>
            {t('settings.data.data_sync.restore_latest')}
          </Button>
        </HStack>
      </SettingRow>
      {summary && summary.lastSyncAt > 0 && (
        <>
          <SettingDivider />
          <SettingRow>
            <SettingRowTitle>{t('settings.data.data_sync.last_result')}</SettingRowTitle>
            <HStack gap="12px" style={{ flexWrap: 'wrap' }}>
              <Typography.Text type="secondary">
                {dayjs(summary.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('settings.data.data_sync.summary.uploaded', { count: summary.uploaded })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('settings.data.data_sync.summary.downloaded', { count: summary.downloaded })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('settings.data.data_sync.summary.deleted', { count: summary.deleted })}
              </Typography.Text>
              <Typography.Text type={summary.conflicts ? 'warning' : 'secondary'}>
                {t('settings.data.data_sync.summary.conflicts', { count: summary.conflicts })}
              </Typography.Text>
              {summary.snapshotUploaded && (
                <Typography.Text type="secondary">
                  {t('settings.data.data_sync.snapshot.uploaded', {
                    file: summary.snapshotFileName || '-',
                    size: formatBytes(summary.snapshotBytes ?? 0)
                  })}
                </Typography.Text>
              )}
            </HStack>
          </SettingRow>
        </>
      )}
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.data_sync.unresolved_conflicts')}</SettingRowTitle>
        <Typography.Text type={status?.conflicts?.length ? 'warning' : 'secondary'}>
          {status?.conflicts?.length || 0}
        </Typography.Text>
      </SettingRow>
    </SettingGroup>
  )
}

export default DataSyncSettings
