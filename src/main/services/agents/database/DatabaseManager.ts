/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { type Client, createClient } from '@libsql/client'
import { loggerService } from '@logger'
import { isDev } from '@main/constant'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle } from 'drizzle-orm/libsql'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

import { getDataPath } from '../../../utils'
import { DataMigrationService } from './DataMigrationService'
import { MigrationService } from './MigrationService'
import * as schema from './schema'

const SQLITE_AUXILIARY_SUFFIXES = ['-wal', '-shm'] as const

function getDbPath() {
  return path.join(getDataPath(), 'agents.db')
}

function getOldDbPath() {
  return path.join(app.getPath('userData'), 'agents.db')
}

const logger = loggerService.withContext('DatabaseManager')

/**
 * Database initialization state
 */
enum InitState {
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  FAILED = 'failed'
}

/**
 * DatabaseManager - Singleton class for managing libsql database connections
 *
 * Responsibilities:
 * - Single source of truth for database connection
 * - Thread-safe initialization with state management
 * - Automatic migration handling
 * - Safe connection cleanup
 * - Error recovery and retry logic
 * - Windows platform compatibility fixes
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null

  private client: Client | null = null
  private db: LibSQLDatabase<typeof schema> | null = null
  private state: InitState = InitState.INITIALIZING

  /**
   * Get the singleton instance (database initialization starts automatically)
   */
  public static async getInstance(): Promise<DatabaseManager> {
    if (DatabaseManager.instance) {
      return DatabaseManager.instance
    }

    const instance = new DatabaseManager()
    await instance.initialize()
    DatabaseManager.instance = instance

    return instance
  }

  /**
   * Migrate agents.db from old userData path to the stable Storage v2 data root.
   * If the stable database already exists, archive the legacy copy instead of
   * overwriting active agent data.
   */
  private static migrateFromOldPath(): void {
    if (isDev) {
      return
    }

    const oldPath = getOldDbPath()
    const dbPath = getDbPath()
    if (!fs.existsSync(oldPath)) {
      return
    }

    const dbDir = path.dirname(dbPath)
    DatabaseManager.ensureDir(dbDir)

    if (fs.existsSync(dbPath)) {
      const archiveDir = path.join(dbDir, 'legacy', `pre-storage-v2-agents-${Date.now()}`)
      DatabaseManager.moveDatabaseFiles(oldPath, path.join(archiveDir, 'agents.db'))
      logger.warn('Archived old agents database because the Storage v2 agents database already exists', {
        oldPath,
        archiveDir,
        dbPath
      })
      return
    }

    logger.info(`Migrating agents.db from ${oldPath} to ${dbPath}`)
    DatabaseManager.moveDatabaseFiles(oldPath, dbPath)
  }

  private static moveDatabaseFiles(sourceMainDbPath: string, targetMainDbPath: string): void {
    DatabaseManager.moveFile(sourceMainDbPath, targetMainDbPath)

    // SQLite WAL mode auxiliary files: -wal (write-ahead log with uncommitted data) and -shm (shared memory index)
    for (const suffix of SQLITE_AUXILIARY_SUFFIXES) {
      const sourcePath = `${sourceMainDbPath}${suffix}`
      if (fs.existsSync(sourcePath)) {
        DatabaseManager.moveFile(sourcePath, `${targetMainDbPath}${suffix}`)
      }
    }
  }

  private static moveFile(sourcePath: string, targetPath: string): void {
    DatabaseManager.ensureDir(path.dirname(targetPath))

    try {
      fs.renameSync(sourcePath, targetPath)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV') {
        fs.copyFileSync(sourcePath, targetPath)
        fs.unlinkSync(sourcePath)
        return
      }

      throw error
    }
  }

  private static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  /**
   * Perform the actual initialization
   */
  public async initialize(): Promise<void> {
    if (this.state === InitState.INITIALIZED) {
      return
    }

    try {
      DatabaseManager.migrateFromOldPath()
      const dbPath = getDbPath()

      logger.info(`Initializing database at: ${dbPath}`)

      // Ensure database directory exists
      const dbDir = path.dirname(dbPath)
      if (!fs.existsSync(dbDir)) {
        logger.info(`Creating database directory: ${dbDir}`)
        fs.mkdirSync(dbDir, { recursive: true })
      }

      // Check if database file is corrupted (Windows specific check)
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath)
        if (stats.size === 0) {
          logger.warn('Database file is empty, removing corrupted file')
          fs.unlinkSync(dbPath)
        }
      }

      // Create client with platform-specific options
      this.client = createClient({
        url: `file:${dbPath}`,
        // intMode: 'number' helps avoid some Windows compatibility issues
        intMode: 'number'
      })

      // Create drizzle instance
      this.db = drizzle(this.client, { schema })

      // Run schema migrations
      const migrationService = new MigrationService(this.db, this.client)
      await migrationService.runMigrations()

      // Run data migrations (must run after schema migrations)
      const dataMigrationService = new DataMigrationService(this.db, this.client)
      await dataMigrationService.runDataMigrations()

      this.state = InitState.INITIALIZED
      logger.info('Database initialized successfully')
    } catch (error) {
      const err = error as Error
      logger.error('Database initialization failed:', {
        error: err.message,
        stack: err.stack
      })

      // Clean up failed initialization
      this.cleanupFailedInit()

      // Set failed state
      this.state = InitState.FAILED
      throw new Error(`Database initialization failed: ${err.message || 'Unknown error'}`)
    }
  }

  /**
   * Clean up after failed initialization
   */
  private cleanupFailedInit(): void {
    if (this.client) {
      try {
        // On Windows, closing a partially initialized client can crash
        // Wrap in try-catch and ignore errors during cleanup
        this.client.close()
      } catch (error) {
        logger.warn('Failed to close client during cleanup:', error as Error)
      }
    }
    this.client = null
    this.db = null
  }

  /**
   * Get the database instance
   * Automatically waits for initialization to complete
   * @throws Error if database initialization failed
   */
  public getDatabase(): LibSQLDatabase<typeof schema> {
    return this.db!
  }

  /**
   * Get the raw client (for advanced operations)
   * Automatically waits for initialization to complete
   * @throws Error if database initialization failed
   */
  public async getClient(): Promise<Client> {
    return this.client!
  }

  /**
   * Check if database is initialized
   */
  public isInitialized(): boolean {
    return this.state === InitState.INITIALIZED
  }

  /**
   * Close the database connection and reset the singleton.
   * Must be called before deleting agents.db (e.g. during backup restore).
   * After calling this, getInstance() will re-initialize a fresh connection.
   */
  public static async close(): Promise<void> {
    const instance = DatabaseManager.instance
    if (!instance) {
      return
    }

    // Detach singleton first so concurrent getInstance() creates a fresh connection
    // instead of returning a stale instance with null client.
    DatabaseManager.instance = null

    if (instance.client) {
      try {
        instance.client.close()
        logger.info('Database connection closed')
      } catch (error) {
        logger.warn('Failed to close database connection:', error as Error)
      }
    }
  }
}
