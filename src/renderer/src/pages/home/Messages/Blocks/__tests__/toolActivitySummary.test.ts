import { MessageBlockStatus, MessageBlockType, type ToolMessageBlock } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { getToolActivitySummary } from '../toolActivitySummary'

const block = (toolName: string, args: Record<string, unknown>): ToolMessageBlock =>
  ({
    id: `tool-${toolName}`,
    messageId: 'message-1',
    type: MessageBlockType.TOOL,
    status: MessageBlockStatus.SUCCESS,
    toolId: toolName,
    metadata: {
      rawMcpToolResponse: {
        id: 'call-1',
        toolCallId: 'call-1',
        status: 'done',
        tool: {
          id: toolName,
          name: toolName,
          description: '',
          type: 'provider'
        },
        arguments: args
      }
    }
  }) as ToolMessageBlock

describe('getToolActivitySummary', () => {
  it.each([
    [
      'turns CLI install command descriptions into task labels',
      { description: 'Install feishu-cli globally via npm', command: 'npm install -g feishu-cli' },
      'zh-CN',
      '安装飞书 CLI'
    ],
    [
      'turns documentation fetch descriptions into task labels',
      { description: 'Fetch Feishu CLI installation guide with fallback', command: 'curl -fsSL https://example.com' },
      'zh-CN',
      '获取飞书 CLI 安装指南'
    ],
    [
      'turns documentation guide fallbacks into localized task labels',
      { description: 'Fetch Feishu CLI guide with insecure flag', command: 'curl -k https://example.com' },
      'zh-CN',
      '获取飞书 CLI 指南'
    ],
    [
      'does not expose local install workaround wording in the summary',
      { description: 'Install feishu-cli locally in workspace', command: 'npm install feishu-cli' },
      'zh-CN',
      '安装飞书 CLI'
    ],
    [
      'falls back to command parsing when no description exists',
      { command: 'npm install -g feishu-cli' },
      'zh-CN',
      '安装飞书 CLI'
    ],
    [
      'translates natural-language npm search descriptions in Chinese UI',
      { description: 'Search for feishu related global npm packages', command: 'npm search feishu' },
      'zh-CN',
      '查找飞书相关 npm 包'
    ],
    [
      'translates npm registry search wording in Chinese UI',
      { description: 'Search npm for @feishu packages', command: 'npm search @feishu' },
      'zh-CN',
      '查找飞书相关 npm 包'
    ],
    [
      'translates command-only npm searches in Chinese UI',
      { command: 'npm search feishu' },
      'zh-CN',
      '查找飞书相关 npm 包'
    ],
    [
      'translates common diagnostic descriptions in Chinese UI',
      { description: 'Check target skill location', command: 'test -f .codex/skills/example/SKILL.md' },
      'zh-CN',
      '检查技能位置'
    ],
    [
      'keeps natural-language summaries in English UI',
      { description: 'Search for feishu related global npm packages', command: 'npm search feishu' },
      'en-US',
      'Find Feishu npm packages'
    ]
  ])('%s', (_name, args, language, expected) => {
    expect(getToolActivitySummary(block('Bash', args), language)).toBe(expected)
  })
})
