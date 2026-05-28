import { loggerService } from '@renderer/services/LoggerService'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import { persistStorageV2ReduxSlice } from '@renderer/services/StorageV2ReduxSliceService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addDirectory,
  clearDirectories,
  initialState as initialCodeToolsState,
  removeDirectory,
  resetCodeTools,
  setCurrentDirectory,
  setEnvironmentVariables,
  setSelectedCliTool,
  setSelectedModel,
  setSelectedTerminal
} from '@renderer/store/codeTools'
import type { Model } from '@renderer/types'
import { codeTools } from '@shared/config/constant'
import { useCallback } from 'react'

function flushCodeToolsMirror(reason: string): void
function flushCodeToolsMirror(reason: string, options: { strict: true }): Promise<void>
function flushCodeToolsMirror(reason: string, options?: { strict?: boolean }) {
  const task = flushStorageV2ReduxMirror(reason, options)
  if (options?.strict) return task
  void task
  return undefined
}

export const useCodeTools = () => {
  const dispatch = useAppDispatch()
  const codeToolsState = useAppSelector((state) => state.codeTools)
  const logger = loggerService.withContext('useCodeTools')

  // 设置选择的 CLI 工具
  const setCliTool = useCallback(
    (tool: codeTools) => {
      dispatch(setSelectedCliTool(tool))
      flushCodeToolsMirror('code-tools-selected-cli')
    },
    [dispatch]
  )

  // 设置选择的模型
  const setModel = useCallback(
    (model: Model | null) => {
      dispatch(setSelectedModel(model))
      flushCodeToolsMirror('code-tools-selected-model')
    },
    [dispatch]
  )

  // 设置选择的终端
  const setTerminal = useCallback(
    (terminal: string) => {
      dispatch(setSelectedTerminal(terminal))
      flushCodeToolsMirror('code-tools-selected-terminal')
    },
    [dispatch]
  )

  // 设置环境变量
  const setEnvVars = useCallback(
    (envVars: string) => {
      dispatch(setEnvironmentVariables(envVars))
      flushCodeToolsMirror('code-tools-env-vars')
    },
    [dispatch]
  )

  // 添加目录
  const addDir = useCallback(
    (directory: string) => {
      dispatch(addDirectory(directory))
      flushCodeToolsMirror('code-tools-add-directory')
    },
    [dispatch]
  )

  // 删除目录
  const removeDir = useCallback(
    async (directory: string) => {
      await persistStorageV2ReduxSlice('codeTools', {
        ...codeToolsState,
        directories: codeToolsState.directories.filter((dir) => dir !== directory),
        currentDirectory: codeToolsState.currentDirectory === directory ? '' : codeToolsState.currentDirectory
      })
      dispatch(removeDirectory(directory))
      await flushCodeToolsMirror('code-tools-remove-directory', { strict: true })
    },
    [codeToolsState, dispatch]
  )

  // 设置当前目录
  const setCurrentDir = useCallback(
    (directory: string) => {
      dispatch(setCurrentDirectory(directory))
      flushCodeToolsMirror('code-tools-current-directory')
    },
    [dispatch]
  )

  // 清空所有目录
  const clearDirs = useCallback(async () => {
    await persistStorageV2ReduxSlice('codeTools', {
      ...codeToolsState,
      directories: [],
      currentDirectory: ''
    })
    dispatch(clearDirectories())
    await flushCodeToolsMirror('code-tools-clear-directories', { strict: true })
  }, [codeToolsState, dispatch])

  // 重置所有设置
  const resetSettings = useCallback(async () => {
    await persistStorageV2ReduxSlice('codeTools', initialCodeToolsState)
    dispatch(resetCodeTools())
    await flushCodeToolsMirror('code-tools-reset', { strict: true })
  }, [dispatch])

  // 选择文件夹的辅助函数
  const selectFolder = useCallback(async () => {
    try {
      const folderPath = await window.api.file.selectFolder()
      if (folderPath) {
        setCurrentDir(folderPath)
        return folderPath
      }
      return null
    } catch (error) {
      logger.error('选择文件夹失败:', error as Error)
      throw error
    }
  }, [setCurrentDir, logger])

  // 获取当前CLI工具选择的模型
  const selectedModel = codeToolsState.selectedModels[codeToolsState.selectedCliTool] || null

  // 获取当前CLI工具的环境变量
  const environmentVariables = codeToolsState?.environmentVariables?.[codeToolsState.selectedCliTool] || ''

  // 检查是否可以启动（所有必需字段都已填写）
  const canLaunch = Boolean(
    codeToolsState.selectedCliTool &&
      codeToolsState.currentDirectory &&
      (codeToolsState.selectedCliTool === codeTools.githubCopilotCli || selectedModel)
  )

  return {
    // 状态
    selectedCliTool: codeToolsState.selectedCliTool,
    selectedModel: selectedModel,
    selectedTerminal: codeToolsState.selectedTerminal,
    environmentVariables: environmentVariables,
    directories: codeToolsState.directories,
    currentDirectory: codeToolsState.currentDirectory,
    canLaunch,

    // 操作函数
    setCliTool,
    setModel,
    setTerminal,
    setEnvVars,
    addDir,
    removeDir,
    setCurrentDir,
    clearDirs,
    resetSettings,
    selectFolder
  }
}
