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
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { projectDbPath } from './project.js'
import { matchExperienceConditions, rankTextCandidates, type ExperienceConditionMatch } from './r41.js'
import { effectiveStartFromStored, effectiveStartIsUncertainAt, normalizeEffectiveStart, type EffectiveStart, type ValidFromBasis, type ValidFromPrecision } from './temporal.js'
import { inspectMemoryDatabaseIdentity, inspectSqliteSchema, snapshotSqliteFile, type SqliteSchemaInspection } from './sqlite-inspection.js'
import type { DashboardReadVersionStamp } from './dashboard-read.js'

const require = createRequire(import.meta.url)

export const MEMORY_SCHEMA_VERSION = 9

const DASHBOARD_ORIGIN_MAX_INDEXES = 16
const DASHBOARD_ORIGIN_INDEX_LIST_LIMIT = DASHBOARD_ORIGIN_MAX_INDEXES + 1
const DASHBOARD_ORIGIN_INDEX_NAME_BYTES = 128
const DASHBOARD_ORIGIN_INDEX_COLUMN_NAME_BYTES = 64
const DASHBOARD_ORIGIN_METADATA_BYTES = 4096
const DASHBOARD_ORIGIN_EVENT_INDEX = 'memory_events_event_unique'

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
  revision: number
  validFrom?: number
  validFromState: 'known' | 'unknown'
  validFromPrecision: ValidFromPrecision
  validFromBasis: ValidFromBasis
  validFromUpper?: number
  validFromLabel?: string
  validTo?: number
  recordedAt: number
  supersededAt?: number
  sourceVerified: boolean
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
  sourceVerified?: boolean
  validFrom?: number | string | null
  validFromInfo?: EffectiveStart
  validTo?: number
  reason?: string
}

export interface L0MessageInput {
  sessionId: string
  role: string
  content: string
  turn?: number
  step?: number
  createdAt?: number
  recordedAt?: number
  sourceEventId?: string
  origin?: string
  sourceKind?: string
  derivedFrom?: string[]
  agentId?: string
  agentPreset?: string
  provider?: string
  model?: string
  fingerprint?: string
  skipExtractionReason?: string
  originalMessageIdentity?: OriginalMessageIdentity
}

/** Pseudonymous, versioned identity for one Host message within its capture scope. */
export interface OriginalMessageIdentity {
  schema: 'memory-tdai/original-message/v1'
  algorithm: 'sha256'
  digest: string
}

export interface CaptureIdentityFenceCandidate {
  sourceId?: string
  sourceEventId?: string
}

export interface CaptureOriginalMessageMetrics {
  recordedOriginalMessageLowerBound: number
  unknownOriginalMessageEvents: number
  mostLinkedL0Session: {
    sessionId: string
    linkedL0Messages: number
    originalMessageCount: null
    events: number
    recordedOriginalMessageLowerBound: number
    unknownOriginalMessageEvents: number
  } | null
  topSessions: Array<{
    sessionId: string
    linkedL0Messages: number
    originalMessageCount: null
    events: number
    recordedOriginalMessageLowerBound: number
    unknownOriginalMessageEvents: number
  }>
}

export interface CaptureEventRecord {
  id: string
  projectKey: string
  eventId: string
  sessionId: string
  role: string
  source: string
  agentId?: string
  agentPreset?: string
  provider?: string
  model?: string
  occurredAt: number
  recordedAt: number
  fingerprint?: string
  metadata?: Record<string, unknown>
}

export interface MemoryEventInput {
  eventId: string
  type: string
  count?: number
  tokens?: number
  rawTokens?: number
  sessionId?: string
  source?: string
  sourceId?: string
  agentId?: string
  agentPreset?: string
  provider?: string
  model?: string
  occurredAt?: number
  usage?: { inputTokens?: number | null; outputTokens?: number | null; cachedInputTokens?: number | null; cacheReadTokens?: number | null; cacheWriteTokens?: number | null; reasoningTokens?: number | null; costMicros?: number | null }
  metadata?: Record<string, unknown>
}

export interface MemoryEventDetail {
  id: number
  eventId: string
  type: string
  occurredAt: number
  /** Original event/source timestamp when it differs from the capture timestamp. */
  sourceOccurredAt?: number
  count: number
  tokens?: number
  rawTokens?: number
  tokenEstimate?: boolean
  selectedMemoryIds?: string[]
  sessionId?: string
  source?: string
  agentId?: string
  agentPreset?: string
  provider?: string
  model?: string
  sourceId?: string
  fingerprint?: string
  /** Short user-source excerpt returned only for an explicit duplicate-clue request. */
  excerpt?: string
  excerptTruncated?: boolean
}

export interface CaptureOverview {
  messageCount: number
  sessions: number
  unknownSessionEvents: number
  /** Events without a Host Agent instance ID, even if the stable preset ID is known. */
  unknownAgentEvents: number
  /** Events without a Host Agent preset ID. */
  unknownAgentPresetEvents: number
  agents: Array<{ agentId: string; count: number; other?: boolean }>
  agentPresets: Array<{ agentPreset: string; count: number; other?: boolean }>
  providers: Array<{ provider: string; count: number; other?: boolean }>
  models: Array<{ model: string; count: number; other?: boolean }>
  sources: Array<{ source: string; count: number; other?: boolean }>
  repeated: Array<{ fingerprint: string; count: number }>
  repeatedTotal: number
  longestSession: { sessionId: string; messages: number } | null
  mostLinkedL0Session?: { sessionId: string; linkedL0Messages: number; originalMessageCount: null; events: number } | null
  topSessions: Array<{ sessionId: string; messages?: number; events: number; linkedL0Messages?: number; originalMessageCount?: null }>
}

export interface DailyEventCount {
  type: string
  events: number
  count: number
  tokens: number
  rawTokens: number
}

export interface EventDayMetrics {
  date: string
  captures: number
  recalls: number
  recallRequests: number
  revisions: number
  initialApprovals: number
  /** Legacy unit: selected memories, as stored in event.count. */
  preparedInjections: number
  preparedInjectionEvents: number
}

export interface EventOverviewMetrics {
  recallRequests: number
  recallResults: number
  preparedInjectionEvents: number
  preparedInjectionMemories: number
  preparedInjectionTokens: number
}

export interface ExtractionJob {
  id: string
  sessionId: string
  policyRevision: string
  status: 'queued' | 'ready' | 'dispatching' | 'result_ready' | 'completed' | 'failed' | 'source_pruned' | 'uncertain_remote' | 'blocked_charged'
  createdAt: number
  updatedAt: number
  quietUntil: number
  mustRunBy: number
  sourceIds: string[]
  inputSnapshot: Array<{ id: string; role: string; content: string; createdAt: number }>
  inputHash?: string
  attemptId?: string
  responseText?: string
  error?: string
  usage?: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null; costMicros: number | null }
  provider?: string
  model?: string
  agentPreset?: string
}

export interface MemoryRevision {
  id: string
  memoryId: string
  revision: number
  content: string
  kind: string
  scene?: string
  status: MemoryStatus
  recordedAt: number
  knownTo?: number
  validFrom?: number
  validFromState: 'known' | 'unknown'
  validFromPrecision: ValidFromPrecision
  validFromBasis: ValidFromBasis
  validFromUpper?: number
  validFromLabel?: string
  temporalUncertainAt?: boolean
  validTo?: number
  supersededAt?: number
  sourceMessageIds: string[]
  reason?: string
}

export interface RevisionCandidate {
  id: string
  memoryId: string
  baseRevision: number
  content: string
  sourceMessageIds: string[]
  reason: string
  createdAt: number
  status: 'candidate' | 'approved' | 'rejected' | 'conflict'
  validFrom?: number
  validFromState: 'known' | 'unknown'
  validFromPrecision: ValidFromPrecision
  validFromBasis: ValidFromBasis
  validFromUpper?: number
  validFromLabel?: string
  validTo?: number
}

export interface RelationRecord {
  id: string
  fromId: string
  toId: string
  type: 'supports' | 'contradicts' | 'depends_on' | 'supersedes' | 'derived_from'
  evidenceIds: string[]
  sourceRevision: number
  fromRevision: number
  toRevision: number
  createdAt: number
}

export interface DashboardVisibilityMemoryCursor { createdAt: number; id: string }
export interface DashboardVisibilityRevisionCursor { recordedAt: number; revision: number }
export interface DashboardVisibilityRelationCursor { toId: string; type: string }
export interface DashboardVisibilityMemoryPageRow { id?: string; idBytes: number; createdAt: number }
export interface DashboardReadEventPageRow {
  id: number
  projectKey?: string
  projectKeyBytes: number
  type?: string
  typeBytes: number
  eventId?: string
  eventIdBytes: number
  sourceId?: string
  sourceIdBytes: number
  /** True only when the LEFT JOIN found an L0 row in this same project. */
  l0Found: boolean
  sourceEventId?: string
  sourceEventIdBytes: number
  /** The linked L0's own source_event_id, when present and bounded. */
  linkedL0SourceEventId?: string
  linkedL0SourceEventIdBytes: number
  /** The capture event's own `capture:<id>` identity, independent of the L0. */
  directSourceEventId?: string
  directSourceEventIdBytes: number
  sessionId?: string
  sessionIdBytes: number
  fingerprint?: string
  fingerprintBytes: number
  memoryIds?: string[]
  memoryIdsInvalid: boolean
  originalMessageIdentity?: string | null
  metadataBytes: number
  metadataInvalid: boolean
  fingerprintInvalid: boolean
  identityInvalid: boolean
  createdAt: number
  occurredAt?: number | null
  count: number
  tokens: number
  rawTokens: number
  source?: string
  sourceBytes: number
  agentId?: string
  agentIdBytes: number
  agentPreset?: string
  agentPresetBytes: number
  provider?: string
  providerBytes: number
  model?: string
  modelBytes: number
}
export interface DashboardReadEventCursor { id: number }
/** One bounded fingerprint-enumeration row; an over-long key is reported, never truncated. */
export interface DashboardRepeatFingerprintRow { fingerprint?: string; fingerprintBytes: number }
/** One bounded L0 member of a `(projectKey, fingerprint)` repeated-capture group. */
export interface DashboardRepeatMemberRow { rowid: number; memberId?: string; memberIdBytes: number; createdAt: number }
/** Small capture-event projection for one L0 member; all text is byte-gated before JS. */
export interface DashboardRepeatEventRow {
  id: number
  eventId?: string
  eventIdBytes: number
  createdAt: number
  sourceId?: string
  sourceIdBytes: number
  /** L0 row identity (`l0_messages.source_event_id`), if present and bounded. */
  l0SourceEventId?: string
  l0SourceEventIdBytes: number
  /** Capture event's own Host identity derived from `capture:<id>`, if present and bounded. */
  eventSourceEventId?: string
  eventSourceEventIdBytes: number
  sessionId?: string
  sessionIdBytes: number
  source?: string
  sourceBytes: number
  agentId?: string
  agentIdBytes: number
  agentPreset?: string
  agentPresetBytes: number
  provider?: string
  providerBytes: number
  model?: string
  modelBytes: number
  fingerprint?: string
  fingerprintBytes: number
  fingerprintInvalid: boolean
  identityInvalid: boolean
}
export interface DashboardReadProjectMeta { name?: string; nameBytes: number }
export interface DashboardManagedMemoryView {
  id?: string
  idBytes: number
  content?: string
  contentBytes: number
  kind?: string
  kindBytes: number
  scene?: string | null
  sceneBytes: number
  confidence: number
  status?: string
  source?: string
  sourceBytes: number
  sourceMessageIds?: string
  sourceMessageIdsBytes: number
  createdAt: number
  updatedAt: number
  approvedAt?: number | null
  forgottenAt?: number | null
  revision: number
  validFrom?: number | null
  validFromState?: string
  validFromStateInvalid: boolean
  validFromPrecision?: string
  validFromPrecisionBytes: number
  validFromPrecisionInvalid: boolean
  validFromBasis?: string
  validFromBasisBytes: number
  validFromBasisInvalid: boolean
  validFromUpper?: number | null
  validFromLabel?: string | null
  validFromLabelBytes: number
  validTo?: number | null
  recordedAt: number
  supersededAt?: number | null
  sourceVerified: number
  expiryAt?: number | null
}
export interface DashboardVisibilityMemoryMeta {
  currentRevision?: number
  status?: string
  statusInvalid: boolean
  confidence?: number
  source?: string
  sourceBytes: number
  createdAt?: number
  updatedAt?: number
  approvedAt?: number | null
  forgottenAt?: number | null
  expiryAt?: number | null
}
/** Bounded direct-origin projection; raw affinity columns never leave SQLite. */
export interface DashboardVisibilityDirectCreationOrigin {
  schemaVersion: number
  lookupCapabilitySupported: boolean
  creationApproved: boolean
  creationReasonIsText: boolean
  approvalFound: boolean
  approvalCountIsOne: boolean
  approvalCreatedAtIsSafe: boolean
  approvalOccurredAtIsSafe: boolean
  approvalMetadataIsText: boolean
  approvalMetadata?: string
  approvalMetadataBytes: number
}
export interface DashboardVisibilityRevisionPageRow {
  revision: number
  recordedAt: number
  validFrom?: number | null
  validFromState?: string
  validFromStateInvalid: boolean
  validFromUpper?: number | null
  validFromPrecision?: string
  validFromPrecisionBytes: number
  validFromPrecisionInvalid: boolean
  validFromBasis?: string
  validFromBasisBytes: number
  validFromBasisInvalid: boolean
  validFromLabel?: string | null
  validFromLabelBytes: number
  validTo?: number | null
  supersededAt?: number | null
  sourceVerified?: number
  contentBytes: number
  sourceIdsBytes: number
  kind?: string
  kindBytes: number
  scene?: string | null
  sceneBytes: number
}
export interface DashboardVisibilityRelationPageRow {
  id?: string
  idBytes: number
  toId?: string
  toIdBytes: number
  type?: string
  typeBytes: number
  fromRevision: number
  toRevision: number
  evidenceBytes: number
}
export interface DashboardVisibilitySourceIdentity {
  found: boolean
  sourceEventId?: string | null
  sourceEventIdBytes: number
  origin?: string | null
  originBytes: number
  sourceKind?: string | null
  sourceKindBytes: number
  sessionId?: string | null
  sessionIdBytes: number
  agentPreset?: string | null
  agentPresetBytes: number
  projectionBytes: number
}
export interface DashboardVisibilityLegacyEventPageRow {
  id: number
  createdAt: number
  matches: boolean
  eventId?: string | null
  eventIdBytes?: number | null
  sessionId?: string | null
  sessionIdBytes?: number | null
  agentPreset?: string | null
  agentPresetBytes?: number | null
  metadataBytes?: number | null
}

export interface RelationCandidate extends RelationRecord {
  status: 'candidate' | 'approved' | 'rejected' | 'stale'
  fromRevision: number
  toRevision: number
}

export interface TaskContextRecord {
  taskRef: string
  goal: string
  constraints: string[]
  completed: string[]
  pending: string[]
  knownUnknowns: string[]
  confirmedFacts: string[]
  assumptions: string[]
  blockers: string[]
  artifactRefs: Array<{ ref: string; hash?: string; revision?: string }>
  sourceMemoryIds: string[]
  sourceRevisions: Record<string, number>
  status: 'active' | 'paused' | 'complete' | 'cancelled'
  revision: number
  updatedAt: number
  lastVerifiedAt?: number
  staleSources: string[]
}

export interface ExperienceRecord {
  id: string
  title: string
  symptom: string
  environment: Record<string, string>
  prerequisites: string[]
  steps: string[]
  outcomes: string[]
  counterexamples: string[]
  evidenceMemoryIds: string[]
  sourceRevisions: Record<string, number>
  status: 'episode' | 'candidate' | 'verified' | 'rejected' | 'stale'
  independentSources: number
  reviewedAt?: number
  createdAt: number
  updatedAt: number
}

export interface EvaluationCase {
  id: string
  title: string
  query: string
  expectedIds: string[]
  forbiddenIds: string[]
  fixture: Record<string, unknown>
  source: 'synthetic' | 'approved'
  createdAt: number
  updatedAt: number
}

export interface RetrievalStrategy {
  id: string
  title: string
  baseId: string
  config: { maxCandidates: number; maxResults: number }
  status: 'candidate' | 'shadow' | 'selected' | 'superseded' | 'rolled_back'
  createdAt: number
  updatedAt: number
}

export interface EvaluationRun {
  id: string
  pairId?: string
  caseId: string
  strategyId: string
  role: 'baseline' | 'candidate' | 'shadow'
  result: {
    hits: string[]; missing: string[]; forbidden: string[]; hardGate: boolean; score: number; stopReason: string
    candidateCount?: number
    incomplete?: boolean
    budgetGaps?: string[]
    sourceIssues?: string[]
    filterReasons?: Array<{ id: string; reason: string }>
    routes?: Array<{ id: string; routes: string[] }>
    renderedPacket?: string
    renderedPacketProvenance?: 'complete' | 'incomplete'
    renderedPacketSourceKind?: 'approved' | 'synthetic'
    renderedPacketSourceIds?: string[]
    renderedPacketSourceRefs?: Array<{ projectKey: string; id: string }>
    renderedPacketAvailable?: boolean
    renderedPacketReason?: string
    audit?: { caseFingerprint: string; sourceFingerprint: string; strategyFingerprint: string; controlSeq: number; policyRevision: string }
  }
  createdAt: number
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
  revisions?: number
  coverage?: 'covered' | 'partial' | 'unknown'
}

export interface SceneRecord {
  name: string
  summary: string
  memoryCount: number
  updatedAt: number
  sourceIds: string[]
  sourceRevisions: Record<string, number>
  summaryComplete: boolean
}

export interface PersonaRecord {
  content: string
  sourceCount: number
  updatedAt: number
  /** Memory ids the persona was generated from; empty for pre-upgrade rows. */
  sourceIds?: string[]
  /** Exact source revisions used to generate the persona; missing maps are stale. */
  sourceRevisions?: Record<string, number>
  /** True when a source memory is unavailable or no longer matches its recorded revision. */
  stale: boolean
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

export interface ExtractionJobSummary {
  queued: number
  oldestWaitingAt: number | null
  failed: number
  uncertainUsage: number
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

function validFromFields(row: Record<string, unknown>, recordedAt: number): Pick<MemoryRecord,
  'validFrom' | 'validFromState' | 'validFromPrecision' | 'validFromBasis' | 'validFromUpper' | 'validFromLabel'> {
  const start = effectiveStartFromStored({ state: row.valid_from_state, precision: row.valid_from_precision,
    basis: row.valid_from_basis, value: row.valid_from, upperExclusive: row.valid_from_upper,
    label: row.valid_from_label, recordedAt })
  return {
    ...(start.value === undefined ? {} : { validFrom: start.value }),
    validFromState: start.state, validFromPrecision: start.precision, validFromBasis: start.basis,
    ...(start.upperExclusive === undefined ? {} : { validFromUpper: start.upperExclusive }),
    ...(start.label === undefined ? {} : { validFromLabel: start.label }),
  }
}

function startInfoFromMemory(record: MemoryRecord): EffectiveStart {
  return effectiveStartFromStored({ state: record.validFromState, precision: record.validFromPrecision, basis: record.validFromBasis,
    value: record.validFrom, upperExclusive: record.validFromUpper, label: record.validFromLabel, recordedAt: record.recordedAt })
}

function startInfoFromRevision(revision: MemoryRevision): EffectiveStart {
  return effectiveStartFromStored({ state: revision.validFromState, precision: revision.validFromPrecision, basis: revision.validFromBasis,
    value: revision.validFrom, upperExclusive: revision.validFromUpper, label: revision.validFromLabel, recordedAt: revision.recordedAt })
}

function startInfoFromCandidate(candidate: RevisionCandidate): EffectiveStart {
  return effectiveStartFromStored({ state: candidate.validFromState, precision: candidate.validFromPrecision, basis: candidate.validFromBasis,
    value: candidate.validFrom, upperExclusive: candidate.validFromUpper, label: candidate.validFromLabel, recordedAt: candidate.createdAt })
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
    revision: Number(row.revision ?? 1),
    ...validFromFields(row, Number(row.recorded_at ?? row.updated_at ?? row.created_at ?? 0)),
    validTo: row.valid_to === null || row.valid_to === undefined ? undefined : Number(row.valid_to),
    recordedAt: Number(row.recorded_at ?? row.updated_at ?? row.created_at ?? 0),
    supersededAt: row.superseded_at === null || row.superseded_at === undefined ? undefined : Number(row.superseded_at),
    sourceVerified: Number(row.source_verified ?? 0) === 1,
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

function evaluationRunMentionsMemory(resultJson: unknown, memoryIds: ReadonlySet<string>, projectKey?: string): boolean {
  const result = parseJson<Record<string, unknown>>(resultJson, {})
  for (const field of ['hits', 'missing', 'forbidden'] as const) {
    if (Array.isArray(result[field]) && (result[field] as unknown[]).some((id) => typeof id === 'string' && memoryIds.has(id))) return true
  }
  if (Array.isArray(result.renderedPacketSourceIds) && result.renderedPacketSourceIds.some((id) => typeof id === 'string' && memoryIds.has(id))) return true
  if (Array.isArray(result.renderedPacketSourceRefs) && result.renderedPacketSourceRefs.some((value) => {
    if (value === null || typeof value !== 'object') return false
    const ref = value as Record<string, unknown>
    return typeof ref.id === 'string' && memoryIds.has(ref.id) && (projectKey === undefined || ref.projectKey === projectKey)
  })) return true
  return Array.isArray(result.filterReasons) && result.filterReasons.some((item) => item !== null && typeof item === 'object' &&
    typeof (item as Record<string, unknown>).id === 'string' && memoryIds.has(String((item as Record<string, unknown>).id)))
}

function evaluationRunMentionsSourceRefs(resultJson: unknown, sourceRefs: ReadonlySet<string>): boolean {
  if (sourceRefs.size === 0) return false
  const result = parseJson<Record<string, unknown>>(resultJson, {})
  return Array.isArray(result.renderedPacketSourceRefs) && result.renderedPacketSourceRefs.some((value) => {
    if (value === null || typeof value !== 'object') return false
    const ref = value as Record<string, unknown>
    return typeof ref.projectKey === 'string' && typeof ref.id === 'string' && sourceRefs.has(JSON.stringify([ref.projectKey, ref.id]))
  })
}

export function evaluationRunCountForSourceRefsFile(file: string, sourceRefs: Array<{ projectKey: string; id: string }>): number {
  const targets = new Set(sourceRefs.map(({ projectKey, id }) => JSON.stringify([projectKey, id])))
  if (targets.size === 0) return 0
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDb }
  const db = new sqlite.DatabaseSync(file, { readOnly: true })
  try {
    if (db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_runs'").get() === undefined) return 0
    const rows = db.prepare('SELECT id, pair_id, result_json FROM evaluation_runs').all() as Array<Record<string, unknown>>
    const pairIds = new Set<string>()
    const standaloneIds = new Set<string>()
    for (const row of rows) {
      if (typeof row.id !== 'string' || !evaluationRunMentionsSourceRefs(row.result_json, targets)) continue
      if (typeof row.pair_id === 'string') pairIds.add(row.pair_id)
      else standaloneIds.add(row.id)
    }
    return rows.filter((row) => typeof row.id === 'string' && (standaloneIds.has(row.id) ||
      (typeof row.pair_id === 'string' && pairIds.has(row.pair_id)))).length
  } finally { db.close() }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function toExtractionJob(row: Record<string, unknown>): ExtractionJob {
  const usage = parseJson<ExtractionJob['usage'] | undefined>(row.usage_json, undefined)
  return {
    id: String(row.id), sessionId: String(row.session_id), policyRevision: String(row.policy_revision),
    status: String(row.status) as ExtractionJob['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    quietUntil: Number(row.quiet_until), mustRunBy: Number(row.must_run_by), sourceIds: parseIds(row.source_ids),
    inputSnapshot: parseJson<ExtractionJob['inputSnapshot']>(row.input_snapshot, []),
    ...(typeof row.input_hash === 'string' ? { inputHash: row.input_hash } : {}),
    ...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
    ...(typeof row.response_text === 'string' ? { responseText: row.response_text } : {}),
    ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof row.route_provider === 'string' ? { provider: row.route_provider } : {}),
    ...(typeof row.route_model === 'string' ? { model: row.route_model } : {}),
    ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}),
  }
}

function toRevisionCandidate(row: Record<string, unknown>): RevisionCandidate {
  const createdAt = Number(row.created_at ?? 0)
  return {
    id: String(row.id), memoryId: String(row.memory_id), baseRevision: Number(row.base_revision), content: String(row.content),
    sourceMessageIds: parseIds(row.source_message_ids), reason: String(row.reason ?? ''), createdAt,
    status: String(row.status) as RevisionCandidate['status'], ...validFromFields(row, createdAt),
    ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: Number(row.valid_to) }),
  }
}

function sqliteGlob(pattern: string): string {
  let output = ''
  for (const character of pattern) {
    if (character === '*') output += '*'
    else if (character === '?') output += '?'
    else if (character === '[') output += '[[]'
    else if (character === ']') output += '[]]'
    else output += character
  }
  return output
}

function excludedMemorySql(patterns: string[]): { sql: string; params: string[] } {
  const safePatterns = patterns.filter((pattern) => typeof pattern === 'string' && pattern !== '').slice(0, 100)
  if (safePatterns.length === 0) return { sql: '1 = 0', params: [] }
  return {
    sql: `l.agent_preset IS NOT NULL AND (${safePatterns.map(() => 'l.agent_preset GLOB ?').join(' OR ')})`,
    params: safePatterns.map(sqliteGlob),
  }
}

function excludedEventSql(patterns: string[]): { sql: string; params: string[] } {
  const safePatterns = patterns.filter((pattern) => typeof pattern === 'string' && pattern !== '').slice(0, 100)
  if (safePatterns.length === 0) return { sql: '1 = 1', params: [] }
  const excludedSources = excludedMemorySql(safePatterns)
  return {
    sql: `(e.agent_preset IS NULL OR NOT (${safePatterns.map(() => 'e.agent_preset GLOB ?').join(' OR ')}))
      AND (e.type NOT IN ('initial_approval','revision') OR e.source_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.project_key = e.project_key AND l.id = ms.source_id
        WHERE ms.memory_id = e.source_id AND ${excludedSources.sql}
      ))`,
    params: [...safePatterns.map(sqliteGlob), ...excludedSources.params],
  }
}

function isOriginalMessageIdentity(value: unknown): value is OriginalMessageIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schema === 'memory-tdai/original-message/v1' && record.algorithm === 'sha256' &&
    typeof record.digest === 'string' && /^[a-f0-9]{64}$/u.test(record.digest)
}

function captureMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** Capture replay tolerates the new optional fields while preserving accepted identity evidence. */
function captureMetadataCompatible(existingValue: unknown, incomingValue: unknown): boolean {
  if ((existingValue ?? null) === (incomingValue ?? null)) return true
  const existing = captureMetadataRecord(existingValue)
  const incoming = captureMetadataRecord(incomingValue)
  if (existing === undefined || incoming === undefined) return false
  const optional = new Set(['originalMessageIdentity'])
  const withoutOptional = (record: Record<string, unknown>): string => JSON.stringify(
    Object.fromEntries(Object.entries(record).filter(([key]) => !optional.has(key))),
  )
  if (withoutOptional(existing) !== withoutOptional(incoming)) return false
  const existingIdentity = isOriginalMessageIdentity(existing.originalMessageIdentity) ? existing.originalMessageIdentity : undefined
  const incomingIdentity = isOriginalMessageIdentity(incoming.originalMessageIdentity) ? incoming.originalMessageIdentity : undefined
  if (existingIdentity !== undefined && incomingIdentity !== undefined && existingIdentity.digest !== incomingIdentity.digest) return false
  return true
}

function captureIdentityFromMetadata(value: unknown): string | null {
  const metadata = captureMetadataRecord(value)
  const identity = metadata?.originalMessageIdentity
  return isOriginalMessageIdentity(identity) ? identity.digest : null
}

function captureSourceEventIdFromRow(row: Record<string, unknown>): string | undefined {
  const l0SourceEventId = row.l0_source_event_id
  if (typeof l0SourceEventId === 'string' && l0SourceEventId.length > 0) return l0SourceEventId
  const eventId = row.event_id
  if (typeof eventId === 'string' && eventId.startsWith('capture:')) {
    const suffix = eventId.slice('capture:'.length)
    if (suffix.length > 0) return suffix
  }
  return undefined
}

function excludedJobSql(patterns: string[]): { sql: string; params: string[] } {
  const safePatterns = patterns.filter((pattern) => typeof pattern === 'string' && pattern !== '').slice(0, 100)
  if (safePatterns.length === 0) return { sql: '1 = 1', params: [] }
  return { sql: `(j.agent_preset IS NULL OR NOT (${safePatterns.map(() => 'j.agent_preset GLOB ?').join(' OR ')}))`, params: safePatterns.map(sqliteGlob) }
}

/** Fixed capability CTEs: two table-index lists capped at 16 and three index-key lists capped at 6.
 * Limits precede filtering, so a missing/moved/partial/collated index fails closed without a catalog scan.
 * Each data statement repeats this guard in its own snapshot and uses it to set a zero-or-bounded LIMIT. */
function dashboardOverviewIndexCapabilitySql(): string {
  const specs = [
    ['created_keys', 'l1_status_created_page', ['project_key', 'status', 'created_at', 'id'], [0, 0, 0, 0]],
    ['updated_keys', 'l1_status_updated_page', ['project_key', 'status', 'updated_at', 'id'], [0, 0, 1, 1]],
    ['revision_keys', 'l1_revision_effective_lookup', ['memory_id', 'status', 'recorded_at', 'revision'], [0, 0, 0, 0]],
  ] as const
  const lists = (['l1_memories', 'l1_revisions'] as const).map((table) => `${table}_indexes AS MATERIALIZED (
    SELECT CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name END AS name,
      "unique", CASE WHEN length(CAST(origin AS BLOB)) <= 8 THEN origin END AS origin, partial
    FROM pragma_index_list('${table}', 'main') LIMIT 16)`)
  const keys = specs.map(([alias, name]) => `${alias} AS MATERIALIZED (SELECT seqno, cid,
    CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name END AS name,
    "desc", CASE WHEN length(CAST(coll AS BLOB)) <= 16 THEN coll END AS coll, "key"
    FROM pragma_index_xinfo('${name}', 'main') LIMIT 6)`)
  const shapes = specs.map(([alias, , columns, directions]) => `(SELECT count(*) = 5 AND sum(CASE
    WHEN ("key" = 0 AND seqno = 4 AND cid = -1) OR ("key" = 1 AND cid >= 0 AND coll = 'BINARY' AND (
      ${columns.map((column, index) => `(seqno = ${index} AND name = '${column}' AND "desc" = ${directions[index]})`).join(' OR ')}
    )) THEN 1 ELSE 0 END) = 5 FROM ${alias})`)
  return [...lists, ...keys, `overview_index_capability AS MATERIALIZED (SELECT CASE WHEN
    (SELECT count(*) FROM l1_memories_indexes WHERE name IN ('l1_status_created_page','l1_status_updated_page')
      AND "unique" = 0 AND origin = 'c' AND partial = 0) = 2
    AND (SELECT count(*) FROM l1_revisions_indexes WHERE name = 'l1_revision_effective_lookup'
      AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
    AND ${shapes.join(' AND ')} THEN 1 ELSE 0 END AS ready)`].join(', ')
}

export class MemoryStore {
  readonly file: string
  readonly openingSchema: SqliteSchemaInspection | undefined
  readonly readOnly: boolean
  private readonly db: SqliteDb
  private readonly dashboardConnectionIdentity: string
  /**
   * Path identity (dev/ino) observed immediately before and after this
   * connection opened. It is retained for later path checks; it is not proof
   * of the SQLite handle's underlying inode.
   */
  private readonly databaseFileIdentity: { dev: number; ino: number } | undefined
  private ftsAvailable = false
  private closed = false
  private dashboardOriginRollbackFailure: {
    rollbackError: unknown
    closeError?: unknown
    cleanupUnknown: boolean
  } | undefined

  constructor(file: string, options: { readOnly?: boolean } = {}) {
    this.file = path.resolve(file)
    this.readOnly = options.readOnly === true
    if (!this.readOnly) mkdirSync(path.dirname(this.file), { recursive: true })
    this.openingSchema = this.readOnly ? undefined : existsSync(this.file) ? inspectSqliteSchema(this.file) : undefined
    const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly: boolean }) => SqliteDb }
    if (this.readOnly) {
      const openingFileIdentity = databaseFileIdentity(this.file)
      this.db = new sqlite.DatabaseSync(this.file, { readOnly: true })
      this.dashboardConnectionIdentity = randomUUID()
      this.databaseFileIdentity = verifyDatabaseFileIdentity(this.file, openingFileIdentity)
      try {
        const rawUserVersion = (this.db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version
        const userVersion = typeof rawUserVersion === 'number' && Number.isSafeInteger(rawUserVersion) ? rawUserVersion : Number.NaN
        const requiredTables = ['meta', 'project_meta', 'memory_events', 'l0_messages', 'l1_memories', 'l1_revisions',
          'memory_sources', 'memory_relations', 'l2_scenes', 'l2_scene_members']
        const tableNames = requiredTables.map(() => '?').join(', ')
        const tableRows = this.db.prepare(`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN (${tableNames}) LIMIT ${requiredTables.length}`)
          .all(...requiredTables) as Array<{ name?: unknown }>
        const tables = new Set(tableRows.flatMap((row) => typeof row.name === 'string' && requiredTables.includes(row.name) ? [row.name] : []))
        const meta = tables.has('meta') ? this.db.prepare(`SELECT
            CASE WHEN length(CAST(value AS BLOB)) <= 16 THEN value END AS value,
            length(CAST(value AS BLOB)) AS value_bytes
          FROM meta WHERE key = ? LIMIT 1`).get('schema_version') as { value?: unknown; value_bytes?: unknown } | undefined : undefined
        const versionText = typeof meta?.value === 'string' && meta.value_bytes === Buffer.byteLength(meta.value, 'utf8') &&
          /^(0|[1-9][0-9]*)$/u.test(meta.value) ? meta.value : undefined
        const recordedVersion = versionText === undefined ? Number.NaN : Number(versionText)
        if (userVersion !== MEMORY_SCHEMA_VERSION || recordedVersion !== MEMORY_SCHEMA_VERSION ||
            requiredTables.some((table) => !tables.has(table))) {
          throw new Error('read-only project store is missing, unsupported, or awaiting schema migration')
        }
        this.db.exec('PRAGMA query_only = ON')
        this.db.exec('PRAGMA busy_timeout = 3000')
      } catch (error) {
        try { this.db.close() } catch { /* preserve the schema refusal */ }
        throw error
      }
      return
    }
    if ((this.openingSchema?.recordedVersion ?? 0) > MEMORY_SCHEMA_VERSION || (this.openingSchema?.userVersion ?? 0) > MEMORY_SCHEMA_VERSION) {
      throw new Error(`memory database schema is newer than this plugin supports (meta=${this.openingSchema?.recordedVersion ?? 0}, user_version=${this.openingSchema?.userVersion ?? 0})`)
    }
    const openingVersion = Math.max(this.openingSchema?.recordedVersion ?? 0, this.openingSchema?.userVersion ?? 0)
    // Every existing database that will be changed by this migration gets a
    // verified pre-migration copy, including the supported schema 7/8 range.
    // The current schema reopens in place without creating duplicate backups.
    if (this.openingSchema !== undefined && openingVersion < MEMORY_SCHEMA_VERSION) {
      const backupDirectory = path.join(path.dirname(this.file), 'migration-backups')
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
      const directoryStat = lstatSync(backupDirectory)
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('pre-migration backup directory is not a regular directory')
      const backupFile = path.join(backupDirectory, `schema-${openingVersion}-${Date.now()}-${randomUUID().replace(/-/gu, '').slice(0, 12)}.db`)
      const backupSchema = snapshotSqliteFile(this.file, backupFile)
      if (JSON.stringify(backupSchema) !== JSON.stringify(this.openingSchema) ||
          JSON.stringify(inspectMemoryDatabaseIdentity(backupFile)) !== JSON.stringify(inspectMemoryDatabaseIdentity(this.file))) {
        throw new Error('raw pre-migration backup did not preserve the opening SQLite schema and L0/L1 identity')
      }
      const digest = createHash('sha256').update(readFileSync(backupFile)).digest('hex')
      writeFileSync(`${backupFile}.json`, `${JSON.stringify({ version: 1, source: path.basename(this.file), schema: backupSchema,
        dataIdentity: inspectMemoryDatabaseIdentity(backupFile), sha256: digest, createdAt: Date.now() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    const openingFileIdentity = databaseFileIdentity(this.file)
    this.db = new sqlite.DatabaseSync(this.file)
    this.dashboardConnectionIdentity = randomUUID()
    this.databaseFileIdentity = verifyDatabaseFileIdentity(this.file, openingFileIdentity)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const metaExists = this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined
    const recordedVersion = metaExists
      ? Number((this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value ?? 0)
      : 0
    const userVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
    if (recordedVersion > MEMORY_SCHEMA_VERSION || userVersion > MEMORY_SCHEMA_VERSION) throw new Error(`memory database schema is newer than this plugin supports (meta=${recordedVersion}, user_version=${userVersion})`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
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
      CREATE INDEX IF NOT EXISTS l1_status_created_page ON l1_memories(project_key, status, created_at, id);
      CREATE INDEX IF NOT EXISTS l1_status_updated_page ON l1_memories(project_key, status, updated_at DESC, id DESC);
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
        source_ids TEXT NOT NULL DEFAULT '[]',
        source_revisions TEXT NOT NULL DEFAULT '{}',
        summary_complete INTEGER NOT NULL DEFAULT 0,
        summary_parts TEXT,
        summary_frontier TEXT,
        summary_frontier_ready INTEGER NOT NULL DEFAULT 0,
        summary_member_count INTEGER NOT NULL DEFAULT 0,
        source_snapshot_dirty INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_key, name)
      );
      CREATE TABLE IF NOT EXISTS l2_scene_members (
        project_key TEXT NOT NULL,
        scene_name TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        revision INTEGER,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (project_key, scene_name, memory_id)
      );
      CREATE INDEX IF NOT EXISTS l2_scene_members_order ON l2_scene_members(project_key, scene_name, ordinal);
      CREATE INDEX IF NOT EXISTS l2_scene_members_memory ON l2_scene_members(project_key, memory_id, scene_name);
      CREATE TABLE IF NOT EXISTS l3_persona (
        project_key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source_revisions TEXT NOT NULL DEFAULT '{}'
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
    // v3: personas remember which approved memories they were generated from so
    // a later forget can mark them stale instead of injecting outdated facts.
    const personaColumns = this.db.prepare('PRAGMA table_info(l3_persona)').all() as unknown as Array<{ name?: string }>
    if (!personaColumns.some((column) => column.name === 'source_ids')) {
      this.db.exec("ALTER TABLE l3_persona ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]'")
    }
    this.ensureColumn('l3_persona', 'source_revisions', "TEXT NOT NULL DEFAULT '{}'" )
    this.ensureColumn('l0_messages', 'source_event_id', 'TEXT')
    this.ensureColumn('l0_messages', 'origin', "TEXT NOT NULL DEFAULT 'dsh-session'")
    this.ensureColumn('l0_messages', 'source_kind', "TEXT NOT NULL DEFAULT 'conversation'")
    this.ensureColumn('l0_messages', 'derived_from', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('l0_messages', 'agent_id', 'TEXT')
    this.ensureColumn('l0_messages', 'agent_preset', 'TEXT')
    this.ensureColumn('l0_messages', 'provider', 'TEXT')
    this.ensureColumn('l0_messages', 'model', 'TEXT')
    this.ensureColumn('l0_messages', 'fingerprint', 'TEXT')
    this.ensureColumn('l1_memories', 'revision', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('l1_memories', 'valid_from', 'INTEGER')
    this.ensureColumn('l1_memories', 'valid_from_state', "TEXT NOT NULL DEFAULT 'known'")
    this.ensureColumn('l1_memories', 'valid_from_precision', "TEXT NOT NULL DEFAULT 'instant'")
    this.ensureColumn('l1_memories', 'valid_from_upper', 'INTEGER')
    this.ensureColumn('l1_memories', 'valid_from_basis', "TEXT NOT NULL DEFAULT 'default_record_time'")
    this.ensureColumn('l1_memories', 'valid_from_label', 'TEXT')
    this.ensureColumn('l1_memories', 'valid_to', 'INTEGER')
    this.ensureColumn('l1_memories', 'recorded_at', 'INTEGER')
    this.ensureColumn('l1_memories', 'superseded_at', 'INTEGER')
    this.ensureColumn('l1_memories', 'expiry_at', 'INTEGER')
    this.db.exec('CREATE INDEX IF NOT EXISTS l1_expiry_boundary ON l1_memories(project_key, status, expiry_at)')
    this.ensureColumn('l1_memories', 'source_verified', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('l2_scenes', 'source_ids', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('l2_scenes', 'source_revisions', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('l2_scenes', 'summary_complete', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('l2_scenes', 'summary_parts', 'TEXT')
    this.ensureColumn('l2_scenes', 'summary_frontier', 'TEXT')
    this.ensureColumn('l2_scenes', 'summary_frontier_ready', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('l2_scenes', 'summary_member_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('l2_scenes', 'source_snapshot_dirty', 'INTEGER NOT NULL DEFAULT 0')
    // A member write by an older schema-v9 writer cannot update the R21
    // frontier. Track membership mutations in SQLite and invalidate the
    // frontier even when the old writer leaves readiness set to 1. A complete
    // clean rebuild can revalidate readiness for R21 rollback compatibility.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS l2_scene_members_frontier_invalidate_insert
      AFTER INSERT ON l2_scene_members BEGIN
        UPDATE l2_scenes SET summary_member_count = summary_member_count + 1,
          summary_frontier_ready = CASE WHEN source_snapshot_dirty = 0
            AND json_valid(CASE WHEN json_valid(summary_frontier) THEN summary_frontier ELSE '[]' END)
            AND json_type(CASE WHEN json_valid(summary_frontier) THEN summary_frontier ELSE '[]' END) = 'array'
            AND json_array_length(CASE WHEN json_valid(summary_frontier) THEN summary_frontier ELSE '[]' END) = 321
            AND json_valid(CASE WHEN json_valid(source_ids) THEN source_ids ELSE '[]' END)
            AND json_type(CASE WHEN json_valid(source_ids) THEN source_ids ELSE '[]' END) = 'array'
            AND json_array_length(CASE WHEN json_valid(source_ids) THEN source_ids ELSE '[]' END) = memory_count
            AND summary_member_count + 1 = memory_count AND NEW.ordinal = memory_count - 1
            THEN 1 ELSE 0 END
        WHERE project_key = NEW.project_key AND name = NEW.scene_name;
      END;
      CREATE TRIGGER IF NOT EXISTS l2_scene_members_frontier_invalidate_update
      AFTER UPDATE ON l2_scene_members BEGIN
        UPDATE l2_scenes SET summary_frontier_ready = 0,
          summary_member_count = MAX(summary_member_count - 1, 0)
        WHERE project_key = OLD.project_key AND name = OLD.scene_name;
        UPDATE l2_scenes SET summary_frontier_ready = 0,
          summary_member_count = summary_member_count + 1
        WHERE project_key = NEW.project_key AND name = NEW.scene_name;
      END;
      CREATE TRIGGER IF NOT EXISTS l2_scene_members_frontier_invalidate_delete
      AFTER DELETE ON l2_scene_members BEGIN
        UPDATE l2_scenes SET summary_frontier_ready = 0,
          summary_member_count = MAX(summary_member_count - 1, 0)
        WHERE project_key = OLD.project_key AND name = OLD.scene_name;
      END;
    `)
    const frontierGuard = this.db.prepare("SELECT value FROM meta WHERE key = 'scene_frontier_member_guard_v1'")
      .get() as { value?: string } | undefined
    if (frontierGuard?.value !== '1') {
      // R21 persisted no member-to-frontier binding. Seed the mutation counter
      // and invalidate all old frontiers once; clean JSON can repopulate its
      // members, while dirty scenes rebuild from approved records.
      this.db.prepare(`UPDATE l2_scenes SET summary_member_count = (
        SELECT COUNT(*) FROM l2_scene_members member
        WHERE member.project_key = l2_scenes.project_key AND member.scene_name = l2_scenes.name
      ), summary_frontier_ready = 0 WHERE project_key = ?`).run(projectKeyOfFile(this.file))
      this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
        .run('scene_frontier_member_guard_v1', '1')
    }
    // Uninitialized clean snapshots use JSON as their migration source of truth.
    // Ready clean rows and dirty rows already have complete indexed membership.
    this.db.prepare(`DELETE FROM l2_scene_members WHERE project_key = ? AND NOT EXISTS (
      SELECT 1 FROM l2_scenes s WHERE s.project_key = l2_scene_members.project_key AND s.name = l2_scene_members.scene_name
    )`).run(projectKeyOfFile(this.file))
    this.db.prepare(`DELETE FROM l2_scene_members WHERE project_key = ? AND scene_name IN (
      SELECT name FROM l2_scenes WHERE project_key = ? AND source_snapshot_dirty = 0 AND summary_frontier_ready = 0
    )`).run(projectKeyOfFile(this.file), projectKeyOfFile(this.file))
    this.db.prepare(`INSERT OR IGNORE INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
      SELECT s.project_key, s.name, CAST(member.value AS TEXT),
        CASE WHEN revision.type IN ('integer', 'real') THEN CAST(revision.value AS INTEGER) ELSE NULL END,
        CAST(member.key AS INTEGER)
      FROM l2_scenes s
      JOIN json_each(CASE WHEN json_valid(s.source_ids) THEN
        CASE WHEN json_type(s.source_ids) = 'array' THEN s.source_ids ELSE '[]' END ELSE '[]' END) member
      LEFT JOIN json_each(CASE WHEN json_valid(s.source_revisions) THEN
        CASE WHEN json_type(s.source_revisions) = 'object' THEN s.source_revisions ELSE '{}' END ELSE '{}' END) revision
        ON revision.key = CAST(member.value AS TEXT)
      WHERE s.project_key = ? AND s.source_snapshot_dirty = 0 AND s.summary_frontier_ready = 0`).run(projectKeyOfFile(this.file))
    for (const [column, definition] of [
      ['event_id', 'TEXT'], ['session_id', 'TEXT'], ['agent_id', 'TEXT'], ['agent_preset', 'TEXT'],
      ['provider', 'TEXT'], ['model', 'TEXT'], ['source', 'TEXT'], ['occurred_at', 'INTEGER'], ['source_id', 'TEXT'],
      ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'], ['cached_input_tokens', 'INTEGER'],
      ['cache_read_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'], ['reasoning_tokens', 'INTEGER'],
      ['cost_micros', 'INTEGER'], ['usage_known', 'INTEGER'], ['metadata', 'TEXT'],
    ] as const) this.ensureColumn('memory_events', column, definition)
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS l0_source_event_unique ON l0_messages(source_event_id) WHERE source_event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS memory_events_event_unique ON memory_events(event_id) WHERE event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS l0_fingerprint_idx ON l0_messages(project_key, fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS events_project_type_time ON memory_events(project_key, type, occurred_at);
      CREATE INDEX IF NOT EXISTS memory_events_association ON memory_events(project_key, type, source_id, created_at, id);
      CREATE TABLE IF NOT EXISTS l1_revisions (
        revision_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        scene TEXT,
        status TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        known_to INTEGER,
        valid_from INTEGER,
        valid_from_state TEXT NOT NULL DEFAULT 'known',
        valid_from_precision TEXT NOT NULL DEFAULT 'instant',
        valid_from_upper INTEGER,
        valid_from_basis TEXT NOT NULL DEFAULT 'default_record_time',
        valid_from_label TEXT,
        valid_to INTEGER,
        superseded_at INTEGER,
        source_message_ids TEXT NOT NULL DEFAULT '[]',
        source_verified INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        UNIQUE(memory_id, revision)
      );
      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(memory_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS memory_sources_source ON memory_sources(source_id, memory_id);
      CREATE INDEX IF NOT EXISTS l1_revisions_time ON l1_revisions(memory_id, valid_from, recorded_at);
      CREATE INDEX IF NOT EXISTS l1_revision_effective_lookup ON l1_revisions(memory_id, status, recorded_at, revision);
      CREATE TABLE IF NOT EXISTS revision_candidates (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        source_message_ids TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        kind TEXT,
        scene TEXT,
        valid_from INTEGER,
        valid_from_state TEXT NOT NULL DEFAULT 'known',
        valid_from_precision TEXT NOT NULL DEFAULT 'instant',
        valid_from_upper INTEGER,
        valid_from_basis TEXT NOT NULL DEFAULT 'default_record_time',
        valid_from_label TEXT,
        valid_to INTEGER,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        conflict_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS revision_candidates_status ON revision_candidates(status, created_at);
      CREATE TABLE IF NOT EXISTS extraction_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        policy_revision TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        quiet_until INTEGER NOT NULL,
        must_run_by INTEGER NOT NULL,
        source_ids TEXT NOT NULL,
        input_snapshot TEXT NOT NULL DEFAULT '[]',
        input_hash TEXT,
        attempt_id TEXT,
        response_text TEXT,
        usage_json TEXT,
        route_provider TEXT,
        route_model TEXT,
        agent_preset TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS extraction_jobs_queue ON extraction_jobs(status, must_run_by, quiet_until);
      CREATE TABLE IF NOT EXISTS extraction_job_sources (
        source_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        assigned_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extraction_job_sources_job ON extraction_job_sources(job_id, source_id);
      CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        evidence_ids TEXT NOT NULL DEFAULT '[]',
        from_revision INTEGER NOT NULL,
        to_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(from_id, to_id, relation_type)
      );
      CREATE INDEX IF NOT EXISTS memory_relations_from ON memory_relations(from_id);
      CREATE INDEX IF NOT EXISTS memory_relations_to ON memory_relations(to_id);
      CREATE TABLE IF NOT EXISTS relation_candidates (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        evidence_ids TEXT NOT NULL DEFAULT '[]',
        from_revision INTEGER NOT NULL,
        to_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate'
      );
      CREATE INDEX IF NOT EXISTS relation_candidates_status ON relation_candidates(status, created_at);
      CREATE TABLE IF NOT EXISTS task_contexts (
        task_ref TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        completed_json TEXT NOT NULL,
        pending_json TEXT NOT NULL,
        known_unknowns_json TEXT NOT NULL,
        confirmed_facts_json TEXT NOT NULL DEFAULT '[]',
        assumptions_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL,
        source_memory_ids TEXT NOT NULL,
        source_revisions TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_verified_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS experience_cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        symptom TEXT NOT NULL,
        environment_json TEXT NOT NULL,
        prerequisites_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        outcomes_json TEXT NOT NULL,
        counterexamples_json TEXT NOT NULL,
        evidence_memory_ids TEXT NOT NULL,
        source_revisions TEXT NOT NULL,
        status TEXT NOT NULL,
        independent_sources INTEGER NOT NULL,
        reviewed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS experiences_status ON experience_cards(status, updated_at);
      CREATE TABLE IF NOT EXISTS evaluation_cases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        query TEXT NOT NULL,
        expected_ids TEXT NOT NULL,
        forbidden_ids TEXT NOT NULL,
        fixture_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retrieval_strategies (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        base_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retrieval_strategies_status ON retrieval_strategies(status, updated_at);
      CREATE TABLE IF NOT EXISTS retrieval_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO retrieval_state(key, value) VALUES ('selected_strategy_id', 'builtin-v1');
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        pair_id TEXT,
        case_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        role TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evaluation_runs_strategy ON evaluation_runs(strategy_id, role, created_at);
      CREATE TABLE IF NOT EXISTS read_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        cache_generation INTEGER NOT NULL,
        control_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta(key, value) VALUES ('cache_generation', '1');
    `)
    this.ensureColumn('revision_candidates', 'kind', 'TEXT')
    this.ensureColumn('revision_candidates', 'scene', 'TEXT')
    this.ensureColumn('revision_candidates', 'valid_from', 'INTEGER')
    this.ensureColumn('revision_candidates', 'valid_from_state', "TEXT NOT NULL DEFAULT 'known'")
    this.ensureColumn('revision_candidates', 'valid_from_precision', "TEXT NOT NULL DEFAULT 'instant'")
    this.ensureColumn('revision_candidates', 'valid_from_upper', 'INTEGER')
    this.ensureColumn('revision_candidates', 'valid_from_basis', "TEXT NOT NULL DEFAULT 'default_record_time'")
    this.ensureColumn('revision_candidates', 'valid_from_label', 'TEXT')
    this.ensureColumn('revision_candidates', 'valid_to', 'INTEGER')
    for (const [column, definition] of [
      ['valid_from_state', "TEXT NOT NULL DEFAULT 'known'"], ['valid_from_precision', "TEXT NOT NULL DEFAULT 'instant'"],
      ['valid_from_upper', 'INTEGER'], ['valid_from_basis', "TEXT NOT NULL DEFAULT 'default_record_time'"], ['valid_from_label', 'TEXT'],
    ] as const) this.ensureColumn('l1_revisions', column, definition)
    const revisionColumns = this.db.prepare('PRAGMA table_info(l1_revisions)').all() as unknown as Array<{ name?: string; notnull?: number }>
    if (revisionColumns.find((column) => column.name === 'valid_from')?.notnull === 1) {
      this.db.exec(`
        DROP INDEX IF EXISTS l1_revisions_time;
        ALTER TABLE l1_revisions RENAME TO l1_revisions_legacy_time;
        CREATE TABLE l1_revisions (
          revision_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL,
          kind TEXT NOT NULL, scene TEXT, status TEXT NOT NULL, recorded_at INTEGER NOT NULL, known_to INTEGER,
          valid_from INTEGER, valid_from_state TEXT NOT NULL DEFAULT 'known', valid_from_precision TEXT NOT NULL DEFAULT 'instant',
          valid_from_upper INTEGER, valid_from_basis TEXT NOT NULL DEFAULT 'default_record_time', valid_from_label TEXT,
          valid_to INTEGER, superseded_at INTEGER, source_message_ids TEXT NOT NULL DEFAULT '[]',
          source_verified INTEGER NOT NULL DEFAULT 0, reason TEXT, UNIQUE(memory_id, revision)
        );
        INSERT INTO l1_revisions(revision_id, memory_id, revision, content, kind, scene, status, recorded_at, known_to,
          valid_from, valid_from_state, valid_from_precision, valid_from_upper, valid_from_basis, valid_from_label,
          valid_to, superseded_at, source_message_ids, source_verified, reason)
        SELECT revision_id, memory_id, revision, content, kind, scene, status, recorded_at, known_to,
          valid_from, valid_from_state, valid_from_precision, valid_from_upper, valid_from_basis, valid_from_label,
          valid_to, superseded_at, source_message_ids, source_verified, reason FROM l1_revisions_legacy_time;
        DROP TABLE l1_revisions_legacy_time;
      `)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS l1_revisions_time ON l1_revisions(memory_id, valid_from, recorded_at);
      CREATE INDEX IF NOT EXISTS l1_revision_effective_lookup ON l1_revisions(memory_id, status, recorded_at, revision);
      CREATE INDEX IF NOT EXISTS l1_revision_recorded_boundary ON l1_revisions(status, recorded_at, memory_id);
      CREATE INDEX IF NOT EXISTS l1_revision_start_boundary ON l1_revisions(status, valid_from, memory_id);
      CREATE INDEX IF NOT EXISTS l1_revision_end_boundary ON l1_revisions(status, valid_to, memory_id);`)
    this.ensureColumn('task_contexts', 'confirmed_facts_json', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('task_contexts', 'assumptions_json', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('task_contexts', 'blockers_json', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('task_contexts', 'last_verified_at', 'INTEGER')
    this.ensureColumn('extraction_jobs', 'route_provider', 'TEXT')
    this.ensureColumn('extraction_jobs', 'route_model', 'TEXT')
    this.ensureColumn('extraction_jobs', 'agent_preset', 'TEXT')
    this.ensureColumn('evaluation_runs', 'pair_id', 'TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS evaluation_runs_pair ON evaluation_runs(pair_id, created_at)')
    this.db.exec(`
      UPDATE l1_memories SET valid_from = COALESCE(valid_from, created_at), recorded_at = COALESCE(recorded_at, updated_at)
       WHERE valid_from_state = 'known';
      UPDATE l1_revisions SET valid_from = COALESCE(valid_from, recorded_at) WHERE valid_from_state = 'known';
      UPDATE revision_candidates SET valid_from = COALESCE(valid_from, created_at) WHERE valid_from_state = 'known';
      INSERT OR IGNORE INTO l1_revisions(revision_id, memory_id, revision, content, kind, scene, status, recorded_at, valid_from,
        valid_from_state, valid_from_precision, valid_from_upper, valid_from_basis, valid_from_label, valid_to, superseded_at,
        source_message_ids, source_verified)
      SELECT id || ':r' || revision, id, revision, content, kind, scene, status,
        COALESCE(recorded_at, updated_at, created_at), valid_from, valid_from_state, valid_from_precision, valid_from_upper,
        valid_from_basis, valid_from_label, valid_to, superseded_at, source_message_ids, source_verified FROM l1_memories;
    `)
    const sourceRows = this.db.prepare('SELECT id, source_message_ids, created_at FROM l1_memories').all() as Array<Record<string, unknown>>
    const linkSource = this.db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id, source_id, created_at) VALUES (?, ?, ?)')
    for (const row of sourceRows) {
      for (const sourceId of parseIds(row.source_message_ids)) linkSource.run(String(row.id), sourceId, Number(row.created_at ?? Date.now()))
    }
    this.db.prepare(
      `INSERT OR IGNORE INTO memory_events(project_key, type, count, tokens, raw_tokens, created_at, event_id, occurred_at, source_id, usage_known, metadata)
       SELECT project_key, 'initial_approval', 1, 0, 0, approved_at, 'initial-approval:' || id, approved_at, id, 0, '{"backfilled":true}'
       FROM l1_memories WHERE approved_at IS NOT NULL`,
    ).run()
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(MEMORY_SCHEMA_VERSION))
    this.db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
    this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name?: string }>
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private insertRevision(input: {
    memoryId: string; revision: number; content: string; kind: string; scene?: string; status: MemoryStatus;
    recordedAt: number; validFromInfo: EffectiveStart; validTo?: number; sourceMessageIds: string[]; sourceVerified: boolean; reason?: string
  }): void {
    this.db.prepare(
      `INSERT INTO l1_revisions(revision_id, memory_id, revision, content, kind, scene, status, recorded_at,
         valid_from, valid_from_state, valid_from_precision, valid_from_upper, valid_from_basis, valid_from_label,
         valid_to, source_message_ids, source_verified, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${input.memoryId}:r${input.revision}`, input.memoryId, input.revision, input.content, input.kind, input.scene ?? null,
      input.status, input.recordedAt, input.validFromInfo.value ?? null, input.validFromInfo.state, input.validFromInfo.precision,
      input.validFromInfo.upperExclusive ?? null, input.validFromInfo.basis, input.validFromInfo.label ?? null,
      input.validTo ?? null, JSON.stringify(input.sourceMessageIds),
      input.sourceVerified ? 1 : 0, input.reason ?? null,
    )
  }

  private invalidateCaches(): void {
    this.db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'cache_generation'").run()
    this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('cache_generation', '2')").run()
    this.db.prepare('DELETE FROM read_cache').run()
  }

  private rememberSources(memoryId: string, ids: string[], now = Date.now()): void {
    const statement = this.db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id, source_id, created_at) VALUES (?, ?, ?)')
    for (const sourceId of [...new Set(ids)]) statement.run(memoryId, sourceId, now)
  }

  cacheGeneration(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'cache_generation'").get() as { value?: string } | undefined
    return Number(row?.value ?? 1)
  }

  cachedRead<T>(key: string, controlSeq: number, now = Date.now()): T | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT value_json, cache_generation, control_seq, expires_at FROM read_cache WHERE cache_key = ?').get(key) as
      | { value_json?: string; cache_generation?: number; control_seq?: number; expires_at?: number }
      | undefined
    if (row === undefined || Number(row.expires_at ?? 0) <= now || Number(row.cache_generation ?? -1) !== this.cacheGeneration() || Number(row.control_seq ?? -1) !== controlSeq) {
      if (row !== undefined) this.db.prepare('DELETE FROM read_cache WHERE cache_key = ?').run(key)
      return undefined
    }
    try { return JSON.parse(String(row.value_json)) as T } catch { this.db.prepare('DELETE FROM read_cache WHERE cache_key = ?').run(key); return undefined }
  }

  cacheRead(key: string, value: unknown, controlSeq: number, ttlMs = 60_000, now = Date.now()): void {
    this.ensureOpen()
    this.db.prepare(
      `INSERT INTO read_cache(cache_key, value_json, cache_generation, control_seq, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, cache_generation = excluded.cache_generation,
       control_seq = excluded.control_seq, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    ).run(key, JSON.stringify(value), this.cacheGeneration(), controlSeq, now, now + Math.max(1000, Math.min(300_000, ttlMs)))
  }

  hasSourceMessages(ids: string[]): boolean {
    this.ensureOpen()
    if (ids.length === 0) return false
    const unique = [...new Set(ids)]
    const placeholders = unique.map(() => '?').join(',')
    const row = this.db.prepare(`SELECT COUNT(DISTINCT id) AS n FROM l0_messages WHERE id IN (${placeholders}) AND project_key = ?`)
      .get(...unique, projectKeyOfFile(this.file)) as { n?: number }
    return Number(row?.n ?? 0) === unique.length
  }

  extractionSourcesPending(jobId: string, sessionId: string, ids: string[]): boolean {
    this.ensureOpen()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return false
    const placeholders = unique.map(() => '?').join(', ')
    const owned = this.db.prepare(`SELECT COUNT(*) AS n FROM extraction_job_sources WHERE job_id = ? AND source_id IN (${placeholders})`)
      .get(jobId, ...unique) as { n?: number }
    if (Number(owned?.n ?? 0) !== unique.length) return false
    const pending = this.db.prepare(
      `SELECT COUNT(*) AS n FROM l0_messages WHERE project_key = ? AND session_id = ? AND id IN (${placeholders}) AND extracted_at IS NULL`,
    ).get(projectKeyOfFile(this.file), sessionId, ...unique) as { n?: number }
    return Number(pending?.n ?? 0) === unique.length
  }

  sourceMessages(ids: string[]): Array<{ id: string; content: string; role: string; sessionId: string; createdAt: number; sourceEventId?: string; origin: string; sourceKind: string; agentId?: string; agentPreset?: string; provider?: string; model?: string }> {
    this.ensureOpen()
    if (ids.length === 0) return []
    const unique = [...new Set(ids)].slice(0, 100)
    const placeholders = unique.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT id, content, role, session_id, created_at, source_event_id, origin, source_kind, agent_id, agent_preset, provider, model
       FROM l0_messages WHERE project_key = ? AND id IN (${placeholders})`,
    ).all(projectKeyOfFile(this.file), ...unique) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id), content: String(row.content), role: String(row.role), sessionId: String(row.session_id), createdAt: Number(row.created_at),
      ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
      origin: String(row.origin ?? 'dsh-session'), sourceKind: String(row.source_kind ?? 'conversation'),
      ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}),
      ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}),
      ...(typeof row.provider === 'string' ? { provider: row.provider } : {}),
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
    }))
  }

  sourceReadMetadata(ids: string[]): Array<{ id: string; sourceEventId?: string; agentPreset?: string }> {
    this.ensureOpen()
    const unique = [...new Set(ids)]
    const sources: Array<{ id: string; sourceEventId?: string; agentPreset?: string }> = []
    for (let offset = 0; offset < unique.length; offset += 200) {
      const batch = unique.slice(offset, offset + 200)
      const rows = this.db.prepare(`SELECT id, source_event_id, agent_preset FROM l0_messages
        WHERE project_key = ? AND id IN (${batch.map(() => '?').join(',')})`).all(projectKeyOfFile(this.file), ...batch) as Array<Record<string, unknown>>
      sources.push(...rows.map((row) => ({ id: String(row.id), ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
        ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}) })))
    }
    return sources
  }

  sourceIdentity(sourceId: string): { id: string; sourceEventId?: string; origin: string; sourceKind: string; sessionId: string } | undefined {
    this.ensureOpen()
    const projectKey = projectKeyOfFile(this.file)
    const row = this.db.prepare('SELECT id, source_event_id, origin, source_kind, session_id FROM l0_messages WHERE project_key = ? AND id = ?')
      .get(projectKey, sourceId) as Record<string, unknown> | undefined
    if (row !== undefined) return { id: String(row.id), ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
      origin: String(row.origin ?? 'dsh-session'), sourceKind: String(row.source_kind ?? 'conversation'), sessionId: String(row.session_id) }

    // L0 retention removes message bodies and identity columns, but capture
    // audit rows intentionally retain the stable host-event mapping.
    const captured = this.db.prepare(`SELECT event_id, source, session_id, metadata FROM memory_events
      WHERE project_key = ? AND source_id = ? AND source = 'dsh-session' ORDER BY created_at DESC LIMIT 20`)
      .all(projectKey, sourceId) as Array<Record<string, unknown>>
    for (const item of captured) {
      const eventId = typeof item.event_id === 'string' ? item.event_id : ''
      if (!eventId.startsWith('capture:') || eventId.length <= 'capture:'.length) continue
      const sourceEventId = eventId.slice('capture:'.length)
      if (sourceEventId === sourceId) continue
      let metadata: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(String(item.metadata ?? '{}')) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
      } catch { /* identity remains usable; optional source kind defaults below */ }
      return { id: sourceId, sourceEventId, origin: 'dsh-session',
        sourceKind: typeof metadata.sourceKind === 'string' ? metadata.sourceKind : 'conversation',
        sessionId: typeof item.session_id === 'string' ? item.session_id : '' }
    }
    return undefined
  }

  sourceIdentities(sourceIds: string[]): Map<string, { id: string; sourceEventId?: string; origin: string; sourceKind: string; sessionId: string }> {
    this.ensureOpen()
    const unique = [...new Set(sourceIds)].filter((id) => id !== '')
    const identities = new Map<string, { id: string; sourceEventId?: string; origin: string; sourceKind: string; sessionId: string }>()
    const projectKey = projectKeyOfFile(this.file)
    for (let offset = 0; offset < unique.length; offset += 200) {
      const batch = unique.slice(offset, offset + 200)
      const rows = this.db.prepare(`SELECT id, source_event_id, origin, source_kind, session_id FROM l0_messages
        WHERE project_key = ? AND id IN (${batch.map(() => '?').join(',')})`).all(projectKey, ...batch) as Array<Record<string, unknown>>
      for (const row of rows) {
        const id = String(row.id)
        identities.set(id, { id, ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
          origin: String(row.origin ?? 'dsh-session'), sourceKind: String(row.source_kind ?? 'conversation'), sessionId: String(row.session_id) })
      }
    }
    // Retained audit mappings cover L0 rows removed by retention. Keep the
    // same newest-20-row search per source, but fetch those rows in bounded batches.
    const missing = unique.filter((id) => !identities.has(id))
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100)
      const rows = this.db.prepare(`SELECT * FROM (
          SELECT source_id, event_id, session_id, metadata,
            ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC) AS row_ordinal
          FROM memory_events WHERE project_key = ? AND source = 'dsh-session' AND source_id IN (${batch.map(() => '?').join(',')})
        ) WHERE row_ordinal <= 20 ORDER BY source_id ASC, row_ordinal ASC`).all(projectKey, ...batch) as Array<Record<string, unknown>>
      for (const item of rows) {
        const id = String(item.source_id)
        if (identities.has(id)) continue
        const eventId = typeof item.event_id === 'string' ? item.event_id : ''
        if (!eventId.startsWith('capture:') || eventId.length <= 'capture:'.length) continue
        const sourceEventId = eventId.slice('capture:'.length)
        if (sourceEventId === id) continue
        let metadata: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(String(item.metadata ?? '{}')) as unknown
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
        } catch { /* identity remains usable; optional source kind defaults below */ }
        identities.set(id, { id, sourceEventId, origin: 'dsh-session',
          sourceKind: typeof metadata.sourceKind === 'string' ? metadata.sourceKind : 'conversation',
          sessionId: typeof item.session_id === 'string' ? item.session_id : '' })
      }
    }
    return identities
  }

  sourceIdsForMemory(memoryId: string): string[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_id').all(memoryId) as Array<{ source_id?: string }>
    return rows.flatMap((row) => typeof row.source_id === 'string' ? [row.source_id] : [])
  }

  extractionJobsForSources(sourceIds: string[]): Array<{ id: string; sourceIds: string[]; attemptId?: string; status: ExtractionJob['status'] }> {
    this.ensureOpen()
    const unique = [...new Set(sourceIds)]
    if (unique.length === 0) return []
    const rows = this.db.prepare(`SELECT j.id, j.source_ids, j.attempt_id, j.status FROM extraction_jobs j
      WHERE EXISTS (SELECT 1 FROM json_each(j.source_ids) source WHERE source.value IN (SELECT value FROM json_each(?)))`)
      .all(JSON.stringify(unique)) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), sourceIds: parseIds(row.source_ids),
      ...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}), status: String(row.status) as ExtractionJob['status'] }))
  }

  extractionJobsForMemories(memoryIds: string[]): Array<{ id: string; sourceIds: string[]; attemptId?: string; status: ExtractionJob['status'] }> {
    this.ensureOpen()
    const unique = [...new Set(memoryIds)]
    if (unique.length === 0) return []
    const rows = this.db.prepare(`SELECT DISTINCT j.id, j.source_ids, j.attempt_id, j.status FROM extraction_jobs j
      JOIN extraction_job_sources js ON js.job_id = j.id
      JOIN memory_sources ms ON ms.source_id = js.source_id
      JOIN l1_memories m ON m.id = ms.memory_id
      WHERE m.project_key = ? AND m.id IN (${unique.map(() => '?').join(',')}) ORDER BY j.id`)
      .all(projectKeyOfFile(this.file), ...unique) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), sourceIds: parseIds(row.source_ids),
      ...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}), status: String(row.status) as ExtractionJob['status'] }))
  }

  revokeSourcesFromExtractionJobs(sourceIds: string[], now = Date.now()): Array<{ id: string; sourceIds: string[]; revokedSourceIds: string[]; attemptId?: string; status: ExtractionJob['status'] }> {
    this.ensureOpen()
    const revoked = new Set(sourceIds)
    if (revoked.size === 0) return []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const affected = this.extractionJobsForSources([...revoked])
      const output = affected.map((job) => ({ ...job, revokedSourceIds: job.sourceIds.filter((id) => revoked.has(id)) }))
      const detach = this.db.prepare('DELETE FROM extraction_job_sources WHERE job_id = ? AND source_id = ?')
      const retire = this.db.prepare('UPDATE l0_messages SET extracted_at = COALESCE(extracted_at, ?) WHERE project_key = ? AND id = ?')
      for (const job of output) {
        for (const sourceId of job.revokedSourceIds) detach.run(job.id, sourceId)
        for (const sourceId of job.revokedSourceIds) retire.run(now, projectKeyOfFile(this.file), sourceId)
        const remaining = job.sourceIds.filter((id) => !revoked.has(id))
        const chargedOrSent = job.attemptId !== undefined || ['dispatching', 'result_ready', 'uncertain_remote', 'blocked_charged'].includes(job.status)
        if (chargedOrSent) {
          const terminal = job.status === 'completed' || job.status === 'blocked_charged' ? job.status : 'blocked_charged'
          this.db.prepare(`UPDATE extraction_jobs SET status = ?, error = 'source_revoked_paid_lineage_retained', input_snapshot = '[]',
            response_text = NULL, updated_at = ? WHERE id = ?`).run(terminal, now, job.id)
        } else if (remaining.length > 0) {
          // An unsent job can continue with still-owned siblings after removing
          // the revoked source from both the request set and its owner rows.
          this.db.prepare(`UPDATE extraction_jobs SET status = 'queued', source_ids = ?, input_snapshot = '[]', input_hash = NULL,
            response_text = NULL, error = 'revoked_source_removed_before_dispatch', updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(remaining), now, job.id)
        } else {
          this.db.prepare(`UPDATE extraction_jobs SET status = 'source_pruned', error = 'source_revoked', input_snapshot = '[]',
            response_text = NULL, updated_at = ? WHERE id = ?`).run(now, job.id)
        }
      }
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return output
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  managedContentInventory(limit = 500): MemoryRecord[] {
    this.ensureOpen()
    return this.allRecords(Math.max(1, Math.min(2000, Math.floor(limit))))
  }

  managedSourceInventory(limit = 500): Array<{ id: string; role: string; preview: string; createdAt: number; origin: string; sourceKind: string }> {
    this.ensureOpen()
    const rows = this.db.prepare(`SELECT id, role, substr(content, 1, 180) AS preview, created_at, origin, source_kind
      FROM l0_messages WHERE project_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(projectKeyOfFile(this.file), Math.max(1, Math.min(2000, Math.floor(limit)))) as Array<Record<string, unknown>>
    return rows.flatMap((row) => typeof row.id === 'string' ? [{ id: row.id, role: String(row.role ?? 'unknown'), preview: String(row.preview ?? ''),
      createdAt: Number(row.created_at ?? 0), origin: String(row.origin ?? 'dsh-session'), sourceKind: String(row.source_kind ?? 'conversation') }] : [])
  }

  managedDeletionPlan(input: { memoryIds: string[]; sourceIds: string[]; expandSelectedMemorySources?: boolean }): {
    memoryIds: string[]; sourceIds: string[]; selectedMemoryCount: number; derivedMemoryCount: number;
    revisionCount: number; rawSourceCount: number; missingSourceCount: number; relatedExtractionJobs: Array<{ id: string; status: ExtractionJob['status']; attemptId?: string }>;
    relationCount: number; taskContextCount: number; experienceCount: number; personaAffected: boolean; sceneCount: number; evaluationCaseCount: number; evaluationRunCount: number;
  } {
    this.ensureOpen()
    const selected = [...new Set(input.memoryIds)].sort()
    const memoryIds = new Set(selected)
    const sourceIds = new Set([...new Set(input.sourceIds)])
    if (selected.length > 1000 || sourceIds.size > 5000 || [...selected, ...sourceIds].some((id) => id === '' || id.length > 200)) throw new Error('managed deletion selection exceeds its bounded limits')
    for (const id of selected) if (this.get(id) === undefined) throw new Error(`memory is not available in the selected project: ${id}`)
    const referencedBySources = (ids: string[]): string[] => {
      const references: string[] = []
      for (let index = 0; index < ids.length; index += 200) {
        references.push(...this.sourceMemoryReferences(ids.slice(index, index + 200)).map((item) => item.memoryId))
      }
      return references
    }
    // Expand raw sources only from memories the user explicitly selected. A
    // source-only or shared-source-dependent memory is itself deleted, while
    // its other independent L0 sources remain intact for unrelated memories.
    if (input.expandSelectedMemorySources !== false) {
      for (const id of selected) for (const sourceId of this.sourceIdsForMemory(id)) sourceIds.add(sourceId)
    }
    if (sourceIds.size > 5000) throw new Error('managed deletion impact exceeds the 5000-source safety limit')
    for (const referencedId of referencedBySources([...sourceIds])) memoryIds.add(referencedId)
    if (memoryIds.size > 1000) throw new Error('managed deletion impact exceeds the 1000-memory safety limit')
    // If a selected source only supported a dependency edge, deleting that edge
    // must not make its derived memory readable again after the edge disappears.
    const dependencyRows = this.db.prepare(`SELECT from_id, to_id, evidence_ids FROM memory_relations
      WHERE relation_type IN ('depends_on','derived_from') ORDER BY id LIMIT 5001`).all() as Array<Record<string, unknown>>
    if (dependencyRows.length > 5000) throw new Error('managed deletion dependency graph exceeds the 5000-relation safety limit')
    const evidenceAffected = new Set<string>()
    for (const row of dependencyRows) {
      const memoryId = String(row.from_id ?? '')
      if (memoryId !== '' && parseIds(row.evidence_ids).some((id) => sourceIds.has(id)) && this.get(memoryId) !== undefined) evidenceAffected.add(memoryId)
    }
    let addedEvidenceDescendant = true
    while (addedEvidenceDescendant) {
      addedEvidenceDescendant = false
      for (const row of dependencyRows) {
        const childId = String(row.from_id ?? '')
        const dependencyId = String(row.to_id ?? '')
        if (!evidenceAffected.has(dependencyId) || childId === '' || evidenceAffected.has(childId) || this.get(childId) === undefined) continue
        evidenceAffected.add(childId)
        addedEvidenceDescendant = true
        if (evidenceAffected.size > 1000) throw new Error('managed deletion relation-evidence impact exceeds the 1000-memory safety limit')
      }
    }
    for (const id of evidenceAffected) memoryIds.add(id)
    if (memoryIds.size > 1000) throw new Error('managed deletion impact exceeds the 1000-memory safety limit')
    // Deleting a memory or dependency must also delete derived descendants. Do not add
    // their independent source messages to the raw-source deletion set.
    let addedDescendant = true
    while (addedDescendant) {
      addedDescendant = false
      for (const row of dependencyRows) {
        const childId = String(row.from_id ?? '')
        const dependencyId = String(row.to_id ?? '')
        if (!memoryIds.has(dependencyId) || childId === '' || memoryIds.has(childId) || this.get(childId) === undefined) continue
        memoryIds.add(childId)
        addedDescendant = true
        if (memoryIds.size > 1000) throw new Error('managed deletion dependency impact exceeds the 1000-memory safety limit')
      }
    }
    const memories = [...memoryIds].sort()
    const sources = [...sourceIds].sort()
    const revisionCount = memories.length === 0 ? 0 : Number((this.db.prepare(`SELECT COUNT(*) AS n FROM l1_revisions WHERE memory_id IN (${memories.map(() => '?').join(',')})`)
      .get(...memories) as { n?: number }).n ?? 0)
    const rawSourceCount = sources.length === 0 ? 0 : Number((this.db.prepare(`SELECT COUNT(*) AS n FROM l0_messages WHERE project_key = ? AND id IN (${sources.map(() => '?').join(',')})`)
      .get(projectKeyOfFile(this.file), ...sources) as { n?: number }).n ?? 0)
    const projectKey = projectKeyOfFile(this.file)
    const relatedJobs = new Map<string, ReturnType<MemoryStore['extractionJobsForSources']>[number]>()
    for (const job of [...this.extractionJobsForSources(sources), ...this.extractionJobsForMemories(memories)]) relatedJobs.set(job.id, job)
    const relatedExtractionJobs = [...relatedJobs.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, status, attemptId }) => ({ id, status, ...(attemptId === undefined ? {} : { attemptId }) }))
    const relationRows = this.db.prepare('SELECT from_id, to_id, evidence_ids FROM memory_relations').all() as Array<Record<string, unknown>>
    const candidateRows = this.db.prepare('SELECT from_id, to_id, evidence_ids FROM relation_candidates').all() as Array<Record<string, unknown>>
    const affectedRelations = [...relationRows, ...candidateRows].filter((row) => memoryIds.has(String(row.from_id)) || memoryIds.has(String(row.to_id)) ||
      parseIds(row.evidence_ids).some((id) => sourceIds.has(id))).length
    const taskRows = this.db.prepare('SELECT source_memory_ids FROM task_contexts').all() as Array<Record<string, unknown>>
    const taskContextCount = taskRows.filter((row) => parseIds(row.source_memory_ids).some((id) => memoryIds.has(id))).length
    const experienceRows = this.db.prepare('SELECT evidence_memory_ids FROM experience_cards').all() as Array<Record<string, unknown>>
    const experienceCount = experienceRows.filter((row) => parseIds(row.evidence_memory_ids).some((id) => memoryIds.has(id))).length
    const affectedScenes = new Set<string>()
    for (let offset = 0; offset < memories.length; offset += 100) {
      const batch = memories.slice(offset, offset + 100)
      const sceneRows = this.db.prepare(`SELECT DISTINCT scene_name FROM l2_scene_members
        WHERE project_key = ? AND memory_id IN (${batch.map(() => '?').join(',')})`)
        .all(projectKeyOfFile(this.file), ...batch) as Array<Record<string, unknown>>
      for (const row of sceneRows) if (typeof row.scene_name === 'string') affectedScenes.add(row.scene_name)
    }
    const sceneCount = affectedScenes.size
    const persona = this.db.prepare('SELECT source_ids FROM l3_persona WHERE project_key = ?').get(projectKeyOfFile(this.file)) as Record<string, unknown> | undefined
    const personaAffected = persona !== undefined && parseIds(persona.source_ids).some((id) => memoryIds.has(id))
    const evaluationCases = this.db.prepare('SELECT id, expected_ids, forbidden_ids FROM evaluation_cases').all() as Array<Record<string, unknown>>
    const affectedEvaluationCaseIds = new Set(evaluationCases.flatMap((row) => [...parseIds(row.expected_ids), ...parseIds(row.forbidden_ids)].some((id) => memoryIds.has(id))
      ? [String(row.id)] : []))
    const evaluationCaseCount = affectedEvaluationCaseIds.size
    const evaluationRuns = this.db.prepare('SELECT id, pair_id, case_id, result_json FROM evaluation_runs').all() as Array<Record<string, unknown>>
    const affectedEvaluationPairs = new Set<string>()
    const affectedEvaluationRunIds = new Set<string>()
    for (const row of evaluationRuns) {
      if (typeof row.id !== 'string' || (!affectedEvaluationCaseIds.has(String(row.case_id)) &&
          !evaluationRunMentionsMemory(row.result_json, memoryIds, projectKey))) continue
      if (typeof row.pair_id === 'string') affectedEvaluationPairs.add(row.pair_id)
      else affectedEvaluationRunIds.add(row.id)
    }
    const evaluationRunCount = evaluationRuns.filter((row) => typeof row.id === 'string' &&
      (affectedEvaluationRunIds.has(row.id) || (typeof row.pair_id === 'string' && affectedEvaluationPairs.has(row.pair_id)))).length
    return { memoryIds: memories, sourceIds: sources, selectedMemoryCount: selected.length, derivedMemoryCount: Math.max(0, memories.length - selected.length),
      revisionCount, rawSourceCount, missingSourceCount: Math.max(0, sources.length - rawSourceCount), relatedExtractionJobs,
      relationCount: affectedRelations, taskContextCount, experienceCount, personaAffected, sceneCount, evaluationCaseCount, evaluationRunCount }
  }

  purgeManagedContent(input: { memoryIds: string[]; sourceIds: string[]; now?: number }): { memories: number; sources: number; extractionJobs: number; derivedRows: number } {
    this.ensureOpen()
    const memoryIds = [...new Set(input.memoryIds)]
    const sourceIds = [...new Set(input.sourceIds)]
    if (memoryIds.length > 1000 || sourceIds.length > 5000) throw new Error('managed content purge exceeds its bounded limits')
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const sourceJobs = this.extractionJobsForSources(sourceIds)
      const outputJobs = this.extractionJobsForMemories(memoryIds)
      const jobs = new Map<string, ReturnType<MemoryStore['extractionJobsForSources']>[number]>()
      for (const job of [...sourceJobs, ...outputJobs]) jobs.set(job.id, job)
      const redactSourceJob = this.db.prepare(`UPDATE extraction_jobs SET
        status = CASE WHEN status IN ('queued','ready') THEN 'source_pruned'
                      WHEN status IN ('result_ready','dispatching','uncertain_remote') THEN 'blocked_charged'
                      ELSE status END,
        error = CASE WHEN status IN ('completed','failed','blocked_charged') THEN error ELSE 'content_deleted' END,
        input_snapshot = '[]', response_text = NULL, updated_at = ? WHERE id = ?`)
      for (const job of sourceJobs) redactSourceJob.run(now, job.id)
      const sourceJobIds = new Set(sourceJobs.map((job) => job.id))
      const redactGeneratedOutput = this.db.prepare('UPDATE extraction_jobs SET response_text = NULL, updated_at = ? WHERE id = ?')
      for (const job of outputJobs) if (!sourceJobIds.has(job.id)) redactGeneratedOutput.run(now, job.id)
      const memorySet = new Set(memoryIds)
      const sourceSet = new Set(sourceIds)
      const relationRows = this.db.prepare('SELECT id, from_id, to_id, evidence_ids FROM memory_relations').all() as Array<Record<string, unknown>>
      const removeRelation = this.db.prepare('DELETE FROM memory_relations WHERE id = ?')
      let derivedRows = 0
      for (const row of relationRows) if (memorySet.has(String(row.from_id)) || memorySet.has(String(row.to_id)) || parseIds(row.evidence_ids).some((id) => sourceSet.has(id))) {
        removeRelation.run(String(row.id)); derivedRows += 1
      }
      const revisionCandidates = this.db.prepare('SELECT id, memory_id, source_message_ids FROM revision_candidates').all() as Array<Record<string, unknown>>
      for (const row of revisionCandidates) if (memorySet.has(String(row.memory_id)) || parseIds(row.source_message_ids).some((id) => sourceSet.has(id))) {
        this.db.prepare('DELETE FROM revision_candidates WHERE id = ?').run(String(row.id)); derivedRows += 1
      }
      const candidateRows = this.db.prepare('SELECT id, from_id, to_id, evidence_ids FROM relation_candidates').all() as Array<Record<string, unknown>>
      const removeCandidate = this.db.prepare('DELETE FROM relation_candidates WHERE id = ?')
      for (const row of candidateRows) if (memorySet.has(String(row.from_id)) || memorySet.has(String(row.to_id)) || parseIds(row.evidence_ids).some((id) => sourceSet.has(id))) {
        removeCandidate.run(String(row.id)); derivedRows += 1
      }
      for (const [table, field] of [['task_contexts', 'source_memory_ids'], ['experience_cards', 'evidence_memory_ids']] as const) {
        const rows = this.db.prepare(`SELECT rowid, ${field} AS sources FROM ${table}`).all() as Array<Record<string, unknown>>
        const remove = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`)
        for (const row of rows) if (parseIds(row.sources).some((id) => memorySet.has(id))) { remove.run(Number(row.rowid)); derivedRows += 1 }
      }
      const evaluationCases = this.db.prepare('SELECT id, expected_ids, forbidden_ids FROM evaluation_cases').all() as Array<Record<string, unknown>>
      const affectedEvaluationCaseIds = evaluationCases.flatMap((row) => [...parseIds(row.expected_ids), ...parseIds(row.forbidden_ids)].some((id) => memorySet.has(id))
        ? [String(row.id)] : [])
      if (affectedEvaluationCaseIds.length > 0) {
        const marks = affectedEvaluationCaseIds.map(() => '?').join(',')
        derivedRows += Number(this.db.prepare(`DELETE FROM evaluation_runs WHERE case_id IN (${marks})`).run(...affectedEvaluationCaseIds).changes ?? 0)
        derivedRows += Number(this.db.prepare(`DELETE FROM evaluation_cases WHERE id IN (${marks})`).run(...affectedEvaluationCaseIds).changes ?? 0)
      }
      const evaluationRuns = this.db.prepare('SELECT id, pair_id, result_json FROM evaluation_runs').all() as Array<Record<string, unknown>>
      const affectedPairs = new Set<string>()
      const affectedRuns = new Set<string>()
      for (const row of evaluationRuns) {
        if (typeof row.id !== 'string' || !evaluationRunMentionsMemory(row.result_json, memorySet, projectKeyOfFile(this.file))) continue
        if (typeof row.pair_id === 'string') affectedPairs.add(row.pair_id)
        else affectedRuns.add(row.id)
      }
      for (const pairId of affectedPairs) {
        derivedRows += Number(this.db.prepare('DELETE FROM evaluation_runs WHERE pair_id = ?').run(pairId).changes ?? 0)
      }
      for (const id of affectedRuns) {
        derivedRows += Number(this.db.prepare('DELETE FROM evaluation_runs WHERE id = ?').run(id).changes ?? 0)
      }
      if (memoryIds.length > 0) {
        const sceneNames = new Set<string>()
        for (let offset = 0; offset < memoryIds.length; offset += 100) {
          const batch = memoryIds.slice(offset, offset + 100)
          const sceneRows = this.db.prepare(`SELECT DISTINCT scene_name FROM l2_scene_members
            WHERE project_key = ? AND memory_id IN (${batch.map(() => '?').join(',')})`)
            .all(projectKeyOfFile(this.file), ...batch) as Array<Record<string, unknown>>
          for (const row of sceneRows) if (typeof row.scene_name === 'string') sceneNames.add(row.scene_name)
        }
        for (const sceneName of sceneNames) {
          this.db.prepare('DELETE FROM l2_scene_members WHERE project_key = ? AND scene_name = ?').run(projectKeyOfFile(this.file), sceneName)
          this.db.prepare('DELETE FROM l2_scenes WHERE project_key = ? AND name = ?').run(projectKeyOfFile(this.file), sceneName)
          derivedRows += 1
        }
      }
      const persona = this.db.prepare('SELECT source_ids FROM l3_persona WHERE project_key = ?').get(projectKeyOfFile(this.file)) as Record<string, unknown> | undefined
      if (persona !== undefined && parseIds(persona.source_ids).some((id) => memorySet.has(id))) {
        this.db.prepare('DELETE FROM l3_persona WHERE project_key = ?').run(projectKeyOfFile(this.file)); derivedRows += 1
      }
      if (memoryIds.length > 0) {
        const marks = memoryIds.map(() => '?').join(',')
        if (this.ftsAvailable) this.db.prepare(`DELETE FROM l1_fts WHERE record_id IN (${marks})`).run(...memoryIds)
        this.db.prepare(`DELETE FROM memory_sources WHERE memory_id IN (${marks})`).run(...memoryIds)
        this.db.prepare(`DELETE FROM l1_revisions WHERE memory_id IN (${marks})`).run(...memoryIds)
        this.db.prepare(`DELETE FROM revision_candidates WHERE memory_id IN (${marks})`).run(...memoryIds)
        this.db.prepare(`DELETE FROM l1_memories WHERE project_key = ? AND id IN (${marks})`).run(projectKeyOfFile(this.file), ...memoryIds)
      }
      let sources = 0
      if (sourceIds.length > 0) {
        const marks = sourceIds.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM extraction_job_sources WHERE source_id IN (${marks})`).run(...sourceIds)
        this.db.prepare(`DELETE FROM memory_sources WHERE source_id IN (${marks})`).run(...sourceIds)
        sources = Number(this.db.prepare(`DELETE FROM l0_messages WHERE project_key = ? AND id IN (${marks})`).run(projectKeyOfFile(this.file), ...sourceIds).changes ?? 0)
      }
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return { memories: memoryIds.length, sources, extractionJobs: jobs.size, derivedRows }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  sourceMemoryReferences(ids: string[]): Array<{ sourceId: string; memoryId: string }> {
    this.ensureOpen()
    const unique = [...new Set(ids)].slice(0, 200)
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT source_id, memory_id FROM memory_sources WHERE source_id IN (${placeholders}) ORDER BY source_id, memory_id`)
      .all(...unique) as Array<Record<string, unknown>>
    return rows.flatMap((row) => typeof row.source_id === 'string' && typeof row.memory_id === 'string'
      ? [{ sourceId: row.source_id, memoryId: row.memory_id }] : [])
  }

  get hasFts(): boolean {
    return this.ftsAvailable
  }

  recordL0(input: L0MessageInput): string {
    return this.captureMessage(input).id
  }

  captureMessage(input: L0MessageInput): { id: string; created: boolean } {
    this.ensureOpen()
    if (input.originalMessageIdentity !== undefined && !isOriginalMessageIdentity(input.originalMessageIdentity)) {
      throw new Error('original message identity is invalid')
    }
    const content = input.content.replace(/\s+/g, ' ').trim()
    if (content === '') throw new Error('L0 content is empty')
    const createdAt = input.createdAt ?? Date.now()
    const recordedAt = input.recordedAt ?? Date.now()
    const id = `l0_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const eventId = input.sourceEventId ?? null
    const fingerprint = input.role === 'user'
      ? createHash('sha256').update(`${projectKeyOfFile(this.file)}\0${content.normalize('NFC')}`).digest('hex')
      : null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(
        `INSERT OR IGNORE INTO l0_messages(id, project_key, session_id, role, content, turn, step, created_at,
           source_event_id, origin, source_kind, derived_from, agent_id, agent_preset, provider, model, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, projectKeyOfFile(this.file), input.sessionId, input.role, content, input.turn ?? null, input.step ?? null, createdAt,
        eventId, input.origin ?? 'dsh-session', input.sourceKind ?? 'conversation', JSON.stringify(input.derivedFrom ?? []),
        input.agentId ?? null, input.agentPreset ?? null, input.provider ?? null, input.model ?? null, fingerprint,
      )
      const row = eventId === null ? undefined : this.db.prepare('SELECT * FROM l0_messages WHERE source_event_id = ?').get(eventId) as Record<string, unknown> | undefined
      const actualId = typeof row?.id === 'string' ? row.id : id
      if (row !== undefined) {
        const exactReplay = row.project_key === projectKeyOfFile(this.file) && row.session_id === input.sessionId && row.role === input.role &&
          row.content === content && row.source_kind === (input.sourceKind ?? 'conversation') && row.origin === (input.origin ?? 'dsh-session') &&
          (row.turn ?? null) === (input.turn ?? null) && (row.step ?? null) === (input.step ?? null) && Number(row.created_at) === createdAt &&
          (row.agent_preset ?? null) === (input.agentPreset ?? null) && (row.provider ?? null) === (input.provider ?? null) &&
          (row.model ?? null) === (input.model ?? null) && String(row.derived_from ?? '[]') === JSON.stringify(input.derivedFrom ?? [])
        if (!exactReplay) throw new Error('capture event id was replayed with a different source payload')
      }
      const created = Number(result.changes ?? 0) > 0
      if (input.skipExtractionReason !== undefined) {
        this.db.prepare('UPDATE l0_messages SET extracted_at = COALESCE(extracted_at, ?) WHERE id = ?').run(createdAt, actualId)
      }
      this.appendEventInTransaction({
        eventId: eventId === null ? `capture:${actualId}` : `capture:${eventId}`,
        type: 'capture', sessionId: input.sessionId, source: input.origin ?? 'dsh-session',
        sourceId: actualId, agentId: input.agentId, agentPreset: input.agentPreset,
        provider: input.provider, model: input.model, occurredAt: createdAt, count: 1,
        metadata: {
          role: input.role,
          sourceKind: input.sourceKind ?? 'conversation',
          ...(input.originalMessageIdentity === undefined ? {} : { originalMessageIdentity: input.originalMessageIdentity }),
        },
      }, recordedAt)
      if (input.skipExtractionReason !== undefined) this.appendEventInTransaction({
        eventId: `skip:${eventId ?? actualId}`, type: 'skipped_nonmemory', count: 1, sessionId: input.sessionId,
        agentId: input.agentId, agentPreset: input.agentPreset, provider: input.provider, model: input.model,
        source: 'small_talk', sourceId: actualId, occurredAt: createdAt, metadata: { reason: input.skipExtractionReason },
      }, recordedAt)
      if (created) this.invalidateCaches()
      this.db.exec('COMMIT')
      return { id: actualId, created }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** L0 rows that have not been consumed by a successful extraction pass, oldest first. */
  unextracted(sessionId: string, limit = 24): Array<{ id: string; role: string; content: string; createdAt: number; sourceEventId?: string }> {
    this.ensureOpen()
    const rows = this.db
      .prepare(
        `SELECT id, role, content, created_at, source_event_id FROM l0_messages
         WHERE session_id = ? AND extracted_at IS NULL ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(sessionId, Math.max(1, Math.min(100, limit))) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      role: String(row.role),
      content: String(row.content),
      createdAt: Number(row.created_at ?? 0),
      ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
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

  enqueueExtractionJob(input: { sessionId: string; sourceId: string; policyRevision: string; quietMs: number; maxWaitMs: number; now?: number }): ExtractionJob {
    this.ensureOpen()
    const now = input.now ?? Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const source = this.db.prepare('SELECT created_at, extracted_at, provider, model, agent_preset FROM l0_messages WHERE id = ? AND project_key = ? AND session_id = ?')
        .get(input.sourceId, projectKeyOfFile(this.file), input.sessionId) as { created_at?: number; extracted_at?: number | null; provider?: string | null; model?: string | null; agent_preset?: string | null } | undefined
      if (source === undefined) throw new Error('cannot queue extraction: source is missing or outside the session scope')
      if (source.extracted_at !== null && source.extracted_at !== undefined) throw new Error('cannot queue extraction: source was already consumed')
      const owner = this.db.prepare('SELECT job_id FROM extraction_job_sources WHERE source_id = ?').get(input.sourceId) as { job_id?: string } | undefined
      if (typeof owner?.job_id === 'string') {
        const existing = this.getExtractionJob(owner.job_id)
        if (existing !== undefined) {
          this.db.exec('COMMIT')
          return existing
        }
        this.db.prepare('DELETE FROM extraction_job_sources WHERE source_id = ?').run(input.sourceId)
      }
      const current = this.db.prepare(
        `SELECT * FROM extraction_jobs WHERE session_id = ? AND policy_revision = ? AND status = 'queued'
         AND route_provider IS ? AND route_model IS ? AND agent_preset IS ? ORDER BY created_at ASC LIMIT 1`,
      ).get(input.sessionId, input.policyRevision, source.provider ?? null, source.model ?? null, source.agent_preset ?? null) as Record<string, unknown> | undefined
      const quietUntil = now + Math.max(0, input.quietMs)
      if (current !== undefined) {
        const job = toExtractionJob(current)
        const sourceIds = [...new Set([...job.sourceIds, input.sourceId])]
        if (sourceIds.length > 24) throw new Error('extraction jobs are limited to 24 source messages')
        const firstSeen = Math.min(job.createdAt, Number(source.created_at ?? now))
        const changed = this.db.prepare(
          `UPDATE extraction_jobs SET source_ids = ?, quiet_until = ?, must_run_by = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
        ).run(JSON.stringify(sourceIds), quietUntil, Math.min(job.mustRunBy, firstSeen + Math.max(1000, input.maxWaitMs)), now, job.id)
        if (Number(changed.changes ?? 0) !== 1) throw new Error('extraction job changed while queuing a source')
        this.db.prepare('INSERT INTO extraction_job_sources(source_id, job_id, session_id, assigned_at) VALUES (?, ?, ?, ?)')
          .run(input.sourceId, job.id, input.sessionId, now)
        this.db.exec('COMMIT')
        return this.getExtractionJob(job.id)!
      }
      const id = `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`
      const firstSeen = Number(source.created_at ?? now)
      this.db.prepare(
        `INSERT INTO extraction_jobs(id, session_id, policy_revision, status, created_at, updated_at, quiet_until, must_run_by,
           source_ids, input_snapshot, route_provider, route_model, agent_preset) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      ).run(id, input.sessionId, input.policyRevision, firstSeen, now, quietUntil, firstSeen + Math.max(1000, input.maxWaitMs),
        JSON.stringify([input.sourceId]), source.provider ?? null, source.model ?? null, source.agent_preset ?? null)
      this.db.prepare('INSERT INTO extraction_job_sources(source_id, job_id, session_id, assigned_at) VALUES (?, ?, ?, ?)')
        .run(input.sourceId, id, input.sessionId, now)
      this.db.exec('COMMIT')
      return this.getExtractionJob(id)!
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getExtractionJob(id: string): ExtractionJob | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM extraction_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toExtractionJob(row)
  }

  verifyCommittedExtraction(input: { jobId: string; attemptId: string; responseText: string; usage: ExtractionJob['usage'] }): boolean {
    this.ensureOpen()
    const job = this.getExtractionJob(input.jobId)
    if (job === undefined || job.status !== 'completed' || job.attemptId !== input.attemptId ||
        job.responseText !== input.responseText || JSON.stringify(job.usage ?? null) !== JSON.stringify(input.usage ?? null) ||
        job.sourceIds.length === 0 || job.sourceIds.length > 24) return false
    const placeholders = job.sourceIds.map(() => '?').join(',')
    const sources = this.db.prepare(`SELECT COUNT(*) AS n FROM l0_messages WHERE project_key = ? AND id IN (${placeholders}) AND extracted_at IS NOT NULL`)
      .get(projectKeyOfFile(this.file), ...job.sourceIds) as { n?: number }
    if (Number(sources?.n ?? 0) !== job.sourceIds.length) return false
    const event = this.db.prepare("SELECT metadata FROM memory_events WHERE event_id = ? AND type = 'extract' AND source_id = ?")
      .get(`extract:${job.id}`, job.id) as { metadata?: unknown } | undefined
    if (event === undefined || typeof event.metadata !== 'string') return false
    try {
      const metadata = JSON.parse(event.metadata) as Record<string, unknown>
      return metadata.attemptId === input.attemptId && metadata.sourceCount === job.sourceIds.length
    } catch { return false }
  }

  queuedExtractionJob(sessionId: string, now = Date.now(), includeNotDue = false): ExtractionJob | undefined {
    this.ensureOpen()
    const row = this.db.prepare(
      `SELECT * FROM extraction_jobs WHERE session_id = ? AND status = 'queued' ${includeNotDue ? '' : 'AND (quiet_until <= ? OR must_run_by <= ?)'}
       ORDER BY created_at ASC LIMIT 1`,
    ).get(...(includeNotDue ? [sessionId] : [sessionId, now, now])) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toExtractionJob(row)
  }

  nextActionableExtractionJob(sessionId: string, now = Date.now(), wakeGateHeld = false, forceDeferred = false): ExtractionJob | undefined {
    this.ensureOpen()
    const budgetBlocked = `COALESCE((error LIKE 'daily % limit reached%' OR error LIKE 'daily % budget exhausted%' OR
      error LIKE 'estimated request reservation % exceeds the configured daily%' OR
      error LIKE '%daily token and task budgets must be explicitly configured%'), 0)`
    const deferredReady = forceDeferred
      ? "status IN ('ready','result_ready')"
      : `(status IN ('ready','result_ready') AND (
          (updated_at + 30000 <= ? AND NOT (${budgetBlocked})) OR
          (updated_at + 30000 <= ? AND MAX(updated_at + 30000, (CAST(updated_at / 86400000 AS INTEGER) + 1) * 86400000) <= ? AND (${budgetBlocked})) OR
          (? = 1 AND error LIKE 'global billable request gate is held%')
        ))`
    const params: unknown[] = [sessionId]
    if (!forceDeferred) params.push(now, now, now, wakeGateHeld ? 1 : 0)
    const row = this.db.prepare(
      `SELECT * FROM extraction_jobs WHERE session_id = ? AND (
        ${deferredReady} OR (status = 'queued' AND (quiet_until <= ? OR must_run_by <= ?)))
       ORDER BY CASE WHEN status = 'queued' THEN MIN(quiet_until, must_run_by)
                     WHEN error LIKE 'global billable request gate is held%' AND ? = 1 THEN ?
                     WHEN (${budgetBlocked})
                       THEN MAX(updated_at + 30000, (CAST(updated_at / 86400000 AS INTEGER) + 1) * 86400000)
                     ELSE updated_at + 30000 END ASC, created_at ASC LIMIT 1`,
    ).get(...params, now, now, wakeGateHeld ? 1 : 0, now) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toExtractionJob(row)
  }

  extractionJobs(limit = 200): ExtractionJob[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT * FROM extraction_jobs ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(1000, Math.floor(limit)))) as Array<Record<string, unknown>>
    return rows.map(toExtractionJob)
  }

  extractionJobsForOverview(limit = 10, excludedAgentPatterns: string[] = []): ExtractionJob[] {
    this.ensureOpen()
    const visibleAgent = excludedJobSql(excludedAgentPatterns)
    const rows = this.db.prepare(`SELECT * FROM extraction_jobs j WHERE ${visibleAgent.sql} ORDER BY j.updated_at DESC LIMIT ?`)
      .all(...visibleAgent.params, Math.max(1, Math.min(50, Math.floor(limit)))) as Array<Record<string, unknown>>
    return rows.map(toExtractionJob)
  }

  extractionJobsPage(input: { limit?: number; filter?: 'all' | 'queued' | 'failed' | 'uncertain' | 'oldest';
    after?: { updatedAt?: number; createdAt?: number; id: string }; excludedAgentPatterns?: string[] } = {}): {
    jobs: ExtractionJob[]; next?: { updatedAt: number; id: string } | { createdAt: number; id: string }
  } {
    this.ensureOpen()
    const visibleAgent = excludedJobSql(input.excludedAgentPatterns ?? [])
    const filter = input.filter ?? 'all'
    const oldest = filter === 'oldest'
    const pending = `j.status IN ('queued','ready','dispatching') AND EXISTS (
      SELECT 1 FROM extraction_job_sources js JOIN l0_messages l ON l.id = js.source_id
      WHERE js.job_id = j.id AND js.session_id = j.session_id AND l.extracted_at IS NULL)`
    const filterSql = filter === 'queued' || oldest ? ` AND ${pending}`
      : filter === 'failed' ? " AND j.status IN ('failed','source_pruned')"
        : filter === 'uncertain' ? " AND j.status IN ('uncertain_remote','blocked_charged')" : ''
    const afterTime = input.after === undefined ? undefined : oldest ? input.after.createdAt : input.after.updatedAt
    const afterSql = afterTime === undefined ? '' : oldest
      ? ' AND (j.created_at > ? OR (j.created_at = ? AND j.id > ?))'
      : ' AND (j.updated_at < ? OR (j.updated_at = ? AND j.id < ?))'
    const params: unknown[] = [...visibleAgent.params]
    if (afterTime !== undefined && input.after !== undefined) params.push(afterTime, afterTime, input.after.id)
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)))
    const rows = this.db.prepare(`SELECT j.* FROM extraction_jobs j WHERE ${visibleAgent.sql}${filterSql}${afterSql}
      ORDER BY j.${oldest ? 'created_at ASC, j.id ASC' : 'updated_at DESC, j.id DESC'} LIMIT ?`).all(...params, limit + 1) as Array<Record<string, unknown>>
    const jobs = rows.slice(0, limit).map(toExtractionJob)
    const last = jobs.at(-1)
    return { jobs, ...(rows.length > limit && last !== undefined ? { next: oldest ? { createdAt: last.createdAt, id: last.id } : { updatedAt: last.updatedAt, id: last.id } } : {}) }
  }

  /** Bounded primary-key processing metadata page; exclusions and ownership proof are applied by the caller. */
  dashboardProcessingSummaryPage(after?: { id: string }, limit = 15): {
    rows: Array<{ id?: string; idBytes: number; status?: string; statusBytes: number; agentPreset?: string; agentPresetBytes: number;
      sessionId?: string; sessionIdBytes: number; createdAt?: number; updatedAt?: number; error?: string }>;
    hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    const afterSql = after === undefined ? '' : ' AND j.id > ?'
    const params: unknown[] = after === undefined ? [] : [after.id]
    const rows = this.db.prepare(`SELECT
        CASE WHEN length(CAST(j.id AS BLOB)) <= 256 THEN j.id END AS id, length(CAST(j.id AS BLOB)) AS id_bytes,
        CASE WHEN length(CAST(j.status AS BLOB)) <= 64 THEN j.status END AS status, length(CAST(j.status AS BLOB)) AS status_bytes,
        CASE WHEN j.agent_preset IS NOT NULL AND length(CAST(j.agent_preset AS BLOB)) <= 512 THEN j.agent_preset END AS agent_preset,
        CASE WHEN j.agent_preset IS NULL THEN 0 ELSE length(CAST(j.agent_preset AS BLOB)) END AS agent_preset_bytes,
        CASE WHEN typeof(j.session_id) = 'text' AND length(CAST(j.session_id AS BLOB)) <= 512 THEN j.session_id END AS session_id,
        length(CAST(j.session_id AS BLOB)) AS session_id_bytes,
        CASE WHEN typeof(j.created_at) IN ('integer','real') AND j.created_at >= 0 AND j.created_at <= 9007199254740991
          THEN j.created_at END AS created_at,
        CASE WHEN typeof(j.updated_at) IN ('integer','real') AND j.updated_at >= 0 AND j.updated_at <= 9007199254740991
          THEN j.updated_at END AS updated_at,
        CASE WHEN j.error IS NULL THEN NULL WHEN length(CAST(j.error AS BLOB)) <= 240 THEN j.error ELSE NULL END AS error
      FROM extraction_jobs j WHERE 1=1${afterSql}
      ORDER BY j.id ASC LIMIT ?`).all(...params, bounded + 1) as Array<Record<string, unknown>>
    return {
      rows: rows.slice(0, bounded).map((row) => ({
        ...(typeof row.id === 'string' ? { id: row.id } : {}), idBytes: Number(row.id_bytes ?? 0),
        ...(typeof row.status === 'string' ? { status: row.status } : {}), statusBytes: Number(row.status_bytes ?? 0),
        ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}),
        agentPresetBytes: Number(row.agent_preset_bytes ?? 0),
        ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
        sessionIdBytes: Number(row.session_id_bytes ?? 0),
        ...(Number.isSafeInteger(row.created_at) ? { createdAt: Number(row.created_at) } : {}),
        ...(Number.isSafeInteger(row.updated_at) ? { updatedAt: Number(row.updated_at) } : {}),
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
      })),
      hasMore: rows.length > bounded,
    }
  }

  /**
   * Raw ownership keyset for one extraction job. The returned page is ordered
   * by the indexed (job_id, source_id) key and never filters session or L0
   * state before LIMIT, so an unbounded EXISTS cannot hide inside one job.
   */
  dashboardProcessingSourcePage(jobId: string, afterSourceId?: string, limit = 15): {
    rows: Array<{ sourceId?: string; sourceIdBytes: number; sessionId?: string; sessionIdType: 'text' | 'null' | 'invalid'; sessionIdBytes: number }>; hasMore: boolean
  } {
    this.ensureOpen()
    if (typeof jobId !== 'string' || jobId.length < 1 || Buffer.byteLength(jobId, 'utf8') > 256) throw new TypeError('processing job key is invalid')
    if (afterSourceId !== undefined && (typeof afterSourceId !== 'string' || afterSourceId.length < 1 || Buffer.byteLength(afterSourceId, 'utf8') > 256)) {
      throw new TypeError('processing source cursor is invalid')
    }
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    const projection = `SELECT
        CASE WHEN typeof(source_id) = 'text' AND length(CAST(source_id AS BLOB)) <= 256 THEN source_id END AS source_id,
        length(CAST(source_id AS BLOB)) AS source_id_bytes,
        CASE WHEN typeof(session_id) = 'text' AND length(CAST(session_id AS BLOB)) <= 512 THEN session_id END AS session_id,
        typeof(session_id) AS session_id_type,
        length(CAST(session_id AS BLOB)) AS session_id_bytes
      FROM extraction_job_sources WHERE job_id = ?`
    const rows = (afterSourceId === undefined
      ? this.db.prepare(`${projection} ORDER BY source_id ASC LIMIT ?`).all(jobId, bounded + 1)
      : this.db.prepare(`${projection} AND source_id > ? ORDER BY source_id ASC LIMIT ?`).all(jobId, afterSourceId, bounded + 1)) as Array<Record<string, unknown>>
    return {
      rows: rows.slice(0, bounded).map((row) => ({
        ...(typeof row.source_id === 'string' ? { sourceId: row.source_id } : {}), sourceIdBytes: Number(row.source_id_bytes ?? 0),
        ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
        sessionIdType: row.session_id_type === 'text' ? 'text' : row.session_id_type === 'null' ? 'null' : 'invalid',
        sessionIdBytes: Number(row.session_id_bytes ?? 0),
      })),
      hasMore: rows.length > bounded,
    }
  }

  /** One primary-key L0 ownership point read; missing rows and extracted rows are not pending. */
  dashboardProcessingSourcePending(sourceId: string): { exists: boolean; pending: boolean } {
    this.ensureOpen()
    if (typeof sourceId !== 'string' || sourceId.length < 1 || Buffer.byteLength(sourceId, 'utf8') > 256) throw new TypeError('processing source key is invalid')
    const row = this.db.prepare(`SELECT
        1 AS found,
        CASE WHEN extracted_at IS NULL THEN 1 ELSE 0 END AS pending
      FROM l0_messages WHERE project_key = ? AND id = ? LIMIT 1`)
      .get(projectKeyOfFile(this.file), sourceId) as { found?: unknown; pending?: unknown } | undefined
    if (row === undefined) return { exists: false, pending: false }
    return { exists: Number(row.found) === 1, pending: Number(row.pending) === 1 }
  }

  extractionJobSummary(excludedAgentPatterns: string[] = []): ExtractionJobSummary {
    this.ensureOpen()
    const visibleAgent = excludedJobSql(excludedAgentPatterns)
    const row = this.db.prepare(
      `SELECT SUM(CASE WHEN j.status IN ('queued','ready','dispatching') AND EXISTS (
           SELECT 1 FROM extraction_job_sources js JOIN l0_messages l ON l.id = js.source_id
           WHERE js.job_id = j.id AND js.session_id = j.session_id AND l.extracted_at IS NULL) THEN 1 ELSE 0 END) AS queued,
         MIN(CASE WHEN j.status IN ('queued','ready','dispatching') AND EXISTS (
           SELECT 1 FROM extraction_job_sources js JOIN l0_messages l ON l.id = js.source_id
           WHERE js.job_id = j.id AND js.session_id = j.session_id AND l.extracted_at IS NULL) THEN j.created_at END) AS oldest_waiting,
         SUM(CASE WHEN j.status IN ('failed','source_pruned') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN j.status IN ('uncertain_remote','blocked_charged') THEN 1 ELSE 0 END) AS uncertain_usage
       FROM extraction_jobs j WHERE ${visibleAgent.sql}`,
    ).get(...visibleAgent.params) as { queued?: number; oldest_waiting?: number | null; failed?: number; uncertain_usage?: number }
    return { queued: Number(row?.queued ?? 0), oldestWaitingAt: row?.oldest_waiting == null ? null : Number(row.oldest_waiting),
      failed: Number(row?.failed ?? 0), uncertainUsage: Number(row?.uncertain_usage ?? 0) }
  }

  nextExtractionDueAt(sessionId: string): number | undefined {
    this.ensureOpen()
    const row = this.db.prepare(
      `SELECT MIN(CASE WHEN status = 'queued' THEN MIN(quiet_until, must_run_by)
                       WHEN error LIKE 'daily % limit reached%' OR error LIKE 'daily % budget exhausted%' OR
                            error LIKE 'estimated request reservation % exceeds the configured daily%' OR
                            error LIKE '%daily token and task budgets must be explicitly configured%'
                         THEN MAX(updated_at + 30000, (CAST(updated_at / 86400000 AS INTEGER) + 1) * 86400000)
                       ELSE updated_at + 30000 END) AS due
       FROM extraction_jobs WHERE session_id = ? AND status IN ('queued','ready','result_ready')`,
    ).get(sessionId) as { due?: number | null } | undefined
    return row?.due === undefined || row.due === null ? undefined : Number(row.due)
  }

  deferReadyExtractionJob(id: string, reason: string, now = Date.now()): void {
    this.ensureOpen()
    this.db.prepare("UPDATE extraction_jobs SET error = ?, updated_at = ? WHERE id = ? AND status = 'ready' AND attempt_id IS NULL")
      .run(reason.slice(0, 500), now, id)
  }

  deferSavedExtractionJob(id: string, reason: string, now = Date.now()): void {
    this.ensureOpen()
    this.db.prepare("UPDATE extraction_jobs SET error = ?, updated_at = ? WHERE id = ? AND status = 'result_ready'")
      .run(reason.slice(0, 500), now, id)
  }

  freezeExtractionJob(id: string, now = Date.now()): ExtractionJob {
    this.ensureOpen()
    let wasPruned = false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const job = this.getExtractionJob(id)
      if (job === undefined) throw new Error(`extraction job not found: ${id}`)
      if (job.status === 'ready' || job.status === 'result_ready') {
        this.db.exec('COMMIT')
        return job
      }
      if (job.status !== 'queued') throw new Error(`extraction job is not queued: ${job.status}`)
      const sourceIds = [...new Set(job.sourceIds)]
      if (sourceIds.length === 0 || sourceIds.length > 24) throw new Error('extraction job source count must be between 1 and 24')
      const placeholders = sourceIds.map(() => '?').join(', ')
      const rows = this.db.prepare(
        `SELECT id, role, content, created_at, extracted_at FROM l0_messages WHERE project_key = ? AND session_id = ? AND id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
      ).all(projectKeyOfFile(this.file), job.sessionId, ...sourceIds) as Array<Record<string, unknown>>
      const owned = this.db.prepare('SELECT COUNT(*) AS n FROM extraction_job_sources WHERE job_id = ? AND source_id IN (' + placeholders + ')')
        .get(id, ...sourceIds) as { n?: number }
      if (rows.length !== sourceIds.length || Number(owned?.n ?? 0) !== sourceIds.length || rows.some((row) => row.extracted_at !== null && row.extracted_at !== undefined)) {
        this.updateExtractionJob(id, 'source_pruned', 'source_pruned', now)
        wasPruned = true
        this.db.exec('COMMIT')
      } else {
        const snapshot = rows.map((row) => ({ id: String(row.id), role: String(row.role), content: String(row.content), createdAt: Number(row.created_at) }))
        const frozenRoute = job.provider && job.model ? { provider: job.provider, model: job.model } : undefined
        if (frozenRoute === undefined) throw new Error('extraction job has no model route pinned at capture time')
        const inputHash = createHash('sha256').update(JSON.stringify({ policyRevision: job.policyRevision, route: frozenRoute, snapshot })).digest('hex')
        const changed = this.db.prepare(
          `UPDATE extraction_jobs SET status = 'ready', input_snapshot = ?, input_hash = ?, route_provider = ?, route_model = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        ).run(JSON.stringify(snapshot), inputHash, frozenRoute?.provider ?? null, frozenRoute?.model ?? null, now, id)
        if (Number(changed.changes ?? 0) !== 1) throw new Error('extraction job changed while freezing its source set')
        this.db.exec('COMMIT')
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (wasPruned) throw new Error('extraction job source_pruned: source rows expired, disappeared, were consumed, or are owned by another job')
    return this.getExtractionJob(id)!
  }

  attachExtractionAttempt(jobId: string, attemptId: string, now = Date.now()): void {
    this.ensureOpen()
    const result = this.db.prepare(
      `UPDATE extraction_jobs SET status = 'dispatching', attempt_id = ?, updated_at = ? WHERE id = ? AND status = 'ready' AND attempt_id IS NULL`,
    ).run(attemptId, now, jobId)
    if (Number(result.changes ?? 0) !== 1) throw new Error('extraction job was already dispatched or changed')
  }

  saveExtractionResponse(jobId: string, attemptId: string, responseText: string, usage: NonNullable<ExtractionJob['usage']>, now = Date.now()): void {
    this.ensureOpen()
    const existing = this.getExtractionJob(jobId)
    if (existing?.attemptId !== attemptId) throw new Error('extraction response did not match the active job attempt')
    if (existing.status === 'result_ready') {
      if (existing.responseText !== responseText) throw new Error('saved extraction response conflicts with the existing local result')
      return
    }
    const result = this.db.prepare(
      `UPDATE extraction_jobs SET status = 'result_ready', response_text = ?, usage_json = ?, updated_at = ?
       WHERE id = ? AND attempt_id = ? AND status IN ('dispatching','uncertain_remote')`,
    ).run(responseText, JSON.stringify(usage), now, jobId, attemptId)
    if (Number(result.changes ?? 0) !== 1) throw new Error('extraction response did not match the active job attempt')
  }

  updateExtractionJob(id: string, status: ExtractionJob['status'], error?: string, now = Date.now()): void {
    this.ensureOpen()
    this.db.prepare(`UPDATE extraction_jobs SET status = ?, error = ?, updated_at = ?,
      input_snapshot = CASE WHEN ? = 'source_pruned' THEN '[]' ELSE input_snapshot END,
      response_text = CASE WHEN ? = 'source_pruned' THEN NULL ELSE response_text END
      WHERE id = ?`)
      .run(status, error ?? null, now, status, status, id)
  }

  requeueResolvedExtractionJob(id: string, now = Date.now()): void {
    this.ensureOpen()
    const result = this.db.prepare(
      `UPDATE extraction_jobs SET status = 'ready', attempt_id = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'uncertain_remote' AND input_snapshot <> '[]' AND input_hash IS NOT NULL`,
    ).run(now, id)
    if (Number(result.changes ?? 0) !== 1) throw new Error('only a source-verified uncertain job can be requeued')
  }

  extractionJobForAttempt(attemptId: string): ExtractionJob | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM extraction_jobs WHERE attempt_id = ? ORDER BY updated_at DESC LIMIT 1').get(attemptId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toExtractionJob(row)
  }

  commitExtractionBatch(jobId: string, inputs: AddMemoryInput[], now = Date.now()): { consumed: number; created: number; updated: number; memories: MemoryRecord[] } {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const job = this.getExtractionJob(jobId)
      if (job === undefined || job.status !== 'result_ready') throw new Error('only a saved extraction response can be committed')
      if (job.inputSnapshot.length === 0 || job.sourceIds.length === 0) throw new Error('extraction job has no frozen input')
      if (!this.hasSourceMessages(job.sourceIds)) throw new Error('extraction job sources are no longer available')
      const ownerPlaceholders = job.sourceIds.map(() => '?').join(', ')
      const ownership = this.db.prepare(`SELECT COUNT(*) AS n FROM extraction_job_sources WHERE job_id = ? AND source_id IN (${ownerPlaceholders})`)
        .get(jobId, ...job.sourceIds) as { n?: number }
      if (Number(ownership?.n ?? 0) !== job.sourceIds.length) throw new Error('extraction job no longer owns its complete frozen source set')
      const memories: MemoryRecord[] = []
      let created = 0
      let updated = 0
      for (const input of inputs) {
        const content = normalizeMemoryText(input.content)
        if (content === '') throw new Error('extraction response contains empty memory content')
        if (input.sourceVerified !== true || input.sourceMessageIds === undefined || input.sourceMessageIds.length === 0) {
          throw new Error('extraction result has no verified source references')
        }
        if (input.sourceMessageIds.some((id) => !job.sourceIds.includes(id))) throw new Error('extraction result references a source outside its frozen batch')
        if (!this.hasSourceMessages(input.sourceMessageIds)) throw new Error('extraction result references a missing or cross-project source')
        const validFromInfo = input.validFromInfo ?? normalizeEffectiveStart(input.validFrom, now)
        const contentNorm = createHash('sha256').update(content).digest('hex').slice(0, 40)
        const existing = this.db.prepare('SELECT * FROM l1_memories WHERE project_key = ? AND content_norm = ?')
          .get(projectKeyOfFile(this.file), contentNorm) as Record<string, unknown> | undefined
        if (existing !== undefined) {
          const record = toRecord(existing)
          if (record.status === 'forgotten') { memories.push(record); continue }
          const merged = [...new Set([...record.sourceMessageIds, ...input.sourceMessageIds])]
          if (merged.length > record.sourceMessageIds.length) {
            const revision = record.revision + 1
            this.db.prepare('UPDATE l1_memories SET source_message_ids = ?, source_verified = 1, revision = ?, updated_at = ?, recorded_at = ? WHERE id = ? AND revision = ?')
              .run(JSON.stringify(merged), revision, now, now, record.id, record.revision)
            this.db.prepare('UPDATE l1_revisions SET known_to = ?, superseded_at = ? WHERE memory_id = ? AND revision = ? AND known_to IS NULL')
              .run(now, now, record.id, record.revision)
            this.insertRevision({ memoryId: record.id, revision, content: record.content, kind: record.kind, scene: record.scene, status: record.status,
              recordedAt: now, validFromInfo: startInfoFromMemory(record), validTo: record.validTo, sourceMessageIds: merged, sourceVerified: true, reason: 'additional verified extraction source' })
            this.rememberSources(record.id, input.sourceMessageIds, now)
            memories.push(this.get(record.id)!)
            updated += 1
          } else memories.push(record)
          continue
        }
        const id = memoryId()
        const status = input.status ?? 'candidate'
        const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.5))
        this.db.prepare(
          `INSERT INTO l1_memories(id, project_key, content, content_norm, kind, scene, confidence, status, source, source_message_ids,
             created_at, updated_at, approved_at, forgotten_at, revision, valid_from, valid_from_state, valid_from_precision,
             valid_from_upper, valid_from_basis, valid_from_label, valid_to, recorded_at, source_verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, projectKeyOfFile(this.file), content, contentNorm, input.kind ?? 'fact', input.scene ?? null, confidence, status,
          input.source ?? 'extraction', JSON.stringify(input.sourceMessageIds), now, now, status === 'approved' ? now : null,
          status === 'forgotten' ? now : null, validFromInfo.value ?? null, validFromInfo.state, validFromInfo.precision,
          validFromInfo.upperExclusive ?? null, validFromInfo.basis, validFromInfo.label ?? null, input.validTo ?? null, now)
        this.insertRevision({ memoryId: id, revision: 1, content, kind: input.kind ?? 'fact', scene: input.scene, status, recordedAt: now,
          validFromInfo, validTo: input.validTo, sourceMessageIds: input.sourceMessageIds, sourceVerified: true, reason: input.reason ?? 'extraction' })
        this.rememberSources(id, input.sourceMessageIds, now)
        if (status === 'approved') this.appendEventInTransaction({ eventId: `initial-approval:${id}`, type: 'initial_approval', sourceId: id,
          occurredAt: now, metadata: { source: input.source ?? 'extraction' } }, now)
        if (this.ftsAvailable) this.db.prepare('INSERT INTO l1_fts(content, record_id) VALUES (?, ?)').run(tokenize(content).join(' '), id)
        memories.push(this.get(id)!)
        created += 1
      }
      const placeholders = job.sourceIds.map(() => '?').join(', ')
      const consumed = this.db.prepare(`UPDATE l0_messages SET extracted_at = ? WHERE project_key = ? AND id IN (${placeholders}) AND extracted_at IS NULL`)
        .run(now, projectKeyOfFile(this.file), ...job.sourceIds)
      if (Number(consumed.changes ?? 0) !== job.sourceIds.length) throw new Error('one or more source rows were already consumed; batch commit rolled back')
      const completed = this.db.prepare("UPDATE extraction_jobs SET status = 'completed', error = NULL, updated_at = ? WHERE id = ? AND status = 'result_ready'")
        .run(now, jobId)
      if (Number(completed.changes ?? 0) !== 1) throw new Error('extraction job changed before batch completion; batch commit rolled back')
      this.db.prepare(
        `INSERT OR IGNORE INTO memory_events(project_key, type, count, tokens, raw_tokens, created_at, event_id, session_id, occurred_at, source_id, usage_known, metadata)
         VALUES (?, 'extract', ?, 0, 0, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(projectKeyOfFile(this.file), created, now, `extract:${jobId}`, job.sessionId, now, jobId, JSON.stringify({ attemptId: job.attemptId, sourceCount: job.sourceIds.length, created, updated }))
      if (job.attemptId !== undefined && job.usage !== undefined) {
        this.appendEventInTransaction({
          eventId: `provider-usage:${job.attemptId}`, type: 'provider_usage', sessionId: job.sessionId,
          provider: job.provider, model: job.model, source: 'extraction', sourceId: jobId, occurredAt: now,
          usage: job.usage,
          metadata: { terminal: 'stop', inputHash: job.inputHash ?? null },
        }, now)
      }
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return { consumed: Number(consumed.changes ?? 0), created, updated, memories }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addMemory(input: AddMemoryInput): { record: MemoryRecord; created: boolean } {
    this.ensureOpen()
    const content = normalizeMemoryText(input.content)
    if (content === '') throw new Error('memory content is empty')
    if (input.sourceVerified === true && !this.hasSourceMessages(input.sourceMessageIds ?? [])) {
      throw new Error('memory source validation failed: one or more source messages are outside this project or unavailable')
    }
    const norm = createHash('sha256').update(content).digest('hex').slice(0, 40)
    const projectKey = projectKeyOfFile(this.file)
    const now = Date.now()
    const validFromInfo = input.validFromInfo ?? normalizeEffectiveStart(input.validFrom, now)
    const existing = this.db
      .prepare('SELECT * FROM l1_memories WHERE project_key = ? AND content_norm = ?')
      .get(projectKey, norm) as Record<string, unknown> | undefined
    if (existing) {
      const record = toRecord(existing)
      // A forgotten memory must not be revived by a repeated extraction.
      if (record.status === 'forgotten') return { record, created: false }
      const sourceMessageIds = [...new Set([...record.sourceMessageIds, ...(input.sourceMessageIds ?? [])])]
      if (sourceMessageIds.length !== record.sourceMessageIds.length || (input.sourceVerified === true && !record.sourceVerified)) {
        const revision = record.revision + 1
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.prepare(
            `UPDATE l1_memories SET source_message_ids = ?, source_verified = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`,
          ).run(JSON.stringify(sourceMessageIds), input.sourceVerified === true || record.sourceVerified ? 1 : 0, revision, now, record.id, record.revision)
          this.db.prepare('UPDATE l1_revisions SET known_to = ?, superseded_at = ? WHERE memory_id = ? AND revision = ? AND known_to IS NULL')
            .run(now, now, record.id, record.revision)
          this.insertRevision({
            memoryId: record.id, revision, content: record.content, kind: record.kind, scene: record.scene,
            status: record.status, recordedAt: now, validFromInfo: startInfoFromMemory(record), validTo: record.validTo,
            sourceMessageIds, sourceVerified: input.sourceVerified === true || record.sourceVerified, reason: 'additional source evidence',
          })
          this.rememberSources(record.id, input.sourceMessageIds ?? [], now)
          this.invalidateCaches()
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        return { record: this.get(record.id)!, created: false }
      }
      return { record, created: false }
    }
    const id = memoryId()
    const status = input.status ?? 'candidate'
    const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.5))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO l1_memories(id, project_key, content, content_norm, kind, scene, confidence, status, source, source_message_ids,
             created_at, updated_at, approved_at, forgotten_at, revision, valid_from, valid_from_state, valid_from_precision,
             valid_from_upper, valid_from_basis, valid_from_label, valid_to, recorded_at, source_verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          validFromInfo.value ?? null,
          validFromInfo.state,
          validFromInfo.precision,
          validFromInfo.upperExclusive ?? null,
          validFromInfo.basis,
          validFromInfo.label ?? null,
          input.validTo ?? null,
          now,
          input.sourceVerified === true ? 1 : 0,
        )
      this.insertRevision({
        memoryId: id, revision: 1, content, kind: input.kind ?? 'fact', scene: input.scene,
        status, recordedAt: now, validFromInfo, validTo: input.validTo,
        sourceMessageIds: input.sourceMessageIds ?? [], sourceVerified: input.sourceVerified === true,
        reason: input.reason ?? 'initial record',
      })
      this.rememberSources(id, input.sourceMessageIds ?? [], now)
      if (status === 'approved') this.appendEventInTransaction({ eventId: `initial-approval:${id}`, type: 'initial_approval', sourceId: id,
        occurredAt: now, metadata: { source: input.source ?? 'manual' } }, now)
      if (this.ftsAvailable) {
        this.db
          .prepare('INSERT INTO l1_fts(content, record_id) VALUES (?, ?)')
          .run(tokenize(content).join(' '), id)
      }
      this.invalidateCaches()
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
    const previous = this.get(id)
    if (previous === undefined) return undefined
    // A forgotten logical memory is immutable. Re-approval must be represented
    // as a new, independently reviewed memory with a new id.
    if (previous.status === 'forgotten' || previous.status === status) return previous
    const now = Date.now()
    const revision = previous.revision + 1
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.db.prepare(
        `UPDATE l1_memories SET status = ?, updated_at = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
         forgotten_at = CASE WHEN ? = 'forgotten' THEN ? ELSE forgotten_at END, revision = ?, recorded_at = ?, superseded_at = ? WHERE id = ? AND revision = ?`,
      ).run(status, now, status, now, status, now, revision, now, status === 'forgotten' ? now : null, id, previous.revision)
      if (Number(updated.changes ?? 0) !== 1) throw new Error('memory revision changed; reload before retrying')
      this.db.prepare('UPDATE l1_revisions SET known_to = ?, superseded_at = ? WHERE memory_id = ? AND known_to IS NULL')
        .run(now, now, id)
      this.insertRevision({
        memoryId: id, revision, content: previous.content, kind: previous.kind, scene: previous.scene,
        status, recordedAt: now, validFromInfo: startInfoFromMemory(previous), validTo: previous.validTo,
        sourceMessageIds: previous.sourceMessageIds, sourceVerified: previous.sourceVerified,
        reason: status === 'forgotten' ? 'user forget' : 'user approval',
      })
      if (status === 'approved' && previous.status === 'candidate') this.appendEventInTransaction({ eventId: `initial-approval:${id}`, type: 'initial_approval', sourceId: id,
        occurredAt: now, metadata: { source: 'review' } }, now)
      this.invalidateCaches()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.get(id)
  }

  proposeRevision(input: { memoryId: string; expectedRevision: number; content: string; sourceMessageIds: string[]; reason: string; validFrom?: number | string | null; validTo?: number; kind?: string; scene?: string }, now = Date.now()): RevisionCandidate {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get(input.memoryId)
      if (current === undefined) throw new Error('revision target is not in this project')
      if (current.status === 'forgotten') throw new Error('forgotten memories cannot receive new revisions')
      if (current.revision !== input.expectedRevision) throw new Error('revision base is stale; reload current memory before proposing a change')
      const content = normalizeMemoryText(input.content)
      const sourceIds = [...new Set(input.sourceMessageIds)]
      if (content === '' || input.reason.trim() === '' || sourceIds.length === 0 || !this.hasSourceMessages(sourceIds)) throw new Error('revision needs non-empty content/reason and verified same-project source messages')
      const id = `rev_${randomUUID().replace(/-/g, '').slice(0, 20)}`
      const conflictIds = this.findPotentialConflicts(content, input.memoryId)
      // For an existing memory, an omitted time field means this is a
      // non-temporal revision. Preserve the established time claim; explicit
      // null remains an intentional reset to unknown.
      const validFromInfo = input.validFrom === undefined ? startInfoFromMemory(current) : normalizeEffectiveStart(input.validFrom, now)
      this.db.prepare(
        `INSERT INTO revision_candidates(id, memory_id, base_revision, content, source_message_ids, reason, kind, scene,
           valid_from, valid_from_state, valid_from_precision, valid_from_upper, valid_from_basis, valid_from_label,
           valid_to, created_at, status, conflict_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
      ).run(id, input.memoryId, input.expectedRevision, content, JSON.stringify(sourceIds), input.reason.trim().slice(0, 1000),
        input.kind ?? current.kind, input.scene ?? current.scene ?? null, validFromInfo.value ?? null, validFromInfo.state,
        validFromInfo.precision, validFromInfo.upperExclusive ?? null, validFromInfo.basis, validFromInfo.label ?? null,
        input.validTo ?? null, now, JSON.stringify(conflictIds))
      this.appendEventInTransaction({ eventId: `revision-candidate:${id}`, type: 'revision_candidate', sourceId: input.memoryId, count: 1,
        metadata: { baseRevision: input.expectedRevision, conflictCount: conflictIds.length } }, now)
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return this.revisionCandidate(id)!
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private findPotentialConflicts(content: string, excludeId: string): string[] {
    const terms = [...new Set(tokenize(content).filter((term) => term.length > 1))].slice(0, 8)
    if (terms.length === 0) return []
    const where = terms.map(() => 'content LIKE ?').join(' OR ')
    const rows = this.db.prepare(
      `SELECT id FROM l1_memories WHERE status IN ('candidate','approved') AND id <> ? AND (${where}) ORDER BY updated_at DESC LIMIT 20`,
    ).all(excludeId, ...terms.map((term) => `%${term}%`)) as Array<{ id?: string }>
    return rows.flatMap((row) => typeof row.id === 'string' ? [row.id] : [])
  }

  revisionCandidate(id: string): RevisionCandidate | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM revision_candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toRevisionCandidate(row)
  }

  revisionCandidates(status: RevisionCandidate['status'] = 'candidate', limit = 100): RevisionCandidate[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT * FROM revision_candidates WHERE status = ? ORDER BY created_at ASC LIMIT ?')
      .all(status, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[]
    return rows.map(toRevisionCandidate)
  }

  approveRevision(id: string, now = Date.now()): { candidate: RevisionCandidate; record?: MemoryRecord; conflictIds: string[] } {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    let conflictIds: string[] = []
    let currentId: string | undefined
    try {
      const candidate = this.revisionCandidate(id)
      if (candidate === undefined || candidate.status !== 'candidate') throw new Error('revision candidate is unavailable')
      const current = this.get(candidate.memoryId)
      if (current === undefined || current.status === 'forgotten' || current.revision !== candidate.baseRevision) {
        const changed = this.db.prepare("UPDATE revision_candidates SET status = 'conflict' WHERE id = ? AND status = 'candidate'").run(id)
        if (Number(changed.changes ?? 0) !== 1) throw new Error('revision candidate changed concurrently')
        this.db.exec('COMMIT')
        return { candidate: this.revisionCandidate(id)!, conflictIds: [] }
      }
      if (!this.hasSourceMessages(candidate.sourceMessageIds)) throw new Error('revision evidence expired before approval')
      const norm = createHash('sha256').update(candidate.content).digest('hex').slice(0, 40)
      const duplicate = this.db.prepare('SELECT id FROM l1_memories WHERE project_key = ? AND content_norm = ? AND id <> ?')
        .get(projectKeyOfFile(this.file), norm, current.id) as { id?: string } | undefined
      if (duplicate !== undefined) {
        conflictIds = [String(duplicate.id)]
        const changed = this.db.prepare("UPDATE revision_candidates SET status = 'conflict', conflict_ids = ? WHERE id = ? AND status = 'candidate'")
          .run(JSON.stringify(conflictIds), id)
        if (Number(changed.changes ?? 0) !== 1) throw new Error('revision candidate changed concurrently')
        this.db.exec('COMMIT')
        return { candidate: this.revisionCandidate(id)!, conflictIds }
      }
      const revision = current.revision + 1
      const candidateMetadata = this.db.prepare('SELECT kind, scene FROM revision_candidates WHERE id = ?').get(id) as { kind?: string; scene?: string | null } | undefined
      const revisionKind = candidateMetadata?.kind ?? current.kind
      const revisionScene = candidateMetadata?.scene ?? current.scene
      const validFromInfo = startInfoFromCandidate(candidate)
      const updated = this.db.prepare(
        `UPDATE l1_memories SET content = ?, content_norm = ?, kind = ?, scene = ?, source_message_ids = ?, source_verified = 1,
           revision = ?, valid_from = ?, valid_from_state = ?, valid_from_precision = ?, valid_from_upper = ?, valid_from_basis = ?,
           valid_from_label = ?, valid_to = ?, updated_at = ?, recorded_at = ?, superseded_at = NULL
         WHERE id = ? AND revision = ? AND status <> 'forgotten'`,
      ).run(candidate.content, norm, revisionKind, revisionScene ?? null, JSON.stringify([...new Set([...current.sourceMessageIds, ...candidate.sourceMessageIds])]), revision,
        validFromInfo.value ?? null, validFromInfo.state, validFromInfo.precision, validFromInfo.upperExclusive ?? null, validFromInfo.basis,
        validFromInfo.label ?? null, candidate.validTo ?? null, now, now, current.id, current.revision)
      if (Number(updated.changes ?? 0) !== 1) throw new Error('memory changed during revision approval; reload and reconcile')
      // Preserve prior valid-time claims. A late or future correction adds a
      // newer knowledge-time claim; it must not rewrite what was recorded before.
      const sourceIds = [...new Set([...current.sourceMessageIds, ...candidate.sourceMessageIds])]
      this.insertRevision({ memoryId: current.id, revision, content: candidate.content, kind: revisionKind, scene: revisionScene,
        status: current.status, recordedAt: now, validFromInfo, validTo: candidate.validTo, sourceMessageIds: sourceIds,
        sourceVerified: true, reason: candidate.reason })
      this.rememberSources(current.id, candidate.sourceMessageIds, now)
      const accepted = this.db.prepare("UPDATE revision_candidates SET status = 'approved' WHERE id = ? AND status = 'candidate' AND base_revision = ?")
        .run(id, candidate.baseRevision)
      if (Number(accepted.changes ?? 0) !== 1) throw new Error('revision candidate was already resolved; update rolled back')
      if (this.ftsAvailable) {
        this.db.prepare('DELETE FROM l1_fts WHERE record_id = ?').run(current.id)
        this.db.prepare('INSERT INTO l1_fts(content, record_id) VALUES (?, ?)').run(tokenize(candidate.content).join(' '), current.id)
      }
      this.appendEventInTransaction({ eventId: `revision-accepted:${id}`, type: 'revision', sourceId: current.id, count: 1,
        metadata: { revision, reason: candidate.reason } }, now)
      this.invalidateCaches()
      this.db.exec('COMMIT')
      currentId = current.id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const candidate = this.revisionCandidate(id)!
    conflictIds = this.findPotentialConflicts(candidate.content, currentId!)
    return { candidate, record: this.get(currentId!), conflictIds }
  }

  rejectRevision(id: string, now = Date.now()): RevisionCandidate | undefined {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.db.prepare("UPDATE revision_candidates SET status = 'rejected' WHERE id = ? AND status = 'candidate'").run(id)
      if (Number(changed.changes ?? 0) !== 1) throw new Error('revision candidate is unavailable or already resolved')
      this.appendEventInTransaction({ eventId: `revision-rejected:${id}`, type: 'revision_rejected', count: 1 }, now)
      this.invalidateCaches()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.revisionCandidate(id)
  }

  revisions(memoryId: string, limit = 100): MemoryRevision[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT * FROM l1_revisions WHERE memory_id = ? ORDER BY revision DESC LIMIT ?')
      .all(memoryId, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.revision_id), memoryId: String(row.memory_id), revision: Number(row.revision), content: String(row.content),
      kind: String(row.kind), ...(typeof row.scene === 'string' ? { scene: row.scene } : {}), status: String(row.status) as MemoryStatus,
      recordedAt: Number(row.recorded_at), ...(row.known_to === null || row.known_to === undefined ? {} : { knownTo: Number(row.known_to) }),
      ...validFromFields(row, Number(row.recorded_at)), ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: Number(row.valid_to) }),
      ...(row.superseded_at === null || row.superseded_at === undefined ? {} : { supersededAt: Number(row.superseded_at) }),
      sourceMessageIds: parseIds(row.source_message_ids), ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    }))
  }

  /** Revisions recorded by a knowledge-time snapshot, including later superseded versions. */
  revisionsAt(memoryId: string, knownAt: number, limit = 100, offset = 0): MemoryRevision[] {
    this.ensureOpen()
    const rows = this.db.prepare(
      `SELECT * FROM l1_revisions WHERE memory_id = ? AND status = 'approved' AND recorded_at <= ?
       ORDER BY recorded_at DESC, revision DESC LIMIT ? OFFSET ?`,
    ).all(memoryId, knownAt, Math.max(1, Math.min(500, Math.floor(limit))), Math.max(0, Math.floor(offset))) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.revision_id), memoryId: String(row.memory_id), revision: Number(row.revision), content: String(row.content),
      kind: String(row.kind), ...(typeof row.scene === 'string' ? { scene: row.scene } : {}), status: 'approved' as const,
      recordedAt: Number(row.recorded_at), ...(row.known_to === null || row.known_to === undefined || Number(row.known_to) > knownAt ? {} : { knownTo: Number(row.known_to) }),
      ...validFromFields(row, Number(row.recorded_at)), ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: Number(row.valid_to) }),
      ...(row.superseded_at === null || row.superseded_at === undefined || Number(row.superseded_at) > knownAt ? {} : { supersededAt: Number(row.superseded_at) }),
      sourceMessageIds: parseIds(row.source_message_ids), ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    }))
  }

  countRevisionsAt(memoryId: string, knownAt: number): number {
    this.ensureOpen()
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM l1_revisions WHERE memory_id = ? AND status = 'approved' AND recorded_at <= ?`,
    ).get(memoryId, knownAt) as { n?: number }
    return Number(row?.n ?? 0)
  }

  revisionAt(memoryId: string, effectiveAt: number, knownAt: number): MemoryRevision | undefined {
    this.ensureOpen()
    const row = this.db.prepare(
      `SELECT * FROM l1_revisions WHERE memory_id = ? AND status = 'approved'
       AND (valid_from_state = 'unknown' OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_at <= ? ORDER BY recorded_at DESC, revision DESC LIMIT 1`,
    ).get(memoryId, effectiveAt, effectiveAt, knownAt) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      id: String(row.revision_id), memoryId: String(row.memory_id), revision: Number(row.revision), content: String(row.content),
      kind: String(row.kind), ...(typeof row.scene === 'string' ? { scene: row.scene } : {}), status: String(row.status) as MemoryStatus,
      recordedAt: Number(row.recorded_at), ...(row.known_to === null || row.known_to === undefined || Number(row.known_to) > knownAt ? {} : { knownTo: Number(row.known_to) }),
      ...validFromFields(row, Number(row.recorded_at)),
      temporalUncertainAt: effectiveStartIsUncertainAt(effectiveStartFromStored({ state: row.valid_from_state,
        precision: row.valid_from_precision, basis: row.valid_from_basis, value: row.valid_from,
        upperExclusive: row.valid_from_upper, label: row.valid_from_label, recordedAt: Number(row.recorded_at) }), effectiveAt),
      ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: Number(row.valid_to) }),
      ...(row.superseded_at === null || row.superseded_at === undefined || Number(row.superseded_at) > knownAt ? {} : { supersededAt: Number(row.superseded_at) }),
      sourceMessageIds: parseIds(row.source_message_ids), ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    }
  }

  proposeRelation(input: { fromId: string; toId: string; type: RelationRecord['type']; evidenceIds: string[] }, now = Date.now()): RelationCandidate {
    this.ensureOpen()
    const from = this.get(input.fromId)
    const to = this.get(input.toId)
    const evidence = [...new Set(input.evidenceIds)]
    if (from === undefined || to === undefined || from.id === to.id || from.status !== 'approved' || to.status !== 'approved') {
      throw new Error('relation endpoints must be distinct, same-project approved memories')
    }
    if (evidence.length === 0 || !this.hasSourceMessages(evidence)) throw new Error('relation needs available same-project evidence')
    if (!['supports', 'contradicts', 'depends_on', 'supersedes', 'derived_from'].includes(input.type)) throw new Error('unsupported relation type')
    const id = `relc_${randomUUID().replace(/-/g, '').slice(0, 18)}`
    this.db.prepare(
      `INSERT INTO relation_candidates(id, from_id, to_id, relation_type, evidence_ids, from_revision, to_revision, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
    ).run(id, from.id, to.id, input.type, JSON.stringify(evidence), from.revision, to.revision, now)
    this.invalidateCaches()
    return this.relationCandidate(id)!
  }

  relationCandidate(id: string): RelationCandidate | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM relation_candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      id: String(row.id), fromId: String(row.from_id), toId: String(row.to_id), type: String(row.relation_type) as RelationRecord['type'],
      evidenceIds: parseIds(row.evidence_ids), sourceRevision: Number(row.from_revision), fromRevision: Number(row.from_revision),
      toRevision: Number(row.to_revision), createdAt: Number(row.created_at), status: String(row.status) as RelationCandidate['status'],
    }
  }

  relationCandidates(status: RelationCandidate['status'] = 'candidate', limit = 100): RelationCandidate[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT id FROM relation_candidates WHERE status = ? ORDER BY created_at ASC LIMIT ?')
      .all(status, Math.max(1, Math.min(500, limit))) as Array<{ id?: string }>
    return rows.flatMap((row) => typeof row.id === 'string' ? [this.relationCandidate(row.id)!] : [])
  }

  reviewRelationCandidate(id: string, approve: boolean, now = Date.now()): RelationCandidate {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.relationCandidate(id)
      if (candidate === undefined || candidate.status !== 'candidate') throw new Error('relation candidate is unavailable')
      const from = this.get(candidate.fromId)
      const to = this.get(candidate.toId)
      const invalid = from === undefined || to === undefined || from.status !== 'approved' || to.status !== 'approved' ||
        from.revision !== candidate.fromRevision || to.revision !== candidate.toRevision || !this.hasSourceMessages(candidate.evidenceIds)
      const status = invalid ? 'stale' : approve ? 'approved' : 'rejected'
      const changed = this.db.prepare("UPDATE relation_candidates SET status = ? WHERE id = ? AND status = 'candidate'").run(status, id)
      if (Number(changed.changes ?? 0) !== 1) throw new Error('relation candidate changed concurrently')
      if (invalid || !approve) {
        this.invalidateCaches()
        this.db.exec('COMMIT')
        return this.relationCandidate(id)!
      }
      // Re-read endpoints under the same write transaction immediately before
      // materializing the relation; a stale revision never becomes authoritative.
      const currentFrom = this.get(candidate.fromId)
      const currentTo = this.get(candidate.toId)
      if (currentFrom?.status !== 'approved' || currentTo?.status !== 'approved' ||
          currentFrom.revision !== candidate.fromRevision || currentTo.revision !== candidate.toRevision ||
          !this.hasSourceMessages(candidate.evidenceIds)) {
        throw new Error('relation endpoints or evidence changed during review')
      }
      this.db.prepare(
        `INSERT INTO memory_relations(id, from_id, to_id, relation_type, evidence_ids, from_revision, to_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(from_id, to_id, relation_type) DO UPDATE SET evidence_ids = excluded.evidence_ids,
         from_revision = excluded.from_revision, to_revision = excluded.to_revision, created_at = excluded.created_at`,
      ).run(id.replace(/^relc_/u, 'rel_'), candidate.fromId, candidate.toId, candidate.type, JSON.stringify(candidate.evidenceIds), candidate.fromRevision, candidate.toRevision, now)
      this.appendEventInTransaction({ eventId: `relation:${id}`, type: 'relation', sourceId: candidate.fromId, count: 1, metadata: { toId: candidate.toId, type: candidate.type } }, now)
      this.invalidateCaches()
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.relationCandidate(id)!
  }

  relationsFor(memoryId: string, limit = 40, knownAt?: number): RelationRecord[] {
    this.ensureOpen()
    const boundedLimit = Math.max(1, Math.min(200, limit))
    const rows = (knownAt === undefined
      ? this.db.prepare(`SELECT * FROM memory_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(memoryId, memoryId, boundedLimit)
      : this.db.prepare(`SELECT * FROM memory_relations WHERE (from_id = ? OR to_id = ?) AND created_at <= ? ORDER BY created_at DESC LIMIT ?`)
        .all(memoryId, memoryId, knownAt, boundedLimit)) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), fromId: String(row.from_id), toId: String(row.to_id),
      type: String(row.relation_type) as RelationRecord['type'], evidenceIds: parseIds(row.evidence_ids),
      sourceRevision: Number(row.from_revision), fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), createdAt: Number(row.created_at) }))
  }

  dependencyRelationsFrom(memoryId: string, limit = 200): { relations: RelationRecord[]; truncated: boolean } {
    this.ensureOpen()
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const rows = this.db.prepare(
      "SELECT * FROM memory_relations WHERE from_id = ? AND relation_type IN ('depends_on', 'derived_from') ORDER BY created_at ASC, id ASC LIMIT ?",
    ).all(memoryId, boundedLimit + 1) as Array<Record<string, unknown>>
    const page = rows.slice(0, boundedLimit).map((row) => ({ id: String(row.id), fromId: String(row.from_id), toId: String(row.to_id),
      type: String(row.relation_type) as RelationRecord['type'], evidenceIds: parseIds(row.evidence_ids),
      sourceRevision: Number(row.from_revision), fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), createdAt: Number(row.created_at) }))
    return { relations: page, truncated: rows.length > boundedLimit }
  }

  dependencyRelationsFor(memoryIds: string[], limit = 200): Map<string, { relations: RelationRecord[]; truncated: boolean }> {
    this.ensureOpen()
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const unique = [...new Set(memoryIds)].filter((id) => id !== '')
    const result = new Map<string, { relations: RelationRecord[]; truncated: boolean }>()
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100)
      const rows = this.db.prepare(`SELECT * FROM (
          SELECT r.*, ROW_NUMBER() OVER (PARTITION BY from_id ORDER BY created_at ASC, id ASC) AS row_ordinal,
            COUNT(*) OVER (PARTITION BY from_id) AS relation_total
          FROM memory_relations r WHERE from_id IN (${batch.map(() => '?').join(',')})
            AND relation_type IN ('depends_on', 'derived_from')
        ) WHERE row_ordinal <= ? ORDER BY from_id ASC, created_at ASC, id ASC`).all(...batch, boundedLimit + 1) as Array<Record<string, unknown>>
      for (const id of batch) result.set(id, { relations: [], truncated: false })
      for (const row of rows) {
        const fromId = String(row.from_id)
        const entry = result.get(fromId)
        if (entry === undefined) continue
        if (Number(row.row_ordinal) > boundedLimit || Number(row.relation_total) > boundedLimit) entry.truncated = true
        if (Number(row.row_ordinal) <= boundedLimit) entry.relations.push({ id: String(row.id), fromId, toId: String(row.to_id),
          type: String(row.relation_type) as RelationRecord['type'], evidenceIds: parseIds(row.evidence_ids),
          sourceRevision: Number(row.from_revision), fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), createdAt: Number(row.created_at) })
      }
    }
    return result
  }

  dependencyRelationsAll(limit = 500): RelationRecord[] {
    this.ensureOpen()
    const rows = this.db.prepare(
      "SELECT * FROM memory_relations WHERE relation_type IN ('depends_on', 'derived_from') ORDER BY created_at ASC, id ASC LIMIT ?",
    ).all(Math.max(1, Math.min(2000, Math.floor(limit)))) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), fromId: String(row.from_id), toId: String(row.to_id),
      type: String(row.relation_type) as RelationRecord['type'], evidenceIds: parseIds(row.evidence_ids),
      sourceRevision: Number(row.from_revision), fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), createdAt: Number(row.created_at) }))
  }

  dependencyClosure(memoryIds: string[], limit = 500): { ids: string[]; truncated: boolean } {
    this.ensureOpen()
    const maxIds = Math.max(1, Math.min(5000, Math.floor(limit)))
    const rows = this.db.prepare("SELECT from_id, to_id FROM memory_relations WHERE relation_type IN ('depends_on', 'derived_from') ORDER BY created_at ASC, id ASC")
      .all() as Array<{ from_id?: string; to_id?: string }>
    const adjacent = new Map<string, Set<string>>()
    for (const row of rows) {
      if (typeof row.from_id !== 'string' || typeof row.to_id !== 'string') continue
      const from = adjacent.get(row.from_id) ?? new Set<string>()
      from.add(row.to_id)
      adjacent.set(row.from_id, from)
    }
    const ids = new Set<string>()
    const queue = [...new Set(memoryIds)]
    let cursor = 0
    while (cursor < queue.length && ids.size < maxIds) {
      const id = queue[cursor++]!
      if (ids.has(id)) continue
      ids.add(id)
      for (const neighbor of adjacent.get(id) ?? []) if (!ids.has(neighbor)) queue.push(neighbor)
    }
    return { ids: [...ids], truncated: cursor < queue.length }
  }

  boundedRelationNeighborhood(startIds: string[], depth = 2, limit = 40): { relations: RelationRecord[]; visitedIds: string[]; truncated: boolean } {
    this.ensureOpen()
    const maxDepth = Math.max(0, Math.min(2, Math.floor(depth)))
    const maxRelations = Math.max(1, Math.min(40, Math.floor(limit)))
    const visited = new Set(startIds)
    const frontier = [...new Set(startIds)]
    const selected = new Map<string, RelationRecord>()
    for (let level = 0; level < maxDepth && frontier.length > 0 && selected.size < maxRelations; level += 1) {
      const next: string[] = []
      for (const id of frontier) {
        for (const relation of this.relationsFor(id, maxRelations)) {
          selected.set(relation.id, relation)
          const neighbor = relation.fromId === id ? relation.toId : relation.fromId
          if (!visited.has(neighbor)) { visited.add(neighbor); next.push(neighbor) }
          if (selected.size >= maxRelations) break
        }
        if (selected.size >= maxRelations) break
      }
      frontier.splice(0, frontier.length, ...next)
    }
    return { relations: [...selected.values()], visitedIds: [...visited], truncated: selected.size >= maxRelations }
  }

  upsertTaskContext(input: Omit<TaskContextRecord, 'revision' | 'updatedAt' | 'staleSources' | 'sourceRevisions'> & { expectedRevision?: number; lastVerifiedAt?: number; sourceRevisions?: Record<string, number> }, now = Date.now()): TaskContextRecord {
    this.ensureOpen()
    if (input.taskRef.trim() === '' || input.goal.trim() === '' || input.taskRef.length > 160) throw new Error('task context needs a stable task_ref and goal')
    const sourceIds = [...new Set(input.sourceMemoryIds)]
    const sources = sourceIds.map((id) => this.get(id))
    if (sources.some((record) => record === undefined || record.status !== 'approved')) throw new Error('task context sources must be approved same-project memories')
    const sourceRevisions = input.sourceRevisions ?? Object.fromEntries(sources.flatMap((record) => record === undefined ? [] : [[record.id, record.revision] as const]))
    if (sourceIds.some((id) => !Number.isSafeInteger(sourceRevisions[id]) || sourceRevisions[id]! < 1)) throw new Error('task dependency snapshot is incomplete')
    const existing = this.db.prepare('SELECT revision FROM task_contexts WHERE task_ref = ?').get(input.taskRef) as { revision?: number } | undefined
    const previousRevision = Number(existing?.revision ?? 0)
    if ((input.expectedRevision ?? previousRevision) !== previousRevision) throw new Error('task context changed; reload before saving')
    const revision = previousRevision + 1
    this.db.prepare(
      `INSERT INTO task_contexts(task_ref, goal, constraints_json, completed_json, pending_json, known_unknowns_json,
         confirmed_facts_json, assumptions_json, blockers_json, artifact_refs_json, source_memory_ids, source_revisions,
         status, revision, updated_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_ref) DO UPDATE SET goal = excluded.goal, constraints_json = excluded.constraints_json,
         completed_json = excluded.completed_json, pending_json = excluded.pending_json, known_unknowns_json = excluded.known_unknowns_json,
         confirmed_facts_json = excluded.confirmed_facts_json, assumptions_json = excluded.assumptions_json, blockers_json = excluded.blockers_json,
         artifact_refs_json = excluded.artifact_refs_json, source_memory_ids = excluded.source_memory_ids, source_revisions = excluded.source_revisions,
         status = excluded.status, revision = excluded.revision, updated_at = excluded.updated_at, last_verified_at = excluded.last_verified_at`,
    ).run(input.taskRef, input.goal, JSON.stringify(input.constraints), JSON.stringify(input.completed), JSON.stringify(input.pending),
      JSON.stringify(input.knownUnknowns), JSON.stringify(input.confirmedFacts), JSON.stringify(input.assumptions), JSON.stringify(input.blockers),
      JSON.stringify(input.artifactRefs), JSON.stringify(sourceIds), JSON.stringify(sourceRevisions), input.status, revision, now, input.lastVerifiedAt ?? null)
    this.invalidateCaches()
    return this.taskContext(input.taskRef)!
  }

  taskContext(taskRef: string): TaskContextRecord | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM task_contexts WHERE task_ref = ?').get(taskRef) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const sourceMemoryIds = parseIds(row.source_memory_ids)
    const sourceRevisions = parseJson<Record<string, number>>(row.source_revisions, {})
    const staleSources = sourceMemoryIds.filter((id) => {
      const memory = this.get(id)
      return memory === undefined || memory.status !== 'approved' || memory.revision !== sourceRevisions[id]
    })
    return {
      taskRef: String(row.task_ref), goal: String(row.goal), constraints: parseJson(row.constraints_json, []),
      completed: parseJson(row.completed_json, []), pending: parseJson(row.pending_json, []), knownUnknowns: parseJson(row.known_unknowns_json, []),
      confirmedFacts: parseJson(row.confirmed_facts_json, []), assumptions: parseJson(row.assumptions_json, []), blockers: parseJson(row.blockers_json, []),
      artifactRefs: parseJson(row.artifact_refs_json, []), sourceMemoryIds, sourceRevisions,
      status: String(row.status) as TaskContextRecord['status'], revision: Number(row.revision), updatedAt: Number(row.updated_at),
      ...(row.last_verified_at === null || row.last_verified_at === undefined ? {} : { lastVerifiedAt: Number(row.last_verified_at) }), staleSources,
    }
  }

  taskContexts(limit = 100): TaskContextRecord[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT task_ref FROM task_contexts ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))) as Array<{ task_ref?: string }>
    return rows.flatMap((row) => typeof row.task_ref === 'string' ? [this.taskContext(row.task_ref)!] : [])
  }

  saveExperience(input: Omit<ExperienceRecord, 'sourceRevisions' | 'independentSources' | 'createdAt' | 'updatedAt' | 'reviewedAt' | 'status'> & { status?: 'episode' | 'candidate'; sourceRevisions?: Record<string, number> }, now = Date.now()): ExperienceRecord {
    this.ensureOpen()
    const title = input.title.trim()
    const symptom = input.symptom.trim()
    const evidenceIds = [...new Set(input.evidenceMemoryIds)]
    if (title === '' || symptom === '' || evidenceIds.length === 0) throw new Error('experience needs a title, symptom and approved evidence')
    const evidence = evidenceIds.map((id) => this.get(id))
    if (evidence.some((memory) => memory === undefined || memory.status !== 'approved')) throw new Error('experience evidence must be approved same-project memories')
    const sourceRevisions = input.sourceRevisions ?? Object.fromEntries(evidence.flatMap((memory) => memory === undefined ? [] : [[memory.id, memory.revision] as const]))
    if (evidenceIds.some((id) => !Number.isSafeInteger(sourceRevisions[id]) || sourceRevisions[id]! < 1)) throw new Error('experience dependency snapshot is incomplete')
    const roots = this.independentSourceCount(evidenceIds)
    const status = input.status ?? 'episode'
    const existing = this.db.prepare('SELECT created_at, reviewed_at FROM experience_cards WHERE id = ?').get(input.id) as { created_at?: number; reviewed_at?: number | null } | undefined
    const createdAt = Number(existing?.created_at ?? now)
    this.db.prepare(
      `INSERT INTO experience_cards(id, title, symptom, environment_json, prerequisites_json, steps_json, outcomes_json, counterexamples_json,
         evidence_memory_ids, source_revisions, status, independent_sources, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, symptom = excluded.symptom, environment_json = excluded.environment_json,
         prerequisites_json = excluded.prerequisites_json, steps_json = excluded.steps_json, outcomes_json = excluded.outcomes_json,
         counterexamples_json = excluded.counterexamples_json, evidence_memory_ids = excluded.evidence_memory_ids,
         source_revisions = excluded.source_revisions, status = excluded.status, reviewed_at = NULL,
         independent_sources = excluded.independent_sources, updated_at = excluded.updated_at`,
    ).run(input.id, title, symptom, JSON.stringify(input.environment), JSON.stringify(input.prerequisites), JSON.stringify(input.steps),
      JSON.stringify(input.outcomes), JSON.stringify(input.counterexamples), JSON.stringify(evidenceIds), JSON.stringify(sourceRevisions), status,
      roots, existing?.reviewed_at ?? null, createdAt, now)
    this.invalidateCaches()
    return this.experience(input.id)!
  }

  reviewExperience(id: string, approve: boolean, now = Date.now()): ExperienceRecord {
    this.ensureOpen()
    const card = this.experience(id)
    if (card === undefined || card.status === 'stale') throw new Error('experience is unavailable or stale')
    const validSources = card.evidenceMemoryIds.every((sourceId) => {
      const record = this.get(sourceId)
      return record !== undefined && record.status === 'approved' && record.revision === card.sourceRevisions[sourceId]
    })
    if (!validSources) {
      this.db.prepare("UPDATE experience_cards SET status = 'stale', updated_at = ? WHERE id = ?").run(now, id)
      return this.experience(id)!
    }
    if (approve && card.independentSources < 2) throw new Error('verified experience requires at least two independent source roots; keep it as an episode/candidate')
    const status = approve ? 'verified' : 'rejected'
    this.db.prepare('UPDATE experience_cards SET status = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(status, now, now, id)
    this.invalidateCaches()
    this.appendEvent({ eventId: `experience-review:${id}:${status}:${now}`, type: 'experience_review', count: 1, metadata: { status, independentSources: card.independentSources } }, now)
    return this.experience(id)!
  }

  experience(id: string): ExperienceRecord | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM experience_cards WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const evidenceMemoryIds = parseIds(row.evidence_memory_ids)
    const sourceRevisions = parseJson<Record<string, number>>(row.source_revisions, {})
    const stale = evidenceMemoryIds.some((sourceId) => {
      const memory = this.get(sourceId)
      return memory === undefined || memory.status !== 'approved' || memory.revision !== sourceRevisions[sourceId]
    })
    return {
      id: String(row.id), title: String(row.title), symptom: String(row.symptom), environment: parseJson(row.environment_json, {}),
      prerequisites: parseJson(row.prerequisites_json, []), steps: parseJson(row.steps_json, []), outcomes: parseJson(row.outcomes_json, []),
      counterexamples: parseJson(row.counterexamples_json, []), evidenceMemoryIds, sourceRevisions,
      status: stale ? 'stale' : String(row.status) as ExperienceRecord['status'], independentSources: Number(row.independent_sources),
      ...(row.reviewed_at === null || row.reviewed_at === undefined ? {} : { reviewedAt: Number(row.reviewed_at) }),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  experiences(status?: ExperienceRecord['status'], limit = 100): ExperienceRecord[] {
    this.ensureOpen()
    const rows = status === undefined
      ? this.db.prepare('SELECT id FROM experience_cards ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)))
      : this.db.prepare('SELECT id FROM experience_cards WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, Math.max(1, Math.min(500, limit)))
    return (rows as Array<{ id?: string }>).flatMap((row) => typeof row.id === 'string' ? [this.experience(row.id)!] : [])
  }

  /**
   * Compare an experience card with caller-reported current condition facts.
   *
   * The legacy `environment` argument keeps its old meaning. Two optional
   * bounded facts may be added: `conditions` (extra environment key/value
   * facts, with the legacy environment winning on a duplicate key) and
   * `satisfiedPrerequisites` (exact normalized statements the caller declares
   * as currently satisfied). These inputs describe current conditions only;
   * this method never changes a card status, never upgrades episode/candidate
   * to verified and never grants execution authority.
   */
  matchExperiences(query: string, environment: Record<string, string>, limit = 10, options: {
    conditions?: Record<string, string>
    satisfiedPrerequisites?: string[]
  } = {}): Array<{
    experience: ExperienceRecord
    applicability: ExperienceConditionMatch['applicability']
    reviewNeeded: boolean
    matched: string[]
    missing: string[]
    different: Array<{ key: string; expected: string; actual: string }>
    conditionState: ExperienceConditionMatch['conditionState']
    truncated: boolean
    prerequisites: { satisfied: string[]; unresolved: string[] }
    counterexampleMatches: string[]
    verified: boolean
    executionAuthorized: false
    conditionSource: 'caller_reported'
  }> {
    this.ensureOpen()
    const terms = [...new Set(tokenize(query).filter((term) => term.length > 1))].slice(0, 8)
    const candidates = this.experiences(undefined, 500).filter((card) => card.status !== 'stale')
      .map((card) => ({ card, score: terms.reduce((sum, term) => sum + (card.symptom.toLowerCase().includes(term) || card.title.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter((item) => terms.length === 0 || item.score > 0).sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt).slice(0, Math.max(1, Math.min(50, limit)))
    // Caller-reported facts are bounded and never persisted. The legacy
    // `environment` field wins when both sources name the same key so old
    // callers keep their exact comparison input.
    const facts: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.conditions ?? {}).slice(0, 32)) {
      if (typeof key !== 'string' || key === '' || key.length > 80 || typeof value !== 'string' || value.length > 300) continue
      facts[key] = value
    }
    for (const [key, value] of Object.entries(environment).slice(0, 32)) {
      if (typeof key !== 'string' || key === '' || key.length > 80 || typeof value !== 'string' || value.length > 300) continue
      facts[key] = value
    }
    const satisfiedPrerequisites = [...new Set((options.satisfiedPrerequisites ?? [])
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().slice(0, 300)))].slice(0, 32)
    return candidates.map(({ card }) => {
      const conditionContext = normalizeMemoryText(`${query} ${Object.entries(facts).map(([key, value]) => `${key} ${value}`).join(' ')}`).toLocaleLowerCase()
      // Counterexamples are only matched from the caller's own explicit words
      // plus supplied facts; a stored counterexample is never assumed to apply.
      const counterexampleMatches = card.counterexamples.filter((example) => {
        const normalized = normalizeMemoryText(example).toLocaleLowerCase()
        return normalized.length >= 4 && conditionContext.includes(normalized)
      })
      const match = matchExperienceConditions({ expected: card.environment, actual: facts, prerequisites: card.prerequisites,
        satisfiedPrerequisites, counterexampleMatches })
      const reviewNeeded = card.status !== 'verified' || match.truncated || match.unresolvedPrerequisites.length > 0 ||
        (card.counterexamples.length > 0 && match.counterexampleMatches.length === 0)
      return { experience: card, applicability: match.applicability, reviewNeeded, matched: match.matched, missing: match.missing,
        different: match.different, conditionState: match.conditionState, truncated: match.truncated,
        prerequisites: { satisfied: match.satisfiedPrerequisites, unresolved: match.unresolvedPrerequisites },
        counterexampleMatches: match.counterexampleMatches, verified: card.status === 'verified',
        executionAuthorized: false as const, conditionSource: 'caller_reported' as const }
    })
  }

  private independentSourceCount(memoryIds: string[]): number {
    const roots = new Set<string>()
    const visited = new Set<string>()
    const pending = [...memoryIds]
    while (pending.length > 0 && visited.size < 500) {
      const memoryId = pending.pop()!
      if (visited.has(memoryId)) continue
      visited.add(memoryId)
      const row = this.db.prepare('SELECT source_message_ids FROM l1_memories WHERE id = ?').get(memoryId) as { source_message_ids?: string } | undefined
      for (const sourceId of parseIds(row?.source_message_ids)) {
        const source = this.db.prepare('SELECT id, derived_from FROM l0_messages WHERE id = ?').get(sourceId) as { id?: string; derived_from?: string } | undefined
        const derived = parseIds(source?.derived_from)
        if (derived.length > 0) pending.push(...derived)
        else roots.add(source?.id ?? sourceId)
      }
    }
    return roots.size
  }

  saveEvaluationCase(input: Omit<EvaluationCase, 'createdAt' | 'updatedAt'>, now = Date.now()): EvaluationCase {
    this.ensureOpen()
    if (input.id.trim() === '' || input.title.trim() === '' || input.query.trim() === '') throw new Error('evaluation case needs id, title and query')
    if (!['synthetic', 'approved'].includes(input.source)) throw new Error('evaluation source must be synthetic or approved')
    const existing = this.db.prepare('SELECT created_at FROM evaluation_cases WHERE id = ?').get(input.id) as { created_at?: number } | undefined
    const createdAt = Number(existing?.created_at ?? now)
    this.db.prepare(
      `INSERT INTO evaluation_cases(id, title, query, expected_ids, forbidden_ids, fixture_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, query = excluded.query,
         expected_ids = excluded.expected_ids, forbidden_ids = excluded.forbidden_ids, fixture_json = excluded.fixture_json,
         source = excluded.source, updated_at = excluded.updated_at`,
    ).run(input.id, input.title, input.query, JSON.stringify(input.expectedIds), JSON.stringify(input.forbiddenIds), JSON.stringify(input.fixture), input.source, createdAt, now)
    return this.evaluationCase(input.id)!
  }

  evaluationCase(id: string): EvaluationCase | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM evaluation_cases WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { id: String(row.id), title: String(row.title), query: String(row.query),
      expectedIds: parseIds(row.expected_ids), forbiddenIds: parseIds(row.forbidden_ids), fixture: parseJson(row.fixture_json, {}),
      source: String(row.source) as EvaluationCase['source'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
  }

  evaluationCases(limit = 100): EvaluationCase[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT id FROM evaluation_cases ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))) as Array<{ id?: string }>
    return rows.flatMap((row) => typeof row.id === 'string' ? [this.evaluationCase(row.id)!] : [])
  }

  deleteEvaluationCase(id: string): boolean {
    this.ensureOpen()
    return Number(this.db.prepare('DELETE FROM evaluation_cases WHERE id = ?').run(id).changes ?? 0) > 0
  }

  createRetrievalStrategy(input: { title: string; baseId: string; config: { maxCandidates: number; maxResults: number } }, now = Date.now()): RetrievalStrategy {
    this.ensureOpen()
    const title = input.title.trim().slice(0, 120)
    const maxCandidates = Math.max(10, Math.min(200, Math.floor(input.config.maxCandidates)))
    const maxResults = Math.max(1, Math.min(12, Math.floor(input.config.maxResults)))
    if (title === '') throw new Error('strategy candidate needs a title')
    const active = this.selectedRetrievalStrategyId()
    if (active !== input.baseId) throw new Error('selected strategy changed; reload before creating a candidate')
    const id = `str_${randomUUID().replace(/-/gu, '').slice(0, 20)}`
    this.db.prepare(
      `INSERT INTO retrieval_strategies(id, title, base_id, config_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'candidate', ?, ?)`,
    ).run(id, title, input.baseId, JSON.stringify({ maxCandidates, maxResults }), now, now)
    return this.retrievalStrategy(id)!
  }

  retrievalStrategy(id: string): RetrievalStrategy | undefined {
    this.ensureOpen()
    if (id === 'builtin-v1') return { id, title: '基线（内置）', baseId: '', config: { maxCandidates: 50, maxResults: 6 }, status: 'selected', createdAt: 0, updatedAt: 0 }
    const row = this.db.prepare('SELECT * FROM retrieval_strategies WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return { id: String(row.id), title: String(row.title), baseId: String(row.base_id),
      config: parseJson(row.config_json, { maxCandidates: 50, maxResults: 6 }),
      status: String(row.status) as RetrievalStrategy['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
  }

  retrievalStrategies(limit = 100): RetrievalStrategy[] {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT id FROM retrieval_strategies ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(300, limit))) as Array<{ id?: string }>
    return rows.flatMap((row) => typeof row.id === 'string' ? [this.retrievalStrategy(row.id)!] : [])
  }

  markRetrievalStrategyShadow(id: string, now = Date.now()): RetrievalStrategy {
    this.ensureOpen()
    const candidate = this.retrievalStrategy(id)
    if (candidate === undefined || candidate.status !== 'candidate') throw new Error('only a candidate strategy can enter shadow evaluation')
    if (candidate.baseId !== this.selectedRetrievalStrategyId()) throw new Error('selected strategy changed; rebuild the candidate from the current baseline')
    this.db.prepare("UPDATE retrieval_strategies SET status = 'shadow', updated_at = ? WHERE id = ? AND status = 'candidate'").run(now, id)
    return this.retrievalStrategy(id)!
  }

  selectedRetrievalStrategyId(): string {
    this.ensureOpen()
    const row = this.db.prepare("SELECT value FROM retrieval_state WHERE key = 'selected_strategy_id'").get() as { value?: string } | undefined
    return row?.value ?? 'builtin-v1'
  }

  selectRetrievalStrategy(id: string, now = Date.now()): { selected: RetrievalStrategy; previousId: string } {
    this.ensureOpen()
    const candidate = this.retrievalStrategy(id)
    if (candidate === undefined || candidate.status !== 'shadow') throw new Error('only a shadow-evaluated strategy can be selected')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previousId = this.selectedRetrievalStrategyId()
      if (candidate.baseId !== previousId) throw new Error('strategy base changed; re-run evaluation before selecting')
      if (previousId !== 'builtin-v1') this.db.prepare("UPDATE retrieval_strategies SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'selected'").run(now, previousId)
      this.db.prepare("UPDATE retrieval_strategies SET status = 'selected', updated_at = ? WHERE id = ? AND status = 'shadow'").run(now, id)
      this.db.prepare("UPDATE retrieval_state SET value = ? WHERE key = 'selected_strategy_id'").run(id)
      this.db.exec('COMMIT')
      return { selected: this.retrievalStrategy(id)!, previousId }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  rollbackRetrievalStrategy(id: string, expectedCurrentId: string, now = Date.now()): string {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const currentId = this.selectedRetrievalStrategyId()
      const current = this.retrievalStrategy(currentId)
      if (currentId !== expectedCurrentId || current?.baseId !== id) throw new Error('selected strategy changed; rollback preview is stale')
      if (id !== 'builtin-v1' && this.retrievalStrategy(id) === undefined) throw new Error('rollback target is unavailable')
      this.db.prepare("UPDATE retrieval_strategies SET status = 'rolled_back', updated_at = ? WHERE id = ? AND status = 'selected'").run(now, currentId)
      if (id !== 'builtin-v1') this.db.prepare("UPDATE retrieval_strategies SET status = 'selected', updated_at = ? WHERE id = ?").run(now, id)
      this.db.prepare("UPDATE retrieval_state SET value = ? WHERE key = 'selected_strategy_id'").run(id)
      this.db.exec('COMMIT')
      return id
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  saveEvaluationRun(input: Omit<EvaluationRun, 'id' | 'createdAt'>, now = Date.now()): EvaluationRun {
    this.ensureOpen()
    const id = `run_${randomUUID().replace(/-/gu, '').slice(0, 20)}`
    this.db.prepare('INSERT INTO evaluation_runs(id, pair_id, case_id, strategy_id, role, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.pairId ?? null, input.caseId, input.strategyId, input.role, JSON.stringify(input.result), now)
    return { ...input, id, createdAt: now }
  }

  evaluationRuns(strategyId?: string, limit = 500): EvaluationRun[] {
    this.ensureOpen()
    const rows = strategyId === undefined
      ? this.db.prepare('SELECT * FROM evaluation_runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(2000, limit)))
      : this.db.prepare('SELECT * FROM evaluation_runs WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?').all(strategyId, Math.max(1, Math.min(2000, limit)))
    return (rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), ...(typeof row.pair_id === 'string' ? { pairId: row.pair_id } : {}),
      caseId: String(row.case_id), strategyId: String(row.strategy_id),
      role: String(row.role) as EvaluationRun['role'], result: parseJson(row.result_json, { hits: [], missing: [], forbidden: [], hardGate: false, score: 0, stopReason: 'unknown' }), createdAt: Number(row.created_at) }))
  }

  evaluationRunsPage(after?: { createdAt: number; id: string }, limit = 40): { runs: EvaluationRun[]; next?: { createdAt: number; id: string } } {
    this.ensureOpen()
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = after === undefined
      ? this.db.prepare('SELECT * FROM evaluation_runs ORDER BY created_at DESC, id DESC LIMIT ?').all(boundedLimit + 1)
      : this.db.prepare('SELECT * FROM evaluation_runs WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(after.createdAt, after.createdAt, after.id, boundedLimit + 1)
    const hasMore = rows.length > boundedLimit
    const pageRows = (rows as Array<Record<string, unknown>>).slice(0, boundedLimit)
    const runs = pageRows.map((row) => ({ id: String(row.id), ...(typeof row.pair_id === 'string' ? { pairId: row.pair_id } : {}),
      caseId: String(row.case_id), strategyId: String(row.strategy_id), role: String(row.role) as EvaluationRun['role'],
      result: parseJson(row.result_json, { hits: [], missing: [], forbidden: [], hardGate: false, score: 0, stopReason: 'unknown' }), createdAt: Number(row.created_at) }))
    const last = pageRows.at(-1)
    return { runs, ...(hasMore && last !== undefined ? { next: { createdAt: Number(last.created_at), id: String(last.id) } } : {}) }
  }

  evaluationRunsForPairs(pairIds: string[], limit = 500): EvaluationRun[] {
    this.ensureOpen()
    const unique = [...new Set(pairIds)].slice(0, 100)
    if (unique.length === 0) return []
    const rows = this.db.prepare(`SELECT * FROM evaluation_runs WHERE pair_id IN (${unique.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...unique, Math.max(1, Math.min(1000, Math.floor(limit)))) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), ...(typeof row.pair_id === 'string' ? { pairId: row.pair_id } : {}),
      caseId: String(row.case_id), strategyId: String(row.strategy_id), role: String(row.role) as EvaluationRun['role'],
      result: parseJson(row.result_json, { hits: [], missing: [], forbidden: [], hardGate: false, score: 0, stopReason: 'unknown' }), createdAt: Number(row.created_at) }))
  }

  purgeEvaluationRunsForMemories(memoryIds: string[]): number {
    this.ensureOpen()
    const targets = new Set(memoryIds)
    if (targets.size === 0) return 0
    const rows = this.db.prepare('SELECT id, pair_id, result_json FROM evaluation_runs').all() as Array<Record<string, unknown>>
    const pairIds = new Set<string>()
    const standaloneIds = new Set<string>()
    for (const row of rows) {
      if (typeof row.id !== 'string' || !evaluationRunMentionsMemory(row.result_json, targets, projectKeyOfFile(this.file))) continue
      if (typeof row.pair_id === 'string') pairIds.add(row.pair_id)
      else standaloneIds.add(row.id)
    }
    if (pairIds.size === 0 && standaloneIds.size === 0) return 0
    const removePair = this.db.prepare('DELETE FROM evaluation_runs WHERE pair_id = ?')
    const removeRun = this.db.prepare('DELETE FROM evaluation_runs WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let removed = 0
      for (const pairId of pairIds) removed += Number(removePair.run(pairId).changes ?? 0)
      for (const id of standaloneIds) removed += Number(removeRun.run(id).changes ?? 0)
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return removed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  purgeEvaluationRunsForSourceRefs(sourceRefs: Array<{ projectKey: string; id: string }>): number {
    this.ensureOpen()
    const targets = new Set(sourceRefs.map(({ projectKey, id }) => JSON.stringify([projectKey, id])))
    if (targets.size === 0) return 0
    const rows = this.db.prepare('SELECT id, pair_id, result_json FROM evaluation_runs').all() as Array<Record<string, unknown>>
    const pairIds = new Set<string>()
    const standaloneIds = new Set<string>()
    for (const row of rows) {
      if (typeof row.id !== 'string' || !evaluationRunMentionsSourceRefs(row.result_json, targets)) continue
      if (typeof row.pair_id === 'string') pairIds.add(row.pair_id)
      else standaloneIds.add(row.id)
    }
    if (pairIds.size === 0 && standaloneIds.size === 0) return 0
    const removePair = this.db.prepare('DELETE FROM evaluation_runs WHERE pair_id = ?')
    const removeRun = this.db.prepare('DELETE FROM evaluation_runs WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let removed = 0
      for (const pairId of pairIds) removed += Number(removePair.run(pairId).changes ?? 0)
      for (const id of standaloneIds) removed += Number(removeRun.run(id).changes ?? 0)
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return removed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  get(id: string): MemoryRecord | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT * FROM l1_memories WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toRecord(row) : undefined
  }

  statusOf(id: string): MemoryStatus | undefined {
    this.ensureOpen()
    const row = this.db.prepare('SELECT status FROM l1_memories WHERE project_key = ? AND id = ?')
      .get(projectKeyOfFile(this.file), id) as { status?: unknown } | undefined
    return row?.status === 'candidate' || row?.status === 'approved' || row?.status === 'forgotten' ? row.status : undefined
  }

  /** One raw approved-row keyset page for the internal visibility reader; no body or JSON enters JS. */
  dashboardVisibilityMemoryPage(after?: DashboardVisibilityMemoryCursor, limit = 16, status: MemoryStatus = 'approved'): {
    rows: DashboardVisibilityMemoryPageRow[]; hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(16, limit)) : 16
    if (!['candidate', 'approved', 'forgotten'].includes(status)) throw new TypeError('visibility memory status is invalid')
    if (after !== undefined && (!Number.isSafeInteger(after.createdAt) || typeof after.id !== 'string' ||
        Buffer.byteLength(after.id, 'utf8') > 256)) throw new TypeError('visibility memory cursor is invalid')
    const projectKey = projectKeyOfFile(this.file)
    const rows = (after === undefined
      ? this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
          length(CAST(id AS BLOB)) AS id_bytes, created_at
        FROM l1_memories WHERE project_key = ? AND status = ?
        ORDER BY l1_memories.created_at ASC, l1_memories.id ASC LIMIT ?`).all(projectKey, status, bounded)
      : this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
          length(CAST(id AS BLOB)) AS id_bytes, created_at
        FROM l1_memories WHERE project_key = ? AND status = ?
          AND (l1_memories.created_at, l1_memories.id) > (?, ?)
        ORDER BY l1_memories.created_at ASC, l1_memories.id ASC LIMIT ?`).all(projectKey, status, after.createdAt, after.id, bounded)) as Array<Record<string, unknown>>
    return {
      rows: rows.map((row) => ({ ...(typeof row.id === 'string' ? { id: row.id } : {}),
        idBytes: Number(row.id_bytes), createdAt: Number(row.created_at) })),
      hasMore: rows.length === bounded,
    }
  }

  /** Exact additive-index capability for the C route-II event association page. */
  dashboardEventsAssociationIndexReady(): boolean {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT
        CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 2048 THEN sql END AS sql,
        length(CAST(sql AS BLOB)) AS bytes
      FROM sqlite_master WHERE type = 'index' AND name = 'memory_events_association'`).get() as { sql?: unknown; bytes?: unknown } | undefined
    if (typeof row?.sql !== 'string' || !Number.isSafeInteger(row.bytes) || Number(row.bytes) > 2048) return false
    const normalized = row.sql.trim().toLowerCase().replace(/;$/u, '').replace(/\s+/gu, '')
    return normalized === 'createindexmemory_events_associationonmemory_events(project_key,type,source_id,created_at,id)' ||
      normalized === 'createindexifnotexistsmemory_events_associationonmemory_events(project_key,type,source_id,created_at,id)'
  }

  /** Exact additive-index capability; a same-name wrong definition is refused. */
  dashboardRecentIndexReady(): boolean {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT
        CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 2048 THEN sql END AS sql,
        length(CAST(sql AS BLOB)) AS bytes
      FROM sqlite_master WHERE type = 'index' AND name = 'l1_status_updated_page'`).get() as { sql?: unknown; bytes?: unknown } | undefined
    if (typeof row?.sql !== 'string' || !Number.isSafeInteger(row.bytes) || Number(row.bytes) > 2048) return false
    const normalized = row.sql.trim().toLowerCase().replace(/;$/, '').replace(/\s+/gu, '')
    return normalized === 'createindexl1_status_updated_pageonl1_memories(project_key,status,updated_atdesc,iddesc)' ||
      normalized === 'createindexifnotexistsl1_status_updated_pageonl1_memories(project_key,status,updated_atdesc,iddesc)'
  }

  /** Keyset page of current approved rows by updated_at/id for the separate recent capability. */
  dashboardRecentApprovedPage(after?: { updatedAt: number; id: string }, limit = 16): {
    rows: Array<{ id?: string; idBytes: number; updatedAt: number; createdAt: number }>; hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    const projectKey = projectKeyOfFile(this.file)
    const rows = (after === undefined
      ? this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
          length(CAST(id AS BLOB)) AS id_bytes, updated_at, created_at
        FROM l1_memories INDEXED BY l1_status_updated_page
        WHERE project_key = ? AND status = 'approved'
        ORDER BY l1_memories.updated_at DESC, l1_memories.id DESC LIMIT ?`).all(projectKey, bounded + 1)
      : this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
          length(CAST(id AS BLOB)) AS id_bytes, updated_at, created_at
        FROM l1_memories INDEXED BY l1_status_updated_page
        WHERE project_key = ? AND status = 'approved'
          AND (l1_memories.updated_at, l1_memories.id) < (?, ?)
        ORDER BY l1_memories.updated_at DESC, l1_memories.id DESC LIMIT ?`).all(projectKey, after.updatedAt, after.id, bounded + 1)) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => ({ ...(typeof row.id === 'string' ? { id: row.id } : {}),
      idBytes: Number(row.id_bytes), updatedAt: Number(row.updated_at), createdAt: Number(row.created_at) })),
      hasMore: rows.length > bounded }
  }

  /** Bounded status-aware point projection for management library/detail reads. */
  dashboardOverviewMemoryHeads(): { projectKey: string; connectionId: string; schemaVersion: number; eventTailId: number; ready: boolean;
    branches: Record<'candidate' | 'approved' | 'forgotten' | 'recent',
      Array<{ id?: string; idBytes: number; createdAt: number; updatedAt: number; contentBytes: number; sourceIdsBytes: number }>> } {
    this.ensureOpen()
    const projectKey = projectKeyOfFile(this.file)
    const branches = { candidate: [], approved: [], forgotten: [], recent: [] } as
      Record<'candidate' | 'approved' | 'forgotten' | 'recent',
        Array<{ id?: string; idBytes: number; createdAt: number; updatedAt: number; contentBytes: number; sourceIdsBytes: number }>>
    const capability = dashboardOverviewIndexCapabilitySql()
    const checked = this.db.prepare(`WITH ${capability} SELECT ready, schema_version,
      COALESCE((SELECT CASE WHEN typeof(id) = 'integer' AND id BETWEEN 1 AND 9007199254740991 THEN id ELSE -1 END
        FROM main.memory_events ORDER BY id DESC LIMIT 1), 0) AS event_tail_id
      FROM overview_index_capability CROSS JOIN pragma_schema_version`)
      .get() as { ready?: unknown; schema_version?: unknown; event_tail_id?: unknown } | undefined
    const schemaVersion = checked?.schema_version
    if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
      throw new Error('overview schema version is invalid')
    }
    const eventTailId = checked?.event_tail_id
    if (typeof eventTailId !== 'number' || !Number.isSafeInteger(eventTailId) || eventTailId < 0) {
      throw new Error('overview event tail is invalid')
    }
    const scope = { projectKey, connectionId: this.dashboardConnectionIdentity, schemaVersion, eventTailId }
    if (checked?.ready !== 1) return { ...scope, ready: false, branches }
    const fields = `CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
      length(CAST(id AS BLOB)) AS id_bytes,
      CASE WHEN typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991 THEN created_at END AS created_at,
      CASE WHEN typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991 THEN updated_at END AS updated_at,
      length(CAST(content AS BLOB)) AS content_bytes, length(CAST(source_message_ids AS BLOB)) AS source_ids_bytes`
    const selects = (['candidate', 'approved', 'forgotten', 'recent'] as const).map((branch) => {
      const recent = branch === 'recent'
      return `SELECT '${branch}' AS branch, * FROM (SELECT ${fields} FROM main.l1_memories INDEXED BY
        ${recent ? 'l1_status_updated_page' : 'l1_status_created_page'} WHERE project_key = ? AND status = ?
        ORDER BY ${recent ? 'l1_memories.updated_at DESC, l1_memories.id DESC' : 'l1_memories.created_at ASC, l1_memories.id ASC'}
        LIMIT (SELECT CASE WHEN ready = 1 THEN 4 ELSE 0 END FROM capability))`
    })
    // LIMIT is evaluated before each single-table seek. A failed capability
    // reads zero data rows; no outer join can force a sort before the row cap.
    // The shape check and data read share this statement's snapshot.
    const guard = `WITH ${capability}, capability AS MATERIALIZED (SELECT ready FROM overview_index_capability) `
    const rows = this.db.prepare(guard + selects.join(' UNION ALL ') +
      " UNION ALL SELECT 'capability', NULL, 0, ready, 0, 0, 0 FROM capability").all(projectKey, 'candidate', projectKey, 'approved',
      projectKey, 'forgotten', projectKey, 'approved') as Array<Record<string, unknown>>
    if (rows.at(-1)?.branch !== 'capability' || rows.at(-1)?.created_at !== 1) return { ...scope, ready: false, branches }
    rows.pop()
    for (const row of rows) {
      const branch = row.branch as keyof typeof branches
      if (!Object.hasOwn(branches, branch) || branches[branch].length >= 4) throw new Error('overview head shape is invalid')
      branches[branch].push({ ...(typeof row.id === 'string' ? { id: row.id } : {}), idBytes: Number(row.id_bytes),
        createdAt: typeof row.created_at === 'number' ? row.created_at : Number.NaN,
        updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Number.NaN,
        contentBytes: Number(row.content_bytes), sourceIdsBytes: Number(row.source_ids_bytes) })
    }
    // Compound SELECT output order is not part of the cursor contract. Sort
    // only the already-capped four rows per branch, using SQLite BINARY ID order.
    for (const branch of ['candidate', 'approved', 'forgotten', 'recent'] as const) {
      const recent = branch === 'recent'
      branches[branch].sort((left, right) => {
        const time = recent ? right.updatedAt - left.updatedAt : left.createdAt - right.createdAt
        const id = Buffer.compare(Buffer.from(left.id ?? '', 'utf8'), Buffer.from(right.id ?? '', 'utf8'))
        return time || (recent ? -id : id)
      })
    }
    return { ...scope, ready: true, branches }
  }

  /** Bounded status-aware point projection for management library/detail reads. */
  dashboardManagedMemory(id: string, maxContentBytes = 65_536, maxSourceBytes = 65_536): DashboardManagedMemoryView | undefined {
    this.ensureOpen()
    if (Buffer.byteLength(id, 'utf8') > 256 || !Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0 || maxContentBytes > 65_536 ||
        !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 0 || maxSourceBytes > 65_536) {
      throw new TypeError('managed memory projection bound is invalid')
    }
    const row = this.db.prepare(`SELECT
        CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id, length(CAST(id AS BLOB)) AS id_bytes,
        CASE WHEN length(CAST(content AS BLOB)) > 0 AND length(CAST(content AS BLOB)) <= ? THEN content END AS content, length(CAST(content AS BLOB)) AS content_bytes,
        CASE WHEN length(CAST(kind AS BLOB)) <= 256 THEN kind END AS kind, length(CAST(kind AS BLOB)) AS kind_bytes,
        CASE WHEN scene IS NULL OR length(CAST(scene AS BLOB)) <= 512 THEN scene END AS scene,
        COALESCE(length(CAST(scene AS BLOB)), 0) AS scene_bytes, confidence,
        CASE WHEN status IN ('candidate','approved','forgotten') THEN status END AS status,
        CASE WHEN length(CAST(source AS BLOB)) <= 512 THEN source END AS source, length(CAST(source AS BLOB)) AS source_bytes,
        CASE WHEN length(CAST(source_message_ids AS BLOB)) <= ? THEN source_message_ids END AS source_message_ids,
        length(CAST(source_message_ids AS BLOB)) AS source_ids_bytes, created_at, updated_at, approved_at, forgotten_at,
        revision, valid_from, valid_from_upper,
        CASE WHEN valid_from_state IN ('known','unknown') THEN valid_from_state END AS valid_from_state,
        CASE WHEN valid_from_state IN ('known','unknown') THEN 0 ELSE 1 END AS valid_from_state_invalid,
        CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN valid_from_precision END AS valid_from_precision,
        length(CAST(valid_from_precision AS BLOB)) AS valid_from_precision_bytes,
        CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN 0 ELSE 1 END AS valid_from_precision_invalid,
        CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN valid_from_basis END AS valid_from_basis,
        length(CAST(valid_from_basis AS BLOB)) AS valid_from_basis_bytes,
        CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN 0 ELSE 1 END AS valid_from_basis_invalid,
        CASE WHEN valid_from_label IS NULL OR length(CAST(valid_from_label AS BLOB)) <= 512 THEN valid_from_label END AS valid_from_label,
        COALESCE(length(CAST(valid_from_label AS BLOB)), 0) AS valid_from_label_bytes,
        valid_to, recorded_at, superseded_at, source_verified, expiry_at
      FROM l1_memories WHERE project_key = ? AND id = ?`).get(maxContentBytes, maxSourceBytes, projectKeyOfFile(this.file), id) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      ...(typeof row.id === 'string' ? { id: row.id } : {}), idBytes: Number(row.id_bytes),
      ...(typeof row.content === 'string' ? { content: row.content } : {}), contentBytes: Number(row.content_bytes),
      ...(typeof row.kind === 'string' ? { kind: row.kind } : {}), kindBytes: Number(row.kind_bytes),
      ...(row.scene === null ? { scene: null } : typeof row.scene === 'string' ? { scene: row.scene } : {}),
      sceneBytes: Number(row.scene_bytes), confidence: Number(row.confidence),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(typeof row.source === 'string' ? { source: row.source } : {}), sourceBytes: Number(row.source_bytes),
      ...(typeof row.source_message_ids === 'string' ? { sourceMessageIds: row.source_message_ids } : {}),
      sourceMessageIdsBytes: Number(row.source_ids_bytes), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(row.approved_at === null ? { approvedAt: null } : { approvedAt: Number(row.approved_at) }),
      ...(row.forgotten_at === null ? { forgottenAt: null } : { forgottenAt: Number(row.forgotten_at) }),
      revision: Number(row.revision), ...(row.valid_from === null ? { validFrom: null } : { validFrom: Number(row.valid_from) }),
      ...(typeof row.valid_from_state === 'string' ? { validFromState: row.valid_from_state } : {}),
      validFromStateInvalid: Number(row.valid_from_state_invalid) !== 0,
      ...(typeof row.valid_from_precision === 'string' ? { validFromPrecision: row.valid_from_precision } : {}),
      validFromPrecisionBytes: Number(row.valid_from_precision_bytes), validFromPrecisionInvalid: Number(row.valid_from_precision_invalid) !== 0,
      ...(typeof row.valid_from_basis === 'string' ? { validFromBasis: row.valid_from_basis } : {}),
      validFromBasisBytes: Number(row.valid_from_basis_bytes), validFromBasisInvalid: Number(row.valid_from_basis_invalid) !== 0,
      ...(row.valid_from_upper === null ? { validFromUpper: null } : { validFromUpper: Number(row.valid_from_upper) }),
      ...(row.valid_from_label === null ? { validFromLabel: null } : typeof row.valid_from_label === 'string' ? { validFromLabel: row.valid_from_label } : {}),
      validFromLabelBytes: Number(row.valid_from_label_bytes),
      ...(row.valid_to === null ? { validTo: null } : { validTo: Number(row.valid_to) }), recordedAt: Number(row.recorded_at),
      ...(row.superseded_at === null ? { supersededAt: null } : { supersededAt: Number(row.superseded_at) }),
      sourceVerified: Number(row.source_verified), ...(row.expiry_at === null ? { expiryAt: null } : { expiryAt: Number(row.expiry_at) }),
    }
  }

  /** Integer-primary-key page; 15 returned projections plus one raw sentinel per call. */
  dashboardReadEventPage(afterId = 0, limit = 16, throughId?: number): { rows: DashboardReadEventPageRow[]; hasMore: boolean } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new TypeError('dashboard event cursor is invalid')
    if (throughId !== undefined && (!Number.isSafeInteger(throughId) || throughId < afterId)) {
      throw new TypeError('dashboard event upper bound is invalid')
    }
    const rawLimit = throughId === undefined ? bounded + 1 : Math.min(bounded + 1, throughId - afterId)
    const rows = this.db.prepare(`SELECT e.id,
        CASE WHEN length(CAST(e.project_key AS BLOB)) <= 256 THEN e.project_key END AS project_key,
        length(CAST(e.project_key AS BLOB)) AS project_key_bytes,
        CASE WHEN length(CAST(e.type AS BLOB)) <= 64 THEN e.type END AS type, length(CAST(e.type AS BLOB)) AS type_bytes,
        CASE WHEN e.event_id IS NULL OR length(CAST(e.event_id AS BLOB)) <= 2048 THEN e.event_id END AS event_id,
        COALESCE(length(CAST(e.event_id AS BLOB)), 0) AS event_id_bytes,
        CASE WHEN e.source_id IS NULL OR length(CAST(e.source_id AS BLOB)) <= 256 THEN e.source_id END AS source_id,
        COALESCE(length(CAST(e.source_id AS BLOB)), 0) AS source_id_bytes,
        CASE WHEN e.session_id IS NULL OR length(CAST(e.session_id AS BLOB)) <= 512 THEN e.session_id END AS session_id,
        COALESCE(length(CAST(e.session_id AS BLOB)), 0) AS session_id_bytes,
        CASE WHEN e.metadata IS NOT NULL AND length(CAST(e.metadata AS BLOB)) <= 16384 THEN e.metadata END AS metadata,
        COALESCE(length(CAST(e.metadata AS BLOB)), 0) AS metadata_bytes,
        CASE WHEN e.type = 'capture' AND l.role = 'user' AND length(CAST(l.fingerprint AS BLOB)) <= 512 THEN l.fingerprint END AS fingerprint,
        CASE WHEN e.type = 'capture' AND l.role = 'user' THEN COALESCE(length(CAST(l.fingerprint AS BLOB)), 0) ELSE 0 END AS fingerprint_bytes,
        CASE WHEN l.source_event_id IS NULL OR length(CAST(l.source_event_id AS BLOB)) <= 2000 THEN l.source_event_id END AS l0_source_event_id,
        COALESCE(length(CAST(l.source_event_id AS BLOB)), 0) AS l0_source_event_id_bytes,
        CASE WHEN l.id IS NULL THEN 0 ELSE 1 END AS l0_found,
        e.created_at, e.occurred_at, e.count, e.tokens, e.raw_tokens,
        CASE WHEN e.source IS NULL OR length(CAST(e.source AS BLOB)) <= 512 THEN e.source END AS source,
        COALESCE(length(CAST(e.source AS BLOB)), 0) AS source_bytes,
        CASE WHEN e.agent_id IS NULL OR length(CAST(e.agent_id AS BLOB)) <= 512 THEN e.agent_id END AS agent_id,
        COALESCE(length(CAST(e.agent_id AS BLOB)), 0) AS agent_id_bytes,
        CASE WHEN e.agent_preset IS NULL OR length(CAST(e.agent_preset AS BLOB)) <= 512 THEN e.agent_preset END AS agent_preset,
        COALESCE(length(CAST(e.agent_preset AS BLOB)), 0) AS agent_preset_bytes,
        CASE WHEN e.provider IS NULL OR length(CAST(e.provider AS BLOB)) <= 256 THEN e.provider END AS provider,
        COALESCE(length(CAST(e.provider AS BLOB)), 0) AS provider_bytes,
        CASE WHEN e.model IS NULL OR length(CAST(e.model AS BLOB)) <= 256 THEN e.model END AS model,
        COALESCE(length(CAST(e.model AS BLOB)), 0) AS model_bytes
      FROM memory_events e LEFT JOIN l0_messages l ON l.project_key = e.project_key AND l.id = e.source_id
      WHERE e.id > ? ${throughId === undefined ? '' : 'AND e.id <= ?'} ORDER BY e.id ASC LIMIT ?`)
      .all(...(throughId === undefined ? [afterId, rawLimit] : [afterId, throughId, rawLimit])) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => {
      const sourceIdBytes = Number(row.source_id_bytes)
      const sessionIdBytes = Number(row.session_id_bytes)
      const eventIdBytes = Number(row.event_id_bytes)
      const l0SourceEventIdBytes = Number(row.l0_source_event_id_bytes)
      const metadataBytes = Number(row.metadata_bytes)
      const fingerprintBytes = Number(row.fingerprint_bytes)
      const eventId = typeof row.event_id === 'string' ? row.event_id : undefined
      const sourceId = typeof row.source_id === 'string' ? row.source_id : undefined
      const linkedL0SourceEventId = typeof row.l0_source_event_id === 'string' && row.l0_source_event_id.length > 0
        ? row.l0_source_event_id : undefined
      const directSourceEventId = eventId !== undefined && eventId.startsWith('capture:') && eventId.length > 8
        ? eventId.slice(8) : undefined
      const linkedL0SourceEventIdBytes = Buffer.byteLength(linkedL0SourceEventId ?? '', 'utf8')
      const directSourceEventIdBytes = Buffer.byteLength(directSourceEventId ?? '', 'utf8')
      const sourceEventId = captureSourceEventIdFromRow({
        event_id: eventId, source_id: sourceId, l0_source_event_id: linkedL0SourceEventId,
      })
      const identityInvalid = (sourceIdBytes > 0 && sourceId === undefined) ||
        (sessionIdBytes > 0 && typeof row.session_id !== 'string') ||
        (eventIdBytes > 0 && eventId === undefined) || l0SourceEventIdBytes > 2000 ||
        (sourceEventId !== undefined && Buffer.byteLength(sourceEventId, 'utf8') > 2000) ||
        linkedL0SourceEventIdBytes > 2000 || directSourceEventIdBytes > 2000
      let memoryIds: string[] | undefined
      let memoryIdsInvalid = false
      if (row.type === 'inject_prepared') {
        if (typeof row.metadata !== 'string') memoryIdsInvalid = true
        else {
          try {
            const metadata = JSON.parse(row.metadata) as unknown
            const ids = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
              ? (metadata as Record<string, unknown>).memoryIds : undefined
            if (!Array.isArray(ids) || ids.length > 100 ||
                ids.some((id) => typeof id !== 'string' || Buffer.byteLength(id, 'utf8') < 1 || Buffer.byteLength(id, 'utf8') > 256)) {
              memoryIdsInvalid = true
            } else memoryIds = [...new Set(ids as string[])]
          } catch { memoryIdsInvalid = true }
        }
      }
      const eventRow: DashboardReadEventPageRow = { id: Number(row.id),
        ...(typeof row.project_key === 'string' ? { projectKey: row.project_key } : {}), projectKeyBytes: Number(row.project_key_bytes),
        ...(typeof row.type === 'string' ? { type: row.type } : {}), typeBytes: Number(row.type_bytes),
        ...(eventId === undefined ? {} : { eventId }), eventIdBytes,
        ...(sourceId === undefined ? {} : { sourceId }), sourceIdBytes,
        l0Found: Number(row.l0_found) === 1,
        ...(sourceEventId === undefined ? {} : { sourceEventId }),
        sourceEventIdBytes: Buffer.byteLength(sourceEventId ?? '', 'utf8'),
        ...(linkedL0SourceEventId === undefined ? {} : { linkedL0SourceEventId }),
        linkedL0SourceEventIdBytes,
        ...(directSourceEventId === undefined ? {} : { directSourceEventId }),
        directSourceEventIdBytes,
        ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}), sessionIdBytes,
        ...(typeof row.fingerprint === 'string' ? { fingerprint: row.fingerprint } : {}), fingerprintBytes,
        ...(memoryIds === undefined ? {} : { memoryIds }), memoryIdsInvalid,
        ...(row.type === 'capture' ? { originalMessageIdentity: typeof row.metadata === 'string'
          ? captureIdentityFromMetadata(row.metadata) : null } : {}),
        metadataBytes, metadataInvalid: metadataBytes > 16_384 || metadataBytes > 0 && typeof row.metadata !== 'string',
        fingerprintInvalid: fingerprintBytes > 512 || fingerprintBytes > 0 && typeof row.fingerprint !== 'string',
        identityInvalid,
        createdAt: Number(row.created_at), ...(row.occurred_at === null ? { occurredAt: null } : { occurredAt: Number(row.occurred_at) }),
        count: Number(row.count), tokens: Number(row.tokens), rawTokens: Number(row.raw_tokens),
        ...(typeof row.source === 'string' ? { source: row.source } : {}), sourceBytes: Number(row.source_bytes),
        ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}), agentIdBytes: Number(row.agent_id_bytes),
        ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}), agentPresetBytes: Number(row.agent_preset_bytes),
        ...(typeof row.provider === 'string' ? { provider: row.provider } : {}), providerBytes: Number(row.provider_bytes),
        ...(typeof row.model === 'string' ? { model: row.model } : {}), modelBytes: Number(row.model_bytes),
      }
      return eventRow
    }), hasMore: rows.length > bounded }
  }

  /** Point projection only; all text fields are byte-probed and capped before they enter JS. */
  dashboardVisibilityMemoryMeta(id: string): DashboardVisibilityMemoryMeta | undefined {
    this.ensureOpen()
    if (Buffer.byteLength(id, 'utf8') > 256) throw new TypeError('visibility memory ID is too long')
    const row = this.db.prepare(`SELECT CASE WHEN status IN ('candidate', 'approved', 'forgotten') THEN status END AS status,
        CASE WHEN status IN ('candidate', 'approved', 'forgotten') THEN 0 ELSE 1 END AS status_invalid, confidence,
        CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision END AS current_revision,
        CASE WHEN length(CAST(source AS BLOB)) <= 512 THEN source END AS source,
        length(CAST(source AS BLOB)) AS source_bytes, created_at, updated_at, approved_at, forgotten_at, expiry_at
      FROM l1_memories WHERE project_key = ? AND id = ?`).get(projectKeyOfFile(this.file), id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      currentRevision: typeof row.current_revision === 'number' ? row.current_revision : undefined,
      status: typeof row.status === 'string' ? row.status : undefined,
      statusInvalid: Number(row.status_invalid) !== 0,
      confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
      ...(typeof row.source === 'string' ? { source: row.source } : {}),
      sourceBytes: Number(row.source_bytes),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      approvedAt: row.approved_at === null ? null : Number(row.approved_at),
      forgottenAt: row.forgotten_at === null ? null : Number(row.forgotten_at),
      expiryAt: row.expiry_at === null ? null : Number(row.expiry_at),
    }
  }

  /** Uncached main-schema fence for one reader-owned direct-origin scope. */
  dashboardVisibilitySchemaVersion(): number {
    this.ensureOpen()
    const row = this.db.prepare('PRAGMA main.schema_version').get() as Record<string, unknown> | undefined
    const value = row?.schema_version
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('project dashboard schema version is unavailable')
    }
    return value
  }

  /** Prove a bounded direct origin against one owned main-schema read snapshot. */
  dashboardVisibilityDirectCreationOrigin(memoryId: string): DashboardVisibilityDirectCreationOrigin | undefined {
    this.ensureOpen()
    if (Buffer.byteLength(memoryId, 'utf8') > 256) throw new TypeError('visibility memory ID is too long')
    const projectKey = projectKeyOfFile(this.file)
    const eventId = `initial-approval:${memoryId}`
    let ownedTransaction = false
    let operationFailed = false
    let operationError: unknown
    let result: DashboardVisibilityDirectCreationOrigin | undefined
    try {
      this.db.exec('BEGIN DEFERRED')
      ownedTransaction = true
      const snapshotRow = this.db.prepare('SELECT 1 AS snapshot_ready FROM main.sqlite_schema LIMIT 1').get()
      if (snapshotRow === undefined) throw new Error('project dashboard main-schema snapshot is unavailable')
      const schemaRow = this.db.prepare('PRAGMA main.schema_version').get() as Record<string, unknown> | undefined
      const schemaVersion = schemaRow?.schema_version
      if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        throw new Error('project dashboard main-schema version is unavailable')
      }
      const unavailable = (): DashboardVisibilityDirectCreationOrigin => ({
        schemaVersion,
        lookupCapabilitySupported: false,
        creationApproved: false,
        creationReasonIsText: false,
        approvalFound: false,
        approvalCountIsOne: false,
        approvalCreatedAtIsSafe: false,
        approvalOccurredAtIsSafe: false,
        approvalMetadataIsText: false,
        approvalMetadataBytes: 0,
      })
      const readUnderSnapshot = (): DashboardVisibilityDirectCreationOrigin => {
        type IndexListEntry = { name?: string; unique: boolean; partial: boolean }
        const readIndexList = (table: 'l1_revisions' | 'memory_events'): IndexListEntry[] | undefined => {
          const rows = this.db.prepare(`SELECT
              CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ${DASHBOARD_ORIGIN_INDEX_NAME_BYTES}
                THEN name END AS bounded_name,
              CASE WHEN "unique" = 1 THEN 1 ELSE 0 END AS is_unique,
              CASE WHEN partial = 1 THEN 1 ELSE 0 END AS is_partial
            FROM pragma_index_list(?, 'main') LIMIT ?`)
            .all(table, DASHBOARD_ORIGIN_INDEX_LIST_LIMIT) as Array<Record<string, unknown>>
          if (rows.length > DASHBOARD_ORIGIN_MAX_INDEXES) return undefined
          return rows.map((row) => ({
            ...(typeof row.bounded_name === 'string' ? { name: row.bounded_name } : {}),
            unique: Number(row.is_unique) === 1,
            partial: Number(row.is_partial) === 1,
          }))
        }
        const revisionIndexes = readIndexList('l1_revisions')
        const eventIndexes = readIndexList('memory_events')
        if (revisionIndexes === undefined || eventIndexes === undefined) return unavailable()
        const indexNameIsSafe = (name: string | undefined): name is string =>
          name !== undefined && Buffer.byteLength(name, 'utf8') <= DASHBOARD_ORIGIN_INDEX_NAME_BYTES &&
          /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
        const readIndexColumns = (name: string, maximum: number): Array<{ seq: number; cid: number; name?: string }> | undefined => {
          if (!indexNameIsSafe(name)) return undefined
          const rows = this.db.prepare(`SELECT seqno AS seq, cid,
              CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ${DASHBOARD_ORIGIN_INDEX_COLUMN_NAME_BYTES}
                THEN name END AS bounded_name
            FROM pragma_index_info(?, 'main') LIMIT ?`)
            .all(name, maximum + 1) as Array<Record<string, unknown>>
          if (rows.length > maximum) return undefined
          return rows.map((row) => ({
            seq: typeof row.seq === 'number' ? row.seq : -1,
            cid: typeof row.cid === 'number' ? row.cid : -1,
            ...(typeof row.bounded_name === 'string' ? { name: row.bounded_name } : {}),
          }))
        }
        const revisionIndex = revisionIndexes.find((entry) => entry.unique && !entry.partial &&
          indexNameIsSafe(entry.name) && (() => {
            const columns = readIndexColumns(entry.name!, 2)
            return columns?.length === 2 && columns[0]?.seq === 0 && columns[0]?.cid >= 0 &&
              columns[0]?.name === 'memory_id' && columns[1]?.seq === 1 && columns[1]?.cid >= 0 &&
              columns[1]?.name === 'revision'
          })())?.name
        const eventIndex = eventIndexes.find((entry) => entry.name === DASHBOARD_ORIGIN_EVENT_INDEX &&
          entry.unique && entry.partial)
        if (revisionIndex === undefined || eventIndex === undefined) return unavailable()
        const eventColumns = readIndexColumns(eventIndex.name!, 1)
        if (eventColumns?.length !== 1 || eventColumns[0]?.seq !== 0 || eventColumns[0]?.cid < 0 ||
            eventColumns[0]?.name !== 'event_id') return unavailable()

        const quotedRevisionIndex = `"${revisionIndex}"`
        const originSql = `SELECT
            CASE WHEN typeof(r.status) = 'text' THEN
              CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END ELSE 0 END AS creation_approved,
            CASE WHEN typeof(r.reason) = 'text' THEN 1 ELSE 0 END AS creation_reason_is_text,
            CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS approval_found,
            CASE WHEN typeof(e.count) = 'integer' THEN
              CASE WHEN e.count = 1 THEN 1 ELSE 0 END ELSE 0 END AS approval_count_is_one,
            CASE WHEN typeof(e.created_at) = 'integer' THEN
              CASE WHEN e.created_at BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END ELSE 0 END AS approval_created_at_is_safe,
            CASE WHEN typeof(e.occurred_at) = 'integer' THEN
              CASE WHEN e.occurred_at BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END ELSE 0 END AS approval_occurred_at_is_safe,
            CASE WHEN typeof(e.metadata) = 'text' THEN 1 ELSE 0 END AS approval_metadata_is_text,
            CASE WHEN typeof(e.metadata) = 'text' THEN
              CASE WHEN length(CAST(e.metadata AS BLOB)) <= ${DASHBOARD_ORIGIN_METADATA_BYTES}
                THEN e.metadata END END AS approval_metadata,
            CASE WHEN e.metadata IS NULL THEN 0
              WHEN typeof(e.metadata) = 'text' THEN
                CASE WHEN length(CAST(e.metadata AS BLOB)) <= ${DASHBOARD_ORIGIN_METADATA_BYTES}
                  THEN length(CAST(e.metadata AS BLOB)) ELSE ${DASHBOARD_ORIGIN_METADATA_BYTES + 1} END
              ELSE ${DASHBOARD_ORIGIN_METADATA_BYTES + 1} END AS approval_metadata_bytes
          FROM main.l1_revisions AS r INDEXED BY ${quotedRevisionIndex}
          LEFT JOIN main.memory_events AS e INDEXED BY ${DASHBOARD_ORIGIN_EVENT_INDEX}
            ON e.event_id = ? AND e.project_key = ? AND e.source_id = ? AND e.type = 'initial_approval'
          WHERE r.memory_id = ? AND r.revision = 1`
        const planRows = this.db.prepare(`EXPLAIN QUERY PLAN ${originSql}`)
          .all(eventId, projectKey, memoryId, memoryId) as Array<Record<string, unknown>>
        if (planRows.length > 2) return unavailable()
        const planDetails = planRows.map((row) => typeof row.detail === 'string' &&
          Buffer.byteLength(row.detail, 'utf8') <= 512 ? row.detail : '')
        const revisionSearch = planDetails.some((detail) =>
          detail.startsWith(`SEARCH r USING INDEX ${revisionIndex} `) && detail.includes('(memory_id=? AND revision=?)'))
        const eventSearch = planDetails.some((detail) =>
          detail.startsWith(`SEARCH e USING INDEX ${DASHBOARD_ORIGIN_EVENT_INDEX} `) &&
          detail.includes('(event_id=?)') && detail.endsWith('LEFT-JOIN'))
        if (!revisionSearch || !eventSearch) return unavailable()
        const row = this.db.prepare(originSql).get(eventId, projectKey, memoryId, memoryId) as Record<string, unknown> | undefined
        if (row === undefined) return { ...unavailable(), lookupCapabilitySupported: true }
        return {
          schemaVersion,
          lookupCapabilitySupported: true,
          creationApproved: Number(row.creation_approved) === 1,
          creationReasonIsText: Number(row.creation_reason_is_text) === 1,
          approvalFound: Number(row.approval_found) === 1,
          approvalCountIsOne: Number(row.approval_count_is_one) === 1,
          approvalCreatedAtIsSafe: Number(row.approval_created_at_is_safe) === 1,
          approvalOccurredAtIsSafe: Number(row.approval_occurred_at_is_safe) === 1,
          approvalMetadataIsText: Number(row.approval_metadata_is_text) === 1,
          ...(typeof row.approval_metadata === 'string' ? { approvalMetadata: row.approval_metadata } : {}),
          approvalMetadataBytes: Number(row.approval_metadata_bytes),
        }
      }
      result = readUnderSnapshot()
    } catch (error) {
      operationFailed = true
      operationError = error
    } finally {
      if (ownedTransaction) {
        try { this.db.exec('ROLLBACK') }
        catch (rollbackError) {
          const poison = { rollbackError, cleanupUnknown: true as boolean, closeError: undefined as unknown }
          this.dashboardOriginRollbackFailure = poison
          try {
            this.db.close()
            this.closed = true
            poison.cleanupUnknown = false
          } catch (closeError) {
            poison.closeError = closeError
          }
          const failure = Object.assign(new Error('owned dashboard origin rollback failed; store is poisoned'), {
            operationError: operationFailed ? operationError : undefined,
            rollbackError,
            closeError: poison.closeError,
            cleanupUnknown: poison.cleanupUnknown,
          })
          throw failure
        }
      }
    }
    if (operationFailed) throw operationError
    return result
  }

  /** One current-meta point plus an admitted 2..16 indexed revision rows; inline JSON is capped at at most 4 KiB per row. */
  dashboardVisibilityNodePage(memoryId: string, limit = 16, inlineSourceBytes = 4096): { projectKey: string; meta?: DashboardVisibilityMemoryMeta;
    rows: Array<DashboardVisibilityRevisionPageRow & { inlineSourceJson?: string }>; hasMore: boolean } {
    this.ensureOpen()
    if (typeof memoryId !== 'string' || Buffer.byteLength(memoryId, 'utf8') < 1 || Buffer.byteLength(memoryId, 'utf8') > 256) {
      throw new TypeError('visibility node ID is invalid')
    }
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > 16 ||
        !Number.isSafeInteger(inlineSourceBytes) || inlineSourceBytes < 0 || inlineSourceBytes > 4096) {
      throw new TypeError('visibility node projection bound is invalid')
    }
    const projectKey = projectKeyOfFile(this.file)
    const rows = this.db.prepare(`WITH ${dashboardOverviewIndexCapabilitySql()},
    key_columns AS MATERIALIZED (SELECT seqno, cid,
      CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 256 THEN name END AS name,
      "desc", CASE WHEN length(CAST(coll AS BLOB)) <= 16 THEN coll END AS coll, "key"
      FROM pragma_index_xinfo('sqlite_autoindex_l1_memories_1', 'main') LIMIT 3),
    capability AS MATERIALIZED (SELECT CASE WHEN
      (SELECT count(*) = 2 AND sum(CASE WHEN (seqno = 0 AND cid >= 0 AND name = 'id'
        AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1) OR (seqno = 1 AND cid = -1 AND "key" = 0)
        THEN 1 ELSE 0 END) = 2 FROM key_columns)
      AND (SELECT ready = 1 FROM overview_index_capability)
      THEN 1 ELSE 0 END AS ready), m AS (
      SELECT 1 AS meta_present, CASE WHEN status IN ('candidate','approved','forgotten') THEN status END AS meta_status,
        CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision END AS meta_current_revision,
        CASE WHEN status IN ('candidate','approved','forgotten') AND typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
          AND typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
          AND typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991
          AND (approved_at IS NULL OR (typeof(approved_at) = 'integer' AND approved_at BETWEEN 0 AND 9007199254740991))
          AND (forgotten_at IS NULL OR (typeof(forgotten_at) = 'integer' AND forgotten_at BETWEEN 0 AND 9007199254740991))
          AND (expiry_at IS NULL OR (typeof(expiry_at) = 'integer' AND expiry_at BETWEEN 0 AND 9007199254740991)) THEN 0 ELSE 1 END AS meta_invalid,
        CASE WHEN typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1 THEN confidence END AS meta_confidence,
        CASE WHEN typeof(source) = 'text' AND length(CAST(source AS BLOB)) <= 512 THEN source END AS meta_source,
        length(CAST(source AS BLOB)) AS meta_source_bytes,
        CASE WHEN typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991 THEN created_at END AS meta_created,
        CASE WHEN typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991 THEN updated_at END AS meta_updated,
        CASE WHEN typeof(approved_at) = 'integer' AND approved_at BETWEEN 0 AND 9007199254740991 THEN approved_at END AS meta_approved,
        CASE WHEN typeof(forgotten_at) = 'integer' AND forgotten_at BETWEEN 0 AND 9007199254740991 THEN forgotten_at END AS meta_forgotten,
        CASE WHEN typeof(expiry_at) = 'integer' AND expiry_at BETWEEN 0 AND 9007199254740991 THEN expiry_at END AS meta_expiry
      FROM main.l1_memories INDEXED BY sqlite_autoindex_l1_memories_1
      WHERE project_key = ? AND id = ? LIMIT (SELECT ready FROM capability)
    ), r AS (SELECT
          CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991 THEN revision END AS revision,
          CASE WHEN typeof(recorded_at) = 'integer' AND recorded_at BETWEEN 0 AND 9007199254740991 THEN recorded_at END AS recorded_at,
          CASE WHEN typeof(valid_from) = 'integer' AND valid_from BETWEEN 0 AND 9007199254740991 THEN valid_from END AS valid_from,
          CASE WHEN typeof(valid_from_upper) = 'integer' AND valid_from_upper BETWEEN 0 AND 9007199254740991 THEN valid_from_upper END AS valid_from_upper,
          CASE WHEN valid_from_state IN ('known', 'unknown') THEN valid_from_state END AS valid_from_state,
          CASE WHEN valid_from_state IN ('known', 'unknown') THEN 0 ELSE 1 END AS valid_from_state_invalid,
          CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN valid_from_precision END AS valid_from_precision,
          CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN 0 ELSE 1 END AS precision_invalid,
          length(CAST(valid_from_precision AS BLOB)) AS precision_bytes,
          CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN valid_from_basis END AS valid_from_basis,
          CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN 0 ELSE 1 END AS basis_invalid,
          length(CAST(valid_from_basis AS BLOB)) AS basis_bytes,
          CASE WHEN valid_from_label IS NULL OR length(CAST(valid_from_label AS BLOB)) <= 512 THEN valid_from_label END AS valid_from_label,
          COALESCE(length(CAST(valid_from_label AS BLOB)), 0) AS label_bytes,
          CASE WHEN typeof(valid_to) = 'integer' AND valid_to BETWEEN 0 AND 9007199254740991 THEN valid_to END AS valid_to,
          CASE WHEN typeof(superseded_at) = 'integer' AND superseded_at BETWEEN 0 AND 9007199254740991 THEN superseded_at END AS superseded_at,
          CASE WHEN typeof(source_verified) = 'integer' AND source_verified IN (0, 1) THEN source_verified END AS source_verified,
          length(CAST(content AS BLOB)) AS content_bytes,
          length(CAST(source_message_ids AS BLOB)) AS source_ids_bytes,
          CASE WHEN length(CAST(kind AS BLOB)) <= 256 THEN kind END AS kind,
          length(CAST(kind AS BLOB)) AS kind_bytes,
          CASE WHEN scene IS NULL OR length(CAST(scene AS BLOB)) <= 512 THEN scene END AS scene,
          COALESCE(length(CAST(scene AS BLOB)), 0) AS scene_bytes,
          1 AS revision_present, CASE WHEN revision IS NULL OR recorded_at IS NULL OR source_verified IS NULL
            OR (revision IS NOT NULL AND (typeof(revision) != 'integer' OR revision < 0 OR revision > 9007199254740991))
            OR (recorded_at IS NOT NULL AND (typeof(recorded_at) != 'integer' OR recorded_at < 0 OR recorded_at > 9007199254740991))
            OR (valid_from IS NOT NULL AND (typeof(valid_from) != 'integer' OR valid_from < 0 OR valid_from > 9007199254740991))
            OR (valid_from_upper IS NOT NULL AND (typeof(valid_from_upper) != 'integer' OR valid_from_upper < 0 OR valid_from_upper > 9007199254740991))
            OR (valid_to IS NOT NULL AND (typeof(valid_to) != 'integer' OR valid_to < 0 OR valid_to > 9007199254740991))
            OR (superseded_at IS NOT NULL AND (typeof(superseded_at) != 'integer' OR superseded_at < 0 OR superseded_at > 9007199254740991))
            OR (source_verified IS NOT NULL AND (typeof(source_verified) != 'integer' OR source_verified < 0 OR source_verified > 9007199254740991))
          THEN 1 ELSE 0 END AS numeric_invalid,
          CASE WHEN typeof(source_message_ids) = 'text' AND length(CAST(source_message_ids AS BLOB)) <= ${inlineSourceBytes} THEN source_message_ids END AS inline_sources
        FROM main.l1_revisions INDEXED BY l1_revision_effective_lookup
        WHERE memory_id = ? AND status = 'approved'
        ORDER BY l1_revisions.recorded_at DESC, l1_revisions.revision DESC
        LIMIT (SELECT CASE WHEN ready = 1 THEN ${limit} ELSE 0 END FROM capability))
      SELECT capability.ready AS capability_ready, m.*, r.* FROM capability LEFT JOIN m ON 1 = 1 LEFT JOIN r ON 1 = 1`)
      .all(projectKey, memoryId, memoryId) as Array<Record<string, unknown>>
    const first = rows[0]
    if (first?.capability_ready !== 1) throw new Error('visibility node indexed capability is unavailable')
    if (first.meta_present !== 1) return { projectKey, rows: [], hasMore: false }
    const meta: DashboardVisibilityMemoryMeta = { status: typeof first.meta_status === 'string' ? first.meta_status : undefined,
      currentRevision: typeof first.meta_current_revision === 'number' ? first.meta_current_revision : undefined,
      statusInvalid: first.meta_invalid !== 0, confidence: typeof first.meta_confidence === 'number' ? first.meta_confidence : undefined,
      ...(typeof first.meta_source === 'string' ? { source: first.meta_source } : {}), sourceBytes: Number(first.meta_source_bytes),
      createdAt: Number(first.meta_created), updatedAt: Number(first.meta_updated),
      approvedAt: first.meta_approved === null ? null : Number(first.meta_approved),
      forgottenAt: first.meta_forgotten === null ? null : Number(first.meta_forgotten),
      expiryAt: first.meta_expiry === null ? null : Number(first.meta_expiry) }
    // Restore keyset order after the bounded outer join; at most the admitted limit of rows exists.
    const revisionRows = rows.filter((row) => row.revision_present === 1).sort((left, right) =>
      Number(right.recorded_at) - Number(left.recorded_at) || Number(right.revision) - Number(left.revision))
    return { projectKey, meta, rows: revisionRows.map((row) => ({ revision: row.numeric_invalid === 1 ? Number.NaN : Number(row.revision), recordedAt: Number(row.recorded_at),
        ...(row.valid_from === null ? { validFrom: null } : { validFrom: Number(row.valid_from) }),
        ...(typeof row.valid_from_state === 'string' ? { validFromState: row.valid_from_state } : {}),
        validFromStateInvalid: Number(row.valid_from_state_invalid) !== 0,
        ...(row.valid_from_upper === null ? { validFromUpper: null } : { validFromUpper: Number(row.valid_from_upper) }),
        ...(typeof row.valid_from_precision === 'string' ? { validFromPrecision: row.valid_from_precision } : {}),
        validFromPrecisionBytes: Number(row.precision_bytes),
        validFromPrecisionInvalid: Number(row.precision_invalid) !== 0,
        ...(typeof row.valid_from_basis === 'string' ? { validFromBasis: row.valid_from_basis } : {}),
        validFromBasisBytes: Number(row.basis_bytes),
        validFromBasisInvalid: Number(row.basis_invalid) !== 0,
        ...(row.valid_from_label === null ? { validFromLabel: null } :
          (typeof row.valid_from_label === 'string' ? { validFromLabel: row.valid_from_label } : {})),
        validFromLabelBytes: Number(row.label_bytes),
        ...(row.valid_to === null ? { validTo: null } : { validTo: Number(row.valid_to) }),
        ...(row.superseded_at === null ? { supersededAt: null } : { supersededAt: Number(row.superseded_at) }),
        ...(typeof row.source_verified === 'number' ? { sourceVerified: row.source_verified } : {}),
        contentBytes: Number(row.content_bytes), sourceIdsBytes: Number(row.source_ids_bytes),
        ...(typeof row.kind === 'string' ? { kind: row.kind } : {}), kindBytes: Number(row.kind_bytes),
        ...(row.scene === null ? { scene: null } : (typeof row.scene === 'string' ? { scene: row.scene } : {})),
        sceneBytes: Number(row.scene_bytes),
        ...(typeof row.inline_sources === 'string' ? { inlineSourceJson: row.inline_sources } : {}),
      })), hasMore: revisionRows.length === limit }
  }

  dashboardVisibilityRevisionPage(memoryId: string, after?: DashboardVisibilityRevisionCursor, limit = 16): {
    rows: DashboardVisibilityRevisionPageRow[]; hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(16, limit)) : 16
    if (Buffer.byteLength(memoryId, 'utf8') > 256 || (after !== undefined &&
        (!Number.isSafeInteger(after.recordedAt) || !Number.isSafeInteger(after.revision) || after.revision < 1))) {
      throw new TypeError('visibility revision cursor is invalid')
    }
    const rows = (after === undefined
      ? this.db.prepare(`SELECT revision, recorded_at, valid_from, valid_from_upper,
          CASE WHEN valid_from_state IN ('known', 'unknown') THEN valid_from_state END AS valid_from_state,
          CASE WHEN valid_from_state IN ('known', 'unknown') THEN 0 ELSE 1 END AS valid_from_state_invalid,
          CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN valid_from_precision END AS valid_from_precision,
          CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN 0 ELSE 1 END AS precision_invalid,
          length(CAST(valid_from_precision AS BLOB)) AS precision_bytes,
          CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN valid_from_basis END AS valid_from_basis,
          CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN 0 ELSE 1 END AS basis_invalid,
          length(CAST(valid_from_basis AS BLOB)) AS basis_bytes,
          CASE WHEN valid_from_label IS NULL OR length(CAST(valid_from_label AS BLOB)) <= 512 THEN valid_from_label END AS valid_from_label,
          COALESCE(length(CAST(valid_from_label AS BLOB)), 0) AS label_bytes,
          valid_to, superseded_at, source_verified,
          length(CAST(content AS BLOB)) AS content_bytes,
          length(CAST(source_message_ids AS BLOB)) AS source_ids_bytes,
          CASE WHEN length(CAST(kind AS BLOB)) <= 256 THEN kind END AS kind,
          length(CAST(kind AS BLOB)) AS kind_bytes,
          CASE WHEN scene IS NULL OR length(CAST(scene AS BLOB)) <= 512 THEN scene END AS scene,
          COALESCE(length(CAST(scene AS BLOB)), 0) AS scene_bytes
        FROM l1_revisions WHERE memory_id = ? AND status = 'approved'
        ORDER BY l1_revisions.recorded_at DESC, l1_revisions.revision DESC LIMIT ?`).all(memoryId, bounded)
      : this.db.prepare(`SELECT revision, recorded_at, valid_from, valid_from_upper,
          CASE WHEN valid_from_state IN ('known', 'unknown') THEN valid_from_state END AS valid_from_state,
          CASE WHEN valid_from_state IN ('known', 'unknown') THEN 0 ELSE 1 END AS valid_from_state_invalid,
          CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN valid_from_precision END AS valid_from_precision,
          CASE WHEN valid_from_precision IN ('instant','second','minute','day','month','year','unknown') THEN 0 ELSE 1 END AS precision_invalid,
          length(CAST(valid_from_precision AS BLOB)) AS precision_bytes,
          CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN valid_from_basis END AS valid_from_basis,
          CASE WHEN valid_from_basis IN ('default_record_time','explicit','explicit_unknown') THEN 0 ELSE 1 END AS basis_invalid,
          length(CAST(valid_from_basis AS BLOB)) AS basis_bytes,
          CASE WHEN valid_from_label IS NULL OR length(CAST(valid_from_label AS BLOB)) <= 512 THEN valid_from_label END AS valid_from_label,
          COALESCE(length(CAST(valid_from_label AS BLOB)), 0) AS label_bytes,
          valid_to, superseded_at, source_verified,
          length(CAST(content AS BLOB)) AS content_bytes,
          length(CAST(source_message_ids AS BLOB)) AS source_ids_bytes,
          CASE WHEN length(CAST(kind AS BLOB)) <= 256 THEN kind END AS kind,
          length(CAST(kind AS BLOB)) AS kind_bytes,
          CASE WHEN scene IS NULL OR length(CAST(scene AS BLOB)) <= 512 THEN scene END AS scene,
          COALESCE(length(CAST(scene AS BLOB)), 0) AS scene_bytes
        FROM l1_revisions WHERE memory_id = ? AND status = 'approved'
          AND (l1_revisions.recorded_at, l1_revisions.revision) < (?, ?)
        ORDER BY l1_revisions.recorded_at DESC, l1_revisions.revision DESC LIMIT ?`).all(memoryId,
          after.recordedAt, after.revision, bounded)) as Array<Record<string, unknown>>
    return {
      rows: rows.map((row) => ({ revision: Number(row.revision), recordedAt: Number(row.recorded_at),
        ...(row.valid_from === null ? { validFrom: null } : { validFrom: Number(row.valid_from) }),
        ...(typeof row.valid_from_state === 'string' ? { validFromState: row.valid_from_state } : {}),
        validFromStateInvalid: Number(row.valid_from_state_invalid) !== 0,
        ...(row.valid_from_upper === null ? { validFromUpper: null } : { validFromUpper: Number(row.valid_from_upper) }),
        ...(typeof row.valid_from_precision === 'string' ? { validFromPrecision: row.valid_from_precision } : {}),
        validFromPrecisionBytes: Number(row.precision_bytes),
        validFromPrecisionInvalid: Number(row.precision_invalid) !== 0,
        ...(typeof row.valid_from_basis === 'string' ? { validFromBasis: row.valid_from_basis } : {}),
        validFromBasisBytes: Number(row.basis_bytes),
        validFromBasisInvalid: Number(row.basis_invalid) !== 0,
        ...(row.valid_from_label === null ? { validFromLabel: null } :
          (typeof row.valid_from_label === 'string' ? { validFromLabel: row.valid_from_label } : {})),
        validFromLabelBytes: Number(row.label_bytes),
        ...(row.valid_to === null ? { validTo: null } : { validTo: Number(row.valid_to) }),
        ...(row.superseded_at === null ? { supersededAt: null } : { supersededAt: Number(row.superseded_at) }),
        ...(typeof row.source_verified === 'number' ? { sourceVerified: row.source_verified } : {}),
        contentBytes: Number(row.content_bytes), sourceIdsBytes: Number(row.source_ids_bytes),
        ...(typeof row.kind === 'string' ? { kind: row.kind } : {}), kindBytes: Number(row.kind_bytes),
        ...(row.scene === null ? { scene: null } : (typeof row.scene === 'string' ? { scene: row.scene } : {})),
        sceneBytes: Number(row.scene_bytes),
      })),
      hasMore: rows.length === bounded,
    }
  }

  dashboardVisibilityRevisionSources(memoryId: string, revision: number): { json?: string; bytes: number } | undefined {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(source_message_ids AS BLOB)) <= 65536
          THEN source_message_ids END AS source_message_ids,
        length(CAST(source_message_ids AS BLOB)) AS source_ids_bytes
      FROM l1_revisions WHERE memory_id = ? AND revision = ? AND status = 'approved'`).get(memoryId, revision) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      ...(typeof row.source_message_ids === 'string' ? { json: row.source_message_ids } : {}),
      bytes: Number(row.source_ids_bytes),
    }
  }

  dashboardVisibilityRevisionBody(memoryId: string, revision: number): { content?: string; bytes: number } | undefined {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(content AS BLOB)) <= 65536 THEN content END AS content,
        length(CAST(content AS BLOB)) AS content_bytes
      FROM l1_revisions WHERE memory_id = ? AND revision = ? AND status = 'approved'`).get(memoryId, revision) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      ...(typeof row.content === 'string' ? { content: row.content } : {}),
      bytes: Number(row.content_bytes),
    }
  }

  /** Raw relation seek on the existing UNIQUE(from_id,to_id,relation_type) index. */
  dashboardVisibilityRelationPage(fromId: string, after?: DashboardVisibilityRelationCursor, limit = 16): {
    rows: DashboardVisibilityRelationPageRow[]; hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(16, limit)) : 16
    if (Buffer.byteLength(fromId, 'utf8') > 256 || (after !== undefined &&
        (Buffer.byteLength(after.toId, 'utf8') > 256 || Buffer.byteLength(after.type, 'utf8') > 32))) {
      throw new TypeError('visibility relation cursor is invalid')
    }
    const rows = (after === undefined
      ? this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
          length(CAST(id AS BLOB)) AS id_bytes,
          CASE WHEN length(CAST(to_id AS BLOB)) <= 256 THEN to_id END AS to_id,
          length(CAST(to_id AS BLOB)) AS to_id_bytes,
          CASE WHEN length(CAST(relation_type AS BLOB)) <= 32 THEN relation_type END AS relation_type,
          length(CAST(relation_type AS BLOB)) AS relation_type_bytes,
          from_revision, to_revision, length(CAST(evidence_ids AS BLOB)) AS evidence_bytes
        FROM memory_relations WHERE from_id = ? ORDER BY memory_relations.to_id ASC, memory_relations.relation_type ASC LIMIT ?`).all(fromId, bounded)
      : this.db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
          length(CAST(id AS BLOB)) AS id_bytes,
          CASE WHEN length(CAST(to_id AS BLOB)) <= 256 THEN to_id END AS to_id,
          length(CAST(to_id AS BLOB)) AS to_id_bytes,
          CASE WHEN length(CAST(relation_type AS BLOB)) <= 32 THEN relation_type END AS relation_type,
          length(CAST(relation_type AS BLOB)) AS relation_type_bytes,
          from_revision, to_revision, length(CAST(evidence_ids AS BLOB)) AS evidence_bytes
        FROM memory_relations WHERE from_id = ?
          AND (memory_relations.to_id, memory_relations.relation_type) > (?, ?)
        ORDER BY memory_relations.to_id ASC, memory_relations.relation_type ASC LIMIT ?`).all(fromId, after.toId, after.type, bounded)) as Array<Record<string, unknown>>
    return {
      rows: rows.map((row) => ({ ...(typeof row.id === 'string' ? { id: row.id } : {}), idBytes: Number(row.id_bytes),
        ...(typeof row.to_id === 'string' ? { toId: row.to_id } : {}), toIdBytes: Number(row.to_id_bytes),
        ...(typeof row.relation_type === 'string' ? { type: row.relation_type } : {}),
        typeBytes: Number(row.relation_type_bytes), fromRevision: Number(row.from_revision),
        toRevision: Number(row.to_revision), evidenceBytes: Number(row.evidence_bytes) })),
      hasMore: rows.length === bounded,
    }
  }

  dashboardVisibilityRelationEvidence(relationId: string): { json?: string; bytes: number } | undefined {
    this.ensureOpen()
    if (Buffer.byteLength(relationId, 'utf8') > 256) throw new TypeError('visibility relation ID is too long')
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(evidence_ids AS BLOB)) <= 65536
          THEN evidence_ids END AS evidence_ids,
        length(CAST(evidence_ids AS BLOB)) AS evidence_bytes
      FROM memory_relations WHERE id = ?`).get(relationId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      ...(typeof row.evidence_ids === 'string' ? { json: row.evidence_ids } : {}),
      bytes: Number(row.evidence_bytes),
    }
  }

  /** Direct L0 point lookup returns identity metadata only; it never projects message content. */
  dashboardVisibilitySourceIdentities(sourceIds: readonly string[], maxFieldBytes = 4096): Array<{ id: string; identity: DashboardVisibilitySourceIdentity }> {
    this.ensureOpen()
    if (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 15 || sourceIds.some((id) =>
      typeof id !== 'string' || Buffer.byteLength(id, 'utf8') < 1 || Buffer.byteLength(id, 'utf8') > 256)) {
      throw new TypeError('visibility source batch is invalid')
    }
    if (!Number.isSafeInteger(maxFieldBytes) || maxFieldBytes < 0 || maxFieldBytes > 4096) {
      throw new TypeError('visibility source projection bound is invalid')
    }
    const ids = [...new Set(sourceIds)]
    const columns = ['source_event_id', 'origin', 'source_kind', 'session_id', 'agent_preset'] as const
    const fields = columns.flatMap((column) => [
      `CASE WHEN ${column} IS NULL THEN 0 WHEN typeof(${column}) = 'text' THEN length(CAST(${column} AS BLOB)) ELSE -1 END AS ${column}_bytes`,
      `CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${maxFieldBytes} THEN ${column} END AS ${column}`,
    ])
    const guard = `WITH key_columns AS MATERIALIZED (SELECT seqno, cid,
      CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 256 THEN name END AS name,
      "desc", CASE WHEN length(CAST(coll AS BLOB)) <= 16 THEN coll END AS coll, "key"
      FROM pragma_index_xinfo('sqlite_autoindex_l0_messages_1', 'main') LIMIT 3),
      capability AS MATERIALIZED (SELECT CASE WHEN count(*) = 2 AND sum(CASE WHEN (seqno = 0 AND cid >= 0 AND name = 'id'
        AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1) OR (seqno = 1 AND cid = -1 AND "key" = 0)
        THEN 1 ELSE 0 END) = 2
        THEN 1 ELSE 0 END AS ready FROM key_columns) `
    const rows = this.db.prepare(guard + `SELECT * FROM (SELECT id, 1 AS capability_ready, ${fields.join(', ')}
      FROM main.l0_messages INDEXED BY sqlite_autoindex_l0_messages_1
      WHERE project_key = ? AND id IN (${ids.map(() => '?').join(', ')})
      LIMIT (SELECT CASE WHEN ready = 1 THEN 15 ELSE 0 END FROM capability))
      UNION ALL SELECT NULL, ready, ${fields.map(() => 'NULL').join(', ')} FROM capability LIMIT 16`)
      .all(projectKeyOfFile(this.file), ...ids) as Array<Record<string, unknown>>
    if (rows.at(-1)?.id !== null || rows.at(-1)?.capability_ready !== 1) throw new Error('visibility source primary-key capability is unavailable')
    rows.pop()
    const byId = new Map(rows.map((row) => [row.id, row]))
    return ids.map((id) => {
      const row = byId.get(id)
      if (row === undefined) return { id, identity: { found: false, sourceEventIdBytes: 0, originBytes: 0,
        sourceKindBytes: 0, sessionIdBytes: 0, agentPresetBytes: 0, projectionBytes: 0 } }
      const sizes = columns.map((column) => Number(row[`${column}_bytes`]))
      return { id, identity: { found: true,
        ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}), sourceEventIdBytes: sizes[0]!,
        ...(typeof row.origin === 'string' ? { origin: row.origin } : {}), originBytes: sizes[1]!,
        ...(typeof row.source_kind === 'string' ? { sourceKind: row.source_kind } : {}), sourceKindBytes: sizes[2]!,
        ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}), sessionIdBytes: sizes[3]!,
        ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}), agentPresetBytes: sizes[4]!,
        projectionBytes: sizes.reduce((sum, size) => sum + size, 0) } }
    })
  }

  /** Direct L0 point lookup returns identity metadata only; it never projects message content. */
  automaticPersonaMatches(content: string, ids: string[], revisions: Record<string, number>): boolean {
    this.ensureOpen()
    return this.db.prepare(`SELECT 1 AS same FROM l3_persona WHERE project_key = ? AND content = ? AND source_ids = ? AND source_revisions = ?`)
      .get(projectKeyOfFile(this.file), content, JSON.stringify(ids), JSON.stringify(revisions)) !== undefined
  }

  /** A small point preflight before deterministic L3 reads any source body. */
  automaticPersonaEligible(id: string): boolean {
    this.ensureOpen()
    return this.db.prepare(`SELECT 1 AS eligible FROM l1_memories WHERE id = ? AND status = 'approved'
      AND kind IN ('preference', 'fact') AND typeof(content) = 'text' AND length(CAST(content AS BLOB)) <= 768
      AND typeof(source_message_ids) = 'text' AND length(CAST(source_message_ids AS BLOB)) <= 4096
      AND CASE WHEN json_valid(source_message_ids) THEN json_array_length(source_message_ids) BETWEEN 1 AND 8 ELSE 0 END`)
      .get(id) !== undefined
  }

  /** Profile browser: one integer-key row, bounded SQL projection before materialization. */
  globalSourceRow(after: number): { ordinal: number; id?: string; content?: string; sessionId?: string; createdAt?: number } | undefined {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT rowid AS ordinal,
      CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
      CASE WHEN length(CAST(content AS BLOB)) <= 32768 THEN content END AS content,
      CASE WHEN length(CAST(session_id AS BLOB)) <= 512 THEN session_id END AS session_id, CASE WHEN typeof(created_at) IN ('integer', 'real') AND created_at >= 0 AND created_at <= 8640000000000000 AND created_at = CAST(created_at AS INTEGER) THEN CAST(created_at AS INTEGER) END AS created_at
      FROM l0_messages WHERE project_key = ? AND rowid > ? ORDER BY rowid LIMIT 1`).get(projectKeyOfFile(this.file), after) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { ordinal: Number(row.ordinal), createdAt: globalSafeInteger(row.created_at, 8640000000000000),
      ...(typeof row.id === 'string' ? { id: row.id } : {}),
      ...(typeof row.content === 'string' ? { content: row.content } : {}),
      ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}) }
  }

  /** All historical revisions, not recall/injection events or just the latest row timestamp. */
  /** One approved relation on an existing endpoint/rowid index; no body or unbounded JSON leaves SQLite. */
  globalRelationRow(memoryId: string, direction: 'from' | 'to', after: number): {
    ordinal: number; id?: string; fromId?: string; toId?: string; type?: string;
    fromRevision?: number; toRevision?: number; createdAt?: number; evidenceIds?: string[]
  } | undefined {
    this.ensureOpen()
    if (typeof memoryId !== 'string' || Buffer.byteLength(memoryId) > 256 || !Number.isSafeInteger(after) || after < 0 ||
        direction !== 'from' && direction !== 'to') throw new TypeError('global relation cursor is invalid')
    const column = direction === 'from' ? 'from_id' : 'to_id'
    const index = direction === 'from' ? 'memory_relations_from' : 'memory_relations_to'
    const row = this.db.prepare(`SELECT rowid AS ordinal,
      CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 256 THEN id END AS id,
      CASE WHEN typeof(from_id) = 'text' AND length(CAST(from_id AS BLOB)) BETWEEN 1 AND 256 THEN from_id END AS from_id,
      CASE WHEN typeof(to_id) = 'text' AND length(CAST(to_id AS BLOB)) BETWEEN 1 AND 256 THEN to_id END AS to_id,
      CASE WHEN relation_type IN ('supports','contradicts','depends_on','supersedes','derived_from') THEN relation_type END AS relation_type,
      CASE WHEN typeof(from_revision) IN ('integer','real') AND from_revision BETWEEN 1 AND 9007199254740991
        AND from_revision = CAST(from_revision AS INTEGER) THEN CAST(from_revision AS INTEGER) END AS from_revision,
      CASE WHEN typeof(to_revision) IN ('integer','real') AND to_revision BETWEEN 1 AND 9007199254740991
        AND to_revision = CAST(to_revision AS INTEGER) THEN CAST(to_revision AS INTEGER) END AS to_revision,
      CASE WHEN typeof(created_at) IN ('integer','real') AND created_at BETWEEN 0 AND 8640000000000000
        AND created_at = CAST(created_at AS INTEGER) THEN CAST(created_at AS INTEGER) END AS created_at,
      CASE WHEN typeof(evidence_ids) = 'text' AND length(CAST(evidence_ids AS BLOB)) <= 16384 THEN
        CASE WHEN json_valid(evidence_ids) THEN
          CASE WHEN json_type(evidence_ids) = 'array' AND json_array_length(evidence_ids) BETWEEN 1 AND 8 THEN
            CASE WHEN NOT EXISTS (SELECT 1 FROM json_each(evidence_ids) WHERE type <> 'text'
              OR length(CAST(value AS BLOB)) NOT BETWEEN 1 AND 256) THEN evidence_ids END
          END
        END
      END AS evidence
      FROM memory_relations INDEXED BY ${index} WHERE ${column} = ? AND rowid > ? ORDER BY rowid LIMIT 1`)
      .get(memoryId, after) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const ordinal = globalSafeInteger(row.ordinal)
    if (ordinal === undefined || ordinal <= after) throw new Error('global relation ordinal is invalid')
    const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) as unknown : undefined
    return { ordinal, ...(typeof row.id === 'string' ? { id: row.id } : {}),
      ...(typeof row.from_id === 'string' ? { fromId: row.from_id } : {}),
      ...(typeof row.to_id === 'string' ? { toId: row.to_id } : {}),
      ...(typeof row.relation_type === 'string' ? { type: row.relation_type } : {}),
      fromRevision: globalSafeInteger(row.from_revision), toRevision: globalSafeInteger(row.to_revision),
      createdAt: globalSafeInteger(row.created_at, 8640000000000000),
      ...(Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 8 && evidence.every((id) =>
        typeof id === 'string' && id.length > 0 && !id.includes('\0') && Buffer.byteLength(id) <= 256)
        ? { evidenceIds: evidence as string[] } : {}) }
  }

  globalRevisionRow(after: number): { ordinal: number; id?: string; revision?: number; at?: number; reason?: string } | undefined {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT rowid AS ordinal,
      CASE WHEN length(CAST(memory_id AS BLOB)) <= 256 THEN memory_id END AS id,
      CASE WHEN typeof(revision) IN ('integer', 'real') AND revision >= 1 AND revision <= 9007199254740991 AND revision = CAST(revision AS INTEGER) THEN CAST(revision AS INTEGER) END AS revision, CASE WHEN typeof(recorded_at) IN ('integer', 'real') AND recorded_at >= 0 AND recorded_at <= 8640000000000000 AND recorded_at = CAST(recorded_at AS INTEGER) THEN CAST(recorded_at AS INTEGER) END AS recorded_at, CASE WHEN length(CAST(reason AS BLOB)) <= 512 THEN reason END AS reason
      FROM l1_revisions WHERE rowid > ? ORDER BY rowid LIMIT 1`).get(after) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { ordinal: Number(row.ordinal), revision: globalSafeInteger(row.revision), at: globalSafeInteger(row.recorded_at, 8640000000000000),
      ...(typeof row.id === 'string' ? { id: row.id } : {}), ...(typeof row.reason === 'string' ? { reason: row.reason } : {}) }
  }

  globalDerivedSources(layer: 'L2' | 'L3', id: string): { updatedAt: number; ids: string[]; revisions: Record<string, number> } | undefined {
    this.ensureOpen()
    const table = layer === 'L2' ? 'l2_scenes' : 'l3_persona'
    const row = this.db.prepare(`SELECT CASE WHEN typeof(updated_at) IN ('integer', 'real') AND updated_at >= 0 AND updated_at <= 8640000000000000 AND updated_at = CAST(updated_at AS INTEGER) THEN CAST(updated_at AS INTEGER) END AS updated_at,
      CASE WHEN length(CAST(source_ids AS BLOB)) <= 16384 THEN source_ids END AS ids,
      CASE WHEN length(CAST(source_revisions AS BLOB)) <= 16384 THEN source_revisions END AS revisions
      FROM ${table} WHERE project_key = ? ${layer === 'L2' ? 'AND name = ? AND source_snapshot_dirty = 0 AND summary_frontier_ready = 1' : ''} LIMIT 1`)
      .get(...(layer === 'L2' ? [projectKeyOfFile(this.file), id] : [projectKeyOfFile(this.file)])) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    if (globalSafeInteger(row.updated_at, 8640000000000000) === undefined || typeof row.ids !== 'string' || typeof row.revisions !== 'string') throw new Error('derived source proof exceeds budget')
    const ids: unknown = JSON.parse(row.ids), revisions: unknown = JSON.parse(row.revisions)
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 256) ||
        typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)) throw new Error('derived source proof unavailable')
    const mapped = revisions as Record<string, number>
    if (ids.some((item: string) => !Number.isSafeInteger(mapped[item]) || mapped[item]! < 1)) throw new Error('derived source revision unavailable')
    return { updatedAt: Number(row.updated_at), ids: [...new Set(ids as string[])], revisions: mapped }
  }

  globalSourceLabel(id: string): { sessionId?: string; createdAt?: number } {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(session_id AS BLOB)) <= 512 THEN session_id END AS session_id,
      CASE WHEN typeof(created_at) IN ('integer', 'real') AND created_at >= 0 AND created_at <= 8640000000000000 AND created_at = CAST(created_at AS INTEGER) THEN CAST(created_at AS INTEGER) END AS created_at FROM l0_messages WHERE project_key = ? AND id = ?`).get(projectKeyOfFile(this.file), id) as Record<string, unknown> | undefined
    return row === undefined ? {} : { ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}), createdAt: globalSafeInteger(row.created_at, 8640000000000000) }
  }

  dashboardVisibilitySourceIdentity(sourceId: string): DashboardVisibilitySourceIdentity {
    this.ensureOpen()
    if (Buffer.byteLength(sourceId, 'utf8') > 256) throw new TypeError('visibility source ID is too long')
    const row = this.db.prepare(`SELECT
        length(CAST(source_event_id AS BLOB)) AS event_bytes, length(CAST(origin AS BLOB)) AS origin_bytes,
        length(CAST(source_kind AS BLOB)) AS kind_bytes, length(CAST(session_id AS BLOB)) AS session_bytes,
        length(CAST(agent_preset AS BLOB)) AS agent_bytes,
        CASE WHEN length(CAST(source_event_id AS BLOB)) <= 4096 THEN source_event_id END AS source_event_id,
        CASE WHEN length(CAST(origin AS BLOB)) <= 4096 THEN origin END AS origin,
        CASE WHEN length(CAST(source_kind AS BLOB)) <= 4096 THEN source_kind END AS source_kind,
        CASE WHEN length(CAST(session_id AS BLOB)) <= 4096 THEN session_id END AS session_id,
        CASE WHEN length(CAST(agent_preset AS BLOB)) <= 4096 THEN agent_preset END AS agent_preset
      FROM l0_messages WHERE project_key = ? AND id = ?`).get(projectKeyOfFile(this.file), sourceId) as Record<string, unknown> | undefined
    if (row === undefined) return { found: false, sourceEventIdBytes: 0, originBytes: 0, sourceKindBytes: 0,
      sessionIdBytes: 0, agentPresetBytes: 0, projectionBytes: 0 }
    const sizes = [row.event_bytes, row.origin_bytes, row.kind_bytes, row.session_bytes, row.agent_bytes]
      .map((value) => value === null ? 0 : Number(value))
    return {
      found: true,
      ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
      sourceEventIdBytes: sizes[0]!,
      ...(typeof row.origin === 'string' ? { origin: row.origin } : {}), originBytes: sizes[1]!,
      ...(typeof row.source_kind === 'string' ? { sourceKind: row.source_kind } : {}), sourceKindBytes: sizes[2]!,
      ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}), sessionIdBytes: sizes[3]!,
      ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}), agentPresetBytes: sizes[4]!,
      projectionBytes: sizes.reduce((sum, size) => sum + size, 0),
    }
  }

  /** L0 retention fallback page seeks the integer primary key and only returns scalar lengths for unrelated events. */
  dashboardVisibilityLegacyEventPage(sourceId: string, afterId?: number, limit = 16): {
    rows: DashboardVisibilityLegacyEventPageRow[]; hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(16, limit)) : 16
    if (Buffer.byteLength(sourceId, 'utf8') > 256 || (afterId !== undefined && !Number.isSafeInteger(afterId))) {
      throw new TypeError('visibility legacy-event cursor is invalid')
    }
    const projectKey = projectKeyOfFile(this.file)
    const match = "project_key = ? AND source = 'dsh-session' AND source_id = ?"
    const fields = `id, created_at, CASE WHEN ${match} THEN 1 ELSE 0 END AS matches,
      CASE WHEN ${match} AND length(CAST(event_id AS BLOB)) <= 2008 THEN event_id END AS event_id,
      CASE WHEN ${match} THEN COALESCE(length(CAST(event_id AS BLOB)), 0) END AS event_id_bytes,
      CASE WHEN ${match} AND length(CAST(session_id AS BLOB)) <= 512 THEN session_id END AS session_id,
      CASE WHEN ${match} THEN COALESCE(length(CAST(session_id AS BLOB)), 0) END AS session_id_bytes,
      CASE WHEN ${match} AND length(CAST(agent_preset AS BLOB)) <= 256 THEN agent_preset END AS agent_preset,
      CASE WHEN ${match} THEN COALESCE(length(CAST(agent_preset AS BLOB)), 0) END AS agent_preset_bytes,
      CASE WHEN ${match} THEN COALESCE(length(CAST(metadata AS BLOB)), 0) END AS metadata_bytes`
    const matchArgs = [projectKey, sourceId, projectKey, sourceId, projectKey, sourceId, projectKey, sourceId,
      projectKey, sourceId, projectKey, sourceId, projectKey, sourceId, projectKey, sourceId]
    const rows = (afterId === undefined
      ? this.db.prepare(`SELECT ${fields} FROM memory_events ORDER BY id ASC LIMIT ?`).all(...matchArgs, bounded)
      : this.db.prepare(`SELECT ${fields} FROM memory_events WHERE id > ? ORDER BY id ASC LIMIT ?`).all(...matchArgs, afterId, bounded)) as Array<Record<string, unknown>>
    return {
      rows: rows.map((row) => ({ id: Number(row.id), createdAt: Number(row.created_at), matches: Number(row.matches) === 1,
        ...(typeof row.event_id === 'string' ? { eventId: row.event_id } : {}),
        ...(row.event_id_bytes === null || row.event_id_bytes === undefined ? {} : { eventIdBytes: Number(row.event_id_bytes) }),
        ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
        ...(row.session_id_bytes === null || row.session_id_bytes === undefined ? {} : { sessionIdBytes: Number(row.session_id_bytes) }),
        ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}),
        ...(row.agent_preset_bytes === null || row.agent_preset_bytes === undefined ? {} : { agentPresetBytes: Number(row.agent_preset_bytes) }),
        ...(row.metadata_bytes === null || row.metadata_bytes === undefined ? {} : { metadataBytes: Number(row.metadata_bytes) }),
      })),
      hasMore: rows.length === bounded,
    }
  }

  dashboardVisibilityLegacyEventMetadata(eventRowId: number): { json?: string; bytes: number } | undefined {
    this.ensureOpen()
    if (!Number.isSafeInteger(eventRowId)) throw new TypeError('visibility event row ID is invalid')
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(metadata AS BLOB)) <= 16384 THEN metadata END AS metadata,
        COALESCE(length(CAST(metadata AS BLOB)), 0) AS metadata_bytes FROM memory_events WHERE id = ?`).get(eventRowId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      ...(typeof row.metadata === 'string' ? { json: row.metadata } : {}),
      bytes: Number(row.metadata_bytes),
    }
  }

  /** Model-facing exact-id read; get() remains the administrative audit path. */
  getApprovedForRead(id: string, excludedAgentPatterns: string[] = [], now = Date.now()): MemoryRecord | undefined {
    this.ensureOpen()
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const row = this.db.prepare(
      `SELECT m.* FROM l1_memories m WHERE m.id = ? AND m.project_key = ? AND m.status = 'approved'
       AND (m.expiry_at IS NULL OR m.expiry_at > ?)
       AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id
         WHERE ms.memory_id = m.id AND ${hidden.sql})`,
    ).get(id, projectKeyOfFile(this.file), now, ...hidden.params) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.currentEffectiveVersion(row, now)
  }

  private currentEffectiveVersion(row: Record<string, unknown>, now: number): MemoryRecord | undefined {
    const revision = this.db.prepare(
      `SELECT * FROM l1_revisions WHERE memory_id = ? AND status = 'approved'
       AND (valid_from_state = 'unknown' OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?) AND recorded_at <= ?
       ORDER BY recorded_at DESC, revision DESC LIMIT 1`,
    ).get(String(row.id), now, now, now) as Record<string, unknown> | undefined
    if (revision === undefined) return undefined
    return toRecord({ ...row, content: revision.content, kind: revision.kind, scene: revision.scene,
      revision: revision.revision, valid_from: revision.valid_from, valid_from_state: revision.valid_from_state,
      valid_from_precision: revision.valid_from_precision, valid_from_upper: revision.valid_from_upper,
      valid_from_basis: revision.valid_from_basis, valid_from_label: revision.valid_from_label, valid_to: revision.valid_to,
      recorded_at: revision.recorded_at, superseded_at: revision.superseded_at,
      source_message_ids: revision.source_message_ids, source_verified: revision.source_verified })
  }

  /** Historical valid-time reads ignore valid_to but still honor current status, retention and Agent policy. */
  getApprovedForHistory(id: string, excludedAgentPatterns: string[] = [], now = Date.now()): MemoryRecord | undefined {
    this.ensureOpen()
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const row = this.db.prepare(
      `SELECT m.* FROM l1_memories m WHERE m.id = ? AND m.project_key = ? AND m.status = 'approved'
       AND (m.expiry_at IS NULL OR m.expiry_at > ?)
       AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id
         WHERE ms.memory_id = m.id AND ${hidden.sql})`,
    ).get(id, projectKeyOfFile(this.file), now, ...hidden.params) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  list(status: MemoryStatus, limit = 50): MemoryRecord[] {
    this.ensureOpen()
    const rows = this.db
      .prepare('SELECT * FROM l1_memories WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
      .all(status, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[]
    return rows.map(toRecord)
  }

  statusCounts(): Record<MemoryStatus, number> {
    this.ensureOpen()
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM l1_memories WHERE project_key = ? GROUP BY status')
      .all(projectKeyOfFile(this.file)) as Array<{ status?: string; n?: number }>
    const counts: Record<MemoryStatus, number> = { candidate: 0, approved: 0, forgotten: 0 }
    for (const row of rows) {
      if (row.status === 'candidate' || row.status === 'approved' || row.status === 'forgotten') counts[row.status] = Number(row.n ?? 0)
    }
    return counts
  }

  visibleStatusCount(status: MemoryStatus, excludedAgentPatterns: string[] = [], hiddenMemoryIds: ReadonlySet<string> = new Set(), now = Date.now()): number {
    this.ensureOpen()
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const effective = status === 'approved'
      ? `AND (m.expiry_at IS NULL OR m.expiry_at > ?) AND EXISTS (
           SELECT 1 FROM l1_revisions r WHERE r.memory_id = m.id AND r.status = 'approved'
             AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?) AND (r.valid_to IS NULL OR r.valid_to > ?) AND r.recorded_at <= ?)`
      : status === 'candidate'
      ? "AND (m.valid_from_state = 'unknown' OR m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_to IS NULL OR m.valid_to > ?) AND (m.expiry_at IS NULL OR m.expiry_at > ?)"
      : ''
    const params: unknown[] = [projectKeyOfFile(this.file), status]
    if (status === 'approved') params.push(now, now, now, now)
    else if (status === 'candidate') params.push(now, now, now)
    params.push(...hidden.params)
    const where = `WHERE m.project_key = ? AND m.status = ? ${effective}
      AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.project_key = m.project_key AND l.id = ms.source_id
        WHERE ms.memory_id = m.id AND ${hidden.sql})`
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM l1_memories m ${where}`).get(...params) as { n?: number }
    const hiddenIds = [...hiddenMemoryIds]
    let hiddenCount = 0
    for (let offset = 0; offset < hiddenIds.length; offset += 200) {
      const batch = hiddenIds.slice(offset, offset + 200)
      const hiddenRow = this.db.prepare(`SELECT COUNT(*) AS n FROM l1_memories m ${where} AND m.id IN (${batch.map(() => '?').join(',')})`)
        .get(...params, ...batch) as { n?: number }
      hiddenCount += Number(hiddenRow.n ?? 0)
    }
    return Math.max(0, Number(total.n ?? 0) - hiddenCount)
  }

  allRecords(limit = 5000): MemoryRecord[] {
    this.ensureOpen()
    const rows = this.db
      .prepare('SELECT * FROM l1_memories ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(20_000, limit))) as unknown as Record<string, unknown>[]
    return rows.map(toRecord)
  }

  memorySourceRowsPage(input: { status: 'candidate' | 'forgotten'; after?: { createdAt: number; id: string }; limit?: number }): {
    records: Array<{ id: string; sourceMessageIds: string[]; createdAt: number }>
    next?: { createdAt: number; id: string }
  } {
    this.ensureOpen()
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)))
    const params: unknown[] = [projectKeyOfFile(this.file), input.status]
    const cursor = input.after === undefined ? '' : ' AND (created_at > ? OR (created_at = ? AND id > ?))'
    if (input.after !== undefined) params.push(input.after.createdAt, input.after.createdAt, input.after.id)
    params.push(limit + 1)
    const rows = this.db.prepare(`SELECT id, source_message_ids, created_at FROM l1_memories
      WHERE project_key = ? AND status = ?${cursor} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>
    const records = rows.slice(0, limit).flatMap((row) => typeof row.id === 'string'
      ? [{ id: row.id, sourceMessageIds: parseIds(row.source_message_ids), createdAt: Number(row.created_at ?? 0) }]
      : [])
    const last = records.at(-1)
    return rows.length > limit && last !== undefined ? { records, next: { createdAt: last.createdAt, id: last.id } } : { records }
  }

  recordsPage(input: { after?: { createdAt: number; id: string }; limit?: number; status?: MemoryStatus; excludedAgentPatterns?: string[]; hiddenMemoryIds?: ReadonlySet<string>; currentOnly?: boolean } = {}): { records: MemoryRecord[]; next?: { createdAt: number; id: string } } {
    this.ensureOpen()
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)))
    const hidden = excludedMemorySql(input.excludedAgentPatterns ?? [])
    const filters = ['m.project_key = ?']
    const baseParams: unknown[] = [projectKeyOfFile(this.file)]
    if (input.status !== undefined) { filters.push('m.status = ?'); baseParams.push(input.status) }
    if (input.currentOnly === true && (input.status === undefined || input.status === 'approved' || input.status === 'candidate')) {
      const now = Date.now()
      filters.push('(m.expiry_at IS NULL OR m.expiry_at > ?)')
      baseParams.push(now)
      if (input.status === 'approved') {
        filters.push(`EXISTS (SELECT 1 FROM l1_revisions r WHERE r.memory_id = m.id AND r.status = 'approved'
          AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?) AND (r.valid_to IS NULL OR r.valid_to > ?) AND r.recorded_at <= ?)`)
        baseParams.push(now, now, now)
      } else if (input.status === 'candidate') {
        filters.push("(m.valid_from_state = 'unknown' OR m.valid_from IS NULL OR m.valid_from <= ?)", '(m.valid_to IS NULL OR m.valid_to > ?)')
        baseParams.push(now, now)
      }
    }
    filters.push(`NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id WHERE ms.memory_id = m.id AND ${hidden.sql})`)
    baseParams.push(...hidden.params)
    const hiddenIds = input.hiddenMemoryIds ?? new Set<string>()
    const records: MemoryRecord[] = []
    let scan = input.after
    let exhausted = false
    const batchSize = Math.max(limit + 1, 100)
    while (records.length <= limit && !exhausted) {
      const filtersWithCursor = [...filters]
      const params = [...baseParams]
      if (scan !== undefined) {
        filtersWithCursor.push('(m.created_at > ? OR (m.created_at = ? AND m.id > ?))')
        params.push(scan.createdAt, scan.createdAt, scan.id)
      }
      params.push(batchSize)
      const rows = this.db.prepare(`SELECT m.* FROM l1_memories m WHERE ${filtersWithCursor.join(' AND ')} ORDER BY m.created_at ASC, m.id ASC LIMIT ?`)
        .all(...params) as Array<Record<string, unknown>>
      if (rows.length === 0) { exhausted = true; break }
      for (const row of rows) {
        const record = input.status === 'approved' && input.currentOnly === true
          ? this.currentEffectiveVersion(row, Date.now())
          : toRecord(row)
        if (record === undefined) {
          scan = { createdAt: Number(row.created_at), id: String(row.id) }
          continue
        }
        if (!hiddenIds.has(record.id) || record.status === 'forgotten') records.push(record)
        scan = { createdAt: record.createdAt, id: record.id }
        if (records.length > limit) break
      }
      if (rows.length < batchSize) exhausted = true
    }
    const page = records.slice(0, limit)
    const last = page.at(-1)
    return records.length > limit && last !== undefined
      ? { records: page, next: { createdAt: last.createdAt, id: last.id } }
      : { records: page }
  }

  recordsAt(effectiveAt: number, knownAt: number, excludedAgentPatterns: string[] = [], limit = 100): MemoryRecord[] {
    this.ensureOpen()
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const rows = this.db.prepare(
      `SELECT r.* FROM l1_revisions r JOIN l1_memories m ON m.id = r.memory_id
       WHERE m.project_key = ? AND r.recorded_at <= ? AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?)
         AND (r.valid_to IS NULL OR r.valid_to > ?)
         AND r.status = 'approved' AND m.status <> 'forgotten'
         AND NOT EXISTS (SELECT 1 FROM l1_revisions newer WHERE newer.memory_id = r.memory_id AND newer.status = 'approved'
           AND newer.recorded_at <= ? AND (newer.valid_from_state = 'unknown' OR newer.valid_from <= ?) AND (newer.valid_to IS NULL OR newer.valid_to > ?)
           AND (newer.recorded_at > r.recorded_at OR (newer.recorded_at = r.recorded_at AND newer.revision > r.revision)))
         AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id
           WHERE ms.memory_id = m.id AND ${hidden.sql})
       ORDER BY r.recorded_at DESC, r.memory_id ASC LIMIT ?`,
    ).all(projectKeyOfFile(this.file), knownAt, effectiveAt, effectiveAt, knownAt, effectiveAt, effectiveAt,
      ...hidden.params, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      ...(this.get(String(row.memory_id)) ?? {} as MemoryRecord),
      id: String(row.memory_id), content: String(row.content), kind: String(row.kind),
      scene: row.scene === null || row.scene === undefined ? undefined : String(row.scene),
      status: 'approved', revision: Number(row.revision), recordedAt: Number(row.recorded_at),
      ...validFromFields(row, Number(row.recorded_at)),
      temporalUncertainAt: effectiveStartIsUncertainAt(effectiveStartFromStored({ state: row.valid_from_state,
        precision: row.valid_from_precision, basis: row.valid_from_basis, value: row.valid_from,
        upperExclusive: row.valid_from_upper, label: row.valid_from_label, recordedAt: Number(row.recorded_at) }), effectiveAt),
      validTo: row.valid_to === null || row.valid_to === undefined ? undefined : Number(row.valid_to),
      supersededAt: row.superseded_at === null || row.superseded_at === undefined ? undefined : Number(row.superseded_at),
      sourceMessageIds: parseIds(row.source_message_ids), sourceVerified: Number(row.source_verified ?? 0) === 1,
    }))
  }

  private sceneTimeBoundaryMemoryIds(since: number, now: number): string[] {
    const projectKey = projectKeyOfFile(this.file)
    const rows = this.db.prepare(`SELECT m.id FROM l1_memories m
        WHERE m.project_key = ? AND m.status = 'approved' AND m.expiry_at > ? AND m.expiry_at <= ?
      UNION
      SELECT m.id FROM l1_revisions r JOIN l1_memories m ON m.id = r.memory_id
        WHERE r.status = 'approved' AND r.recorded_at > ? AND r.recorded_at <= ? AND m.project_key = ? AND m.status = 'approved'
      UNION
      SELECT m.id FROM l1_revisions r JOIN l1_memories m ON m.id = r.memory_id
        WHERE r.status = 'approved' AND r.valid_from_state <> 'unknown' AND r.valid_from > ? AND r.valid_from <= ?
          AND m.project_key = ? AND m.status = 'approved'
      UNION
      SELECT m.id FROM l1_revisions r JOIN l1_memories m ON m.id = r.memory_id
        WHERE r.status = 'approved' AND r.valid_to > ? AND r.valid_to <= ? AND m.project_key = ? AND m.status = 'approved'`)
      .all(projectKey, since, now, since, now, projectKey, since, now, projectKey, since, now, projectKey) as Array<{ id?: string }>
    return rows.flatMap((row) => typeof row.id === 'string' ? [row.id] : [])
  }

  private summarizeSceneParts(contents: string[], memoryCount: number): { summary: string; summaryParts: string[]; summaryComplete: boolean } {
    const parts: string[] = []
    let used = 0
    for (const content of contents) {
      const separator = parts.length === 0 ? '' : ' / '
      const part = content.trim()
      if (part !== '' && used + separator.length + part.length <= 320) {
        parts.push(part)
        used += separator.length + part.length
      }
    }
    let omittedCount = memoryCount - parts.length
    let summary = parts.join(' / ')
    let omission = omittedCount === 0 ? '' : `（另有 ${omittedCount} 条完整记忆未展开）`
    while (parts.length > 0 && summary.length + (omission === '' ? 0 : (summary === '' ? 0 : 1) + omission.length) > 320) {
      parts.pop()
      omittedCount = memoryCount - parts.length
      summary = parts.join(' / ')
      omission = omittedCount === 0 ? '' : `（另有 ${omittedCount} 条完整记忆未展开）`
    }
    if (omission !== '') summary = summary === '' ? omission : `${summary} ${omission}`
    return { summary, summaryParts: parts, summaryComplete: parts.length === memoryCount }
  }

  private sceneSummaryFrontier(contents: string[]): number[][] {
    const frontier: number[][] = Array.from({ length: 321 }, () => [])
    const lengths = contents.map((content) => content.trim().length)
    const collect = (state: number, initialUsed: number, hasParts: boolean): void => {
      const selected: number[] = []
      let used = initialUsed
      let selectedAny = hasParts
      for (let ordinal = 0; ordinal < contents.length; ordinal += 1) {
        const length = lengths[ordinal]!
        if (length === 0) continue
        const separator = selectedAny ? 3 : 0
        if (used + separator + length <= 320) {
          selected.push(ordinal)
          used += separator + length
          selectedAny = true
        }
      }
      frontier[state] = selected
    }
    // State 0 is the ordinary empty scene. States 1..320 model an already
    // selected prefix whose text consumes that many UTF-16 code units.
    collect(0, 0, false)
    for (let used = 1; used <= 320; used += 1) collect(used, used, true)
    return frontier
  }

  private parseSceneSummaryFrontier(value: unknown, minimumOrdinal = Number.NEGATIVE_INFINITY): number[][] | undefined {
    if (typeof value !== 'string') return undefined
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { return undefined }
    if (!Array.isArray(parsed) || parsed.length !== 321) return undefined
    const frontier: number[][] = []
    for (const state of parsed) {
      if (!Array.isArray(state) || state.length > 80) return undefined
      const ordinals: number[] = []
      let previous = Number.NEGATIVE_INFINITY
      for (const ordinal of state) {
        if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= previous || ordinal < minimumOrdinal) return undefined
        ordinals.push(ordinal)
        previous = ordinal
      }
      frontier.push(ordinals)
    }
    return frontier
  }

  private prependSceneSummaryFrontier(frontier: number[][], newOrdinal: number, content: string): number[][] {
    const length = content.trim().length
    if (length === 0 || length > 320) return frontier
    const next: number[][] = Array.from({ length: 321 }, () => [])
    next[0] = [newOrdinal, ...frontier[length]!]
    for (let used = 1; used <= 320; used += 1) {
      const suffixState = used + 3 + length
      next[used] = suffixState <= 320
        ? [newOrdinal, ...frontier[suffixState]!]
        : frontier[used]!
    }
    return next
  }

  private sceneSnapshot(records: MemoryRecord[]): {
    summary: string
    summaryParts: string[]
    memoryCount: number
    sourceIds: string[]
    sourceRevisions: Record<string, number>
    summaryComplete: boolean
    summaryFrontier: number[][]
  } {
    const contents = records.map((record) => record.content)
    const summary = this.summarizeSceneParts(contents, records.length)
    return { ...summary, memoryCount: records.length, sourceIds: records.map((record) => record.id),
      sourceRevisions: Object.fromEntries(records.map((record) => [record.id, record.revision])),
      summaryFrontier: this.sceneSummaryFrontier(contents) }
  }

  private replaceSceneMembers(name: string, records: MemoryRecord[]): void {
    const projectKey = projectKeyOfFile(this.file)
    this.db.prepare('DELETE FROM l2_scene_members WHERE project_key = ? AND scene_name = ?').run(projectKey, name)
    const insert = this.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
      VALUES (?, ?, ?, ?, ?)`)
    records.forEach((record, ordinal) => insert.run(projectKey, name, record.id, record.revision, ordinal))
  }

  /** Increment the current scene membership for a newly approved candidate without rematerializing the whole scene. */
  advanceSceneIndexForApproval(id: string, now = Date.now()): boolean {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const lastRefresh = this.db.prepare('SELECT MIN(updated_at) AS updated_at FROM l2_scenes WHERE project_key = ?')
        .get(projectKeyOfFile(this.file)) as { updated_at?: number | null }
      const lastRefreshAt = lastRefresh?.updated_at === null || lastRefresh?.updated_at === undefined ? undefined : Number(lastRefresh.updated_at)
      if (lastRefreshAt === undefined || now <= lastRefreshAt) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (this.sceneTimeBoundaryMemoryIds(lastRefreshAt, now).some((memoryId) => memoryId !== id)) {
        this.db.exec('ROLLBACK')
        return false
      }
      const effective = this.getApprovedForRead(id, [], now)
      const approvalUpdatedAt = effective?.updatedAt ?? Number((this.db.prepare('SELECT updated_at FROM l1_memories WHERE project_key = ? AND id = ?')
        .get(projectKeyOfFile(this.file), id) as { updated_at?: number } | undefined)?.updated_at ?? 0)
      if (approvalUpdatedAt <= lastRefreshAt) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (effective !== undefined) {
        const name = effective.scene?.trim() || 'general'
        const projectKey = projectKeyOfFile(this.file)
        // approvedRecords() orders scene provenance by the memory row's updated_at.
        // Prepending is equivalent only when this approval sorts ahead of every other
        // approved row; otherwise use the normal rebuild to preserve that order.
        const laterApproved = this.db.prepare(`SELECT 1 FROM l1_memories
          WHERE project_key = ? AND status = 'approved' AND id <> ? AND updated_at >= ? LIMIT 1`)
          .get(projectKey, id, approvalUpdatedAt)
        if (laterApproved !== undefined) {
          this.db.exec('ROLLBACK')
          return false
        }
        // The trigger-maintained member count and ready bit are the integrity
        // fence: every membership mutation clears ready, and only a complete
        // rebuild or validated prepend can restore it. Avoid recounting every
        // member on each warm approval; the scene-order index supports MIN.
        const existing = this.db.prepare(`SELECT s.memory_count, s.summary_frontier, s.summary_frontier_ready,
          s.summary_member_count AS member_count,
          (SELECT MIN(member.ordinal) FROM l2_scene_members member
            WHERE member.project_key = s.project_key AND member.scene_name = s.name) AS first_ordinal
          FROM l2_scenes s WHERE s.project_key = ? AND s.name = ?`)
          .get(projectKey, name) as Record<string, unknown> | undefined
        const frontier = existing === undefined ? undefined
          : this.parseSceneSummaryFrontier(existing.summary_frontier, Number(existing.first_ordinal))
        const duplicateMember = this.db.prepare(`SELECT 1 FROM l2_scene_members
          WHERE project_key = ? AND scene_name = ? AND memory_id = ?`).get(projectKey, name, id)
        const orphanMembers = existing === undefined
          ? this.db.prepare('SELECT 1 FROM l2_scene_members WHERE project_key = ? AND scene_name = ? LIMIT 1').get(projectKey, name)
          : undefined
        if (duplicateMember !== undefined || orphanMembers !== undefined || (existing !== undefined &&
            (!Number.isSafeInteger(Number(existing.memory_count)) || Number(existing.memory_count) < 1 ||
             Number(existing.member_count) !== Number(existing.memory_count) ||
             existing.first_ordinal === null || existing.first_ordinal === undefined ||
             !Number.isSafeInteger(Number(existing.first_ordinal)) || Number(existing.summary_frontier_ready) !== 1 ||
             frontier === undefined))) {
          this.db.exec('ROLLBACK')
          return false
        }
        if (existing === undefined) {
          const snapshot = this.sceneSnapshot([effective])
          this.db.prepare(`INSERT INTO l2_scenes(project_key, name, summary, memory_count, updated_at, source_ids,
            source_revisions, summary_complete, summary_parts, summary_frontier, summary_frontier_ready, source_snapshot_dirty)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, 0)`)
            .run(projectKey, name, snapshot.summary, now, JSON.stringify(snapshot.sourceIds),
              JSON.stringify(snapshot.sourceRevisions), snapshot.summaryComplete ? 1 : 0,
              JSON.stringify(snapshot.summaryParts), JSON.stringify(snapshot.summaryFrontier))
          this.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
            VALUES (?, ?, ?, ?, 0)`)
            .run(projectKey, name, id, effective.revision)
          this.db.prepare('UPDATE l2_scenes SET summary_frontier_ready = 1 WHERE project_key = ? AND name = ?')
            .run(projectKey, name)
        } else {
          const nextCount = Number(existing.memory_count) + 1
          const newOrdinal = Number(existing.first_ordinal) - 1
          if (!Number.isSafeInteger(newOrdinal)) {
            this.db.exec('ROLLBACK')
            return false
          }
          const nextFrontier = this.prependSceneSummaryFrontier(frontier!, newOrdinal, effective.content)
          const selectedOrdinals = nextFrontier[0]!
          this.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
            VALUES (?, ?, ?, ?, ?)`)
            .run(projectKey, name, id, effective.revision, newOrdinal)
          const selectedRows = selectedOrdinals.length === 0 ? [] : this.db.prepare(`SELECT member.ordinal, revision.content
            FROM l2_scene_members member
            JOIN l1_revisions revision ON revision.memory_id = member.memory_id AND revision.revision = member.revision AND revision.status = 'approved'
            WHERE member.project_key = ? AND member.scene_name = ? AND member.ordinal IN (${selectedOrdinals.map(() => '?').join(',')})
            ORDER BY member.ordinal`)
            .all(projectKey, name, ...selectedOrdinals) as Array<{ ordinal?: unknown; content?: unknown }>
          if (selectedRows.length !== selectedOrdinals.length || selectedRows.some((row, index) =>
              Number(row.ordinal) !== selectedOrdinals[index] || typeof row.content !== 'string')) {
            this.db.exec('ROLLBACK')
            return false
          }
          const summary = this.summarizeSceneParts(selectedRows.map((row) => row.content as string), nextCount)
          this.db.prepare(`UPDATE l2_scenes SET memory_count = ?, updated_at = ?, summary = ?, summary_parts = ?,
            summary_complete = ?, summary_frontier = ?, summary_frontier_ready = 1, source_snapshot_dirty = 1
            WHERE project_key = ? AND name = ?`)
            .run(nextCount, now, summary.summary, JSON.stringify(summary.summaryParts), summary.summaryComplete ? 1 : 0,
              JSON.stringify(nextFrontier), projectKey, name)
        }
      }
      this.db.prepare('UPDATE l2_scenes SET updated_at = ? WHERE project_key = ?').run(now, projectKeyOfFile(this.file))
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Rebuild the deterministic L2 scene index from approved L1 memories. */
  refreshScenes(now = Date.now(), onlyScene?: string | string[], includeScenes = true): SceneRecord[] {
    this.ensureOpen()
    let sceneNames = onlyScene === undefined ? undefined : [...new Set(typeof onlyScene === 'string' ? [onlyScene] : onlyScene)]
    if (sceneNames !== undefined && sceneNames.length === 0) return includeScenes ? this.scenes() : []
    if (sceneNames !== undefined) {
      const lastRefresh = this.db.prepare('SELECT MIN(updated_at) AS updated_at FROM l2_scenes WHERE project_key = ?')
        .get(projectKeyOfFile(this.file)) as { updated_at?: number | null }
      const lastRefreshAt = lastRefresh?.updated_at === null || lastRefresh?.updated_at === undefined ? undefined : Number(lastRefresh.updated_at)
      if (lastRefreshAt === undefined || now < lastRefreshAt) sceneNames = undefined
      else {
        const boundaryIds = this.sceneTimeBoundaryMemoryIds(lastRefreshAt, now)
        if (boundaryIds.length > 0) {
          const affected = new Set(sceneNames)
          for (let offset = 0; offset < boundaryIds.length; offset += 100) {
            const batch = boundaryIds.slice(offset, offset + 100)
            const previousScenes = this.db.prepare(`SELECT DISTINCT scene_name FROM l2_scene_members
              WHERE project_key = ? AND memory_id IN (${batch.map(() => '?').join(',')})`)
              .all(projectKeyOfFile(this.file), ...batch) as Array<Record<string, unknown>>
            for (const row of previousScenes) if (typeof row.scene_name === 'string') affected.add(row.scene_name)
          }
          for (let offset = 0; offset < boundaryIds.length; offset += 100) {
            const current = this.approvedRecords([], now, now, undefined, boundaryIds.slice(offset, offset + 100))
            for (const record of current) affected.add(record.scene?.trim() || 'general')
          }
          sceneNames = [...affected]
        }
      }
    }
    const groups = new Map<string, MemoryRecord[]>()
    if (sceneNames === undefined) {
      for (const record of this.approvedRecords([], now, now)) {
        const name = record.scene?.trim() || 'general'
        const list = groups.get(name) ?? []
        list.push(record)
        groups.set(name, list)
      }
    } else {
      for (let offset = 0; offset < sceneNames.length; offset += 100) {
        for (const record of this.approvedRecords([], now, now, sceneNames.slice(offset, offset + 100))) {
          const name = record.scene?.trim() || 'general'
          const list = groups.get(name) ?? []
          list.push(record)
          groups.set(name, list)
        }
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (sceneNames === undefined) {
        this.db.prepare('DELETE FROM l2_scene_members WHERE project_key = ?').run(projectKeyOfFile(this.file))
        this.db.prepare('DELETE FROM l2_scenes WHERE project_key = ?').run(projectKeyOfFile(this.file))
      } else for (let offset = 0; offset < sceneNames.length; offset += 100) {
        const batch = sceneNames.slice(offset, offset + 100)
        const marks = batch.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM l2_scene_members WHERE project_key = ? AND scene_name IN (${marks})`)
          .run(projectKeyOfFile(this.file), ...batch)
        this.db.prepare(`DELETE FROM l2_scenes WHERE project_key = ? AND name IN (${marks})`)
          .run(projectKeyOfFile(this.file), ...batch)
      }
      for (const [name, records] of groups) {
        const snapshot = this.sceneSnapshot(records)
        this.db
          .prepare(`INSERT INTO l2_scenes(project_key, name, summary, memory_count, updated_at, source_ids, source_revisions,
            summary_complete, summary_parts, summary_frontier, summary_frontier_ready, source_snapshot_dirty)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`)
          .run(projectKeyOfFile(this.file), name, snapshot.summary, snapshot.memoryCount, now,
            JSON.stringify(snapshot.sourceIds), JSON.stringify(snapshot.sourceRevisions), snapshot.summaryComplete ? 1 : 0,
            JSON.stringify(snapshot.summaryParts), JSON.stringify(snapshot.summaryFrontier))
        this.replaceSceneMembers(name, records)
        this.db.prepare('UPDATE l2_scenes SET summary_frontier_ready = 1 WHERE project_key = ? AND name = ?')
          .run(projectKeyOfFile(this.file), name)
      }
      this.db.prepare('UPDATE l2_scenes SET updated_at = ? WHERE project_key = ?').run(now, projectKeyOfFile(this.file))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return includeScenes ? this.scenes() : []
  }

  /** Bounded read-only scene metadata; no repairs, no summary body. */
  dashboardSceneMetaPage(after: { memoryCount: number; name: string } | undefined, limit: number): {
    rows: Array<{ name?: string; nameBytes: number; memoryCount: number; updatedAt: number; summaryBytes: number; summaryComplete: boolean;
      sourceIdsBytes: number; sourceRevisionsBytes: number; dirty: boolean; frontierReady: boolean }>
    hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(40, limit)) : 40
    // The materialized name is a bounded projection, but ordering and the
    // continuation predicate both use the raw identity column. The previous
    // boundary key must therefore be the same bounded raw name returned here.
    const select = `SELECT CASE WHEN length(CAST(name AS BLOB)) <= 4096 THEN name END AS name,
      COALESCE(length(CAST(name AS BLOB)), 0) AS name_bytes, memory_count, updated_at,
      COALESCE(length(CAST(summary AS BLOB)), 0) AS summary_bytes, summary_complete,
      COALESCE(length(CAST(source_ids AS BLOB)), 0) AS source_ids_bytes,
      COALESCE(length(CAST(source_revisions AS BLOB)), 0) AS source_revisions_bytes,
      source_snapshot_dirty, summary_frontier_ready FROM l2_scenes WHERE project_key = ?`
    const rows = (after === undefined
      ? this.db.prepare(`${select} ORDER BY l2_scenes.memory_count DESC, l2_scenes.name ASC LIMIT ?`).all(projectKeyOfFile(this.file), bounded + 1)
      : this.db.prepare(`${select} AND (memory_count < ? OR (memory_count = ? AND name > ?))
          ORDER BY l2_scenes.memory_count DESC, l2_scenes.name ASC LIMIT ?`).all(projectKeyOfFile(this.file),
        after.memoryCount, after.memoryCount, after.name, bounded + 1)) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => this.sceneMetaProjection(row)), hasMore: rows.length > bounded }
  }

  private sceneMetaProjection(row: Record<string, unknown>): {
    name?: string; nameBytes: number; memoryCount: number; updatedAt: number; summaryBytes: number; summaryComplete: boolean;
    sourceIdsBytes: number; sourceRevisionsBytes: number; dirty: boolean; frontierReady: boolean
  } {
    return {
      ...(typeof row.name === 'string' ? { name: row.name } : {}), nameBytes: Number(row.name_bytes ?? 0),
      memoryCount: Number(row.memory_count ?? 0), updatedAt: Number(row.updated_at ?? 0),
      summaryBytes: Number(row.summary_bytes ?? 0), summaryComplete: Number(row.summary_complete ?? 0) === 1,
      sourceIdsBytes: Number(row.source_ids_bytes ?? 0), sourceRevisionsBytes: Number(row.source_revisions_bytes ?? 0),
      dirty: Number(row.source_snapshot_dirty ?? 0) === 1, frontierReady: Number(row.summary_frontier_ready ?? 0) === 1,
    }
  }

  /** Exact bounded scene metadata identity re-read for final proof. */
  dashboardSceneMeta(name: string): {
    name?: string; nameBytes: number; memoryCount: number; updatedAt: number; summaryBytes: number; summaryComplete: boolean;
    sourceIdsBytes: number; sourceRevisionsBytes: number; dirty: boolean; frontierReady: boolean
  } | undefined {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(name AS BLOB)) <= 4096 THEN name END AS name,
      COALESCE(length(CAST(name AS BLOB)), 0) AS name_bytes, memory_count, updated_at,
      COALESCE(length(CAST(summary AS BLOB)), 0) AS summary_bytes, summary_complete,
      COALESCE(length(CAST(source_ids AS BLOB)), 0) AS source_ids_bytes,
      COALESCE(length(CAST(source_revisions AS BLOB)), 0) AS source_revisions_bytes,
      source_snapshot_dirty, summary_frontier_ready FROM l2_scenes WHERE project_key = ? AND name = ?`)
      .get(projectKeyOfFile(this.file), name) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.sceneMetaProjection(row)
  }

  dashboardSceneSummary(name: string, maxBytes: number): { bytes: number; summary?: string } {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT COALESCE(length(CAST(summary AS BLOB)), 0) AS bytes,
      CASE WHEN length(CAST(summary AS BLOB)) <= ? THEN summary END AS summary
      FROM l2_scenes WHERE project_key = ? AND name = ?`).get(maxBytes, projectKeyOfFile(this.file), name) as
      | { bytes?: unknown; summary?: unknown } | undefined
    if (row === undefined) return { bytes: 0 }
    return { bytes: Number(row.bytes ?? 0), ...(typeof row.summary === 'string' ? { summary: row.summary } : {}) }
  }

  dashboardSceneMemberPage(name: string, afterOrdinal: number | undefined, limit: number): {
    rows: Array<{ memoryId?: string; memoryIdBytes: number; revision: number; ordinal: number }>
    hasMore: boolean
  } {
    this.ensureOpen()
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100
    // Keep one row per normalized ordinal even when the identity is invalid.
    // Dropping such a row here would turn corruption into a false EOF.
    const rows = (afterOrdinal === undefined
      ? this.db.prepare(`SELECT CASE WHEN length(CAST(memory_id AS BLOB)) <= 256 THEN memory_id END AS memory_id,
        COALESCE(length(CAST(memory_id AS BLOB)), 0) AS memory_id_bytes, revision, ordinal
        FROM l2_scene_members WHERE project_key = ? AND scene_name = ? ORDER BY ordinal ASC LIMIT ?`)
        .all(projectKeyOfFile(this.file), name, bounded + 1)
      : this.db.prepare(`SELECT CASE WHEN length(CAST(memory_id AS BLOB)) <= 256 THEN memory_id END AS memory_id,
        COALESCE(length(CAST(memory_id AS BLOB)), 0) AS memory_id_bytes, revision, ordinal
        FROM l2_scene_members WHERE project_key = ? AND scene_name = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT ?`)
        .all(projectKeyOfFile(this.file), name, afterOrdinal, bounded + 1)) as Array<Record<string, unknown>>
    return { rows: rows.slice(0, bounded).map((row) => ({
      ...(typeof row.memory_id === 'string' ? { memoryId: row.memory_id } : {}),
      memoryIdBytes: Number(row.memory_id_bytes ?? 0), revision: Number(row.revision ?? 0), ordinal: Number(row.ordinal ?? 0),
    })), hasMore: rows.length > bounded }
  }

  dashboardPersonaMeta(): { contentBytes: number; sourceCount: number; updatedAt: number; sourceIdsBytes: number; sourceRevisionsBytes: number } | undefined {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT COALESCE(length(CAST(content AS BLOB)), 0) AS content_bytes,
      source_count, updated_at, COALESCE(length(CAST(source_ids AS BLOB)), 0) AS source_ids_bytes,
      COALESCE(length(CAST(source_revisions AS BLOB)), 0) AS source_revisions_bytes
      FROM l3_persona WHERE project_key = ?`).get(projectKeyOfFile(this.file)) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return { contentBytes: Number(row.content_bytes ?? 0), sourceCount: Number(row.source_count ?? 0),
      updatedAt: Number(row.updated_at ?? 0), sourceIdsBytes: Number(row.source_ids_bytes ?? 0),
      sourceRevisionsBytes: Number(row.source_revisions_bytes ?? 0) }
  }

  dashboardPersonaBody(maxBytes: number): { bytes: number; content?: string } {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT COALESCE(length(CAST(content AS BLOB)), 0) AS bytes,
      CASE WHEN length(CAST(content AS BLOB)) <= ? THEN content END AS content
      FROM l3_persona WHERE project_key = ?`).get(maxBytes, projectKeyOfFile(this.file)) as
      | { bytes?: unknown; content?: unknown } | undefined
    if (row === undefined) return { bytes: 0 }
    return { bytes: Number(row.bytes ?? 0), ...(typeof row.content === 'string' ? { content: row.content } : {}) }
  }

  dashboardPersonaSources(maxBytes: number): { sourceIds?: string; sourceRevisions?: string; sourceIdsBytes: number; sourceRevisionsBytes: number } {
    this.ensureOpen()
    const row = this.db.prepare(`SELECT COALESCE(length(CAST(source_ids AS BLOB)), 0) AS ids_bytes,
      COALESCE(length(CAST(source_revisions AS BLOB)), 0) AS revisions_bytes,
      CASE WHEN length(CAST(source_ids AS BLOB)) <= ? THEN source_ids END AS source_ids,
      CASE WHEN length(CAST(source_revisions AS BLOB)) <= ? THEN source_revisions END AS source_revisions
      FROM l3_persona WHERE project_key = ?`).get(maxBytes, maxBytes, projectKeyOfFile(this.file)) as Record<string, unknown> | undefined
    if (row === undefined) return { sourceIdsBytes: 0, sourceRevisionsBytes: 0 }
    return { sourceIdsBytes: Number(row.ids_bytes ?? 0), sourceRevisionsBytes: Number(row.revisions_bytes ?? 0),
      ...(typeof row.source_ids === 'string' ? { sourceIds: row.source_ids } : {}),
      ...(typeof row.source_revisions === 'string' ? { sourceRevisions: row.source_revisions } : {}) }
  }

  scenes(): SceneRecord[] {
    this.ensureOpen()
    const rows = this.db
      .prepare(`SELECT name, summary, memory_count, updated_at, source_ids, source_revisions, summary_complete,
        summary_frontier_ready, source_snapshot_dirty
        FROM l2_scenes WHERE project_key = ? ORDER BY memory_count DESC, name ASC`)
      .all(projectKeyOfFile(this.file)) as unknown as Array<Record<string, unknown>>
    const uninitializedSummaryNames = rows.flatMap((row) => Number(row.summary_frontier_ready ?? 0) !== 1 && typeof row.name === 'string' ? [row.name] : [])
    if (uninitializedSummaryNames.length > 0) {
      // R19/R20 databases have no complete summary frontier. Rebuild each
      // such scene once, persist the frontier, then keep later approvals bounded.
      this.refreshScenes(Date.now(), uninitializedSummaryNames, false)
      return this.scenes()
    }
    // Dirty JSON is only a stale response snapshot; the normalized member rows
    // are the canonical source for complete IDs, revisions, and order.
    const dirtyNames = rows.flatMap((row) => Number(row.source_snapshot_dirty ?? 0) === 1 && typeof row.name === 'string' ? [row.name] : [])
    const dirtyMembers = new Map<string, Array<Record<string, unknown>>>(dirtyNames.map((name) => [name, []]))
    for (let offset = 0; offset < dirtyNames.length; offset += 100) {
      const batch = dirtyNames.slice(offset, offset + 100)
      const members = this.db.prepare(`SELECT scene_name, memory_id, revision FROM l2_scene_members
        WHERE project_key = ? AND scene_name IN (${batch.map(() => '?').join(',')}) ORDER BY scene_name, ordinal`)
        .all(projectKeyOfFile(this.file), ...batch) as Array<Record<string, unknown>>
      for (const member of members) {
        if (typeof member.scene_name === 'string') dirtyMembers.get(member.scene_name)?.push(member)
      }
    }
    let repairMembership = false
    const scenes = rows.map((row) => {
      const isDirty = Number(row.source_snapshot_dirty ?? 0) === 1
      const name = String(row.name)
      const members = isDirty ? dirtyMembers.get(name) ?? [] : undefined
      const sourceIds = members === undefined
        ? parseIds(row.source_ids)
        : members.flatMap((member) => typeof member.memory_id === 'string' ? [member.memory_id] : [])
      const sourceIdSet = new Set(sourceIds)
      const parsedRevisions: Record<string, unknown> = members === undefined
        ? parseJson<Record<string, unknown>>(row.source_revisions, {})
        : Object.fromEntries(members.flatMap((member) => {
          const revision = Number(member.revision)
          return typeof member.memory_id === 'string' && Number.isSafeInteger(revision) && revision > 0
            ? [[member.memory_id, revision] as [string, number]] : []
        }))
      const revisionEntries: Array<[string, number]> = []
      if (parsedRevisions !== null && typeof parsedRevisions === 'object' && !Array.isArray(parsedRevisions)) {
        for (const [id, revision] of Object.entries(parsedRevisions)) {
          if (sourceIdSet.has(id) && typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0) {
            revisionEntries.push([id, revision])
          }
        }
      }
      const memoryCount = Number(row.memory_count ?? 0)
      if (isDirty && (sourceIds.length !== memoryCount || revisionEntries.length !== sourceIds.length)) repairMembership = true
      const sourceRevisions = Object.fromEntries(revisionEntries)
      return {
        name,
        summary: String(row.summary ?? ''),
        memoryCount,
        updatedAt: Number(row.updated_at ?? 0),
        sourceIds,
        sourceRevisions,
        summaryComplete: Number(row.summary_complete ?? 0) === 1,
      }
    })
    if (repairMembership) {
      this.refreshScenes(Date.now(), undefined, false)
      return this.scenes()
    }
    return scenes
  }

  /** Find persisted L2 scenes containing a memory, independent of current read visibility. */
  sceneNamesContainingMemory(id: string): string[] {
    this.ensureOpen()
    const rows = this.db.prepare(`SELECT DISTINCT scene_name FROM l2_scene_members
      WHERE project_key = ? AND memory_id = ? ORDER BY scene_name`)
      .all(projectKeyOfFile(this.file), id) as Array<Record<string, unknown>>
    return rows.flatMap((row) => typeof row.scene_name === 'string' ? [row.scene_name] : [])
  }

  persona(): PersonaRecord | null {
    this.ensureOpen()
    const row = this.db.prepare('SELECT content, source_count, updated_at, source_ids, source_revisions FROM l3_persona WHERE project_key = ?').get(projectKeyOfFile(this.file)) as
      | Record<string, unknown>
      | undefined
    if (row === undefined) return null
    const sourceIds = parseIds(row.source_ids)
    const sourceRevisions = parseJson<Record<string, number>>(row.source_revisions, {})
    let stale = false
    if (sourceIds.length === 0 || sourceIds.some((id) => !Number.isSafeInteger(sourceRevisions[id]) || Number(sourceRevisions[id]) < 1)) {
      // A persona without provenance (upgraded from a build that predates the
      // source_ids/source_revisions columns, or generated from nothing) cannot
      // be checked against the exact approved source versions. Treat it as
      // stale until an operator regenerates it; reads never trigger a model call.
      stale = true
    } else {
      for (const id of sourceIds) {
        const record = this.get(id)
        if (record === undefined || record.status !== 'approved' || record.revision !== sourceRevisions[id]) {
          stale = true
          break
        }
      }
    }
    return {
      content: String(row.content ?? ''),
      sourceCount: Number(row.source_count ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      sourceIds,
      sourceRevisions,
      stale,
    }
  }

  setPersona(content: string, sourceCount: number, sourceIds: string[] = [], now = Date.now(), sourceRevisions: Record<string, number> = {}): PersonaRecord {
    this.ensureOpen()
    const normalized = content.replace(/\r\n/g, '\n').trim()
    if (normalized === '') throw new Error('persona content is empty')
    const uniqueSourceIds = [...new Set(sourceIds)]
    const validSourceRevisions = Object.fromEntries(uniqueSourceIds.flatMap((id) => {
      const revision = sourceRevisions[id]
      return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? [[id, revision] as const] : []
    }))
    const stale = uniqueSourceIds.length === 0 || Object.keys(validSourceRevisions).length !== uniqueSourceIds.length
    this.db
      .prepare(
        `INSERT INTO l3_persona(project_key, content, source_count, updated_at, source_ids, source_revisions) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_key) DO UPDATE SET content = excluded.content, source_count = excluded.source_count, updated_at = excluded.updated_at,
           source_ids = excluded.source_ids, source_revisions = excluded.source_revisions`,
      )
      .run(projectKeyOfFile(this.file), normalized, sourceCount, now, JSON.stringify(uniqueSourceIds), JSON.stringify(validSourceRevisions))
    return { content: normalized, sourceCount, updatedAt: now, sourceIds: uniqueSourceIds, sourceRevisions: validSourceRevisions, stale }
  }

  search(query: string, limit = 5, excludedAgentPatterns: string[] = []): SearchHit[] {
    this.ensureOpen()
    const allowed = Math.max(1, Math.min(200, limit))
    return rankTextCandidates(query, this.approvedRecords(excludedAgentPatterns), tokenize, allowed)
      .map(({ record, score }) => ({ ...record, score }))
  }

  searchExact(query: string, limit = 10, excludedAgentPatterns: string[] = []): SearchHit[] {
    this.ensureOpen()
    const needle = normalizeMemoryText(query).toLocaleLowerCase()
    if (needle.length < 3) return []
    return this.approvedRecords(excludedAgentPatterns)
      .filter((record) => normalizeMemoryText(record.content).toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, Math.min(50, Math.floor(limit))))
      .map((record) => ({ ...record, score: 1 }))
  }

  private searchLike(query: string, limit: number, excludedAgentPatterns: string[] = []): SearchHit[] {
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const visibility = `(valid_to IS NULL OR valid_to > ?) AND (expiry_at IS NULL OR expiry_at > ?) AND NOT EXISTS (
      SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id WHERE ms.memory_id = l1_memories.id AND ${hidden.sql})`
    const tokens = tokenize(query).filter((token) => token.length > 1).slice(0, 6)
    if (tokens.length === 0) {
      const needle = query.trim()
      if (needle === '') return []
      const rows = this.db
        .prepare(`SELECT * FROM l1_memories WHERE status = 'approved' AND ${visibility} AND content LIKE ? ORDER BY updated_at DESC LIMIT ?`)
        .all(Date.now(), Date.now(), ...hidden.params, `%${needle}%`, limit) as unknown as Record<string, unknown>[]
      return rows.map((row) => ({ ...toRecord(row), score: 0.1 }))
    }
    const clauses = tokens.map(() => 'content LIKE ?').join(' OR ')
    const rows = this.db
      .prepare(`SELECT * FROM l1_memories WHERE status = 'approved' AND ${visibility} AND (${clauses}) ORDER BY updated_at DESC LIMIT ?`)
      .all(Date.now(), Date.now(), ...hidden.params, ...tokens.map((token) => `%${token}%`), limit) as unknown as Record<string, unknown>[]
    return rows.map((row) => ({ ...toRecord(row), score: 0.1 }))
  }

  stats(excludedAgentPatterns: string[] = [], hiddenMemoryIds: ReadonlySet<string> = new Set(), hiddenFromForgotten: ReadonlySet<string> = new Set(), includeMemoryCounts = true): StoreStats {
    this.ensureOpen()
    const count = (status: MemoryStatus): number => includeMemoryCounts ? this.visibleStatusCount(status, excludedAgentPatterns,
      status === 'forgotten' ? hiddenFromForgotten : hiddenMemoryIds)
      : 0
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const visibleL0 = `NOT (${hidden.sql})`
    const l0 = this.db.prepare(`SELECT COUNT(*) AS n FROM l0_messages l WHERE l.project_key = ? AND ${visibleL0}`)
      .get(projectKeyOfFile(this.file), ...hidden.params) as { n?: number }
    const sessions = this.db.prepare(`SELECT COUNT(DISTINCT NULLIF(session_id, '')) AS n FROM l0_messages l WHERE l.project_key = ? AND ${visibleL0}`)
      .get(projectKeyOfFile(this.file), ...hidden.params) as { n?: number }
    const repeated = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT lower(trim(content)) AS c FROM l0_messages l WHERE l.project_key = ? AND role = 'user' AND ${visibleL0}
           GROUP BY c HAVING COUNT(*) > 1
         )`,
      )
      .get(projectKeyOfFile(this.file), ...hidden.params) as { n?: number }
    const version = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
    return {
      l0Messages: Number(l0?.n ?? 0),
      sessions: Number(sessions?.n ?? 0),
      repeatedQuestions: Number(repeated?.n ?? 0),
      candidates: count('candidate'),
      approved: count('approved'),
      forgotten: count('forgotten'),
      ftsAvailable: this.ftsAvailable,
      schemaVersion: Number(version?.value ?? 3),
    }
  }

  setProjectMeta(project: { key: string; name: string; cwd: string }, now = Date.now()): void {
    this.ensureOpen()
    this.db
      .prepare('INSERT OR REPLACE INTO project_meta(key, name, cwd, updated_at) VALUES (?, ?, ?, ?)')
      .run(project.key, project.name, project.cwd, now)
  }

  /** Bounded project label projection for the versioned dashboard bootstrap. */
  dashboardProjectMeta(maxNameBytes = 256): DashboardReadProjectMeta | undefined {
    this.ensureOpen()
    if (!Number.isSafeInteger(maxNameBytes) || maxNameBytes < 0 || maxNameBytes > 256) {
      throw new TypeError('dashboard project-name bound is invalid')
    }
    const row = this.db.prepare(`SELECT
        CASE WHEN length(CAST(name AS BLOB)) <= ? THEN name END AS name,
        length(CAST(name AS BLOB)) AS name_bytes
      FROM project_meta WHERE key = ? LIMIT 1`).get(maxNameBytes, projectKeyOfFile(this.file)) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      ...(typeof row.name === 'string' ? { name: row.name } : {}), nameBytes: Number(row.name_bytes),
    }
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

  appendEvent(input: MemoryEventInput, now = Date.now()): boolean {
    this.ensureOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.appendEventInTransaction(input, now)
      this.db.exec('COMMIT')
      return inserted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private appendEventInTransaction(input: MemoryEventInput, now: number): boolean {
    const usage = input.usage
    const usageKnown = usage !== undefined && Object.values(usage).some((value) => typeof value === 'number') ? 1 : 0
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events(project_key, type, count, tokens, raw_tokens, created_at, event_id,
         session_id, agent_id, agent_preset, provider, model, source, occurred_at, source_id, input_tokens, output_tokens,
         cached_input_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_micros, usage_known, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectKeyOfFile(this.file), input.type, input.count ?? 1, input.tokens ?? 0, input.rawTokens ?? 0, now, input.eventId,
      input.sessionId ?? null, input.agentId ?? null, input.agentPreset ?? null, input.provider ?? null, input.model ?? null,
      input.source ?? null, input.occurredAt ?? now, input.sourceId ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null,
      usage?.cachedInputTokens ?? null, usage?.cacheReadTokens ?? null, usage?.cacheWriteTokens ?? null,
      usage?.reasoningTokens ?? null, usage?.costMicros ?? null, usageKnown,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    if (Number(result.changes ?? 0) > 0) return true
    const existing = this.db.prepare('SELECT * FROM memory_events WHERE event_id = ?').get(input.eventId) as Record<string, unknown> | undefined
    if (existing === undefined) throw new Error('event insert could not be verified')
    const expected: Record<string, unknown> = {
      project_key: projectKeyOfFile(this.file), type: input.type, count: input.count ?? 1, tokens: input.tokens ?? 0,
      raw_tokens: input.rawTokens ?? 0, session_id: input.sessionId ?? null, agent_id: input.agentId ?? null,
      agent_preset: input.agentPreset ?? null, provider: input.provider ?? null, model: input.model ?? null,
      source: input.source ?? null, occurred_at: input.occurredAt ?? now, source_id: input.sourceId ?? null,
      input_tokens: usage?.inputTokens ?? null, output_tokens: usage?.outputTokens ?? null,
      cached_input_tokens: usage?.cachedInputTokens ?? null, cache_read_tokens: usage?.cacheReadTokens ?? null,
      cache_write_tokens: usage?.cacheWriteTokens ?? null, reasoning_tokens: usage?.reasoningTokens ?? null,
      cost_micros: usage?.costMicros ?? null, usage_known: usageKnown,
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
    }
    const metadataMatches = input.type === 'capture'
      ? captureMetadataCompatible(existing.metadata, expected.metadata)
      : (existing.metadata ?? null) === expected.metadata
    if (Object.entries(expected).some(([key, value]) => key !== 'metadata' && (existing[key] ?? null) !== value) || !metadataMatches) {
      throw new Error('event idempotency key conflicts with a different event payload')
    }
    return false
  }

  captureOverview(from: number, to: number, excludedAgentPatterns: string[] = []): CaptureOverview {
    this.ensureOpen()
    const hidden = excludedEventSql(excludedAgentPatterns)
    const base = `e.project_key = ? AND e.type = 'capture' AND e.created_at >= ? AND e.created_at < ? AND ${hidden.sql}`
    const countRow = this.db.prepare(`SELECT COUNT(DISTINCT COALESCE(event_id, 'legacy:' || id)) AS n FROM memory_events e WHERE ${base}`)
      .get(projectKeyOfFile(this.file), from, to, ...hidden.params) as { n?: number }
    const sessionRow = this.db.prepare(`SELECT COUNT(DISTINCT NULLIF(session_id, '')) AS n,
        COUNT(DISTINCT CASE WHEN NULLIF(session_id, '') IS NULL THEN COALESCE(event_id, 'legacy:' || id) END) AS unknown,
        COUNT(DISTINCT CASE WHEN NULLIF(agent_id, '') IS NULL THEN COALESCE(event_id, 'legacy:' || id) END) AS unknown_agents,
        COUNT(DISTINCT CASE WHEN NULLIF(agent_preset, '') IS NULL THEN COALESCE(event_id, 'legacy:' || id) END) AS unknown_agent_presets
       FROM memory_events e WHERE ${base}`)
      .get(projectKeyOfFile(this.file), from, to, ...hidden.params) as { n?: number; unknown?: number; unknown_agents?: number; unknown_agent_presets?: number }
    const group = (column: string, label: string): Array<{ [key: string]: string | number | boolean }> => {
      const rows = this.db.prepare(
        `SELECT COALESCE(NULLIF(${column}, ''), 'unknown') AS value, COUNT(DISTINCT COALESCE(event_id, 'legacy:' || id)) AS n
         FROM memory_events e WHERE ${base} GROUP BY value ORDER BY n DESC, value ASC LIMIT 99`,
      ).all(projectKeyOfFile(this.file), from, to, ...hidden.params) as Array<{ value?: string; n?: number }>
      const output: Array<{ [key: string]: string | number | boolean }> = rows.map((row) => ({ [label]: String(row.value ?? 'unknown'), count: Number(row.n ?? 0) }))
      const total = Number(countRow?.n ?? 0)
      const remainder = Math.max(0, total - rows.reduce((sum, row) => sum + Number(row.n ?? 0), 0))
      if (remainder > 0) output.push({ [label]: 'other', count: remainder, other: true })
      return output
    }
    const repeatedRows = this.db.prepare(
      `SELECT l.fingerprint, COUNT(DISTINCT COALESCE(e.event_id, 'legacy:' || e.id)) AS n
       FROM memory_events e JOIN l0_messages l ON l.id = e.source_id
       WHERE e.project_key = ? AND e.type = 'capture' AND e.created_at >= ? AND e.created_at < ?
         AND l.role = 'user' AND l.fingerprint IS NOT NULL AND ${hidden.sql}
       GROUP BY l.fingerprint HAVING COUNT(DISTINCT COALESCE(e.event_id, 'legacy:' || e.id)) > 1
       ORDER BY n DESC, l.fingerprint LIMIT 100`,
    ).all(projectKeyOfFile(this.file), from, to, ...hidden.params) as Array<{ fingerprint?: string; n?: number }>
    const repeatedTotalRow = this.db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT l.fingerprint FROM memory_events e JOIN l0_messages l ON l.id = e.source_id
         WHERE e.project_key = ? AND e.type = 'capture' AND e.created_at >= ? AND e.created_at < ?
           AND l.role = 'user' AND l.fingerprint IS NOT NULL AND ${hidden.sql}
         GROUP BY l.fingerprint HAVING COUNT(DISTINCT COALESCE(e.event_id, 'legacy:' || e.id)) > 1
       )`,
    ).get(projectKeyOfFile(this.file), from, to, ...hidden.params) as { n?: number }
    const mostLinkedL0 = this.db.prepare(
      `SELECT e.session_id, COUNT(DISTINCT l.id) AS linked_l0_messages,
         COUNT(DISTINCT COALESCE(e.event_id, 'legacy:' || e.id)) AS events
       FROM memory_events e LEFT JOIN l0_messages l ON l.project_key = e.project_key AND l.id = e.source_id
       WHERE ${base} AND NULLIF(e.session_id, '') IS NOT NULL
       GROUP BY e.session_id ORDER BY linked_l0_messages DESC, events DESC, e.session_id ASC LIMIT 1`,
    ).get(projectKeyOfFile(this.file), from, to, ...hidden.params) as { session_id?: string; linked_l0_messages?: number; events?: number } | undefined
    const topSessions = this.db.prepare(
      `SELECT e.session_id, COUNT(DISTINCT l.id) AS linked_l0_messages,
         COUNT(DISTINCT COALESCE(e.event_id, 'legacy:' || e.id)) AS events
       FROM memory_events e LEFT JOIN l0_messages l ON l.project_key = e.project_key AND l.id = e.source_id
       WHERE ${base} AND NULLIF(e.session_id, '') IS NOT NULL
       GROUP BY e.session_id ORDER BY linked_l0_messages DESC, events DESC, e.session_id ASC LIMIT 10`,
    ).all(projectKeyOfFile(this.file), from, to, ...hidden.params) as Array<{ session_id?: string; linked_l0_messages?: number; events?: number }>
    return {
      messageCount: Number(countRow?.n ?? 0),
      sessions: Number(sessionRow?.n ?? 0),
      unknownSessionEvents: Number(sessionRow?.unknown ?? 0),
      unknownAgentEvents: Number(sessionRow?.unknown_agents ?? 0),
      unknownAgentPresetEvents: Number(sessionRow?.unknown_agent_presets ?? 0),
      agents: group('e.agent_id', 'agentId') as CaptureOverview['agents'],
      agentPresets: group('e.agent_preset', 'agentPreset') as CaptureOverview['agentPresets'],
      providers: group('e.provider', 'provider') as CaptureOverview['providers'],
      models: group('e.model', 'model') as CaptureOverview['models'],
      sources: group('e.source', 'source') as CaptureOverview['sources'],
      repeated: repeatedRows.map((row) => ({ fingerprint: String(row.fingerprint), count: Math.max(0, Number(row.n ?? 0) - 1) })),
      repeatedTotal: Number(repeatedTotalRow?.n ?? 0),
      longestSession: null,
      mostLinkedL0Session: mostLinkedL0?.session_id === undefined ? null : {
        sessionId: String(mostLinkedL0.session_id), linkedL0Messages: Number(mostLinkedL0.linked_l0_messages ?? 0),
        originalMessageCount: null, events: Number(mostLinkedL0.events ?? 0),
      },
      topSessions: topSessions.flatMap((row) => typeof row.session_id === 'string'
        ? [{ sessionId: row.session_id, linkedL0Messages: Number(row.linked_l0_messages ?? 0), originalMessageCount: null,
          events: Number(row.events ?? 0) }] : []),
    }
  }

  captureOriginalMessageMetrics(
    from: number,
    to: number,
    excludedAgentPatterns: string[],
    visibleBatch: (candidates: CaptureIdentityFenceCandidate[]) => boolean[],
  ): CaptureOriginalMessageMetrics {
    this.ensureOpen()
    const hidden = excludedEventSql(excludedAgentPatterns)
    const batchSize = 200
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS tdai_capture_original_message_scope_v1 (
      capture_row_id INTEGER PRIMARY KEY,
      session_id TEXT,
      source_id TEXT,
      identity_digest TEXT
    )`)
    const clear = this.db.prepare('DELETE FROM tdai_capture_original_message_scope_v1')
    clear.run()
    const insert = this.db.prepare(`INSERT INTO tdai_capture_original_message_scope_v1
      (capture_row_id, session_id, source_id, identity_digest) VALUES (?, ?, ?, ?)`)
    const page = this.db.prepare(`SELECT e.id AS row_id, e.event_id, e.session_id, e.source_id, e.metadata,
        l.source_event_id AS l0_source_event_id
      FROM memory_events e
      LEFT JOIN l0_messages l ON l.project_key = e.project_key AND l.id = e.source_id
      WHERE e.project_key = ? AND e.type = 'capture' AND e.created_at >= ? AND e.created_at < ?
        AND ${hidden.sql} AND e.id > ?
      ORDER BY e.id ASC LIMIT ?`)
    let afterId = 0
    try {
      while (true) {
        const rows = page.all(projectKeyOfFile(this.file), from, to, ...hidden.params, afterId, batchSize) as Array<Record<string, unknown>>
        if (rows.length === 0) break
        const candidates = rows.map((row) => {
          const sourceId = row.source_id
          const sourceEventId = captureSourceEventIdFromRow(row)
          return {
            ...(typeof sourceId === 'string' && sourceId.length > 0 ? { sourceId } : {}),
            ...(sourceEventId === undefined ? {} : { sourceEventId }),
          }
        })
        const visible = visibleBatch(candidates)
        if (!Array.isArray(visible) || visible.length !== rows.length || visible.some((value) => typeof value !== 'boolean')) {
          throw new Error('capture identity visibility filter returned an invalid batch')
        }
        for (let index = 0; index < rows.length; index += 1) {
          if (visible[index] !== true) continue
          const row = rows[index]!
          const rowId = Number(row.row_id)
          if (!Number.isSafeInteger(rowId) || rowId <= 0) throw new Error('capture identity event row has an invalid key')
          insert.run(rowId, typeof row.session_id === 'string' ? row.session_id : null,
            typeof row.source_id === 'string' ? row.source_id : null, captureIdentityFromMetadata(row.metadata))
        }
        const lastId = Number(rows[rows.length - 1]?.row_id)
        if (!Number.isSafeInteger(lastId) || lastId <= afterId) throw new Error('capture identity paging did not advance')
        afterId = lastId
      }
      const totals = this.db.prepare(`SELECT COUNT(DISTINCT identity_digest) AS known,
          COUNT(DISTINCT CASE WHEN identity_digest IS NULL THEN capture_row_id END) AS unknown
        FROM tdai_capture_original_message_scope_v1`).get() as { known?: number; unknown?: number }
      const sessionRows = this.db.prepare(`SELECT c.session_id, COUNT(DISTINCT l.id) AS linked_l0_messages,
          COUNT(DISTINCT c.capture_row_id) AS events,
          COUNT(DISTINCT c.identity_digest) AS recorded_original_message_lower_bound,
          COUNT(DISTINCT CASE WHEN c.identity_digest IS NULL THEN c.capture_row_id END) AS unknown_original_message_events
        FROM tdai_capture_original_message_scope_v1 c
        LEFT JOIN l0_messages l ON l.project_key = ? AND l.id = c.source_id
        WHERE NULLIF(c.session_id, '') IS NOT NULL
        GROUP BY c.session_id
        ORDER BY linked_l0_messages DESC, events DESC, c.session_id ASC LIMIT 10`)
        .all(projectKeyOfFile(this.file)) as Array<Record<string, unknown>>
      const topSessions = sessionRows.flatMap((row) => typeof row.session_id === 'string' ? [{
        sessionId: row.session_id,
        linkedL0Messages: Number(row.linked_l0_messages ?? 0),
        originalMessageCount: null as null,
        events: Number(row.events ?? 0),
        recordedOriginalMessageLowerBound: Number(row.recorded_original_message_lower_bound ?? 0),
        unknownOriginalMessageEvents: Number(row.unknown_original_message_events ?? 0),
      }] : [])
      return {
        recordedOriginalMessageLowerBound: Number(totals.known ?? 0),
        unknownOriginalMessageEvents: Number(totals.unknown ?? 0),
        mostLinkedL0Session: topSessions[0] ?? null,
        topSessions,
      }
    } finally {
      clear.run()
    }
  }

  repeatedCapturesPage(input: { from: number; to: number; limit?: number; after?: { repeatCount: number; fingerprint: string }; excludedAgentPatterns?: string[] }): {
    items: Array<{ fingerprint: string; repeatCount: number }>; next?: { repeatCount: number; fingerprint: string }
  } {
    this.ensureOpen()
    if (!this.dashboardEventsAssociationIndexReady()) throw new Error('events association index is missing')
    const hidden = excludedEventSql(input.excludedAgentPatterns ?? [])
    const repeatedCount = 'COUNT(DISTINCT COALESCE(e.event_id, \'legacy:\' || e.id))'
    const afterHaving = input.after === undefined ? '' : ` AND (${repeatedCount} < ? OR (${repeatedCount} = ? AND l.fingerprint > ?))`
    const params: unknown[] = [input.from, input.to, projectKeyOfFile(this.file), ...hidden.params]
    if (input.after !== undefined) params.push(input.after.repeatCount + 1, input.after.repeatCount + 1, input.after.fingerprint)
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)))
    const rows = this.db.prepare(`SELECT l.fingerprint, ${repeatedCount} AS n
      FROM l0_messages l INDEXED BY l0_fingerprint_idx
      JOIN memory_events e INDEXED BY memory_events_association
        ON e.project_key = l.project_key AND e.type = 'capture' AND e.source_id = l.id
       AND e.created_at >= ? AND e.created_at < ?
      WHERE l.project_key = ? AND l.role = 'user' AND l.fingerprint IS NOT NULL AND ${hidden.sql}
      GROUP BY l.fingerprint HAVING ${repeatedCount} > 1${afterHaving}
      ORDER BY n DESC, l.fingerprint ASC LIMIT ?`).all(...params, limit + 1) as Array<{ fingerprint?: string; n?: number }>
    const items = rows.slice(0, limit).flatMap((row) => typeof row.fingerprint === 'string'
      ? [{ fingerprint: row.fingerprint, repeatCount: Math.max(0, Number(row.n ?? 0) - 1) }] : [])
    const last = items.at(-1)
    return { items, ...(rows.length > limit && last !== undefined ? { next: { repeatCount: last.repeatCount, fingerprint: last.fingerprint } } : {}) }
  }

  /**
   * Level 1 of the bounded repeated-capture scan: the next distinct user
   * fingerprint after the caller's stable ASCII cursor. The
   * `(project_key, fingerprint, created_at)` index answers one row per query;
   * an over-long fingerprint is returned as a byte sentinel so the caller
   * stops instead of truncating a seek key.
   */
  dashboardRepeatFingerprintNext(afterFingerprint?: string): DashboardRepeatFingerprintRow | undefined {
    this.ensureOpen()
    if (afterFingerprint !== undefined && (typeof afterFingerprint !== 'string' || afterFingerprint.length === 0 ||
        afterFingerprint.includes('\u0000') || Buffer.byteLength(afterFingerprint, 'utf8') > 512)) {
      throw new TypeError('repeat fingerprint cursor is invalid')
    }
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(fingerprint AS BLOB)) <= 512 THEN fingerprint END AS fingerprint,
        length(CAST(fingerprint AS BLOB)) AS fingerprint_bytes
      FROM l0_messages INDEXED BY l0_fingerprint_idx
      WHERE project_key = ? AND role = 'user' AND fingerprint IS NOT NULL
        ${afterFingerprint === undefined ? '' : 'AND fingerprint > ?'}
      ORDER BY fingerprint ASC LIMIT 1`).get(...(afterFingerprint === undefined
        ? [projectKeyOfFile(this.file)] : [projectKeyOfFile(this.file), afterFingerprint])) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const fingerprintBytes = Number(row.fingerprint_bytes)
    if (!Number.isSafeInteger(fingerprintBytes) || fingerprintBytes < 1) throw new Error('repeat fingerprint projection is invalid')
    return { ...(typeof row.fingerprint === 'string' ? { fingerprint: row.fingerprint } : {}), fingerprintBytes }
  }

  /**
   * Level 2: bounded L0 members of one repeated-capture group, ordered by the
   * actual `(created_at, rowid)` index key. `limit + 1` raw rows are read so
   * the sentinel proves whether the group has more members without advancing
   * the caller's consumed cursor.
   */
  dashboardRepeatGroupMemberPage(fingerprint: string, after?: { createdAt: number; rowid: number }, limit = 15): {
    rows: DashboardRepeatMemberRow[]; hasMore: boolean
  } {
    this.ensureOpen()
    if (typeof fingerprint !== 'string' || fingerprint.length === 0 || fingerprint.includes('\u0000') ||
        Buffer.byteLength(fingerprint, 'utf8') > 512) throw new TypeError('repeat group fingerprint is invalid')
    if (after !== undefined && (!Number.isSafeInteger(after.createdAt) || after.createdAt < 0 ||
        !Number.isSafeInteger(after.rowid) || after.rowid < 1)) throw new TypeError('repeat group member cursor is invalid')
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    const rows = this.db.prepare(`SELECT rowid AS member_rowid,
        CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS member_id,
        length(CAST(id AS BLOB)) AS member_id_bytes, created_at
      FROM l0_messages INDEXED BY l0_fingerprint_idx
      WHERE project_key = ? AND role = 'user' AND fingerprint = ?
        ${after === undefined ? '' : 'AND (created_at > ? OR (created_at = ? AND rowid > ?))'}
      ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(...(after === undefined
      ? [projectKeyOfFile(this.file), fingerprint] : [projectKeyOfFile(this.file), fingerprint, after.createdAt, after.createdAt, after.rowid]),
      bounded + 1) as Array<Record<string, unknown>>
    return {
      rows: rows.slice(0, bounded).map((row) => ({
        rowid: Number(row.member_rowid),
        ...(typeof row.member_id === 'string' ? { memberId: row.member_id } : {}),
        memberIdBytes: Number(row.member_id_bytes),
        createdAt: Number(row.created_at),
      })),
      hasMore: rows.length > bounded,
    }
  }

  /**
   * Level 3: bounded capture events for one L0 member inside the requested
   * record-time window. Uses the registered
   * `(project_key, type, source_id, created_at, id)` association index and
   * fails closed when that index is absent; there is no unbounded GROUP BY
   * fallback on this route.
   */
  dashboardRepeatCaptureEventPage(sourceId: string, from: number, to: number,
    after?: { createdAt: number; id: number }, limit = 15): { rows: DashboardRepeatEventRow[]; hasMore: boolean } {
    this.ensureOpen()
    if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.includes('\u0000') ||
        Buffer.byteLength(sourceId, 'utf8') > 256) throw new TypeError('repeat capture source id is invalid')
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new TypeError('repeat capture time window is invalid')
    }
    if (after !== undefined && (!Number.isSafeInteger(after.createdAt) || after.createdAt < 0 ||
        !Number.isSafeInteger(after.id) || after.id < 1)) throw new TypeError('repeat capture event cursor is invalid')
    if (!this.dashboardEventsAssociationIndexReady()) throw new Error('events association index is missing')
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(15, limit)) : 15
    const rows = this.db.prepare(`SELECT e.id,
        CASE WHEN e.event_id IS NULL OR length(CAST(e.event_id AS BLOB)) <= 2048 THEN e.event_id END AS event_id,
        COALESCE(length(CAST(e.event_id AS BLOB)), 0) AS event_id_bytes,
        e.created_at,
        CASE WHEN e.source_id IS NULL OR length(CAST(e.source_id AS BLOB)) <= 256 THEN e.source_id END AS source_id,
        COALESCE(length(CAST(e.source_id AS BLOB)), 0) AS source_id_bytes,
        CASE WHEN e.session_id IS NULL OR length(CAST(e.session_id AS BLOB)) <= 512 THEN e.session_id END AS session_id,
        COALESCE(length(CAST(e.session_id AS BLOB)), 0) AS session_id_bytes,
        CASE WHEN e.source IS NULL OR length(CAST(e.source AS BLOB)) <= 512 THEN e.source END AS source,
        COALESCE(length(CAST(e.source AS BLOB)), 0) AS source_bytes,
        CASE WHEN e.agent_id IS NULL OR length(CAST(e.agent_id AS BLOB)) <= 512 THEN e.agent_id END AS agent_id,
        COALESCE(length(CAST(e.agent_id AS BLOB)), 0) AS agent_id_bytes,
        CASE WHEN e.agent_preset IS NULL OR length(CAST(e.agent_preset AS BLOB)) <= 512 THEN e.agent_preset END AS agent_preset,
        COALESCE(length(CAST(e.agent_preset AS BLOB)), 0) AS agent_preset_bytes,
        CASE WHEN e.provider IS NULL OR length(CAST(e.provider AS BLOB)) <= 256 THEN e.provider END AS provider,
        COALESCE(length(CAST(e.provider AS BLOB)), 0) AS provider_bytes,
        CASE WHEN e.model IS NULL OR length(CAST(e.model AS BLOB)) <= 256 THEN e.model END AS model,
        COALESCE(length(CAST(e.model AS BLOB)), 0) AS model_bytes,
        CASE WHEN l.source_event_id IS NULL OR length(CAST(l.source_event_id AS BLOB)) <= 2000 THEN l.source_event_id END AS l0_source_event_id,
        COALESCE(length(CAST(l.source_event_id AS BLOB)), 0) AS l0_source_event_id_bytes,
        CASE WHEN l.role = 'user' AND length(CAST(l.fingerprint AS BLOB)) <= 512 THEN l.fingerprint END AS l0_fingerprint,
        COALESCE(length(CAST(l.fingerprint AS BLOB)), 0) AS l0_fingerprint_bytes
      FROM memory_events e INDEXED BY memory_events_association
      LEFT JOIN l0_messages l ON l.project_key = e.project_key AND l.id = e.source_id
      WHERE e.project_key = ? AND e.type = 'capture' AND e.source_id = ?
        AND e.created_at >= ? AND e.created_at < ?
        ${after === undefined ? '' : 'AND (e.created_at > ? OR (e.created_at = ? AND e.id > ?))'}
      ORDER BY e.created_at ASC, e.id ASC LIMIT ?`).all(...(after === undefined
      ? [projectKeyOfFile(this.file), sourceId, from, to]
      : [projectKeyOfFile(this.file), sourceId, from, to, after.createdAt, after.createdAt, after.id]),
      bounded + 1) as Array<Record<string, unknown>>
    return {
      rows: rows.slice(0, bounded).map((row) => {
        const eventIdBytes = Number(row.event_id_bytes)
        const sourceIdBytes = Number(row.source_id_bytes)
        const sessionIdBytes = Number(row.session_id_bytes)
        const l0SourceEventIdBytes = Number(row.l0_source_event_id_bytes)
        const fingerprintBytes = Number(row.l0_fingerprint_bytes)
        const eventId = typeof row.event_id === 'string' ? row.event_id : undefined
        const projectedSourceId = typeof row.source_id === 'string' ? row.source_id : undefined
        const l0SourceEventId = typeof row.l0_source_event_id === 'string' && row.l0_source_event_id.length > 0
          ? row.l0_source_event_id : undefined
        const captureSuffix = eventId !== undefined && eventId.startsWith('capture:') ? eventId.slice('capture:'.length) : undefined
        const eventSourceEventId = captureSuffix !== undefined && captureSuffix.length > 0 ? captureSuffix : undefined
        const eventSourceEventIdBytes = Buffer.byteLength(eventSourceEventId ?? '', 'utf8')
        return {
          id: Number(row.id),
          ...(eventId === undefined ? {} : { eventId }), eventIdBytes,
          createdAt: Number(row.created_at),
          ...(projectedSourceId === undefined ? {} : { sourceId: projectedSourceId }), sourceIdBytes,
          ...(l0SourceEventId === undefined ? {} : { l0SourceEventId }), l0SourceEventIdBytes,
          ...(eventSourceEventId === undefined ? {} : { eventSourceEventId }), eventSourceEventIdBytes,
          ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}), sessionIdBytes,
          ...(typeof row.source === 'string' ? { source: row.source } : {}), sourceBytes: Number(row.source_bytes),
          ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}), agentIdBytes: Number(row.agent_id_bytes),
          ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}), agentPresetBytes: Number(row.agent_preset_bytes),
          ...(typeof row.provider === 'string' ? { provider: row.provider } : {}), providerBytes: Number(row.provider_bytes),
          ...(typeof row.model === 'string' ? { model: row.model } : {}), modelBytes: Number(row.model_bytes),
          ...(typeof row.l0_fingerprint === 'string' ? { fingerprint: row.l0_fingerprint } : {}), fingerprintBytes,
          fingerprintInvalid: fingerprintBytes > 512 || fingerprintBytes > 0 && typeof row.l0_fingerprint !== 'string',
          identityInvalid: sourceIdBytes > 256 || projectedSourceId === undefined && sourceIdBytes > 0 ||
            eventIdBytes > 2048 || sessionIdBytes > 512 || l0SourceEventIdBytes > 2000 || eventSourceEventIdBytes > 2000,
        }
      }),
      hasMore: rows.length > bounded,
    }
  }

  /**
   * Explicit-excerpt point read. Only called when the caller asked for an
   * excerpt; the materialized text is capped at 161 characters and the raw
   * source body is never returned.
   */
  dashboardRepeatExcerpt(memberId: string): { excerpt: string; excerptBytes: number; excerptTruncated: boolean } | undefined {
    this.ensureOpen()
    if (typeof memberId !== 'string' || memberId.length === 0 || memberId.includes('\u0000') ||
        Buffer.byteLength(memberId, 'utf8') > 256) throw new TypeError('repeat excerpt source id is invalid')
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(content AS BLOB)) <= 4_000_000 THEN substr(content, 1, 160) END AS excerpt,
        length(CAST(content AS BLOB)) AS content_bytes
      FROM l0_messages WHERE project_key = ? AND id = ?`).get(projectKeyOfFile(this.file), memberId) as Record<string, unknown> | undefined
    if (row === undefined || typeof row.excerpt !== 'string') return undefined
    const contentBytes = Number(row.content_bytes)
    const excerptBytes = Buffer.byteLength(row.excerpt, 'utf8')
    if (!Number.isSafeInteger(contentBytes) || contentBytes < excerptBytes || excerptBytes > 2048) return undefined
    return { excerpt: row.excerpt, excerptBytes, excerptTruncated: contentBytes > excerptBytes }
  }

  eventDetails(input: {
    from: number
    to: number
    type: 'capture' | 'recall_returned' | 'recall_no_result' | 'revision' | 'initial_approval' | 'inject_prepared'
    dimension?: 'source' | 'agent' | 'agent_preset' | 'provider' | 'model'
    value?: string
    otherValues?: string[]
    fingerprint?: string
    includeExcerpt?: boolean
    after?: { occurredAt: number; id: number }
    limit?: number
    excludedAgentPatterns?: string[]
  }): { events: MemoryEventDetail[]; next?: { occurredAt: number; id: number } } {
    this.ensureOpen()
    const hidden = excludedEventSql(input.excludedAgentPatterns ?? [])
    const eventTime = input.type === 'capture' ? 'e.created_at' : 'COALESCE(e.occurred_at, e.created_at)'
    const columns = { source: 'e.source', agent: 'e.agent_id', agent_preset: 'e.agent_preset', provider: 'e.provider', model: 'e.model' } as const
    const dim = input.dimension === undefined ? undefined : columns[input.dimension]
    const otherValues = [...new Set((input.otherValues ?? []).filter((value) => typeof value === 'string').map((value) => value.slice(0, 500)))].slice(0, 100)
    let dimensionSql = '1 = 1'
    if (dim !== undefined && input.value !== undefined) {
      if (input.value === '__other__') {
        dimensionSql = otherValues.length === 0 ? '1 = 0' : `COALESCE(NULLIF(${dim}, ''), 'unknown') NOT IN (${otherValues.map(() => '?').join(', ')})`
      } else {
        dimensionSql = `COALESCE(NULLIF(${dim}, ''), 'unknown') = ?`
      }
    }
    const fingerprintSql = input.type === 'capture' && input.fingerprint !== undefined ? ' AND l.fingerprint = ? AND l.role = \'user\'' : ''
    const afterSql = input.after === undefined ? '' : ` AND (${eventTime} < ? OR (${eventTime} = ? AND e.id < ?))`
    const params: unknown[] = [projectKeyOfFile(this.file), input.type, input.from, input.to, ...hidden.params]
    if (dim !== undefined && input.value !== undefined) {
      if (input.value === '__other__') params.push(...otherValues)
      else params.push(input.value)
    }
    if (fingerprintSql !== '') params.push(input.fingerprint)
    if (input.after !== undefined) params.push(input.after.occurredAt, input.after.occurredAt, input.after.id)
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
    const rows = this.db.prepare(
      `SELECT e.id, e.event_id, e.type, ${eventTime} AS occurred_at, COALESCE(e.occurred_at, e.created_at) AS source_occurred_at, e.created_at AS captured_at,
         e.count, e.tokens, e.raw_tokens, e.metadata, e.session_id, e.source, e.agent_id, e.agent_preset, e.provider, e.model, e.source_id,
         ${input.includeExcerpt === true && input.type === 'capture' && input.fingerprint !== undefined ? 'substr(l.content, 1, 161)' : 'NULL'} AS excerpt,
         CASE WHEN e.type = 'capture' AND l.role = 'user' THEN l.fingerprint ELSE NULL END AS fingerprint
       FROM memory_events e LEFT JOIN l0_messages l ON l.id = e.source_id AND l.project_key = e.project_key
       WHERE e.project_key = ? AND e.type = ? AND ${eventTime} >= ? AND ${eventTime} < ?
         AND ${hidden.sql} AND ${dimensionSql}${fingerprintSql}${afterSql}
       ORDER BY ${eventTime} DESC, e.id DESC LIMIT ?`,
    ).all(...params, boundedLimit + 1) as Array<Record<string, unknown>>
    const hasMore = rows.length > boundedLimit
    const page = rows.slice(0, boundedLimit).map((row): MemoryEventDetail => {
      const metadata = parseJson<Record<string, unknown>>(row.metadata, {})
      const selectedMemoryIds = Array.isArray(metadata.memoryIds) ? metadata.memoryIds.filter((id): id is string => typeof id === 'string') : []
      return {
        id: Number(row.id), eventId: String(row.event_id ?? `legacy:${String(row.id)}`), type: String(row.type),
        occurredAt: Number(row.occurred_at),
        ...(input.type === 'capture' && Number(row.source_occurred_at) !== Number(row.captured_at) ? { sourceOccurredAt: Number(row.source_occurred_at) } : {}),
        count: Number(row.count ?? 0), tokens: Number(row.tokens ?? 0), rawTokens: Number(row.raw_tokens ?? 0),
        ...(metadata.estimate === true ? { tokenEstimate: true } : {}), ...(selectedMemoryIds.length > 0 ? { selectedMemoryIds } : {}),
        ...(typeof row.session_id === 'string' && row.session_id !== '' ? { sessionId: row.session_id } : {}),
        ...(typeof row.source === 'string' && row.source !== '' ? { source: row.source } : {}),
        ...(typeof row.agent_id === 'string' && row.agent_id !== '' ? { agentId: row.agent_id } : {}),
        ...(typeof row.agent_preset === 'string' && row.agent_preset !== '' ? { agentPreset: row.agent_preset } : {}),
        ...(typeof row.provider === 'string' && row.provider !== '' ? { provider: row.provider } : {}),
        ...(typeof row.model === 'string' && row.model !== '' ? { model: row.model } : {}),
        ...(typeof row.source_id === 'string' && row.source_id !== '' ? { sourceId: row.source_id } : {}),
        ...(typeof row.fingerprint === 'string' && row.fingerprint !== '' ? { fingerprint: row.fingerprint } : {}),
        ...(typeof row.excerpt === 'string' ? { excerpt: row.excerpt.slice(0, 160), excerptTruncated: row.excerpt.length > 160 } : {}),
      }
    })
    const last = page.at(-1)
    return { events: page, ...(hasMore && last !== undefined ? { next: { occurredAt: last.occurredAt, id: last.id } } : {}) }
  }

  eventDimensions(from: number, to: number, type: 'capture' | 'recall_returned' | 'revision' | 'initial_approval' | 'inject_prepared', excludedAgentPatterns: string[] = []): Pick<CaptureOverview, 'sources' | 'agents' | 'agentPresets' | 'providers' | 'models'> {
    this.ensureOpen()
    const hidden = excludedEventSql(excludedAgentPatterns)
    const eventTime = type === 'capture' ? 'e.created_at' : 'COALESCE(e.occurred_at, e.created_at)'
    const countSql = 'SELECT COUNT(DISTINCT COALESCE(event_id, \'legacy:\' || id)) AS n FROM memory_events e ' +
      'WHERE e.project_key = ? AND e.type = ? AND ' + eventTime + ' >= ? AND ' + eventTime + ' < ? AND ' + hidden.sql
    const countRow = this.db.prepare(countSql).get(projectKeyOfFile(this.file), type, from, to, ...hidden.params) as { n?: number }
    const total = Number(countRow?.n ?? 0)
    const group = (column: string, label: string): Array<{ [key: string]: string | number | boolean }> => {
      const sql = 'SELECT COALESCE(NULLIF(' + column + ', \'\'), \'unknown\') AS value, COUNT(DISTINCT COALESCE(event_id, \'legacy:\' || id)) AS n ' +
        'FROM memory_events e WHERE e.project_key = ? AND e.type = ? AND ' + eventTime + ' >= ? AND ' + eventTime + ' < ? AND ' + hidden.sql +
        ' GROUP BY value ORDER BY n DESC, value ASC LIMIT 99'
      const rows = this.db.prepare(sql).all(projectKeyOfFile(this.file), type, from, to, ...hidden.params) as Array<{ value?: string; n?: number }>
      const result: Array<{ [key: string]: string | number | boolean }> = rows.map((row) => ({ [label]: String(row.value ?? 'unknown'), count: Number(row.n ?? 0) }))
      const remainder = Math.max(0, total - rows.reduce((sum, row) => sum + Number(row.n ?? 0), 0))
      if (remainder > 0) result.push({ [label]: 'other', count: remainder, other: true })
      return result
    }
    return {
      sources: group('e.source', 'source') as CaptureOverview['sources'],
      agents: group('e.agent_id', 'agentId') as CaptureOverview['agents'],
      agentPresets: group('e.agent_preset', 'agentPreset') as CaptureOverview['agentPresets'],
      providers: group('e.provider', 'provider') as CaptureOverview['providers'],
      models: group('e.model', 'model') as CaptureOverview['models'],
    }
  }

  dailyEvents(from: number, to: number, excludedAgentPatterns: string[] = []): DailyEventCount[] {
    this.ensureOpen()
    const hidden = excludedEventSql(excludedAgentPatterns)
    const rows = this.db.prepare(
      `SELECT type, COUNT(DISTINCT COALESCE(event_id, 'legacy:' || id)) AS events, COALESCE(SUM(count), 0) AS n,
         COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(raw_tokens), 0) AS raw
       FROM memory_events e WHERE project_key = ? AND COALESCE(occurred_at, created_at) >= ? AND COALESCE(occurred_at, created_at) < ?
         AND ${hidden.sql} GROUP BY type`,
    ).all(projectKeyOfFile(this.file), from, to, ...hidden.params) as Array<Record<string, unknown>>
    return rows.map((row) => ({ type: String(row.type), events: Number(row.events ?? 0), count: Number(row.n ?? 0), tokens: Number(row.tokens ?? 0), rawTokens: Number(row.raw ?? 0) }))
  }

  questionOccurrences(fingerprint: string, from: number, to: number, excludedAgentPatterns: string[] = [], limit = 25): Array<{ id: string; content: string; sessionId: string; createdAt: number }> {
    this.ensureOpen()
    const filter = excludedEventSql(excludedAgentPatterns)
    const rows = this.db.prepare(
      `SELECT DISTINCT l.id, l.content, l.session_id, l.created_at FROM l0_messages l
       JOIN memory_events e ON e.source_id = l.id AND e.project_key = l.project_key AND e.type = 'capture'
       WHERE l.project_key = ? AND l.role = 'user' AND l.fingerprint = ? AND e.created_at >= ? AND e.created_at < ? AND ${filter.sql}
       ORDER BY e.created_at ASC, l.id ASC LIMIT ?`,
    ).all(projectKeyOfFile(this.file), fingerprint, from, to, ...filter.params, Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), content: String(row.content), sessionId: String(row.session_id), createdAt: Number(row.created_at) }))
  }

  /**
   * Read the current approved revision projection without hydrating memory bodies.
   * `currentTtlAt` may pin expiry checks across a caller's multi-query snapshot;
   * omitted values preserve the current wall-clock TTL for historical valid/known reads.
   */
  approvedRecordReferences(excludedAgentPatterns: string[] = [], now = Date.now(), knownAt = now,
    currentTtlAt = Date.now()): Array<{
    id: string
    revision: number
    sourceMessageIds: string[]
  }> {
    this.ensureOpen()
    // Keep the same effective-revision, expiry, source-exclusion, and ordering
    // predicates as approvedRecords(), without selecting approved body content.
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const rows = this.db.prepare(`SELECT m.id, r.revision AS effective_revision, r.source_message_ids AS effective_source_ids
      FROM l1_memories m JOIN l1_revisions r ON r.memory_id = m.id AND r.status = 'approved'
        AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?) AND (r.valid_to IS NULL OR r.valid_to > ?) AND r.recorded_at <= ?
      WHERE m.project_key = ? AND m.status = 'approved' AND (m.expiry_at IS NULL OR m.expiry_at > ?)
        AND NOT EXISTS (SELECT 1 FROM l1_revisions newer WHERE newer.memory_id = r.memory_id AND newer.status = 'approved'
          AND newer.recorded_at <= ? AND (newer.valid_from_state = 'unknown' OR newer.valid_from <= ?) AND (newer.valid_to IS NULL OR newer.valid_to > ?)
          AND (newer.recorded_at > r.recorded_at OR (newer.recorded_at = r.recorded_at AND newer.revision > r.revision)))
        AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.project_key = m.project_key AND l.id = ms.source_id
          WHERE ms.memory_id = m.id AND ${hidden.sql})
      ORDER BY m.updated_at DESC`).all(now, now, knownAt, projectKeyOfFile(this.file), currentTtlAt, knownAt, now, now, ...hidden.params) as Array<Record<string, unknown>>
    return rows.flatMap((row) => typeof row.id === 'string'
      ? [{ id: row.id, revision: Number(row.effective_revision), sourceMessageIds: parseIds(row.effective_source_ids) }]
      : [])
  }

  /** `currentTtlAt` is separate from valid/known time so historical reads never revive expired rows. */
  approvedRecords(excludedAgentPatterns: string[] = [], now = Date.now(), knownAt = now, onlyScene?: string | string[],
    onlyIds?: string[], currentTtlAt = Date.now()): MemoryRecord[] {
    this.ensureOpen()
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const sceneNames = onlyScene === undefined ? undefined : [...new Set(typeof onlyScene === 'string' ? [onlyScene] : onlyScene)]
    if (sceneNames?.length === 0 || onlyIds?.length === 0) return []
    const sceneFilter = sceneNames === undefined ? '' : `AND COALESCE(NULLIF(TRIM(r.scene, ?), ''), 'general') IN (${sceneNames.map(() => '?').join(',')})`
    const idFilter = onlyIds === undefined ? '' : `AND m.id IN (${onlyIds.map(() => '?').join(',')})`
    const sceneTrimCharacters = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    const rows = this.db.prepare(
      `SELECT m.*, r.content AS effective_content, r.kind AS effective_kind, r.scene AS effective_scene,
         r.revision AS effective_revision, r.valid_from AS effective_valid_from, r.valid_from_state AS effective_valid_from_state,
         r.valid_from_precision AS effective_valid_from_precision, r.valid_from_upper AS effective_valid_from_upper,
         r.valid_from_basis AS effective_valid_from_basis, r.valid_from_label AS effective_valid_from_label, r.valid_to AS effective_valid_to,
         r.recorded_at AS effective_recorded_at, r.superseded_at AS effective_superseded_at,
         r.source_message_ids AS effective_source_ids, r.source_verified AS effective_source_verified
       FROM l1_memories m JOIN l1_revisions r ON r.memory_id = m.id AND r.status = 'approved'
         AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?) AND (r.valid_to IS NULL OR r.valid_to > ?) AND r.recorded_at <= ?
       WHERE m.status = 'approved' AND (m.expiry_at IS NULL OR m.expiry_at > ?) ${sceneFilter} ${idFilter}
         AND NOT EXISTS (SELECT 1 FROM l1_revisions newer WHERE newer.memory_id = r.memory_id AND newer.status = 'approved'
           AND newer.recorded_at <= ? AND (newer.valid_from_state = 'unknown' OR newer.valid_from <= ?) AND (newer.valid_to IS NULL OR newer.valid_to > ?)
           AND (newer.recorded_at > r.recorded_at OR (newer.recorded_at = r.recorded_at AND newer.revision > r.revision)))
         AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id
           WHERE ms.memory_id = m.id AND ${hidden.sql})
       ORDER BY m.updated_at DESC`,
    ).all(now, now, knownAt, currentTtlAt, ...(sceneNames === undefined ? [] : [sceneTrimCharacters, ...sceneNames]),
      ...(onlyIds === undefined ? [] : onlyIds), knownAt, now, now, ...hidden.params) as Record<string, unknown>[]
    return rows.map((row) => toRecord({ ...row,
      content: row.effective_content, kind: row.effective_kind, scene: row.effective_scene,
      revision: row.effective_revision, valid_from: row.effective_valid_from, valid_from_state: row.effective_valid_from_state,
      valid_from_precision: row.effective_valid_from_precision, valid_from_upper: row.effective_valid_from_upper,
      valid_from_basis: row.effective_valid_from_basis, valid_from_label: row.effective_valid_from_label, valid_to: row.effective_valid_to,
      recorded_at: row.effective_recorded_at, superseded_at: row.effective_superseded_at,
      source_message_ids: row.effective_source_ids, source_verified: row.effective_source_verified,
    }))
  }

  visibleApprovedCount(excludedAgentPatterns: string[] = [], now = Date.now()): number {
    this.ensureOpen()
    const hidden = excludedMemorySql(excludedAgentPatterns)
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT m.id) AS n FROM l1_memories m JOIN l1_revisions r ON r.memory_id = m.id
       WHERE m.status = 'approved' AND r.status = 'approved' AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?)
       AND (r.valid_to IS NULL OR r.valid_to > ?)
       AND r.recorded_at <= ? AND (m.expiry_at IS NULL OR m.expiry_at > ?) AND NOT EXISTS (
         SELECT 1 FROM memory_sources ms JOIN l0_messages l ON l.id = ms.source_id WHERE ms.memory_id = m.id AND ${hidden.sql})`,
    ).get(now, now, now, now, ...hidden.params) as { n?: number }
    return Number(row?.n ?? 0)
  }

  eventDayMetrics(days: Array<{ date: string; from: number; to: number }>, excludedAgentPatterns: string[] = []): EventDayMetrics[] {
    this.ensureOpen()
    if (days.length === 0) return []
    const boundedDays = days.slice(0, 400)
    const hidden = excludedEventSql(excludedAgentPatterns)
    const values = boundedDays.map(() => '(?, ?, ?)').join(', ')
    const params: unknown[] = []
    for (let index = 0; index < boundedDays.length; index += 1) {
      const day = boundedDays[index]!
      params.push(index, day.from, day.to)
    }
    params.push(projectKeyOfFile(this.file), ...hidden.params)
    const rows = this.db.prepare(
      `WITH days(i, day_start, day_end) AS (VALUES ${values})
       SELECT days.i,
         COUNT(DISTINCT CASE WHEN e.type = 'capture' THEN COALESCE(e.event_id, 'legacy:' || e.id) END) AS captures,
         COUNT(DISTINCT CASE WHEN e.type = 'recall_returned' THEN COALESCE(e.event_id, 'legacy:' || e.id) END) AS recalls,
         COUNT(DISTINCT CASE WHEN e.type IN ('recall_returned','recall_no_result') THEN COALESCE(e.event_id, 'legacy:' || e.id) END) AS recall_requests,
         COUNT(DISTINCT CASE WHEN e.type = 'revision' THEN COALESCE(e.event_id, 'legacy:' || e.id) END) AS revisions,
         COUNT(DISTINCT CASE WHEN e.type = 'initial_approval' THEN COALESCE(e.event_id, 'legacy:' || e.id) END) AS initial_approvals,
         COUNT(DISTINCT CASE WHEN e.type = 'inject_prepared' THEN COALESCE(e.event_id, 'legacy:' || e.id) END) AS prepared_events,
         COALESCE(SUM(CASE WHEN e.type = 'inject_prepared' THEN e.count ELSE 0 END), 0) AS prepared
       FROM days LEFT JOIN memory_events e ON e.project_key = ?
         AND (CASE WHEN e.type = 'capture' THEN e.created_at ELSE COALESCE(e.occurred_at, e.created_at) END) >= days.day_start
         AND (CASE WHEN e.type = 'capture' THEN e.created_at ELSE COALESCE(e.occurred_at, e.created_at) END) < days.day_end
         AND ${hidden.sql}
       GROUP BY days.i ORDER BY days.i`,
    ).all(...params) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      date: boundedDays[Number(row.i)]!.date, captures: Number(row.captures ?? 0), recalls: Number(row.recalls ?? 0),
      recallRequests: Number(row.recall_requests ?? 0), revisions: Number(row.revisions ?? 0),
      initialApprovals: Number(row.initial_approvals ?? 0), preparedInjections: Number(row.prepared ?? 0),
      preparedInjectionEvents: Number(row.prepared_events ?? 0),
    }))
  }

  eventOverviewMetrics(from: number, to: number, excludedAgentPatterns: string[] = []): EventOverviewMetrics {
    this.ensureOpen()
    const hidden = excludedEventSql(excludedAgentPatterns)
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN type IN ('recall_returned','recall_no_result') THEN COALESCE(event_id, 'legacy:' || id) END) AS recall_requests,
         COUNT(DISTINCT CASE WHEN type = 'recall_returned' THEN COALESCE(event_id, 'legacy:' || id) END) AS recall_results,
         COUNT(DISTINCT CASE WHEN type = 'inject_prepared' THEN COALESCE(event_id, 'legacy:' || id) END) AS prepared_events,
         COALESCE(SUM(CASE WHEN type = 'inject_prepared' THEN count ELSE 0 END), 0) AS prepared_memories,
         COALESCE(SUM(CASE WHEN type = 'inject_prepared' THEN tokens ELSE 0 END), 0) AS prepared_tokens
       FROM memory_events e WHERE project_key = ? AND COALESCE(occurred_at, created_at) >= ? AND COALESCE(occurred_at, created_at) < ? AND ${hidden.sql}`,
    ).get(projectKeyOfFile(this.file), from, to, ...hidden.params) as { recall_requests?: number; recall_results?: number; prepared_events?: number; prepared_memories?: number; prepared_tokens?: number }
    return { recallRequests: Number(row?.recall_requests ?? 0), recallResults: Number(row?.recall_results ?? 0),
      preparedInjectionEvents: Number(row?.prepared_events ?? 0), preparedInjectionMemories: Number(row?.prepared_memories ?? 0),
      preparedInjectionTokens: Number(row?.prepared_tokens ?? 0) }
  }

  dashboard(excludedAgentPatterns: string[] = [], hiddenMemoryIds: ReadonlySet<string> = new Set(), omitOverriddenMemoryProjections = false): DashboardStats {
    this.ensureOpen()
    const base = this.stats(excludedAgentPatterns, hiddenMemoryIds, new Set(), !omitOverriddenMemoryProjections)
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
      recent: omitOverriddenMemoryProjections ? [] : this.recordsPage({ status: 'approved', limit: 8, excludedAgentPatterns, hiddenMemoryIds, currentOnly: true }).records,
      candidatesList: omitOverriddenMemoryProjections ? [] : this.recordsPage({ status: 'candidate', limit: 50, excludedAgentPatterns, hiddenMemoryIds, currentOnly: true }).records,
      scenes: this.scenes(),
      persona: this.persona(),
      project: { key, name: meta?.name ?? key, cwd: meta?.cwd ?? '' },
    }
  }

  /**
   * Delete L0 raw conversation rows older than `days` days. `days <= 0` deletes
   * nothing (the default retention keeps L0 forever). This is strictly an L0
   * operation: L1 memories, forgotten review records, L2 scenes and L3 personas
   * are never removed here.
   */
  pruneOlderThan(days: number, now = Date.now()): number {
    if (days <= 0) return 0
    this.ensureOpen()
    const cutoff = now - days * 86_400_000
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const projectKey = projectKeyOfFile(this.file)
      const affected = this.db.prepare(`SELECT id FROM extraction_jobs WHERE status IN ('queued','ready','result_ready','dispatching')
        AND EXISTS (SELECT 1 FROM l0_messages l WHERE l.project_key = ? AND l.id IN (
          SELECT value FROM json_each(extraction_jobs.source_ids)) AND l.created_at < ?)`)
        .all(projectKey, cutoff) as Array<{ id?: string }>
      const markPruned = this.db.prepare(`UPDATE extraction_jobs SET status = 'source_pruned', error = 'source_pruned',
        input_snapshot = '[]', response_text = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','ready','result_ready','dispatching')`)
      for (const job of affected) if (typeof job.id === 'string') markPruned.run(now, job.id)
      const result = this.db.prepare('DELETE FROM l0_messages WHERE project_key = ? AND created_at < ?').run(projectKey, cutoff)
      this.invalidateCaches()
      this.db.exec('COMMIT')
      return Number(result.changes ?? 0)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    try {
      this.db.close()
      this.closed = true
      if (this.dashboardOriginRollbackFailure !== undefined) {
        this.dashboardOriginRollbackFailure.cleanupUnknown = false
      }
    } catch (error) {
      if (this.dashboardOriginRollbackFailure !== undefined) {
        if (this.dashboardOriginRollbackFailure.closeError === undefined) {
          this.dashboardOriginRollbackFailure.closeError = error
        }
        this.dashboardOriginRollbackFailure.cleanupUnknown = true
      }
      throw error
    }
  }

  /**
   * Path observation (dev/ino) retained from this connection's open. It is
   * never re-read from the path: a directory entry replaced later can be
   * detected when its lstat() disagrees with this observation. This proves
   * path-observation agreement, not the identity of the SQLite handle itself;
   * an external process/thread can still replace B with A for the open and back
   * to B between the two pre/post-open stats, which this observation cannot
   * exclude.
   */
  dashboardFileIdentity(): { dev: number; ino: number } | undefined {
    const identity = this.databaseFileIdentity
    return identity === undefined ? undefined : Object.freeze({ dev: identity.dev, ino: identity.ino })
  }

  /** Constant-size same-connection probe for bounded dashboard sessions. */
  dashboardReadVersion(): DashboardReadVersionStamp {
    this.ensureOpen()
    const dataVersionRow = this.db.prepare('PRAGMA data_version').get() as Record<string, unknown> | undefined
    const changesRow = this.db.prepare('SELECT total_changes() AS total_changes').get() as Record<string, unknown> | undefined
    const dataVersion = dataVersionRow?.data_version
    const totalChanges = changesRow?.total_changes
    if (typeof dataVersion !== 'number' || !Number.isSafeInteger(dataVersion) || dataVersion < 0 ||
        typeof totalChanges !== 'number' || !Number.isSafeInteger(totalChanges) || totalChanges < 0) {
      throw new Error('project dashboard read version probe returned an unsafe SQLite counter')
    }
    return Object.freeze({ scope: 'project', connectionId: this.dashboardConnectionIdentity, dataVersion, totalChanges })
  }

  /** Explicit overview-only two-statement probe; observations are returned to its owning reader. */
  dashboardOverviewReadVersion(): { stamp: DashboardReadVersionStamp; schemaVersion: number } {
    this.ensureOpen()
    const dataVersionRow = this.db.prepare('PRAGMA data_version').get() as Record<string, unknown> | undefined
    const changesRow = this.db.prepare('SELECT total_changes() AS total_changes, schema_version FROM pragma_schema_version')
      .get() as Record<string, unknown> | undefined
    const dataVersion = dataVersionRow?.data_version
    const totalChanges = changesRow?.total_changes
    const schemaVersion = changesRow?.schema_version
    if (typeof dataVersion !== 'number' || !Number.isSafeInteger(dataVersion) || dataVersion < 0 ||
        typeof totalChanges !== 'number' || !Number.isSafeInteger(totalChanges) || totalChanges < 0 ||
        typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
      throw new Error('project dashboard read version probe returned an unsafe SQLite counter')
    }
    return { stamp: Object.freeze({ scope: 'project', connectionId: this.dashboardConnectionIdentity, dataVersion, totalChanges }), schemaVersion }
  }

  /** Creates a consistent, standalone SQLite snapshot including current WAL contents. */
  backupTo(destination: string): void {
    this.ensureOpen()
    const target = path.resolve(destination)
    mkdirSync(path.dirname(target), { recursive: true })
    const escaped = target.replace(/'/gu, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
  }

  private ensureOpen(): void {
    if (this.dashboardOriginRollbackFailure !== undefined) {
      throw Object.assign(new Error('memory store is poisoned after dashboard origin rollback failure'), {
        rollbackError: this.dashboardOriginRollbackFailure.rollbackError,
        closeError: this.dashboardOriginRollbackFailure.closeError,
        cleanupUnknown: this.dashboardOriginRollbackFailure.cleanupUnknown,
      })
    }
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

/** Observe the path's dev/ino without following a final symlink. */
function databaseFileIdentity(file: string): { dev: number; ino: number } | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) return undefined
    return Object.freeze({ dev: stat.dev, ino: stat.ino })
  } catch { return undefined }
}

/**
 * Retain the post-open path observation only when the path did not visibly
 * change across the SQLite open. A pre-existing file must report the same
 * dev/ino; a newly created writable path is accepted from the post-open stat.
 * This compares two path observations and cannot exclude a replacement that
 * restores the original path between them (external B→A(open)→B).
 */
function verifyDatabaseFileIdentity(
  file: string,
  before: { dev: number; ino: number } | undefined,
): { dev: number; ino: number } | undefined {
  const after = databaseFileIdentity(file)
  if (after === undefined) return undefined
  if (before !== undefined && (before.dev !== after.dev || before.ino !== after.ino)) return undefined
  return after
}

export function openProjectStore(
  root: string,
  projectKey: string,
  project?: { key: string; name: string; cwd: string },
): MemoryStore {
  // Shared validation: the key must be a safe single path segment and the
  // final database path (including any symlink boundary) must stay under
  // `<root>/projects/`.
  const file = projectDbPath(root, projectKey)
  const store = new MemoryStore(file)
  if (project !== undefined) store.setProjectMeta(project)
  return store
}

/** Open one already-existing, current-schema project database without migration or write access. */
export function openProjectStoreReadOnly(root: string, projectKey: string): MemoryStore {
  const projectsRoot = path.resolve(root, 'projects')
  const rootStat = lstatSync(projectsRoot, { throwIfNoEntry: false })
  if (rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('read-only project root is missing or is not a regular directory')
  }
  const file = projectDbPath(root, projectKey)
  const directory = path.dirname(file)
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false })
  const fileStat = lstatSync(file, { throwIfNoEntry: false })
  if (directoryStat === undefined || directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
      fileStat === undefined || fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error('read-only project database is missing or crosses a symlink boundary')
  }
  const relative = path.relative(projectsRoot, path.resolve(file))
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('read-only project database escapes the selected project root')
  }
  return new MemoryStore(file, { readOnly: true })
}

/** SQL global projections use NULL for invalid numbers, never a coerced zero. */
function globalSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined
}
