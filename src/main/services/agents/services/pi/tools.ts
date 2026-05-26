import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import mcpService from '@main/services/MCPService'
import getShellEnv from '@main/utils/shell-env'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import type { MCPCallToolResponse, MCPTool, MCPToolResultContent } from '@types'
import fg from 'fast-glob'

const execFileAsync = promisify(execFile)
const MAX_READ_BYTES = 96 * 1024
const MAX_SCAN_FILE_BYTES = 512 * 1024
const MAX_SUCCESS_OUTPUT_CHARS = 24_000
const MAX_ERROR_OUTPUT_CHARS = 8_000
const MAX_SEARCH_RESULTS = 200
const BASH_TIMEOUT_MS = 120_000
const BASH_MAX_BUFFER = 1024 * 1024

type ToolResultDetails = Record<string, unknown>
type ToolParams = Record<string, any>

const textResult = (text: string, details: ToolResultDetails = {}): AgentToolResult<ToolResultDetails> => ({
  content: [{ type: 'text', text }],
  details
})

const errorTextResult = (text: string, details: ToolResultDetails = {}): AgentToolResult<ToolResultDetails> => ({
  content: [{ type: 'text', text }],
  details: { ...details, isError: true }
})

const truncateOutput = (text: string, maxChars: number) => {
  if (text.length <= maxChars) return { text, truncated: false }
  const headLength = Math.floor(maxChars * 0.35)
  const tailLength = maxChars - headLength
  return {
    text: `${text.slice(0, headLength)}\n\n[...truncated ${text.length - maxChars} chars...]\n\n${text.slice(-tailLength)}`,
    truncated: true
  }
}

const compactError = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

const RECOVERABLE_BASH_DESCRIPTION_PATTERN =
  /\b(check|inspect|probe|verify|test|look for|locate|find|list|stat|exist|target skill location)\b/i
const READ_ONLY_BASH_COMMAND_PATTERN =
  /^\s*(?:test\b|\[\s|ls\b|stat\b|find\b|rg\b|grep\b|pwd\b|printf\b|echo\b|cat\b|sed\b|awk\b|head\b|tail\b|wc\b|git\s+(?:status|diff|show|log|rev-parse|ls-files|grep)\b)/i
const POLICY_FAILURE_PATTERN = /outside accessible directories|parent directory traversal/i
const POLICY_REFUSAL_PATTERN = /^Refusing to /i
const NPM_INSTALL_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:env\s+(?:\S+\s+)*?)?(?:(?:\.{0,2}\/|\S*\/)?(?:npm|pnpm|bun|bunx|npx|corepack))\b/i
const GLOBAL_PACKAGE_INSTALL_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:(?:npm|pnpm)\s+(?:install|i|add)\s+(?:[^\n;&|]*\s)?(?:-g|--global)\b|yarn\s+global\s+add\b)/i
const NPM_MIRROR_SSL_PATTERN =
  /(?:npmmirror\.com|registry\.npmmirror\.com|cdn\.npmmirror\.com)[\s\S]{0,400}(?:SSL|certificate|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|unable to verify|unable to get local issuer|certificate verify failed|SSL routines)|(?:SSL|certificate|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|unable to verify|unable to get local issuer|certificate verify failed|SSL routines)[\s\S]{0,400}(?:npmmirror\.com|registry\.npmmirror\.com|cdn\.npmmirror\.com)/i
const SSL_CERTIFICATE_FAILURE_PATTERN =
  /SSL|certificate|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|unable to verify|unable to get local issuer|certificate verify failed|SSL routines/i
const INSTALL_BINARY_DOWNLOAD_PATTERN =
  /(?:download|fetch|install|postinstall|prebuild|binary|release|tar\.gz|tgz|zip|dmg|pkg|node-gyp|prebuild-install|esbuild|sharp|electron|playwright|puppeteer)/i
const FETCH_DOCUMENTATION_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:env\s+(?:\S+\s+)*?)?(?:curl|wget)\b/i
const FETCH_DOCUMENTATION_DESCRIPTION_PATTERN =
  /(?:fetch|get|read|download|抓取|获取|查看|下载)[\s\S]{0,80}(?:doc|docs|documentation|guide|manual|install|installation|文档|指南|安装)/i
const NPMJS_REGISTRY = 'https://registry.npmjs.org'
const SYSTEM_SSL_REPAIR_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:sudo\s+)?(?:(?:\/usr\/bin\/)?security\s+(?:add-trusted-cert|delete-certificate|trust-settings|authorizationdb)\b|(?:update-ca-certificates|update-ca-trust|trust\s+anchor|certutil\s+-A)\b|brew\s+(?:install|reinstall|upgrade)\s+(?:ca-certificates|openssl(?:@\d+)?)\b|(?:npm|pnpm|yarn)\s+config\s+set\s+strict-ssl\s+false\b|git\s+config\s+(?:--global\s+)?http\.sslVerify\s+false\b|(?:export\s+)?NODE_TLS_REJECT_UNAUTHORIZED=0\b|pip\s+config\s+set\s+global\.trusted-host\b|cp\b[\s\S]{0,240}(?:\/etc\/ssl|\/usr\/local\/etc\/openssl|\/opt\/homebrew\/etc\/openssl))/i
const SYSTEM_SSL_REPAIR_MESSAGE =
  'Refusing to change system/global SSL, certificate, curl, keychain, or trust-store configuration. Treat this as an environment issue and use a scoped fallback instead, such as app/Node fetch, an official registry retry, or a one-off insecure fetch only for public non-secret content.'
const GLOBAL_PACKAGE_REGISTRATION_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:(?:npm|pnpm|yarn)\s+(?:link|publish|login|adduser|whoami)\b|corepack\s+enable\b|(?:npm|pnpm|yarn)\s+config\s+set\s+(?:prefix|global-dir|global-bin-dir)\b)/i
const GLOBAL_PACKAGE_REGISTRATION_MESSAGE =
  'Refusing to use global npm/package registration as a workaround for workspace path restrictions. Stay inside the accessible workspace, use the injected MCP/tools, or ask the user to add the needed path to the agent workspace.'
const LOCAL_INSTALL_WORKAROUND_PATTERN =
  /(?:local|workspace|current directory|当前目录|本地工作区|工作区|换个方式|workaround|fallback|instead)[\s\S]{0,120}(?:install|安装)|(?:install|安装)[\s\S]{0,120}(?:local|workspace|current directory|当前目录|本地工作区|工作区|workaround|fallback|instead)/i
const LOCAL_INSTALL_WORKAROUND_MESSAGE =
  'Refusing to turn a path/global-install restriction into a local workspace install workaround. Only install dependencies when they are required by the current project itself.'
const MANUAL_BINARY_DOWNLOAD_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:(?:node|tsx|ts-node)\s+(?:-e|--eval|-)\b[\s\S]{0,1200}(?:fetch|https|http|request)[\s\S]{0,1200}(?:binary|bin|release|download|tar\.gz|tgz|zip|dmg|pkg|node_modules|vendor)|(?:curl|wget)\b[\s\S]{0,1200}(?:binary|bin|release|tar\.gz|tgz|zip|dmg|pkg|node_modules|vendor))/i
const MANUAL_BINARY_DOWNLOAD_MESSAGE =
  'Refusing to manually download dependency binaries as a workaround for curl/SSL/install-script failures. Stop retrying and report the dependency/environment blocker briefly.'
const DOCUMENTATION_FETCH_UNAVAILABLE_MESSAGE =
  '[Documentation fetch unavailable due to network restrictions. Do not retry with another downloader or narrate the fetch failure; continue only if package metadata or local knowledge is enough.]'

const isRecoverableBashFailure = (command: string, description: string | undefined, output: string) => {
  if (POLICY_FAILURE_PATTERN.test(output)) return false
  if (description && RECOVERABLE_BASH_DESCRIPTION_PATTERN.test(description)) return true
  return READ_ONLY_BASH_COMMAND_PATTERN.test(command)
}

const shouldRetryNpmMirrorWithOfficialRegistry = (command: string, output: string) => {
  return NPM_INSTALL_COMMAND_PATTERN.test(command) && NPM_MIRROR_SSL_PATTERN.test(output)
}

const isInstallBinarySslFailure = (command: string, output: string) => {
  return (
    NPM_INSTALL_COMMAND_PATTERN.test(command) &&
    !POLICY_REFUSAL_PATTERN.test(output) &&
    SSL_CERTIFICATE_FAILURE_PATTERN.test(output) &&
    INSTALL_BINARY_DOWNLOAD_PATTERN.test(output)
  )
}

const isDocumentationFetchSslFailure = (command: string, description: string | undefined, output: string) => {
  return (
    FETCH_DOCUMENTATION_COMMAND_PATTERN.test(command) &&
    !!description &&
    FETCH_DOCUMENTATION_DESCRIPTION_PATTERN.test(description) &&
    SSL_CERTIFICATE_FAILURE_PATTERN.test(output)
  )
}

const agentToolPrefixForCwd = (cwd: string) => {
  const key = Buffer.from(path.resolve(cwd)).toString('base64url').slice(0, 48)
  return path.join(process.env.TMPDIR || '/tmp', 'cherry-studio-agent-tools', key)
}

const buildBashEnv = async (cwd: string, extraEnv: NodeJS.ProcessEnv = {}) => {
  const shellEnv = await getShellEnv().catch(() => process.env)
  const toolPrefix = agentToolPrefixForCwd(cwd)
  const toolBin = path.join(toolPrefix, 'bin')
  const managedBin = path.join(os.homedir(), HOME_CHERRY_DIR, 'bin')
  const workspaceBin = path.join(cwd, 'node_modules', '.bin')
  const basePath = extraEnv.PATH ?? shellEnv.PATH ?? shellEnv.Path ?? process.env.PATH ?? ''
  const nextPath = [toolBin, workspaceBin, managedBin, basePath].filter(Boolean).join(path.delimiter)

  return {
    ...shellEnv,
    ...extraEnv,
    HOME: cwd,
    PWD: cwd,
    NPM_CONFIG_PREFIX: extraEnv.NPM_CONFIG_PREFIX ?? toolPrefix,
    npm_config_prefix: extraEnv.npm_config_prefix ?? toolPrefix,
    PNPM_HOME: extraEnv.PNPM_HOME ?? toolBin,
    YARN_PREFIX: extraEnv.YARN_PREFIX ?? toolPrefix,
    PATH: nextPath,
    ...(process.platform === 'win32' ? { Path: nextPath } : {})
  }
}

const textFromMcpContent = (item: MCPToolResultContent) => {
  if (item.type === 'text') return item.text ?? ''
  if (item.type === 'resource') {
    const uri = item.resource?.uri ? `Resource: ${item.resource.uri}\n` : ''
    return `${uri}${item.resource?.text ?? item.text ?? '[resource]'}`
  }
  if (item.type === 'image') return '[image]'
  if (item.type === 'audio') return '[audio]'
  return JSON.stringify(item)
}

const mcpResultToToolResult = (
  result: MCPCallToolResponse,
  details: ToolResultDetails
): AgentToolResult<ToolResultDetails> => {
  const content = result.content?.length
    ? result.content.map((item) => {
        if (item.type === 'image' && item.data) {
          return {
            type: 'image' as const,
            data: item.data,
            mimeType: item.mimeType ?? 'image/png'
          }
        }
        const truncated = truncateOutput(textFromMcpContent(item), MAX_SUCCESS_OUTPUT_CHARS)
        return { type: 'text' as const, text: truncated.text }
      })
    : [
        {
          type: 'text' as const,
          text: truncateOutput(JSON.stringify(result.structuredContent ?? null), MAX_SUCCESS_OUTPUT_CHARS).text
        }
      ]

  return {
    content,
    details: {
      ...details,
      structuredContent: result.structuredContent,
      isError: result.isError === true
    }
  }
}

const safeExecute = async (operation: string, fn: () => Promise<AgentToolResult<ToolResultDetails>>) => {
  try {
    return await fn()
  } catch (error) {
    return errorTextResult(`${operation} failed: ${compactError(error)}`)
  }
}

const isInside = (target: string, roots: string[]) => {
  const resolved = path.resolve(target)
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved)
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

const resolveAllowedPath = (rawPath: string | undefined, cwd: string, roots: string[]) => {
  const resolved = path.resolve(cwd, rawPath || '.')
  if (!isInside(resolved, roots)) {
    throw new Error(`Path is outside accessible directories: ${rawPath || resolved}`)
  }
  return resolved
}

const assertCommandDoesNotReferenceOutsidePaths = (command: string, roots: string[]) => {
  if (SYSTEM_SSL_REPAIR_COMMAND_PATTERN.test(command)) {
    throw new Error(SYSTEM_SSL_REPAIR_MESSAGE)
  }
  if (GLOBAL_PACKAGE_REGISTRATION_COMMAND_PATTERN.test(command)) {
    throw new Error(GLOBAL_PACKAGE_REGISTRATION_MESSAGE)
  }
  if (MANUAL_BINARY_DOWNLOAD_COMMAND_PATTERN.test(command)) {
    throw new Error(MANUAL_BINARY_DOWNLOAD_MESSAGE)
  }

  const absolutePathPattern = /(^|[\s"'`=([{:;,])((?:\/[^/\s"'`$;|&:<>(){}[\]]+)+)/g
  for (const match of command.matchAll(absolutePathPattern)) {
    const candidate = match[2]
    if (!candidate || isInside(candidate, roots)) continue
    throw new Error(`Bash command references a path outside accessible directories: ${candidate}`)
  }

  const parentTraversalPattern = /(^|[\s"'`=([{:;,])\.\.(?:\/|$)/
  if (parentTraversalPattern.test(command)) {
    throw new Error('Bash command references parent directory traversal outside the workspace boundary')
  }
}

const sandboxProfileForRoots = (roots: string[]) => {
  const deniedRoots = collectDeniedHomeSiblings(roots)
  const denyRules = deniedRoots.map((root) => `(subpath ${JSON.stringify(root)})`).join(' ')
  if (!denyRules) return '(version 1)\n(allow default)'

  return ['(version 1)', '(allow default)', `(deny file-read* ${denyRules})`, `(deny file-write* ${denyRules})`].join(
    '\n'
  )
}

const collectDeniedHomeSiblings = (roots: string[]) => {
  const home = process.env.HOME
  if (!home) return ['/etc', '/private/etc', '/var/db', '/private/var/db'].filter((item) => !isInside(item, roots))

  const allowedAncestors = new Set<string>()
  for (const root of roots) {
    let current = path.resolve(root)
    while (current.startsWith(home)) {
      allowedAncestors.add(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  const denied = ['/etc', '/private/etc', '/var/db', '/private/var/db']
  try {
    const entries = readdirSync(home, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(home, entry.name)
      if (!allowedAncestors.has(entryPath) && !roots.some((root) => isInside(entryPath, [root]))) {
        denied.push(entryPath)
      }
    }
  } catch {
    denied.push(path.join(home, '.ssh'), path.join(home, '.config'), path.join(home, 'Library'))
  }

  return denied.filter((item) => !roots.some((root) => isInside(item, [root])))
}

const runBash = async (
  command: string,
  cwd: string,
  roots: string[],
  signal?: AbortSignal,
  extraEnv: NodeJS.ProcessEnv = {}
) => {
  assertCommandDoesNotReferenceOutsidePaths(command, roots)

  const env = await buildBashEnv(cwd, extraEnv)

  if (process.platform === 'darwin') {
    return await execFileAsync(
      '/usr/bin/sandbox-exec',
      ['-p', sandboxProfileForRoots(roots), '/bin/zsh', '-lc', command],
      {
        cwd,
        env,
        signal,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: BASH_MAX_BUFFER
      }
    )
  }

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
  return await execFileAsync(shell, args, {
    cwd,
    env,
    signal,
    timeout: BASH_TIMEOUT_MS,
    maxBuffer: BASH_MAX_BUFFER
  })
}

const toDisplayPath = (target: string, cwd: string) => {
  const relative = path.relative(cwd, target)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target
}

async function walkFiles(root: string, cwd: string, roots: string[], results: string[] = []): Promise<string[]> {
  const resolvedRoot = resolveAllowedPath(root, cwd, roots)
  const entries = await fs.readdir(resolvedRoot, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const entryPath = path.join(resolvedRoot, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(entryPath, cwd, roots, results)
      continue
    }
    if (entry.isFile()) {
      results.push(entryPath)
    }
    if (results.length >= MAX_SEARCH_RESULTS * 20) break
  }

  return results
}

export function createPiTools(cwd: string, accessiblePaths: string[]): AgentTool<any>[] {
  const roots = accessiblePaths.length > 0 ? accessiblePaths.map((p) => path.resolve(p)) : [path.resolve(cwd)]

  const readTool: AgentTool<any> = {
    name: 'Read',
    label: 'Read',
    description: 'Reads the contents of a file',
    parameters: Type.Object({
      file_path: Type.Optional(Type.String({ description: 'Path to the file to read' })),
      path: Type.Optional(Type.String({ description: 'Path to the file to read' })),
      offset: Type.Optional(Type.Number({ description: 'Line number to start reading from, 1-indexed' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' }))
    }),
    async execute(_toolCallId, params) {
      return safeExecute('Read', async () => {
        const input = params as ToolParams
        const filePath = resolveAllowedPath(input.file_path ?? input.path, cwd, roots)
        const buffer = await fs.readFile(filePath)
        const truncated = buffer.byteLength > MAX_READ_BYTES && !input.limit
        let text = truncated ? buffer.subarray(0, MAX_READ_BYTES).toString('utf8') : buffer.toString('utf8')
        const lines = text.split(/\r?\n/)
        if (input.offset || input.limit) {
          const start = Math.max((input.offset ?? 1) - 1, 0)
          text = lines.slice(start, input.limit ? start + input.limit : undefined).join('\n')
        }
        if (truncated) {
          text += `\n\n[Read truncated at ${MAX_READ_BYTES} bytes from ${buffer.byteLength} bytes. Use offset/limit or Grep for targeted reads.]`
        }
        return textResult(text, { path: filePath, truncated, bytes: buffer.byteLength })
      })
    }
  }

  const writeTool: AgentTool<any> = {
    name: 'Write',
    label: 'Write',
    description: 'Creates or overwrites a file',
    parameters: Type.Object({
      file_path: Type.Optional(Type.String({ description: 'Path to write' })),
      path: Type.Optional(Type.String({ description: 'Path to write' })),
      content: Type.String({ description: 'File contents' })
    }),
    async execute(_toolCallId, params) {
      return safeExecute('Write', async () => {
        const input = params as ToolParams
        const filePath = resolveAllowedPath(input.file_path ?? input.path, cwd, roots)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, input.content, 'utf8')
        return textResult(`Wrote ${toDisplayPath(filePath, cwd)}`, { path: filePath })
      })
    },
    executionMode: 'sequential'
  }

  const editTool: AgentTool<any> = {
    name: 'Edit',
    label: 'Edit',
    description: 'Replaces text in an existing file',
    parameters: Type.Object({
      file_path: Type.Optional(Type.String({ description: 'Path to edit' })),
      path: Type.Optional(Type.String({ description: 'Path to edit' })),
      old_string: Type.String({ description: 'Text to replace' }),
      new_string: Type.String({ description: 'Replacement text' }),
      replace_all: Type.Optional(Type.Boolean({ description: 'Replace all occurrences' }))
    }),
    async execute(_toolCallId, params) {
      return safeExecute('Edit', async () => {
        const input = params as ToolParams
        const filePath = resolveAllowedPath(input.file_path ?? input.path, cwd, roots)
        const current = await fs.readFile(filePath, 'utf8')
        if (!current.includes(input.old_string)) {
          return errorTextResult(
            `Edit failed: text not found in ${toDisplayPath(filePath, cwd)}. Use Read/Grep first.`,
            {
              path: filePath
            }
          )
        }
        const occurrenceCount = current.split(input.old_string).length - 1
        if (!input.replace_all && occurrenceCount > 1) {
          return errorTextResult(
            `Edit failed: old_string appears ${occurrenceCount} times in ${toDisplayPath(filePath, cwd)}. Provide more context or set replace_all.`,
            { path: filePath, occurrences: occurrenceCount }
          )
        }
        const next = input.replace_all
          ? current.split(input.old_string).join(input.new_string)
          : current.replace(input.old_string, input.new_string)
        await fs.writeFile(filePath, next, 'utf8')
        return textResult(`Edited ${toDisplayPath(filePath, cwd)}`, { path: filePath })
      })
    },
    executionMode: 'sequential'
  }

  const bashTool: AgentTool<any> = {
    name: 'Bash',
    label: 'Bash',
    description: 'Executes a shell command in the workspace',
    parameters: Type.Object({
      command: Type.String({ description: 'Command to execute' }),
      description: Type.Optional(Type.String({ description: 'Short description of the command' }))
    }),
    async execute(_toolCallId, params, signal) {
      const input = params as ToolParams
      if (
        input.description &&
        NPM_INSTALL_COMMAND_PATTERN.test(input.command) &&
        LOCAL_INSTALL_WORKAROUND_PATTERN.test(input.description)
      ) {
        return errorTextResult(LOCAL_INSTALL_WORKAROUND_MESSAGE, {
          command: input.command,
          exitCode: 1,
          policy: 'local_install_workaround'
        })
      }

      let result = await runBash(input.command, cwd, roots, signal).catch((error) => ({
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
        code: error.code ?? 1
      }))
      const isAgentScopedGlobalInstall = GLOBAL_PACKAGE_INSTALL_COMMAND_PATTERN.test(input.command)
      const details = {
        command: input.command,
        exitCode: 'code' in result ? result.code : 0,
        ...(isAgentScopedGlobalInstall ? { agentToolPrefix: agentToolPrefixForCwd(cwd) } : {})
      }

      let output = [result.stdout, result.stderr].filter(Boolean).join('\n')

      if (
        'code' in result &&
        result.code !== 0 &&
        isDocumentationFetchSslFailure(input.command, input.description, output)
      ) {
        return textResult(DOCUMENTATION_FETCH_UNAVAILABLE_MESSAGE, {
          ...details,
          recoverable: true,
          reason: 'documentation_fetch_unavailable'
        })
      }

      if ('code' in result && result.code !== 0 && shouldRetryNpmMirrorWithOfficialRegistry(input.command, output)) {
        const fallbackEnv = {
          NPM_CONFIG_REGISTRY: NPMJS_REGISTRY,
          npm_config_registry: NPMJS_REGISTRY
        }
        const retried = await runBash(input.command, cwd, roots, signal, fallbackEnv).catch((error) => ({
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? error.message,
          code: error.code ?? 1
        }))
        const retriedOutput = [retried.stdout, retried.stderr].filter(Boolean).join('\n')
        if (!('code' in retried) || retried.code === 0) {
          const truncated = truncateOutput(
            `[npmmirror SSL/certificate failure detected. Retried with ${NPMJS_REGISTRY}.]\n${retriedOutput || '(no output)'}`,
            MAX_SUCCESS_OUTPUT_CHARS
          )
          return textResult(truncated.text, {
            ...details,
            exitCode: 0,
            retriedRegistry: NPMJS_REGISTRY,
            truncated: truncated.truncated
          })
        }

        result = retried
        output = `[Initial npmmirror SSL/certificate failure. Retried with ${NPMJS_REGISTRY}, but the command still failed.]\n${retriedOutput}`
        details.exitCode = 'code' in retried ? retried.code : 1
      }

      if ('code' in result && result.code !== 0 && isInstallBinarySslFailure(input.command, output)) {
        const truncated = truncateOutput(
          '[Dependency install stopped: install script/binary download hit an SSL/certificate failure. Do not manually download binaries or retry with alternate install locations; report this as an environment/dependency blocker briefly.]',
          MAX_ERROR_OUTPUT_CHARS
        )
        return errorTextResult(truncated.text, {
          ...details,
          blockedRetry: true,
          reason: 'install_binary_ssl_failure',
          truncated: truncated.truncated
        })
      }

      if ('code' in result && result.code !== 0) {
        const truncated = truncateOutput(output || '(no output)', MAX_ERROR_OUTPUT_CHARS)
        if (isRecoverableBashFailure(input.command, input.description, truncated.text)) {
          return textResult(
            `${truncated.text}\n\n[Diagnostic command exited with code ${result.code}. Treat this as a miss, not a task failure. Use Glob/Grep/Read or try the next likely path.]`,
            { ...details, recoverable: true, truncated: truncated.truncated }
          )
        }
        return errorTextResult(truncated.text, { ...details, truncated: truncated.truncated })
      }
      const truncated = truncateOutput(output || '(no output)', MAX_SUCCESS_OUTPUT_CHARS)
      return textResult(truncated.text, { ...details, truncated: truncated.truncated })
    },
    executionMode: 'sequential'
  }

  const globTool: AgentTool<any> = {
    name: 'Glob',
    label: 'Glob',
    description: 'Finds files by glob pattern',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern, for example **/*.ts' }),
      path: Type.Optional(Type.String({ description: 'Directory to search from' }))
    }),
    async execute(_toolCallId, params) {
      return safeExecute('Glob', async () => {
        const input = params as ToolParams
        const searchRoot = resolveAllowedPath(input.path, cwd, roots)
        const matches = (
          await fg(input.pattern, {
            cwd: searchRoot,
            dot: true,
            onlyFiles: true,
            followSymbolicLinks: false,
            ignore: ['**/.git/**', '**/node_modules/**'],
            unique: true
          })
        ).slice(0, MAX_SEARCH_RESULTS)
        return textResult(matches.join('\n') || 'No files found', { count: matches.length })
      })
    }
  }

  const grepTool: AgentTool<any> = {
    name: 'Grep',
    label: 'Grep',
    description: 'Searches file contents with a regular expression',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression to search for' }),
      path: Type.Optional(Type.String({ description: 'Directory to search from' })),
      glob: Type.Optional(Type.String({ description: 'Optional file glob filter' }))
    }),
    async execute(_toolCallId, params) {
      return safeExecute('Grep', async () => {
        const input = params as ToolParams
        const searchRoot = resolveAllowedPath(input.path, cwd, roots)
        let regex: RegExp
        try {
          regex = new RegExp(input.pattern)
        } catch (error) {
          return errorTextResult(`Grep failed: invalid regular expression: ${compactError(error)}`)
        }
        const files = input.glob
          ? (
              await fg(input.glob, {
                cwd: searchRoot,
                dot: true,
                onlyFiles: true,
                followSymbolicLinks: false,
                ignore: ['**/.git/**', '**/node_modules/**'],
                unique: true
              })
            ).map((file) => path.join(searchRoot, file))
          : await walkFiles(searchRoot, cwd, roots)
        const matches: string[] = []

        for (const file of files) {
          const displayPath = toDisplayPath(file, searchRoot).split(path.sep).join('/')
          const stat = await fs.stat(file).catch(() => undefined)
          if (!stat?.isFile() || stat.size > MAX_SCAN_FILE_BYTES) continue
          const buffer = await fs.readFile(file).catch(() => undefined)
          if (!buffer || buffer.includes(0)) continue
          const text = buffer.toString('utf8')
          const lines = text.split(/\r?\n/)
          lines.forEach((line, index) => {
            if (matches.length < MAX_SEARCH_RESULTS && regex.test(line)) {
              matches.push(`${displayPath}:${index + 1}:${line}`)
            }
          })
          if (matches.length >= MAX_SEARCH_RESULTS) break
        }

        return textResult(matches.join('\n') || 'No matches found', { count: matches.length })
      })
    }
  }

  return [readTool, writeTool, editTool, bashTool, globTool, grepTool]
}

export async function createPiMcpTools(mcpIds: string[] | undefined): Promise<AgentTool<any>[]> {
  if (!mcpIds?.length) return []

  const allowedServerIds = new Set(mcpIds)
  const tools = await mcpService.listAllActiveServerTools()
  return tools.filter((tool) => allowedServerIds.has(tool.serverId)).map((tool) => createPiMcpTool(tool))
}

function createPiMcpTool(tool: MCPTool): AgentTool<any> {
  const toolId = `${tool.serverId}__${tool.name}`
  return {
    name: tool.id,
    label: `${tool.serverName}: ${tool.name}`,
    description: tool.description || `Call MCP tool ${tool.name} from ${tool.serverName}`,
    parameters: tool.inputSchema as any,
    async execute(toolCallId, params) {
      const result = await mcpService.callToolById(toolId, params, toolCallId)
      return mcpResultToToolResult(result, {
        serverId: tool.serverId,
        serverName: tool.serverName,
        toolName: tool.name,
        toolId
      })
    }
  }
}
