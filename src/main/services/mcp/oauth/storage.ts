import { loggerService } from '@logger'
import type {
  OAuthClientInformation,
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import fs from 'fs/promises'
import path from 'path'

import { storageV2SecretVaultService } from '../../storageV2/SecretVaultService'
import { storageV2SettingsRepository } from '../../storageV2/StorageV2Repositories'
import type { IOAuthStorage, OAuthStorageData } from './types'
import { OAuthStorageSchema } from './types'

const logger = loggerService.withContext('MCP:OAuthStorage')
const STORAGE_V2_MCP_OAUTH_SCOPE = 'mcp-oauth'
const STORAGE_V2_MCP_OAUTH_SETTING_PREFIX = 'mcp.oauth.'

type OAuthStorageV2Setting = {
  clearedAt?: string
  legacyFallbackAt?: string
  storageSecretRef?: string
  updatedAt?: string
}

type OAuthStorageV2ReadResult = {
  cleared: boolean
  data: OAuthStorageData | null
}

function getStorageV2SettingKey(serverUrlHash: string) {
  return `${STORAGE_V2_MCP_OAUTH_SETTING_PREFIX}${serverUrlHash}`
}

function getStorageV2SecretRef(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const secretRef = (value as OAuthStorageV2Setting).storageSecretRef
  return typeof secretRef === 'string' && secretRef ? secretRef : null
}

function isStorageV2Cleared(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && (value as OAuthStorageV2Setting).clearedAt
  )
}

export class JsonFileStorage implements IOAuthStorage {
  private readonly filePath: string
  private cache: OAuthStorageData | null = null

  constructor(
    readonly serverUrlHash: string,
    configDir: string
  ) {
    this.filePath = path.join(configDir, `${serverUrlHash}_oauth.json`)
  }

  static async clearByServerUrlHash(serverUrlHash: string, configDir: string): Promise<void> {
    await new JsonFileStorage(serverUrlHash, configDir).clear()
  }

  private async readStorage(): Promise<OAuthStorageData> {
    if (this.cache) {
      return this.cache
    }

    const storageV2Result = await this.readStorageV2().catch((error): OAuthStorageV2ReadResult => {
      logger.warn('Failed to read OAuth storage from Storage v2:', error as Error)
      return {
        cleared: false,
        data: null
      }
    })

    if (storageV2Result.cleared) {
      const initial: OAuthStorageData = { lastUpdated: Date.now() }
      this.cache = initial
      return initial
    }

    if (storageV2Result.data) {
      this.cache = storageV2Result.data
      return storageV2Result.data
    }

    try {
      const validated = await this.readLegacyStorage()
      this.cache = validated
      await this.writeStorageV2(validated).catch((error) => {
        logger.warn('Failed to mirror legacy OAuth storage to Storage v2:', error as Error)
      })
      return validated
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // File doesn't exist, return initial state
        const initial: OAuthStorageData = { lastUpdated: Date.now() }
        await this.writeStorage(initial)
        return initial
      }
      logger.error('Error reading OAuth storage:', error as Error)
      throw new Error(`Failed to read OAuth storage: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async readLegacyStorage(): Promise<OAuthStorageData> {
    const data = await fs.readFile(this.filePath, 'utf-8')
    const parsed = JSON.parse(data)
    return OAuthStorageSchema.parse(parsed)
  }

  private async readStorageV2(): Promise<OAuthStorageV2ReadResult> {
    const setting = await storageV2SettingsRepository.get(getStorageV2SettingKey(this.serverUrlHash))
    if (isStorageV2Cleared(setting)) {
      return {
        cleared: true,
        data: null
      }
    }

    const secretRef = getStorageV2SecretRef(setting)
    if (!secretRef) {
      return {
        cleared: false,
        data: null
      }
    }

    const secret = await storageV2SecretVaultService.getSecret(secretRef)
    if (!secret) {
      return {
        cleared: false,
        data: null
      }
    }

    return {
      cleared: false,
      data: OAuthStorageSchema.parse(JSON.parse(secret))
    }
  }

  private async writeStorageV2(data: OAuthStorageData): Promise<void> {
    const secretRef = await storageV2SecretVaultService.setSecret(
      STORAGE_V2_MCP_OAUTH_SCOPE,
      this.serverUrlHash,
      'storage',
      JSON.stringify(data)
    )
    await storageV2SettingsRepository.set(
      getStorageV2SettingKey(this.serverUrlHash),
      {
        storageSecretRef: secretRef,
        updatedAt: new Date().toISOString()
      } satisfies OAuthStorageV2Setting,
      STORAGE_V2_MCP_OAUTH_SCOPE
    )
  }

  private async markStorageV2LegacyFallback(): Promise<void> {
    const timestamp = new Date().toISOString()
    await storageV2SettingsRepository.set(
      getStorageV2SettingKey(this.serverUrlHash),
      {
        legacyFallbackAt: timestamp,
        updatedAt: timestamp
      } satisfies OAuthStorageV2Setting,
      STORAGE_V2_MCP_OAUTH_SCOPE
    )
  }

  private async clearStorageV2(): Promise<void> {
    const timestamp = new Date().toISOString()
    await storageV2SettingsRepository.set(
      getStorageV2SettingKey(this.serverUrlHash),
      {
        clearedAt: timestamp,
        updatedAt: timestamp
      } satisfies OAuthStorageV2Setting,
      STORAGE_V2_MCP_OAUTH_SCOPE
    )
  }

  private async writeStorage(data: OAuthStorageData): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })

      // Update timestamp
      data.lastUpdated = Date.now()

      // Write file atomically
      const tempPath = `${this.filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2))
      await fs.rename(tempPath, this.filePath)

      await this.writeStorageV2(data).catch(async (error) => {
        logger.warn('Failed to write OAuth storage to Storage v2:', error as Error)
        await this.markStorageV2LegacyFallback().catch((fallbackError) => {
          logger.warn('Failed to clear OAuth Storage v2 cleared marker after legacy write:', fallbackError as Error)
        })
      })

      // Update cache
      this.cache = data
    } catch (error) {
      logger.error('Error writing OAuth storage:', error as Error)
      throw new Error(`Failed to write OAuth storage: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async getClientInformation(): Promise<OAuthClientInformation | undefined> {
    const data = await this.readStorage()
    return data.clientInfo
  }

  async saveClientInformation(info: OAuthClientInformationMixed | undefined): Promise<void> {
    const data = await this.readStorage()
    await this.writeStorage({
      ...data,
      clientInfo: info
    })
  }

  async getTokens(): Promise<OAuthTokens | undefined> {
    const data = await this.readStorage()
    return data.tokens
  }

  async saveTokens(tokens: OAuthTokens | undefined): Promise<void> {
    const data = await this.readStorage()
    await this.writeStorage({
      ...data,
      tokens
    })
  }

  async getCodeVerifier(): Promise<string> {
    const data = await this.readStorage()
    if (!data.codeVerifier) {
      throw new Error('No code verifier saved for session')
    }
    return data.codeVerifier
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const data = await this.readStorage()
    await this.writeStorage({
      ...data,
      codeVerifier
    })
  }

  async clear(): Promise<void> {
    let storageV2Error: unknown = null
    try {
      await this.clearStorageV2()
    } catch (error) {
      storageV2Error = error
      logger.error('Error clearing OAuth storage from Storage v2:', error as Error)
    }

    try {
      await fs.unlink(this.filePath)
      this.cache = null
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
        logger.error('Error clearing OAuth storage:', error as Error)
        throw new Error(`Failed to clear OAuth storage: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.cache = null
    if (storageV2Error) {
      throw new Error(
        `Failed to clear OAuth storage from Storage v2: ${
          storageV2Error instanceof Error ? storageV2Error.message : String(storageV2Error)
        }`
      )
    }
  }
}
