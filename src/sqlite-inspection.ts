import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

type InspectDb = {
  exec(sql: string): void
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
  close(): void
}

interface ReadOnlySqliteDb extends InspectDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
}

export interface SqliteSchemaInspection {
  userVersion: number
  tables: string[]
  integrity: 'ok'
  recordedVersion?: number
}

export interface MemoryDatabaseIdentity {
  l0Count: number | null
  l0IdsSha256: string | null
  l1Count: number | null
  l1IdsSha256: string | null
  sourceMapSha256: string | null
}

/** Opens an existing SQLite file read-only and records only its raw schema metadata. */
export function inspectSqliteSchema(file: string, versionKey = 'schema_version'): SqliteSchemaInspection {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(versionKey)) throw new Error('SQLite version metadata key is invalid')
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly: boolean }) => InspectDb }
  const db = new sqlite.DatabaseSync(file, { readOnly: true })
  try {
    const check = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') throw new Error(`SQLite integrity check failed: ${file}`)
    const userVersionValue = (db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version
    const userVersion = Number(userVersionValue ?? 0)
    if (!Number.isSafeInteger(userVersion) || userVersion < 0) throw new Error(`SQLite user_version is invalid: ${file}`)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name?: unknown }>).flatMap((row) => typeof row.name === 'string' ? [row.name] : [])
    let recordedVersion: number | undefined
    if (tables.includes('meta')) {
      const columns = (db.prepare('PRAGMA table_info(meta)').all() as Array<{ name?: unknown }>).flatMap((row) => typeof row.name === 'string' ? [row.name] : [])
      if (!columns.includes('key') || !columns.includes('value')) throw new Error(`SQLite meta table has an unsupported shape: ${file}`)
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(versionKey) as { value?: unknown } | undefined
      if (row?.value !== undefined) {
        recordedVersion = Number(row.value)
        if (!Number.isSafeInteger(recordedVersion) || recordedVersion < 0) throw new Error(`SQLite recorded schema version is invalid: ${file}`)
      }
    }
    return { userVersion, tables, integrity: 'ok', ...(recordedVersion === undefined ? {} : { recordedVersion }) }
  } finally {
    db.close()
  }
}

/** Copy a committed SQLite/WAL view without opening the source through a migrating application store. */
export function snapshotSqliteFile(source: string, destination: string, versionKey = 'schema_version'): SqliteSchemaInspection {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error(`SQLite snapshot source is not a regular file: ${source}`)
  const target = path.resolve(destination)
  if (existsSync(target)) throw new Error(`SQLite snapshot destination already exists: ${target}`)
  mkdirSync(path.dirname(target), { recursive: true })
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly: boolean }) => InspectDb }
  const db = new sqlite.DatabaseSync(source, { readOnly: true })
  try {
    const escaped = target.replace(/'/gu, "''")
    db.exec(`VACUUM INTO '${escaped}'`)
  } finally {
    db.close()
  }
  chmodSync(target, 0o600)
  return inspectSqliteSchema(target, versionKey)
}

/** Read-only identity summary used to prove staged restore migrations preserved L0/L1 IDs and source links. */
export function inspectMemoryDatabaseIdentity(file: string): MemoryDatabaseIdentity {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly: boolean }) => InspectDb }
  const db = new sqlite.DatabaseSync(file, { readOnly: true })
  const digest = (rows: string[]): string => createHash('sha256').update(rows.join('\n')).digest('hex')
  try {
    const tableNames = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
    const inspectIds = (table: string): { count: number | null; hash: string | null; ids: string[] } => {
      if (!tableNames.has(table)) return { count: null, hash: null, ids: [] }
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
        .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
      if (!columns.has('id')) return { count: null, hash: null, ids: [] }
      const ids = (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id?: unknown }>)
        .map((row) => String(row.id ?? ''))
      if (ids.some((id) => id === '')) throw new Error(`SQLite ${table}.id contains an empty identity`)
      return { count: ids.length, hash: digest(ids), ids }
    }
    const l0 = inspectIds('l0_messages')
    const l1 = inspectIds('l1_memories')
    let sourceMapSha256: string | null = null
    if (tableNames.has('l1_memories')) {
      const columns = new Set((db.prepare('PRAGMA table_info(l1_memories)').all() as Array<{ name?: unknown }>)
        .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
      if (columns.has('id') && columns.has('source_message_ids')) {
        const rows = db.prepare('SELECT id, source_message_ids FROM l1_memories ORDER BY id').all() as Array<{ id?: unknown; source_message_ids?: unknown }>
        const mapping = rows.map((row) => {
          const id = String(row.id ?? '')
          let sourceIds: unknown
          try { sourceIds = JSON.parse(String(row.source_message_ids ?? '[]')) } catch { throw new Error(`SQLite source map is invalid for memory ${id}`) }
          if (id === '' || !Array.isArray(sourceIds) || sourceIds.some((sourceId) => typeof sourceId !== 'string')) {
            throw new Error(`SQLite source map has an invalid row for memory ${id || '<empty>'}`)
          }
          return `${id}\0${JSON.stringify([...new Set(sourceIds as string[])].sort())}`
        })
        sourceMapSha256 = digest(mapping)
      }
    }
    return { l0Count: l0.count, l0IdsSha256: l0.hash, l1Count: l1.count, l1IdsSha256: l1.hash, sourceMapSha256 }
  } finally { db.close() }
}

/** Find raw source rows that a restore would make pending after the live branch already consumed them. */
export function unconsumedSourcesAlreadyConsumed(snapshotFile: string, currentFile: string, maxRows = 100_000): { count: number; sample: string[]; truncated: boolean } {
  if (!existsSync(snapshotFile) || !existsSync(currentFile)) return { count: 0, sample: [], truncated: false }
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly: boolean }) => ReadOnlySqliteDb }
  const snapshot = new sqlite.DatabaseSync(snapshotFile, { readOnly: true })
  let current: ReadOnlySqliteDb | undefined
  try {
    current = new sqlite.DatabaseSync(currentFile, { readOnly: true })
    const snapshotColumns = new Set((snapshot.prepare('PRAGMA table_info(l0_messages)').all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
    const currentColumns = new Set((current.prepare('PRAGMA table_info(l0_messages)').all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
    if (!snapshotColumns.has('id') || !snapshotColumns.has('extracted_at') || !currentColumns.has('id') || !currentColumns.has('extracted_at')) {
      throw new Error('recovery source reconciliation requires l0_messages.id and extracted_at in both databases')
    }
    const sourceRows = snapshot.prepare('SELECT id FROM l0_messages WHERE extracted_at IS NULL ORDER BY id LIMIT ?')
      .all(maxRows + 1) as Array<{ id?: unknown }>
    const truncated = sourceRows.length > maxRows
    const ids = sourceRows.slice(0, maxRows).flatMap((row) => typeof row.id === 'string' ? [row.id] : [])
    const sample: string[] = []
    let count = 0
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400)
      if (batch.length === 0) continue
      const placeholders = batch.map(() => '?').join(',')
      const rows = current.prepare(`SELECT id FROM l0_messages WHERE id IN (${placeholders}) AND extracted_at IS NOT NULL`).all(...batch) as Array<{ id?: unknown }>
      for (const row of rows) {
        if (typeof row.id !== 'string') continue
        count += 1
        if (sample.length < 12) sample.push(row.id)
      }
    }
    return { count, sample, truncated }
  } finally {
    try { current?.close() } finally { snapshot.close() }
  }
}

/** Read only source IDs from persistent extraction-job rows to map legacy control attempts. */
export function extractionJobSourceIds(file: string, jobIds: string[], maxRows = 100_000): {
  sourceIdsByJob: Map<string, string[]>
  complete: boolean
} {
  const sourceIdsByJob = new Map<string, string[]>()
  if (jobIds.length === 0) return { sourceIdsByJob, complete: true }
  if (!existsSync(file)) return { sourceIdsByJob, complete: false }
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => ReadOnlySqliteDb }
  const db = new sqlite.DatabaseSync(file, { readOnly: true })
  let complete = true
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'extraction_jobs'").get()
    if (table === undefined) return { sourceIdsByJob, complete: false }
    const columns = new Set((db.prepare('PRAGMA table_info(extraction_jobs)').all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
    if (!columns.has('id') || !columns.has('source_ids')) return { sourceIdsByJob, complete: false }
    const unique = [...new Set(jobIds)].slice(0, Math.max(1, maxRows))
    if (unique.length !== new Set(jobIds).size) complete = false
    for (let offset = 0; offset < unique.length; offset += 400) {
      const batch = unique.slice(offset, offset + 400)
      const placeholders = batch.map(() => '?').join(',')
      const rows = db.prepare(`SELECT id, source_ids FROM extraction_jobs WHERE id IN (${placeholders})`).all(...batch) as Array<{ id?: unknown; source_ids?: unknown }>
      for (const row of rows) {
        if (typeof row.id !== 'string') { complete = false; continue }
        try {
          const parsed = JSON.parse(String(row.source_ids ?? '[]')) as unknown
          if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((id) => typeof id === 'string')) { complete = false; continue }
          sourceIdsByJob.set(row.id, [...new Set(parsed)])
        } catch { complete = false }
      }
    }
    if (sourceIdsByJob.size < unique.length) complete = false
    return { sourceIdsByJob, complete }
  } finally { db.close() }
}

/** Compare snapshot-pending sources with both live L0 consumption and durable paid-dispatch IDs. */
export function reconcileRecoverySourceConsumption(snapshotFile: string, currentFile: string, durableSourceIds: string[],
  durableHistoryComplete: boolean, maxRows = 100_000): { count: number; sample: string[]; truncated: boolean; unverifiable: boolean } {
  if (!existsSync(snapshotFile)) throw new Error('recovery snapshot database is missing')
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => ReadOnlySqliteDb }
  const snapshot = new sqlite.DatabaseSync(snapshotFile, { readOnly: true })
  let current: ReadOnlySqliteDb | undefined
  const durable = new Set(durableSourceIds)
  try {
    const snapshotColumns = new Set((snapshot.prepare('PRAGMA table_info(l0_messages)').all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
    if (!snapshotColumns.has('id') || !snapshotColumns.has('extracted_at')) throw new Error('recovery source reconciliation requires snapshot l0_messages.id and extracted_at')
    if (existsSync(currentFile)) current = new sqlite.DatabaseSync(currentFile, { readOnly: true })
    let currentColumns = new Set<string>()
    if (current !== undefined) currentColumns = new Set((current.prepare('PRAGMA table_info(l0_messages)').all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
    if (current !== undefined && (!currentColumns.has('id') || !currentColumns.has('extracted_at'))) {
      throw new Error('recovery source reconciliation requires current l0_messages.id and extracted_at')
    }
    const sourceRows = snapshot.prepare('SELECT id FROM l0_messages WHERE extracted_at IS NULL ORDER BY id LIMIT ?')
      .all(maxRows + 1) as Array<{ id?: unknown }>
    const truncated = sourceRows.length > maxRows
    const ids = sourceRows.slice(0, maxRows).flatMap((row) => typeof row.id === 'string' ? [row.id] : [])
    const sample: string[] = []
    let count = 0
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400)
      const alreadyConsumed = new Set<string>()
      for (const id of batch) if (durable.has(id)) alreadyConsumed.add(id)
      if (current !== undefined) {
        const placeholders = batch.map(() => '?').join(',')
        const rows = current.prepare(`SELECT id FROM l0_messages WHERE id IN (${placeholders}) AND extracted_at IS NOT NULL`).all(...batch) as Array<{ id?: unknown }>
        for (const row of rows) if (typeof row.id === 'string') alreadyConsumed.add(row.id)
      }
      for (const id of alreadyConsumed) {
        count += 1
        if (sample.length < 12) sample.push(id)
      }
    }
    return { count, sample, truncated, unverifiable: !durableHistoryComplete }
  } finally {
    try { current?.close() } finally { snapshot.close() }
  }
}
