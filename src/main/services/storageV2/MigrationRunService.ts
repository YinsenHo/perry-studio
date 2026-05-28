import { randomUUID } from 'node:crypto'

import type { Row } from '@libsql/client'

import { storageV2Database } from './StorageV2Database'

export type StorageV2MigrationRunStatus = 'success' | 'failed'

export type StorageV2MigrationRunInput = {
  kind?: string
  status: StorageV2MigrationRunStatus
  dryRun: boolean
  startedAt: string
  finishedAt?: string
  snapshotPath?: string
  report?: unknown
  error?: string
}

export type StorageV2MigrationRun = {
  id: string
  kind: string
  status: StorageV2MigrationRunStatus
  dryRun: boolean
  startedAt: string
  finishedAt: string | null
  snapshotPath: string | null
  report: unknown
  error: string | null
  createdAt: string
}

function text(row: Row, key: string): string | null {
  const value = row[key]
  return value == null ? null : String(value)
}

function parseJson(value: string | null): unknown {
  if (!value) return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeLimit(limit?: number) {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? limit : 10
  return Math.min(Math.max(Math.trunc(value), 1), 50)
}

export class StorageV2MigrationRunService {
  async recordRun(input: StorageV2MigrationRunInput): Promise<StorageV2MigrationRun> {
    const client = await storageV2Database.getClient()
    const now = new Date().toISOString()
    const run: StorageV2MigrationRun = {
      id: randomUUID(),
      kind: input.kind ?? 'legacy-migration',
      status: input.status,
      dryRun: input.dryRun,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? now,
      snapshotPath: input.snapshotPath ?? null,
      report: input.report ?? null,
      error: input.error ?? null,
      createdAt: now
    }

    await client.execute({
      sql: `
        INSERT INTO migration_runs (
          id,
          kind,
          status,
          dry_run,
          started_at,
          finished_at,
          snapshot_path,
          report_json,
          error,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        run.id,
        run.kind,
        run.status,
        run.dryRun ? 1 : 0,
        run.startedAt,
        run.finishedAt,
        run.snapshotPath,
        JSON.stringify(run.report),
        run.error,
        run.createdAt
      ]
    })

    return run
  }

  async listRuns(limit?: number): Promise<StorageV2MigrationRun[]> {
    const client = await storageV2Database.getClient()
    const result = await client.execute({
      sql: `
        SELECT
          id,
          kind,
          status,
          dry_run,
          started_at,
          finished_at,
          snapshot_path,
          report_json,
          error,
          created_at
        FROM migration_runs
        ORDER BY created_at DESC
        LIMIT ?
      `,
      args: [normalizeLimit(limit)]
    })

    return result.rows.map((row) => ({
      id: String(row.id),
      kind: text(row, 'kind') ?? 'legacy-migration',
      status: (text(row, 'status') ?? 'failed') as StorageV2MigrationRunStatus,
      dryRun: Boolean(row.dry_run),
      startedAt: text(row, 'started_at') ?? '',
      finishedAt: text(row, 'finished_at'),
      snapshotPath: text(row, 'snapshot_path'),
      report: parseJson(text(row, 'report_json')),
      error: text(row, 'error'),
      createdAt: text(row, 'created_at') ?? ''
    }))
  }
}

export const storageV2MigrationRunService = new StorageV2MigrationRunService()
