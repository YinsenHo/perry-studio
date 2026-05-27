import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { loggerService } from '@logger'
import { getResourcePath } from '@main/utils'
import { findExecutableInEnv, getBinaryName, getGitBashPathInfo, runInstallScript } from '@main/utils/process'
import {
  disableManagedRuntime,
  enableManagedRuntime,
  extractRtkBinaries,
  getUserBinDir,
  isManagedRuntimeDisabled
} from '@main/utils/rtk'
import type { EnvironmentDependenciesStatus, EnvironmentDependencyStatus } from '@shared/config/types'

import { isWin } from '../constant'

const execFileAsync = promisify(execFile)
const logger = loggerService.withContext('EnvironmentDependencyService')
const VERSION_TIMEOUT_MS = 3000
const MANAGED_CLI_TOOL_NAMES = ['perry-settings', 'perry-knowledge', 'perry-painting', 'perry-notes']
const MANAGED_BINARY_NAMES = ['rtk', 'uv', 'uvx', 'bun', 'bunx', 'node', 'npm', 'npx', ...MANAGED_CLI_TOOL_NAMES]

class EnvironmentDependencyService {
  async ensureIntegratedRuntime(): Promise<void> {
    if (isManagedRuntimeDisabled()) return

    await extractRtkBinaries()
    await this.installNodeShim()
    await this.installCliTools()
  }

  async installManagedRuntime(): Promise<EnvironmentDependenciesStatus> {
    enableManagedRuntime()
    await extractRtkBinaries()
    await this.installNodeShim()
    await this.installCliTools()
    return this.getStatus()
  }

  async uninstallManagedRuntime(): Promise<EnvironmentDependenciesStatus> {
    disableManagedRuntime()

    await Promise.all(
      MANAGED_BINARY_NAMES.map(async (name) => {
        const paths = await this.getManagedBinaryPaths(name)
        await Promise.all(paths.map((binaryPath) => fs.promises.rm(binaryPath, { force: true, recursive: true })))
      })
    )
    await fs.promises.rm(path.join(getUserBinDir(), 'perry-cli'), { force: true, recursive: true })

    return this.getStatus()
  }

  async installUv(): Promise<EnvironmentDependenciesStatus> {
    enableManagedRuntime()
    await this.ensureIntegratedRuntime()
    await runInstallScript('install-uv.js')
    return this.getStatus()
  }

  async installBun(): Promise<EnvironmentDependenciesStatus> {
    enableManagedRuntime()
    await this.ensureIntegratedRuntime()
    await runInstallScript('install-bun.js')
    return this.getStatus()
  }

  async getStatus(): Promise<EnvironmentDependenciesStatus> {
    const dependencies = await Promise.all([
      this.resolveDependency('bash', 'Bash', ['bash'], true),
      this.resolveDependency('git', 'Git', ['git'], true),
      this.resolveRuntimeNode(),
      this.resolveDependency('npm', 'npm', ['npm'], false),
      this.resolveDependency('python', 'Python', ['python3', 'python'], false),
      this.resolveDependency('uv', 'UV', ['uv'], false),
      this.resolveDependency('bun', 'Bun', ['bun'], false),
      this.resolveDependency('rtk', 'RTK', ['rtk'], false)
    ])

    return {
      managedDir: getUserBinDir(),
      managedRuntimeEnabled: !isManagedRuntimeDisabled(),
      dependencies
    }
  }

  private async resolveRuntimeNode(): Promise<EnvironmentDependencyStatus> {
    const managedPath = await this.getManagedBinaryPath('node')
    if (fs.existsSync(managedPath)) {
      return {
        id: 'node',
        name: 'Node.js',
        command: 'node',
        required: false,
        installed: true,
        source: 'managed',
        path: managedPath,
        version: await this.getVersion(managedPath)
      }
    }

    const systemPath = await findExecutableInEnv('node')
    if (systemPath) {
      return {
        id: 'node',
        name: 'Node.js',
        command: 'node',
        required: false,
        installed: true,
        source: 'system',
        path: systemPath,
        version: await this.getVersion(systemPath)
      }
    }

    return {
      id: 'node',
      name: 'Node.js',
      command: 'node',
      required: false,
      installed: true,
      source: 'runtime',
      path: process.execPath,
      version: process.version
    }
  }

  private async resolveDependency(
    id: string,
    name: string,
    commands: string[],
    required: boolean
  ): Promise<EnvironmentDependencyStatus> {
    if (id === 'bash' && isWin) {
      const gitBash = getGitBashPathInfo().path
      if (gitBash) {
        return {
          id,
          name,
          command: 'bash',
          required,
          installed: true,
          source: 'system',
          path: gitBash,
          version: await this.getVersion(gitBash)
        }
      }
    }

    for (const command of commands) {
      const managedPath = await this.getManagedBinaryPath(command)
      if (fs.existsSync(managedPath)) {
        return {
          id,
          name,
          command,
          required,
          installed: true,
          source: 'managed',
          path: managedPath,
          version: await this.getVersion(managedPath)
        }
      }
    }

    for (const command of commands) {
      const systemPath = await findExecutableInEnv(command)
      if (systemPath) {
        return {
          id,
          name,
          command,
          required,
          installed: true,
          source: 'system',
          path: systemPath,
          version: await this.getVersion(systemPath)
        }
      }
    }

    return {
      id,
      name,
      command: commands[0],
      required,
      installed: false,
      source: 'missing',
      path: null,
      version: null
    }
  }

  private async getManagedBinaryPath(name: string): Promise<string> {
    return (await this.getManagedBinaryPaths(name))[0]
  }

  private async getManagedBinaryPaths(name: string): Promise<string[]> {
    if (MANAGED_CLI_TOOL_NAMES.includes(name)) {
      return [
        path.join(getUserBinDir(), name),
        path.join(getUserBinDir(), `${name}.cmd`),
        path.join(getUserBinDir(), `${name}.js`)
      ]
    }

    const binaryPath = path.join(getUserBinDir(), await getBinaryName(name))
    if (isWin && name === 'node') {
      return [path.join(getUserBinDir(), 'node.cmd'), binaryPath]
    }
    return [binaryPath]
  }

  private async getVersion(binaryPath: string): Promise<string | null> {
    try {
      const env = binaryPath === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
      const command = isWin && binaryPath.toLowerCase().endsWith('.cmd') ? 'cmd.exe' : binaryPath
      const args = command === 'cmd.exe' ? ['/d', '/s', '/c', `"${binaryPath}" --version`] : ['--version']
      const { stdout, stderr } = await execFileAsync(command, args, {
        env,
        encoding: 'utf8',
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true
      })
      return (stdout || stderr).trim().split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  private async installNodeShim(): Promise<void> {
    const binDir = getUserBinDir()
    fs.mkdirSync(binDir, { recursive: true })

    const shimPath = await this.getManagedBinaryPath('node')
    if (isWin) {
      const script = [
        '@echo off',
        'set ELECTRON_RUN_AS_NODE=1',
        'set ELECTRON_NO_ATTACH_CONSOLE=1',
        `"${process.execPath}" %*`,
        ''
      ].join('\r\n')
      fs.writeFileSync(shimPath.replace(/\.exe$/i, '.cmd'), script, 'utf8')
      return
    }

    const escapedExecPath = process.execPath.replace(/(["\\$`])/g, '\\$1')
    const script = [
      '#!/bin/sh',
      'export ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_NO_ATTACH_CONSOLE=1',
      `exec "${escapedExecPath}" "$@"`,
      ''
    ].join('\n')

    fs.writeFileSync(shimPath, script, 'utf8')
    fs.chmodSync(shimPath, 0o755)
    logger.debug('Installed Node.js shim', { shimPath })
  }

  private async installCliTools(): Promise<void> {
    const binDir = getUserBinDir()
    fs.mkdirSync(binDir, { recursive: true })

    const sourceDir = path.join(getResourcePath(), 'cli')
    const runtimeDir = path.join(binDir, 'perry-cli')
    if (!fs.existsSync(sourceDir)) return
    await fs.promises.rm(runtimeDir, { force: true, recursive: true })
    await fs.promises.cp(sourceDir, runtimeDir, { recursive: true })

    for (const name of MANAGED_CLI_TOOL_NAMES) {
      const scriptPath = path.join(runtimeDir, `${name}.js`)
      if (!fs.existsSync(scriptPath)) continue

      if (isWin) {
        const nodePath = (await this.getManagedBinaryPath('node')).replace(/\.exe$/i, '.cmd')
        fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"${nodePath}" "${scriptPath}" %*\r\n`, 'utf8')
      } else {
        const nodePath = await this.getManagedBinaryPath('node')
        const wrapper = ['#!/bin/sh', `exec "${nodePath}" "${scriptPath}" "$@"`, ''].join('\n')
        const wrapperPath = path.join(binDir, name)
        fs.writeFileSync(wrapperPath, wrapper, 'utf8')
        fs.chmodSync(wrapperPath, 0o755)
      }
    }
    logger.debug('Installed Cherry Studio Pi CLI tools', { tools: MANAGED_CLI_TOOL_NAMES })
  }
}

export const environmentDependencyService = new EnvironmentDependencyService()
