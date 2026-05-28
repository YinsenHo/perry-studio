import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { config as apiServerConfig } from '@main/apiServer/config'
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
const POLICY_FAILURE_PATTERN = /parent directory traversal/i
const NPM_INSTALL_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:env\s+(?:\S+\s+)*?)?(?:(?:\.{0,2}\/|\S*\/)?(?:npm|pnpm|bun|bunx|npx|corepack))\b/i
const GLOBAL_PACKAGE_INSTALL_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:(?:npm|pnpm)\s+(?:install|i|add)\s+(?:[^\n;&|]*\s)?(?:-g|--global)\b|yarn\s+global\s+add\b)/i
const NPM_MIRROR_SSL_PATTERN =
  /(?:npmmirror\.com|registry\.npmmirror\.com|cdn\.npmmirror\.com)[\s\S]{0,400}(?:SSL|certificate|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|unable to verify|unable to get local issuer|certificate verify failed|SSL routines)|(?:SSL|certificate|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|unable to verify|unable to get local issuer|certificate verify failed|SSL routines)[\s\S]{0,400}(?:npmmirror\.com|registry\.npmmirror\.com|cdn\.npmmirror\.com)/i
const NPMJS_REGISTRY = 'https://registry.npmjs.org'
const SHELL_FAILURE_MARKER_PATTERN =
  /(?:^|\n)(?:CURL_FAILED|NPM_FAILED|PNPM_FAILED|YARN_FAILED|BREW_FAILED|BREW_NOT_AVAILABLE|INSTALL_FAILED)\b/i
const SHELL_ERROR_OUTPUT_PATTERN =
  /(?:^|\n)(?:[^\n]+:\s+)?(?:command not found|Operation not permitted|Permission denied|No such file or directory|Error:|fatal:|npm ERR!|ERR_PNPM_|curl: \(\d+\))/i

const isRecoverableBashFailure = (command: string, description: string | undefined, output: string) => {
  if (POLICY_FAILURE_PATTERN.test(output)) return false
  if (description && RECOVERABLE_BASH_DESCRIPTION_PATTERN.test(description)) return true
  return READ_ONLY_BASH_COMMAND_PATTERN.test(command)
}

const shouldRetryNpmMirrorWithOfficialRegistry = (command: string, output: string) => {
  return NPM_INSTALL_COMMAND_PATTERN.test(command) && NPM_MIRROR_SSL_PATTERN.test(output)
}

const outputLooksLikeForcedShellFailure = (output: string) => {
  return SHELL_FAILURE_MARKER_PATTERN.test(output) || SHELL_ERROR_OUTPUT_PATTERN.test(output)
}

const agentToolPrefixForCwd = (cwd: string) => {
  const key = Buffer.from(path.resolve(cwd)).toString('base64url').slice(0, 48)
  return path.join(process.env.TMPDIR || '/tmp', 'cherry-studio-agent-tools', key)
}

const buildBashEnv = async (cwd: string, extraEnv: NodeJS.ProcessEnv = {}) => {
  const shellEnv = await getShellEnv().catch(() => process.env)
  const apiConfig = await apiServerConfig.get().catch(() => null)
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
    PERRY_STUDIO_API_BASE:
      extraEnv.PERRY_STUDIO_API_BASE ??
      (apiConfig ? `http://${apiConfig.host}:${apiConfig.port}` : process.env.PERRY_STUDIO_API_BASE),
    PERRY_STUDIO_API_KEY: extraEnv.PERRY_STUDIO_API_KEY ?? apiConfig?.apiKey ?? process.env.PERRY_STUDIO_API_KEY,
    CHERRY_STUDIO_API_BASE:
      extraEnv.CHERRY_STUDIO_API_BASE ??
      (apiConfig ? `http://${apiConfig.host}:${apiConfig.port}` : process.env.CHERRY_STUDIO_API_BASE),
    CHERRY_STUDIO_API_KEY: extraEnv.CHERRY_STUDIO_API_KEY ?? apiConfig?.apiKey ?? process.env.CHERRY_STUDIO_API_KEY,
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

const browserResultToToolResult = (
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string; mimeType_?: string }>
    isError: boolean
  },
  details: ToolResultDetails
): AgentToolResult<ToolResultDetails> => {
  const content = result.content.map((item) => {
    if (item.type === 'image' && item.data) {
      return {
        type: 'image' as const,
        data: item.data,
        mimeType: item.mimeType ?? item.mimeType_ ?? 'image/png'
      }
    }
    return {
      type: 'text' as const,
      text: truncateOutput(item.text ?? JSON.stringify(item), MAX_SUCCESS_OUTPUT_CHARS).text
    }
  })

  return {
    content,
    details: {
      ...details,
      isError: result.isError
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

const resolveAllowedPath = (rawPath: string | undefined, cwd: string) => {
  return path.resolve(cwd, rawPath || '.')
}

const assertCommandDoesNotReferenceOutsidePaths = (command: string) => {
  const parentTraversalPattern = /(^|[\s"'`=([{:;,])\.\.(?:\/|$)/
  if (parentTraversalPattern.test(command)) {
    throw new Error('Bash command references parent directory traversal outside the workspace boundary')
  }
}

const sandboxProfileForRoots = () => '(version 1)\n(allow default)'

const runBash = async (command: string, cwd: string, signal?: AbortSignal, extraEnv: NodeJS.ProcessEnv = {}) => {
  assertCommandDoesNotReferenceOutsidePaths(command)

  const env = await buildBashEnv(cwd, extraEnv)

  if (process.platform === 'darwin') {
    return await execFileAsync('/usr/bin/sandbox-exec', ['-p', sandboxProfileForRoots(), '/bin/zsh', '-lc', command], {
      cwd,
      env,
      signal,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: BASH_MAX_BUFFER
    })
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
  const resolvedRoot = resolveAllowedPath(root, cwd)
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
  let browserController: any

  const getBrowserController = async () => {
    if (!browserController) {
      const modulePath = '@main/mcpServers/browser/controller'
      const { CdpBrowserController } = await import(/* @vite-ignore */ modulePath)
      browserController = new CdpBrowserController()
    }
    return browserController
  }

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
        const filePath = resolveAllowedPath(input.file_path ?? input.path, cwd)
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
        const filePath = resolveAllowedPath(input.file_path ?? input.path, cwd)
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
        const filePath = resolveAllowedPath(input.file_path ?? input.path, cwd)
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
      let result = await runBash(input.command, cwd, signal).catch((error) => ({
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
        code: error.code ?? 1
      }))
      let output = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (!('code' in result) && outputLooksLikeForcedShellFailure(output)) {
        result = { ...result, code: 1 }
      }
      const isAgentScopedGlobalInstall = GLOBAL_PACKAGE_INSTALL_COMMAND_PATTERN.test(input.command)
      const details = {
        command: input.command,
        exitCode: 'code' in result ? result.code : 0,
        ...(isAgentScopedGlobalInstall ? { agentToolPrefix: agentToolPrefixForCwd(cwd) } : {})
      }

      output = [result.stdout, result.stderr].filter(Boolean).join('\n')

      if ('code' in result && result.code !== 0 && shouldRetryNpmMirrorWithOfficialRegistry(input.command, output)) {
        const fallbackEnv = {
          NPM_CONFIG_REGISTRY: NPMJS_REGISTRY,
          npm_config_registry: NPMJS_REGISTRY
        }
        const retried = await runBash(input.command, cwd, signal, fallbackEnv).catch((error) => ({
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

  const httpRequestTool: AgentTool<any> = {
    name: 'HTTPRequest',
    label: 'HTTP Request',
    description:
      'Send an HTTP or HTTPS request and return the response. Supports custom method, headers, and body. Use for APIs, downloads, and direct web requests.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL to request' },
        method: { type: 'string', description: 'HTTP method, for example GET, POST, PUT, PATCH, DELETE' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional request headers'
        },
        body: { type: 'string', description: 'Optional request body' },
        max_chars: { type: 'number', description: 'Maximum response characters to return' }
      },
      required: ['url']
    } as any,
    async execute(_toolCallId, params, signal) {
      return safeExecute('HTTPRequest', async () => {
        const input = params as ToolParams
        const { net } = await import('electron')
        const method = String(input.method ?? 'GET').toUpperCase()
        const response = await net.fetch(input.url, {
          method,
          headers: input.headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : input.body,
          signal
        })
        const contentType = response.headers.get('content-type') ?? ''
        const rawText = await response.text()
        const maxChars = typeof input.max_chars === 'number' ? input.max_chars : MAX_SUCCESS_OUTPUT_CHARS
        const truncated = truncateOutput(rawText || '(empty response)', maxChars)
        return textResult(truncated.text, {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          url: response.url,
          contentType,
          truncated: truncated.truncated,
          isError: !response.ok
        })
      })
    }
  }

  const browserOpenTool: AgentTool<any> = {
    name: 'BrowserOpen',
    label: 'Browser Open',
    description:
      'Open a URL in Cherry Studio browser automation and optionally return page content. Use for rendered pages, navigation, login flows, or pages that need JavaScript.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        format: {
          type: 'string',
          enum: ['html', 'txt', 'markdown', 'json'],
          description: 'Optional content format to return after navigation'
        },
        selector: { type: 'string', description: 'Optional CSS selector to extract when format is set' },
        maxChars: { type: 'number', description: 'Maximum characters to return' },
        timeout: { type: 'number', description: 'Navigation timeout in ms' },
        privateMode: { type: 'boolean', description: 'Use incognito/private session' },
        newTab: { type: 'boolean', description: 'Open in a new tab' },
        showWindow: { type: 'boolean', description: 'Show the browser window for visible/manual interaction' }
      },
      required: ['url']
    } as any,
    async execute(_toolCallId, params) {
      return safeExecute('BrowserOpen', async () => {
        const toolPath = '@main/mcpServers/browser/tools/open'
        const [{ handleOpen }, controller] = await Promise.all([
          import(/* @vite-ignore */ toolPath),
          getBrowserController()
        ])
        const result = await handleOpen(controller, params)
        return browserResultToToolResult(result, { tool: 'BrowserOpen' })
      })
    }
  }

  const browserExecuteTool: AgentTool<any> = {
    name: 'BrowserExecute',
    label: 'Browser Execute',
    description:
      'Run JavaScript in an open browser page. Use after BrowserOpen to click, fill forms, inspect the DOM, or extract dynamic content.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to run in the page context' },
        timeout: { type: 'number', description: 'Execution timeout in ms' },
        privateMode: { type: 'boolean', description: 'Target private session' },
        tabId: { type: 'string', description: 'Target tab ID from BrowserOpen' }
      },
      required: ['code']
    } as any,
    async execute(_toolCallId, params) {
      return safeExecute('BrowserExecute', async () => {
        const toolPath = '@main/mcpServers/browser/tools/execute'
        const [{ handleExecute }, controller] = await Promise.all([
          import(/* @vite-ignore */ toolPath),
          getBrowserController()
        ])
        const result = await handleExecute(controller, params)
        return browserResultToToolResult(result, { tool: 'BrowserExecute' })
      })
    }
  }

  const browserResetTool: AgentTool<any> = {
    name: 'BrowserReset',
    label: 'Browser Reset',
    description: 'Close Cherry Studio browser automation windows and clear browser automation state.',
    parameters: { type: 'object', properties: {} } as any,
    async execute(_toolCallId, params) {
      return safeExecute('BrowserReset', async () => {
        const toolPath = '@main/mcpServers/browser/tools/reset'
        const [{ handleReset }, controller] = await Promise.all([
          import(/* @vite-ignore */ toolPath),
          getBrowserController()
        ])
        const result = await handleReset(controller, params)
        return browserResultToToolResult(result, { tool: 'BrowserReset' })
      })
    }
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
        const searchRoot = resolveAllowedPath(input.path, cwd)
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
        const searchRoot = resolveAllowedPath(input.path, cwd)
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

  return [
    readTool,
    writeTool,
    editTool,
    bashTool,
    globTool,
    grepTool,
    httpRequestTool,
    browserOpenTool,
    browserExecuteTool,
    browserResetTool
  ]
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
