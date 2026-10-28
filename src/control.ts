/**
 * Monotonic, content-free control ledger shared by project databases.
 *
 * Forget fences and provider attempts must survive restoring an older project
 * snapshot. This file therefore stores IDs, hashes, states and usage only; it
 * never stores message or memory bodies.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { inspectSqliteSchema, type SqliteSchemaInspection } from './sqlite-inspection.js'
import type { DashboardReadVersionStamp } from './dashboard-read.js'

const require = createRequire(import.meta.url)
const CONTROL_SCHEMA_VERSION = 5

type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

export type AttemptState = 'dispatching' | 'complete' | 'failed_known' | 'uncertain_remote' | 'confirmed_not_charged' | 'blocked_charged'

export interface AttemptUsage {
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  costMicros: number | null
}

export interface BillableObservedUsageReceipt {
  verification: 'recorded_not_independently_verified'
  callId: string
  projectKey: string
  purpose: string
  provider: string
  model: string
  requestHash: string
  usageSha256: string
  usage: AttemptUsage
  recordedAt: number
  conflicts: Array<{
    preservedSha256: string
    conflictingSha256: string
    preservedUsage: AttemptUsage
    conflictingUsage: AttemptUsage
    observedAt: number
  }>
}

export interface AttemptRecord {
  id: string
  projectKey: string
  jobId: string
  provider: string
  model: string
  inputHash: string
  requestHash?: string
  billableCallId?: string
  sourceDigest: string
  sourceIds?: string[]
  state: AttemptState
  createdAt: number
  updatedAt: number
  usage: AttemptUsage
  error?: string
}

export interface UsageConflictRecord {
  id: number
  attemptId: string
  field: keyof AttemptUsage
  preservedValue: number
  conflictingValue: number
  priorState: AttemptState
  observedAt: number
}

export interface DashboardVisibilityFences {
  forgottenMemoryIds: string[]
  deletedMemoryIds: string[]
  deletedSourceIds: string[]
  revokedSourceIds: string[]
  revokedSourceEventIds: string[]
  deletedSourceEventIds: string[]
}

export interface DashboardReadUsageRow {
  id?: string
  idBytes: number
  projectKey?: string
  projectKeyBytes: number
  createdAt: number
  state?: string
  stateBytes: number
  label?: string
  labelBytes: number
  provider?: string
  providerBytes: number
  model?: string
  modelBytes: number
  inputTokens?: number | null
  outputTokens?: number | null
  cachedInputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
  costMicros?: number | null
  actualTokens?: number | null
}

export interface DashboardReadCoverageRow {
  id: number
  startedAt: number
  endedAt: number | null
  status?: string
  statusBytes: number
  policyRevision?: string
  policyRevisionBytes: number
}

export interface BillableCall {
  id: string
  projectKey: string
  purpose: string
  budgetClass: 'automatic' | 'manual'
  state: 'reserved' | 'dispatching' | 'complete' | 'failed_known' | 'uncertain' | 'cancelled'
  reservedTokens: number
  actualTokens: number | null
  jobId?: string
  attemptId?: string
  provider?: string
  model?: string
  requestHash?: string
  responseHash?: string
  responseStatus: 'none' | 'saved' | 'committed' | 'blocked'
  /** True only after the local provider stream has returned to its caller. */
  localEnded: boolean
  createdAt: number
  updatedAt: number
}

export interface ControlEvent {
  seq: number
  eventId: string
  projectKey: string
  type: string
  memoryId?: string
  attemptId?: string
  snapshotId?: string
  createdAt: number
}

export interface CoverageWindow {
  id: number
  startedAt: number
  endedAt: number | null
  status: 'active' | 'closed' | 'interrupted'
  policyRevision: string
}

export type ContentDeletionStage = 'database' | 'responses' | 'offloads' | 'global_persona'

export interface ContentDeletionIntent {
  requestDigest: string
  projectKey: string
  memoryIds: string[]
  sourceIds: string[]
  offloadIds: string[]
  sourceEventDigests: string[]
  selectedMemoryIds: string[]
  selectedSourceIds: string[]
  selectedOffloadIds: string[]
  relatedJobIds?: string[]
  fenceSeq: number
  stages: Record<ContentDeletionStage, boolean>
  createdAt: number
  updatedAt: number
  completedAt?: number
  lastError?: string
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finiteTokenUsage(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function sqlFiniteNumber(column: string): string {
  return `CASE WHEN typeof(${column}) IN ('integer', 'real') AND ${column} BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
    THEN CAST(${column} AS REAL) ELSE NULL END`
}

function normalizedObservedUsage(value: Partial<AttemptUsage>): AttemptUsage {
  const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costMicros'] as const
  const usage = {} as AttemptUsage
  for (const field of fields) {
    const item = value[field]
    if (item === undefined || item === null) usage[field] = null
    else if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new Error(`observed ${field} must be null or a finite non-negative integer`)
    else usage[field] = item
  }
  return usage
}

function parseObservedUsage(json: string): AttemptUsage {
  const value = JSON.parse(json) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('stored observed usage receipt is malformed')
  return normalizedObservedUsage(value as Partial<AttemptUsage>)
}

function priorAttemptValue(value: unknown, incoming: number): number {
  return nullableNumber(value) ?? incoming
}

function toAttempt(row: Record<string, unknown>): AttemptRecord {
  let sourceIds: string[] | undefined
  try {
    const parsed = JSON.parse(String(row.source_ids ?? '[]')) as unknown
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) sourceIds = [...new Set(parsed)]
  } catch { /* legacy/corrupt source mapping is reported as incomplete by attemptSourceHistory */ }
  return {
    id: String(row.id),
    projectKey: String(row.project_key),
    jobId: String(row.job_id),
    provider: String(row.provider),
    model: String(row.model),
    inputHash: String(row.input_hash),
    ...(typeof row.request_hash === 'string' && row.request_hash !== '' ? { requestHash: row.request_hash } : {}),
    ...(typeof row.billable_call_id === 'string' && row.billable_call_id !== '' ? { billableCallId: row.billable_call_id } : {}),
    sourceDigest: String(row.source_digest),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    state: String(row.state) as AttemptState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    usage: {
      inputTokens: nullableNumber(row.input_tokens),
      outputTokens: nullableNumber(row.output_tokens),
      cachedInputTokens: nullableNumber(row.cached_input_tokens),
      cacheReadTokens: nullableNumber(row.cache_read_tokens),
      cacheWriteTokens: nullableNumber(row.cache_write_tokens),
      reasoningTokens: nullableNumber(row.reasoning_tokens),
      costMicros: nullableNumber(row.cost_micros),
    },
    ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
  }
}

function contained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

function secureControlFile(root: string): string {
  const requestedRoot = path.resolve(root)
  mkdirSync(requestedRoot, { recursive: true })
  const realRoot = realpathSync(requestedRoot)
  const directory = path.join(realRoot, 'control')
  const existingDirectory = lstatSync(directory, { throwIfNoEntry: false })
  if (existingDirectory === undefined) mkdirSync(directory)
  const realDirectory = realpathSync(directory)
  if (!contained(realRoot, realDirectory) || !statSync(realDirectory).isDirectory()) {
    throw new Error('control directory escapes the configured memory root or is not a directory')
  }
  const file = path.join(realDirectory, 'control.db')
  const existingFile = lstatSync(file, { throwIfNoEntry: false })
  if (existingFile?.isSymbolicLink()) {
    let realFile: string
    try { realFile = realpathSync(file) } catch { throw new Error('control database is a dangling symlink') }
    if (!contained(realRoot, realFile) || !statSync(realFile).isFile()) throw new Error('control database symlink escapes the configured memory root or is not a regular file')
  }
  if (existingFile !== undefined && !existingFile.isSymbolicLink() && !existingFile.isFile()) {
    throw new Error('control database path is not a regular file')
  }
  return file
}

/** Root-local monotonic ledger. One instance is owned by MemoryRuntime. */
export class ControlLedger {
  readonly file: string
  readonly openingSchema: SqliteSchemaInspection | undefined
  private readonly db: SqliteDb
  private readonly dashboardConnectionIdentity: string
  readonly writerEpoch!: number
  private closed = false

  constructor(root: string) {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly: boolean }) => SqliteDb }
    this.file = secureControlFile(root)
    this.openingSchema = existsSync(this.file) ? inspectSqliteSchema(this.file, 'ledger_schema') : undefined
    if ((this.openingSchema?.userVersion ?? 0) > CONTROL_SCHEMA_VERSION) throw new Error(`control ledger user_version is newer than this plugin supports: ${this.openingSchema?.userVersion}`)
    if (this.openingSchema !== undefined) {
      const readonly = new sqlite.DatabaseSync(this.file, { readOnly: true })
      try {
        const metaExists = readonly.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined
        if (metaExists) {
          const meta = readonly.prepare("SELECT value FROM meta WHERE key = 'ledger_schema'").get() as { value?: unknown } | undefined
          if (meta?.value !== undefined) {
            const recorded = Number(meta.value)
            if (!Number.isSafeInteger(recorded) || recorded < 0) throw new Error('control ledger schema marker is invalid')
            if (recorded > CONTROL_SCHEMA_VERSION) throw new Error(`control ledger schema is newer than this plugin supports: ${recorded}`)
          }
        }
      } finally { readonly.close() }
    }
    this.db = new sqlite.DatabaseSync(this.file)
    this.dashboardConnectionIdentity = randomUUID()
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS control_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL,
        type TEXT NOT NULL,
        memory_id TEXT,
        attempt_id TEXT,
        snapshot_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS control_events_project_seq ON control_events(project_key, seq);
      CREATE TABLE IF NOT EXISTS forget_fences (
        project_key TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        control_seq INTEGER NOT NULL,
        forgotten_at INTEGER NOT NULL,
        PRIMARY KEY(project_key, memory_id)
      );
      CREATE TABLE IF NOT EXISTS source_revocations (
        project_key TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        source_id_digest TEXT,
        control_seq INTEGER NOT NULL,
        revoked_at INTEGER NOT NULL,
        PRIMARY KEY(project_key, source_digest)
      );
      CREATE TABLE IF NOT EXISTS content_fences (
        project_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('memory','source','offload')),
        entity_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        control_seq INTEGER NOT NULL,
        fenced_at INTEGER NOT NULL,
        PRIMARY KEY(project_key, entity_kind, entity_id)
      );
      CREATE TABLE IF NOT EXISTS deleted_source_events (
        project_key TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        control_seq INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY(project_key, event_digest)
      );
      CREATE TABLE IF NOT EXISTS content_deletion_intents (
        request_digest TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        offload_ids TEXT NOT NULL,
        selected_memory_ids TEXT NOT NULL,
        selected_source_ids TEXT NOT NULL,
        selected_offload_ids TEXT NOT NULL,
        source_event_digests TEXT NOT NULL,
        related_job_ids TEXT,
        fence_seq INTEGER NOT NULL DEFAULT 0,
        database_done INTEGER NOT NULL DEFAULT 0,
        responses_done INTEGER NOT NULL DEFAULT 0,
        offloads_done INTEGER NOT NULL DEFAULT 0,
        global_persona_done INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS content_deletion_intents_pending_idx ON content_deletion_intents(completed_at, created_at);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        request_hash TEXT,
        billable_call_id TEXT,
        source_digest TEXT NOT NULL,
        source_ids TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        cost_micros INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_job_idx ON attempts(project_key, job_id, created_at);
      CREATE INDEX IF NOT EXISTS attempts_state_idx ON attempts(state, updated_at);
      CREATE TABLE IF NOT EXISTS usage_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        field TEXT NOT NULL,
        preserved_value INTEGER NOT NULL,
        conflicting_value INTEGER NOT NULL,
        prior_state TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_conflicts_attempt_idx ON usage_conflicts(attempt_id, observed_at);
      CREATE TABLE IF NOT EXISTS billable_calls (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        purpose TEXT NOT NULL,
        budget_class TEXT NOT NULL,
        state TEXT NOT NULL,
        reserved_tokens INTEGER NOT NULL,
        actual_tokens INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        job_id TEXT,
        attempt_id TEXT,
        provider TEXT,
        model TEXT,
        request_hash TEXT,
        response_sha256 TEXT,
        response_status TEXT NOT NULL DEFAULT 'none',
        local_ended INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS billable_calls_day_idx ON billable_calls(budget_class, created_at);
      CREATE INDEX IF NOT EXISTS billable_calls_state_idx ON billable_calls(state, updated_at);
      CREATE TABLE IF NOT EXISTS billable_usage_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        reason TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(call_id, receipt_id)
      );
      CREATE INDEX IF NOT EXISTS billable_usage_receipts_call_idx ON billable_usage_receipts(call_id, created_at);
      CREATE TABLE IF NOT EXISTS billable_usage_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        field TEXT NOT NULL,
        preserved_value INTEGER NOT NULL,
        conflicting_value INTEGER NOT NULL,
        observed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS billable_usage_conflicts_call_idx ON billable_usage_conflicts(call_id, observed_at);
      CREATE TABLE IF NOT EXISTS billable_observed_usage (
        call_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        purpose TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        usage_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billable_observed_usage_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        preserved_sha256 TEXT NOT NULL,
        conflicting_sha256 TEXT NOT NULL,
        preserved_usage_json TEXT NOT NULL,
        conflicting_usage_json TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        UNIQUE(call_id, preserved_sha256, conflicting_sha256)
      );
      CREATE INDEX IF NOT EXISTS billable_observed_usage_conflicts_call_idx ON billable_observed_usage_conflicts(call_id, observed_at);
      CREATE TABLE IF NOT EXISTS manual_usage_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        disposition TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS manual_usage_reviews_attempt_idx ON manual_usage_reviews(attempt_id, created_at);
      CREATE TABLE IF NOT EXISTS manual_billable_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        disposition TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS manual_billable_reviews_call_idx ON manual_billable_reviews(call_id, created_at);
      CREATE TABLE IF NOT EXISTS capture_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        policy_revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_marks (
        snapshot_id TEXT PRIMARY KEY,
        control_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('ledger_schema', '1');
      INSERT OR IGNORE INTO meta(key, value) VALUES ('writer_epoch', '0');
      CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_active_job ON attempts(project_key, job_id)
        WHERE state IN ('dispatching', 'uncertain_remote');
    `)
    for (const [table, column, definition] of [
      ['attempts', 'cache_read_tokens', 'INTEGER'], ['attempts', 'cache_write_tokens', 'INTEGER'],
      ['attempts', 'request_hash', 'TEXT'], ['attempts', 'billable_call_id', 'TEXT'],
      ['attempts', 'source_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['billable_calls', 'input_tokens', 'INTEGER'], ['billable_calls', 'output_tokens', 'INTEGER'],
      ['billable_calls', 'job_id', 'TEXT'], ['billable_calls', 'attempt_id', 'TEXT'],
      ['billable_calls', 'provider', 'TEXT'], ['billable_calls', 'model', 'TEXT'], ['billable_calls', 'request_hash', 'TEXT'],
      ['billable_calls', 'response_sha256', 'TEXT'], ['billable_calls', 'response_status', "TEXT NOT NULL DEFAULT 'none'"],
      ['billable_calls', 'local_ended', 'INTEGER NOT NULL DEFAULT 0'],
      ['content_deletion_intents', 'related_job_ids', 'TEXT'],
    ] as const) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
      if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS source_revocations_source_id ON source_revocations(project_key, source_id_digest)')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS attempts_billable_call_unique ON attempts(billable_call_id) WHERE billable_call_id IS NOT NULL')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS billable_calls_attempt_unique ON billable_calls(attempt_id) WHERE attempt_id IS NOT NULL')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE attempts SET state = 'confirmed_not_charged', updated_at = ? WHERE state = 'dispatching' AND billable_call_id IN (SELECT id FROM billable_calls WHERE state = 'reserved')").run(Date.now())
      this.db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'writer_epoch'").run()
      const epoch = this.db.prepare("SELECT value FROM meta WHERE key = 'writer_epoch'").get() as { value?: string }
      this.writerEpoch = Number(epoch?.value ?? 1)
      const now = Date.now()
      this.db.prepare("UPDATE attempts SET state = 'uncertain_remote', updated_at = ? WHERE state = 'dispatching'").run(now)
      this.db.prepare("UPDATE billable_calls SET state = 'uncertain', updated_at = ? WHERE state = 'dispatching'").run(now)
      this.db.prepare("UPDATE billable_calls SET state = 'cancelled', actual_tokens = 0, updated_at = ? WHERE state = 'reserved'").run(now)
      // MemoryRuntime acquires the exclusive process writer lease before opening
      // this ledger. A dispatching/uncertain call left by the previous owner can
      // no longer have a live local stream after that lease handoff, while its
      // remote charge state must remain unknown until matching evidence arrives.
      this.db.prepare("UPDATE billable_calls SET local_ended = 1 WHERE state IN ('uncertain', 'complete', 'failed_known', 'cancelled')").run()
      this.db.prepare(
        `INSERT OR IGNORE INTO control_events(event_id, project_key, type, created_at)
         SELECT 'attempt:' || id || ':startup-unknown:' || ?, project_key, 'attempt_uncertain_remote', ?
         FROM attempts WHERE state IN ('uncertain_remote','confirmed_not_charged') AND updated_at = ?`,
      ).run(this.writerEpoch, now, now)
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'ledger_schema'").run(String(CONTROL_SCHEMA_VERSION))
      this.db.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  appendControl(input: { eventId: string; projectKey: string; type: string; memoryId?: string; attemptId?: string; snapshotId?: string; now?: number }): number {
    this.ensureOpen()
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const seq = this.appendControlInTransaction(input, now)
      this.db.exec('COMMIT')
      return seq
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private appendControlInTransaction(input: { eventId: string; projectKey: string; type: string; memoryId?: string; attemptId?: string; snapshotId?: string }, now: number): number {
    this.db.prepare(
      `INSERT OR IGNORE INTO control_events(event_id, project_key, type, memory_id, attempt_id, snapshot_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.eventId, input.projectKey, input.type, input.memoryId ?? null, input.attemptId ?? null, input.snapshotId ?? null, now)
    const row = this.db.prepare('SELECT seq, project_key, type, memory_id, attempt_id, snapshot_id FROM control_events WHERE event_id = ?').get(input.eventId) as
      | { seq?: number; project_key?: string; type?: string; memory_id?: string | null; attempt_id?: string | null; snapshot_id?: string | null }
      | undefined
    if (row === undefined) throw new Error('control event insert could not be verified')
    const mismatch = String(row.project_key) !== input.projectKey || String(row.type) !== input.type ||
      (row.memory_id ?? undefined) !== input.memoryId || (row.attempt_id ?? undefined) !== input.attemptId || (row.snapshot_id ?? undefined) !== input.snapshotId
    if (mismatch) throw new Error('control event idempotency key conflicts with a different payload')
    const seq = Number(row.seq ?? 0)
    if (input.type === 'forget' && input.memoryId !== undefined) {
      this.db.prepare(
        `INSERT INTO forget_fences(project_key, memory_id, control_seq, forgotten_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_key, memory_id) DO UPDATE SET
           control_seq = MAX(forget_fences.control_seq, excluded.control_seq),
           forgotten_at = CASE WHEN excluded.control_seq > forget_fences.control_seq THEN excluded.forgotten_at ELSE forget_fences.forgotten_at END`,
      ).run(input.projectKey, input.memoryId, seq, now)
    }
    return seq
  }

  isForgotten(projectKey: string, memoryId: string): boolean {
    this.ensureOpen()
    return this.db.prepare('SELECT 1 AS found FROM forget_fences WHERE project_key = ? AND memory_id = ?').get(projectKey, memoryId) !== undefined
  }

  forgottenIds(projectKey: string): Set<string> {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT memory_id FROM forget_fences WHERE project_key = ?').all(projectKey) as Array<{ memory_id?: string }>
    return new Set(rows.flatMap((row) => typeof row.memory_id === 'string' ? [row.memory_id] : []))
  }

  /**
   * Revoke use of one verifiable Host event. The raw Host identity is hashed
   * before it enters the content-free, snapshot-independent ledger.
   */
  revokeSourceEvent(projectKey: string, sourceEventId: string, sourceIdOrNow?: string | number, suppliedNow = Date.now()): { revoked: true; alreadyRevoked: boolean } {
    this.ensureOpen()
    if (projectKey.trim() === '' || sourceEventId.trim() === '' || sourceEventId.length > 2000) throw new Error('source revocation requires a bounded project key and Host event identity')
    const sourceId = typeof sourceIdOrNow === 'string' ? sourceIdOrNow : undefined
    const now = typeof sourceIdOrNow === 'number' ? sourceIdOrNow : suppliedNow
    if (sourceId !== undefined && (sourceId.trim() === '' || sourceId.length > 200)) throw new Error('source revocation requires a bounded local source ID')
    const digest = createHash('sha256').update(`${projectKey}\0${sourceEventId}`).digest('hex')
    const sourceIdDigest = sourceId === undefined ? null : createHash('sha256').update(`${projectKey}\0${sourceId}`).digest('hex')
    const eventId = `source-revoke:${digest}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const prior = this.db.prepare('SELECT 1 AS found FROM source_revocations WHERE project_key = ? AND source_digest = ?').get(projectKey, digest) !== undefined
      const seq = this.appendControlInTransaction({ eventId, projectKey, type: 'source_revocation' }, now)
      this.db.prepare('INSERT OR IGNORE INTO source_revocations(project_key, source_digest, source_id_digest, control_seq, revoked_at) VALUES (?, ?, ?, ?, ?)')
        .run(projectKey, digest, sourceIdDigest, seq, now)
      if (sourceIdDigest !== null) this.db.prepare('UPDATE source_revocations SET source_id_digest = COALESCE(source_id_digest, ?) WHERE project_key = ? AND source_digest = ?')
        .run(sourceIdDigest, projectKey, digest)
      const confirmed = this.db.prepare('SELECT control_seq, source_id_digest FROM source_revocations WHERE project_key = ? AND source_digest = ?').get(projectKey, digest) as { control_seq?: number; source_id_digest?: string | null } | undefined
      if (confirmed === undefined || Number(confirmed.control_seq) !== seq) throw new Error('source revocation fence could not be verified')
      if (sourceIdDigest !== null && confirmed.source_id_digest !== sourceIdDigest) throw new Error('source ID revocation mapping could not be verified')
      this.db.exec('COMMIT')
      return { revoked: true, alreadyRevoked: prior }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  isSourceEventRevoked(projectKey: string, sourceEventId: string): boolean {
    this.ensureOpen()
    if (sourceEventId === '') return false
    const digest = createHash('sha256').update(`${projectKey}\0${sourceEventId}`).digest('hex')
    return this.db.prepare('SELECT 1 AS found FROM source_revocations WHERE project_key = ? AND source_digest = ?').get(projectKey, digest) !== undefined
  }

  isSourceIdRevoked(projectKey: string, sourceId: string): boolean {
    this.ensureOpen()
    if (sourceId === '') return false
    const digest = createHash('sha256').update(`${projectKey}\0${sourceId}`).digest('hex')
    return this.db.prepare('SELECT 1 AS found FROM source_revocations WHERE project_key = ? AND source_id_digest = ?')
      .get(projectKey, digest) !== undefined
  }

  revokedSourceIds(projectKey: string, sourceIds: string[]): Set<string> {
    this.ensureOpen()
    const digestToId = new Map<string, string>()
    for (const sourceId of new Set(sourceIds)) {
      if (sourceId !== '') digestToId.set(createHash('sha256').update(`${projectKey}\0${sourceId}`).digest('hex'), sourceId)
    }
    const digests = [...digestToId.keys()]
    const revoked = new Set<string>()
    for (let offset = 0; offset < digests.length; offset += 200) {
      const batch = digests.slice(offset, offset + 200)
      const rows = this.db.prepare(`SELECT source_id_digest FROM source_revocations
        WHERE project_key = ? AND source_id_digest IN (${batch.map(() => '?').join(',')})`).all(projectKey, ...batch) as Array<{ source_id_digest?: string }>
      for (const row of rows) {
        const sourceId = digestToId.get(String(row.source_id_digest ?? ''))
        if (sourceId !== undefined) revoked.add(sourceId)
      }
    }
    return revoked
  }

  fencedSourceEventIds(projectKey: string, sourceEventIds: string[]): Set<string> {
    this.ensureOpen()
    const digestToId = new Map<string, string>()
    for (const sourceEventId of new Set(sourceEventIds)) {
      if (sourceEventId !== '') digestToId.set(createHash('sha256').update(`${projectKey}\0${sourceEventId}`).digest('hex'), sourceEventId)
    }
    const digests = [...digestToId.keys()]
    const fenced = new Set<string>()
    for (let offset = 0; offset < digests.length; offset += 200) {
      const batch = digests.slice(offset, offset + 200)
      const placeholders = batch.map(() => '?').join(',')
      const revoked = this.db.prepare(`SELECT source_digest AS digest FROM source_revocations
        WHERE project_key = ? AND source_digest IN (${placeholders})`).all(projectKey, ...batch) as Array<{ digest?: string }>
      const deleted = this.db.prepare(`SELECT event_digest AS digest FROM deleted_source_events
        WHERE project_key = ? AND event_digest IN (${placeholders})`).all(projectKey, ...batch) as Array<{ digest?: string }>
      for (const row of [...revoked, ...deleted]) {
        const sourceEventId = digestToId.get(String(row.digest ?? ''))
        if (sourceEventId !== undefined) fenced.add(sourceEventId)
      }
    }
    return fenced
  }

  /** Persist the original cleanup scope and anti-resurrection fences before purge. */
  fenceContentDeletion(input: { projectKey: string; requestDigest: string; memoryIds: string[]; sourceIds: string[]; offloadIds?: string[];
    selectedMemoryIds?: string[]; selectedSourceIds?: string[]; selectedOffloadIds?: string[]; sourceEventIds?: string[]; relatedJobIds?: string[]; now?: number }): number {
    this.ensureOpen()
    if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) throw new Error('content deletion request digest is invalid')
    const memoryIds = [...new Set(input.memoryIds)].sort()
    const sourceIds = [...new Set(input.sourceIds)].sort()
    const offloadIds = [...new Set(input.offloadIds ?? [])].sort()
    const selectedMemoryIds = [...new Set(input.selectedMemoryIds ?? memoryIds)].sort()
    const selectedSourceIds = [...new Set(input.selectedSourceIds ?? sourceIds)].sort()
    const selectedOffloadIds = [...new Set(input.selectedOffloadIds ?? offloadIds)].sort()
    const sourceEventIds = [...new Set(input.sourceEventIds ?? [])].sort()
    const relatedJobIds = [...new Set(input.relatedJobIds ?? [])].sort()
    if (memoryIds.length > 1000 || sourceIds.length > 5000 || offloadIds.length > 5000 || sourceEventIds.length > 5000 ||
        selectedMemoryIds.length > 1000 || selectedSourceIds.length > 5000 || selectedOffloadIds.length > 500 || relatedJobIds.length > 5000 ||
        [...memoryIds, ...sourceIds, ...offloadIds, ...selectedMemoryIds, ...selectedSourceIds, ...selectedOffloadIds, ...relatedJobIds].some((id) => id === '' || id.length > 200) ||
        sourceEventIds.some((id) => id === '' || id.length > 2000)) {
      throw new Error('content deletion selection exceeds its bounded limits')
    }
    if (memoryIds.length + sourceIds.length + offloadIds.length + sourceEventIds.length === 0) throw new Error('content deletion selection is empty')
    const sourceEventDigests = sourceEventIds.map((id) => createHash('sha256').update(`${input.projectKey}\0${id}`).digest('hex')).sort()
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const existingIntent = this.db.prepare(`SELECT project_key, memory_ids, source_ids, offload_ids, selected_memory_ids, selected_source_ids,
        selected_offload_ids, source_event_digests, related_job_ids FROM content_deletion_intents WHERE request_digest = ?`)
        .get(input.requestDigest) as Record<string, unknown> | undefined
      const requestedScope = [input.projectKey, JSON.stringify(memoryIds), JSON.stringify(sourceIds), JSON.stringify(offloadIds), JSON.stringify(sourceEventDigests), JSON.stringify(relatedJobIds)]
      if (existingIntent !== undefined) {
        const priorRelatedJobs = existingIntent.related_job_ids === null || existingIntent.related_job_ids === undefined
          ? (relatedJobIds.length === 0 ? JSON.stringify([]) : '<legacy-unbound>') : String(existingIntent.related_job_ids)
        const priorScope = [String(existingIntent.project_key), String(existingIntent.memory_ids), String(existingIntent.source_ids),
          String(existingIntent.offload_ids), String(existingIntent.source_event_digests), priorRelatedJobs]
        const priorSelection = [String(existingIntent.selected_memory_ids), String(existingIntent.selected_source_ids), String(existingIntent.selected_offload_ids)]
        const requestedSelection = [JSON.stringify(selectedMemoryIds), JSON.stringify(selectedSourceIds), JSON.stringify(selectedOffloadIds)]
        if (JSON.stringify(priorScope) !== JSON.stringify(requestedScope) || JSON.stringify(priorSelection) !== JSON.stringify(requestedSelection)) {
          throw new Error('content deletion request digest is already bound to a different cleanup scope')
        }
      } else {
        this.db.prepare(`INSERT INTO content_deletion_intents(request_digest, project_key, memory_ids, source_ids, offload_ids,
          selected_memory_ids, selected_source_ids, selected_offload_ids, source_event_digests, related_job_ids, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.requestDigest, input.projectKey, JSON.stringify(memoryIds), JSON.stringify(sourceIds), JSON.stringify(offloadIds),
            JSON.stringify(selectedMemoryIds), JSON.stringify(selectedSourceIds), JSON.stringify(selectedOffloadIds), JSON.stringify(sourceEventDigests), JSON.stringify(relatedJobIds), now, now)
      }
      let highWater = 0
      const insert = this.db.prepare(`INSERT OR IGNORE INTO content_fences(project_key, entity_kind, entity_id, request_digest, control_seq, fenced_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
      for (const [kind, ids] of [['memory', memoryIds], ['source', sourceIds], ['offload', offloadIds]] as const) {
        for (const id of ids) {
          const eventId = `content-delete:${input.requestDigest}:${kind}:${createHash('sha256').update(id).digest('hex')}`
          const seq = this.appendControlInTransaction({ eventId, projectKey: input.projectKey, type: `content_delete_${kind}`, memoryId: id }, now)
          insert.run(input.projectKey, kind, id, input.requestDigest, seq, now)
          const row = this.db.prepare('SELECT control_seq FROM content_fences WHERE project_key = ? AND entity_kind = ? AND entity_id = ?')
            .get(input.projectKey, kind, id) as { control_seq?: number } | undefined
          if (row === undefined) throw new Error(`content deletion fence could not be verified: ${kind}`)
          highWater = Math.max(highWater, Number(row.control_seq ?? 0))
        }
      }
      const insertDeletedEvent = this.db.prepare(`INSERT OR IGNORE INTO deleted_source_events(project_key, event_digest, request_digest, control_seq, deleted_at)
        VALUES (?, ?, ?, ?, ?)`)
      for (const digest of sourceEventDigests) {
        const eventId = `content-delete-event:${input.requestDigest}:${digest}`
        const seq = this.appendControlInTransaction({ eventId, projectKey: input.projectKey, type: 'content_delete_source_event' }, now)
        insertDeletedEvent.run(input.projectKey, digest, input.requestDigest, seq, now)
        const row = this.db.prepare('SELECT control_seq FROM deleted_source_events WHERE project_key = ? AND event_digest = ?')
          .get(input.projectKey, digest) as { control_seq?: number } | undefined
        if (row === undefined) throw new Error('content deletion event fence could not be verified')
        highWater = Math.max(highWater, Number(row.control_seq ?? 0))
      }
      this.db.prepare('UPDATE content_deletion_intents SET fence_seq = MAX(fence_seq, ?), updated_at = ? WHERE request_digest = ?')
        .run(highWater, now, input.requestDigest)
      this.db.exec('COMMIT')
      return highWater
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  isSourceEventDeleted(projectKey: string, sourceEventId: string): boolean {
    this.ensureOpen()
    if (sourceEventId === '') return false
    const digest = createHash('sha256').update(`${projectKey}\0${sourceEventId}`).digest('hex')
    return this.db.prepare('SELECT 1 AS found FROM deleted_source_events WHERE project_key = ? AND event_digest = ?').get(projectKey, digest) !== undefined
  }

  isContentDeleted(projectKey: string, kind: 'memory' | 'source' | 'offload', entityId: string): boolean {
    this.ensureOpen()
    return this.db.prepare('SELECT 1 AS found FROM content_fences WHERE project_key = ? AND entity_kind = ? AND entity_id = ?')
      .get(projectKey, kind, entityId) !== undefined
  }

  /** Bounded point/existence probes for one visibility batch; output rows are one-per-requested ID. */
  dashboardVisibilityFences(input: { projectKey: string; memoryIds?: readonly string[]; sourceIds?: readonly string[];
    sourceEventIds?: readonly string[] }): DashboardVisibilityFences {
    this.ensureOpen()
    const projectKey = input.projectKey
    if (typeof projectKey !== 'string' || projectKey.length === 0 || Buffer.byteLength(projectKey, 'utf8') > 256) {
      throw new TypeError('visibility fence project key is invalid')
    }
    const memoryIds = [...new Set(input.memoryIds ?? [])]
    const sourceIds = [...new Set(input.sourceIds ?? [])]
    const sourceEventIds = [...new Set(input.sourceEventIds ?? [])]
    const boundedIds = (ids: string[], maximumBytes: number, label: string): void => {
      if (ids.length > 15 || ids.some((id) => typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > maximumBytes)) {
        throw new RangeError(`${label} visibility fence batch exceeds its bound`)
      }
    }
    boundedIds(memoryIds, 256, 'memory')
    boundedIds(sourceIds, 256, 'source')
    boundedIds(sourceEventIds, 2000, 'source-event')
    const result: DashboardVisibilityFences = {
      forgottenMemoryIds: [], deletedMemoryIds: [], deletedSourceIds: [], revokedSourceIds: [],
      revokedSourceEventIds: [], deletedSourceEventIds: [],
    }
    if (memoryIds.length > 0) {
      const values = memoryIds.map(() => '(?)').join(',')
      const rows = this.db.prepare(`WITH requested(id) AS (VALUES ${values})
        SELECT id,
          EXISTS(SELECT 1 FROM forget_fences f WHERE f.project_key = ? AND f.memory_id = requested.id) AS forgotten,
          EXISTS(SELECT 1 FROM content_fences c WHERE c.project_key = ? AND c.entity_kind = 'memory' AND c.entity_id = requested.id) AS deleted
        FROM requested`).all(...memoryIds, projectKey, projectKey) as Array<Record<string, unknown>>
      if (rows.length !== memoryIds.length) throw new Error('visibility memory-fence probe returned an incomplete batch')
      for (const row of rows) {
        if (typeof row.id !== 'string') throw new Error('visibility memory-fence probe returned an invalid key')
        if (Number(row.forgotten) === 1) result.forgottenMemoryIds.push(row.id)
        if (Number(row.deleted) === 1) result.deletedMemoryIds.push(row.id)
      }
    }
    if (sourceIds.length > 0) {
      const sourcePairs = sourceIds.map((id) => ({ id,
        digest: createHash('sha256').update(`${projectKey}\0${id}`).digest('hex') }))
      const values = sourcePairs.map(() => '(?,?)').join(',')
      const rows = this.db.prepare(`WITH requested(id,digest) AS (VALUES ${values})
        SELECT id,
          EXISTS(SELECT 1 FROM content_fences c WHERE c.project_key = ? AND c.entity_kind = 'source' AND c.entity_id = requested.id) AS deleted,
          EXISTS(SELECT 1 FROM source_revocations r WHERE r.project_key = ? AND r.source_id_digest = requested.digest) AS revoked
        FROM requested`).all(...sourcePairs.flatMap(({ id, digest }) => [id, digest]), projectKey, projectKey) as Array<Record<string, unknown>>
      if (rows.length !== sourceIds.length) throw new Error('visibility source-fence probe returned an incomplete batch')
      for (const row of rows) {
        if (typeof row.id !== 'string') throw new Error('visibility source-fence probe returned an invalid key')
        if (Number(row.deleted) === 1) result.deletedSourceIds.push(row.id)
        if (Number(row.revoked) === 1) result.revokedSourceIds.push(row.id)
      }
    }
    if (sourceEventIds.length > 0) {
      const eventPairs = sourceEventIds.map((id) => ({ id,
        digest: createHash('sha256').update(`${projectKey}\0${id}`).digest('hex') }))
      const values = eventPairs.map(() => '(?,?)').join(',')
      const rows = this.db.prepare(`WITH requested(id,digest) AS (VALUES ${values})
        SELECT id,
          EXISTS(SELECT 1 FROM source_revocations r WHERE r.project_key = ? AND r.source_digest = requested.digest) AS revoked,
          EXISTS(SELECT 1 FROM deleted_source_events d WHERE d.project_key = ? AND d.event_digest = requested.digest) AS deleted
        FROM requested`).all(...eventPairs.flatMap(({ id, digest }) => [id, digest]), projectKey, projectKey) as Array<Record<string, unknown>>
      if (rows.length !== sourceEventIds.length) throw new Error('visibility source-event fence probe returned an incomplete batch')
      for (const row of rows) {
        if (typeof row.id !== 'string') throw new Error('visibility source-event fence probe returned an invalid key')
        if (Number(row.revoked) === 1) result.revokedSourceEventIds.push(row.id)
        if (Number(row.deleted) === 1) result.deletedSourceEventIds.push(row.id)
      }
    }
    return result
  }

  contentDeletedIds(projectKey: string, kind: 'memory' | 'source' | 'offload'): Set<string> {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT entity_id FROM content_fences WHERE project_key = ? AND entity_kind = ?').all(projectKey, kind) as Array<{ entity_id?: string }>
    return new Set(rows.flatMap((row) => typeof row.entity_id === 'string' ? [row.entity_id] : []))
  }

  contentDeletionIntent(requestDigest: string): ContentDeletionIntent | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM content_deletion_intents WHERE request_digest = ?').get(requestDigest) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const readIds = (key: string): string[] => {
      try { const value = JSON.parse(String(row[key] ?? '[]')) as unknown; return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [] }
      catch { return [] }
    }
    return { requestDigest: String(row.request_digest), projectKey: String(row.project_key), memoryIds: readIds('memory_ids'),
      sourceIds: readIds('source_ids'), offloadIds: readIds('offload_ids'), selectedMemoryIds: readIds('selected_memory_ids'),
      selectedSourceIds: readIds('selected_source_ids'), selectedOffloadIds: readIds('selected_offload_ids'), sourceEventDigests: readIds('source_event_digests'),
      ...(typeof row.related_job_ids === 'string' ? { relatedJobIds: readIds('related_job_ids') } : {}),
      fenceSeq: Number(row.fence_seq ?? 0), stages: { database: Number(row.database_done ?? 0) === 1,
        responses: Number(row.responses_done ?? 0) === 1, offloads: Number(row.offloads_done ?? 0) === 1,
        global_persona: Number(row.global_persona_done ?? 0) === 1 }, createdAt: Number(row.created_at ?? 0), updatedAt: Number(row.updated_at ?? 0),
      ...(row.completed_at === null || row.completed_at === undefined ? {} : { completedAt: Number(row.completed_at) }),
      ...(typeof row.last_error === 'string' && row.last_error !== '' ? { lastError: String(row.last_error) } : {}) }
  }

  pendingContentDeletionIntents(limit = 100): ContentDeletionIntent[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT request_digest FROM content_deletion_intents WHERE completed_at IS NULL ORDER BY created_at ASC LIMIT ?')
      .all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{ request_digest?: string }>
    return rows.flatMap((row) => typeof row.request_digest === 'string' ? [this.contentDeletionIntent(row.request_digest)!] : [])
  }

  contentDeletionIntentsForProject(projectKey: string, limit = 500): ContentDeletionIntent[] {
    this.ensureOpen()
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
    const rows = this.db.prepare('SELECT request_digest FROM content_deletion_intents WHERE project_key = ? ORDER BY created_at ASC, request_digest ASC LIMIT ?')
      .all(projectKey, boundedLimit + 1) as Array<{ request_digest?: string }>
    if (rows.length > boundedLimit) throw new Error('content deletion intent history exceeds its bounded recovery limit')
    return rows.flatMap((row) => typeof row.request_digest === 'string' ? [this.contentDeletionIntent(row.request_digest)!] : [])
  }

  markContentDeletionStage(requestDigest: string, stage: ContentDeletionStage, error?: string, now = Date.now()): void {
    this.ensureOpen()
    const column = ({ database: 'database_done', responses: 'responses_done', offloads: 'offloads_done', global_persona: 'global_persona_done' } as const)[stage]
    this.db.prepare(`UPDATE content_deletion_intents SET ${column} = 1, last_error = ?, updated_at = ? WHERE request_digest = ? AND completed_at IS NULL`)
      .run(error === undefined ? null : error.slice(0, 1000), now, requestDigest)
  }

  recordContentDeletionError(requestDigest: string, error: string, now = Date.now()): void {
    this.ensureOpen()
    this.db.prepare('UPDATE content_deletion_intents SET last_error = ?, updated_at = ? WHERE request_digest = ? AND completed_at IS NULL')
      .run(error.slice(0, 1000), now, requestDigest)
  }

  finishContentDeletion(requestDigest: string, now = Date.now()): void {
    this.ensureOpen()
    const result = this.db.prepare(`UPDATE content_deletion_intents SET completed_at = ?, last_error = NULL, updated_at = ?
      WHERE request_digest = ? AND database_done = 1 AND responses_done = 1 AND offloads_done = 1 AND global_persona_done = 1`)
      .run(now, now, requestDigest)
    if (Number(result.changes ?? 0) !== 1) throw new Error('content deletion intent still has unfinished cleanup stages')
  }

  controlHighWater(): number {
    this.ensureOpen()
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM control_events').get() as { n?: number }
    return Number(row?.n ?? 0)
  }

  recordSnapshot(snapshotId: string, schemaVersion: number, now = Date.now()): { snapshotId: string; controlSeq: number; createdAt: number } {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const controlSeq = this.appendControlInTransaction({ eventId: `snapshot:${snapshotId}`, projectKey: '*', type: 'snapshot', snapshotId }, now)
      this.db.prepare(
        `INSERT INTO recovery_marks(snapshot_id, control_seq, created_at, schema_version) VALUES (?, ?, ?, ?)
         ON CONFLICT(snapshot_id) DO NOTHING`,
      ).run(snapshotId, controlSeq, now, schemaVersion)
      this.db.exec('COMMIT')
      return { snapshotId, controlSeq, createdAt: now }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  rollbackPlan(snapshotId: string): { snapshotId: string; snapshotControlSeq: number; currentControlSeq: number; replay: ControlEvent[]; safeForWrites: boolean; blockers: string[] } {
    this.ensureOpen()
    const mark = this.db.prepare('SELECT control_seq FROM recovery_marks WHERE snapshot_id = ?').get(snapshotId) as { control_seq?: number } | undefined
    if (mark === undefined) return { snapshotId, snapshotControlSeq: 0, currentControlSeq: this.controlHighWater(), replay: [], safeForWrites: false, blockers: ['snapshot control mark is missing'] }
    const snapshotControlSeq = Number(mark.control_seq ?? 0)
    const rows = this.db.prepare(
      `SELECT seq, event_id, project_key, type, memory_id, attempt_id, snapshot_id, created_at
       FROM control_events WHERE seq > ? ORDER BY seq ASC`,
    ).all(snapshotControlSeq) as Array<Record<string, unknown>>
    const replay = rows.map((row) => ({
      seq: Number(row.seq), eventId: String(row.event_id), projectKey: String(row.project_key), type: String(row.type),
      ...(typeof row.memory_id === 'string' ? { memoryId: row.memory_id } : {}),
      ...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
      ...(typeof row.snapshot_id === 'string' ? { snapshotId: row.snapshot_id } : {}),
      createdAt: Number(row.created_at),
    }))
    const countRow = this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state IN ('dispatching', 'uncertain_remote')").get() as { n?: number }
    const unresolved = this.db.prepare("SELECT id, state FROM attempts WHERE state IN ('dispatching', 'uncertain_remote') ORDER BY created_at ASC LIMIT 50").all() as Array<{ id?: string; state?: string }>
    const count = Number(countRow?.n ?? 0)
    const blockers = unresolved.map((attempt) => `attempt ${String(attempt.id)} has ${String(attempt.state)} usage`)
    if (count > unresolved.length) blockers.push(`${count - unresolved.length} additional unresolved attempt(s)`)
    const billableCount = this.db.prepare("SELECT COUNT(*) AS n FROM billable_calls WHERE state IN ('dispatching', 'uncertain')").get() as { n?: number }
    const billableCalls = this.db.prepare("SELECT id, state FROM billable_calls WHERE state IN ('dispatching', 'uncertain') ORDER BY created_at ASC LIMIT 50").all() as Array<{ id?: string; state?: string }>
    const unresolvedBillable = Number(billableCount?.n ?? 0)
    blockers.push(...billableCalls.map((call) => 'billable call ' + String(call.id) + ' has ' + String(call.state) + ' usage'))
    if (unresolvedBillable > billableCalls.length) blockers.push(String(unresolvedBillable - billableCalls.length) + ' additional unresolved billable call(s)')
    return { snapshotId, snapshotControlSeq, currentControlSeq: this.controlHighWater(), replay, safeForWrites: blockers.length === 0, blockers }
  }

  beginAttempt(input: { id: string; projectKey: string; jobId: string; provider: string; model: string; inputHash: string; requestHash?: string; sourceDigest: string; sourceIds?: string[]; billableCallId?: string; now?: number }): AttemptRecord {
    this.ensureOpen()
    this.assertWriterEpoch()
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const currentEpoch = this.db.prepare("SELECT value FROM meta WHERE key = 'writer_epoch'").get() as { value?: string }
      if (Number(currentEpoch?.value ?? 0) !== this.writerEpoch) throw new Error('stale writer epoch; this runtime may not dispatch')
      if (input.billableCallId !== undefined) {
        const call = this.db.prepare('SELECT * FROM billable_calls WHERE id = ?').get(input.billableCallId) as Record<string, unknown> | undefined
        if (call === undefined || call.state !== 'reserved' || call.project_key !== input.projectKey || call.job_id !== input.jobId ||
            call.attempt_id !== input.id || call.provider !== input.provider || call.model !== input.model ||
            (input.requestHash !== undefined && call.request_hash !== input.requestHash)) {
          throw new Error('billable reservation does not match the extraction attempt identity')
        }
      }
      const sourceIds = [...new Set(input.sourceIds ?? [])]
      if (input.sourceIds !== undefined && (sourceIds.length === 0 || createHash('sha256').update(sourceIds.join('\0')).digest('hex') !== input.sourceDigest)) {
        throw new Error('extraction attempt source IDs do not match the durable source digest')
      }
      const previous = this.db.prepare('SELECT state FROM attempts WHERE project_key = ? AND job_id = ?').all(input.projectKey, input.jobId) as Array<{ state?: string }>
      if (previous.some((attempt) => attempt.state !== 'confirmed_not_charged' && attempt.state !== 'failed_known')) {
        throw new Error('extraction attempt is unresolved or already consumed; automatic redispatch is blocked')
      }
      this.db.prepare(
        `INSERT INTO attempts(id, project_key, job_id, provider, model, input_hash, request_hash, billable_call_id, source_digest, source_ids, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
      ).run(input.id, input.projectKey, input.jobId, input.provider, input.model, input.inputHash, input.requestHash ?? null,
        input.billableCallId ?? null, input.sourceDigest, JSON.stringify(sourceIds), now, now)
      this.db.prepare(
        'INSERT INTO control_events(event_id, project_key, type, attempt_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(`attempt:${input.id}:dispatch`, input.projectKey, 'attempt_dispatch', input.id, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
        throw new Error('another writer already created an active attempt for this job')
      }
      throw error
    }
    return this.getAttempt(input.id)!
  }

  settleAttempt(id: string, state: Exclude<AttemptState, 'dispatching'>, usage?: Partial<AttemptUsage>, error?: string, now = Date.now()): AttemptRecord {
    this.ensureOpen()
    const allowed = new Set<AttemptState>(['complete', 'failed_known', 'uncertain_remote', 'confirmed_not_charged', 'blocked_charged'])
    if (!allowed.has(state)) throw new Error('invalid attempt state')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const existing = this.getAttempt(id)
      if (existing === undefined) throw new Error(`attempt not found: ${id}`)
      const mayResolve = existing.state === 'dispatching' || existing.state === 'uncertain_remote'
      const next: AttemptState = mayResolve ? state : existing.state
      const merged = {} as AttemptUsage
      const newlyKnown: string[] = []
      const conflicts: Array<{ field: keyof AttemptUsage; prior: number; incoming: number }> = []
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costMicros'] as const) {
        const prior = existing.usage[key]
        const present = usage !== undefined && Object.hasOwn(usage, key)
        const incoming = present ? nullableNumber(usage[key]) : null
        if (!present || incoming === null) merged[key] = prior
        else if (prior === null || prior === incoming) {
          merged[key] = incoming
          if (prior === null) newlyKnown.push(key)
        } else {
          // The first numeric receipt is authoritative. Later contradictions
          // are retained in a content-free audit table instead of replacing it
          // or rolling back the state transition.
          merged[key] = prior
          conflicts.push({ field: key, prior, incoming })
        }
      }
      const lateChargeEvidence = (existing.state === 'confirmed_not_charged' || state === 'confirmed_not_charged') &&
        ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costMicros']
          .some((key) => {
            const value = usage?.[key as keyof AttemptUsage]
            return typeof value === 'number' && Number.isFinite(value) && value > 0
          })
      const nextState: AttemptState = lateChargeEvidence || conflicts.length > 0 ? 'blocked_charged' : next
      const effectiveError = error ?? (lateChargeEvidence ? 'late_usage_after_confirmed_not_charged' : conflicts.length > 0 ? 'conflicting_usage_receipt' : undefined)
      this.db.prepare(
        `UPDATE attempts SET state = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, cost_micros = ?,
         error = COALESCE(?, error), updated_at = ? WHERE id = ?`,
      ).run(nextState, merged.inputTokens, merged.outputTokens, merged.cachedInputTokens, merged.cacheReadTokens, merged.cacheWriteTokens,
        merged.reasoningTokens, merged.costMicros, effectiveError ?? null, now, id)
      if (existing.state !== nextState) {
        this.appendControlInTransaction({ eventId: `attempt:${id}:${nextState}`, projectKey: existing.projectKey, type: `attempt_${nextState}`, attemptId: id }, now)
      }
      if (newlyKnown.length > 0) {
        this.appendControlInTransaction({ eventId: `attempt:${id}:usage-known:${newlyKnown.join(',')}:${now}`, projectKey: existing.projectKey,
          type: 'attempt_usage_reconciled', attemptId: id }, now)
      }
      for (const conflict of conflicts) {
        const inserted = this.db.prepare(
          `INSERT INTO usage_conflicts(attempt_id, field, preserved_value, conflicting_value, prior_state, observed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, conflict.field, conflict.prior, conflict.incoming, existing.state, now)
        const conflictId = Number(inserted.lastInsertRowid ?? 0)
        this.appendControlInTransaction({ eventId: `attempt:${id}:usage-conflict:${conflictId}`, projectKey: existing.projectKey,
          type: 'attempt_usage_conflict', attemptId: id }, now)
      }
      if (lateChargeEvidence && conflicts.length === 0) {
        this.appendControlInTransaction({ eventId: `attempt:${id}:late-charge-evidence:${now}`, projectKey: existing.projectKey,
          type: 'attempt_late_charge_evidence', attemptId: id }, now)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getAttempt(id)!
  }

  usageConflictsForAttempt(id: string): UsageConflictRecord[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT * FROM usage_conflicts WHERE attempt_id = ? ORDER BY id ASC').all(id) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: Number(row.id), attemptId: String(row.attempt_id), field: String(row.field) as keyof AttemptUsage,
      preservedValue: Number(row.preserved_value), conflictingValue: Number(row.conflicting_value),
      priorState: String(row.prior_state) as AttemptState, observedAt: Number(row.observed_at),
    }))
  }

  resolveUnknownAttempt(id: string, disposition: 'charged' | 'not_charged', now = Date.now()): AttemptRecord {
    const attempt = this.getAttempt(id)
    if (attempt === undefined) throw new Error(`attempt not found: ${id}`)
    if (attempt.state !== 'uncertain_remote' && attempt.state !== 'dispatching') throw new Error('only an unresolved attempt can be resolved')
    return this.settleAttempt(id, disposition === 'charged' ? 'blocked_charged' : 'confirmed_not_charged', undefined, undefined, now)
  }

  /** Atomically reserve the single active call; legacy daily limits are ignored. */
  reserveBillableCall(input: {
    id: string; projectKey: string; purpose: string; budgetClass: 'automatic' | 'manual';
    reservedTokens: number; dailyTokenLimit?: number; dailyTaskLimit?: number; now?: number;
    jobId?: string; attemptId?: string; provider?: string; model?: string; requestHash?: string;
  }): BillableCall {
    this.ensureOpen()
    const now = input.now ?? Date.now()
    const tokens = Math.max(1, Math.floor(input.reservedTokens))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const active = this.db.prepare("SELECT id, state FROM billable_calls WHERE state IN ('reserved', 'dispatching', 'uncertain') OR response_status = 'saved' LIMIT 1").get() as { id?: string; state?: string } | undefined
      if (active !== undefined) throw new Error(`global billable request gate is held by ${String(active.id)} (${String(active.state)}, response ${String(this.getBillableCall(String(active.id))?.responseStatus ?? 'none')})`)
      this.db.prepare(
        `INSERT INTO billable_calls(id, project_key, purpose, budget_class, state, reserved_tokens, job_id, attempt_id, provider, model, request_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.projectKey, input.purpose, input.budgetClass, tokens, input.jobId ?? null, input.attemptId ?? null,
        input.provider ?? null, input.model ?? null, input.requestHash ?? null, now, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBillableCall(input.id)!
  }

  markBillableCallDispatched(id: string, now = Date.now()): BillableCall {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const changed = this.db.prepare("UPDATE billable_calls SET state = 'dispatching', updated_at = ? WHERE id = ? AND state = 'reserved'").run(now, id)
      if (Number(changed.changes ?? 0) !== 1) throw new Error('billable reservation is unavailable or already dispatched')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBillableCall(id)!
  }

  recordBillableUsageObservation(input: {
    callId: string; projectKey: string; purpose: string; provider: string; model: string; requestHash: string;
    usage: Partial<AttemptUsage>; now?: number;
  }): 'recorded' | 'duplicate' | 'conflict' {
    this.ensureOpen()
    const usage = normalizedObservedUsage(input.usage)
    const usageJson = JSON.stringify(usage)
    const identity = { callId: input.callId, projectKey: input.projectKey, purpose: input.purpose,
      provider: input.provider, model: input.model, requestHash: input.requestHash }
    if (input.callId === '' || input.projectKey === '' || input.purpose === '' || input.provider === '' || input.model === '' ||
        !/^[a-f0-9]{64}$/u.test(input.requestHash)) throw new Error('observed usage receipt identity is invalid')
    const usageSha256 = createHash('sha256').update(JSON.stringify({ ...identity, usage })).digest('hex')
    const now = input.now ?? Date.now()
    let status: 'recorded' | 'duplicate' | 'conflict'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const current = this.db.prepare('SELECT * FROM billable_calls WHERE id = ?').get(input.callId) as Record<string, unknown> | undefined
      if (current === undefined || current.project_key !== input.projectKey || current.purpose !== input.purpose ||
          current.provider !== input.provider || current.model !== input.model || current.request_hash !== input.requestHash ||
          ['reserved', 'cancelled'].includes(String(current.state))) {
        throw new Error('observed usage receipt does not match a dispatched billable request identity')
      }
      const existing = this.db.prepare('SELECT * FROM billable_observed_usage WHERE call_id = ?').get(input.callId) as Record<string, unknown> | undefined
      if (existing === undefined) {
        if (['complete', 'failed_known'].includes(String(current.state))) throw new Error('settled billable request has no prior observed usage receipt')
        this.db.prepare(`INSERT INTO billable_observed_usage(call_id, project_key, purpose, provider, model, request_hash,
          usage_json, usage_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.callId, input.projectKey, input.purpose, input.provider, input.model, input.requestHash, usageJson, usageSha256, now)
        this.appendControlInTransaction({ eventId: `billable:${input.callId}:observed-usage:${usageSha256}`, projectKey: input.projectKey,
          type: 'billable_usage_observed', attemptId: typeof current.attempt_id === 'string' ? current.attempt_id : input.callId }, now)
        status = 'recorded'
      } else {
        const sameIdentity = existing.project_key === input.projectKey && existing.purpose === input.purpose && existing.provider === input.provider &&
          existing.model === input.model && existing.request_hash === input.requestHash
        if (sameIdentity && existing.usage_sha256 === usageSha256 && existing.usage_json === usageJson) {
          status = this.db.prepare('SELECT 1 AS found FROM billable_observed_usage_conflicts WHERE call_id = ? LIMIT 1').get(input.callId) === undefined
            ? 'duplicate' : 'conflict'
        } else {
          const preservedSha256 = String(existing.usage_sha256 ?? '')
          const preservedJson = String(existing.usage_json ?? '{}')
          this.db.prepare(`INSERT OR IGNORE INTO billable_observed_usage_conflicts(call_id, preserved_sha256, conflicting_sha256,
            preserved_usage_json, conflicting_usage_json, observed_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(input.callId, preservedSha256, usageSha256, preservedJson, usageJson, now)
          this.db.prepare("UPDATE billable_calls SET state = 'uncertain', local_ended = 1, updated_at = ? WHERE id = ? AND state <> 'cancelled'")
            .run(now, input.callId)
          this.appendControlInTransaction({ eventId: `billable:${input.callId}:observed-usage-conflict:${usageSha256}`, projectKey: input.projectKey,
            type: 'billable_usage_conflict', attemptId: typeof current.attempt_id === 'string' ? current.attempt_id : input.callId }, now)
          status = 'conflict'
        }
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return status
  }

  settleBillableCall(id: string, requestedState: 'complete' | 'failed_known' | 'uncertain', usage?: { inputTokens?: number | null; outputTokens?: number | null }, now = Date.now()): BillableCall {
    this.ensureOpen()
    const inputTokens = finiteTokenUsage(usage?.inputTokens)
    const outputTokens = finiteTokenUsage(usage?.outputTokens)
    const actualTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const current = this.db.prepare('SELECT * FROM billable_calls WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (current === undefined || !['reserved', 'dispatching', 'uncertain'].includes(String(current.state))) {
        throw new Error('billable reservation is missing or already settled')
      }
      const observedConflict = this.db.prepare('SELECT 1 AS found FROM billable_observed_usage_conflicts WHERE call_id = ? LIMIT 1').get(id) !== undefined
      let hasConflict = this.db.prepare('SELECT 1 AS found FROM billable_usage_conflicts WHERE call_id = ? LIMIT 1').get(id) !== undefined || observedConflict
      if (inputTokens !== null || outputTokens !== null) {
        const receipts = this.db.prepare('SELECT receipt_id, input_tokens, output_tokens FROM billable_usage_receipts WHERE call_id = ?').all(id) as Array<Record<string, unknown>>
        for (const receipt of receipts) {
          for (const [field, preserved, incoming] of [
            ['input_tokens', nullableNumber(receipt.input_tokens), inputTokens],
            ['output_tokens', nullableNumber(receipt.output_tokens), outputTokens],
          ] as const) {
            if (preserved === null || incoming === null || preserved === incoming) continue
            hasConflict = true
            this.db.prepare(`INSERT INTO billable_usage_conflicts(call_id, receipt_id, field, preserved_value, conflicting_value, observed_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(id, String(receipt.receipt_id), field, preserved, incoming, now)
          }
        }
      }
      const state = actualTokens === null || hasConflict ? 'uncertain' : requestedState
      const changed = this.db.prepare(
        `UPDATE billable_calls SET state = ?, actual_tokens = CASE WHEN ? = 1 THEN actual_tokens ELSE ? END,
         input_tokens = CASE WHEN ? = 1 THEN input_tokens ELSE COALESCE(?, input_tokens) END,
         output_tokens = CASE WHEN ? = 1 THEN output_tokens ELSE COALESCE(?, output_tokens) END, local_ended = 1, updated_at = ?
         WHERE id = ? AND state IN ('reserved', 'dispatching', 'uncertain')`,
      ).run(state, hasConflict ? 1 : 0, actualTokens, observedConflict ? 1 : 0, inputTokens, observedConflict ? 1 : 0, outputTokens, now, id)
      if (Number(changed.changes ?? 0) !== 1) throw new Error('billable reservation is missing or already settled')
      if (hasConflict) {
        this.appendControlInTransaction({ eventId: `billable:${id}:stream-receipt-conflict`, projectKey: String(current.project_key),
          type: 'billable_usage_conflict', attemptId: typeof current.attempt_id === 'string' ? current.attempt_id : id }, now)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBillableCall(id)!
  }

  registerBillableResponse(input: { callId: string; projectKey: string; purpose: string; provider: string; model: string; requestHash: string; sha256: string; now?: number }): BillableCall {
    this.ensureOpen()
    const call = this.getBillableCall(input.callId)
    if (call === undefined || call.projectKey !== input.projectKey || call.purpose !== input.purpose || call.provider !== input.provider ||
        call.model !== input.model || call.requestHash !== input.requestHash || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new Error('saved provider response does not match the persisted billable request identity')
    }
    if (call.state === 'reserved' || call.state === 'cancelled') throw new Error('response cannot attach to an undispatched or cancelled billable request')
    if (call.responseHash !== undefined && call.responseHash !== input.sha256) throw new Error('billable request already has a different saved response')
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      this.db.prepare("UPDATE billable_calls SET response_sha256 = ?, response_status = CASE WHEN response_status IN ('committed','blocked') THEN response_status ELSE 'saved' END, updated_at = ? WHERE id = ?")
        .run(input.sha256, now, input.callId)
      this.appendControlInTransaction({ eventId: `billable:${input.callId}:response-saved:${input.sha256}`, projectKey: input.projectKey,
        type: 'billable_response_saved', attemptId: call.attemptId ?? input.callId }, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBillableCall(input.callId)!
  }

  markBillableResponse(callId: string, status: 'committed' | 'blocked', reason?: string, now = Date.now()): BillableCall {
    this.ensureOpen()
    const call = this.getBillableCall(callId)
    if (call === undefined || call.responseHash === undefined || call.responseStatus === 'none') throw new Error('billable response is not available for local recovery')
    if (call.responseStatus === 'committed') return call
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const changed = this.db.prepare("UPDATE billable_calls SET response_status = ?, updated_at = ? WHERE id = ? AND response_status = 'saved'")
        .run(status, now, callId)
      if (Number(changed.changes ?? 0) !== 1) throw new Error('billable response changed before its local recovery state was recorded')
      this.appendControlInTransaction({ eventId: `billable:${callId}:response-${status}:${call.responseHash}`, projectKey: call.projectKey,
        type: status === 'committed' ? 'billable_response_committed' : 'billable_response_blocked', attemptId: call.attemptId ?? callId }, now)
      if (reason !== undefined) {
        const auditReason = reason.trim().slice(0, 500)
        if (auditReason.length < 8) throw new Error('response recovery audit reason must contain at least 8 characters')
        this.db.prepare('INSERT INTO manual_billable_reviews(call_id, disposition, reason, created_at) VALUES (?, ?, ?, ?)')
          .run(callId, 'retain_unknown', `response ${status}: ${auditReason}`, now)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBillableCall(callId)!
  }

  reconcileBillableUsage(input: {
    callId: string; receiptId: string; provider: string; model: string; requestHash: string;
    jobId?: string; attemptId?: string; inputTokens: number; outputTokens: number; evidenceRef: string; reason: string; authorized?: boolean; now?: number;
  }): BillableCall {
    this.ensureOpen()
    const receiptId = input.receiptId.trim().slice(0, 200)
    const evidenceRef = input.evidenceRef.trim().slice(0, 2000)
    const reason = input.reason.trim().slice(0, 500)
    if (receiptId === '' || evidenceRef.length < 8 || reason.length < 8) throw new Error('usage reconciliation requires a receipt id, evidence reference, and audit reason')
    for (const value of [input.inputTokens, input.outputTokens]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('provider receipt token usage must contain finite non-negative integers')
    }
    const call = this.getBillableCall(input.callId)
    if (call === undefined || call.requestHash === undefined || call.provider === undefined || call.model === undefined ||
        call.requestHash !== input.requestHash || call.provider !== input.provider || call.model !== input.model ||
        call.jobId !== input.jobId || call.attemptId !== input.attemptId || call.state === 'cancelled' || call.state === 'reserved') {
      throw new Error('provider receipt does not match the persisted call, route, request hash, job, and attempt identity')
    }
    const now = input.now ?? Date.now()
    const normalized = { callId: input.callId, receiptId, provider: input.provider, model: input.model, requestHash: input.requestHash,
      jobId: input.jobId ?? null, attemptId: input.attemptId ?? null, inputTokens: input.inputTokens, outputTokens: input.outputTokens, evidenceRef, reason }
    const receiptHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      const existingReceipt = this.db.prepare('SELECT receipt_hash FROM billable_usage_receipts WHERE call_id = ? AND receipt_id = ?')
        .get(input.callId, receiptId) as { receipt_hash?: string } | undefined
      if (existingReceipt !== undefined && existingReceipt.receipt_hash !== receiptHash) throw new Error('provider receipt id already contains different evidence')
      const current = this.db.prepare('SELECT * FROM billable_calls WHERE id = ?').get(input.callId) as Record<string, unknown> | undefined
      if (current === undefined || current.request_hash !== input.requestHash || current.provider !== input.provider || current.model !== input.model ||
          current.job_id !== (input.jobId ?? null) || current.attempt_id !== (input.attemptId ?? null) || current.state === 'cancelled' || current.state === 'reserved') {
        throw new Error('billable call identity changed before reconciliation')
      }
      const priorInput = nullableNumber(current.input_tokens)
      const priorOutput = nullableNumber(current.output_tokens)
      const observedRow = this.db.prepare('SELECT * FROM billable_observed_usage WHERE call_id = ?').get(input.callId) as Record<string, unknown> | undefined
      let observedUsage: AttemptUsage | undefined
      if (observedRow !== undefined) {
        if (observedRow.project_key !== current.project_key || observedRow.purpose !== current.purpose ||
            observedRow.provider !== current.provider || observedRow.model !== current.model || observedRow.request_hash !== current.request_hash) {
          throw new Error('stored observed usage receipt does not match the persisted billable call identity')
        }
        observedUsage = parseObservedUsage(String(observedRow.usage_json))
      }
      const conflicts: Array<{ field: 'input_tokens' | 'output_tokens'; prior: number; incoming: number }> = []
      const compareKnownUsage = (field: 'input_tokens' | 'output_tokens', prior: number | null, incoming: number): void => {
        if (prior === null || prior === incoming || conflicts.some((item) => item.field === field && item.prior === prior && item.incoming === incoming)) return
        conflicts.push({ field, prior, incoming })
      }
      const priorBillableConflict = this.db.prepare('SELECT 1 AS found FROM billable_usage_conflicts WHERE call_id = ? LIMIT 1').get(input.callId) !== undefined ||
        this.db.prepare('SELECT 1 AS found FROM billable_observed_usage_conflicts WHERE call_id = ? LIMIT 1').get(input.callId) !== undefined
      compareKnownUsage('input_tokens', priorInput, input.inputTokens)
      compareKnownUsage('output_tokens', priorOutput, input.outputTokens)
      compareKnownUsage('input_tokens', observedUsage?.inputTokens ?? null, input.inputTokens)
      compareKnownUsage('output_tokens', observedUsage?.outputTokens ?? null, input.outputTokens)
      if (existingReceipt === undefined) {
        this.db.prepare(`INSERT INTO billable_usage_receipts(call_id, receipt_id, receipt_hash, evidence_ref, reason, input_tokens, output_tokens, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.callId, receiptId, receiptHash, evidenceRef, reason, input.inputTokens, input.outputTokens, now)
      }
      if (Number(current.local_ended ?? 0) !== 1 || input.authorized !== true) {
        this.appendControlInTransaction({ eventId: `billable:${input.callId}:receipt-recorded:${receiptId}:${receiptHash}`,
          projectKey: String(current.project_key), type: 'billable_usage_receipt_recorded',
          attemptId: typeof current.attempt_id === 'string' ? current.attempt_id : input.callId }, now)
        this.db.exec('COMMIT')
        return this.getBillableCall(input.callId)!
      }
      this.appendControlInTransaction({ eventId: `billable:${input.callId}:receipt-authorized:${receiptId}:${receiptHash}`,
        projectKey: String(current.project_key), type: 'billable_usage_authorized',
        attemptId: typeof current.attempt_id === 'string' ? current.attempt_id : input.callId }, now)
      const attemptId = typeof current.attempt_id === 'string' ? current.attempt_id : undefined
      let attemptConflict = false
      if (attemptId !== undefined) {
        const attempt = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as Record<string, unknown> | undefined
        if (attempt === undefined || attempt.billable_call_id !== input.callId || attempt.request_hash !== input.requestHash ||
            attempt.provider !== input.provider || attempt.model !== input.model || attempt.job_id !== (input.jobId ?? null)) {
          throw new Error('linked provider attempt does not match the receipt identity')
        }
        for (const [field, incoming] of [['input_tokens', input.inputTokens], ['output_tokens', input.outputTokens]] as const) {
          const prior = nullableNumber(attempt[field])
          const observedPrior = field === 'input_tokens' ? observedUsage?.inputTokens ?? null : observedUsage?.outputTokens ?? null
          if (prior !== null && prior !== incoming) {
            attemptConflict = true
            this.db.prepare(`INSERT INTO usage_conflicts(attempt_id, field, preserved_value, conflicting_value, prior_state, observed_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(attemptId, field === 'input_tokens' ? 'inputTokens' : 'outputTokens', prior, incoming, String(attempt.state), now)
          }
          if (observedPrior !== null && observedPrior !== incoming) attemptConflict = true
        }
        const attemptInput = priorAttemptValue(attempt.input_tokens, observedUsage?.inputTokens ?? input.inputTokens)
        const attemptOutput = priorAttemptValue(attempt.output_tokens, observedUsage?.outputTokens ?? input.outputTokens)
        const responseSaved = current.response_status === 'saved' || current.response_status === 'committed'
        const attemptState = attemptConflict || conflicts.length > 0 || priorBillableConflict ? 'blocked_charged'
          : attempt.state === 'complete' || attempt.state === 'failed_known' ? String(attempt.state)
            : responseSaved ? 'complete' : String(attempt.state)
        this.db.prepare('UPDATE attempts SET input_tokens = ?, output_tokens = ?, state = ?, updated_at = ? WHERE id = ?')
          .run(attemptInput, attemptOutput, attemptState, now, attemptId)
        if (String(attempt.state) !== attemptState) this.appendControlInTransaction({ eventId: `attempt:${attemptId}:${attemptState}`, projectKey: call.projectKey,
          type: `attempt_${attemptState}`, attemptId }, now)
      }
      for (const conflict of conflicts) {
        const alreadyRecorded = this.db.prepare(`SELECT 1 AS found FROM billable_usage_conflicts WHERE call_id = ? AND receipt_id = ? AND
          field = ? AND preserved_value = ? AND conflicting_value = ? LIMIT 1`)
          .get(input.callId, receiptId, conflict.field, conflict.prior, conflict.incoming)
        if (alreadyRecorded !== undefined) continue
        this.db.prepare(`INSERT INTO billable_usage_conflicts(call_id, receipt_id, field, preserved_value, conflicting_value, observed_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(input.callId, receiptId, conflict.field, conflict.prior, conflict.incoming, now)
      }
      const conflict = priorBillableConflict || conflicts.length > 0 || attemptConflict
      const mergedInput = priorInput ?? observedUsage?.inputTokens ?? input.inputTokens
      const mergedOutput = priorOutput ?? observedUsage?.outputTokens ?? input.outputTokens
      const priorActual = nullableNumber(current.actual_tokens)
      const state = conflict ? 'uncertain' : 'complete'
      const actualTokens = conflict ? priorActual : input.inputTokens + input.outputTokens
      this.db.prepare('UPDATE billable_calls SET input_tokens = ?, output_tokens = ?, actual_tokens = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(mergedInput, mergedOutput, actualTokens, state, now, input.callId)
      this.appendControlInTransaction({ eventId: `billable:${input.callId}:receipt:${receiptId}:${receiptHash}`, projectKey: call.projectKey,
        type: conflict ? 'billable_usage_conflict' : 'billable_usage_reconciled', attemptId: attemptId ?? input.callId }, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.getBillableCall(input.callId)!
  }

  pendingBillableResponses(projectKey?: string): BillableCall[] {
    this.ensureOpen()
    const rows = projectKey === undefined
      ? this.db.prepare("SELECT id FROM billable_calls WHERE response_status = 'saved' ORDER BY updated_at ASC").all()
      : this.db.prepare("SELECT id FROM billable_calls WHERE project_key = ? AND response_status = 'saved' ORDER BY updated_at ASC").all(projectKey)
    return (rows as Array<{ id?: string }>).flatMap((row) => typeof row.id === 'string' ? [this.getBillableCall(row.id)!] : [])
  }

  hasBillableUsageConflict(callId: string): boolean {
    this.ensureOpen()
    return this.db.prepare(`SELECT 1 AS found FROM billable_usage_conflicts WHERE call_id = ?
      UNION ALL SELECT 1 AS found FROM billable_observed_usage_conflicts WHERE call_id = ? LIMIT 1`).get(callId, callId) !== undefined
  }

  billableUsageAudit(callId: string): { verification: 'recorded_not_independently_verified'; receipts: Array<Record<string, unknown>>;
    conflicts: Array<Record<string, unknown>>; observedUsageReceipt: BillableObservedUsageReceipt | undefined } {
    this.ensureOpen()
    const receipts = this.db.prepare(`SELECT receipt_id, evidence_ref, reason, input_tokens, output_tokens, created_at
      FROM billable_usage_receipts WHERE call_id = ? ORDER BY created_at ASC, id ASC`).all(callId) as Array<Record<string, unknown>>
    const conflicts = this.db.prepare(`SELECT receipt_id, field, preserved_value, conflicting_value, observed_at
      FROM billable_usage_conflicts WHERE call_id = ? ORDER BY observed_at ASC, id ASC`).all(callId) as Array<Record<string, unknown>>
    return {
      verification: 'recorded_not_independently_verified',
      receipts: receipts.map((row) => ({ receiptId: String(row.receipt_id), evidenceRef: String(row.evidence_ref), reason: String(row.reason),
        inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), createdAt: Number(row.created_at) })),
      conflicts: conflicts.map((row) => ({ receiptId: String(row.receipt_id), field: String(row.field), preservedValue: Number(row.preserved_value),
        conflictingValue: Number(row.conflicting_value), observedAt: Number(row.observed_at) })),
      observedUsageReceipt: this.billableObservedUsageReceipt(callId),
    }
  }

  billableObservedUsageReceipt(callId: string): BillableObservedUsageReceipt | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM billable_observed_usage WHERE call_id = ?').get(callId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const conflicts = this.db.prepare(`SELECT preserved_sha256, conflicting_sha256, preserved_usage_json, conflicting_usage_json, observed_at
      FROM billable_observed_usage_conflicts WHERE call_id = ? ORDER BY observed_at ASC, id ASC`).all(callId) as Array<Record<string, unknown>>
    return {
      verification: 'recorded_not_independently_verified', callId: String(row.call_id), projectKey: String(row.project_key),
      purpose: String(row.purpose), provider: String(row.provider), model: String(row.model), requestHash: String(row.request_hash),
      usageSha256: String(row.usage_sha256), usage: parseObservedUsage(String(row.usage_json)), recordedAt: Number(row.created_at),
      conflicts: conflicts.map((item) => ({ preservedSha256: String(item.preserved_sha256), conflictingSha256: String(item.conflicting_sha256),
        preservedUsage: parseObservedUsage(String(item.preserved_usage_json)), conflictingUsage: parseObservedUsage(String(item.conflicting_usage_json)),
        observedAt: Number(item.observed_at) })),
    }
  }

  cancelBillableReservation(id: string, now = Date.now()): void {
    this.ensureOpen()
    const changed = this.db.prepare("UPDATE billable_calls SET state = 'cancelled', actual_tokens = 0, updated_at = ? WHERE id = ? AND state = 'reserved'").run(now, id)
    if (Number(changed.changes ?? 0) !== 1) throw new Error('only a not-yet-dispatched reservation can be released')
  }

  getBillableCall(id: string): BillableCall | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM billable_calls WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      id: String(row.id), projectKey: String(row.project_key), purpose: String(row.purpose), budgetClass: String(row.budget_class) as BillableCall['budgetClass'],
      state: String(row.state) as BillableCall['state'], reservedTokens: Number(row.reserved_tokens),
      actualTokens: nullableNumber(row.actual_tokens),
      ...(typeof row.job_id === 'string' ? { jobId: row.job_id } : {}), ...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
      ...(typeof row.provider === 'string' ? { provider: row.provider } : {}), ...(typeof row.model === 'string' ? { model: row.model } : {}),
      ...(typeof row.request_hash === 'string' ? { requestHash: row.request_hash } : {}),
      ...(typeof row.response_sha256 === 'string' ? { responseHash: row.response_sha256 } : {}),
      responseStatus: row.response_status === 'saved' || row.response_status === 'committed' || row.response_status === 'blocked' ? row.response_status : 'none',
      localEnded: Number(row.local_ended ?? 0) === 1,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  billableCallSummary(now = Date.now()): { automatic: { tasks: number; tokens: number; unknown: number }; manual: { tasks: number; tokens: number; unknown: number }; active?: BillableCall } {
    this.ensureOpen()
    const startOfUtcDay = Math.floor(now / 86_400_000) * 86_400_000
    const endOfUtcDay = startOfUtcDay + 86_400_000
    const result = { automatic: { tasks: 0, tokens: 0, unknown: 0 }, manual: { tasks: 0, tokens: 0, unknown: 0 } }
    for (const budgetClass of ['automatic', 'manual'] as const) {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS tasks, COALESCE(SUM(CASE WHEN actual_tokens IS NULL THEN reserved_tokens ELSE actual_tokens END), 0) AS tokens,
         SUM(CASE WHEN state = 'uncertain' THEN 1 ELSE 0 END) AS unknown FROM billable_calls
         WHERE budget_class = ? AND created_at >= ? AND created_at < ? AND state <> 'cancelled'`,
      ).get(budgetClass, startOfUtcDay, endOfUtcDay) as { tasks?: number; tokens?: number; unknown?: number }
      result[budgetClass] = { tasks: Number(row?.tasks ?? 0), tokens: Number(row?.tokens ?? 0), unknown: Number(row?.unknown ?? 0) }
    }
    const activeRow = this.db.prepare("SELECT id FROM billable_calls WHERE state IN ('reserved', 'dispatching', 'uncertain') OR response_status = 'saved' LIMIT 1").get() as { id?: string } | undefined
    const active = activeRow?.id === undefined ? undefined : this.getBillableCall(activeRow.id)
    return { ...result, ...(active === undefined ? {} : { active }) }
  }

  /** Creates a standalone SQLite copy for the local recovery snapshot. */
  backupTo(destination: string): void {
    this.ensureOpen()
    const target = path.resolve(destination)
    mkdirSync(path.dirname(target), { recursive: true })
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) throw new Error('control snapshot destination already exists')
    const escaped = target.replace(/'/gu, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
  }

  recordManualUsageReview(input: { attemptId: string; disposition: 'charged' | 'retain_unknown'; reason: string; now?: number }): void {
    this.ensureOpen()
    const reason = input.reason.trim().slice(0, 500)
    if (reason.length < 8) throw new Error('manual usage review requires an audit reason of at least 8 characters')
    const attempt = this.getAttempt(input.attemptId)
    if (attempt === undefined || (attempt.state !== 'uncertain_remote' && attempt.state !== 'dispatching' && attempt.state !== 'blocked_charged')) {
      throw new Error('attempt is not in an auditable unknown or blocked state')
    }
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      this.db.prepare('INSERT INTO manual_usage_reviews(attempt_id, disposition, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(input.attemptId, input.disposition, reason, now)
      this.appendControlInTransaction({ eventId: `attempt:${input.attemptId}:manual-review:${now}:${input.disposition}`, projectKey: attempt.projectKey,
        type: `attempt_manual_review_${input.disposition}`, attemptId: input.attemptId }, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  manualUsageReviews(attemptId: string): Array<{ disposition: 'charged' | 'retain_unknown'; reason: string; createdAt: number }> {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT disposition, reason, created_at FROM manual_usage_reviews WHERE attempt_id = ? ORDER BY created_at ASC').all(attemptId) as Array<Record<string, unknown>>
    return rows.map((row) => ({ disposition: String(row.disposition) as 'charged' | 'retain_unknown', reason: String(row.reason), createdAt: Number(row.created_at) }))
  }

  recordBillableUsageReview(input: { callId: string; disposition: 'charged' | 'retain_unknown'; reason: string; now?: number }): void {
    this.ensureOpen()
    const reason = input.reason.trim().slice(0, 500)
    if (reason.length < 8) throw new Error('manual usage review requires an audit reason of at least 8 characters')
    const call = this.getBillableCall(input.callId)
    if (call === undefined || call.state !== 'uncertain') throw new Error('billable call is not in an unknown state')
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      this.db.prepare('INSERT INTO manual_billable_reviews(call_id, disposition, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(input.callId, input.disposition, reason, now)
      this.appendControlInTransaction({ eventId: 'billable:' + input.callId + ':manual-review:' + now + ':' + input.disposition,
        projectKey: call.projectKey, type: 'billable_manual_review_' + input.disposition, attemptId: input.callId }, now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  manualBillableReviews(callId: string): Array<{ disposition: 'charged' | 'retain_unknown'; reason: string; createdAt: number }> {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT disposition, reason, created_at FROM manual_billable_reviews WHERE call_id = ? ORDER BY created_at ASC')
      .all(callId) as Array<Record<string, unknown>>
    return rows.map((row) => ({ disposition: String(row.disposition) as 'charged' | 'retain_unknown', reason: String(row.reason), createdAt: Number(row.created_at) }))
  }

  listBillableCalls(projectKey?: string, limit = 100): Array<BillableCall & { reviews: Array<{ disposition: 'charged' | 'retain_unknown'; reason: string; createdAt: number }> }> {
    this.ensureOpen()
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
    const rows = projectKey === undefined
      ? this.db.prepare('SELECT id FROM billable_calls ORDER BY updated_at DESC LIMIT ?').all(bounded)
      : this.db.prepare('SELECT id FROM billable_calls WHERE project_key = ? ORDER BY updated_at DESC LIMIT ?').all(projectKey, bounded)
    return (rows as Array<{ id?: string }>).flatMap((row) => typeof row.id === 'string'
      ? [{ ...this.getBillableCall(row.id)!, reviews: this.manualBillableReviews(row.id) }] : [])
  }

  billableCallsForRange(projectKey: string, from: number, to: number): BillableCall[] {
    this.ensureOpen()
    const rows = this.db.prepare(
      'SELECT id FROM billable_calls WHERE project_key = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC',
    ).all(projectKey, from, to) as Array<{ id?: string }>
    return rows.flatMap((row) => typeof row.id === 'string' ? [this.getBillableCall(row.id)!] : [])
  }

  /** Primary-key keyset page for aggregate reads; projects/ranges are filtered after this bounded raw page. */
  dashboardReadBillablePage(afterId = '', limit = 16): { rows: DashboardReadUsageRow[]; hasMore: boolean } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    if (typeof afterId !== 'string' || Buffer.byteLength(afterId, 'utf8') > 256) throw new TypeError('dashboard billable cursor is invalid')
    const rows = this.db.prepare(`SELECT
        CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id, length(CAST(id AS BLOB)) AS id_bytes,
        CASE WHEN length(CAST(project_key AS BLOB)) <= 256 THEN project_key END AS project_key,
        length(CAST(project_key AS BLOB)) AS project_key_bytes, created_at,
        CASE WHEN length(CAST(state AS BLOB)) <= 64 THEN state END AS state, length(CAST(state AS BLOB)) AS state_bytes,
        CASE WHEN length(CAST(purpose AS BLOB)) <= 128 THEN purpose END AS purpose, length(CAST(purpose AS BLOB)) AS purpose_bytes,
        CASE WHEN provider IS NULL OR length(CAST(provider AS BLOB)) <= 256 THEN provider END AS provider,
        COALESCE(length(CAST(provider AS BLOB)), 0) AS provider_bytes,
        CASE WHEN model IS NULL OR length(CAST(model AS BLOB)) <= 256 THEN model END AS model,
        COALESCE(length(CAST(model AS BLOB)), 0) AS model_bytes,
        actual_tokens
      FROM billable_calls WHERE billable_calls.id > ? ORDER BY billable_calls.id ASC LIMIT ?`).all(afterId, bounded + 1) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => ({ ...(typeof row.id === 'string' ? { id: row.id } : {}), idBytes: Number(row.id_bytes),
      ...(typeof row.project_key === 'string' ? { projectKey: row.project_key } : {}), projectKeyBytes: Number(row.project_key_bytes),
      createdAt: Number(row.created_at), ...(typeof row.state === 'string' ? { state: row.state } : {}), stateBytes: Number(row.state_bytes),
      ...(typeof row.purpose === 'string' ? { label: row.purpose } : {}), labelBytes: Number(row.purpose_bytes),
      ...(typeof row.provider === 'string' ? { provider: row.provider } : {}), providerBytes: Number(row.provider_bytes),
      ...(typeof row.model === 'string' ? { model: row.model } : {}), modelBytes: Number(row.model_bytes),
      ...(row.actual_tokens === null ? { actualTokens: null } : { actualTokens: Number(row.actual_tokens) }),
    })), hasMore: rows.length > bounded }
  }

  getAttempt(id: string): AttemptRecord | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toAttempt(row)
  }

  attemptsForJob(projectKey: string, jobId: string): AttemptRecord[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT * FROM attempts WHERE project_key = ? AND job_id = ? ORDER BY created_at ASC').all(projectKey, jobId) as Record<string, unknown>[]
    return rows.map(toAttempt)
  }

  /** Bounded, durable source-dispatch history used to prevent recovery from re-queuing paid input. */
  attemptSourceHistory(projectKey: string, maxRows = 100_000): {
    attempts: Array<{ id: string; jobId: string; sourceDigest: string; sourceIds: string[]; state: AttemptState }>
    complete: boolean
    truncated: boolean
  } {
    this.ensureOpen()
    const bounded = Math.max(1, Math.min(200_000, Math.floor(maxRows)))
    const rows = this.db.prepare(`SELECT id, job_id, source_digest, source_ids, state FROM attempts
      WHERE project_key = ? AND state <> 'confirmed_not_charged' ORDER BY created_at ASC, id ASC LIMIT ?`).all(projectKey, bounded + 1) as Array<Record<string, unknown>>
    const truncated = rows.length > bounded
    let complete = !truncated
    const attempts = rows.slice(0, bounded).map((row) => {
      let sourceIds: string[] = []
      try {
        const parsed = JSON.parse(String(row.source_ids ?? '[]')) as unknown
        if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) sourceIds = [...new Set(parsed)]
        else complete = false
      } catch { complete = false }
      if (sourceIds.length === 0) complete = false
      return { id: String(row.id), jobId: String(row.job_id), sourceDigest: String(row.source_digest), sourceIds,
        state: String(row.state) as AttemptState }
    })
    return { attempts, complete, truncated }
  }

  attemptsForRange(projectKey: string, from: number, to: number): AttemptRecord[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT * FROM attempts WHERE project_key = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC')
      .all(projectKey, from, to) as Array<Record<string, unknown>>
    return rows.map(toAttempt)
  }

  /** Primary-key keyset page for attempt usage; caller counts only selected projects and range. */
  dashboardReadAttemptPage(afterId = '', limit = 16): { rows: DashboardReadUsageRow[]; hasMore: boolean } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    if (typeof afterId !== 'string' || Buffer.byteLength(afterId, 'utf8') > 256) throw new TypeError('dashboard attempt cursor is invalid')
    const rows = this.db.prepare(`SELECT
        CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id, length(CAST(id AS BLOB)) AS id_bytes,
        CASE WHEN length(CAST(project_key AS BLOB)) <= 256 THEN project_key END AS project_key,
        length(CAST(project_key AS BLOB)) AS project_key_bytes, created_at,
        CASE WHEN length(CAST(state AS BLOB)) <= 64 THEN state END AS state, length(CAST(state AS BLOB)) AS state_bytes,
        CASE WHEN length(CAST(provider AS BLOB)) <= 256 THEN provider END AS provider, length(CAST(provider AS BLOB)) AS provider_bytes,
        CASE WHEN length(CAST(model AS BLOB)) <= 256 THEN model END AS model, length(CAST(model AS BLOB)) AS model_bytes,
        input_tokens, output_tokens, cached_input_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_micros
      FROM attempts WHERE attempts.id > ? ORDER BY attempts.id ASC LIMIT ?`).all(afterId, bounded + 1) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => ({ ...(typeof row.id === 'string' ? { id: row.id } : {}), idBytes: Number(row.id_bytes),
      ...(typeof row.project_key === 'string' ? { projectKey: row.project_key } : {}), projectKeyBytes: Number(row.project_key_bytes),
      createdAt: Number(row.created_at), ...(typeof row.state === 'string' ? { state: row.state } : {}), stateBytes: Number(row.state_bytes),
      labelBytes: 0, ...(typeof row.provider === 'string' ? { provider: row.provider } : {}), providerBytes: Number(row.provider_bytes),
      ...(typeof row.model === 'string' ? { model: row.model } : {}), modelBytes: Number(row.model_bytes),
      ...(row.input_tokens === null ? { inputTokens: null } : { inputTokens: Number(row.input_tokens) }),
      ...(row.output_tokens === null ? { outputTokens: null } : { outputTokens: Number(row.output_tokens) }),
      ...(row.cached_input_tokens === null ? { cachedInputTokens: null } : { cachedInputTokens: Number(row.cached_input_tokens) }),
      ...(row.cache_read_tokens === null ? { cacheReadTokens: null } : { cacheReadTokens: Number(row.cache_read_tokens) }),
      ...(row.cache_write_tokens === null ? { cacheWriteTokens: null } : { cacheWriteTokens: Number(row.cache_write_tokens) }),
      ...(row.reasoning_tokens === null ? { reasoningTokens: null } : { reasoningTokens: Number(row.reasoning_tokens) }),
      ...(row.cost_micros === null ? { costMicros: null } : { costMicros: Number(row.cost_micros) }),
    })), hasMore: rows.length > bounded }
  }

  /** Bounded primary-key scan for coverage intervals used by the versioned dashboard. */
  dashboardReadCoveragePage(afterId = 0, limit = 16): { rows: DashboardReadCoverageRow[]; hasMore: boolean } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new TypeError('dashboard coverage cursor is invalid')
    const rows = this.db.prepare(`SELECT id, started_at, ended_at,
        CASE WHEN status IN ('active','closed','interrupted') THEN status END AS status,
        length(CAST(status AS BLOB)) AS status_bytes,
        CASE WHEN length(CAST(policy_revision AS BLOB)) <= 128 THEN policy_revision END AS policy_revision,
        length(CAST(policy_revision AS BLOB)) AS policy_revision_bytes
      FROM capture_windows WHERE id > ? ORDER BY id ASC LIMIT ?`).all(afterId, bounded + 1) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => ({
      id: Number(row.id), startedAt: Number(row.started_at), endedAt: row.ended_at === null ? null : Number(row.ended_at),
      ...(typeof row.status === 'string' ? { status: row.status } : {}), statusBytes: Number(row.status_bytes),
      ...(typeof row.policy_revision === 'string' ? { policyRevision: row.policy_revision } : {}),
      policyRevisionBytes: Number(row.policy_revision_bytes),
    })), hasMore: rows.length > bounded }
  }

  overviewAttemptUsage(projectKey: string, from: number, to: number): {
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    reasoningTokens: number | null
    costMicros: number | null
    knownAttempts: number
    unknownAttempts: number
    byModel: Array<{ provider: string; model: string; calls: number; inputTokens: number | null; outputTokens: number | null; unknownCalls: number; other?: boolean }>
  } {
    this.ensureOpen()
    const normalizedAttempts = `SELECT provider, model, state,
        ${sqlFiniteNumber('input_tokens')} AS input_value, ${sqlFiniteNumber('output_tokens')} AS output_value,
        COALESCE(${sqlFiniteNumber('cache_read_tokens')}, ${sqlFiniteNumber('cached_input_tokens')}) AS cache_read_value,
        ${sqlFiniteNumber('cache_write_tokens')} AS cache_write_value, ${sqlFiniteNumber('reasoning_tokens')} AS reasoning_value,
        ${sqlFiniteNumber('cost_micros')} AS cost_value
      FROM attempts WHERE project_key = ? AND created_at >= ? AND created_at < ?`
    const totals = this.db.prepare(`WITH normalized AS (${normalizedAttempts}) SELECT COUNT(*) AS calls,
      SUM(CASE WHEN input_value IS NULL THEN 1 ELSE 0 END) AS input_unknown, COALESCE(SUM(input_value), 0) AS input_sum,
      SUM(CASE WHEN output_value IS NULL THEN 1 ELSE 0 END) AS output_unknown, COALESCE(SUM(output_value), 0) AS output_sum,
      SUM(CASE WHEN cache_read_value IS NULL THEN 1 ELSE 0 END) AS cache_read_unknown, COALESCE(SUM(cache_read_value), 0) AS cache_read_sum,
      SUM(CASE WHEN cache_write_value IS NULL THEN 1 ELSE 0 END) AS cache_write_unknown, COALESCE(SUM(cache_write_value), 0) AS cache_write_sum,
      SUM(CASE WHEN reasoning_value IS NULL THEN 1 ELSE 0 END) AS reasoning_unknown, COALESCE(SUM(reasoning_value), 0) AS reasoning_sum,
      SUM(CASE WHEN cost_value IS NULL THEN 1 ELSE 0 END) AS cost_unknown, COALESCE(SUM(cost_value), 0) AS cost_sum,
      SUM(CASE WHEN state IN ('dispatching', 'uncertain_remote', 'blocked_charged') OR input_value IS NULL OR output_value IS NULL OR
        cache_read_value IS NULL OR cache_write_value IS NULL OR reasoning_value IS NULL OR cost_value IS NULL THEN 1 ELSE 0 END) AS unknown_calls
      FROM normalized`).get(projectKey, from, to) as Record<string, unknown>
    const nullableSum = (field: string): number | null => Number(totals[`${field}_unknown`] ?? 0) > 0 ? null : Number(totals[`${field}_sum`] ?? 0)
    const ranked = `WITH normalized AS (${normalizedAttempts}), grouped AS (
      SELECT provider, model, COUNT(*) AS calls,
        SUM(CASE WHEN input_value IS NULL THEN 1 ELSE 0 END) AS input_unknown, COALESCE(SUM(input_value), 0) AS input_sum,
        SUM(CASE WHEN output_value IS NULL THEN 1 ELSE 0 END) AS output_unknown, COALESCE(SUM(output_value), 0) AS output_sum,
        SUM(CASE WHEN state IN ('dispatching', 'uncertain_remote', 'blocked_charged') OR input_value IS NULL OR output_value IS NULL OR
          cache_read_value IS NULL OR cache_write_value IS NULL OR reasoning_value IS NULL OR cost_value IS NULL THEN 1 ELSE 0 END) AS unknown_calls
      FROM normalized GROUP BY provider, model
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY calls DESC, provider ASC, model ASC) AS position FROM grouped
    )`
    type ModelAggregate = { provider?: string; model?: string; calls?: number; input_unknown?: number; input_sum?: number; output_unknown?: number; output_sum?: number; unknown_calls?: number }
    const models = this.db.prepare(`${ranked} SELECT provider, model, calls, input_unknown, input_sum, output_unknown, output_sum, unknown_calls
      FROM ranked WHERE position <= 99 ORDER BY position`).all(projectKey, from, to) as ModelAggregate[]
    const remainder = this.db.prepare(`${ranked} SELECT COALESCE(SUM(calls), 0) AS calls,
      COALESCE(SUM(input_unknown), 0) AS input_unknown, COALESCE(SUM(input_sum), 0) AS input_sum,
      COALESCE(SUM(output_unknown), 0) AS output_unknown, COALESCE(SUM(output_sum), 0) AS output_sum,
      COALESCE(SUM(unknown_calls), 0) AS unknown_calls FROM ranked WHERE position > 99`)
    .get(projectKey, from, to) as ModelAggregate
    const byModel: Array<{ provider: string; model: string; calls: number; inputTokens: number | null; outputTokens: number | null; unknownCalls: number; other?: boolean }> = models.flatMap((row) => typeof row.provider === 'string' && typeof row.model === 'string' ? [{
      provider: row.provider, model: row.model, calls: Number(row.calls ?? 0),
      inputTokens: Number(row.input_unknown ?? 0) > 0 ? null : Number(row.input_sum ?? 0),
      outputTokens: Number(row.output_unknown ?? 0) > 0 ? null : Number(row.output_sum ?? 0), unknownCalls: Number(row.unknown_calls ?? 0),
    }] : [])
    if (Number(remainder.calls ?? 0) > 0) byModel.push({ provider: '', model: '', calls: Number(remainder.calls),
      inputTokens: Number(remainder.input_unknown ?? 0) > 0 ? null : Number(remainder.input_sum ?? 0),
      outputTokens: Number(remainder.output_unknown ?? 0) > 0 ? null : Number(remainder.output_sum ?? 0),
      unknownCalls: Number(remainder.unknown_calls ?? 0), other: true })
    const calls = Number(totals.calls ?? 0)
    const unknownAttempts = Number(totals.unknown_calls ?? 0)
    return { inputTokens: nullableSum('input'), outputTokens: nullableSum('output'), cacheReadTokens: nullableSum('cache_read'),
      cacheWriteTokens: nullableSum('cache_write'), reasoningTokens: nullableSum('reasoning'), costMicros: nullableSum('cost'),
      knownAttempts: calls - unknownAttempts, unknownAttempts, byModel }
  }

  overviewBillableUsage(projectKey: string, from: number, to: number): {
    byPurpose: Array<{ purpose: string; calls: number; tokens: number | null; unknownCalls: number; other?: boolean }>
  } {
    this.ensureOpen()
    const normalizedCalls = `SELECT purpose, ${sqlFiniteNumber('actual_tokens')} AS actual_value
      FROM billable_calls WHERE project_key = ? AND created_at >= ? AND created_at < ? AND state <> 'cancelled'`
    const ranked = `WITH normalized AS (${normalizedCalls}), grouped AS (
      SELECT purpose, COUNT(*) AS calls,
        SUM(CASE WHEN actual_value IS NULL THEN 1 ELSE 0 END) AS tokens_unknown, COALESCE(SUM(actual_value), 0) AS tokens_sum,
        SUM(CASE WHEN actual_value IS NULL THEN 1 ELSE 0 END) AS unknown_calls
      FROM normalized GROUP BY purpose
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY calls DESC, purpose ASC) AS position FROM grouped
    )`
    type PurposeAggregate = { purpose?: string; calls?: number; tokens_unknown?: number; tokens_sum?: number; unknown_calls?: number }
    const purposes = this.db.prepare(`${ranked} SELECT purpose, calls, tokens_unknown, tokens_sum, unknown_calls
      FROM ranked WHERE position <= 99 ORDER BY position`).all(projectKey, from, to) as PurposeAggregate[]
    const remainder = this.db.prepare(`${ranked} SELECT COALESCE(SUM(calls), 0) AS calls,
      COALESCE(SUM(tokens_unknown), 0) AS tokens_unknown, COALESCE(SUM(tokens_sum), 0) AS tokens_sum,
      COALESCE(SUM(unknown_calls), 0) AS unknown_calls FROM ranked WHERE position > 99`)
      .get(projectKey, from, to) as PurposeAggregate
    const byPurpose: Array<{ purpose: string; calls: number; tokens: number | null; unknownCalls: number; other?: boolean }> = purposes.flatMap((row) => typeof row.purpose === 'string' ? [{ purpose: row.purpose, calls: Number(row.calls ?? 0),
      tokens: Number(row.tokens_unknown ?? 0) > 0 ? null : Number(row.tokens_sum ?? 0), unknownCalls: Number(row.unknown_calls ?? 0) }] : [])
    if (Number(remainder.calls ?? 0) > 0) byPurpose.push({ purpose: '', calls: Number(remainder.calls),
      tokens: Number(remainder.tokens_unknown ?? 0) > 0 ? null : Number(remainder.tokens_sum ?? 0),
      unknownCalls: Number(remainder.unknown_calls ?? 0), other: true })
    return { byPurpose }
  }

  listAttempts(projectKey?: string, limit = 200): AttemptRecord[] {
    this.ensureOpen()
    const rows = projectKey === undefined
      ? this.db.prepare('SELECT * FROM attempts ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(1000, limit)))
      : this.db.prepare('SELECT * FROM attempts WHERE project_key = ? ORDER BY updated_at DESC LIMIT ?').all(projectKey, Math.max(1, Math.min(1000, limit)))
    return (rows as Record<string, unknown>[]).map(toAttempt)
  }

  startCoverage(policyRevision: string, now = Date.now()): number {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      this.db.prepare("UPDATE capture_windows SET ended_at = ?, status = 'interrupted' WHERE status = 'active'").run(now)
      const result = this.db.prepare("INSERT INTO capture_windows(started_at, status, policy_revision) VALUES (?, 'active', ?)").run(now, policyRevision)
      this.db.exec('COMMIT')
      return Number(result.lastInsertRowid ?? 0)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  stopCoverage(id: number, now = Date.now()): void {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertWriterEpoch()
      this.db.prepare("UPDATE capture_windows SET ended_at = ?, status = 'closed' WHERE id = ? AND status = 'active'").run(now, id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  coverageWindows(from: number, to: number): CoverageWindow[] {
    this.ensureOpen()
    const rows = this.db.prepare(
      `SELECT * FROM capture_windows WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at ASC`,
    ).all(to, from) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: Number(row.id), startedAt: Number(row.started_at), endedAt: nullableNumber(row.ended_at),
      status: String(row.status) as CoverageWindow['status'], policyRevision: String(row.policy_revision),
    }))
  }

  coverageWindowsPage(input: { limit?: number; beforeId?: number } = {}): { windows: CoverageWindow[]; nextBeforeId?: number } {
    this.ensureOpen()
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)))
    const rows = this.db.prepare(`SELECT * FROM capture_windows ${input.beforeId === undefined ? '' : 'WHERE id < ?'}
      ORDER BY id DESC LIMIT ?`).all(...(input.beforeId === undefined ? [] : [input.beforeId]), limit + 1) as Array<Record<string, unknown>>
    const windows = rows.slice(0, limit).map((row): CoverageWindow => ({
      id: Number(row.id), startedAt: Number(row.started_at), endedAt: nullableNumber(row.ended_at),
      status: String(row.status) as CoverageWindow['status'], policyRevision: String(row.policy_revision),
    }))
    const last = windows.at(-1)
    return { windows, ...(rows.length > limit && last !== undefined ? { nextBeforeId: last.id } : {}) }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('control ledger is closed')
  }

  isCurrentWriter(): boolean {
    this.ensureOpen()
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'writer_epoch'").get() as { value?: string }
    return Number(row?.value ?? 0) === this.writerEpoch
  }

  /** One read-only main-schema probe for bounded dashboard invalidation. */
  dashboardReadSchemaVersion(): number {
    this.ensureOpen()
    const row = this.db.prepare('PRAGMA main.schema_version').get() as { schema_version?: unknown } | undefined
    const version = row?.schema_version
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      throw new Error('unsafe control schema version')
    }
    return version
  }

  /** Constant-size same-connection probe, including the observed ledger writer epoch. */
  dashboardReadVersion(): DashboardReadVersionStamp {
    this.ensureOpen()
    const dataVersionRow = this.db.prepare('PRAGMA data_version').get() as Record<string, unknown> | undefined
    const stateRow = this.db.prepare("SELECT total_changes() AS total_changes, value AS writer_epoch FROM meta WHERE key = 'writer_epoch'").get() as Record<string, unknown> | undefined
    const dataVersion = dataVersionRow?.data_version
    const totalChanges = stateRow?.total_changes
    const writerEpochText = stateRow?.writer_epoch
    const observedWriterEpoch = typeof writerEpochText === 'string' && /^[1-9][0-9]*$/u.test(writerEpochText)
      ? Number(writerEpochText) : Number.NaN
    if (typeof dataVersion !== 'number' || !Number.isSafeInteger(dataVersion) || dataVersion < 0 ||
        typeof totalChanges !== 'number' || !Number.isSafeInteger(totalChanges) || totalChanges < 0 ||
        !Number.isSafeInteger(this.writerEpoch) || this.writerEpoch < 1 ||
        !Number.isSafeInteger(observedWriterEpoch) || observedWriterEpoch < 1) {
      throw new Error('control dashboard read version probe returned an unsafe SQLite counter')
    }
    return Object.freeze({ scope: 'control', connectionId: this.dashboardConnectionIdentity, dataVersion, totalChanges,
      writerEpoch: this.writerEpoch, observedWriterEpoch })
  }

  private assertWriterEpoch(): void {
    if (!this.isCurrentWriter()) throw new Error('stale writer epoch; control mutation is blocked')
  }

  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }
}
