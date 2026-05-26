import { useTheme } from '@renderer/context/ThemeProvider'
import type { EnvironmentDependenciesStatus, EnvironmentDependencyStatus } from '@shared/config/types'
import { Button, Popconfirm, Space, Tag } from 'antd'
import { Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer, SettingDescription, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '.'

const EnvironmentDependenciesSettings: FC = () => {
  const { theme } = useTheme()
  const { t } = useTranslation()
  const [status, setStatus] = useState<EnvironmentDependenciesStatus>()
  const [loading, setLoading] = useState(true)
  const [activeAction, setActiveAction] = useState<string>()

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await window.api.environmentDependencies.getStatus())
    } catch (error: any) {
      window.toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const runAction = async (action: string, fn: () => Promise<EnvironmentDependenciesStatus>, successKey: string) => {
    setActiveAction(action)
    try {
      setStatus(await fn())
      window.toast.success(t(successKey))
    } catch (error: any) {
      window.toast.error(error.message)
    } finally {
      setActiveAction(undefined)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const openManagedDir = () => {
    if (status?.managedDir) {
      void window.api.openPath(status.managedDir)
    }
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.environment.title')}</SettingTitle>
        <SettingDescription>{t('settings.environment.description')}</SettingDescription>
        <RuntimeRow>
          <div>
            <SettingRowTitle>{t('settings.environment.integratedRuntime')}</SettingRowTitle>
            <PathText>{status?.managedDir}</PathText>
          </div>
          <Space>
            <Button icon={<FolderOpen size={15} />} onClick={openManagedDir} disabled={!status?.managedDir}>
              {t('settings.environment.openDir')}
            </Button>
            <Button
              type="primary"
              icon={<Download size={15} />}
              loading={activeAction === 'install'}
              onClick={() =>
                runAction('install', window.api.environmentDependencies.install, 'settings.environment.installSuccess')
              }>
              {t('settings.environment.reinstall')}
            </Button>
            <Popconfirm
              title={t('settings.environment.uninstallConfirm')}
              onConfirm={() =>
                runAction(
                  'uninstall',
                  window.api.environmentDependencies.uninstall,
                  'settings.environment.uninstallSuccess'
                )
              }>
              <Button danger icon={<Trash2 size={15} />} loading={activeAction === 'uninstall'}>
                {t('settings.environment.uninstall')}
              </Button>
            </Popconfirm>
          </Space>
        </RuntimeRow>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <HeaderRow>
          <SettingTitle>{t('settings.environment.dependencies')}</SettingTitle>
          <Button icon={<RefreshCw size={15} />} onClick={loadStatus} loading={loading}>
            {t('settings.environment.refresh')}
          </Button>
        </HeaderRow>
        <DependencyList>
          {status?.dependencies.map((dependency) => (
            <DependencyRow key={dependency.id}>
              <DependencyInfo>
                <SettingRowTitle>{dependency.name}</SettingRowTitle>
                <PathText>{dependency.path || t('settings.environment.notFound')}</PathText>
              </DependencyInfo>
              <Space>
                {dependency.version && <VersionText>{dependency.version}</VersionText>}
                <Tag color={tagColor(dependency)}>{sourceLabel(dependency, t)}</Tag>
                {dependency.id === 'uv' && dependency.source === 'missing' && (
                  <Button
                    size="small"
                    icon={<Download size={13} />}
                    loading={activeAction === 'uv'}
                    onClick={() =>
                      runAction(
                        'uv',
                        window.api.environmentDependencies.installUv,
                        'settings.environment.installSuccess'
                      )
                    }>
                    {t('settings.environment.install')}
                  </Button>
                )}
                {dependency.id === 'bun' && dependency.source === 'missing' && (
                  <Button
                    size="small"
                    icon={<Download size={13} />}
                    loading={activeAction === 'bun'}
                    onClick={() =>
                      runAction(
                        'bun',
                        window.api.environmentDependencies.installBun,
                        'settings.environment.installSuccess'
                      )
                    }>
                    {t('settings.environment.install')}
                  </Button>
                )}
              </Space>
            </DependencyRow>
          ))}
        </DependencyList>
      </SettingGroup>
    </SettingContainer>
  )
}

const sourceLabel = (dependency: EnvironmentDependencyStatus, t: (key: string) => string) => {
  if (dependency.source === 'managed') return t('settings.environment.source.managed')
  if (dependency.source === 'runtime') return t('settings.environment.source.runtime')
  if (dependency.source === 'system') return t('settings.environment.source.system')
  return dependency.required
    ? t('settings.environment.source.requiredMissing')
    : t('settings.environment.source.missing')
}

const tagColor = (dependency: EnvironmentDependencyStatus) => {
  if (dependency.source === 'missing') return dependency.required ? 'red' : 'default'
  if (dependency.source === 'managed' || dependency.source === 'runtime') return 'green'
  return 'blue'
}

const RuntimeRow = styled(SettingRow)`
  align-items: flex-start;
  gap: 14px;
  margin-top: 16px;
`

const HeaderRow = styled(SettingRow)`
  margin-bottom: 12px;
`

const DependencyList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const DependencyRow = styled(SettingRow)`
  min-height: 44px;
  padding: 9px 0;
  border-bottom: 0.5px solid var(--color-border);

  &:last-child {
    border-bottom: 0;
  }
`

const DependencyInfo = styled.div`
  min-width: 0;
`

const PathText = styled(SettingDescription)`
  margin-top: 4px;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const VersionText = styled.span`
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-3);
  font-size: 12px;
`

export default EnvironmentDependenciesSettings
