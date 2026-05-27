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
import { Button, Input, Typography } from 'antd'
import dayjs from 'dayjs'
import type { FC } from 'react'
import { useEffect, useState } from 'react'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

type SyncSummary = {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  skipped: number
  lastSyncAt: number
}

type SyncStatus = {
  deviceId: string
  lastSummary: SyncSummary
  conflicts: unknown[]
}

const DataSyncSettings: FC = () => {
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
      window.toast.warning('请先配置 WebDAV 地址')
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
      window.toast.success('数据同步完成')
    } catch (error) {
      window.toast.error(`同步失败：${(error as Error).message}`)
    } finally {
      setSyncing(false)
    }
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
      <SettingTitle>数据同步</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>同步方式</SettingRowTitle>
        <Typography.Text type="secondary">SQLite 细颗粒度记录 + WebDAV</Typography.Text>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>WebDAV 地址</SettingRowTitle>
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
        <SettingRowTitle>用户名</SettingRowTitle>
        <Input
          placeholder="WebDAV 用户名"
          value={webdavUser}
          onChange={(event) => setWebdavUser(event.target.value)}
          onBlur={() => dispatch(setDataSyncWebdavUser(webdavUser || ''))}
          style={{ width: 280 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>密码</SettingRowTitle>
        <Input.Password
          placeholder="WebDAV 密码或应用密码"
          value={webdavPass}
          onChange={(event) => setWebdavPass(event.target.value)}
          onBlur={() => dispatch(setDataSyncWebdavPass(webdavPass || ''))}
          style={{ width: 280 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>同步目录</SettingRowTitle>
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
        <SettingRowTitle>自动同步</SettingRowTitle>
        <Selector
          size={14}
          value={syncInterval}
          onChange={onSyncIntervalChange}
          disabled={!webdavHost}
          options={[
            { label: '关闭', value: 0 },
            { label: '每 1 分钟', value: 1 },
            { label: '每 5 分钟', value: 5 },
            { label: '每 15 分钟', value: 15 },
            { label: '每 30 分钟', value: 30 },
            { label: '每 1 小时', value: 60 },
            { label: '每 2 小时', value: 120 },
            { label: '每 6 小时', value: 360 },
            { label: '每 12 小时', value: 720 },
            { label: '每天', value: 1440 }
          ]}
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          数据同步使用独立的 WebDAV 配置，不复用备份设置；缓存只保存在本地，不参与云端同步。
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>当前设备</SettingRowTitle>
        <Typography.Text type="secondary" copyable>
          {status?.deviceId || '尚未初始化'}
        </Typography.Text>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>立即同步</SettingRowTitle>
        <Button
          type="primary"
          icon={<SyncOutlined spin={syncing} />}
          loading={syncing}
          disabled={!webdavHost}
          onClick={syncNow}>
          同步
        </Button>
      </SettingRow>
      {summary && summary.lastSyncAt > 0 && (
        <>
          <SettingDivider />
          <SettingRow>
            <SettingRowTitle>最近结果</SettingRowTitle>
            <HStack gap="12px">
              <Typography.Text type="secondary">
                {dayjs(summary.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')}
              </Typography.Text>
              <Typography.Text type="secondary">上传 {summary.uploaded}</Typography.Text>
              <Typography.Text type="secondary">下载 {summary.downloaded}</Typography.Text>
              <Typography.Text type="secondary">删除 {summary.deleted}</Typography.Text>
              <Typography.Text type={summary.conflicts ? 'warning' : 'secondary'}>
                冲突 {summary.conflicts}
              </Typography.Text>
            </HStack>
          </SettingRow>
        </>
      )}
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>未解决冲突</SettingRowTitle>
        <Typography.Text type={status?.conflicts?.length ? 'warning' : 'secondary'}>
          {status?.conflicts?.length || 0}
        </Typography.Text>
      </SettingRow>
    </SettingGroup>
  )
}

export default DataSyncSettings
