import type { AppDataRecord } from './AppDataDatabase'

function recordId(record: Pick<AppDataRecord, 'scope' | 'key'>) {
  return `${record.scope}:${record.key}`
}

function compareRecords(left: AppDataRecord, right: AppDataRecord) {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt
  }

  return (left.version ?? 0) - (right.version ?? 0)
}

export function mergeAppDataRecords(primary: AppDataRecord[], secondary: AppDataRecord[]) {
  const records = new Map<string, AppDataRecord>()

  for (const record of [...secondary, ...primary]) {
    const id = recordId(record)
    const existing = records.get(id)

    if (!existing || compareRecords(existing, record) <= 0) {
      records.set(id, record)
    }
  }

  return Array.from(records.values())
}

export function filterAppDataRecords(records: AppDataRecord[], includeDeleted = false) {
  return includeDeleted ? records : records.filter((record) => record.deletedAt == null)
}
