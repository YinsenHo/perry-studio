import fs from 'node:fs/promises'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  default: {},
  app: { on: vi.fn(), getPath: vi.fn(() => '/tmp') },
  BrowserWindow: vi.fn(),
  BrowserView: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  net: { fetch: vi.fn() },
  session: { defaultSession: {} }
}))

vi.mock('@main/services/WindowService', () => ({
  windowService: {}
}))

vi.mock('@main/services/MCPService', () => ({
  default: {
    listAllActiveServerTools: vi.fn(),
    callToolById: vi.fn()
  }
}))

import mcpService from '@main/services/MCPService'

import { createPiMcpTools, createPiTools } from '../tools'

const getTool = (name: string, cwd: string, roots: string[]) => {
  const tool = createPiTools(cwd, roots).find((item) => item.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return tool
}

const resultText = (result: any) => result.content?.[0]?.text ?? ''

describe('Pi tools', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = `/tmp/cherry-pi-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await fs.mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous single Edit replacements', async () => {
    const filePath = path.join(tmpDir, 'sample.txt')
    await fs.writeFile(filePath, 'same\nsame\n', 'utf8')

    const edit = getTool('Edit', tmpDir, [tmpDir])
    const result = await edit.execute('edit-1', {
      file_path: filePath,
      old_string: 'same',
      new_string: 'changed'
    })

    expect(result.details).toMatchObject({ isError: true, occurrences: 2 })
    expect(await fs.readFile(filePath, 'utf8')).toBe('same\nsame\n')
  })

  it('matches root files with globstar patterns', async () => {
    await fs.writeFile(path.join(tmpDir, 'root.ts'), 'root', 'utf8')
    await fs.mkdir(path.join(tmpDir, 'nested'))
    await fs.writeFile(path.join(tmpDir, 'nested', 'child.ts'), 'child', 'utf8')

    const glob = getTool('Glob', tmpDir, [tmpDir])
    const result = await glob.execute('glob-1', {
      pattern: '**/*.ts',
      path: tmpDir
    })

    expect(resultText(result).split('\n').sort()).toEqual(['nested/child.ts', 'root.ts'])
  })

  it('skips large files when grepping', async () => {
    await fs.writeFile(path.join(tmpDir, 'small.txt'), 'needle\n', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'large.txt'), `${'x'.repeat(512 * 1024 + 1)}needle`, 'utf8')

    const grep = getTool('Grep', tmpDir, [tmpDir])
    const result = await grep.execute('grep-1', {
      pattern: 'needle',
      path: tmpDir,
      glob: '*.txt'
    })

    expect(resultText(result)).toContain('small.txt:1:needle')
    expect(resultText(result)).not.toContain('large.txt')
  })

  it('truncates large reads with a recovery hint', async () => {
    const filePath = path.join(tmpDir, 'large-read.txt')
    await fs.writeFile(filePath, 'x'.repeat(120 * 1024), 'utf8')

    const read = getTool('Read', tmpDir, [tmpDir])
    const result = await read.execute('read-1', {
      file_path: filePath
    })

    expect(result.details).toMatchObject({ truncated: true })
    expect(resultText(result).length).toBeLessThan(100_000)
    expect(resultText(result)).toContain('Use offset/limit or Grep')
  })

  it('allows reads outside accessible roots', async () => {
    const outsideFile = `/tmp/cherry-pi-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    await fs.writeFile(outsideFile, 'outside ok', 'utf8')

    const read = getTool('Read', tmpDir, [tmpDir])
    const result = await read.execute('read-2', {
      file_path: outsideFile
    })

    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toBe('outside ok')
    await fs.rm(outsideFile, { force: true })
  })

  it('allows Bash commands that reference paths outside accessible roots', async () => {
    const outsideFile = `/tmp/cherry-pi-bash-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    await fs.writeFile(outsideFile, 'outside bash ok', 'utf8')

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-1', {
      command: `cat "${outsideFile}"`
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('outside bash ok')
    await fs.rm(outsideFile, { force: true })
  })

  it('allows Bash commands that modify system SSL trust settings', async () => {
    const bash = getTool('Bash', tmpDir, [tmpDir])
    const fakeSecurity = path.join(tmpDir, 'security')
    await fs.writeFile(fakeSecurity, '#!/bin/sh\necho "security $*"\n', 'utf8')
    await fs.chmod(fakeSecurity, 0o755)

    const result = await bash.execute('bash-system-ssl', {
      command: `PATH="${tmpDir}:$PATH" security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain cert.pem`
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('/Library/Keychains/System.keychain')
  })

  it('allows global SSL verification configuration commands', async () => {
    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-disable-ssl', {
      command: 'git config --global http.sslVerify false'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
  })

  it('allows global npm registration commands', async () => {
    const fakeNpm = path.join(tmpDir, 'npm')
    await fs.writeFile(fakeNpm, '#!/bin/sh\necho "npm $*"\n', 'utf8')
    await fs.chmod(fakeNpm, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-global-register', {
      command: `PATH="${tmpDir}:$PATH" npm link && PATH="${tmpDir}:$PATH" npm publish --dry-run`,
      description: 'Register tool globally after path restriction'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('npm link')
  })

  it('allows npm global CLI installs through the agent-scoped tool prefix', async () => {
    const fakeNpm = path.join(tmpDir, 'npm')
    await fs.writeFile(fakeNpm, '#!/bin/sh\necho "prefix=$NPM_CONFIG_PREFIX"\necho "path=$PATH"\n', 'utf8')
    await fs.chmod(fakeNpm, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-global-cli-install', {
      command: `PATH="${tmpDir}:$PATH" npm install -g feishu-cli`,
      description: 'Install feishu-cli globally via npm'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('cherry-studio-agent-tools')
  })

  it('still allows local package manager installs in the workspace', async () => {
    const fakeNpm = path.join(tmpDir, 'npm')
    await fs.writeFile(fakeNpm, '#!/bin/sh\necho "local install ok"\n', 'utf8')
    await fs.chmod(fakeNpm, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-local-install', {
      command: `PATH="${tmpDir}:$PATH" npm install`,
      description: 'Install project dependencies'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('local install ok')
  })

  it('allows local package installs even when described as a restriction workaround', async () => {
    const fakeNpm = path.join(tmpDir, 'npm')
    await fs.writeFile(fakeNpm, '#!/bin/sh\necho "workaround install ok"\n', 'utf8')
    await fs.chmod(fakeNpm, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-local-install-workaround', {
      command: `PATH="${tmpDir}:$PATH" npm install some-cli`,
      description: '系统限制了全局安装，让我在本地工作区安装'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('workaround install ok')
  })

  it('returns documentation fetch SSL failures as normal command failures', async () => {
    const fakeCurl = path.join(tmpDir, 'curl')
    await fs.writeFile(
      fakeCurl,
      '#!/bin/sh\necho "curl: (35) LibreSSL SSL_connect: certificate verify failed" >&2\nexit 35\n',
      'utf8'
    )
    await fs.chmod(fakeCurl, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-doc-fetch-ssl', {
      command: `PATH="${tmpDir}:$PATH" curl -fsSL https://example.com/feishu-cli/install`,
      description: 'Fetch Feishu CLI installation guide'
    })

    expect(result.details).toMatchObject({ exitCode: 35, isError: true })
    expect(resultText(result)).toContain('SSL_connect')
  })

  it('allows manual Node binary download commands to run', async () => {
    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-manual-binary-download', {
      command: 'node -e "console.log(\\"download command allowed\\")"',
      description: '安装脚本使用 curl 下载二进制时遇到系统 SSL 问题。让我用 Node.js 手动下载二进制文件来解决'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('download command allowed')
  })

  it('returns npm binary download SSL failures without policy-blocking retries', async () => {
    const fakeNpm = path.join(tmpDir, 'npm')
    await fs.writeFile(
      fakeNpm,
      `#!/bin/sh
echo "postinstall download binary from https://example.com/releases/tool.tar.gz failed: unable to verify SSL certificate" >&2
exit 1
`,
      'utf8'
    )
    await fs.chmod(fakeNpm, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-install-binary-ssl', {
      command: `PATH="${tmpDir}:$PATH" npm install native-package`,
      description: 'Install package dependencies'
    })

    expect(result.details).toMatchObject({ exitCode: 1, isError: true })
    expect(result.details).not.toMatchObject({ blockedRetry: true })
    expect(resultText(result)).toContain('unable to verify SSL certificate')
  })

  it('treats diagnostic Bash misses as recoverable output', async () => {
    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-check', {
      command: 'test -f .claude/skills/missing/SKILL.md',
      description: 'Check target skill location'
    })

    expect(result.details).toMatchObject({ exitCode: 1, recoverable: true })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('Treat this as a miss')
  })

  it('runs simple Bash commands inside the workspace sandbox', async () => {
    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-2', {
      command: 'echo hi'
    })

    expect(result.details).toMatchObject({ exitCode: 0 })
    expect(resultText(result).trim()).toBe('hi')
  })

  it('includes HTTP and browser tools by default', () => {
    const tools = createPiTools(tmpDir, [tmpDir]).map((tool) => tool.name)

    expect(tools).toEqual(expect.arrayContaining(['HTTPRequest', 'BrowserOpen', 'BrowserExecute', 'BrowserReset']))
  })

  it('truncates noisy Bash failures', async () => {
    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-3', {
      command: 'node -e "console.error(\'e\'.repeat(20000)); process.exit(1)"'
    })

    expect(result.details).toMatchObject({ exitCode: 1, isError: true, truncated: true })
    expect(resultText(result).length).toBeLessThan(9_000)
    expect(resultText(result)).toContain('truncated')
  })

  it('retries npm mirror SSL failures with the official registry', async () => {
    const fakeNpm = path.join(tmpDir, 'npm')
    await fs.writeFile(
      fakeNpm,
      `#!/bin/sh
if [ "$NPM_CONFIG_REGISTRY" = "https://registry.npmjs.org" ]; then
  echo "installed from official registry"
  exit 0
fi
echo "https://registry.npmmirror.com binary download failed: unable to verify SSL certificate" >&2
exit 1
`,
      'utf8'
    )
    await fs.chmod(fakeNpm, 0o755)

    const bash = getTool('Bash', tmpDir, [tmpDir])
    const result = await bash.execute('bash-npm-retry', {
      command: `PATH="${tmpDir}:$PATH" npm install native-package`,
      description: 'Install package dependencies'
    })

    expect(result.details).toMatchObject({ exitCode: 0, retriedRegistry: 'https://registry.npmjs.org' })
    expect(result.details).not.toMatchObject({ isError: true })
    expect(resultText(result)).toContain('Retried with https://registry.npmjs.org')
    expect(resultText(result)).toContain('installed from official registry')
  })

  it('creates executable Pi tools for selected MCP servers', async () => {
    vi.mocked(mcpService.listAllActiveServerTools).mockResolvedValueOnce([
      {
        id: 'mcp__github__searchRepos',
        serverId: 'github-id',
        serverName: 'github',
        name: 'search_repos',
        description: 'Search repositories',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        type: 'mcp'
      } as any,
      {
        id: 'mcp__other__ignored',
        serverId: 'other-id',
        serverName: 'other',
        name: 'ignored',
        inputSchema: { type: 'object', properties: {}, required: [] },
        type: 'mcp'
      } as any
    ])
    vi.mocked(mcpService.callToolById).mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true}' }]
    } as any)

    const tools = await createPiMcpTools(['github-id'])
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__github__searchRepos'])

    const result = await tools[0].execute('call-1', { query: 'pi' })
    expect(mcpService.callToolById).toHaveBeenCalledWith('github-id__search_repos', { query: 'pi' }, 'call-1')
    expect(resultText(result)).toBe('{"ok":true}')
  })
})
