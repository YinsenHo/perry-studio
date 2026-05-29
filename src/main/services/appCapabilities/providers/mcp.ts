import mcpService from '@main/services/MCPService'
import { reduxService } from '@main/services/ReduxService'

import type { AppCapabilityDefinition } from '../types'
import { okResult, sanitizeForAgent } from '../utils'

export function createMcpCapabilities(): AppCapabilityDefinition[] {
  return [
    {
      id: 'mcp.servers.list',
      domain: 'mcp',
      kind: 'query',
      title: 'List MCP servers',
      description: 'List configured MCP servers with secrets redacted.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['mcp', 'servers', 'tools'],
      execute: async () => {
        const mcpState = await reduxService.select<any>('state.mcp').catch(() => null)
        return okResult('MCP servers listed', sanitizeForAgent(mcpState?.servers ?? []))
      }
    },
    {
      id: 'mcp.tools.list',
      domain: 'mcp',
      kind: 'query',
      title: 'List active MCP tools',
      description: 'List tools from active MCP servers.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      tags: ['mcp', 'tools', 'list'],
      execute: async () => okResult('MCP tools listed', sanitizeForAgent(await mcpService.listAllActiveServerTools()))
    },
    {
      id: 'mcp.tool.call',
      domain: 'mcp',
      kind: 'command',
      title: 'Call MCP tool',
      description: 'Call an active MCP tool by tool id. Prefer directly injected MCP tools when available.',
      inputSchema: {
        type: 'object',
        properties: {
          toolId: { type: 'string', description: 'Tool id in serverId__toolName format' },
          params: { type: 'object', additionalProperties: true, description: 'Tool parameters' }
        },
        required: ['toolId']
      },
      risk: 'external',
      permissions: ['mcp.tool.call'],
      sideEffects: ['mcp.tool.call'],
      tags: ['mcp', 'tools', 'call'],
      execute: async (input: any, context) =>
        okResult(
          'MCP tool called',
          sanitizeForAgent(
            await mcpService.callToolById(String(input?.toolId), input?.params ?? {}, context.toolCallId)
          )
        )
    }
  ]
}
