import { storageV2Database } from './StorageV2Database'

const COUNTED_TABLES = [
  'settings',
  'providers',
  'models',
  'assistants',
  'agents',
  'agent_sessions',
  'conversations',
  'messages',
  'message_blocks',
  'blobs',
  'files',
  'skills',
  'agent_skills',
  'scheduled_tasks',
  'task_run_logs',
  'channels',
  'knowledge_bases',
  'knowledge_items',
  'kv_records',
  'sync_changes',
  'sync_tombstones',
  'sync_conflicts',
  'migration_runs'
] as const

export type StorageV2Stats = {
  generatedAt: string
  counts: Record<(typeof COUNTED_TABLES)[number], number>
}

export class StorageV2StatisticsService {
  async getStats(): Promise<StorageV2Stats> {
    const client = await storageV2Database.getClient()
    const counts = {} as StorageV2Stats['counts']

    for (const table of COUNTED_TABLES) {
      const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`)
      counts[table] = Number(result.rows[0]?.count ?? 0)
    }

    return {
      generatedAt: new Date().toISOString(),
      counts
    }
  }
}

export const storageV2StatisticsService = new StorageV2StatisticsService()
