import type { ToolMessageBlock } from '@renderer/types/newMessage'

const KNOWN_SUBJECTS: Array<{ pattern: RegExp; zh: string; en: string }> = [
  { pattern: /(?:@?feishu|lark)[-\s_]*cli/i, zh: '飞书 CLI', en: 'Feishu CLI' },
  { pattern: /@feishu/i, zh: '飞书', en: 'Feishu' },
  { pattern: /\b(?:feishu|lark)\b/i, zh: '飞书', en: 'Feishu' }
]

const ZH_SUBJECTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^(?:project|package)\s+dependenc(?:y|ies)$/i, label: '项目依赖' },
  { pattern: /^target\s+skill\s+location$/i, label: '技能位置' },
  { pattern: /^other\s+package\s+managers?$/i, label: '包管理器' },
  { pattern: /^package\s+managers?$/i, label: '包管理器' },
  { pattern: /^repositories$/i, label: '代码仓库' },
  { pattern: /^repository$/i, label: '代码仓库' },
  { pattern: /^tool$/i, label: '工具' },
  { pattern: /^tools$/i, label: '工具' },
  { pattern: /^workspace$/i, label: '工作区' },
  { pattern: /^environment$/i, label: '运行环境' }
]

const isZh = (language?: string) => language?.toLowerCase().startsWith('zh')
const local = (language: string | undefined, zh: string, en: string) => (isZh(language) ? zh : en)

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

const argsOf = (block: ToolMessageBlock): Record<string, unknown> | undefined => {
  const args = block.metadata?.rawMcpToolResponse?.arguments ?? block.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  return args
}

const toolNameOf = (block: ToolMessageBlock) => {
  return block.metadata?.rawMcpToolResponse?.tool?.name || block.toolName || block.toolId || 'Tool'
}

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const stripPackageDecoration = (value: string) => {
  return value
    .replace(/^["'`]|["'`]$/g, '')
    .replace(
      /\s+(?:globally|locally|in workspace|in the workspace|via npm|using npm|with npm|related global npm packages?|related npm packages?|global npm packages?|npm packages?).*$/i,
      ''
    )
    .trim()
}

const formatSubject = (raw: string, language?: string) => {
  const cleaned = stripPackageDecoration(normalizeWhitespace(raw))
  const known = KNOWN_SUBJECTS.find((item) => item.pattern.test(cleaned))
  if (known) return local(language, known.zh, known.en)
  if (isZh(language)) {
    const subject = ZH_SUBJECTS.find((item) => item.pattern.test(cleaned))
    if (subject) return subject.label
  }
  return cleaned
}

const normalizeZhSearchSubject = (raw: string, language?: string) =>
  formatSubject(raw, language)
    .replace(/\brelated\b/gi, '相关')
    .replace(/\bglobal\b/gi, '')
    .replace(/\bnpm\b/gi, 'npm')
    .replace(/\bpackages?\b/gi, '包')
    .replace(/\s+/g, '')
    .trim()

const formatZhTask = (verb: string, subject: string, suffix = '') => {
  const spacer = suffix && /[A-Za-z0-9]$/.test(subject) ? ' ' : ''
  return `${verb}${subject}${spacer}${suffix}`
}

const formatAction = (
  raw: string,
  language: string | undefined,
  zhVerb: string,
  enVerb: string,
  zhSuffix = '',
  enSuffix = ''
) => {
  const subject = formatSubject(raw, language)
  return local(language, formatZhTask(zhVerb, subject, zhSuffix), `${enVerb} ${subject}${enSuffix}`)
}

const basename = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || normalized
}

const ACTION_RULES: Array<[RegExp, string, string]> = [
  [/^fetch\s+(.+)$/i, '获取', 'Fetch'],
  [/^read\s+(.+)$/i, '读取', 'Read'],
  [/^list\s+(.+)$/i, '查看', 'List'],
  [/^check\s+(.+)$/i, '检查', 'Check'],
  [/^(?:inspect|probe|verify|test|look\s+for|locate)\s+(.+)$/i, '检查', 'Check'],
  [/^register\s+(.+?)(?:\s+(?:globally|locally|after)\b.*)?$/i, '注册', 'Register'],
  [/^run\s+(.+)$/i, '运行', 'Run']
]

const summarizeEnglishDescription = (description: string, language?: string): string | undefined => {
  const value = normalizeWhitespace(description)

  if (/^install (?:project |package )?dependenc(?:y|ies)\b/i.test(value)) {
    return local(language, '安装项目依赖', 'Install project dependencies')
  }

  const installMatch = value.match(
    /^install\s+(.+?)(?:\s+(?:globally|locally|in workspace|in the workspace|via|using|with)\b.*)?$/i
  )
  if (installMatch?.[1]) {
    const subject = formatSubject(installMatch[1], language)
    return local(language, `安装${subject}`, `Install ${subject}`)
  }

  const fetchGuideMatch = value.match(/^fetch\s+(.+?)\s+(?:installation\s+)?guide(?:\s+with\s+.+)?$/i)
  if (fetchGuideMatch?.[1]) {
    const subject = formatSubject(fetchGuideMatch[1], language)
    const isInstallationGuide = /\binstallation\s+guide\b/i.test(value)
    if (isZh(language)) return formatZhTask('获取', subject, isInstallationGuide ? '安装指南' : '指南')
    return `Fetch ${subject}${isInstallationGuide ? ' installation' : ''} guide`
  }

  const npmSearchMatch =
    value.match(/^search\s+npm\s+for\s+(.+?)\s+packages?$/i) ??
    value.match(/^search\s+for\s+(.+?)(?:\s+related)?\s+(?:global\s+)?npm\s+packages?$/i)
  if (npmSearchMatch?.[1])
    return formatAction(npmSearchMatch[1], language, '查找', 'Find', '相关 npm 包', ' npm packages')

  const searchMatch = value.match(/^search(?:\s+for)?\s+(.+)$/i)
  if (searchMatch?.[1]) {
    const subject = isZh(language)
      ? normalizeZhSearchSubject(searchMatch[1], language)
      : formatSubject(searchMatch[1], language)
    return local(language, `搜索${subject}`, `Search ${subject}`)
  }

  for (const [pattern, zhVerb, enVerb] of ACTION_RULES) {
    const match = value.match(pattern)
    if (match?.[1]) return formatAction(match[1], language, zhVerb, enVerb)
  }

  return undefined
}

const summarizeChineseDescription = (description: string): string => {
  return normalizeWhitespace(description)
    .replace(/^让我(?:先)?/, '')
    .replace(/^正在/, '')
    .replace(/。.*$/, '')
    .trim()
}

const summarizeCommand = (command: string, language?: string): string | undefined => {
  const value = normalizeWhitespace(command)

  const globalInstallMatch = value.match(
    /\b(?:npm|pnpm)\s+(?:install|i|add)\s+(?:[^\n;&|]*\s)?(?:-g|--global)\s+([^\s;&|]+)/i
  )
  if (globalInstallMatch?.[1]) {
    const subject = formatSubject(globalInstallMatch[1], language)
    return local(language, `安装${subject}`, `Install ${subject}`)
  }

  const localInstallMatch = value.match(/\b(?:npm|pnpm)\s+(?:install|i|add)\s+([^\s;&|]+)/i)
  if (localInstallMatch?.[1]) {
    const subject = formatSubject(localInstallMatch[1], language)
    return local(language, `安装${subject}`, `Install ${subject}`)
  }

  if (/\b(?:npm|pnpm|yarn)\s+(?:install|i)\b/i.test(value)) {
    return local(language, '安装项目依赖', 'Install project dependencies')
  }

  const npmSearchMatch = value.match(/\b(?:npm|pnpm)\s+search\s+([^\s;&|]+)/i)
  if (npmSearchMatch?.[1]) {
    const subject = formatSubject(npmSearchMatch[1], language)
    return local(language, formatZhTask('查找', subject, '相关 npm 包'), `Search ${subject} npm packages`)
  }

  if (/\b(?:npm|pnpm)\s+search\b/i.test(value)) {
    return local(language, '查找 npm 包', 'Search npm packages')
  }

  if (/\b(?:curl|wget)\b/i.test(value)) {
    return local(language, '获取在线资料', 'Fetch online resource')
  }

  return undefined
}

const fileTask = (
  language: string | undefined,
  filePath: string | undefined,
  zhVerb: string,
  enVerb: string,
  zhFallback: string,
  enFallback: string
) => {
  const name = filePath ? basename(filePath) : undefined
  return local(language, name ? `${zhVerb}${name}` : zhFallback, name ? `${enVerb} ${name}` : enFallback)
}

const valueTask = (
  language: string | undefined,
  value: string | undefined,
  zhVerb: string,
  enVerb: string,
  zhFallback: string,
  enFallback: string
) => local(language, value ? `${zhVerb}${value}` : zhFallback, value ? `${enVerb} ${value}` : enFallback)

export const getToolActivitySummary = (block: ToolMessageBlock, language?: string): string => {
  const args = argsOf(block)
  const description = text(args?.description)

  if (description) {
    if (/[\u4e00-\u9fa5]/.test(description)) {
      const summarized = summarizeChineseDescription(description)
      if (summarized) return summarized
    }

    const summarized = summarizeEnglishDescription(description, language)
    if (summarized) return summarized

    return description
  }

  const commandSummary = text(args?.command) ? summarizeCommand(text(args?.command)!, language) : undefined
  if (commandSummary) return commandSummary

  const toolName = toolNameOf(block)
  const filePath = text(args?.file_path ?? args?.path)
  const pattern = text(args?.pattern)
  const query = text(args?.query)

  switch (toolName) {
    case 'Read':
      return fileTask(language, filePath, '读取', 'Read', '读取文件', 'Read file')
    case 'Write':
      return fileTask(language, filePath, '写入', 'Write', '写入文件', 'Write file')
    case 'Edit':
    case 'MultiEdit':
      return fileTask(language, filePath, '更新', 'Update', '更新文件', 'Update file')
    case 'Glob':
      return valueTask(language, pattern, '查找', 'Find', '查找文件', 'Find files')
    case 'Grep':
      return valueTask(language, pattern, '搜索', 'Search', '搜索内容', 'Search content')
    case 'WebSearch':
      return valueTask(language, query, '搜索', 'Search', '搜索网络', 'Search web')
    case 'WebFetch':
      return local(language, '获取在线资料', 'Fetch online resource')
    default:
      if (toolName.startsWith('mcp__')) return local(language, '调用 MCP 工具', 'Call MCP tool')
      return local(language, '处理任务', 'Process task')
  }
}
