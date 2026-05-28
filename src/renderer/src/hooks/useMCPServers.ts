import { createSelector } from '@reduxjs/toolkit'
import NavigationService from '@renderer/services/NavigationService'
import { flushStorageV2ReduxMirror } from '@renderer/services/StorageV2ReduxMirrorFlush'
import { persistStorageV2ReduxSlice } from '@renderer/services/StorageV2ReduxSliceService'
import type { RootState } from '@renderer/store'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { addMCPServer, deleteMCPServer, setMCPServers, updateMCPServer } from '@renderer/store/mcp'
import type { MCPConfig, MCPServer } from '@renderer/types'
import { IpcChannel } from '@shared/IpcChannel'

// Listen for server changes from main process
window.electron.ipcRenderer.on(IpcChannel.Mcp_ServersChanged, (_event, servers) => {
  store.dispatch(setMCPServers(servers))
})

window.electron.ipcRenderer.on(IpcChannel.Mcp_AddServer, (_event, server: MCPServer) => {
  store.dispatch(addMCPServer(server))
  NavigationService.navigate?.('/settings/mcp')
  NavigationService.navigate?.(`/settings/mcp/settings/${encodeURIComponent(server.id)}`)
})

const selectMcpServers = (state: RootState) => state.mcp.servers
const selectActiveMcpServers = createSelector([selectMcpServers], (servers) =>
  servers.filter((server) => server.isActive)
)

function flushMcpMirror(reason: string): void
function flushMcpMirror(reason: string, options: { strict: true }): Promise<void>
function flushMcpMirror(reason: string, options?: { strict?: boolean }) {
  const task = flushStorageV2ReduxMirror(reason, options)
  if (options?.strict) return task
  void task
  return undefined
}

async function persistMcpServerDelete(mcpState: MCPConfig, id: string) {
  await persistStorageV2ReduxSlice('mcp', {
    ...mcpState,
    servers: mcpState.servers.filter((server) => server.id !== id)
  })
}

export const useMCPServers = () => {
  const mcpState = useAppSelector((state) => state.mcp)
  const mcpServers = useAppSelector(selectMcpServers)
  const activedMcpServers = useAppSelector(selectActiveMcpServers)
  const dispatch = useAppDispatch()

  return {
    mcpServers,
    activedMcpServers,
    addMCPServer: (server: MCPServer) => {
      dispatch(addMCPServer(server))
      flushMcpMirror('mcp-add-server')
    },
    updateMCPServer: (server: MCPServer) => {
      dispatch(updateMCPServer(server))
      flushMcpMirror('mcp-update-server')
    },
    deleteMCPServer: async (id: string) => {
      await persistMcpServerDelete(mcpState, id)
      dispatch(deleteMCPServer(id))
      await flushMcpMirror('mcp-delete-server', { strict: true })
    },
    setMCPServerActive: (server: MCPServer, isActive: boolean) => {
      dispatch(updateMCPServer({ ...server, isActive }))
      flushMcpMirror('mcp-set-server-active')
    },
    getActiveMCPServers: () => mcpServers.filter((server) => server.isActive),
    updateMcpServers: (servers: MCPServer[]) => {
      dispatch(setMCPServers(servers))
      flushMcpMirror('mcp-update-servers')
    }
  }
}

export const useMCPServer = (id: string) => {
  const mcpState = useAppSelector((state) => state.mcp)
  const server = useAppSelector((state) => (state.mcp.servers || []).find((server) => server.id === id))
  const dispatch = useAppDispatch()

  return {
    server,
    updateMCPServer: (server: MCPServer) => {
      dispatch(updateMCPServer(server))
      flushMcpMirror('mcp-update-server')
    },
    setMCPServerActive: (server: MCPServer, isActive: boolean) => {
      dispatch(updateMCPServer({ ...server, isActive }))
      flushMcpMirror('mcp-set-server-active')
    },
    deleteMCPServer: async (id: string) => {
      await persistMcpServerDelete(mcpState, id)
      dispatch(deleteMCPServer(id))
      await flushMcpMirror('mcp-delete-server', { strict: true })
    }
  }
}
