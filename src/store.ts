/**
 * Local SQLite store for L0 conversation rows and L1 memories.
 *
 * Storage is one database per project. `node:sqlite` is the only required
 * native capability; FTS5 is used when the Host Node build provides it, and a
 * LIKE fallback keeps search functional otherwise. Chinese content is
 * pre-tokenized with `@node-rs/jieba` before it enters FTS5, because the
 * unicode61 tokenizer does not split CJK text.
 *
 * @module dsh-memory-tdai/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

export type MemoryStatus = 'candidate' | 'approved' | 'forgotten'

export interface MemoryRecord {
  id: string
  content: string
  kind: string
  scene?: string
  confidence: number
  status: MemoryStatus
  source: string
  sourceMessageIds: string[]
  createdAt: number
  updatedAt: number
  approvedAt?: number
  forgottenAt?: number
}

export interface SearchHit extends MemoryRecord {
  score: number
}

export interface AddMemoryInput {
  content: string
  kind?: string
  scene?: string
  confidence?: number
  status?: MemoryStatus
  source?: string
  sourceMessageIds?: string[]
}

export interface L0MessageInput {
  sessionId: string
  role: string
  content: string
  turn?: number
  step?: number
  createdAt?: number
}

export interface StoreStats {
  l0Messages: number
  sessions: number
  repeatedQuestions: number
  candidates: number
  approved: number
  forgotten: number
  ftsAvailable: boolean
  schemaVersion: number
}

export interface ActivityDay {
  date: string
  captures: number
  memories: number
  recalls: number
}

export interface SceneRecord {
  name: string
  summary: string
  memoryCount: number
  updatedAt: number
}

export interface PersonaRecord {
  content: string
  sourceCount: number
  updatedAt: number
}

export interface DashboardStats {
  l0Messages: number
  sessions: number
  repeatedQuestions: number
  candidates: number
  approved: number
  forgotten: number
  injectedCount: number
  injectedTokens: number
  rawTokens: number
  savedTokens: number
  sources: Array<{ source: string; count: number }>
  activity: ActivityDay[]
  longestSession: { sessionId: string; messages: number } | null
  recent: MemoryRecord[]
  candidatesList: MemoryRecord[]
  scenes: SceneRecord[]
  persona: PersonaRecord | null
  project: { key: string; name: string; cwd: string }
}

let jiebaRuntime: { cut(text: string, hmm?: boolean): string[] } | undefined
let jiebaTried = false

function loadJieba(): { cut(text: string, hmm?: boolean): string[] } | undefined {
  if (jiebaTried) return jiebaRuntime
  jiebaTried = true
  try {
    const mod = require('@node-rs/jieba') as { Jieba?: { withDict(dict: unknown): { cut(text: string, hmm?: boolean): string[] } } }
    const dict = require('@node-rs/jieba/dict') as { dict?: unknown }
    if (mod.Jieba && dict.dict) {
      jiebaRuntime = mod.Jieba.withDict(dict.dict)
    }
  } catch {
    jiebaRuntime = undefined
  }
  return jiebaRuntime
}

function fallbackTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? []
}

/** Tokenize text for indexing and query building. */
export function tokenize(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return []
  const runtime = loadJieba()
  const raw = runtime ? runtime.cut(normalized, false) : fallbackTokens(normalized)
  return raw
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '' && /[\p{L}\p{N}]/u.test(token))
}

export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function memoryId(): string {
  return `mem_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function ftsQuery(text: string): string | undefined {
  const tokens = tokenize(text)
  if (tokens.length === 0) return undefined
  return [...new Set(tokens)].slice(0, 24).map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

function toRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    content: String(row.content),
    kind: String(row.kind ?? 'fact'),
    scene: row.scene === null || row.scene === undefined ? undefined : String(row.scene),
    confidence: Number(row.confidence ?? 0.5),
    status: String(row.status) as MemoryStatus,
    source: String(row.source ?? 'unknown'),
    sourceMessageIds: parseIds(row.source_message_ids),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? undefined : Number(row.approved_at),
    forgottenAt: row.forgotten_at === null || row.forgotten_at === undefined ? undefined : Number(row.forgotten_at),
  }
}

function parseIds(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export class MemoryStore {
  readonly file: string
  private readonly db: SqliteDb
  private ftsAvailable = false
  private closed = false

  constructor(file: string) {
    this.file = path.resolve(file)
    mkdirSync(path.dirname(this.file), { recursive: true })
    const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDb }
    this.db = new sqlite.DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS l0_messages (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        turn INTEGER,
        step INTEGER,
        created_at INTEGER NOT NULL,
        extracted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS l0_session_idx ON l0_messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS l0_project_idx ON l0_messages(project_key, created_at);
      CREATE TABLE IF NOT EXISTS l1_memories (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        content TEXT NOT NULL,
        content_norm TEXT NOT NULL,
        kind TEXT NOT NULL,
        scene TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        source_message_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        approved_at INTEGER,
        forgotten_at INTEGER,
        UNIQUE(project_key, content_norm)
      );
      CREATE INDEX IF NOT EXISTS l1_status_idx ON l1_memories(project_key, status, updated_at);
      CREATE INDEX IF NOT EXISTS l1_kind_idx ON l1_memories(project_key, kind);
      CREATE TABLE IF NOT EXISTS project_meta (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL,
        type TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        raw_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_events_idx ON memory_events(type, created_at);
      CREATE TABLE IF NOT EXISTS l2_scenes (
        project_key TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        memory_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_key, name)
      );
      CREATE TABLE IF NOT EXISTS l3_persona (
        project_key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(content, record_id UNINDEXED, tokenize='unicode61')`)
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false
    }
    const columns = this.db.prepare('PRAGMA table_info(l0_messages)').all() as unknown as Array<{ name?: string }>
    if (!columns.some((column) => column.name === 'extracted_at')) {
      this.db.exec('ALTER TABLE l0_messages ADD COLUMN extracted_at INTEGER')
    }
    // The index references extracted_at, so it must be created after the v1
    // table has been upgraded with that column.
    this.db.exec('CREATE INDEX IF NOT EXISTS l0_extract_idx ON l0_messages(session_id, extracted_at, created_at)')
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '2')
  }

  get hasFts(): boolean {
    return this.ftsAvailable
  }

  recordL0(input: L0MessageInput): string {
    this.ensureOpen()
    const content = input.content.replace(/\s+/g, ' ').trim()
    if (content === '') throw new Error('L0 content is empty')
    const createdAt = input.createdAt ?? Date.now()
    const id = `l0_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    this.db
      .prepare(
        'INSERT OR IGNORE INTO l0_messages(id, project_key, session_id, role, content, turn, step, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        projectKeyOfFile(this.file),
        input.sessionId,
        input.role,
        content,
        input.turn ?? null,
        input.step ?? null,
        createdAt,
      )
    return id
  }

  /** L0 rows that have not been consumed by a successful extraction pass. */
  unextracted(sessionId: string, limit = 24): Array<{ id: string; role: string; content: string; createdAt: number }> {
    this.ensureOpen()
    const rows = this.db
      .prepare(
        `SELECT id, role, content, created_at FROM l0_messages
         WHERE session_id = ? AND extracted_at IS NULL ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, Math.max(1, Math.min(100, limit))) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      role: String(row.role),
      content: String(row.content),
      createdAt: Number(row.created_at ?? 0),
    }))
  }

  /** Mark consumed L0 rows after a successful (possibly empty) extraction. */
  markExtracted(ids: string[], now = Date.now()): number {
    this.ensureOpen()
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const result = this.db
      .prepare(`UPDATE l0_messages SET extracted_at = ? WHERE extracted_at IS NULL AND id IN (${placeholders})`)
      .run(now, ...ids)
    return Number(result.changes ?? 0)
  }

  addMemory(input: AddMemoryInput): { record: MemoryRecord; created: boolean } {
    this.ensureOpen()
    const content = normalizeMemoryText(input.content)
    if (content === '') throw new Error('memory content is empty')
    const norm = createHash('sha256').update(content).digest('hex').slice(0, 40)
    const projectKey = projectKeyOfFile(this.file)
    const now = Date.now()
    const existing = this.db
      .prepare('SELECT * FROM l1_memories WHERE project_key = ? AND content_norm = ?')
      .get(projectKey, norm) as Record<string, unknown> | undefined
    if (existing) {
      const record = toRecord(existing)
      // A forgotten memory must not be revived by a repeated extraction.
      return { record, created: false }
    }
    const id = memoryId()
    const status = input.status ?? 'candidate'
    const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.5))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO l1_memories(id, project_key, content, content_norm, kind, scene, confidence, status, source, source_message_ids, created_at, updated_at, approved_at, forgotten_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectKey,
          content,
          norm,
          input.kind ?? 'fact',
          input.scene ?? null,
          confidence,
          status,
          input.source ?? 'manual',
          JSON.stringify(input.sourceMessageIds ?? []),
          now,
          now,
          status === 'approved' ? now : null,
          status === 'forgotten' ? now : null,
        )
      if (this.ftsAvailable) {
        this.db
          .prepare('INSERT INTO l1_fts(content, record_id) VALUES (?, ?)')
          .run(tokenize(content).join(' '), id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { record: this.get(id)!, created: true }
  }

  approve(id: string): MemoryRecord | undefined {
    return this.setStatus(id, 'approved')
  }

  forget(id: string): MemoryRecord | undefined {
    return this.setStatus(id, 'forgotten')
  }

  private setStatus(id: string, status: MemoryStatus): MemoryRecord | undefined {
    this.ensureOpen()
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE l1_memories SET status = ?, updated_at = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
         forgotten_at = CASE WHEN ? = 'forgotten' THEN ? ELSE forgotten_at END WHERE id = ?`,
      )
      .run(status, now, status, now, status, now, id)
    return this.get(id)
  }

  get(id: string): MemoryRecord | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM l1_memories WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toRecord(row) : undefined
  }

  list(status: MemoryStatus, limit = 50): MemoryRecord[] {
    this.ensureOpen()
    const rows = this.db
      .prepare('SELECT * FROM l1_memories WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
      .all(status, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[]
    return rows.map(toRecord)
  }

  allRecords(limit = 5000): MemoryRecord[] {
    this.ensureOpen()
    const rows = this.db
      .prepare('SELECT * FROM l1_memories ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(20_000, limit))) as unknown as Record<string, unknown>[]
    return rows.map(toRecord)
  }

  /** Rebuild the deterministic L2 scene index from approved L1 memories. */
  refreshScenes(now = Date.now()): SceneRecord[] {
    this.ensureOpen()
    const groups = new Map<string, MemoryRecord[]>()
    for (const record of this.list('approved', 5000)) {
      const name = record.scene?.trim() || 'general'
      const list = groups.get(name) ?? []
      list.push(record)
      groups.set(name, list)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM l2_scenes WHERE project_key = ?').run(projectKeyOfFile(this.file))
      for (const [name, records] of groups) {
        const summary = records.map((record) => record.content).join(' / ').slice(0, 320)
        this.db
          .prepare('INSERT INTO l2_scenes(project_key, name, summary, memory_count, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(projectKeyOfFile(this.file), name, summary, records.length, now)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.scenes()
  }

  scenes(): SceneRecord[] {
    this.ensureOpen()
    const rows = this.db
      .prepare('SELECT name, summary, memory_count, updated_at FROM l2_scenes WHERE project_key = ? ORDER BY memory_count DESC, name ASC')
      .all(projectKeyOfFile(this.file)) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      name: String(row.name),
      summary: String(row.summary ?? ''),
      memoryCount: Number(row.memory_count ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }))
  }

  persona(): PersonaRecord | null {
    this.ensureOpen()
    const row = this.db.prepare('SELECT content, source_count, updated_at FROM l3_persona WHERE project_key = ?').get(projectKeyOfFile(this.file)) as
      | Record<string, unknown>
      | undefined
    if (row === undefined) return null
    return { content: String(row.content ?? ''), sourceCount: Number(row.source_count ?? 0), updatedAt: Number(row.updated_at ?? 0) }
  }

  setPersona(content: string, sourceCount: number, now = Date.now()): PersonaRecord {
    this.ensureOpen()
    const normalized = content.replace(/\r\n/g, '\n').trim()
    if (normalized === '') throw new Error('persona content is empty')
    this.db
      .prepare(
        `INSERT INTO l3_persona(project_key, content, source_count, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_key) DO UPDATE SET content = excluded.content, source_count = excluded.source_count, updated_at = excluded.updated_at`,
      )
      .run(projectKeyOfFile(this.file), normalized, sourceCount, now)
    return { content: normalized, sourceCount, updatedAt: now }
  }

  search(query: string, limit = 5): SearchHit[] {
    this.ensureOpen()
    const allowed = Math.max(1, Math.min(50, limit))
    const match = ftsQuery(query)
    if (match && this.ftsAvailable) {
      try {
        const rows = this.db
          .prepare(
            `SELECT m.*, bm25(l1_fts) AS rank FROM l1_fts JOIN l1_memories m ON m.id = l1_fts.record_id
             WHERE l1_fts MATCH ? AND m.status = 'approved' ORDER BY rank LIMIT ?`,
          )
          .all(match, allowed) as Record<string, unknown>[]
        if (rows.length > 0) return rows.map((row) => ({ ...toRecord(row), score: normalizeRank(row.rank) }))
      } catch {
        // Fall through to LIKE; a malformed FTS query must not break recall.
      }
    }
    return this.searchLike(query, allowed)
  }

  private searchLike(query: string, limit: number): SearchHit[] {
    const tokens = tokenize(query).filter((token) => token.length > 1).slice(0, 6)
    if (tokens.length === 0) {
      const needle = query.trim()
      if (needle === '') return []
      const rows = this.db
        .prepare(`SELECT * FROM l1_memories WHERE status = 'approved' AND content LIKE ? ORDER BY updated_at DESC LIMIT ?`)
        .all(`%${needle}%`, limit) as unknown as Record<string, unknown>[]
      return rows.map((row) => ({ ...toRecord(row), score: 0.1 }))
    }
    const clauses = tokens.map(() => 'content LIKE ?').join(' OR ')
    const rows = this.db
      .prepare(`SELECT * FROM l1_memories WHERE status = 'approved' AND (${clauses}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...tokens.map((token) => `%${token}%`), limit) as unknown as Record<string, unknown>[]
    return rows.map((row) => ({ ...toRecord(row), score: 0.1 }))
  }

  stats(): StoreStats {
    this.ensureOpen()
    const count = (status: MemoryStatus): number => {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM l1_memories WHERE status = ?').get(status) as { n?: number }
      return Number(row?.n ?? 0)
    }
    const l0 = this.db.prepare('SELECT COUNT(*) AS n FROM l0_messages').get() as { n?: number }
    const sessions = this.db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM l0_messages').get() as { n?: number }
    const repeated = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT lower(trim(content)) AS c FROM l0_messages WHERE role = 'user' GROUP BY c HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n?: number }
    const version = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
    return {
      l0Messages: Number(l0?.n ?? 0),
      sessions: Number(sessions?.n ?? 0),
      repeatedQuestions: Number(repeated?.n ?? 0),
      candidates: count('candidate'),
      approved: count('approved'),
      forgotten: count('forgotten'),
      ftsAvailable: this.ftsAvailable,
      schemaVersion: Number(version?.value ?? 2),
    }
  }

  setProjectMeta(project: { key: string; name: string; cwd: string }, now = Date.now()): void {
    this.ensureOpen()
    this.db
      .prepare('INSERT OR REPLACE INTO project_meta(key, name, cwd, updated_at) VALUES (?, ?, ?, ?)')
      .run(project.key, project.name, project.cwd, now)
  }

  projectMeta(): { key: string; name: string; cwd: string } | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT key, name, cwd FROM project_meta ORDER BY updated_at DESC LIMIT 1').get() as
      | { key?: string; name?: string; cwd?: string }
      | undefined
    if (row === undefined) return undefined
    return { key: String(row.key ?? ''), name: String(row.name ?? ''), cwd: String(row.cwd ?? '') }
  }

  recordEvent(type: string, count = 0, tokens = 0, rawTokens = 0, now = Date.now()): void {
    this.ensureOpen()
    this.db
      .prepare('INSERT INTO memory_events(project_key, type, count, tokens, raw_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectKeyOfFile(this.file), type, count, tokens, rawTokens, now)
  }

  dashboard(): DashboardStats {
    this.ensureOpen()
    const base = this.stats()
    const since = Date.now() - 366 * 86_400_000
    const activity = new Map<string, ActivityDay>()
    const day = (date: string): ActivityDay => {
      let entry = activity.get(date)
      if (entry === undefined) {
        entry = { date, captures: 0, memories: 0, recalls: 0 }
        activity.set(date, entry)
      }
      return entry
    }
    const l0Rows = this.db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS n FROM l0_messages
         WHERE created_at >= ? GROUP BY d`,
      )
      .all(since) as unknown as Array<{ d?: string; n?: number }>
    for (const row of l0Rows) if (row.d) day(row.d).captures += Number(row.n ?? 0)
    const l1Rows = this.db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS n FROM l1_memories
         WHERE created_at >= ? GROUP BY d`,
      )
      .all(since) as unknown as Array<{ d?: string; n?: number }>
    for (const row of l1Rows) if (row.d) day(row.d).memories += Number(row.n ?? 0)
    const recallRows = this.db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, COALESCE(SUM(count), 0) AS n FROM memory_events
         WHERE type = 'inject' AND created_at >= ? GROUP BY d`,
      )
      .all(since) as unknown as Array<{ d?: string; n?: number }>
    for (const row of recallRows) if (row.d) day(row.d).recalls += Number(row.n ?? 0)

    const sources = (this.db
      .prepare('SELECT source, COUNT(*) AS n FROM l1_memories GROUP BY source ORDER BY n DESC')
      .all() as unknown as Array<{ source?: string; n?: number }>).map((row) => ({
      source: String(row.source ?? 'unknown'),
      count: Number(row.n ?? 0),
    }))
    const inject = this.db
      .prepare(
        `SELECT COALESCE(SUM(count), 0) AS c, COALESCE(SUM(tokens), 0) AS t FROM memory_events WHERE type = 'inject'`,
      )
      .get() as { c?: number; t?: number }
    const compression = this.db
      .prepare(
        `SELECT COALESCE(SUM(tokens), 0) AS t, COALESCE(SUM(raw_tokens), 0) AS r
         FROM memory_events WHERE type IN ('inject', 'offload')`,
      )
      .get() as { t?: number; r?: number }
    const longest = this.db
      .prepare('SELECT session_id, COUNT(*) AS n FROM l0_messages GROUP BY session_id ORDER BY n DESC LIMIT 1')
      .get() as { session_id?: string; n?: number } | undefined
    const meta = this.projectMeta()
    const key = projectKeyOfFile(this.file)
    return {
      l0Messages: base.l0Messages,
      sessions: base.sessions,
      repeatedQuestions: base.repeatedQuestions,
      candidates: base.candidates,
      approved: base.approved,
      forgotten: base.forgotten,
      injectedCount: Number(inject?.c ?? 0),
      injectedTokens: Number(inject?.t ?? 0),
      rawTokens: Number(compression?.r ?? 0),
      savedTokens: Math.max(0, Number(compression?.r ?? 0) - Number(compression?.t ?? 0)),
      sources,
      activity: [...activity.values()].sort((a, b) => a.date.localeCompare(b.date)),
      longestSession:
        longest?.session_id === undefined
          ? null
          : { sessionId: String(longest.session_id), messages: Number(longest.n ?? 0) },
      recent: this.list('approved', 8),
      candidatesList: this.list('candidate', 50),
      scenes: this.scenes(),
      persona: this.persona(),
      project: { key, name: meta?.name ?? key, cwd: meta?.cwd ?? '' },
    }
  }

  pruneOlderThan(days: number, now = Date.now()): number {
    if (days <= 0) return 0
    this.ensureOpen()
    const cutoff = now - days * 86_400_000
    const result = this.db.prepare('DELETE FROM l0_messages WHERE created_at < ?').run(cutoff)
    return Number(result.changes ?? 0)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // Closing twice or after a failed constructor is not actionable.
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('memory store is closed')
  }
}

function normalizeRank(value: unknown): number {
  const rank = Number(value)
  if (!Number.isFinite(rank)) return 0
  return 1 / (1 + Math.abs(rank))
}

function projectKeyOfFile(file: string): string {
  return path.basename(path.dirname(file))
}

export function openProjectStore(
  root: string,
  projectKey: string,
  project?: { key: string; name: string; cwd: string },
): MemoryStore {
  const store = new MemoryStore(path.join(root, 'projects', projectKey, 'memory.db'))
  if (project !== undefined) store.setProjectMeta(project)
  return store
}
