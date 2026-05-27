import { PlusOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { Sortable, useDndReorder } from '@renderer/components/dnd'
import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import { isLinux, isMac } from '@renderer/config/constant'
import { allMinApps } from '@renderer/config/minapps'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMinapps } from '@renderer/hooks/useMinapps'
import useNavBackgroundColor from '@renderer/hooks/useNavBackgroundColor'
import { useSettings } from '@renderer/hooks/useSettings'
import { getThemeModeLabel, getTitleLabel } from '@renderer/i18n/label'
import UpdateAppButton from '@renderer/pages/home/components/UpdateAppButton'
import tabsService from '@renderer/services/TabsService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import type { Tab } from '@renderer/store/tabs'
import { addTab, removeTab, setActiveTab, setTabs } from '@renderer/store/tabs'
import type { MinAppType } from '@renderer/types'
import { ThemeMode } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { markRouteSwitchStart } from '@renderer/utils/routePerformance'
import { getTabBaseId, getTabIdFromPath } from '@renderer/utils/tabs'
import { Tooltip } from 'antd'
import type { LRUCache } from 'lru-cache'
import {
  Bot,
  FileSearch,
  Folder,
  Languages,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Moon,
  MousePointerClick,
  NotepadText,
  Palette,
  Settings,
  Sparkle,
  Sun,
  Terminal,
  X
} from 'lucide-react'
import type { CSSProperties } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import MinAppIcon from '../Icons/MinAppIcon'
import { OpenClawIcon } from '../Icons/SVGIcon'
import MinAppTabsPool from '../MinApp/MinAppTabsPool'
import WindowControls from '../WindowControls'

interface TabsContainerProps {
  children: React.ReactNode
  withSidebar?: boolean
}

const logger = loggerService.withContext('TabContainer')

const getTabIcon = (
  tabId: string,
  minapps: MinAppType[],
  minAppsCache?: LRUCache<string, MinAppType>
): React.ReactNode | undefined => {
  const baseTabId = getTabBaseId(tabId)

  // Check if it's a minapp tab (format: apps:appId)
  if (baseTabId.startsWith('apps:')) {
    const appId = baseTabId.replace('apps:', '')
    let app = [...allMinApps, ...minapps].find((app) => app.id === appId)

    // If not found in permanent apps, search in temporary apps cache
    // The cache stores apps opened via openSmartMinapp() for top navbar mode
    // These are temporary MinApps that were opened but not yet saved to user's config
    // The cache is LRU (Least Recently Used) with max size from settings
    // Cache validity: Apps in cache are currently active/recently used, not outdated
    if (!app && minAppsCache) {
      app = minAppsCache.get(appId)

      // Defensive programming: If app not found in cache but tab exists,
      // the cache entry may have been evicted due to LRU policy
      // Log warning for debugging potential sync issues
      if (!app) {
        logger.warn(`MinApp ${appId} not found in cache, using fallback icon`)
      }
    }

    if (app) {
      return <MinAppIcon size={14} app={app} />
    }

    // Fallback: If no app found (cache evicted), show default icon
    return <LayoutGrid size={14} />
  }

  // TODO: Add TabId as type instead of string
  switch (baseTabId) {
    case 'home':
      return <MessageSquare size={14} />
    case 'agents':
      return <MousePointerClick size={14} />
    case 'store':
      return <Sparkle size={14} />
    case 'translate':
      return <Languages size={14} />
    case 'paintings':
      return <Palette size={14} />
    case 'apps':
      return <LayoutGrid size={14} />
    case 'notes':
      return <NotepadText size={14} />
    case 'knowledge':
      return <FileSearch size={14} />
    case 'files':
      return <Folder size={14} />
    case 'settings':
      return <Settings size={14} />
    case 'code':
      return <Terminal size={14} />
    case 'openclaw':
      return <OpenClawIcon style={{ width: 14, height: 14 }} />
    case 'hermes':
      return <Bot size={14} />
    default:
      return null
  }
}

let lastSettingsPath = '/settings/provider'
const specialTabs = ['launchpad']

const TabsContainer: React.FC<TabsContainerProps> = ({ children, withSidebar = false }) => {
  const location = useLocation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((state) => state.tabs.tabs)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const isFullscreen = useFullscreen()
  const { settedTheme, toggleTheme } = useTheme()
  const { hideMinappPopup, minAppsCache } = useMinappPopup()
  const { minapps } = useMinapps()
  const { useSystemTitleBar } = useSettings()
  const backgroundColor = useNavBackgroundColor()
  const { t } = useTranslation()
  const pendingNavigationFrame = useRef<number | null>(null)
  const pendingNavigationPath = useRef<string | null>(null)
  const tabsBarStyle = useMemo(
    () =>
      ({
        backgroundColor,
        '--tabs-bar-background': backgroundColor
      }) as CSSProperties & Record<'--tabs-bar-background', string>,
    [backgroundColor]
  )

  const getLocationPath = () => `${location.pathname}${location.search}`

  const navigateDeferred = useCallback(
    (path: string, source = 'tabbar') => {
      if (path === getLocationPath()) {
        return
      }

      if (pendingNavigationFrame.current) {
        cancelAnimationFrame(pendingNavigationFrame.current)
      }

      pendingNavigationPath.current = path
      markRouteSwitchStart(source, path)
      pendingNavigationFrame.current = requestAnimationFrame(() => {
        pendingNavigationFrame.current = requestAnimationFrame(() => {
          pendingNavigationFrame.current = null
          startTransition(() => {
            navigate(path)
          })
        })
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location.pathname, location.search, navigate]
  )

  useEffect(() => {
    return () => {
      if (pendingNavigationFrame.current) {
        cancelAnimationFrame(pendingNavigationFrame.current)
      }
      pendingNavigationPath.current = null
    }
  }, [])

  const getTabTitle = (tabId: string): string => {
    const baseTabId = getTabBaseId(tabId)

    // Check if it's a minapp tab
    if (baseTabId.startsWith('apps:')) {
      const appId = baseTabId.replace('apps:', '')
      let app = [...allMinApps, ...minapps].find((app) => app.id === appId)

      // If not found in permanent apps, search in temporary apps cache
      // This ensures temporary MinApps display proper titles while being used
      // The LRU cache automatically manages app lifecycle and prevents memory leaks
      if (!app && minAppsCache) {
        app = minAppsCache.get(appId)

        // Defensive programming: If app not found in cache but tab exists,
        // the cache entry may have been evicted due to LRU policy
        if (!app) {
          logger.warn(`MinApp ${appId} not found in cache, using fallback title`)
        }
      }

      // Return app name if found, otherwise use fallback with appId
      return app ? app.name : `MinApp-${appId}`
    }
    if (baseTabId === 'hermes') {
      return 'Hermes'
    }
    return getTitleLabel(baseTabId)
  }

  const shouldCreateTab = (path: string) => {
    const { pathname } = new URL(path || '/', 'app://perry')
    if (pathname === '/') return false
    if (pathname === '/settings') return false
    return !tabs.some((tab) => tab.id === getTabIdFromPath(path))
  }

  const removeSpecialTabs = useCallback(() => {
    specialTabs.forEach((tabId) => {
      if (getTabBaseId(activeTabId) !== tabId && tabs.some((tab) => getTabBaseId(tab.id) === tabId)) {
        dispatch(removeTab(tabId))
      }
    })
  }, [activeTabId, dispatch, tabs])

  useEffect(() => {
    const locationPath = getLocationPath()
    if (pendingNavigationPath.current && pendingNavigationPath.current !== locationPath) {
      return
    }
    pendingNavigationPath.current = null

    const tabId = getTabIdFromPath(locationPath)
    const currentTab = tabs.find((tab) => tab.id === tabId)

    if (!currentTab && shouldCreateTab(locationPath)) {
      dispatch(addTab({ id: tabId, path: locationPath }))
    } else if (currentTab && activeTabId !== currentTab.id) {
      dispatch(setActiveTab(currentTab.id))
    }

    // 当访问设置页面时，记录路径
    if (location.pathname.startsWith('/settings/')) {
      lastSettingsPath = location.pathname
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, dispatch, location.pathname, location.search, tabs])

  useEffect(() => {
    removeSpecialTabs()
  }, [removeSpecialTabs])

  const closeTab = (tabId: string) => {
    tabsService.closeTab(tabId)
  }

  const handleAddTab = () => {
    hideMinappPopup()
    navigateDeferred('/launchpad', 'new-tab')
  }

  const handleSettingsClick = () => {
    hideMinappPopup()
    navigateDeferred(lastSettingsPath, 'settings-button')
  }

  const handleTabClick = (tab: Tab) => {
    hideMinappPopup()
    if (activeTabId !== tab.id) {
      dispatch(setActiveTab(tab.id))
    }
    navigateDeferred(tab.path, 'tabbar')
  }

  const visibleTabs = useMemo(() => tabs.filter((tab) => !specialTabs.includes(getTabBaseId(tab.id))), [tabs])

  const { onSortEnd } = useDndReorder<Tab>({
    originalList: tabs,
    filteredList: visibleTabs,
    onUpdate: (newTabs) => dispatch(setTabs(newTabs)),
    itemKey: 'id'
  })
  const hasMultipleVisibleTabs = visibleTabs.length > 1
  const tabScrollKey = useMemo(() => visibleTabs.map((tab) => tab.id).join('|'), [visibleTabs])

  return (
    <Container>
      <TabsBar $isFullscreen={isFullscreen} $withSidebar={withSidebar} style={tabsBarStyle}>
        <HorizontalScrollContainer
          dependencies={[tabScrollKey]}
          gap="4px"
          className="tab-scroll-container"
          classNames={{ content: 'tab-scroll-content' }}>
          {hasMultipleVisibleTabs && (
            <Sortable
              items={visibleTabs}
              itemKey="id"
              layout="list"
              horizontal
              gap={'4px'}
              onSortEnd={onSortEnd}
              className="tabs-sortable"
              renderItem={(tab) => {
                return (
                  <Tab
                    key={tab.id}
                    active={tab.id === activeTabId}
                    onClick={() => handleTabClick(tab)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        e.stopPropagation()
                        closeTab(tab.id)
                      }
                    }}>
                    <TabHeader>
                      {tab.id && <TabIcon>{getTabIcon(tab.id, minapps, minAppsCache)}</TabIcon>}
                      <TabTitle>{getTabTitle(tab.id)}</TabTitle>
                    </TabHeader>
                    <CloseButton
                      className="close-button"
                      data-no-dnd
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}>
                      <X size={12} />
                    </CloseButton>
                  </Tab>
                )
              }}
            />
          )}
          <AddTabButton
            onClick={handleAddTab}
            className={classNames({ active: getTabBaseId(activeTabId) === 'launchpad' })}>
            <PlusOutlined />
          </AddTabButton>
        </HorizontalScrollContainer>
        {!withSidebar && (
          <RightButtonsContainer style={{ paddingRight: isLinux && useSystemTitleBar ? '12px' : undefined }}>
            <UpdateAppButton />
            <Tooltip
              title={t('settings.theme.title') + ': ' + getThemeModeLabel(settedTheme)}
              mouseEnterDelay={0.8}
              placement="bottom">
              <ThemeButton onClick={toggleTheme}>
                {settedTheme === ThemeMode.dark ? (
                  <Moon size={16} />
                ) : settedTheme === ThemeMode.light ? (
                  <Sun size={16} />
                ) : (
                  <Monitor size={16} />
                )}
              </ThemeButton>
            </Tooltip>
            <SettingsButton onClick={handleSettingsClick} $active={getTabBaseId(activeTabId) === 'settings'}>
              <Settings size={16} />
            </SettingsButton>
          </RightButtonsContainer>
        )}
        <WindowControls />
      </TabsBar>
      <TabContent $withSidebar={withSidebar}>
        {/* MiniApp WebView 池（Tab 模式保活） */}
        <MinAppTabsPool />
        {children}
      </TabContent>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
`

const TabsBar = styled.div<{ $isFullscreen: boolean; $withSidebar: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  gap: 4px;
  padding-left: ${({ $isFullscreen, $withSidebar }) =>
    $withSidebar
      ? !$isFullscreen && isMac
        ? '30px'
        : '8px'
      : !$isFullscreen && isMac
        ? 'calc(env(titlebar-area-x) + 74px)'
        : '15px'};
  padding-right: ${({ $isFullscreen }) => ($isFullscreen ? '12px' : '0')};
  height: var(--navbar-height);
  min-height: ${({ $isFullscreen, $withSidebar }) =>
    !$isFullscreen && isMac && !$withSidebar ? 'env(titlebar-area-height)' : 'var(--navbar-height)'};
  position: relative;
  z-index: 2;
  border-bottom: none;
  background: var(--tabs-bar-background, var(--navbar-background));
  -webkit-app-region: drag;

  /* 确保交互元素在拖拽区域之上 */
  > * {
    position: relative;
    z-index: 1;
    -webkit-app-region: no-drag;
  }

  .tab-scroll-container {
    align-items: flex-end;
    height: 100%;
    -webkit-app-region: drag;

    > * {
      align-items: flex-end;
      height: 100%;
      overflow-y: visible;
      -webkit-app-region: no-drag;
    }
  }

  .tab-scroll-content {
    overflow-y: visible;
  }
`

const Tab = styled.div<{ active?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 9px;
  position: relative;
  align-self: flex-end;
  z-index: ${(props) => (props.active ? 2 : 1)};
  margin-bottom: -1px;
  background: ${(props) => (props.active ? 'var(--color-background)' : 'transparent')};
  border: none;
  transition:
    background 0.2s,
    box-shadow 0.2s;
  border-radius: ${(props) => (props.active ? '9px 9px 0 0' : '7px')};
  user-select: none;
  height: 30px;
  min-width: 108px;
  max-width: 168px;
  box-shadow: ${(props) =>
    props.active
      ? `inset 0 0.5px 0 var(--color-border),
         inset 0.5px 0 0 var(--color-border),
         inset -0.5px 0 0 var(--color-border)`
      : 'none'};
  contain: layout;

  ${(props) =>
    props.active &&
    `
      &::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        bottom: -2px;
        height: 3px;
        background: var(--color-background);
        pointer-events: none;
      }
    `}

  .close-button {
    opacity: 0;
    transition: opacity 0.2s;
  }

  &:hover {
    background: ${(props) =>
      props.active ? 'var(--color-background)' : 'color-mix(in srgb, var(--color-list-item) 70%, transparent)'};
    .close-button {
      opacity: 1;
    }
  }
`

const TabHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1;
`

const TabIcon = styled.span`
  display: flex;
  align-items: center;
  color: var(--color-text-2);
  flex-shrink: 0;
`

const TabTitle = styled.span`
  color: var(--color-text);
  font-size: 12px;
  display: flex;
  align-items: center;
  margin-right: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`

const CloseButton = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;

  &:hover {
    background: color-mix(in srgb, var(--color-text) 10%, transparent);
  }
`

const AddTabButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  align-self: flex-end;
  margin-bottom: 4px;
  cursor: pointer;
  color: var(--color-text-2);
  border-radius: 7px;
  flex-shrink: 0;
  &.active {
    background: var(--color-list-item);
  }
  &:hover {
    background: var(--color-list-item);
  }
`

const RightButtonsContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-right: ${isMac ? '12px' : '0'};
  flex-shrink: 0;
`

const ThemeButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  cursor: pointer;
  color: var(--color-text);

  &:hover {
    background: var(--color-list-item);
    border-radius: 8px;
  }
`

const SettingsButton = styled.div<{ $active: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  cursor: pointer;
  color: var(--color-text);
  border-radius: 8px;
  background: ${(props) => (props.$active ? 'var(--color-list-item)' : 'transparent')};
  &:hover {
    background: var(--color-list-item);
  }
`

const TabContent = styled.div<{ $withSidebar: boolean }>`
  display: flex;
  flex: 1;
  overflow: hidden;
  width: ${({ $withSidebar }) => ($withSidebar ? '100%' : 'calc(100% - 12px)')};
  margin: ${({ $withSidebar }) => ($withSidebar ? '0' : '6px')};
  margin-top: -1px;
  padding-top: 1px;
  border-radius: ${({ $withSidebar }) => ($withSidebar ? '10px 0 0 0' : '8px')};
  background: var(--color-background);
  overflow: hidden;
  position: relative; /* 约束 MinAppTabsPool 绝对定位范围 */
  z-index: 1;
`

export default TabsContainer
