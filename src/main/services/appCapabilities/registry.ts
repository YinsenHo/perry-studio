import type {
  AppCapabilityDefinition,
  AppCapabilityDescriptor,
  AppCapabilityListOptions,
  AppCapabilitySearchOptions
} from './types'

const normalize = (value: string) => value.toLowerCase().replace(/[_./:-]+/g, ' ')

const tokenize = (value: string) =>
  normalize(value)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

const QUERY_EXPANSIONS: Array<[RegExp, string[]]> = [
  [/备份|备份一下|保存数据/, ['backup', 'storage', 'create', 'data']],
  [/恢复|还原/, ['restore', 'backup', 'storage']],
  [/设置|配置|偏好/, ['settings', 'preferences', 'configuration']],
  [/语言/, ['language', 'settings']],
  [/主题|外观/, ['theme', 'display', 'settings']],
  [/知识库|知识|检索|搜索资料|rag/i, ['knowledge', 'rag', 'search']],
  [/笔记|文档|markdown/i, ['notes', 'markdown']],
  [/绘图|画图|生图|图片生成|图像生成/, ['paintings', 'image', 'generate', 'drawing']],
  [/智能体|agent/i, ['agents', 'agent']],
  [/mcp|工具|tool/i, ['mcp', 'tools']],
  [/任务|定时|计划/, ['tasks', 'schedule']],
  [/会话|对话/, ['sessions', 'conversations', 'chat']],
  [/模型|model/i, ['models', 'llm']],
  [/文件/, ['files', 'storage']],
  [/打开|跳转|进入/, ['open', 'navigate']],
  [/创建|新建/, ['create', 'new']],
  [/删除|移除/, ['delete', 'remove']],
  [/列表|列出|查看/, ['list', 'read']]
]

const expandQueryTerms = (query: string) => {
  const expanded = new Set(tokenize(query))
  for (const [pattern, additions] of QUERY_EXPANSIONS) {
    if (pattern.test(query)) {
      additions.forEach((term) => expanded.add(term))
    }
  }
  return Array.from(expanded)
}

export class AppCapabilityRegistry {
  private readonly capabilities = new Map<string, AppCapabilityDefinition>()

  register(capability: AppCapabilityDefinition): void {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Duplicate app capability: ${capability.id}`)
    }
    this.capabilities.set(capability.id, capability)
  }

  registerMany(capabilities: AppCapabilityDefinition[]): void {
    for (const capability of capabilities) {
      this.register(capability)
    }
  }

  get(id: string): AppCapabilityDefinition | undefined {
    return this.capabilities.get(id)
  }

  list(options: AppCapabilityListOptions = {}): AppCapabilityDescriptor[] {
    return Array.from(this.capabilities.values())
      .filter((capability) => this.matchesListOptions(capability, options))
      .map((capability) => this.toDescriptor(capability, options.includeSchemas === true))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  search(options: AppCapabilitySearchOptions = {}): AppCapabilityDescriptor[] {
    const query = (options.query ?? '').trim()
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50))
    if (!query) {
      return this.list(options).slice(0, limit)
    }

    const terms = expandQueryTerms(query)
    return Array.from(this.capabilities.values())
      .filter((capability) => this.matchesListOptions(capability, options))
      .map((capability) => ({
        capability,
        score: this.score(capability, terms)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
      .slice(0, limit)
      .map((item) => this.toDescriptor(item.capability, options.includeSchemas === true))
  }

  private matchesListOptions(capability: AppCapabilityDefinition, options: AppCapabilityListOptions): boolean {
    if (!options.includeHidden && capability.hidden) return false
    if (options.domain && capability.domain !== options.domain) return false
    if (options.risk && capability.risk !== options.risk) return false
    return true
  }

  private score(capability: AppCapabilityDefinition, terms: string[]): number {
    const fields = [
      [capability.id, 12],
      [capability.domain, 8],
      [capability.title, 7],
      [capability.description, 4],
      [(capability.tags ?? []).join(' '), 5],
      [(capability.aliases ?? []).join(' '), 6],
      [(capability.examples ?? []).join(' '), 3]
    ] as const

    let score = 0
    for (const term of terms) {
      for (const [field, weight] of fields) {
        const normalized = normalize(field)
        if (normalized === term) {
          score += weight * 2
        } else if (normalized.includes(term)) {
          score += weight
        }
      }
    }
    return score
  }

  private toDescriptor(capability: AppCapabilityDefinition, includeSchema: boolean): AppCapabilityDescriptor {
    const { execute: _execute, inputSchema, outputSchema, ...descriptor } = capability
    return {
      ...descriptor,
      ...(includeSchema ? { inputSchema, outputSchema } : {})
    }
  }
}
