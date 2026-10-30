/** Bounded, versioned readers for the Settings dashboard. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Dir, type Stats } from 'node:fs'
import path from 'node:path'
import { matchesAgentGlob } from './config.js'
import type { DashboardReadCoverageRow, DashboardReadUsageRow } from './control.js'
import type {
  DashboardReadBinding, DashboardReadCost, DashboardReadFailureStatus, DashboardReadOutcome,
} from './dashboard-read.js'
import { DASHBOARD_DIRECTORY_MEMBER_RESERVE, DASHBOARD_DIRECTORY_VERIFY_RESERVE, dashboardSceneMemberDigest,
  dashboardAggregateDirectOriginProof, isValidDashboardSceneMember, readDashboardManagedPageForAggregate,
  readDashboardRecentManagedPageForAggregate, withDashboardOverviewFusion } from './dashboard-visibility.js'
import type { DashboardDirectoryLabelReader, DashboardDirectoryMemberLabel, DashboardSceneMetaRow,
  DashboardSceneMemberRow, DashboardVisibilityItem, DashboardVisibleMemorySummary, DashboardVisibilityReadSession } from './dashboard-visibility.js'
import type { DashboardReadEventPageRow, DashboardRepeatEventRow, DashboardRepeatMemberRow, DashboardVisibilityMemoryCursor, MemoryRecord } from './store.js'
import { isValidProjectKey } from './project-key.js'
import { ReadDashboardRequestSchema, type ReadDashboardPage, type ReadDashboardRequest,
  type ReadDashboardResult, type ReadDashboardSettings } from './remote-contract.js'

const MAX_PROJECTS = 4
const PROJECT_CHOICES = 15
const MAX_RAW_DIRECTORY_ENTRIES = 256
const DIRECTORY_RAW_ENTRY_BYTES = 256
const DIRECTORY_READ_BATCH = PROJECT_CHOICES + 1
const DIRECTORY_FINAL_PROOF_SQL = 2
const DIRECTORY_FINAL_PROOF_ROWS = 4
const DIRECTORY_FINAL_PROOF_KEY_BYTES = 256
const DIRECTORY_FINAL_PROOF_MATERIALIZED_BYTES = 1_024
/** Fixed key/name projection bound reused from the bounded store projection. */
const DIRECTORY_LABEL_NAME_BYTES = 256
const MAX_RANGE_DAYS = 400
const MAX_RESPONSE_BYTES = 256 * 1024
const READ_STATE_BYTES = 512 * 1024
/** Usage pages own both their paid SQL projection and a separately prepaid resumable copy.
 * 4096 bytes/row covers the bounded identity strings, numeric fields and row metadata.
 * At most two retained pages exist. Groups are allocated lazily, never before their leases. */
const USAGE_ROW_BYTES = 4096
const MODEL_USAGE_GROUP_BYTES = 4096
const PURPOSE_USAGE_GROUP_BYTES = 2048
/** Within the existing 256 KiB response lease: ten model rows <=80 KiB and ten purpose rows <=40 KiB.
 * The unchanged final encoded-size gate applies to the complete response, including all other panels. */
const USAGE_VISIBLE_IDENTITIES = 9
/** Accounted resident bound for one parsed persona: 100 IDs (256 code units) + revision map + 64KiB UTF-8 body materialized as JS strings, with fixed overhead; a conservative charge, not a measured V8 heap bound. */
const PERSONA_STATE_BYTES = 384 * 1024
/** Bounded aggregate-owned scene page/proof state; capacity is derived below, not a schema ceiling. */
const SCENE_STATE_BYTES = 256 * 1024
const SCENE_PAGE_SIZE = 6
const SCENE_MEMBER_PAGE = 15
const SCENE_PROOFS_PER_CALL = 8
const SCENE_MEMBER_STATE_BYTES = 1_024
/** Derived from the reserved scene state after fixed page/current overhead, not a schema ceiling. */
const SCENE_MEMBER_CAPACITY = Math.floor((SCENE_STATE_BYTES - 4_096) / SCENE_MEMBER_STATE_BYTES)
const MAX_EVENT_LINKS = 4
const MAX_IDENTITIES = 256
/** Bounds visible session rows and zero-event uncertainty markers in the existing read-state lease. */
const MAX_SESSION_KEYS = 256
/** Per-session dedup caps keep the bounded session aggregate inside the fixed read-state lease. */
const MAX_SESSION_LINKED_L0 = 32
const MAX_SESSION_IDENTITIES = 32
const MAX_FINGERPRINTS = 256
const MAX_COVERAGE_WINDOWS = 128
const DETAIL_BODY_BYTES = 32 * 1024
const MEMORY_PAGE_SIZE = 3
const EVENT_PAGE_SIZE = 15
/** Bounds zero-cost in-memory scheduler work within one overview RPC. */
const OVERVIEW_TASK_STEPS_PER_RPC = 64
const EVENT_PAGE_ROW_BYTES = 24_000
const KNOWN_NON_ACTIVITY_EVENT_TYPES = new Set([
  'extract', 'provider_usage', 'persona', 'skipped_nonmemory', 'revision_candidate',
  'revision_rejected', 'relation', 'experience_review', 'approve', 'forget',
])
/** Bounded repeated-capture reading: three-level SQL seeks plus per-event proof. */
const REPEAT_PAGE_SIZE = 10
const REPEAT_MAX_PAGE = 15
const REPEAT_BATCH = 15
/** Raw-row envelopes derived from the bounded Store projections below. */
const REPEAT_FINGERPRINT_ROW_BYTES = 640
const REPEAT_MEMBER_ROW_BYTES = 512
const REPEAT_EVENT_ROW_BYTES = 8_192
/** Bounded sqlite_master `sql` projection (2 KiB text) used to verify the association index per page. */
const REPEAT_INDEX_METADATA_BYTES = 2_176
const REPEAT_EXCERPT_ROW_BYTES = 1_024
/** Complete group vector capacity inside the accounted read-state lease. */
/** Conservative JS-string/Set overhead for one project+fingerprint group entry. */
const REPEAT_GROUP_ENTRY_BYTES = 2_048
const REPEAT_VECTOR_BYTES = 256 * 1024
const REPEAT_GROUP_CAPACITY = Math.floor(REPEAT_VECTOR_BYTES / REPEAT_GROUP_ENTRY_BYTES)
const MAX_REPEAT_IDENTITIES = 1_024
const REPEAT_SCAN_ITERATIONS = 65_536
/** Conservative per-operation envelopes used for the pre-publication reserve. */
const REPEAT_FINGERPRINT_COST: Readonly<DashboardReadCost> = Object.freeze({
  sqlStatements: 1, rowsVisited: 1, materializedBytes: REPEAT_FINGERPRINT_ROW_BYTES, keyBytes: 1_024,
})
const REPEAT_MEMBER_COST: Readonly<DashboardReadCost> = Object.freeze({
  sqlStatements: 1, rowsVisited: REPEAT_BATCH + 1, materializedBytes: (REPEAT_BATCH + 1) * REPEAT_MEMBER_ROW_BYTES, keyBytes: 1_024,
})
const REPEAT_EVENT_COST: Readonly<DashboardReadCost> = Object.freeze({
  sqlStatements: 2, rowsVisited: REPEAT_BATCH + 2,
  materializedBytes: (REPEAT_BATCH + 1) * REPEAT_EVENT_ROW_BYTES + REPEAT_INDEX_METADATA_BYTES, keyBytes: 1_024,
})
/** Fixed safety margin for the fully derived per-event proof envelope. */
const REPEAT_PROOF_MARGIN_SQL = 1
const REPEAT_PROOF_MARGIN_ROWS = 1
const REPEAT_PROOF_MARGIN_BYTES = 512
const REPEAT_PROOF_MARGIN_KEY_BYTES = 512
const REPEAT_EXCERPT_COST: Readonly<DashboardReadCost> = Object.freeze({
  sqlStatements: 1, rowsVisited: 1, materializedBytes: REPEAT_EXCERPT_ROW_BYTES, keyBytes: 1_024,
})
/** Upper bound for one raw processing row: id 256 + status 64 + preset 512 + error 240, session 512, numeric fields and object overhead. */
const PROCESSING_ROW_BYTES = 2_560
/** Upper bound for one raw ownership source row (source id + session id + object overhead). */
const PROCESSING_SOURCE_ROW_BYTES = 1_024
/** One queued job retained across RPCs is charged as bounded pending residency. */
const PROCESSING_PENDING_BYTES = 512
const MAX_PROCESSING_PENDING = 64
const USAGE_PAGE_SIZE = 15
const DASHBOARD_IDLE_MS = 15_000
const DASHBOARD_ABSOLUTE_MS = 60_000
const DIRECTORY_IDLE_MS = 15_000
const DIRECTORY_HANDLE_BYTES = 1_024
const DIMENSION_GROUPS = ['sources', 'agents', 'agentPresets', 'providers', 'models', 'sessions', 'fingerprints'] as const
type DimensionGroup = typeof DIMENSION_GROUPS[number]
type ActivityDimensionGroup = Exclude<DimensionGroup, 'sessions' | 'fingerprints'>
type Metric = { value: number | null; relation: 'exact' | 'lower_bound' | 'unknown'; reason?: string }
type DashboardView = ReadDashboardResult['view']
type DashboardStatus = ReadDashboardResult['status']
type DashboardEventDto = NonNullable<ReadDashboardResult['events']>[number]
type DashboardSceneDto = NonNullable<ReadDashboardResult['scene']>
type DashboardSceneItemDto = DashboardSceneDto['items'][number]
type ActivityKind = 'capture' | 'recall' | 'revision' | 'initial_approval' | 'injection'
type RangeSpec = { from: string; to: string; timeZone: string; activity: ActivityKind; dates: string[]; dateSet: Set<string>
  formatter: LocalDateFormatter; bounds: Map<string, { start: number; end: number }> }
type LocalDateFormatter = Intl.DateTimeFormat

interface DashboardAggregateOptions {
  openReader(binding: DashboardReadBinding, onEnd: (status: DashboardReadFailureStatus, reason: string) => void):
    DashboardReadOutcome<DashboardVisibilityReadSession>
  projectDirectory(): string
  stateRoot(): string
  generationId(): string
  policyRevision(): string
  excludedAgentPatterns(): readonly string[]
  settings(): ReadDashboardSettings
  activeProjectKey(): string | undefined
  lastError(): string | undefined
}

interface DimensionCounter { values: Map<string, number>; other: number; overflow: boolean }
interface DayCounter { captures: number; recalls: number; revisions: number; initialApprovals: number; injections: number }
interface FieldTotal { sum: number; seen: number; missing: number; uncertain: number }
interface UsageFields {
  inputTokens: FieldTotal; outputTokens: FieldTotal; cacheReadTokens: FieldTotal; cacheWriteTokens: FieldTotal
  reasoningTokens: FieldTotal; costMicros: FieldTotal
}
interface ModelUsageGroup extends UsageFields {
  key: string; provider: string | null; model: string | null; other: boolean
  calls: number; knownCalls: number; unknownCalls: number; unknownIdentityCalls: number
}
interface PurposeUsageGroup {
  key: string; purpose: string | null; other: boolean; calls: number
  knownCalls: number; unknownCalls: number; unknownIdentityCalls: number; actualTokens: FieldTotal
}
interface UsagePendingPage {
  rows: DashboardReadUsageRow[]; index: number; hasMore: boolean; reservationToken: string
}
interface UsageTotals {
  attempts: number; knownAttempts: number; unknownAttempts: number
  inputTokens: FieldTotal; outputTokens: FieldTotal; cacheReadTokens: FieldTotal; cacheWriteTokens: FieldTotal
  reasoningTokens: FieldTotal; costMicros: FieldTotal
  attemptProviders: DimensionCounter
  modelGroups?: ModelUsageGroup[]; modelOther?: ModelUsageGroup; unknownModelCalls: number
  billableCalls: number; billableTokens: FieldTotal
  purposeGroups?: PurposeUsageGroup[]; purposeOther?: PurposeUsageGroup; unknownPurposeCalls: number
  preparedInjectionTokensEstimate: number
}
interface MemoryScan { after?: DashboardVisibilityMemoryCursor; done: boolean; count: number; incomplete: boolean }
interface ProjectScan {
  key: string; name: string; eventAfter: number; eventDone: boolean
  eventPage?: { rows: DashboardReadEventPageRow[]; hasMore: boolean; reservationToken: string }
  approved: MemoryScan; candidate: MemoryScan; forgotten: MemoryScan
}

interface CoverageWindowState {
  id: number; startedAt: number; endedAt: number | null; status: 'active' | 'closed' | 'interrupted'; policyRevision: string
}
interface OverviewSessionAgg {
  projectKey: string
  projectName: string
  sessionId: string
  events: number
  linkedL0: Set<string>
  identities: Set<string>
  unknownIdentityEvents: number
  linkedTruncated: boolean
  identityTruncated: boolean
  projectionIncomplete: boolean
}
interface OverviewState {
  counts: {
    captures: number; recallRequests: number; recallResults: number; acceptedRevisions: number; initialApprovals: number
    preparedInjectionEvents: number; preparedInjectionMemories: number; unknownSessionEvents: number
    unknownAgentEvents: number; unknownAgentPresetEvents: number; unknownOriginalMessageEvents: number
  }
  dimensions: Record<DimensionGroup, DimensionCounter>
  // Six bounded counters (nine keys plus overflow each), populated in the existing verified event pass.
  captureSources: DimensionCounter
  selectedDimensions: Record<ActivityDimensionGroup, DimensionCounter>
  days: Map<string, DayCounter>
  sessions: Set<string>
  sessionCounts: Map<string, number>
  sessionAgg: Map<string, OverviewSessionAgg>
  sessionScannedEvents: number
  sessionTruncated: boolean
  sessionIncomplete: boolean
  sessionCaptureIncomplete: boolean
  sessionUnknownSessionEvents: number
  sessionUnknownIdentityEvents: number
  identityDigests: Set<string>
  fingerprintCounts: Map<string, number>
  repeatedTotal: number
  current: { effectiveMemories: number; candidates: number }
  currentIncomplete: { approved: boolean; candidate: boolean }
  attemptsAfter: string; attemptsDone: boolean; attemptsIncomplete: boolean
  billableAfter: string; billableDone: boolean; billableIncomplete: boolean
  attemptPage?: UsagePendingPage; billablePage?: UsagePendingPage
  coverageAfter: number; coverageDone: boolean; coverageTruncated: boolean
  windows: CoverageWindowState[]
  usage: UsageTotals
  incomplete: boolean
  taskOffset: number
}
interface LibraryQuery { projectKey: string; statuses: Array<'candidate' | 'approved' | 'forgotten'>; statusIndex: number;
  query: string | undefined; limit: number; after?: DashboardVisibilityMemoryCursor; hasMore: boolean }
interface EventQuery { projectKey: string; dimension: 'date' | 'source' | 'agent' | 'agentPreset' | 'provider' | 'model' | 'fingerprint'; value: string; afterId: number; hasMore: boolean }
type DashboardPageMemory = NonNullable<ReadDashboardPage['candidates']>[number]
interface OverviewPageState { projectIndex: number; candidates: DashboardPageMemory[]; recent: DashboardPageMemory[];
  candidateAfter?: DashboardVisibilityMemoryCursor; recentAfter?: { updatedAt: number; id: string };
  candidateDone: boolean; recentDone: boolean; candidateCount: number; recentCount: number;
  done: boolean; incomplete: boolean }
interface ProcessingPendingJob { id: string; sessionId: string; createdAt: number; afterSourceId?: string }
interface ProcessingScanState { projectKey?: string; after?: { id: string }; summaryDone: boolean; done: boolean;
  pending: ProcessingPendingJob[]; queued: number; failed: number; uncertainUsage: number; oldestWaitingAt: number | null;
  incomplete: boolean; taskOffset: number }
interface PersonaProofState {
  projectKey: string
  sourceIds: string[]
  sourceRevisions: Record<string, number>
  sourceCount: number
  updatedAt: number
  contentBytes: number
  nextIndex: number
  done: boolean
  noProgressIndex?: number
  noProgressCount: number
  result?: { state: 'visible' | 'unresolved' | 'hidden'; reason?: string; content?: string; stale?: boolean }
}

interface SceneProofCurrent {
  row: DashboardSceneMetaRow
  name: string
  members: DashboardSceneMemberRow[]
  nextMember: number
  afterOrdinal?: number
  memberHasMore: boolean
  phase: 'members' | 'final'
}
interface SceneQuery {
  projectKey: string
  projectName: string
  started: boolean
  after?: { memoryCount: number; name: string }
  rows: DashboardSceneMetaRow[]
  rowIndex: number
  pageHasMore: boolean
  items: DashboardSceneItemDto[]
  current?: SceneProofCurrent
  done: boolean
  unresolvedSeen: boolean
  hiddenSeen: boolean
  blockedReason?: string
  noProgressKey?: string
  noProgressCount: number
}
type DashboardRepeatedDto = NonNullable<ReadDashboardResult['repeated']>
type DashboardRepeatedGroupDto = NonNullable<DashboardRepeatedDto['groups']>[number]
type DashboardRepeatedEventDto = NonNullable<DashboardRepeatedDto['events']>[number]
type RepeatFilters = { agentId?: string; agentPreset?: string; source?: string }
interface RepeatRankCursor { repeatCount: number; fingerprint: string; projectKey: string }
interface RepeatGroupEntry { projectKey: string; fingerprint: string; repeatCount: number; eventCount: number }
interface RepeatMemberCursor { createdAt: number; rowid: number }
interface RepeatEventCursor { createdAt: number; id: number }
/**
 * One project's bounded level-1/2/3 cursors for the repeated-capture scan.
 * `afterFingerprint` advances only when a group closes; a paused group keeps
 * its member and event seeks so unfinished work is re-entered, never skipped.
 */
interface RepeatGroupScan {
  projectKey: string
  afterFingerprint?: string
  currentFingerprint?: string
  fingerprintDone: boolean
  memberAfter?: RepeatMemberCursor
  membersDone: boolean
  memberPending: DashboardRepeatMemberRow[]
  memberHasMore: boolean
  currentMember?: {
    row: DashboardRepeatMemberRow
    memberId: string
    eventAfter?: RepeatEventCursor
    eventDone: boolean
    eventPending: DashboardRepeatEventRow[]
    eventHasMore: boolean
  }
  identities: Set<string>
}
interface RepeatGroupsState {
  target: 'groups'
  requestKey: string
  projectKeys: string[]
  filters: RepeatFilters
  scans: RepeatGroupScan[]
  groups: RepeatGroupEntry[]
  scanDone: boolean
  incomplete: boolean
  incompleteReason?: string
  scannedGroups: number
  scannedEvents: number
  pageStart: number
  pageLimit: number
}
interface RepeatEventPendingRow {
  row: DashboardRepeatEventRow
  proven: boolean
  excerptDone: boolean
  excerpt?: string
  excerptTruncated?: boolean
}
interface RepeatEventsState {
  target: 'events'
  requestKey: string
  projectKey: string
  fingerprint: string
  filters: RepeatFilters
  includeExcerpt: boolean
  pageLimit: number
  memberAfter?: RepeatMemberCursor
  membersDone: boolean
  memberPending: DashboardRepeatMemberRow[]
  memberHasMore: boolean
  currentMember?: {
    row: DashboardRepeatMemberRow
    memberId: string
    eventAfter?: RepeatEventCursor
    eventDone: boolean
    eventPending: RepeatEventPendingRow[]
    eventHasMore: boolean
  }
  events: DashboardRepeatedEventDto[]
  moreWork: boolean
  scanDone: boolean
  incomplete: boolean
  incompleteReason?: string
  scannedMembers: number
  scannedEvents: number
}
type RepeatStep = { status: 'done' } | { status: 'paused' } | { status: 'fatal'; outcome: DashboardReadFailure }
type RepeatEventScanResult = { status: 'ok' } | { status: 'paused' } |
  { status: 'fatal'; outcome: DashboardReadFailure } | { status: 'incomplete'; reason: string }
interface ReadState {
  id: string; binding: DashboardReadBinding; range: RangeSpec; projects: ProjectScan[]; projectByKey: Map<string, ProjectScan>
  reader: DashboardVisibilityReadSession; excludedAgentPatterns: readonly string[]; generatedAt: number
  lastActivityAt: number; overview: OverviewState; view: DashboardView; awaitingFirstAction: boolean; exposedCursor?: string; focusProjectKey?: string; personaState?: PersonaProofState; personaLease?: string; sceneState?: SceneQuery; sceneLease?: string
  outputReservation?: string; library?: LibraryQuery; eventQuery?: EventQuery; explicitClose: boolean
  repeatGroups?: RepeatGroupsState; repeatEvents?: RepeatEventsState; repeatTarget?: 'groups' | 'events'
  page: OverviewPageState; processingScan: ProcessingScanState; globalPersonaState?: {
    done: boolean; state: 'visible' | 'unresolved' | 'hidden' | 'scope_limit'; reason?: string; content?: string; sourceCount: number;
    updatedAt: number; stale: boolean
  }
}
interface TerminalState { status: DashboardStatus; reason: string }
interface ProjectMemberIdentity {
  folderDev: number; folderIno: number; databaseDev: number; databaseIno: number; realFolder: string
}
interface DirectoryReadState {
  id: string; directory: string; realDirectory: string; marker: string; binding: DashboardReadBinding
  dir?: Dir; cursor?: string; pendingKey?: string
  reader: DashboardVisibilityReadSession; labels: DashboardDirectoryLabelReader
  memberIdentities: Map<string, ProjectMemberIdentity>
  outputReservation?: string
  createdAt: number; lastActivityAt: number; complete: boolean; explicitClose: boolean
}
interface RawProjectDirectoryPage { keys: string[]; hasMore: boolean; readable: boolean; rawEntries: number }
interface ProjectDirectoryPage {
  keys: string[]; labels: DashboardDirectoryMemberLabel[]
  hasMore: boolean; readable: boolean; rawEntries: number
}
type DashboardReadFailure = Exclude<DashboardReadOutcome<unknown>, { status: 'ok' }>
type OverviewStep = { status: 'ok' | 'budget_exhausted' } | { status: 'fatal'; outcome: DashboardReadFailure }
type SceneStep = { status: 'ok' | 'pause' } | { status: 'fatal'; outcome: DashboardReadFailure }

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function safeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) }
function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function textBytes(value: unknown): number { return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0 }
function emptyDimension(): DimensionCounter { return { values: new Map(), other: 0, overflow: false } }
function emptyField(): FieldTotal { return { sum: 0, seen: 0, missing: 0, uncertain: 0 } }
function emptyUsage(): UsageTotals {
  return { attempts: 0, knownAttempts: 0, unknownAttempts: 0,
    inputTokens: emptyField(), outputTokens: emptyField(), cacheReadTokens: emptyField(), cacheWriteTokens: emptyField(),
    reasoningTokens: emptyField(), costMicros: emptyField(), attemptProviders: emptyDimension(), unknownModelCalls: 0,
    billableCalls: 0, billableTokens: emptyField(), unknownPurposeCalls: 0, preparedInjectionTokensEstimate: 0 }
}
function emptyOverview(range: RangeSpec): OverviewState {
  return {
    counts: { captures: 0, recallRequests: 0, recallResults: 0, acceptedRevisions: 0, initialApprovals: 0,
      preparedInjectionEvents: 0, preparedInjectionMemories: 0, unknownSessionEvents: 0,
      unknownAgentEvents: 0, unknownAgentPresetEvents: 0, unknownOriginalMessageEvents: 0 },
    dimensions: { sources: emptyDimension(), agents: emptyDimension(), agentPresets: emptyDimension(), providers: emptyDimension(),
      models: emptyDimension(), sessions: emptyDimension(), fingerprints: emptyDimension() },
    captureSources: emptyDimension(),
    selectedDimensions: { sources: emptyDimension(), agents: emptyDimension(), agentPresets: emptyDimension(),
      providers: emptyDimension(), models: emptyDimension() },
    days: new Map(range.dates.map((date) => [date, { captures: 0, recalls: 0, revisions: 0, initialApprovals: 0, injections: 0 }])),
    sessions: new Set(), sessionCounts: new Map(), sessionAgg: new Map(), sessionScannedEvents: 0, sessionTruncated: false,
    sessionIncomplete: false, sessionCaptureIncomplete: false, sessionUnknownSessionEvents: 0, sessionUnknownIdentityEvents: 0,
    identityDigests: new Set(), fingerprintCounts: new Map(), repeatedTotal: 0,
    current: { effectiveMemories: 0, candidates: 0 }, currentIncomplete: { approved: false, candidate: false },
    attemptsAfter: '', attemptsDone: false, attemptsIncomplete: false,
    billableAfter: '', billableDone: false, billableIncomplete: false,
    coverageAfter: 0, coverageDone: false, coverageTruncated: false, windows: [], usage: emptyUsage(), incomplete: false, taskOffset: 0,
  }
}

function response(view: DashboardView, status: DashboardStatus, complete: boolean,
  extra: Partial<ReadDashboardResult> = {}): ReadDashboardResult {
  return { version: 1, view, status, generatedAt: Date.now(), complete, ...extra } as ReadDashboardResult
}

function failureStatus(status: DashboardReadFailureStatus): DashboardStatus {
  if (status === 'expired' || status === 'evicted') return status
  if (status === 'budget-exhausted') return 'budget_exhausted'
  if (status === 'unavailable-probe') return 'unavailable'
  return 'stale'
}

function failureReason(reason: string): string { return reason.slice(0, 160) }

function makeMetric(value: number, complete: boolean, reason = 'checked_subset'): Metric {
  return { value, relation: complete ? 'exact' : 'lower_bound', ...(complete ? {} : { reason }) }
}

function unknownMetric(reason: string): Metric { return { value: null, relation: 'unknown', reason } }

function addDimension(counter: DimensionCounter, key: string, amount = 1): void {
  const existing = counter.values.get(key)
  if (existing !== undefined) { counter.values.set(key, existing + amount); return }
  if (counter.values.size < 9) { counter.values.set(key, amount); return }
  counter.other += amount
  counter.overflow = true
}

function dimensionArray(counter: DimensionCounter, complete: boolean): Array<{ key: string; count: Metric }> {
  const values = [...counter.values].map(([key, value]) => ({ key, count: makeMetric(value, complete, 'checked_subset') }))
  if (counter.other > 0 || counter.overflow) values.push({ key: 'other', count: makeMetric(counter.other, complete, 'dimension_limit') })
  return values.slice(0, 10)
}

function dateValue(date: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
  if (!match) return undefined
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
    ? { year, month, day } : undefined
}

function addUtcDays(date: string, days: number): string {
  const value = dateValue(date)!
  return new Date(Date.UTC(value.year, value.month - 1, value.day + days)).toISOString().slice(0, 10)
}

function parseRange(input: NonNullable<Extract<ReadDashboardRequest, { action: 'bootstrap' }>['range']>): RangeSpec | undefined {
  const from = dateValue(input.from); const to = dateValue(input.to)
  if (from === undefined || to === undefined) return undefined
  const fromEpoch = Date.UTC(from.year, from.month - 1, from.day)
  const toEpoch = Date.UTC(to.year, to.month - 1, to.day)
  const dayCount = Math.floor((toEpoch - fromEpoch) / 86_400_000) + 1
  if (dayCount < 1 || dayCount > MAX_RANGE_DAYS) return undefined
  let formatter: LocalDateFormatter
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) }
  catch { return undefined }
  let boundaryFormatter: Intl.DateTimeFormat
  try { boundaryFormatter = new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) }
  catch { return undefined }
  const dates = Array.from({ length: dayCount }, (_unused, index) => addUtcDays(input.from, index))
  const bounds = new Map<string, { start: number; end: number }>()
  for (const date of dates) {
    const start = localMidnight(date, input.timeZone, boundaryFormatter)
    const end = localMidnight(addUtcDays(date, 1), input.timeZone, boundaryFormatter)
    if (start === undefined || end === undefined || end <= start) return undefined
    bounds.set(date, { start, end })
  }
  return { from: input.from, to: input.to, timeZone: input.timeZone, activity: input.activity, dates,
    dateSet: new Set(dates), formatter, bounds }
}

function localDate(timestamp: number, formatter: LocalDateFormatter): string | undefined {
  if (!safeInteger(timestamp) || timestamp < 0) return undefined
  try {
    const parts = formatter.formatToParts(timestamp)
    const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])) as
      Record<string, string | undefined>
    if (value.year === undefined || value.month === undefined || value.day === undefined) return undefined
    return `${value.year.padStart(4, '0')}-${value.month.padStart(2, '0')}-${value.day.padStart(2, '0')}`
  } catch { return undefined }
}

function localMidnight(date: string, timeZone: string, suppliedFormatter?: Intl.DateTimeFormat): number | undefined {
  const parsed = dateValue(date)
  if (parsed === undefined) return undefined
  let formatter = suppliedFormatter
  if (formatter === undefined) {
    try { formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) }
    catch { return undefined }
  }
  const target = Date.UTC(parsed.year, parsed.month - 1, parsed.day)
  let guess = target
  for (let pass = 0; pass < 4; pass += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])) as Record<string, number>
    if (![parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].every(Number.isFinite)) return undefined
    const observed = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
    const delta = target - observed
    guess += delta
    if (delta === 0) break
  }
  return Number.isSafeInteger(guess) ? guess : undefined
}

function projectionValue(value: string | undefined, bytes: number, maxBytes: number): string | undefined {
  if (!safeInteger(bytes) || bytes < 0 || bytes > maxBytes || value !== undefined && textBytes(value) !== bytes ||
      value === undefined && bytes !== 0) return undefined
  return value
}

function projectDirectoryMarker(directory: string): { marker?: string; readable: boolean; missing: boolean } {
  const rootStat = lstatSync(directory, { throwIfNoEntry: false })
  if (rootStat === undefined) return { readable: true, missing: true }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { readable: false, missing: false }
  return { marker: `${rootStat.dev}:${rootStat.ino}:${rootStat.mtimeMs}:${rootStat.ctimeMs}`, readable: true, missing: false }
}

function validProjectDirectoryEntry(directory: string, name: string, isDirectory: boolean): boolean {
  if (!isDirectory || !isValidProjectKey(name) || textBytes(name) > 256) return false
  const folder = path.join(directory, name)
  const folderStat = lstatSync(folder, { throwIfNoEntry: false })
  if (folderStat === undefined || folderStat.isSymbolicLink() || !folderStat.isDirectory()) return false
  const databaseStat = lstatSync(path.join(folder, 'memory.db'), { throwIfNoEntry: false })
  return databaseStat !== undefined && !databaseStat.isSymbolicLink() && databaseStat.isFile()
}

/**
 * Filesystem identity of one enumerated project member. The real folder path
 * keeps a symlinked parent from aliasing another project, while dev/ino pair
 * binds the exact directory and database inode observed when the label was
 * read. The aggregate rechecks this pair immediately before publication.
 */
function projectMemberIdentity(directory: string, realDirectory: string, key: string): ProjectMemberIdentity | undefined {
  try {
    const folder = path.join(directory, key)
    const folderStat = lstatSync(folder, { throwIfNoEntry: false })
    if (folderStat === undefined || folderStat.isSymbolicLink() || !folderStat.isDirectory()) return undefined
    const databaseStat = lstatSync(path.join(folder, 'memory.db'), { throwIfNoEntry: false })
    if (databaseStat === undefined || databaseStat.isSymbolicLink() || !databaseStat.isFile()) return undefined
    const realFolder = realpathSync(folder)
    if (realFolder !== path.join(realDirectory, key)) return undefined
    return { folderDev: folderStat.dev, folderIno: folderStat.ino,
      databaseDev: databaseStat.dev, databaseIno: databaseStat.ino, realFolder }
  } catch { return undefined }
}

function sameProjectMemberIdentity(left: ProjectMemberIdentity, right: ProjectMemberIdentity): boolean {
  return left.folderDev === right.folderDev && left.folderIno === right.folderIno &&
    left.databaseDev === right.databaseDev && left.databaseIno === right.databaseIno &&
    left.realFolder === right.realFolder
}

function safeDimension(value: string | undefined, bytes: number, maxBytes: number): string {
  const checked = projectionValue(value, bytes, maxBytes)
  return checked === undefined || checked.length === 0 ? 'unknown' : checked
}

function activityTypes(activity: ActivityKind): ReadonlySet<string> {
  switch (activity) {
    case 'capture': return new Set(['capture'])
    case 'recall': return new Set(['recall_returned', 'recall_no_result'])
    case 'revision': return new Set(['revision'])
    case 'initial_approval': return new Set(['initial_approval'])
    case 'injection': return new Set(['inject_prepared'])
  }
}

function emptyMemoryScan(): MemoryScan { return { done: false, count: 0, incomplete: false } }
function emptyOverviewPage(): OverviewPageState { return { projectIndex: 0, candidates: [], recent: [],
  candidateDone: false, recentDone: false, candidateCount: 0, recentCount: 0, done: false, incomplete: false } }
function emptyProcessingScan(): ProcessingScanState { return { summaryDone: false, done: false, pending: [], queued: 0, failed: 0,
  uncertainUsage: 0, oldestWaitingAt: null, incomplete: false, taskOffset: 0 } }

function compareRepeatGroups(left: RepeatGroupEntry, right: RepeatGroupEntry): number {
  if (left.repeatCount !== right.repeatCount) return right.repeatCount - left.repeatCount
  if (left.fingerprint !== right.fingerprint) return left.fingerprint < right.fingerprint ? -1 : 1
  if (left.projectKey !== right.projectKey) return left.projectKey < right.projectKey ? -1 : 1
  return 0
}

/** Stable per-action view label used by closed/error responses. */
function actionView(action: ReadDashboardRequest['action']): DashboardView {
  switch (action) {
    case 'global': return 'global'
    case 'bootstrap': return 'bootstrap'
    case 'settings': return 'settings'
    case 'persona': return 'persona'
    case 'globalPersona': return 'globalPersona'
    case 'scene': return 'scene'
    case 'library': return 'library'
    case 'detail': return 'detail'
    case 'repeated': return 'repeated'
    case 'close': return 'control'
    case 'overview':
    case 'continue': return 'overview'
  }
}

export class DashboardAggregateService {
  private readonly options: DashboardAggregateOptions
  private readonly states = new Map<string, ReadState>()
  private readonly directoryStates = new Map<string, DirectoryReadState>()
  private readonly terminals = new Map<string, TerminalState>()
  private sweepTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(options: DashboardAggregateOptions) { this.options = options }

  read(input: ReadDashboardRequest): ReadDashboardResult {
    let request: ReadDashboardRequest
    try { request = ReadDashboardRequestSchema.parse(input) }
    catch { return response('bootstrap', 'unavailable', false, { reason: 'request-invalid' }) }
    if (this.closed) return response(actionView(request.action), 'unavailable', false, { reason: 'dashboard-reader-closed' })
    try {
      switch (request.action) {
        case 'global': return response('global', 'unavailable', false, { reason: 'global-reader-required' })
        case 'bootstrap': return this.bootstrap(request)
        case 'overview': return this.beginOverview(request.readId, request.focusProjectKey)
        case 'settings': return this.beginSettings(request.readId)
        case 'persona': return this.beginPersona(request.readId, request.projectKey)
        case 'globalPersona': return this.beginGlobalPersona(request.readId)
        case 'scene': return this.beginScene(request.readId, request.projectKey)
        case 'library': return this.beginLibrary(request)
        case 'detail': return this.beginDetail(request)
        case 'repeated': return this.beginRepeated(request)
        case 'continue': return this.continueRead(request.readId, request.cursor)
        case 'close': return this.closeRead(request.readId)
      }
    } catch {
      const readId = request.action === 'global' ? undefined : request.action === 'bootstrap'
        ? (typeof request.readId === 'string' ? request.readId : undefined)
        : request.readId
      const state = readId === undefined ? undefined : this.states.get(readId)
      if (state !== undefined) this.dropState(state, 'unavailable-probe', 'dashboard-read-failed')
      const directoryState = readId === undefined ? undefined : this.directoryStates.get(readId)
      if (directoryState !== undefined) this.dropDirectoryState(directoryState, 'unavailable', 'project-directory-read-failed')
      return response(readId === undefined ? 'bootstrap' : state?.view ?? (directoryState === undefined ? 'overview' : 'bootstrap'),
        'unavailable', false,
        { ...(readId === undefined ? {} : { readId }), reason: 'dashboard-read-failed' })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer)
    this.sweepTimer = undefined
    for (const state of [...this.states.values()]) this.dropState(state, 'stale', 'dashboard-reader-closed')
    for (const state of [...this.directoryStates.values()]) this.dropDirectoryState(state, 'stale', 'dashboard-reader-closed')
    this.states.clear()
    this.directoryStates.clear()
    this.terminals.clear()
  }

  private bootstrap(request: Extract<ReadDashboardRequest, { action: 'bootstrap' }>): ReadDashboardResult {
    const selected = [...new Set(request.projectKeys ?? [])]
    let directoryState: DirectoryReadState | undefined
    if (request.readId !== undefined) {
      directoryState = this.directoryStates.get(request.readId)
      if (directoryState === undefined) return this.terminalOrStale(request.readId, 'bootstrap')
      const checked = this.checkDirectoryState(directoryState)
      if (checked !== undefined) return checked
      if (selected.length === 0) return response('bootstrap', 'selection_required', directoryState.complete, {
        readId: directoryState.id, reason: directoryState.cursor === undefined ? 'project-selection-required' : 'project-list-continuation-required',
      })
    } else if (selected.length === 0) {
      return this.beginProjectSelection()
    }
    if (selected.length > MAX_PROJECTS) return response('bootstrap', 'scope_limit', false, {
      ...(directoryState === undefined ? {} : { readId: directoryState.id }), reason: 'project-selection-limit',
    })
    const projectDirectory = directoryState?.directory ?? this.options.projectDirectory()
    let projectSnapshot: ReturnType<typeof projectDirectoryMarker>
    try { projectSnapshot = projectDirectoryMarker(projectDirectory) } catch {
      return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    }
    if (!projectSnapshot.readable) return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    if (directoryState !== undefined && projectSnapshot.marker !== directoryState.marker) {
      return this.dropDirectoryState(directoryState, 'stale', 'project-directory-changed')
    }
    for (const key of selected) {
      if (!validProjectDirectoryEntry(projectDirectory, key, true)) return response('bootstrap', 'scope_limit', false, {
        ...(directoryState === undefined ? {} : { readId: directoryState.id }), reason: 'project-not-available',
      })
    }
    if (request.range === undefined) return response('bootstrap', 'selection_required', false, {
      ...(directoryState === undefined ? {} : { readId: directoryState.id }), projects: selected.map((key) => ({ key, name: key })),
      reason: 'date-range-required',
    })
    const range = parseRange(request.range)
    if (range === undefined) return response('bootstrap', 'scope_limit', false, {
      ...(directoryState === undefined ? {} : { readId: directoryState.id }), reason: 'date-range-invalid-or-too-large',
    })
    if (directoryState !== undefined) {
      const resumed = directoryState.reader.resumeForRpc()
      if (resumed.status !== 'ok') return this.dropDirectoryState(directoryState, failureStatus(resumed.status), resumed.reason)
      directoryState.explicitClose = true
      try { directoryState.reader.cancel() } catch { /* scope transition retires the old bounded read */ }
      directoryState.explicitClose = false
      this.closeDirectoryState(directoryState)
      this.directoryStates.delete(directoryState.id)
      this.terminals.set(directoryState.id, { status: 'stale', reason: 'project-scope-changed' })
      this.trimTerminalCache()
      this.scheduleSweep()
    }
    const generationId = this.currentGeneration()
    const policyKey = this.currentPolicyKey()
    if (generationId === undefined || policyKey === undefined) return response('bootstrap', 'unavailable', false, { reason: 'dashboard-scope-unavailable' })
    const binding: DashboardReadBinding = {
      generationId, policyKey,
      filterKey: sha256(JSON.stringify({ activity: range.activity, from: range.from, projectKeys: selected.slice().sort(),
        timeZone: range.timeZone, to: range.to })),
      asOf: Date.now(), viewKey: 'dashboard.overview.v1', projectKeys: selected,
    }
    const id = randomUUID()
    let stateRef: ReadState | undefined
    const opened = this.options.openReader(binding, (status, reason) => this.managerEnded(id, stateRef, status, reason))
    if (opened.status !== 'ok') return response('bootstrap', failureStatus(opened.status), false, {
      projects: selected.map((key) => ({ key, name: key })), reason: failureReason(opened.reason),
    })
    const reader = opened.value
    const stateLease = reader.reserveReadState(READ_STATE_BYTES)
    if (stateLease.status !== 'ok') {
      reader.cancel()
      return response('bootstrap', failureStatus(stateLease.status), false, { reason: failureReason(stateLease.reason) })
    }
    const outputLease = reader.reserveReadState(MAX_RESPONSE_BYTES)
    if (outputLease.status !== 'ok') {
      reader.cancel()
      return response('bootstrap', failureStatus(outputLease.status), false, { reason: failureReason(outputLease.reason) })
    }
    const projects: ProjectScan[] = []
    const byKey = new Map<string, ProjectScan>()
    for (const key of selected) {
      const projection = reader.readProject(key, { sqlStatements: 1, rowsVisited: 1, materializedBytes: 512, keyBytes: textBytes(key) },
        (store) => store.dashboardProjectMeta(256))
      if (projection.status !== 'ok') {
        reader.cancel()
        return response('bootstrap', failureStatus(projection.status), false, { reason: failureReason(projection.reason) })
      }
      const meta = projection.value
      const validName = meta?.name !== undefined && projectionValue(meta.name, meta.nameBytes, 256) !== undefined
      const project: ProjectScan = { key, name: validName ? meta!.name! : key, eventAfter: 0, eventDone: false,
        approved: emptyMemoryScan(), candidate: emptyMemoryScan(), forgotten: emptyMemoryScan() }
      projects.push(project)
      byKey.set(key, project)
    }
    stateRef = {
      id, binding, range, projects, projectByKey: byKey, reader,
      excludedAgentPatterns: Object.freeze([...this.options.excludedAgentPatterns()]), generatedAt: Date.now(),
      lastActivityAt: Date.now(), overview: emptyOverview(range), view: 'bootstrap', awaitingFirstAction: true,
      outputReservation: outputLease.value.reservationToken,
      explicitClose: false, page: emptyOverviewPage(), processingScan: emptyProcessingScan(),
      ...(request.focusProjectKey === undefined ? {} : { focusProjectKey: request.focusProjectKey }),
    }
    this.states.set(id, stateRef)
    this.trimTerminalCache()
    this.scheduleSweep()
    const body = response('bootstrap', 'ok', true, { readId: id,
      projects: projects.map((project) => ({ key: project.key, name: project.name })) })
    return this.pauseWithResult(stateRef, body, false, false)
  }

  private beginProjectSelection(): ReadDashboardResult {
    let directory: string
    try { directory = this.options.projectDirectory() } catch {
      return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    }
    let snapshot: ReturnType<typeof projectDirectoryMarker>
    try { snapshot = projectDirectoryMarker(directory) } catch {
      return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    }
    if (!snapshot.readable) return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    if (snapshot.missing || snapshot.marker === undefined) {
      return response('bootstrap', 'selection_required', true, { projects: [], reason: 'project-selection-required' })
    }
    let realDirectory: string
    try { realDirectory = realpathSync(directory) } catch {
      return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    }
    const generationId = this.currentGeneration()
    const policyKey = this.currentPolicyKey()
    if (generationId === undefined || policyKey === undefined) return response('bootstrap', 'unavailable', false, { reason: 'dashboard-scope-unavailable' })
    const id = randomUUID()
    const binding: DashboardReadBinding = { generationId, policyKey, filterKey: sha256('project-selection'),
      asOf: Date.now(), viewKey: 'dashboard.project-selection.v1', projectKeys: [] }
    let stateRef: DirectoryReadState | undefined
    const opened = this.options.openReader(binding, (status, reason) => this.directoryManagerEnded(id, stateRef, status, reason))
    if (opened.status !== 'ok') return response('bootstrap', failureStatus(opened.status), false, { reason: failureReason(opened.reason) })
    const reader = opened.value
    const handleLease = reader.reserveReadState(DIRECTORY_HANDLE_BYTES)
    if (handleLease.status !== 'ok') {
      reader.cancel()
      return response('bootstrap', failureStatus(handleLease.status), false, { reason: failureReason(handleLease.reason) })
    }
    const outputLease = reader.reserveReadState(MAX_RESPONSE_BYTES)
    if (outputLease.status !== 'ok') {
      reader.cancel()
      return response('bootstrap', failureStatus(outputLease.status), false, { reason: failureReason(outputLease.reason) })
    }
    let dir: Dir
    try { dir = opendirSync(directory) } catch {
      reader.cancel()
      return response('bootstrap', 'unavailable', false, { reason: 'project-directory-unreadable' })
    }
    const labels = reader.createDirectoryLabelReader({ readId: id, directory: path.resolve(directory), marker: snapshot.marker })
    if (labels.status !== 'ok') {
      try { dir.closeSync() } catch { /* failed capability creation owns no directory handle */ }
      reader.cancel()
      return response('bootstrap', failureStatus(labels.status), false, { reason: failureReason(labels.reason) })
    }
    const now = Date.now()
    const state: DirectoryReadState = { id, directory, realDirectory, marker: snapshot.marker, binding, dir, reader,
      labels: labels.value, memberIdentities: new Map(),
      outputReservation: outputLease.value.reservationToken, createdAt: now, lastActivityAt: now,
      complete: false, explicitClose: false }
    stateRef = state
    this.directoryStates.set(state.id, state)
    this.scheduleSweep()
    const charged = this.readChargedProjectDirectoryPage(state)
    if (charged.status !== 'ok') return this.dropDirectoryState(state, failureStatus(charged.status), charged.reason)
    const page = charged.value
    if (!page.readable) return this.dropDirectoryState(state, 'stale', 'project-directory-changed', 'bootstrap')
    return this.projectDirectoryResponse(state, page)
  }

  private readChargedProjectDirectoryPage(state: DirectoryReadState): DashboardReadOutcome<ProjectDirectoryPage> {
    const labels: DashboardDirectoryMemberLabel[] = []
    const pending: string[] = state.pendingKey === undefined ? [] : [state.pendingKey]
    state.pendingKey = undefined
    let rawEntries = 0
    let readable = true
    try {
      while (true) {
        const pageSlots = PROJECT_CHOICES - labels.length
        if (pageSlots <= 0) {
          return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
            hasMore: true, readable, rawEntries } }
        }
        const remaining = state.reader.remainingReadWorkBreakdown()
        if (remaining === undefined) return { status: 'stale', reason: 'visibility-session-ended' }
        const memberCapacity = state.labels.remainingMemberCapacity()
        if (memberCapacity === undefined) return { status: 'stale', reason: 'visibility-session-ended' }
        // Every label must leave room for its own SQL/rows/bytes, the member
        // lease, and the final publication probe before any scan starts.
        // Labels already accumulated in this call have not run their
        // pre-publication recheck yet. Every further scan/member slot keeps
        // that outstanding verify work (and the final probe) reserved.
        const wanted = Math.min(pageSlots, memberCapacity.combined,
          this.affordableMemberSlots(remaining.call, pageSlots, labels.length),
          this.affordableMemberSlots(remaining.session, pageSlots, labels.length))
        if (wanted <= 0) {
          // The call allocation may be spent while the same session still has
          // room for a later RPC: hand off the consumed cursor and any pending
          // key instead of dropping cumulative work. Only cumulative
          // exhaustion is reported as an honest incomplete result.
          const sessionCanContinue = memberCapacity.session > 0 &&
            this.affordableMemberSlots(remaining.session, pageSlots, labels.length) > 0
          if (labels.length > 0 || sessionCanContinue && (pending.length > 0 || rawEntries > 0)) {
            return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
              hasMore: true, readable, rawEntries } }
          }
          return { status: 'budget-exhausted', reason: 'project-directory-budget' }
        }
        if (pending.length > 0) {
          const batch = pending.splice(0, wanted)
          const read = this.readDirectoryMemberLabels(state, batch)
          if (read.status !== 'ok') return read
          labels.push(...read.value)
          if (state.complete && state.pendingKey === undefined) {
            return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
              hasMore: false, readable, rawEntries } }
          }
          continue
        }
        const scanSlots = Math.min(wanted,
          this.affordableScanSlots(remaining.call, wanted, labels.length),
          this.affordableScanSlots(remaining.session, wanted, labels.length))
        if (scanSlots <= 0) {
          if (labels.length > 0 || rawEntries > 0) {
            // The call's own allocation is spent, but the same S1 session may
            // still have room for a later RPC. Keep the consumed cursor and the
            // same readId; never reset cumulative work.
            return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
              hasMore: true, readable, rawEntries } }
          }
          return { status: 'budget-exhausted', reason: 'project-directory-budget' }
        }
        const capacity = Math.min(MAX_RAW_DIRECTORY_ENTRIES - rawEntries,
          this.directoryEntryCapacity(remaining.call, scanSlots, labels.length),
          this.directoryEntryCapacity(remaining.session, scanSlots, labels.length))
        const batch = Math.min(DIRECTORY_READ_BATCH, capacity)
        if (!Number.isSafeInteger(batch) || batch < 1) {
          if (labels.length > 0 || rawEntries > 0) {
            return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
              hasMore: true, readable, rawEntries } }
          }
          return { status: 'budget-exhausted', reason: 'project-directory-budget' }
        }
        const rawBytes = batch * DIRECTORY_RAW_ENTRY_BYTES
        const charged = state.reader.chargeRead({ sqlStatements: 0, rowsVisited: batch,
          materializedBytes: rawBytes, keyBytes: rawBytes },
        () => this.readProjectDirectoryPage(state, batch, scanSlots))
        if (charged.status !== 'ok') return charged
        const page = charged.value
        rawEntries += page.rawEntries
        if (!page.readable) {
          readable = false
          return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
            hasMore: false, readable, rawEntries } }
        }
        if (page.keys.length > 0) {
          const read = this.readDirectoryMemberLabels(state, page.keys)
          if (read.status !== 'ok') return read
          labels.push(...read.value)
        }
        if (!page.hasMore) {
          return { status: 'ok', value: { keys: labels.map((label) => label.key), labels,
            hasMore: false, readable, rawEntries } }
        }
      }
    } finally {
      if (pending.length > 0) state.pendingKey = pending[0]
    }
  }

  private readDirectoryMemberLabels(state: DirectoryReadState, keys: readonly string[]): DashboardReadOutcome<DashboardDirectoryMemberLabel[]> {
    if (keys.length === 0) return { status: 'ok', value: [] }
    if (!this.directoryLabelScopeApplies(state)) return { status: 'stale', reason: 'directory-label-scope-changed' }
    for (const key of keys) {
      const identity = projectMemberIdentity(state.directory, state.realDirectory, key)
      if (identity === undefined) return { status: 'stale', reason: 'directory-member-changed' }
      state.memberIdentities.set(key, identity)
    }
    const enumerated = state.labels.enumerate(keys)
    if (enumerated.status !== 'ok') return enumerated
    const labels = state.labels.readLabels(keys)
    if (labels.status !== 'ok') return labels
    if (labels.value.length !== keys.length) return { status: 'unavailable-probe', reason: 'directory-label-projection-invalid' }
    for (let index = 0; index < keys.length; index += 1) {
      const label = labels.value[index]
      if (label === undefined || label.key !== keys[index] || typeof label.name !== 'string' || label.name.length === 0 ||
          textBytes(label.name) > DIRECTORY_LABEL_NAME_BYTES || typeof label.proven !== 'boolean' ||
          !Number.isSafeInteger(label.nameBytes) || label.nameBytes < 0 || label.nameBytes > DIRECTORY_LABEL_NAME_BYTES ||
          (label.nameBytes === 0 ? label.name !== keys[index] : textBytes(label.name) !== label.nameBytes)) {
        return { status: 'unavailable-probe', reason: 'directory-label-projection-invalid' }
      }
    }
    return labels
  }

  /** The label capability must still be the one bound to this directory readId/scope. */
  private directoryLabelScopeApplies(state: DirectoryReadState): boolean {
    try {
      return state.labels.readId === state.id &&
        state.labels.directory === path.resolve(state.directory) &&
        state.labels.marker === state.marker
    } catch { return false }
  }

  private directoryEntryCapacity(remaining: DashboardReadCost, memberSlots: number, outstandingLabels: number): number {
    const slots = Math.max(0, memberSlots)
    const outstanding = Math.max(0, outstandingLabels)
    const memberSql = slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.sqlStatements
    const memberRows = slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.rowsVisited
    const memberBytes = slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.materializedBytes
    const memberKeyBytes = slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.keyBytes
    const verifySql = outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.sqlStatements
    const verifyRows = outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.rowsVisited
    const verifyBytes = outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.materializedBytes
    const verifyKeyBytes = outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.keyBytes
    if (remaining.sqlStatements < DIRECTORY_FINAL_PROOF_SQL + verifySql + memberSql) return 0
    return Math.min(
      remaining.rowsVisited - DIRECTORY_FINAL_PROOF_ROWS - verifyRows - memberRows,
      Math.floor((remaining.keyBytes - DIRECTORY_FINAL_PROOF_KEY_BYTES - verifyKeyBytes - memberKeyBytes) / DIRECTORY_RAW_ENTRY_BYTES),
      Math.floor((remaining.materializedBytes - DIRECTORY_FINAL_PROOF_MATERIALIZED_BYTES - verifyBytes - memberBytes) / DIRECTORY_RAW_ENTRY_BYTES),
    )
  }

  /** Largest new-member count whose label envelope and every outstanding verify still fit. */
  private affordableMemberSlots(remaining: DashboardReadCost, limit: number, outstandingLabels: number): number {
    let slots = Math.min(PROJECT_CHOICES, Math.max(0, limit))
    while (slots > 0 && !this.memberReserveFits(remaining, slots, outstandingLabels)) slots -= 1
    return slots
  }

  /** Largest new-member count that also leaves room for one raw directory entry. */
  private affordableScanSlots(remaining: DashboardReadCost, limit: number, outstandingLabels: number): number {
    let slots = Math.min(PROJECT_CHOICES, Math.max(0, limit))
    while (slots > 0 && this.directoryEntryCapacity(remaining, slots, outstandingLabels) < 1) slots -= 1
    return slots
  }

  private memberReserveFits(remaining: DashboardReadCost, memberSlots: number, outstandingLabels: number): boolean {
    const slots = Math.max(0, memberSlots)
    const outstanding = Math.max(0, outstandingLabels)
    return remaining.sqlStatements >= DIRECTORY_FINAL_PROOF_SQL +
        outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.sqlStatements +
        slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.sqlStatements &&
      remaining.rowsVisited >= DIRECTORY_FINAL_PROOF_ROWS +
        outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.rowsVisited +
        slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.rowsVisited &&
      remaining.materializedBytes >= DIRECTORY_FINAL_PROOF_MATERIALIZED_BYTES +
        outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.materializedBytes +
        slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.materializedBytes &&
      remaining.keyBytes >= DIRECTORY_FINAL_PROOF_KEY_BYTES +
        outstanding * DASHBOARD_DIRECTORY_VERIFY_RESERVE.keyBytes +
        slots * DASHBOARD_DIRECTORY_MEMBER_RESERVE.keyBytes
  }

  private readProjectDirectoryPage(state: DirectoryReadState, rawLimit: number, maxKeys: number): RawProjectDirectoryPage {
    const keys: string[] = []
    if (state.pendingKey !== undefined) {
      keys.push(state.pendingKey)
      state.pendingKey = undefined
    }
    if (state.complete) {
      return { keys: keys.slice(0, maxKeys), hasMore: false, readable: true, rawEntries: 0 }
    }
    if (state.dir === undefined) return { keys: [], hasMore: false, readable: false, rawEntries: 0 }
    let rawEntries = 0
    let exhausted = false
    try {
      while (rawEntries < rawLimit && keys.length <= maxKeys) {
        const entry = state.dir.readSync()
        if (entry === null) { exhausted = true; break }
        rawEntries += 1
        if (validProjectDirectoryEntry(state.directory, entry.name, entry.isDirectory())) keys.push(entry.name)
        if (keys.length > maxKeys) {
          state.pendingKey = keys.pop()
          break
        }
      }
    } catch { return { keys: [], hasMore: false, readable: false, rawEntries } }
    if (exhausted) {
      state.complete = true
      try { state.dir.closeSync() } catch { /* exhausted directory handles are already closed */ }
      state.dir = undefined
    }
    const hasMore = state.pendingKey !== undefined || !state.complete
    return { keys: keys.slice(0, maxKeys), hasMore, readable: true, rawEntries }
  }

  private projectDirectoryResponse(state: DirectoryReadState, page: ProjectDirectoryPage): ReadDashboardResult {
    const after = projectDirectoryMarker(state.directory)
    if (!after.readable || after.marker !== state.marker) {
      return this.dropDirectoryState(state, 'stale', 'project-directory-changed', 'bootstrap')
    }
    if (!page.hasMore && page.labels.length === 0) {
      this.directoryStates.delete(state.id)
      state.explicitClose = true
      try { state.reader.cancel() } catch { /* empty selection has no resumable work */ }
      state.explicitClose = false
      this.closeDirectoryState(state)
      this.scheduleSweep()
      return response('bootstrap', 'selection_required', true, { projects: [], reason: 'project-selection-required' })
    }
    const activeProjectKey = this.provenActiveProjectKey(state, page.labels)
    const body = response('bootstrap', page.hasMore ? 'partial' : 'selection_required', !page.hasMore, {
      readId: state.id, projects: page.labels.map((label) => ({ key: label.key, name: label.name })),
      ...(activeProjectKey === undefined ? {} : { activeProjectKey }),
      ...(page.hasMore ? { reason: 'project-list-lower-bound' } : { reason: 'project-selection-required' }),
    })
    return this.pauseDirectoryWithResult(state, body, page.hasMore, page.keys)
  }

  /**
   * Trusted active-project hint. The value comes only from the runtime's
   * `activeProjectKey()` and is exposed only when the current directory page
   * proved that exact member (enumerated key + opened store + connection stamp
   * + filesystem identity). Request focus is never consulted and an
   * unenumerated project is not reported as existing or absent.
   */
  private provenActiveProjectKey(state: DirectoryReadState, labels: readonly DashboardDirectoryMemberLabel[]): string | undefined {
    let candidate: string | undefined
    try {
      const value = this.options.activeProjectKey()
      if (typeof value === 'string' && value.length > 0 && textBytes(value) <= 256 && isValidProjectKey(value)) candidate = value
    } catch { candidate = undefined }
    if (candidate === undefined) return undefined
    const proven = labels.some((label) => label.key === candidate && label.proven && state.memberIdentities.has(candidate))
    return proven ? candidate : undefined
  }

  private continueProjectSelection(state: DirectoryReadState, cursor: string): ReadDashboardResult {
    const checked = this.checkDirectoryState(state)
    if (checked !== undefined) return checked
    if (state.cursor !== cursor) return response('bootstrap', 'stale', false, { readId: state.id, reason: 'cursor-invalid-or-consumed' })
    state.cursor = undefined
    const resumed = state.reader.resumeForRpc()
    if (resumed.status !== 'ok') return this.dropDirectoryState(state, failureStatus(resumed.status), resumed.reason)
    const output = this.reserveDirectoryOutput(state)
    if (output !== undefined) return output
    const charged = this.readChargedProjectDirectoryPage(state)
    if (charged.status !== 'ok') return this.dropDirectoryState(state, failureStatus(charged.status), charged.reason)
    const page = charged.value
    if (!page.readable) return this.dropDirectoryState(state, 'stale', 'project-directory-read-failed', 'bootstrap')
    return this.projectDirectoryResponse(state, page)
  }

  private reserveDirectoryOutput(state: DirectoryReadState): ReadDashboardResult | undefined {
    const output = state.reader.reserveReadState(MAX_RESPONSE_BYTES)
    if (output.status !== 'ok') return this.dropDirectoryState(state, failureStatus(output.status), output.reason)
    state.outputReservation = output.value.reservationToken
    return undefined
  }

  private pauseDirectoryWithResult(state: DirectoryReadState, body: ReadDashboardResult, exposeCursor: boolean,
    pageKeys: readonly string[]): ReadDashboardResult {
    const encoded = JSON.stringify(exposeCursor ? { ...body, cursor: '00000000-0000-4000-8000-000000000000' } : body)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_BYTES) {
      return this.dropDirectoryState(state, 'budget_exhausted', 'project-list-response-size-limit')
    }
    const reservation = state.outputReservation
    const suspended = state.reader.suspendForRpc(() => {
      let marker: ReturnType<typeof projectDirectoryMarker>
      try { marker = projectDirectoryMarker(state.directory) } catch {
        return { status: 'unavailable-probe', reason: 'project-directory-unreadable' }
      }
      if (!marker.readable || marker.marker !== state.marker) {
        return { status: 'stale', reason: 'project-directory-changed' }
      }
      let currentRealDirectory: string
      try { currentRealDirectory = realpathSync(state.directory) } catch {
        return { status: 'stale', reason: 'project-directory-changed' }
      }
      if (currentRealDirectory !== state.realDirectory) {
        return { status: 'stale', reason: 'project-directory-changed' }
      }
      for (const key of pageKeys) {
        const recorded = state.memberIdentities.get(key)
        const current = projectMemberIdentity(state.directory, state.realDirectory, key)
        if (recorded === undefined || current === undefined || !sameProjectMemberIdentity(recorded, current)) {
          return { status: 'stale', reason: 'directory-member-changed' }
        }
      }
      if (!this.directoryLabelScopeApplies(state)) {
        return { status: 'stale', reason: 'directory-label-scope-changed' }
      }
      // Re-read every published name and connection stamp on the same member
      // connection after the label read and immediately before publication.
      const verified = state.labels.verifyLabels(pageKeys)
      if (verified.status !== 'ok') return verified
      if (reservation === undefined) return { status: 'stale', reason: 'directory-output-reservation-missing' }
      const released = state.reader.releaseReadState(reservation)
      if (released.status === 'ok') state.outputReservation = undefined
      return released
    })
    if (suspended.status !== 'ok') {
      if (suspended.status === 'handoff-exhausted') {
        if (suspended.proofComplete !== true) return this.dropDirectoryState(state, 'stale', 'handoff-proof-incomplete')
        const { cursor: _cursor, ...withoutCursor } = body
        this.dropDirectoryState(state, 'budget_exhausted', suspended.reason)
        return { ...withoutCursor, status: 'budget_exhausted', complete: false, reason: failureReason(suspended.reason) }
      }
      return this.dropDirectoryState(state, failureStatus(suspended.status), suspended.reason)
    }
    state.lastActivityAt = Date.now()
    state.cursor = exposeCursor ? suspended.value.continuationToken : undefined
    this.scheduleSweep()
    return exposeCursor ? { ...body, cursor: suspended.value.continuationToken } : body
  }

  private checkDirectoryState(state: DirectoryReadState): ReadDashboardResult | undefined {
    const now = Date.now()
    if (!safeInteger(now) || now < state.createdAt || now - state.lastActivityAt >= DIRECTORY_IDLE_MS ||
        now - state.createdAt >= DASHBOARD_ABSOLUTE_MS) {
      return this.dropDirectoryState(state, 'expired', 'project-directory-read-expired', 'bootstrap')
    }
    let marker: ReturnType<typeof projectDirectoryMarker>
    try { marker = projectDirectoryMarker(state.directory) } catch {
      return this.dropDirectoryState(state, 'unavailable', 'project-directory-unreadable', 'bootstrap')
    }
    if (!marker.readable || marker.marker !== state.marker) {
      return this.dropDirectoryState(state, 'stale', 'project-directory-changed', 'bootstrap')
    }
    let currentRealDirectory: string
    try { currentRealDirectory = realpathSync(state.directory) } catch {
      return this.dropDirectoryState(state, 'unavailable', 'project-directory-unreadable', 'bootstrap')
    }
    if (currentRealDirectory !== state.realDirectory) {
      return this.dropDirectoryState(state, 'stale', 'project-directory-changed', 'bootstrap')
    }
    const generation = this.currentGeneration()
    const policy = this.currentPolicyKey()
    if (generation === undefined || policy === undefined) {
      return this.dropDirectoryState(state, 'unavailable', 'dashboard-scope-unavailable', 'bootstrap')
    }
    if (generation !== state.binding.generationId || policy !== state.binding.policyKey) {
      return this.dropDirectoryState(state, 'stale', 'dashboard-scope-changed', 'bootstrap')
    }
    return undefined
  }

  private closeDirectoryState(state: DirectoryReadState): void {
    if (state.dir !== undefined) {
      try { state.dir.closeSync() } catch { /* state disposal remains best effort */ }
      state.dir = undefined
    }
    state.memberIdentities.clear()
    try { state.labels.release() } catch { /* state disposal remains best effort */ }
  }

  private dropDirectoryState(state: DirectoryReadState, status: DashboardStatus, reason: string,
    view: DashboardView = 'bootstrap'): ReadDashboardResult {
    this.closeDirectoryState(state)
    this.directoryStates.delete(state.id)
    state.explicitClose = true
    try { state.reader.cancel() } catch { /* selected terminal state remains authoritative */ }
    state.explicitClose = false
    this.terminals.delete(state.id)
    this.terminals.set(state.id, { status, reason: failureReason(reason) })
    this.trimTerminalCache()
    this.scheduleSweep()
    return response(view, status, false, { readId: state.id, reason: failureReason(reason) })
  }

  private directoryManagerEnded(readId: string, state: DirectoryReadState | undefined,
    status: DashboardReadFailureStatus, reason: string): void {
    if (state?.explicitClose) return
    if (state !== undefined) this.closeDirectoryState(state)
    this.directoryStates.delete(readId)
    this.terminals.delete(readId)
    this.terminals.set(readId, { status: failureStatus(status), reason: failureReason(reason) })
    this.trimTerminalCache()
    this.scheduleSweep()
  }

  private beginPersona(readId: string, projectKey: string): ReadDashboardResult {
    const state = this.stateFor(readId)
    if (state === undefined) return this.terminalOrStale(readId, 'persona')
    if (!state.projectByKey.has(projectKey)) return response('persona', 'scope_limit', false, { readId, reason: 'project-not-selected' })
    if (state.exposedCursor !== undefined) return response('persona', 'stale', false, { readId, reason: 'single-use-cursor-required' })
    const resumed = this.resumeForAction(state, 'persona')
    if (resumed !== undefined) return resumed
    const output = this.reserveOutput(state, 'persona')
    if (output !== undefined) return output
    state.view = 'persona'
    state.awaitingFirstAction = false
    const releasePersonaGuard = state.reader.beginPersonaProofGuard(2)
    try {
    if (state.personaState === undefined || state.personaState.projectKey !== projectKey) {
      if (state.personaLease !== undefined) {
        const released = state.reader.releaseReadState(state.personaLease)
        if (released.status !== 'ok') return this.abortWithOutcome(state, released, 'persona')
        state.personaLease = undefined
      }
      const personaLease = state.reader.reserveReadState(PERSONA_STATE_BYTES)
      if (personaLease.status !== 'ok') return this.abortWithOutcome(state, personaLease, 'persona')
      state.personaLease = personaLease.value.reservationToken
      const plan = state.reader.readManagedPersonaPlan(projectKey)
      if (plan.status !== 'ok') return this.abortWithOutcome(state, plan, 'persona')
      if (plan.value.state !== 'visible' || plan.value.sourceIds === undefined || plan.value.sourceRevisions === undefined ||
          plan.value.sourceCount === undefined || plan.value.updatedAt === undefined || plan.value.contentBytes === undefined) {
        state.personaState = { projectKey, sourceIds: [], sourceRevisions: {}, sourceCount: 0, updatedAt: 0, contentBytes: 0,
          nextIndex: 0, done: true, noProgressCount: 0, result: { state: plan.value.state === 'hidden' ? 'hidden' : 'unresolved',
            ...(plan.value.reason === undefined ? {} : { reason: plan.value.reason }), stale: false } }
      } else {
        state.personaState = { projectKey, sourceIds: plan.value.sourceIds, sourceRevisions: plan.value.sourceRevisions,
          sourceCount: plan.value.sourceCount, updatedAt: plan.value.updatedAt, contentBytes: plan.value.contentBytes,
          nextIndex: 0, done: false, noProgressCount: 0 }
      }
    }
    const step = this.processPersonaStep(state)
    if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'persona')
    const terminalPersona = this.personaTerminalReason(state)
    if (terminalPersona !== undefined) return this.abortState(state, 'budget-exhausted', terminalPersona, 'persona')
    const body = this.personaResult(state)
    return this.pauseWithResult(state, body, state.personaState.done === false, false)
    } finally { releasePersonaGuard() }
  }

  private processPersonaStep(state: ReadState): OverviewStep {
    const ps = state.personaState
    if (ps === undefined || ps.done) return { status: 'ok' }
    if (ps.result !== undefined) return { status: 'ok' }
    const end = Math.min(ps.sourceIds.length, ps.nextIndex + 4)
    for (let index = ps.nextIndex; index < end; index += 1) {
      const id = ps.sourceIds[index]!
      const source = state.reader.proveManagedPersonaSource(ps.projectKey, id, ps.sourceRevisions[id]!)
      if (source.status === 'budget-exhausted') {
        if (source.reason === 'persona-session-headroom') {
          ps.result = { state: 'unresolved', reason: 'persona-session-budget-exhausted', stale: false }
          ps.done = true
          return { status: 'ok' }
        }
        if (ps.noProgressIndex === ps.nextIndex && ps.noProgressCount >= 1) {
          ps.result = { state: 'unresolved', reason: 'persona-call-budget-no-progress', stale: false }
          ps.done = true
          return { status: 'ok' }
        }
        ps.noProgressIndex = ps.nextIndex
        ps.noProgressCount = 1
        return { status: 'budget_exhausted' }
      }
      if (source.status !== 'ok') return { status: 'fatal', outcome: source }
      if (source.value !== 'visible') {
        ps.result = { state: source.value, reason: 'persona-source-not-visible', stale: false }
        ps.done = true
        return { status: 'ok' }
      }
      ps.nextIndex = index + 1
      ps.noProgressIndex = undefined
      ps.noProgressCount = 0
    }
    if (ps.nextIndex >= ps.sourceIds.length) {
      const body = state.reader.readManagedPersonaBody(ps.projectKey, {
        sourceCount: ps.sourceCount, updatedAt: ps.updatedAt, contentBytes: ps.contentBytes,
        sourceIds: ps.sourceIds, sourceRevisions: ps.sourceRevisions,
      })
      if (body.status === 'budget-exhausted') {
        if (body.reason === 'persona-session-headroom') {
          ps.result = { state: 'unresolved', reason: 'persona-session-budget-exhausted', stale: false }
          ps.done = true
          return { status: 'ok' }
        }
        if (ps.noProgressIndex === ps.nextIndex && ps.noProgressCount >= 1) {
          ps.result = { state: 'unresolved', reason: 'persona-call-budget-no-progress', stale: false }
          ps.done = true
          return { status: 'ok' }
        }
        ps.noProgressIndex = ps.nextIndex
        ps.noProgressCount = 1
        return { status: 'budget_exhausted' }
      }
      if (body.status !== 'ok') return { status: 'fatal', outcome: body }
      ps.result = body.value.state === 'visible'
        ? { state: 'visible', content: body.value.content, stale: body.value.stale ?? ps.sourceCount === 0 }
        : { state: body.value.state, ...(body.value.reason === undefined ? {} : { reason: body.value.reason }), stale: false }
      ps.done = true
    }
    return { status: 'ok' }
  }

  private personaTerminalReason(state: ReadState): string | undefined {
    const ps = state.personaState
    if (ps === undefined) return 'persona-state-missing'
    const reason = ps.result?.reason
    return reason === 'persona-session-budget-exhausted' || reason === 'persona-call-budget-no-progress'
      ? reason : undefined
  }

  private personaResult(state: ReadState): ReadDashboardResult {
    const ps = state.personaState
    if (ps === undefined) return response('persona', 'stale', false, { readId: state.id, reason: 'persona-state-missing' })
    const result = ps.result ?? { state: 'unresolved' as const, reason: 'persona-proof-pending', stale: false }
    const complete = ps.done && result.state !== 'unresolved'
    return response('persona', ps.done ? (result.state === 'unresolved' ? 'partial' : 'ok') : 'partial', complete, {
      readId: state.id, persona: { state: result.state, projectKey: ps.projectKey,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.content === undefined ? {} : { content: result.content }),
        sourceCount: ps.sourceCount, updatedAt: ps.updatedAt, stale: result.stale ?? false },
    })
  }

  private beginGlobalPersona(readId: string): ReadDashboardResult {
    const state = this.stateFor(readId)
    if (state === undefined) return this.terminalOrStale(readId, 'globalPersona')
    if (state.exposedCursor !== undefined) return response('globalPersona', 'stale', false, { readId, reason: 'single-use-cursor-required' })
    const resumed = this.resumeForAction(state, 'globalPersona')
    if (resumed !== undefined) return resumed
    const output = this.reserveOutput(state, 'globalPersona')
    if (output !== undefined) return output
    state.view = 'globalPersona'
    state.awaitingFirstAction = false
    const root = this.options.stateRoot()
    const directory = path.join(root, 'global')
    let directoryStat: Stats | undefined
    try { directoryStat = lstatSync(directory, { throwIfNoEntry: false }) } catch {
      return this.abortState(state, 'unavailable-probe', 'global-persona-directory-unreadable', 'globalPersona')
    }
    if (directoryStat === undefined) {
      const boundary = state.reader.publishProof()
      if (boundary.status !== 'ok') return this.abortWithOutcome(state, boundary, 'globalPersona')
      return this.pauseWithResult(state, response('globalPersona', 'ok', true, { readId, globalPersona: null }), false, false)
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return this.pauseWithResult(state, response('globalPersona', 'scope_limit', false, { readId, reason: 'global-persona-directory-not-trusted' }), false, false)
    }
    let directoryFd: number | undefined
    let openedDirectory: Stats | undefined
    try {
      directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      openedDirectory = fstatSync(directoryFd)
    } catch {
      if (directoryFd !== undefined) { try { closeSync(directoryFd) } catch { /* invalid directory fd */ } }
      return this.abortState(state, 'unavailable-probe', 'global-persona-directory-unreadable', 'globalPersona')
    }
    if (!openedDirectory.isDirectory() || openedDirectory.dev !== directoryStat.dev || openedDirectory.ino !== directoryStat.ino) {
      try { closeSync(directoryFd!) } catch { /* directory identity mismatch */ }
      return this.abortState(state, 'stale', 'global-persona-directory-changed', 'globalPersona')
    }
    const directoryBound = (): boolean => {
      try {
        const pathStat = lstatSync(directory, { throwIfNoEntry: false })
        const fdStat = fstatSync(directoryFd!)
        return pathStat !== undefined && !pathStat.isSymbolicLink() && pathStat.isDirectory() &&
          pathStat.dev === openedDirectory!.dev && pathStat.ino === openedDirectory!.ino &&
          fdStat.dev === openedDirectory!.dev && fdStat.ino === openedDirectory!.ino
      } catch { return false }
    }
    // Linux can resolve through the bound directory fd. Other hosts use the
    // verified directory path and recheck its identity around the bounded read.
    const file = process.platform === 'linux'
      ? path.join('/proc/self/fd', String(directoryFd!), 'persona.json')
      : path.join(directory, 'persona.json')
    let before: Stats | undefined
    try { before = lstatSync(file, { throwIfNoEntry: false }) } catch {
      try { closeSync(directoryFd!) } catch { /* unreadable directory path */ }
      return this.abortState(state, 'unavailable-probe', 'global-persona-file-unreadable', 'globalPersona')
    }
    if (before === undefined) {
      if (!directoryBound()) { try { closeSync(directoryFd!) } catch { /* parent changed */ } return this.abortState(state, 'stale', 'global-persona-directory-changed', 'globalPersona') }
      const boundary = state.reader.publishProof()
      try { closeSync(directoryFd!) } catch { /* close before publish */ }
      if (boundary.status !== 'ok') return this.abortWithOutcome(state, boundary, 'globalPersona')
      return this.pauseWithResult(state, response('globalPersona', 'ok', true, { readId, globalPersona: null }), false, false)
    }
    if (before.isSymbolicLink() || !before.isFile() || before.size > 256 * 1024) {
      try { closeSync(directoryFd!) } catch { /* close before visible result */ }
      return this.pauseWithResult(state, response('globalPersona', 'scope_limit', false, { readId, reason: 'global-persona-file-not-bounded-regular' }), false, false)
    }
    let fd: number | undefined
    let leaseToken: string | undefined
    try {
      try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch {
        return this.abortState(state, 'unavailable-probe', 'global-persona-file-unreadable', 'globalPersona')
      }
      let opened: Stats
      try { opened = fstatSync(fd) } catch {
        return this.abortState(state, 'unavailable-probe', 'global-persona-file-unreadable', 'globalPersona')
      }
      if (!directoryBound() || !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        return this.abortState(state, 'stale', 'global-persona-file-changed', 'globalPersona')
      }
      const lease = state.reader.reserveReadState(256 * 1024)
      if (lease.status !== 'ok') return this.abortWithOutcome(state, lease, 'globalPersona')
      leaseToken = lease.value.reservationToken
      const finish = (body: ReadDashboardResult): ReadDashboardResult => {
        if (leaseToken !== undefined) {
          const released = state.reader.releaseReadState(leaseToken)
          if (released.status !== 'ok') return this.abortWithOutcome(state, released, 'globalPersona')
          leaseToken = undefined
        }
        return this.pauseWithResult(state, body, false, false)
      }
      const maxBytes = 256 * 1024
      const charged = state.reader.chargeRead({ sqlStatements: 0, rowsVisited: 1,
        materializedBytes: maxBytes + 1, keyBytes: textBytes(file) },
      () => {
        const buffer = Buffer.alloc(maxBytes + 1)
        let total = 0
        while (total <= maxBytes) {
          const read = readSync(fd!, buffer, total, maxBytes + 1 - total, null)
          if (read <= 0) break
          total += read
        }
        return { total, buffer }
      })
      if (charged.status !== 'ok') return this.abortWithOutcome(state, charged, 'globalPersona')
      const { total, buffer } = charged.value
      if (total > maxBytes) return finish(response('globalPersona', 'scope_limit', false, { readId, reason: 'global-persona-file-over-byte-limit' }))
      const afterRead = fstatSync(fd)
      if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.size !== opened.size ||
          afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs) {
        return this.abortState(state, 'stale', 'global-persona-file-changed', 'globalPersona')
      }
      let raw: Record<string, unknown>
      try { raw = JSON.parse(buffer.subarray(0, total).toString('utf8')) as Record<string, unknown> }
      catch { return this.abortState(state, 'unavailable-probe', 'global-persona-json-invalid', 'globalPersona') }
      const content = typeof raw.content === 'string' ? raw.content.trim() : ''
      const updatedAt = raw.updatedAt
      const sourceCount = raw.sourceCount
      if (content === '' || Buffer.byteLength(content, 'utf8') > 65_536 || !safeInteger(updatedAt) || updatedAt < 0 ||
          !safeInteger(sourceCount) || sourceCount < 0 || !Array.isArray(raw.sources) || raw.sources.length > 300) {
        return finish(response('globalPersona', 'partial', false, { readId, globalPersona: null, reason: 'global-persona-fields-invalid' }))
      }
      const sources: Array<{ projectKey: string; id: string; revision: number }> = []
      for (const item of raw.sources as unknown[]) {
        if (item === null || typeof item !== 'object') return finish(response('globalPersona', 'partial', false, { readId, globalPersona: null, reason: 'global-persona-source-invalid' }))
        const row = item as Record<string, unknown>
        if (typeof row.projectKey !== 'string' || !state.projectByKey.has(row.projectKey) ||
            typeof row.id !== 'string' || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) {
          return finish(response('globalPersona', 'scope_limit', false, { readId, globalPersona: null, reason: 'global-persona-source-not-selected' }))
        }
        sources.push({ projectKey: row.projectKey, id: row.id, revision: Number(row.revision) })
      }
      if (sources.length === 0 || Number(sourceCount) !== sources.length) {
        return finish(response('globalPersona', 'partial', false, { readId, globalPersona: null, reason: 'global-persona-source-provenance-missing' }))
      }
      const projectSeen = new Set<string>()
      for (const source of sources) {
        if (!projectSeen.has(source.projectKey)) {
          projectSeen.add(source.projectKey)
          if (projectSeen.size > 4) return finish(response('globalPersona', 'scope_limit', false, { readId, globalPersona: null, reason: 'global-persona-project-limit' }))
        }
        const proof = state.reader.proveManagedPersonaSource(source.projectKey, source.id, source.revision)
        if (proof.status !== 'ok') return this.abortWithOutcome(state, proof, 'globalPersona')
        if (proof.value !== 'visible') return finish(response('globalPersona', 'partial', false, { readId, globalPersona: null, reason: 'global-persona-source-not-visible' }))
      }
      if (!directoryBound()) return this.abortState(state, 'stale', 'global-persona-directory-changed', 'globalPersona')
      const finalFd = fstatSync(fd)
      let finalPath: Stats | undefined
      try { finalPath = lstatSync(file, { throwIfNoEntry: false }) } catch {
        return this.abortState(state, 'unavailable-probe', 'global-persona-file-unreadable', 'globalPersona')
      }
      if (finalPath === undefined || finalPath.isSymbolicLink() || !finalPath.isFile() ||
          finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size ||
          finalFd.dev !== opened.dev || finalFd.ino !== opened.ino || finalFd.size !== opened.size ||
          finalFd.mtimeMs !== opened.mtimeMs || finalFd.ctimeMs !== opened.ctimeMs) {
        return this.abortState(state, 'stale', 'global-persona-file-changed', 'globalPersona')
      }
      const boundary = state.reader.publishProof()
      if (boundary.status !== 'ok') return this.abortWithOutcome(state, boundary, 'globalPersona')
      return finish(response('globalPersona', 'ok', true, { readId,
        globalPersona: { content, sourceCount: Number(sourceCount), updatedAt: Number(updatedAt), stale: false } }))
    } finally {
      if (leaseToken !== undefined) {
        try { state.reader.releaseReadState(leaseToken) } catch { /* release is finalized by session teardown */ }
      }
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* descriptor close is best-effort after publish proof */ }
      }
      if (directoryFd !== undefined) {
        try { closeSync(directoryFd) } catch { /* bound parent close is best-effort */ }
      }
    }
  }

  private beginScene(readId: string, projectKey: string): ReadDashboardResult {
    const state = this.stateFor(readId)
    if (state === undefined) return this.terminalOrStale(readId, 'scene')
    const project = state.projectByKey.get(projectKey)
    if (project === undefined) return response('scene', 'scope_limit', false, { readId, reason: 'project-not-selected' })
    if (state.exposedCursor !== undefined) return response('scene', 'stale', false, { readId, reason: 'single-use-cursor-required' })
    const resumed = this.resumeForAction(state, 'scene')
    if (resumed !== undefined) return resumed
    const output = this.reserveOutput(state, 'scene')
    if (output !== undefined) return output
    state.view = 'scene'
    state.awaitingFirstAction = false
    if (state.sceneState === undefined || state.sceneState.projectKey !== projectKey) {
      if (state.sceneLease !== undefined) {
        const released = state.reader.releaseReadState(state.sceneLease)
        if (released.status !== 'ok') return this.abortWithOutcome(state, released, 'scene')
        state.sceneLease = undefined
      }
      const lease = state.reader.reserveReadState(SCENE_STATE_BYTES)
      if (lease.status !== 'ok') return this.abortWithOutcome(state, lease, 'scene')
      state.sceneLease = lease.value.reservationToken
      state.sceneState = { projectKey, projectName: project.name, started: false, rows: [], rowIndex: 0,
        pageHasMore: false, items: [], done: false, unresolvedSeen: false, hiddenSeen: false, noProgressCount: 0 }
    }
    const scene = state.sceneState
    if (scene === undefined) return this.abortState(state, 'unavailable-probe', 'scene-state-missing', 'scene')
    const releaseGuard = state.reader.beginPersonaProofGuard(2)
    let step: SceneStep
    try {
      step = this.processSceneStep(state)
    } finally { releaseGuard() }
    if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'scene')
    return this.pauseWithResult(state, this.sceneResult(state), !scene.done, false)
  }

  private processSceneStep(state: ReadState): SceneStep {
    const query = state.sceneState
    if (query === undefined) return { status: 'fatal', outcome: { status: 'unavailable-probe', reason: 'scene-state-missing' } }
    if (query.done) return { status: 'ok' }
    // The previous items array belongs to the RPC response that exposed this
    // one-shot cursor. Every continuation starts a new result page; retaining
    // any prior items would repeat them and, when the old page was full, never
    // advance the keyset.
    query.items = []
    let proofs = 0
    while (query.items.length < SCENE_PAGE_SIZE && !query.done) {
      if (query.current === undefined) {
        if (query.rowIndex >= query.rows.length) {
          if (query.started && !query.pageHasMore) { query.done = true; break }
          if (query.started && query.pageHasMore && query.after === undefined) {
            query.done = true
            query.blockedReason = 'scene-keyset-unavailable'
            break
          }
          const page = state.reader.readManagedSceneMetaPage(query.projectKey, query.started ? query.after : undefined,
            SCENE_PAGE_SIZE)
          if (page.status === 'budget-exhausted') return this.sceneBudgetPause(query, 'meta')
          if (page.status !== 'ok') return { status: 'fatal', outcome: page }
          query.rows = page.value.rows
          query.rowIndex = 0
          query.pageHasMore = page.value.hasMore
          query.started = true
          if (query.rows.length === 0) { query.done = true; break }
        }
        const row = query.rows[query.rowIndex]!
        query.rowIndex += 1
        if (row.name === undefined) {
          query.items.push({ projectKey: query.projectKey, projectName: query.projectName,
            state: 'unresolved', reason: 'scene-name-materialization-limit', memoryCount: 0,
            updatedAt: row.updatedAt, summaryComplete: false })
          query.unresolvedSeen = true
          query.done = true
          query.blockedReason = 'scene-name-materialization-limit'
          break
        }
        const name = row.name
        query.after = { memoryCount: row.memoryCount, name }
        if (row.nameBytes > 512) {
          query.items.push({ projectKey: query.projectKey, projectName: query.projectName, state: 'unresolved',
            reason: 'scene-name-over-budget', memoryCount: 0, updatedAt: row.updatedAt, summaryComplete: false })
          query.unresolvedSeen = true
          continue
        }
        if (!row.frontierReady) {
          query.items.push({ projectKey: query.projectKey, projectName: query.projectName, name, state: 'unresolved',
            reason: 'scene-frontier-not-ready', memoryCount: 0, updatedAt: row.updatedAt, summaryComplete: false })
          query.unresolvedSeen = true
          continue
        }
        if (row.summaryBytes > 65_536) {
          query.items.push({ projectKey: query.projectKey, projectName: query.projectName, name, state: 'unresolved',
            reason: 'scene-summary-over-budget', memoryCount: 0, updatedAt: row.updatedAt, summaryComplete: false })
          query.unresolvedSeen = true
          continue
        }
        query.current = { row, name, members: [], nextMember: 0, memberHasMore: true, phase: 'members' }
        query.noProgressKey = undefined
        query.noProgressCount = 0
      }
      const current = query.current
      if (current === undefined) return { status: 'fatal', outcome: { status: 'unavailable-probe', reason: 'scene-current-missing' } }
      if (current.phase === 'members') {
        if (current.nextMember >= current.members.length) {
          if (current.memberHasMore) {
            const page = state.reader.readManagedSceneMembers(query.projectKey, current.name, current.afterOrdinal,
              SCENE_MEMBER_PAGE)
            if (page.status === 'budget-exhausted') {
              return this.sceneBudgetPause(query, `members:${query.rowIndex}:${current.nextMember}`)
            }
            if (page.status !== 'ok') return { status: 'fatal', outcome: page }
            if (page.value.rows.length === 0 && page.value.hasMore) {
              return { status: 'fatal', outcome: { status: 'unavailable-probe', reason: 'scene-member-page-empty' } }
            }
            if (page.value.rows.some((member) => !isValidDashboardSceneMember(member))) {
              current.afterOrdinal = page.value.rows.at(-1)?.ordinal ?? current.afterOrdinal
              this.emitSceneItem(query, current, 'unresolved', 'scene-member-identity-invalid')
              continue
            }
            if (current.members.length + page.value.rows.length > SCENE_MEMBER_CAPACITY) {
              current.afterOrdinal = page.value.rows.at(-1)?.ordinal ?? current.afterOrdinal
              this.emitSceneItem(query, current, 'unresolved', 'scene-members-over-state-budget')
              continue
            }
            current.members.push(...page.value.rows)
            current.memberHasMore = page.value.hasMore
            current.afterOrdinal = page.value.rows.at(-1)?.ordinal ?? current.afterOrdinal
          } else {
            if (current.members.length !== current.row.memoryCount) {
              this.emitSceneItem(query, current, 'unresolved', 'scene-members-incomplete')
              continue
            }
            current.phase = 'final'
          }
        }
        while (current.nextMember < current.members.length && proofs < SCENE_PROOFS_PER_CALL) {
          const member = current.members[current.nextMember]!
          const proof = state.reader.proveManagedSceneMember(query.projectKey, member.memoryId!, member.revision)
          if (proof.status === 'budget-exhausted') {
            return this.sceneBudgetPause(query, `proof:${current.name}:${current.nextMember}`)
          }
          if (proof.status !== 'ok') return { status: 'fatal', outcome: proof }
          if (proof.value !== 'visible') {
            this.emitSceneItem(query, current, proof.value === 'hidden' ? 'hidden' : 'unresolved',
              'scene-member-not-current')
            break
          }
          current.nextMember += 1
          proofs += 1
          query.noProgressKey = undefined
          query.noProgressCount = 0
        }
        if (query.current === undefined) continue
        if (proofs >= SCENE_PROOFS_PER_CALL &&
            (current.nextMember < current.members.length || current.memberHasMore)) return { status: 'pause' }
        if (current.phase === 'members') continue
      }
      if (current.phase === 'final') {
        const final = state.reader.readManagedSceneFinal(query.projectKey, {
          name: current.name, memoryCount: current.row.memoryCount, updatedAt: current.row.updatedAt,
          summaryBytes: current.row.summaryBytes, summaryComplete: current.row.summaryComplete,
          memberCount: current.members.length, memberDigest: dashboardSceneMemberDigest(current.members),
        })
        if (final.status === 'budget-exhausted') {
          return this.sceneBudgetPause(query, `final:${current.name}`)
        }
        if (final.status !== 'ok') return { status: 'fatal', outcome: final }
        const finalSummary = final.value.summary
        if (final.value.state !== 'visible' || finalSummary === undefined) {
          this.emitSceneItem(query, current, final.value.state === 'hidden' ? 'hidden' : 'unresolved',
            final.value.reason ?? 'scene-final-unresolved')
          continue
        }
        this.emitSceneItem(query, current, 'visible', undefined, finalSummary)
        continue
      }
    }
    if (query.items.length >= SCENE_PAGE_SIZE && query.current === undefined &&
        query.rowIndex >= query.rows.length && !query.pageHasMore) query.done = true
    return { status: 'ok' }
  }

  private emitSceneItem(query: SceneQuery, current: SceneProofCurrent,
    state: 'visible' | 'hidden' | 'unresolved', reason: string | undefined, summary?: string): void {
    query.items.push({ projectKey: query.projectKey, projectName: query.projectName, name: current.name,
      state, ...(reason === undefined ? {} : { reason }), ...(summary === undefined ? {} : { summary }),
      memoryCount: state === 'visible' ? current.members.length : current.nextMember, updatedAt: current.row.updatedAt,
      summaryComplete: state === 'visible' ? current.row.summaryComplete : false })
    if (state === 'unresolved') query.unresolvedSeen = true
    if (state === 'hidden') query.hiddenSeen = true
    query.current = undefined
  }

  private sceneBudgetPause(query: SceneQuery, key: string): SceneStep {
    if (query.noProgressKey === key) query.noProgressCount += 1
    else { query.noProgressKey = key; query.noProgressCount = 1 }
    if (query.noProgressCount >= 2) {
      return { status: 'fatal', outcome: { status: 'budget-exhausted', reason: 'scene-call-budget-no-progress' } }
    }
    return { status: 'pause' }
  }

  private sceneResult(state: ReadState): ReadDashboardResult {
    const query = state.sceneState
    if (query === undefined) return response('scene', 'stale', false, { readId: state.id, reason: 'scene-state-missing' })
    const complete = query.done && query.blockedReason === undefined && !query.unresolvedSeen && !query.hiddenSeen
    return response('scene', complete ? 'ok' : 'partial', complete, { readId: state.id,
      ...(query.blockedReason === undefined ? {} : { reason: query.blockedReason }),
      scene: { projectKey: query.projectKey, projectName: query.projectName, items: query.items,
        hasMore: !query.done },
    })
  }

  private beginSettings(readId?: string): ReadDashboardResult {
    let state: ReadState | undefined
    if (readId === undefined) {
      const generationId = this.currentGeneration()
      const policyKey = this.currentPolicyKey()
      if (generationId === undefined || policyKey === undefined) {
        return response('settings', 'unavailable', false, { reason: 'dashboard-scope-unavailable' })
      }
      const today = new Date().toISOString().slice(0, 10)
      const range = parseRange({ from: today, to: today, timeZone: 'UTC', activity: 'capture' })
      if (range === undefined) return response('settings', 'unavailable', false, { reason: 'settings-range-invalid' })
      const id = randomUUID()
      const binding: DashboardReadBinding = { generationId, policyKey, filterKey: sha256('settings-metadata'),
        asOf: Date.now(), viewKey: 'dashboard.settings.v1', projectKeys: [] }
      let stateRef: ReadState | undefined
      const opened = this.options.openReader(binding, (status, reason) => this.settingsManagerEnded(id, stateRef, status, reason))
      if (opened.status !== 'ok') return response('settings', failureStatus(opened.status), false, { reason: failureReason(opened.reason) })
      const reader = opened.value
      const stateLease = reader.reserveReadState(READ_STATE_BYTES)
      if (stateLease.status !== 'ok') {
        reader.cancel()
        return response('settings', failureStatus(stateLease.status), false, { reason: failureReason(stateLease.reason) })
      }
      const output = reader.reserveReadState(MAX_RESPONSE_BYTES)
      if (output.status !== 'ok') {
        reader.cancel()
        return response('settings', failureStatus(output.status), false, { reason: failureReason(output.reason) })
      }
      stateRef = { id, binding, range, projects: [], projectByKey: new Map(), reader,
        excludedAgentPatterns: Object.freeze([...this.options.excludedAgentPatterns()]), generatedAt: Date.now(),
        lastActivityAt: Date.now(), overview: emptyOverview(range), view: 'settings', awaitingFirstAction: false,
        outputReservation: output.value.reservationToken, explicitClose: false,
        page: emptyOverviewPage(), processingScan: emptyProcessingScan() }
      state = stateRef
      this.states.set(id, state)
      this.scheduleSweep()
    } else {
      state = this.stateFor(readId)
      if (state === undefined) return this.terminalOrStale(readId, 'settings')
      if (state.exposedCursor !== undefined) {
        return response('settings', 'stale', false, { readId, reason: 'single-use-cursor-required' })
      }
      const resumed = this.resumeForAction(state, 'settings')
      if (resumed !== undefined) return resumed
      const output = this.reserveOutput(state, 'settings')
      if (output !== undefined) return output
      state.view = 'settings'
      state.awaitingFirstAction = false
    }
    let settings: ReadDashboardSettings
    let activeProjectKey: string | undefined
    let lastError: string | undefined
    let lastErrorState: 'absent' | 'present' | 'omitted' = 'absent'
    try {
      settings = this.options.settings()
      const candidateActive = this.options.activeProjectKey()
      if (candidateActive !== undefined && state.projectByKey.has(candidateActive)) activeProjectKey = candidateActive
      const rawError = this.options.lastError()
      if (rawError !== undefined) {
        if (textBytes(rawError) <= 2000) { lastError = rawError; lastErrorState = 'present' }
        else lastErrorState = 'omitted'
      }
    } catch {
      return this.abortState(state, 'unavailable-probe', 'settings-projection-failed', 'settings')
    }
    const body = response('settings', 'ok', true, { readId: state.id,
      settings, lastErrorState, ...(activeProjectKey === undefined ? {} : { activeProjectKey }),
      ...(lastError === undefined ? {} : { lastError }) })
    return this.pauseWithResult(state, body, false, false)
  }

  private settingsManagerEnded(readId: string, state: ReadState | undefined,
    status: DashboardReadFailureStatus, reason: string): void {
    if (state?.explicitClose) return
    if (state !== undefined) this.states.delete(readId)
    this.terminals.delete(readId)
    this.terminals.set(readId, { status: failureStatus(status), reason: failureReason(reason) })
    this.trimTerminalCache()
    this.scheduleSweep()
  }

  private beginOverview(readId: string, focusProjectKey?: string): ReadDashboardResult {
    const state = this.stateFor(readId)
    if (state === undefined) return this.terminalOrStale(readId, 'overview')
    if (focusProjectKey !== undefined && !state.projectByKey.has(focusProjectKey)) {
      return response('overview', 'scope_limit', false, { readId, reason: 'project-not-selected' })
    }
    if (state.view === 'overview' && !state.awaitingFirstAction && state.exposedCursor !== undefined) {
      return response('overview', 'stale', false, { readId, reason: 'single-use-cursor-required' })
    }
    const resumed = this.resumeForAction(state, 'overview')
    if (resumed !== undefined) return resumed
    const output = this.reserveOutput(state, 'overview')
    if (output !== undefined) return output
    if (focusProjectKey !== undefined && state.focusProjectKey !== focusProjectKey) {
      state.focusProjectKey = focusProjectKey
      if (state.processingScan.projectKey !== undefined && state.processingScan.projectKey !== focusProjectKey) {
        state.processingScan = emptyProcessingScan()
      }
    }
    state.view = 'overview'
    state.awaitingFirstAction = false
    const step = this.processOverviewStep(state)
    const body = this.overviewResult(state, step.status === 'budget_exhausted' ? 'budget_exhausted' : undefined)
    if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'overview')
    return this.pauseWithResult(state, body, this.overviewTasks(state).length > 0, false)
  }

  private continueRead(readId: string, cursor: string): ReadDashboardResult {
    const directoryState = this.directoryStates.get(readId)
    if (directoryState !== undefined) return this.continueProjectSelection(directoryState, cursor)
    const state = this.stateFor(readId)
    if (state === undefined) return this.terminalOrStale(readId, 'overview')
    if (state.exposedCursor !== cursor) return response(state.view, 'stale', false, { readId, reason: 'cursor-invalid-or-consumed' })
    const resumed = state.reader.resumeForRpc()
    state.exposedCursor = undefined
    if (resumed.status !== 'ok') return this.abortWithOutcome(state, resumed, state.view)
    const output = this.reserveOutput(state, state.view)
    if (output !== undefined) return output
    state.lastActivityAt = Date.now()
    switch (state.view) {
      case 'persona': {
        const releasePersonaGuard = state.reader.beginPersonaProofGuard(2)
        try {
          const step = this.processPersonaStep(state)
          if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'persona')
          const terminalPersona = this.personaTerminalReason(state)
          if (terminalPersona !== undefined) return this.abortState(state, 'budget-exhausted', terminalPersona, 'persona')
          const body = this.personaResult(state)
          return this.pauseWithResult(state, body, state.personaState?.done === false, false)
        } finally { releasePersonaGuard() }
      }
      case 'scene': {
        const releaseGuard = state.reader.beginPersonaProofGuard(2)
        let step: SceneStep
        try {
          step = this.processSceneStep(state)
        } finally { releaseGuard() }
        if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'scene')
        return this.pauseWithResult(state, this.sceneResult(state), !state.sceneState?.done, false)
      }
      case 'overview': {
        const step = this.processOverviewStep(state)
        if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'overview')
        const body = this.overviewResult(state, step.status === 'budget_exhausted' ? 'budget_exhausted' : undefined)
        return this.pauseWithResult(state, body, this.overviewTasks(state).length > 0, false)
      }
      case 'library': return this.readLibraryPage(state)
      case 'detail': return state.eventQuery === undefined
        ? response('detail', 'stale', false, { readId, reason: 'detail-query-missing' })
        : this.readEventPage(state)
      case 'repeated': return this.continueRepeated(state)
      default: return response(state.view, 'stale', false, { readId, reason: 'continuation-view-invalid' })
    }
  }

  private beginLibrary(request: Extract<ReadDashboardRequest, { action: 'library' }>): ReadDashboardResult {
    const state = this.stateFor(request.readId)
    if (state === undefined) return this.terminalOrStale(request.readId, 'library')
    if (!state.projectByKey.has(request.projectKey)) return response('library', 'scope_limit', false,
      { readId: state.id, reason: 'project-not-selected' })
    const resumed = this.resumeForAction(state, 'library')
    if (resumed !== undefined) return resumed
    const output = this.reserveOutput(state, 'library')
    if (output !== undefined) return output
    state.view = 'library'
    state.awaitingFirstAction = false
    state.library = { projectKey: request.projectKey,
      statuses: request.status === 'all' ? ['approved', 'candidate', 'forgotten'] : [request.status],
      statusIndex: 0, query: request.query, limit: Math.min(request.limit ?? 15, 6), hasMore: false }
    return this.readLibraryPage(state)
  }

  private readLibraryPage(state: ReadState): ReadDashboardResult {
    const query = state.library
    if (query === undefined) return response('library', 'stale', false, { readId: state.id, reason: 'library-query-missing' })
    const project = state.projectByKey.get(query.projectKey)!
    const normalizedQuery = (query.query ?? '').trim().toLocaleLowerCase()
    const records: Array<NonNullable<ReadDashboardResult['records']>[number]> = []
    while (query.statusIndex < query.statuses.length) {
      const status = query.statuses[query.statusIndex]!
      const remaining = query.limit - records.length
      if (remaining <= 0) break
      const page = state.reader.readManagedPage(project.key, status, query.after, remaining, 16 * 1024,
        `library:${project.key}:${status}`)
      if (page.status !== 'ok') {
        if (page.status === 'budget-exhausted' && page.reason === 'persona-call-headroom') {
          return this.pauseWithResult(state, this.libraryResult(state, records, true, 'budget_exhausted'), true, false)
        }
        return this.abortWithOutcome(state, page, 'library')
      }
      for (const item of page.value.items) {
        if (item.state === 'unresolved') { state.overview.incomplete = true; continue }
        if (item.state !== 'visible') continue
        // The library records contract requires projectKey/projectName, and the
        // query matches projectName. Reuse the overview projection so summary
        // and record paths get the same complete project context.
        const memory = this.pageMemory(item, project)
        if (memory === undefined) { state.overview.incomplete = true; continue }
        if (normalizedQuery.length > 0 &&
            !`${memory.content ?? ''}\n${memory.projectName ?? project.name}`.toLocaleLowerCase().includes(normalizedQuery)) continue
        records.push(memory)
      }
      query.after = page.value.nextCursor
      const moreStatuses = query.statusIndex < query.statuses.length - 1
      if (page.value.hasMore || moreStatuses) {
        query.hasMore = true
        if (!page.value.hasMore) { query.statusIndex += 1; query.after = undefined }
        return this.pauseWithResult(state, this.libraryResult(state, records, true), true, false)
      }
      query.statusIndex += 1
      query.after = undefined
    }
    query.hasMore = false
    return this.pauseWithResult(state, this.libraryResult(state, records, false), false, false)
  }

  private libraryResult(state: ReadState, records: Array<NonNullable<ReadDashboardResult['records']>[number]>,
    hasMore: boolean, statusOverride?: DashboardStatus): ReadDashboardResult {
    const query = state.library!
    const project = state.projectByKey.get(query.projectKey)!
    return response('library', statusOverride ?? (state.overview.incomplete ? 'partial' : 'ok'), !hasMore && !state.overview.incomplete, {
      readId: state.id, projects: [{ key: project.key, name: project.name }],
      records: records.map((record) => ({ ...record, projectKey: project.key, projectName: project.name })),
      reason: hasMore ? 'single-use-cursor-required' : undefined,
    })
  }

  private beginDetail(request: Extract<ReadDashboardRequest, { action: 'detail' }>): ReadDashboardResult {
    const state = this.stateFor(request.readId)
    if (state === undefined) return this.terminalOrStale(request.readId, 'detail')
    if (!state.projectByKey.has(request.projectKey)) return response('detail', 'scope_limit', false,
      { readId: state.id, reason: 'project-not-selected' })
    const resumed = this.resumeForAction(state, 'detail')
    if (resumed !== undefined) return resumed
    const output = this.reserveOutput(state, 'detail')
    if (output !== undefined) return output
    state.view = 'detail'
    state.awaitingFirstAction = false
    state.library = undefined
    if (request.target.kind === 'memory') {
      const result = request.target.status === 'approved'
        ? state.reader.resolveRoot(request.projectKey, request.target.id, DETAIL_BODY_BYTES)
        : state.reader.resolveManagedMemory(request.projectKey, request.target.id, request.target.status, DETAIL_BODY_BYTES)
      if (result.status !== 'ok') return this.abortWithOutcome(state, result, 'detail')
      const item = result.value as DashboardVisibilityItem
      const record = item.state === 'visible' && item.record !== undefined
        ? { ...item.record, projectKey: request.projectKey, projectName: state.projectByKey.get(request.projectKey)!.name }
        : null
      const body = response('detail', item.state === 'unresolved' ? 'partial' : 'ok', item.state !== 'unresolved', {
        readId: state.id, projects: [{ key: request.projectKey, name: state.projectByKey.get(request.projectKey)!.name }],
        record: record as ReadDashboardResult['record'], itemState: item.state,
        reason: item.state === 'unresolved' ? (item.reason ?? 'memory-detail-unresolved') : undefined,
      })
      return this.pauseWithResult(state, body, false, false)
    }
    state.eventQuery = { projectKey: request.projectKey, dimension: request.target.dimension, value: request.target.value,
      afterId: 0, hasMore: false }
    return this.readEventPage(state)
  }

  private readEventPage(state: ReadState): ReadDashboardResult {
    const query = state.eventQuery
    if (query === undefined) return response('detail', 'stale', false, { readId: state.id, reason: 'event-query-missing' })
    const project = state.projectByKey.get(query.projectKey)!
    const page = state.reader.readProject(query.projectKey, { sqlStatements: 1, rowsVisited: EVENT_PAGE_SIZE + 1,
      materializedBytes: (EVENT_PAGE_SIZE + 1) * 24_000, keyBytes: textBytes(query.projectKey) + 16 },
    (store) => store.dashboardReadEventPage(query.afterId, EVENT_PAGE_SIZE))
    if (page.status !== 'ok') {
      if (page.status === 'budget-exhausted') return this.pauseWithResult(state,
        response('detail', 'budget_exhausted', false, { readId: state.id, projects: [{ key: project.key, name: project.name }], events: [] }), true, false)
      return this.abortWithOutcome(state, page, 'detail')
    }
    const events: DashboardEventDto[] = []
    let budget = false
    let unpageable = false
    let lastConsumed = query.afterId
    for (const row of page.value.rows) {
      if (!this.validEventKey(row, query.projectKey)) {
        state.overview.incomplete = true
        if (!safeInteger(row.id) || row.id < 1) { unpageable = true; break }
        lastConsumed = row.id
        continue
      }
      if (!activityTypes(state.range.activity).has(row.type!)) { lastConsumed = row.id; continue }
      const time = this.eventTime(row)
      const date = time === undefined ? undefined : localDate(time, state.range.formatter)
      if (date === undefined) { state.overview.incomplete = true; lastConsumed = row.id; continue }
      if (!state.range.dateSet.has(date)) { lastConsumed = row.id; continue }
      if (!this.matchesEventTarget(row, date, query)) { lastConsumed = row.id; continue }
      const visibility = this.verifyEvent(state, row)
      if (visibility === 'budget') { budget = true; break }
      if (typeof visibility === 'object') return this.abortWithOutcome(state, visibility.outcome, 'detail')
      if (visibility === 'unresolved') { state.overview.incomplete = true; lastConsumed = row.id; continue }
      if (visibility === 'hidden') { lastConsumed = row.id; continue }
      const exclusion = this.eventExclusion(state, row)
      if (exclusion !== 'excluded') this.noteEventProjection(state, row)
      if (exclusion === 'included') events.push(this.eventDto(row))
      lastConsumed = row.id
    }
    query.afterId = lastConsumed
    query.hasMore = !unpageable && (budget || page.value.hasMore)
    if (page.value.rows.length === 0) query.hasMore = false
    const body = response('detail', budget ? 'budget_exhausted' : state.overview.incomplete ? 'partial' : 'ok',
      !query.hasMore && !state.overview.incomplete, { readId: state.id,
        projects: [{ key: project.key, name: project.name }], events,
        reason: query.hasMore ? 'single-use-cursor-required' : undefined })
    return this.pauseWithResult(state, body, query.hasMore, false)
  }

  private matchesEventTarget(row: DashboardReadEventPageRow, date: string, query: EventQuery): boolean {
    const unknown = 'unknown'
    const value = query.dimension === 'date' ? date : query.dimension === 'source' ? safeDimension(row.source, row.sourceBytes, 512)
      : query.dimension === 'agent' ? safeDimension(row.agentId, row.agentIdBytes, 512)
        : query.dimension === 'agentPreset' ? safeDimension(row.agentPreset, row.agentPresetBytes, 512)
          : query.dimension === 'provider' ? safeDimension(row.provider, row.providerBytes, 256)
            : query.dimension === 'model' ? safeDimension(row.model, row.modelBytes, 256)
              : safeDimension(row.fingerprint, row.fingerprintBytes, 512)
    return value === query.value || query.value === unknown && value === unknown
  }

  private eventDto(row: DashboardReadEventPageRow): DashboardEventDto {
    const item: DashboardEventDto = {
      id: row.id,
      type: row.type!,
      createdAt: row.createdAt,
      eventCount: 1,
      count: row.type === 'inject_prepared' ? row.count : 1,
    }
    const source = projectionValue(row.source, row.sourceBytes, 512)
    if (source !== undefined) item.source = source
    const agentId = projectionValue(row.agentId, row.agentIdBytes, 512)
    if (agentId !== undefined) item.agentId = agentId
    const agentPreset = projectionValue(row.agentPreset, row.agentPresetBytes, 512)
    if (agentPreset !== undefined) item.agentPreset = agentPreset
    const provider = projectionValue(row.provider, row.providerBytes, 256)
    if (provider !== undefined) item.provider = provider
    const model = projectionValue(row.model, row.modelBytes, 256)
    if (model !== undefined) item.model = model
    const fingerprint = projectionValue(row.fingerprint, row.fingerprintBytes, 512)
    if (fingerprint !== undefined) item.fingerprint = fingerprint
    const sessionId = projectionValue(row.sessionId, row.sessionIdBytes, 512)
    if (sessionId !== undefined) item.sessionId = sessionId
    return item
  }

  /**
   * Bounded repeated-capture chain. The Store enumerates fingerprints, then
   * L0 members, then capture events; every candidate event is proved through
   * the same visibility session used by the overview/detail readers. Ranking
   * is published only after the complete group vector exists and the shared
   * final proof succeeds. A budget pause keeps all three cursors and pending
   * rows so the next continuation re-enters the same position.
   */
  private beginRepeated(request: Extract<ReadDashboardRequest, { action: 'repeated' }>): ReadDashboardResult {
    const state = this.stateFor(request.readId)
    if (state === undefined) return this.terminalOrStale(request.readId, 'repeated')
    if (state.range.activity !== 'capture') {
      return response('repeated', 'scope_limit', false, { readId: state.id, reason: 'repeat-capture-activity-required' })
    }
    if (request.target.kind === 'groups') {
      const requested = request.target.projectKeys === undefined
        ? state.projects.map((project) => project.key) : [...new Set(request.target.projectKeys)]
      if (requested.length === 0 || requested.length > MAX_PROJECTS) {
        return response('repeated', 'scope_limit', false, { readId: state.id, reason: 'repeat-project-scope-invalid' })
      }
      if (requested.some((key) => !state.projectByKey.has(key))) {
        return response('repeated', 'scope_limit', false, { readId: state.id, reason: 'repeat-project-not-selected' })
      }
      requested.sort()
      const filters = this.repeatFilters(request.target.filters)
      const pageLimit = Math.min(REPEAT_MAX_PAGE, Math.max(1, request.target.limit ?? REPEAT_PAGE_SIZE))
      const requestKey = JSON.stringify({ target: 'groups', projectKeys: requested, filters })
      let existingGroups: RepeatGroupsState | undefined
      let resumeStart: number | undefined
      if (request.target.after !== undefined) {
        existingGroups = state.repeatGroups
        if (existingGroups === undefined || existingGroups.requestKey !== requestKey || !existingGroups.scanDone || existingGroups.incomplete) {
          return response('repeated', 'stale', false, { readId: state.id, reason: 'repeat-ranking-cursor-invalid' })
        }
        resumeStart = this.repeatGroupAfterIndex(existingGroups.groups, request.target.after)
        if (resumeStart === undefined) {
          return response('repeated', 'stale', false, { readId: state.id, reason: 'repeat-ranking-cursor-invalid' })
        }
      }
      const resumed = this.resumeForAction(state, 'repeated')
      if (resumed !== undefined) return resumed
      state.view = 'repeated'
      state.awaitingFirstAction = false
      const output = this.reserveOutput(state, 'repeated')
      if (output !== undefined) return output
      // A plain action is a fresh query: it never replays an earlier page.
      // Only the explicit stable (repeatCount,fingerprint,projectKey) cursor
      // re-positions an already proven vector.
      let groups: RepeatGroupsState
      if (resumeStart !== undefined && existingGroups !== undefined) {
        groups = existingGroups
        groups.pageStart = resumeStart
      } else {
        groups = {
          target: 'groups', requestKey, projectKeys: requested, filters,
          scans: requested.map((projectKey): RepeatGroupScan => ({
            projectKey, fingerprintDone: false, membersDone: false, memberPending: [], memberHasMore: false, identities: new Set(),
          })),
          groups: [], scanDone: false, incomplete: false, scannedGroups: 0, scannedEvents: 0, pageStart: 0, pageLimit,
        }
        state.repeatEvents = undefined
      }
      groups.pageLimit = pageLimit
      state.repeatGroups = groups
      state.repeatTarget = 'groups'
      const step = this.scanRepeatGroups(state, groups)
      if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'repeated')
      if (step.status === 'paused') {
        return this.pauseWithResult(state, this.repeatGroupsBody(state, groups, 'budget_exhausted'), true, false)
      }
      const body = this.repeatGroupsBody(state, groups, groups.incomplete ? 'partial' : 'ok')
      return this.pauseWithResult(state, body, this.repeatGroupsCanExpose(groups), false)
    }
    const projectKey = request.target.projectKey
    if (!state.projectByKey.has(projectKey)) {
      return response('repeated', 'scope_limit', false, { readId: state.id, reason: 'repeat-project-not-selected' })
    }
    const filters = this.repeatFilters(request.target.filters)
    const includeExcerpt = request.target.includeExcerpt === true
    const pageLimit = Math.min(REPEAT_MAX_PAGE, Math.max(1, request.target.limit ?? REPEAT_PAGE_SIZE))
    const requestKey = JSON.stringify({ target: 'events', projectKey, fingerprint: request.target.fingerprint, filters, includeExcerpt })
    const resumed = this.resumeForAction(state, 'repeated')
    if (resumed !== undefined) return resumed
    state.view = 'repeated'
    state.awaitingFirstAction = false
    const output = this.reserveOutput(state, 'repeated')
    if (output !== undefined) return output
    // An action always starts a fresh event scan. Subsequent chunks are served
    // only through the exposed single-use continuation.
    const events: RepeatEventsState = {
      target: 'events', requestKey, projectKey, fingerprint: request.target.fingerprint, filters, includeExcerpt,
      pageLimit, membersDone: false, memberPending: [], memberHasMore: false, events: [], moreWork: true,
      scanDone: false, incomplete: false, scannedMembers: 0, scannedEvents: 0,
    }
    state.repeatEvents = events
    state.repeatTarget = 'events'
    const step = this.scanRepeatEvents(state, events)
    if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'repeated')
    if (step.status === 'paused') {
      return this.pauseWithResult(state, this.repeatEventsBody(state, events, 'budget_exhausted'), true, false)
    }
    const body = this.repeatEventsBody(state, events, events.incomplete ? 'partial' : 'ok')
    return this.pauseWithResult(state, body, this.repeatEventsCanExpose(events), false)
  }

  private continueRepeated(state: ReadState): ReadDashboardResult {
    if (state.repeatTarget === 'groups' && state.repeatGroups !== undefined) {
      const groups = state.repeatGroups
      const step = this.scanRepeatGroups(state, groups)
      if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'repeated')
      if (step.status === 'paused') {
        return this.pauseWithResult(state, this.repeatGroupsBody(state, groups, 'budget_exhausted'), true, false)
      }
      const body = this.repeatGroupsBody(state, groups, groups.incomplete ? 'partial' : 'ok')
      return this.pauseWithResult(state, body, this.repeatGroupsCanExpose(groups), false)
    }
    if (state.repeatTarget === 'events' && state.repeatEvents !== undefined) {
      const events = state.repeatEvents
      events.events.splice(0, events.events.length)
      const step = this.scanRepeatEvents(state, events)
      if (step.status === 'fatal') return this.abortWithOutcome(state, step.outcome, 'repeated')
      if (step.status === 'paused') {
        return this.pauseWithResult(state, this.repeatEventsBody(state, events, 'budget_exhausted'), true, false)
      }
      const body = this.repeatEventsBody(state, events, events.incomplete ? 'partial' : 'ok')
      return this.pauseWithResult(state, body, this.repeatEventsCanExpose(events), false)
    }
    return response('repeated', 'stale', false, { readId: state.id, reason: 'repeat-query-missing' })
  }

  private scanRepeatGroups(state: ReadState, groups: RepeatGroupsState): RepeatStep {
    if (groups.scanDone) return { status: 'done' }
    for (let iteration = 0; iteration < REPEAT_SCAN_ITERATIONS; iteration += 1) {
      const scan = groups.scans.find((item) => !item.fingerprintDone)
      if (scan === undefined) { groups.scanDone = true; return { status: 'done' } }
      if (scan.currentFingerprint === undefined) {
        if (!this.repeatBudgetAllows(state, REPEAT_FINGERPRINT_COST)) return { status: 'paused' }
        const read = state.reader.readProject(scan.projectKey, {
          sqlStatements: 1, rowsVisited: 1, materializedBytes: REPEAT_FINGERPRINT_ROW_BYTES,
          keyBytes: textBytes(scan.projectKey) + textBytes(scan.afterFingerprint),
        }, (store) => store.dashboardRepeatFingerprintNext(scan.afterFingerprint))
        if (read.status === 'budget-exhausted') return { status: 'paused' }
        if (read.status !== 'ok') return { status: 'fatal', outcome: read }
        if (read.value === undefined) { scan.fingerprintDone = true; continue }
        if (read.value.fingerprint === undefined || read.value.fingerprint.includes('\u0000')) {
          return this.repeatIncomplete(groups, 'repeat-fingerprint-overlong')
        }
        scan.currentFingerprint = read.value.fingerprint
        scan.identities = new Set()
        scan.memberAfter = undefined
        scan.membersDone = false
        scan.memberPending = []
        scan.memberHasMore = false
        scan.currentMember = undefined
        continue
      }
      if (scan.currentMember === undefined && scan.memberPending.length === 0 && !scan.membersDone) {
        if (!this.repeatBudgetAllows(state, REPEAT_MEMBER_COST)) return { status: 'paused' }
        const read = state.reader.readProject(scan.projectKey, {
          sqlStatements: 1, rowsVisited: REPEAT_BATCH + 1, materializedBytes: (REPEAT_BATCH + 1) * REPEAT_MEMBER_ROW_BYTES,
          keyBytes: textBytes(scan.projectKey) + textBytes(scan.currentFingerprint) + 32,
        }, (store) => store.dashboardRepeatGroupMemberPage(scan.currentFingerprint!, scan.memberAfter, REPEAT_BATCH))
        if (read.status === 'budget-exhausted') return { status: 'paused' }
        if (read.status !== 'ok') return { status: 'fatal', outcome: read }
        scan.memberPending = [...read.value.rows]
        scan.memberHasMore = read.value.hasMore
        if (scan.memberPending.length === 0) {
          if (scan.memberHasMore) return this.repeatIncomplete(groups, 'repeat-member-page-not-advancing')
          scan.membersDone = true
        }
        continue
      }
      if (scan.currentMember === undefined && scan.memberPending.length > 0) {
        const row = scan.memberPending.shift()!
        if (row.memberId === undefined || row.memberId.includes('\u0000') ||
            !Number.isSafeInteger(row.rowid) || row.rowid < 1 || row.memberIdBytes < 1 ||
            row.memberIdBytes > 256 || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) {
          return this.repeatIncomplete(groups, 'repeat-member-identity-invalid')
        }
        scan.currentMember = { row, memberId: row.memberId, eventDone: false, eventPending: [], eventHasMore: false }
        continue
      }
      const member = scan.currentMember
      if (member === undefined) {
        // The group closed; only now does the level-1 cursor advance.
        const eventCount = scan.identities.size
        groups.scannedGroups += 1
        if (eventCount > 1) {
          if (groups.groups.length >= REPEAT_GROUP_CAPACITY) return this.repeatIncomplete(groups, 'repeat-group-vector-capacity')
          groups.groups.push({ projectKey: scan.projectKey, fingerprint: scan.currentFingerprint!, repeatCount: eventCount - 1, eventCount })
        }
        scan.afterFingerprint = scan.currentFingerprint
        scan.currentFingerprint = undefined
        scan.identities = new Set()
        scan.memberAfter = undefined
        scan.membersDone = false
        scan.memberPending = []
        scan.memberHasMore = false
        continue
      }
      if (member.eventPending.length === 0 && !member.eventDone) {
        if (!this.repeatBudgetAllows(state, REPEAT_EVENT_COST)) return { status: 'paused' }
        const read = state.reader.readProject(scan.projectKey, REPEAT_EVENT_COST,
        (store) => store.dashboardRepeatCaptureEventPage(member.memberId,
          this.repeatRangeStart(state), this.repeatRangeEnd(state), member.eventAfter, REPEAT_BATCH))
        if (read.status === 'budget-exhausted') return { status: 'paused' }
        if (read.status !== 'ok') return { status: 'fatal', outcome: read }
        member.eventPending = [...read.value.rows]
        member.eventHasMore = read.value.hasMore
        if (member.eventPending.length === 0) {
          if (member.eventHasMore) return this.repeatIncomplete(groups, 'repeat-event-page-not-advancing')
          member.eventDone = true
        }
        continue
      }
      if (member.eventPending.length > 0) {
        const row = member.eventPending[0]!
        const processed = this.repeatProcessGroupEvent(state, groups, scan, member.memberId, row)
        if (processed.status === 'paused') return { status: 'paused' }
        if (processed.status === 'fatal') return { status: 'fatal', outcome: processed.outcome }
        if (processed.status === 'incomplete') return this.repeatIncomplete(groups, processed.reason)
        member.eventPending.shift()
        member.eventAfter = { createdAt: row.createdAt, id: row.id }
        if (member.eventPending.length === 0 && !member.eventHasMore) member.eventDone = true
        continue
      }
      scan.memberAfter = { createdAt: member.row.createdAt, rowid: member.row.rowid }
      scan.currentMember = undefined
      if (!scan.memberHasMore && scan.memberPending.length === 0) scan.membersDone = true
    }
    return this.repeatIncomplete(groups, 'repeat-scan-iteration-limit')
  }

  private repeatProcessGroupEvent(state: ReadState, groups: RepeatGroupsState, scan: RepeatGroupScan, memberId: string,
    row: DashboardRepeatEventRow): RepeatEventScanResult {
    if (row.identityInvalid || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0 || row.sourceId !== memberId ||
        row.l0SourceEventId?.includes('\u0000') === true || row.eventSourceEventId?.includes('\u0000') === true) {
      return { status: 'incomplete', reason: 'repeat-event-identity-invalid' }
    }
    const date = localDate(row.createdAt, state.range.formatter)
    if (date === undefined) return { status: 'incomplete', reason: 'repeat-event-time-invalid' }
    if (row.agentPresetBytes > 0 && row.agentPreset === undefined) {
      return { status: 'incomplete', reason: 'repeat-event-agent-identity-invalid' }
    }
    if (!state.range.dateSet.has(date)) return { status: 'ok' }
    if (!this.repeatMatchesFilters(row, groups.filters)) return { status: 'ok' }
    if (this.repeatEventExcluded(state, row)) return { status: 'ok' }
    if (!this.repeatBudgetAllows(state, this.repeatProofCost(state, scan.projectKey, memberId, row))) return { status: 'paused' }
    const identities = this.repeatEventIdentities(row)
    const proof = state.reader.verifyRepeatedCaptureEvent(scan.projectKey, memberId, identities)
    if (proof.status === 'budget-exhausted') return { status: 'paused' }
    if (proof.status !== 'ok') return { status: 'fatal', outcome: proof }
    if (proof.value.state === 'hidden') return { status: 'ok' }
    if (proof.value.state !== 'visible') return { status: 'incomplete', reason: proof.value.reason ?? 'repeat-event-unresolved' }
    // Logical capture identity: a real non-empty event_id, otherwise the
    // legacy row identity. Real production rows are NULL or non-empty, so this
    // preserves the old COALESCE count while a literal `legacy:<rowid>` event
    // id still collides with that row's legacy identity exactly once.
    const identity = typeof row.eventId === 'string' && row.eventId.length > 0 ? row.eventId : `legacy:${row.id}`
    if (!scan.identities.has(identity)) {
      if (scan.identities.size >= MAX_REPEAT_IDENTITIES) return { status: 'incomplete', reason: 'repeat-group-identity-capacity' }
      scan.identities.add(identity)
      groups.scannedEvents += 1
    }
    return { status: 'ok' }
  }

  private scanRepeatEvents(state: ReadState, events: RepeatEventsState): RepeatStep {
    if (events.incomplete) return { status: 'done' }
    for (let iteration = 0; iteration < REPEAT_SCAN_ITERATIONS; iteration += 1) {
      if (events.events.length >= events.pageLimit) {
        events.moreWork = this.repeatEventsHasWork(events)
        return { status: 'done' }
      }
      if (events.currentMember === undefined && events.memberPending.length === 0 && !events.membersDone) {
        if (!this.repeatBudgetAllows(state, REPEAT_MEMBER_COST)) return { status: 'paused' }
        const read = state.reader.readProject(events.projectKey, {
          sqlStatements: 1, rowsVisited: REPEAT_BATCH + 1, materializedBytes: (REPEAT_BATCH + 1) * REPEAT_MEMBER_ROW_BYTES,
          keyBytes: textBytes(events.projectKey) + textBytes(events.fingerprint) + 32,
        }, (store) => store.dashboardRepeatGroupMemberPage(events.fingerprint, events.memberAfter, REPEAT_BATCH))
        if (read.status === 'budget-exhausted') return { status: 'paused' }
        if (read.status !== 'ok') return { status: 'fatal', outcome: read }
        events.memberPending = [...read.value.rows]
        events.memberHasMore = read.value.hasMore
        if (events.memberPending.length === 0) {
          if (events.memberHasMore) return this.repeatIncomplete(events, 'repeat-member-page-not-advancing')
          events.membersDone = true
        }
        continue
      }
      if (events.currentMember === undefined && events.memberPending.length > 0) {
        const row = events.memberPending.shift()!
        if (row.memberId === undefined || row.memberId.includes('\u0000') ||
            !Number.isSafeInteger(row.rowid) || row.rowid < 1 || row.memberIdBytes < 1 ||
            row.memberIdBytes > 256 || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) {
          return this.repeatIncomplete(events, 'repeat-member-identity-invalid')
        }
        events.scannedMembers += 1
        events.currentMember = { row, memberId: row.memberId, eventDone: false, eventPending: [], eventHasMore: false }
        continue
      }
      const member = events.currentMember
      if (member === undefined) {
        events.membersDone = true
        events.scanDone = true
        events.moreWork = false
        return { status: 'done' }
      }
      if (member.eventPending.length === 0 && !member.eventDone) {
        if (!this.repeatBudgetAllows(state, REPEAT_EVENT_COST)) return { status: 'paused' }
        const read = state.reader.readProject(events.projectKey, REPEAT_EVENT_COST,
        (store) => store.dashboardRepeatCaptureEventPage(member.memberId,
          this.repeatRangeStart(state), this.repeatRangeEnd(state), member.eventAfter, REPEAT_BATCH))
        if (read.status === 'budget-exhausted') return { status: 'paused' }
        if (read.status !== 'ok') return { status: 'fatal', outcome: read }
        member.eventPending = read.value.rows.map((row): RepeatEventPendingRow => ({ row, proven: false, excerptDone: false }))
        member.eventHasMore = read.value.hasMore
        if (member.eventPending.length === 0) {
          if (member.eventHasMore) return this.repeatIncomplete(events, 'repeat-event-page-not-advancing')
          member.eventDone = true
        }
        continue
      }
      if (member.eventPending.length > 0) {
        const pending = member.eventPending[0]!
        const processed = this.repeatProcessEventDetailRow(state, events, member.memberId, pending)
        if (processed.status === 'paused') return { status: 'paused' }
        if (processed.status === 'fatal') return { status: 'fatal', outcome: processed.outcome }
        if (processed.status === 'incomplete') return this.repeatIncomplete(events, processed.reason)
        member.eventPending.shift()
        member.eventAfter = { createdAt: pending.row.createdAt, id: pending.row.id }
        if (member.eventPending.length === 0 && !member.eventHasMore) member.eventDone = true
        continue
      }
      events.memberAfter = { createdAt: member.row.createdAt, rowid: member.row.rowid }
      events.currentMember = undefined
      if (!events.memberHasMore && events.memberPending.length === 0) events.membersDone = true
    }
    return this.repeatIncomplete(events, 'repeat-scan-iteration-limit')
  }

  private repeatProcessEventDetailRow(state: ReadState, events: RepeatEventsState, memberId: string,
    pending: RepeatEventPendingRow): RepeatEventScanResult {
    const row = pending.row
    events.scannedEvents += 1
    if (row.identityInvalid || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0 || row.sourceId !== memberId ||
        row.l0SourceEventId?.includes('\u0000') === true || row.eventSourceEventId?.includes('\u0000') === true) {
      return { status: 'incomplete', reason: 'repeat-event-identity-invalid' }
    }
    const date = localDate(row.createdAt, state.range.formatter)
    if (date === undefined) return { status: 'incomplete', reason: 'repeat-event-time-invalid' }
    if (row.agentPresetBytes > 0 && row.agentPreset === undefined) {
      return { status: 'incomplete', reason: 'repeat-event-agent-identity-invalid' }
    }
    if (!state.range.dateSet.has(date)) return { status: 'ok' }
    if (!this.repeatMatchesFilters(row, events.filters)) return { status: 'ok' }
    if (this.repeatEventExcluded(state, row)) return { status: 'ok' }
    if (!pending.proven) {
      if (!this.repeatBudgetAllows(state, this.repeatProofCost(state, events.projectKey, memberId, row))) return { status: 'paused' }
      const proof = state.reader.verifyRepeatedCaptureEvent(events.projectKey, memberId, this.repeatEventIdentities(row))
      if (proof.status === 'budget-exhausted') return { status: 'paused' }
      if (proof.status !== 'ok') return { status: 'fatal', outcome: proof }
      if (proof.value.state === 'hidden') return { status: 'ok' }
      if (proof.value.state !== 'visible') return { status: 'incomplete', reason: proof.value.reason ?? 'repeat-event-unresolved' }
      pending.proven = true
    }
    if (events.includeExcerpt && !pending.excerptDone) {
      if (!this.repeatBudgetAllows(state, REPEAT_EXCERPT_COST)) return { status: 'paused' }
      const read = state.reader.readProject(events.projectKey, {
        sqlStatements: 1, rowsVisited: 1, materializedBytes: REPEAT_EXCERPT_ROW_BYTES, keyBytes: textBytes(memberId),
      }, (store) => store.dashboardRepeatExcerpt(memberId))
      if (read.status === 'budget-exhausted') return { status: 'paused' }
      if (read.status !== 'ok') return { status: 'fatal', outcome: read }
      if (read.value !== undefined) {
        const excerpt = read.value.excerpt.slice(0, 160)
        pending.excerpt = excerpt
        pending.excerptTruncated = read.value.excerptTruncated || excerpt.length < read.value.excerpt.length
      }
      pending.excerptDone = true
    }
    events.events.push({
      id: row.id, type: 'capture', ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
      createdAt: row.createdAt, projectKey: events.projectKey,
      ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
      ...((row.eventSourceEventId ?? row.l0SourceEventId) === undefined ? {}
        : { sourceEventId: row.eventSourceEventId ?? row.l0SourceEventId }),
      ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.agentId === undefined ? {} : { agentId: row.agentId }),
      ...(row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset }),
      ...(row.provider === undefined ? {} : { provider: row.provider }),
      ...(row.model === undefined ? {} : { model: row.model }),
      ...(row.fingerprint === undefined ? {} : { fingerprint: row.fingerprint }),
      ...(pending.excerpt === undefined ? {} : { excerpt: pending.excerpt }),
      ...(pending.excerptTruncated === undefined ? {} : { excerptTruncated: pending.excerptTruncated }),
    })
    return { status: 'ok' }
  }

  private repeatIncomplete(target: { incomplete: boolean; incompleteReason?: string; scanDone: boolean }, reason: string): RepeatStep {
    target.incomplete = true
    target.incompleteReason = reason
    target.scanDone = true
    return { status: 'done' }
  }

  /**
   * Stop before a charged scan step would consume the budget still needed by
   * the final control/project version probes. The response output lease is
   * already charged at the start of the RPC. Without this admission check a
   * per-call budget pause could not complete its own final proof and the
   * readId would be dropped instead of being resumable.
   */
  private repeatBudgetAllows(state: ReadState, cost: DashboardReadCost): boolean {
    const remaining = state.reader.remainingWork()
    if (remaining === undefined) return false
    const projects = Math.max(1, state.binding.projectKeys.length)
    // The 256 KiB output lease was already charged at the start of this RPC
    // (reserveOutput), so only the final control+project probes still need
    // headroom. Each per-scan operation carries its own worst-case envelope.
    const reserve: Record<keyof DashboardReadCost, number> = {
      sqlStatements: 2 + 2 * projects,
      rowsVisited: 2 + 2 * projects,
      materializedBytes: 1_024,
      keyBytes: 2_048,
    }
    for (const key of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes'] as const) {
      if (cost[key] + reserve[key] > remaining.call[key] || cost[key] + reserve[key] > remaining.session[key]) return false
    }
    return true
  }

  /** Available bounded Host identities carried by one repeated capture event. */
  private repeatEventIdentities(row: Pick<DashboardRepeatEventRow, 'l0SourceEventId' | 'eventSourceEventId'>): string[] {
    return [...new Set([row.l0SourceEventId, row.eventSourceEventId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0))]
  }

  /**
   * Derive one repeated-capture proof envelope from its exact identities and
   * session binding. Query cache leases use max(256, projected bytes); each
   * identity also gets a temporary lease, and the semantic continuation keeps
   * a 512-byte header plus its UTF-8 key. The final margin stays conservative.
   */
  private repeatProofCost(state: ReadState, projectKey: string, sourceId: string, row: DashboardRepeatEventRow): DashboardReadCost {
    const projectBytes = textBytes(projectKey)
    const sourceBytes = textBytes(sourceId)
    const identities = this.repeatEventIdentities(row)
    let identityBytes = 0
    let leaseBytes = 0
    for (const identity of identities) {
      const bytes = textBytes(identity)
      identityBytes += bytes
      leaseBytes += Math.max(256, bytes * 2 + 128)
    }
    const proofContextBytes = 512 + textBytes(JSON.stringify([
      'managed-proof-continuation', state.binding, 'repeat-capture-event', projectKey, sourceId, identities,
    ]))
    return {
      sqlStatements: 2 + (identities.length > 0 ? 1 : 0) + REPEAT_PROOF_MARGIN_SQL,
      rowsVisited: 2 + identities.length + REPEAT_PROOF_MARGIN_ROWS,
      materializedBytes: Math.max(256, 96) + Math.max(256, 20_608) +
        (identities.length > 0 ? Math.max(256, identities.length * 96) : 0) + leaseBytes + proofContextBytes +
        REPEAT_PROOF_MARGIN_BYTES,
      keyBytes: 2 * (projectBytes + sourceBytes) +
        (identities.length > 0 ? projectBytes + identityBytes : 0) + REPEAT_PROOF_MARGIN_KEY_BYTES,
    }
  }

  private repeatFilters(input: RepeatFilters | undefined): RepeatFilters {
    if (input === undefined) return {}
    return {
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      ...(input.source === undefined ? {} : { source: input.source }),
    }
  }

  private repeatRangeStart(state: ReadState): number {
    const bounds = state.range.bounds.get(state.range.from)
    if (bounds === undefined) throw new Error('repeat range start is unavailable')
    return bounds.start
  }

  private repeatRangeEnd(state: ReadState): number {
    const bounds = state.range.bounds.get(state.range.to)
    if (bounds === undefined) throw new Error('repeat range end is unavailable')
    return bounds.end
  }

  private repeatDimension(value: string | undefined, bytes: number, maximum: number): string {
    return projectionValue(value, bytes, maximum) ?? 'unknown'
  }

  private repeatMatchesFilters(row: Pick<DashboardRepeatEventRow, 'source' | 'sourceBytes' | 'agentId' | 'agentIdBytes' | 'agentPreset' | 'agentPresetBytes'>, filters: RepeatFilters): boolean {
    if (filters.source !== undefined && this.repeatDimension(row.source, row.sourceBytes, 512) !== filters.source) return false
    if (filters.agentId !== undefined && this.repeatDimension(row.agentId, row.agentIdBytes, 512) !== filters.agentId) return false
    if (filters.agentPreset !== undefined && this.repeatDimension(row.agentPreset, row.agentPresetBytes, 512) !== filters.agentPreset) return false
    return true
  }

  private repeatEventExcluded(state: ReadState, row: Pick<DashboardRepeatEventRow, 'agentPreset' | 'agentPresetBytes'>): boolean {
    if (row.agentPreset === undefined && row.agentPresetBytes === 0) return false
    const preset = projectionValue(row.agentPreset, row.agentPresetBytes, 512)
    if (preset === undefined) return false
    return state.excludedAgentPatterns.some((pattern) => matchesAgentGlob(preset, pattern))
  }

  private repeatGroupAfterIndex(groups: RepeatGroupEntry[], cursor: RepeatRankCursor): number | undefined {
    const sorted = groups.slice().sort(compareRepeatGroups)
    const index = sorted.findIndex((group) => group.projectKey === cursor.projectKey &&
      group.fingerprint === cursor.fingerprint && group.repeatCount === cursor.repeatCount)
    return index < 0 ? undefined : index + 1
  }

  private repeatGroupsCanExpose(groups: RepeatGroupsState): boolean {
    if (groups.incomplete) return false
    return !groups.scanDone || groups.pageStart < groups.groups.length
  }

  private repeatEventsHasWork(events: RepeatEventsState): boolean {
    const member = events.currentMember
    if (member !== undefined && (member.eventPending.length > 0 || !member.eventDone || member.eventHasMore)) return true
    if (events.memberPending.length > 0) return true
    return !events.membersDone
  }

  private repeatEventsCanExpose(events: RepeatEventsState): boolean {
    if (events.incomplete) return false
    return !events.scanDone || this.repeatEventsHasWork(events)
  }

  private repeatGroupsBody(state: ReadState, groups: RepeatGroupsState, statusOverride?: DashboardStatus): ReadDashboardResult {
    const sorted = groups.groups.slice().sort(compareRepeatGroups)
    const page: RepeatGroupEntry[] = []
    if (groups.scanDone) {
      const start = Math.max(0, Math.min(groups.pageStart, sorted.length))
      const slice = sorted.slice(start, start + groups.pageLimit)
      page.push(...slice)
      groups.pageStart = start + slice.length
    }
    const complete = groups.scanDone && !groups.incomplete
    const hasMore = complete && groups.pageStart < sorted.length
    const repeated: DashboardRepeatedDto = {
      target: 'groups', complete, hasMore,
      ...(groups.scanDone ? { groups: page.map((group): DashboardRepeatedGroupDto => ({
        projectKey: group.projectKey, projectName: state.projectByKey.get(group.projectKey)?.name ?? group.projectKey,
        fingerprint: group.fingerprint, repeatCount: group.repeatCount, eventCount: group.eventCount,
      })) } : {}),
      projectKeys: [...groups.projectKeys],
      scannedGroups: groups.scannedGroups, scannedEvents: groups.scannedEvents,
      ...(hasMore ? { reason: 'single-use-cursor-required' } : {}),
      ...(groups.incomplete ? { reason: failureReason(groups.incompleteReason ?? 'repeat-scan-incomplete') } : {}),
    }
    const status = statusOverride ?? (complete ? 'ok' : groups.scanDone ? 'partial' : 'budget_exhausted')
    return response('repeated', status, complete, {
      readId: state.id,
      projects: groups.projectKeys.map((key) => ({ key, name: state.projectByKey.get(key)?.name ?? key })),
      repeated,
      ...(groups.incomplete ? { reason: failureReason(groups.incompleteReason ?? 'repeat-scan-incomplete') } : {}),
    })
  }

  private repeatEventsBody(state: ReadState, events: RepeatEventsState, statusOverride?: DashboardStatus): ReadDashboardResult {
    const chunk = events.events.splice(0, events.events.length)
    const work = this.repeatEventsHasWork(events)
    const complete = events.scanDone && !events.incomplete && !work
    const hasMore = !events.incomplete && work
    const repeated: DashboardRepeatedDto = {
      target: 'events', fingerprint: events.fingerprint, complete, hasMore, events: chunk,
      ...(hasMore ? { reason: 'single-use-cursor-required' } : {}),
      ...(events.incomplete ? { reason: failureReason(events.incompleteReason ?? 'repeat-scan-incomplete') } : {}),
    }
    const status = statusOverride ?? (events.incomplete ? 'partial' : 'ok')
    return response('repeated', status, complete, {
      readId: state.id,
      projects: [{ key: events.projectKey, name: state.projectByKey.get(events.projectKey)?.name ?? events.projectKey }],
      repeated,
      ...(events.incomplete ? { reason: failureReason(events.incompleteReason ?? 'repeat-scan-incomplete') } : {}),
    })
  }

  private processOverviewStep(state: ReadState): OverviewStep {
    return withDashboardOverviewFusion(state.reader, () => this.processOverviewTasks(state))
  }

  private processOverviewTasks(state: ReadState): OverviewStep {
    // Keep final RPC version probes affordable throughout this scheduler slice.
    // Individual page tasks may temporarily raise the reserve while proving a row.
    const releaseHandoffReserve = state.reader.beginPersonaProofGuard(1)
    const blocked = new Set<string>()
    const progressKey = (): string => JSON.stringify({
      tasks: this.overviewTasks(state).map((task) => task.key),
      projects: state.projects.map((project) => [project.key, project.eventDone, project.eventAfter,
        project.eventPage?.rows.length, project.eventPage?.hasMore,
        project.approved.done, project.approved.after, project.approved.count, project.approved.incomplete,
        project.candidate.done, project.candidate.after, project.candidate.count, project.candidate.incomplete,
        project.forgotten.done, project.forgotten.after, project.forgotten.count, project.forgotten.incomplete]),
      overview: [state.overview.attemptsAfter, state.overview.attemptsDone, state.overview.attemptsIncomplete,
        state.overview.billableAfter, state.overview.billableDone, state.overview.billableIncomplete,
        state.overview.attemptPage?.index, state.overview.billablePage?.index,
        state.overview.coverageAfter, state.overview.coverageDone, state.overview.coverageTruncated, state.overview.incomplete],
      processing: [state.processingScan.projectKey, state.processingScan.after, state.processingScan.summaryDone,
        state.processingScan.done, state.processingScan.pending.map((job) => [job.id, job.afterSourceId]),
        state.processingScan.queued, state.processingScan.failed, state.processingScan.uncertainUsage,
        state.processingScan.oldestWaitingAt, state.processingScan.incomplete],
      page: [state.page.projectIndex, state.page.candidateAfter, state.page.recentAfter,
        state.page.candidateDone, state.page.recentDone, state.page.candidateCount, state.page.recentCount,
        state.page.candidates.length, state.page.recent.length, state.page.done, state.page.incomplete],
    })
    const rotateAfter = (key: string): void => {
      const current = this.overviewTasks(state)
      const successor = current.findIndex((candidate) => candidate.key === key)
      state.overview.taskOffset = successor >= 0 ? successor : 0
    }
    try {
      for (let step = 0; step < OVERVIEW_TASK_STEPS_PER_RPC; step += 1) {
        const tasks = this.overviewTasks(state)
        if (tasks.length === 0) return { status: 'ok' }
        const total = tasks.length
        let selected = -1
        for (let offset = 0; offset < total; offset += 1) {
          const index = (state.overview.taskOffset + offset) % total
          if (!blocked.has(tasks[index]!.key)) { selected = index; break }
        }
        if (selected < 0) return { status: 'budget_exhausted' }

        const task = tasks[selected]!
        const beforeProgress = progressKey()
        const beforeWork = state.reader.remainingReadWorkBreakdown()
        if (beforeWork === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
        const nextKey = tasks[(selected + 1) % total]!.key
        const result = task.run()
        if (result.status === 'fatal') return result
        if (result.status === 'budget_exhausted') {
          if (state.reader.remainingReadWorkBreakdown() === undefined) {
            return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
          }
          rotateAfter(nextKey)
          blocked.add(task.key)
          continue
        }

        const afterWork = state.reader.remainingReadWorkBreakdown()
        if (afterWork === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
        const workChanged = JSON.stringify(beforeWork.call) !== JSON.stringify(afterWork.call) ||
          JSON.stringify(beforeWork.session) !== JSON.stringify(afterWork.session)
        if (!workChanged && beforeProgress === progressKey()) {
          return { status: 'fatal', outcome: { status: 'unavailable-probe', reason: 'overview-task-no-progress' } }
        }

        // Work budgets are monotonic within this call. Keep previously blocked
        // tasks out until the next RPC so their raw pages/proofs are not paid twice.
        rotateAfter(nextKey)
      }
      // The bounded scheduler slice yields resumably; remaining tasks stay pending.
      return { status: 'ok' }
    } finally { releaseHandoffReserve() }
  }

  private overviewTasks(state: ReadState): Array<{ key: string; run: () => OverviewStep }> {
    const tasks: Array<{ key: string; run: () => OverviewStep }> = []
    for (const project of state.projects) {
      if (!project.eventDone) tasks.push({ key: `event:${project.key}`, run: () => this.scanEvent(state, project) })
      if (!project.approved.done) tasks.push({ key: `approved:${project.key}`, run: () => this.scanMemories(state, project, 'approved') })
      if (!project.candidate.done) tasks.push({ key: `candidate:${project.key}`, run: () => this.scanMemories(state, project, 'candidate') })
      if (!project.forgotten.done) tasks.push({ key: `forgotten:${project.key}`, run: () => this.scanMemories(state, project, 'forgotten') })
    }
    if (!state.overview.attemptsDone) tasks.push({ key: 'attempts', run: () => this.scanAttempts(state) })
    if (!state.overview.billableDone) tasks.push({ key: 'billable', run: () => this.scanBillable(state) })
    if (!state.overview.coverageDone) tasks.push({ key: 'coverage', run: () => this.scanCoverage(state) })
    if (!state.processingScan.done) tasks.push({ key: 'processing', run: () => this.scanProcessing(state) })
    if (!state.page.done) tasks.push({ key: 'page', run: () => this.scanPage(state) })
    return tasks
  }

  private scanProcessing(state: ReadState): OverviewStep {
    const scan = state.processingScan
    const project = state.focusProjectKey === undefined ? state.projects[0] : state.projectByKey.get(state.focusProjectKey)
    if (project === undefined) { scan.done = true; return { status: 'ok' } }
    if (scan.projectKey !== undefined && scan.projectKey !== project.key) {
      scan.projectKey = project.key; scan.after = undefined; scan.summaryDone = false; scan.done = false; scan.pending = []
      scan.queued = 0; scan.failed = 0; scan.uncertainUsage = 0; scan.oldestWaitingAt = null; scan.incomplete = false
    }
    scan.projectKey = project.key
    if (scan.pending.length > 0) return this.scanProcessingSources(state, project)
    const remaining = state.reader.remainingReadWorkBreakdown()
    if (remaining === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
    const finalProof = this.overviewFinalProofReserve(state)
    const summaryCost: DashboardReadCost = { sqlStatements: 1, rowsVisited: 16,
      materializedBytes: 16 * PROCESSING_ROW_BYTES, keyBytes: textBytes(project.key) + textBytes(scan.after?.id) }
    if (!this.processingBudgetFits(remaining, summaryCost, finalProof)) {
      return this.processingBudgetFits({ call: remaining.session, session: remaining.session }, summaryCost, finalProof)
        ? { status: 'budget_exhausted' }
        : { status: 'fatal', outcome: { status: 'budget-exhausted', reason: 'persona-session-headroom' } }
    }
    const page = state.reader.readProject(project.key, summaryCost,
      (store) => store.dashboardProcessingSummaryPage(scan.after, 15))
    if (page.status !== 'ok') return this.overviewBudgetFailure(page)
    for (const row of page.value.rows) {
      if (row.id === undefined || row.id.length < 1 || row.idBytes < 1 || row.idBytes > 256 ||
          textBytes(row.id) !== row.idBytes || row.statusBytes < 1 || row.statusBytes > 64 ||
          row.status === undefined || row.createdAt === undefined || row.updatedAt === undefined) { scan.incomplete = true; continue }
      if (row.agentPresetBytes > 512 || row.agentPreset !== undefined &&
          (row.agentPresetBytes < 1 || textBytes(row.agentPreset) !== row.agentPresetBytes)) { scan.incomplete = true; continue }
      if (row.agentPreset !== undefined && state.excludedAgentPatterns.some((pattern) => matchesAgentGlob(row.agentPreset!, pattern))) continue
      if (row.status === 'failed' || row.status === 'source_pruned') scan.failed += 1
      if (row.status === 'uncertain_remote' || row.status === 'blocked_charged') scan.uncertainUsage += 1
      if (row.status === 'queued' || row.status === 'ready' || row.status === 'dispatching') {
        if (row.sessionId === undefined || row.sessionIdBytes < 1 || row.sessionIdBytes > 512 ||
            textBytes(row.sessionId) !== row.sessionIdBytes) { scan.incomplete = true; continue }
        if (scan.pending.length >= MAX_PROCESSING_PENDING) { scan.incomplete = true; continue }
        scan.pending.push({ id: row.id!, sessionId: row.sessionId, createdAt: row.createdAt })
      }
    }
    const last = page.value.rows.at(-1)
    if (last === undefined) scan.summaryDone = true
    else if (last.id === undefined || last.id.length < 1 || textBytes(last.id) > 256) {
      scan.incomplete = true; scan.summaryDone = true
    } else { scan.after = { id: last.id }; scan.summaryDone = !page.value.hasMore }
    scan.done = scan.summaryDone && scan.pending.length === 0
    if (scan.done && scan.incomplete) state.overview.incomplete = true
    return { status: 'ok' }
  }

  /** Final handoff re-probes control + every selected project; every probe is two SQL/two rows. */
  private overviewFinalProofReserve(state: ReadState): DashboardReadCost {
    if (typeof state.reader.finalBoundaryCost === 'function') return state.reader.finalBoundaryCost()
    const probes = 2 * (1 + state.projects.length)
    return { sqlStatements: probes, rowsVisited: probes, materializedBytes: 0, keyBytes: 0 }
  }

  private processingBudgetFits(remaining: { call: DashboardReadCost; session: DashboardReadCost },
    need: DashboardReadCost, reserve: DashboardReadCost): boolean {
    const fits = (available: DashboardReadCost): boolean =>
      need.sqlStatements + reserve.sqlStatements <= available.sqlStatements &&
      need.rowsVisited + reserve.rowsVisited <= available.rowsVisited &&
      need.materializedBytes + reserve.materializedBytes <= available.materializedBytes &&
      need.keyBytes + reserve.keyBytes <= available.keyBytes
    return fits(remaining.call) && fits(remaining.session)
  }

  /** Only a call-local headroom refusal can resume without losing its cause. */
  private overviewBudgetFailure(outcome: DashboardReadFailure): OverviewStep {
    return outcome.status === 'budget-exhausted' && outcome.reason === 'persona-call-headroom'
      ? { status: 'budget_exhausted' } : { status: 'fatal', outcome }
  }

  /** One source page plus at most `limit` point reads, sentinel and retained pending residency. */
  private processingSourceCost(state: ReadState, projectKey: string, afterSourceId: string | undefined,
    limit: number): DashboardReadCost {
    return { sqlStatements: 1 + limit,
      rowsVisited: (limit + 1) + limit,
      materializedBytes: (limit + 1) * PROCESSING_SOURCE_ROW_BYTES + limit * 256 +
        state.processingScan.pending.length * PROCESSING_PENDING_BYTES,
      keyBytes: textBytes(projectKey) + textBytes(afterSourceId) + 1_024 }
  }

  private scanProcessingSources(state: ReadState, project: ProjectScan): OverviewStep {
    const scan = state.processingScan
    const job = scan.pending[0]
    if (job === undefined) { scan.done = scan.summaryDone; return { status: 'ok' } }
    // One charged operation holds the raw source page, its sentinel row and at
    // most 15 primary-key point reads. Select the smallest batch that fits all
    // four call/session dimensions while reserving the final control/project
    // probes; the retained pending queue contributes a bounded residency term.
    // The page is charged atomically, so a budget refusal never half-reads and
    // a continuation never re-pays for the same source range.
    const remaining = state.reader.remainingReadWorkBreakdown()
    if (remaining === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
    const reserve = this.overviewFinalProofReserve(state)
    let sourceLimit = 0
    let need: DashboardReadCost | undefined
    // Largest admissible batch first; overview's round-robin scheduler may run
    // several bounded tasks per RPC, and this source batch must still leave the
    // final handoff probes reserved.
    for (let limit = 15; limit >= 1; limit -= 1) {
      const candidate = this.processingSourceCost(state, project.key, job.afterSourceId, limit)
      if (this.processingBudgetFits(remaining, candidate, reserve)) { sourceLimit = limit; need = candidate; break }
    }
    if (sourceLimit < 1 || need === undefined) {
      const oneSource = this.processingSourceCost(state, project.key, job.afterSourceId, 1)
      return this.processingBudgetFits({ call: remaining.session, session: remaining.session }, oneSource, reserve)
        ? { status: 'budget_exhausted' }
        : { status: 'fatal', outcome: { status: 'budget-exhausted', reason: 'persona-session-headroom' } }
    }
    const page = state.reader.readProject(project.key, need, (store) => {
      const sourcePage = store.dashboardProcessingSourcePage(job.id, job.afterSourceId, sourceLimit)
      const checks = sourcePage.rows.flatMap((row) => {
        // SQL NULL, empty text, and non-text SQLite values are not a verified
        // different session. In particular, a zero-byte BLOB has no string
        // projection but must not be treated as a legitimate missing owner.
        const sessionParsed = row.sessionIdType === 'text' && row.sessionId !== undefined &&
          row.sessionIdBytes >= 1 && row.sessionIdBytes <= 512 && textBytes(row.sessionId) === row.sessionIdBytes
        if (row.sourceId === undefined || row.sourceIdBytes < 1 || row.sourceIdBytes > 256 ||
            textBytes(row.sourceId) !== row.sourceIdBytes || !sessionParsed) return []
        return [{ sourceId: row.sourceId, sessionMatches: row.sessionId === job.sessionId,
          point: row.sessionId === job.sessionId ? store.dashboardProcessingSourcePending(row.sourceId) : undefined }]
      })
      return { sourcePage, checks }
    })
    if (page.status !== 'ok') return this.overviewBudgetFailure(page)
    const { sourcePage, checks } = page.value
    if (checks.length < sourcePage.rows.length) {
      scan.incomplete = true
      scan.pending.shift()
      scan.done = scan.summaryDone && scan.pending.length === 0
      if (scan.done && scan.incomplete) state.overview.incomplete = true
      return { status: 'ok' }
    }
    const pending = checks.some((check) => check.sessionMatches && check.point?.exists === true && check.point.pending === true)
    const lastSource = checks.at(-1)?.sourceId
    if (pending) {
      scan.queued += 1
      if (scan.oldestWaitingAt === null || job.createdAt < scan.oldestWaitingAt) scan.oldestWaitingAt = job.createdAt
      scan.pending.shift()
    } else if (sourcePage.hasMore && lastSource !== undefined) {
      job.afterSourceId = lastSource
    } else {
      if (sourcePage.hasMore) scan.incomplete = true
      scan.pending.shift()
    }
    scan.done = scan.summaryDone && scan.pending.length === 0
    if (scan.done && scan.incomplete) state.overview.incomplete = true
    return { status: 'ok' }
  }

  private scanPage(state: ReadState): OverviewStep {
    const pageState = state.page
    // Trusted aggregate pages keep row-level source/revocation checks and defer
    // scope/version validation to the enclosing RPC handoff.
    const releaseFinalProofGuard = state.reader.beginPersonaProofGuard(1)
    try {
      if (pageState.projectIndex >= state.projects.length) {
        pageState.done = true
        if (pageState.incomplete) state.overview.incomplete = true
        return { status: 'ok' }
      }

      const project = state.projects[pageState.projectIndex]!
      if (!pageState.candidateDone && pageState.candidateCount < 6) {
        const candidate = readDashboardManagedPageForAggregate(state.reader, project.key, 'candidate',
          pageState.candidateAfter, 1, 16 * 1024, `page:${project.key}`)
        if (candidate.status === 'budget-exhausted') return this.overviewBudgetFailure(candidate)
        if (candidate.status !== 'ok') return { status: 'fatal', outcome: candidate }
        for (const item of candidate.value.items) {
          const memory = this.pageMemory(item, project)
          if (memory === undefined) pageState.incomplete = true
          else if (pageState.candidateCount < 6) { pageState.candidates.push(memory); pageState.candidateCount += 1 }
        }
        pageState.candidateAfter = candidate.value.nextCursor
        if (!candidate.value.hasMore || pageState.candidateCount >= 6) pageState.candidateDone = true
        else if (pageState.candidateAfter === undefined) { pageState.incomplete = true; pageState.candidateDone = true }
        return { status: 'ok' }
      }
      pageState.candidateDone = true

      if (!pageState.recentDone && pageState.recentCount < 6) {
        const recent = readDashboardRecentManagedPageForAggregate(state.reader, project.key,
          pageState.recentAfter, 1, 16 * 1024)
        if (recent.status === 'budget-exhausted') return this.overviewBudgetFailure(recent)
        if (recent.status !== 'ok') return { status: 'fatal', outcome: recent }
        for (const item of recent.value.items) {
          const memory = this.pageMemory(item, project)
          if (memory === undefined) pageState.incomplete = true
          else if (pageState.recentCount < 6) { pageState.recent.push(memory); pageState.recentCount += 1 }
        }
        pageState.recentAfter = recent.value.nextCursor
        if (!recent.value.hasMore || pageState.recentCount >= 6) pageState.recentDone = true
        else if (pageState.recentAfter === undefined) { pageState.incomplete = true; pageState.recentDone = true }

        if (pageState.recentDone) {
          pageState.projectIndex += 1
          pageState.candidateAfter = undefined
          pageState.recentAfter = undefined
          pageState.candidateDone = false
          pageState.recentDone = false
          pageState.candidateCount = 0
          pageState.recentCount = 0
          pageState.done = pageState.projectIndex >= state.projects.length
          if (pageState.done && pageState.incomplete) state.overview.incomplete = true
        }
        return { status: 'ok' }
      }

      pageState.recentDone = true
      pageState.projectIndex += 1
      pageState.candidateAfter = undefined
      pageState.recentAfter = undefined
      pageState.candidateDone = false
      pageState.recentDone = false
      pageState.candidateCount = 0
      pageState.recentCount = 0
      pageState.done = pageState.projectIndex >= state.projects.length
      if (pageState.done && pageState.incomplete) state.overview.incomplete = true
      return { status: 'ok' }
    } finally { releaseFinalProofGuard() }
  }

  private pageMemory(item: DashboardVisibilityItem, project: ProjectScan): DashboardPageMemory | undefined {
    const summary = item.summary
    if (summary !== undefined) return { ...summary, projectKey: project.key, projectName: project.name,
      ...(item.record?.content === undefined ? {} : { content: item.record.content }) }
    const record = item.record
    if (record === undefined || item.state !== 'visible') return undefined
    return this.pageMemoryFromRecord(record, project)
  }

  private pageMemoryFromRecord(record: MemoryRecord, project: ProjectScan): DashboardPageMemory {
    return {
      id: record.id, kind: record.kind, ...(record.scene === undefined ? {} : { scene: record.scene }), confidence: record.confidence,
      status: record.status, source: record.source, sourceMessageIds: record.sourceMessageIds,
      contentBytes: textBytes(record.content), createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
      ...(record.forgottenAt === undefined ? {} : { forgottenAt: record.forgottenAt }), revision: record.revision,
      ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }), validFromState: record.validFromState,
      validFromPrecision: record.validFromPrecision, validFromBasis: record.validFromBasis,
      ...(record.validFromUpper === undefined ? {} : { validFromUpper: record.validFromUpper }),
      ...(record.validFromLabel === undefined ? {} : { validFromLabel: record.validFromLabel }),
      ...(record.validTo === undefined ? {} : { validTo: record.validTo }), recordedAt: record.recordedAt,
      ...(record.supersededAt === undefined ? {} : { supersededAt: record.supersededAt }),
      sourceVerified: record.sourceVerified,
      // Base MemoryRecord has no expiryAt. Visibility's approved/candidate
      // records may carry a numeric expiry; preserve it only when it actually
      // exists and is a number, otherwise omit the field.
      ...('expiryAt' in record && typeof record.expiryAt === 'number' ? { expiryAt: record.expiryAt } : {}),
      projectKey: project.key, projectName: project.name, content: record.content,
    }
  }

  private scanEvent(state: ReadState, project: ProjectScan): OverviewStep {
    const releaseFinalProofGuard = state.reader.beginPersonaProofGuard(1)
    try {
      if (project.eventPage === undefined) {
        let throughId: number | undefined
        if (state.projects.length > 1 && typeof state.reader.readOverviewEventTail === 'function') {
          const tail = state.reader.readOverviewEventTail(project.key)
          if (tail.status !== 'ok') return this.overviewBudgetFailure(tail)
          if (tail.value < project.eventAfter) return { status: 'fatal', outcome: { status: 'stale', reason: 'overview-event-tail-changed' } }
          throughId = tail.value
          if (throughId === project.eventAfter) { project.eventDone = true; return { status: 'ok' } }
        }
        // The immutable header ceiling also constrains SQL, so it bounds the
        // raw sentinel and retained copies before either is materialized.
        const remainingRows = throughId === undefined ? Number.MAX_SAFE_INTEGER : throughId - project.eventAfter
        const cursorKeyBytes = textBytes(project.key) + (throughId === undefined ? 16 : 32)
        const remaining = state.reader.remainingReadWorkBreakdown()
        if (remaining === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
        const finalProof = this.overviewFinalProofReserve(state)
        let pageLimit = 0
        let queryCost: DashboardReadCost | undefined
        let pageCost: DashboardReadCost | undefined
        for (let limit = Math.min(remainingRows, state.projects.length > 1 ? 3 : EVENT_PAGE_SIZE); limit >= 1; limit -= 1) {
          const rawRows = Math.min(remainingRows, limit + 1)
          const candidateQuery: DashboardReadCost = { sqlStatements: 1, rowsVisited: rawRows,
            materializedBytes: rawRows * EVENT_PAGE_ROW_BYTES, keyBytes: cursorKeyBytes }
          const candidatePage: DashboardReadCost = { ...candidateQuery,
            materializedBytes: candidateQuery.materializedBytes + limit * EVENT_PAGE_ROW_BYTES }
          if (this.processingBudgetFits(remaining, candidatePage, finalProof)) {
            pageLimit = limit
            queryCost = candidateQuery
            pageCost = candidatePage
            break
          }
        }
        if (pageLimit === 0 || queryCost === undefined || pageCost === undefined) {
          const oneRowQuery: DashboardReadCost = { sqlStatements: 1, rowsVisited: Math.min(remainingRows, 2),
            materializedBytes: Math.min(remainingRows, 2) * EVENT_PAGE_ROW_BYTES, keyBytes: cursorKeyBytes }
          const oneRowPage: DashboardReadCost = { ...oneRowQuery,
            materializedBytes: oneRowQuery.materializedBytes + EVENT_PAGE_ROW_BYTES }
          return this.processingBudgetFits({ call: remaining.session, session: remaining.session }, oneRowPage, finalProof)
            ? { status: 'budget_exhausted' }
            : { status: 'fatal', outcome: { status: 'budget-exhausted', reason: 'persona-session-headroom' } }
        }
        // Admit both the raw SELECT and the bounded continuation residency
        // before touching SQLite. A denied event proof below leaves this page
        // in the read state, so the next cursor never re-reads proved rows.
        const lease = state.reader.reserveReadState(pageLimit * EVENT_PAGE_ROW_BYTES)
        if (lease.status !== 'ok') return this.overviewBudgetFailure(lease)
        const page = state.reader.readProject(project.key, queryCost,
          (store) => store.dashboardReadEventPage(project.eventAfter, pageLimit, throughId))
        if (page.status !== 'ok') {
          const released = state.reader.releaseReadState(lease.value.reservationToken)
          if (page.status !== 'budget-exhausted') return { status: 'fatal', outcome: page }
          return released.status === 'ok' ? this.overviewBudgetFailure(page) : { status: 'fatal', outcome: released }
        }
        if (page.value.rows.length === 0) {
          const released = state.reader.releaseReadState(lease.value.reservationToken)
          if (released.status !== 'ok') return { status: 'fatal', outcome: released }
          if (page.value.hasMore) {
            state.overview.incomplete = true
            state.overview.sessionCaptureIncomplete = true
            state.overview.sessionIncomplete = true
          }
          project.eventDone = true
          return { status: 'ok' }
        }
        project.eventPage = { rows: page.value.rows, hasMore: page.value.hasMore,
          reservationToken: lease.value.reservationToken }
      }
      const pending = project.eventPage
      if (pending === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'event-page-buffer-missing' } }
      while (pending.rows.length > 0) {
        const row = pending.rows[0]!
        if (!this.validEventKey(row, project.key)) {
          state.overview.incomplete = true
          state.overview.sessionCaptureIncomplete = true
          state.overview.sessionIncomplete = true
          if (!safeInteger(row.id) || row.id < 1) {
            project.eventDone = true
            pending.hasMore = false
            pending.rows.length = 0
            break
          }
          project.eventAfter = row.id
          pending.rows.shift()
          continue
        }
        const type = row.type!
        if (!['capture', 'recall_returned', 'recall_no_result', 'revision', 'initial_approval', 'inject_prepared'].includes(type)) {
          if (!KNOWN_NON_ACTIVITY_EVENT_TYPES.has(type)) {
            state.overview.incomplete = true
            state.overview.sessionCaptureIncomplete = true
            state.overview.sessionIncomplete = true
          }
          project.eventAfter = row.id
          pending.rows.shift()
          continue
        }
        const timestamp = this.eventTime(row)
        const date = timestamp === undefined ? undefined : localDate(timestamp, state.range.formatter)
        if (date === undefined) {
          state.overview.incomplete = true
          if (row.type === 'capture') {
            state.overview.sessionCaptureIncomplete = true
            state.overview.sessionIncomplete = true
          }
          project.eventAfter = row.id
          pending.rows.shift()
          continue
        }
        if (!state.range.dateSet.has(date)) { project.eventAfter = row.id; pending.rows.shift(); continue }
        const visibility = this.verifyEvent(state, row)
        if (visibility === 'budget') return { status: 'budget_exhausted' }
        if (typeof visibility === 'object') return { status: 'fatal', outcome: visibility.outcome }
        if (visibility === 'unresolved') {
          state.overview.incomplete = true
          if (row.type === 'capture') {
            state.overview.sessionCaptureIncomplete = true
            state.overview.sessionIncomplete = true
          }
        } else if (visibility === 'visible') {
          const exclusion = this.eventExclusion(state, row)
          if (exclusion === 'included') {
            this.countEvent(state, row, date)
            this.noteSessionEvent(state, row)
          }
          // Known excluded rows stay invisible. Unknown presets retain only a
          // bounded session uncertainty marker; included rows first establish
          // their visible aggregate so projection defects stay session-local.
          if (exclusion !== 'excluded') this.noteEventProjection(state, row)
        }
        project.eventAfter = row.id
        pending.rows.shift()
      }
      project.eventDone = !pending.hasMore
      project.eventPage = undefined
      const released = state.reader.releaseReadState(pending.reservationToken)
      if (released.status !== 'ok') return { status: 'fatal', outcome: released }
      return { status: 'ok' }
    } finally { releaseFinalProofGuard() }
  }

  private scanMemories(state: ReadState, project: ProjectScan, status: 'approved' | 'candidate' | 'forgotten'):
    OverviewStep {
    const scan = status === 'approved' ? project.approved : status === 'candidate' ? project.candidate : project.forgotten
    const page = readDashboardManagedPageForAggregate(state.reader, project.key, status, scan.after, MEMORY_PAGE_SIZE, null,
      `overview:${project.key}:${status}`)
    if (page.status === 'budget-exhausted') return this.overviewBudgetFailure(page)
    if (page.status !== 'ok') return { status: 'fatal', outcome: page }
    for (const item of page.value.items) {
      if (item.state === 'visible') {
        const summary = item.summary
        if (summary === undefined) {
          if (status === 'approved') {
            scan.incomplete = true
            state.overview.currentIncomplete.approved = true
            state.overview.incomplete = true
          }
          continue
        }
        if (status === 'approved') {
          const sourceIds: unknown = summary.sourceMessageIds
          const validSourceProof = Array.isArray(sourceIds) && sourceIds.length > 0 &&
            sourceIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && Buffer.byteLength(id, 'utf8') <= 256)
          const trustedDirectOrigin = Array.isArray(sourceIds) && sourceIds.length === 0 &&
            summary[dashboardAggregateDirectOriginProof] === true
          if (!validSourceProof && !trustedDirectOrigin) {
            // Empty or malformed source lists need trusted direct-creation
            // evidence; uncertain rows are excluded from the known lower bound.
            scan.incomplete = true
            state.overview.currentIncomplete.approved = true
            state.overview.incomplete = true
            continue
          }
        }
        scan.count += 1
        if (status === 'approved') state.overview.current.effectiveMemories += 1
        else if (status === 'candidate') state.overview.current.candidates += 1
      } else if (item.state === 'unresolved') {
        scan.incomplete = true
        if (status !== 'forgotten') state.overview.currentIncomplete[status] = true
        state.overview.incomplete = true
      }
    }
    scan.after = page.value.nextCursor
    scan.done = !page.value.hasMore
    return { status: 'ok' }
  }

  /** Retain a page before reading it; a denied group lease leaves the exact row pending. */
  private scanUsage(state: ReadState, kind: 'attempt' | 'billable'): OverviewStep {
    const overview = state.overview
    const slot = kind === 'attempt' ? 'attemptPage' : 'billablePage'
    let pending = overview[slot]
    if (pending === undefined) {
      const after = kind === 'attempt' ? overview.attemptsAfter : overview.billableAfter
      const cost: DashboardReadCost = { sqlStatements: 1, rowsVisited: USAGE_PAGE_SIZE + 1,
        materializedBytes: (USAGE_PAGE_SIZE + 1) * USAGE_ROW_BYTES, keyBytes: textBytes(after) }
      const retainedBytes = (USAGE_PAGE_SIZE + 1) * USAGE_ROW_BYTES
      const admission = this.usageAdmission(state, { ...cost, materializedBytes: cost.materializedBytes + retainedBytes })
      if (admission.status !== 'ok') return admission
      const lease = state.reader.reserveReadState(retainedBytes)
      if (lease.status !== 'ok') return this.overviewBudgetFailure(lease)
      const page = state.reader.readControl(cost, (control) => kind === 'attempt'
        ? control.dashboardReadAttemptPage(after, USAGE_PAGE_SIZE) : control.dashboardReadBillablePage(after, USAGE_PAGE_SIZE))
      if (page.status !== 'ok') {
        const released = state.reader.releaseReadState(lease.value.reservationToken)
        return released.status === 'ok' ? this.overviewBudgetFailure(page) : { status: 'fatal', outcome: released }
      }
      pending = { rows: page.value.rows, index: 0, hasMore: page.value.hasMore, reservationToken: lease.value.reservationToken }
      overview[slot] = pending
    }
    while (pending.index < pending.rows.length) {
      const row = pending.rows[pending.index]!
      const applied = kind === 'attempt' ? this.addAttempt(state, row) : this.addBillable(state, row)
      if (applied.status !== 'ok') return applied
      pending.index += 1
    }
    const last = pending.rows.at(-1)
    const invalid = last !== undefined && (last.id === undefined || textBytes(last.id) !== last.idBytes || last.idBytes < 1 || last.idBytes > 256)
    const done = last === undefined || invalid || !pending.hasMore
    if (kind === 'attempt') {
      if (last?.id !== undefined && !invalid) overview.attemptsAfter = last.id
      overview.attemptsDone = done
      if (invalid) { overview.attemptsIncomplete = true; overview.incomplete = true }
    } else {
      if (last?.id !== undefined && !invalid) overview.billableAfter = last.id
      overview.billableDone = done
      if (invalid) { overview.billableIncomplete = true; overview.incomplete = true }
    }
    const released = state.reader.releaseReadState(pending.reservationToken)
    if (released.status !== 'ok') return { status: 'fatal', outcome: released }
    overview[slot] = undefined
    return { status: 'ok' }
  }

  private usageAdmission(state: ReadState, cost: DashboardReadCost): OverviewStep {
    const remaining = state.reader.remainingReadWorkBreakdown()
    if (remaining === undefined) return { status: 'fatal', outcome: { status: 'stale', reason: 'visibility-session-ended' } }
    const reserve = this.overviewFinalProofReserve(state)
    if (this.processingBudgetFits(remaining, cost, reserve)) return { status: 'ok' }
    return this.processingBudgetFits({ call: remaining.session, session: remaining.session }, cost, reserve)
      ? { status: 'budget_exhausted' }
      : { status: 'fatal', outcome: { status: 'budget-exhausted', reason: 'persona-session-headroom' } }
  }

  private reserveUsageGroup(state: ReadState, bytes: number, identityBytes: number): OverviewStep {
    // JSON framing can expand each UTF-8 byte to six escaped code units.
    // Keys pay for that temporary canonical tuple, the digest and fixed metadata.
    const keyBytes = 12 * identityBytes + 256
    const admitted = this.usageAdmission(state, { sqlStatements: 0, rowsVisited: 0, materializedBytes: bytes, keyBytes })
    if (admitted.status !== 'ok') return admitted
    const lease = state.reader.reserveReadState(bytes)
    if (lease.status !== 'ok') return this.overviewBudgetFailure(lease)
    const keys = state.reader.reserveReadKeys(keyBytes)
    if (keys.status !== 'ok') {
      const released = state.reader.releaseReadState(lease.value.reservationToken)
      return released.status === 'ok' ? this.overviewBudgetFailure(keys) : { status: 'fatal', outcome: released }
    }
    // Manager-owned leases live until this readId is cancelled/expired/closed.
    // Releasing the page never refunds past group or key work.
    return { status: 'ok' }
  }

  private scanAttempts(state: ReadState): OverviewStep { return this.scanUsage(state, 'attempt') }

  private addAttempt(state: ReadState, row: DashboardReadUsageRow): OverviewStep {
    const overview = state.overview
    if (row.projectKey === undefined || textBytes(row.projectKey) !== row.projectKeyBytes || row.projectKeyBytes < 1 ||
        row.projectKeyBytes > 256 || !isValidProjectKey(row.projectKey)) {
      overview.incomplete = true; overview.attemptsIncomplete = true; return { status: 'ok' }
    }
    if (!state.projectByKey.has(row.projectKey)) return { status: 'ok' }
    if (!safeInteger(row.createdAt) || row.createdAt < 0) {
      overview.incomplete = true; overview.attemptsIncomplete = true; return { status: 'ok' }
    }
    const date = localDate(row.createdAt, state.range.formatter)
    if (date === undefined) { overview.incomplete = true; overview.attemptsIncomplete = true; return { status: 'ok' } }
    if (!state.range.dateSet.has(date)) return { status: 'ok' }
    const usage = overview.usage
    const stateKnown = row.state !== undefined && textBytes(row.state) === row.stateBytes &&
      ['complete', 'failed_known', 'uncertain_remote', 'dispatching', 'confirmed_not_charged', 'blocked_charged'].includes(row.state)
    if (!stateKnown) { overview.incomplete = true; overview.attemptsIncomplete = true }
    const usageCertain = stateKnown && !['uncertain_remote', 'dispatching', 'blocked_charged'].includes(row.state!)
    const provider = projectionValue(row.provider, row.providerBytes, 256) ?? null
    const model = projectionValue(row.model, row.modelBytes, 256) ?? null
    const providerIdentity = provider === '' ? null : provider
    const modelIdentity = model === '' ? null : model
    let group = usage.modelGroups?.find((item) => item.provider === providerIdentity && item.model === modelIdentity)
    if (group === undefined) {
      const other = (usage.modelGroups?.length ?? 0) >= USAGE_VISIBLE_IDENTITIES
      group = other ? usage.modelOther : undefined
      if (group === undefined) {
        const admitted = this.reserveUsageGroup(state, MODEL_USAGE_GROUP_BYTES,
          other ? 0 : textBytes(providerIdentity) + textBytes(modelIdentity))
        if (admitted.status !== 'ok') return admitted
        group = { key: other ? 'model:other' : `model:${sha256(JSON.stringify([providerIdentity, modelIdentity]))}`,
          provider: other ? null : providerIdentity, model: other ? null : modelIdentity, other,
          calls: 0, knownCalls: 0, unknownCalls: 0, unknownIdentityCalls: 0,
          inputTokens: emptyField(), outputTokens: emptyField(), cacheReadTokens: emptyField(),
          cacheWriteTokens: emptyField(), reasoningTokens: emptyField(), costMicros: emptyField() }
        if (other) usage.modelOther = group
        else { usage.modelGroups ??= []; usage.modelGroups.push(group) }
      }
    }
    usage.attempts += 1
    group.calls += 1
    if (providerIdentity === null || modelIdentity === null) { usage.unknownModelCalls += 1; group.unknownIdentityCalls += 1 }
    const fields: Array<[FieldTotal, FieldTotal, number | null | undefined]> = [
      [usage.inputTokens, group.inputTokens, row.inputTokens], [usage.outputTokens, group.outputTokens, row.outputTokens], [usage.cacheReadTokens, group.cacheReadTokens, row.cacheReadTokens ?? row.cachedInputTokens],
      [usage.cacheWriteTokens, group.cacheWriteTokens, row.cacheWriteTokens], [usage.reasoningTokens, group.reasoningTokens, row.reasoningTokens], [usage.costMicros, group.costMicros, row.costMicros],
    ]
    let allFieldsKnown = true
    for (const [total, grouped, value] of fields) {
      for (const target of [total, grouped]) {
        if (finiteNonnegative(value)) {
          target.sum += value; target.seen += 1
          if (!usageCertain) target.uncertain += 1
        } else { target.missing += 1; allFieldsKnown = false }
      }
    }
    if (stateKnown && usageCertain && allFieldsKnown) { usage.knownAttempts += 1; group.knownCalls += 1 }
    else { usage.unknownAttempts += 1; group.unknownCalls += 1 }
    addDimension(usage.attemptProviders, safeDimension(row.provider, row.providerBytes, 256))
    return { status: 'ok' }
  }

  private scanBillable(state: ReadState): OverviewStep { return this.scanUsage(state, 'billable') }

  private addBillable(state: ReadState, row: DashboardReadUsageRow): OverviewStep {
    const overview = state.overview
    if (row.projectKey === undefined || textBytes(row.projectKey) !== row.projectKeyBytes || row.projectKeyBytes < 1 ||
        row.projectKeyBytes > 256 || !isValidProjectKey(row.projectKey)) {
      overview.incomplete = true; overview.billableIncomplete = true; return { status: 'ok' }
    }
    if (!state.projectByKey.has(row.projectKey)) return { status: 'ok' }
    if (!safeInteger(row.createdAt) || row.createdAt < 0) {
      overview.incomplete = true; overview.billableIncomplete = true; return { status: 'ok' }
    }
    const date = localDate(row.createdAt, state.range.formatter)
    if (date === undefined) { overview.incomplete = true; overview.billableIncomplete = true; return { status: 'ok' } }
    if (!state.range.dateSet.has(date)) return { status: 'ok' }
    if (row.state === undefined || textBytes(row.state) !== row.stateBytes ||
        !['reserved', 'dispatching', 'complete', 'failed_known', 'uncertain', 'cancelled'].includes(row.state)) {
      overview.incomplete = true; overview.billableIncomplete = true; return { status: 'ok' }
    }
    if (row.state === 'cancelled') return { status: 'ok' }
    const label = projectionValue(row.label, row.labelBytes, 128)
    const purpose = label === undefined || label === '' ? null : label
    const usage = overview.usage
    let group = usage.purposeGroups?.find((item) => item.purpose === purpose)
    if (group === undefined) {
      const other = (usage.purposeGroups?.length ?? 0) >= USAGE_VISIBLE_IDENTITIES
      group = other ? usage.purposeOther : undefined
      if (group === undefined) {
        const admitted = this.reserveUsageGroup(state, PURPOSE_USAGE_GROUP_BYTES, other ? 0 : textBytes(purpose))
        if (admitted.status !== 'ok') return admitted
        group = { key: other ? 'purpose:other' : `purpose:${sha256(JSON.stringify([purpose]))}`,
          purpose: other ? null : purpose, other, calls: 0, knownCalls: 0, unknownCalls: 0, unknownIdentityCalls: 0,
          actualTokens: emptyField() }
        if (other) usage.purposeOther = group
        else { usage.purposeGroups ??= []; usage.purposeGroups.push(group) }
      }
    }
    usage.billableCalls += 1
    group.calls += 1
    if (purpose === null) { usage.unknownPurposeCalls += 1; group.unknownIdentityCalls += 1 }
    const certain = !['reserved', 'dispatching', 'uncertain'].includes(row.state)
    for (const field of [usage.billableTokens, group.actualTokens]) {
      if (finiteNonnegative(row.actualTokens)) {
        field.sum += row.actualTokens; field.seen += 1
        if (!certain) field.uncertain += 1
      } else field.missing += 1
    }
    if (finiteNonnegative(row.actualTokens) && certain) group.knownCalls += 1
    else group.unknownCalls += 1
    return { status: 'ok' }
  }

  private scanCoverage(state: ReadState): OverviewStep {
    const page = state.reader.readControl({ sqlStatements: 1, rowsVisited: USAGE_PAGE_SIZE + 1,
      materializedBytes: (USAGE_PAGE_SIZE + 1) * 512, keyBytes: 8 },
    (control) => control.dashboardReadCoveragePage(state.overview.coverageAfter, USAGE_PAGE_SIZE))
    if (page.status !== 'ok') return this.overviewBudgetFailure(page)
    for (const row of page.value.rows) this.addCoverageWindow(state, row)
    const last = page.value.rows[page.value.rows.length - 1]
    if (last === undefined) state.overview.coverageDone = true
    else if (!safeInteger(last.id) || last.id < 1) { state.overview.incomplete = true; state.overview.coverageDone = true }
    else {
      state.overview.coverageAfter = last.id
      state.overview.coverageDone = !page.value.hasMore
    }
    return { status: 'ok' }
  }

  private addCoverageWindow(state: ReadState, row: DashboardReadCoverageRow): void {
    const overview = state.overview
    if (!safeInteger(row.id) || row.id < 1 || !safeInteger(row.startedAt) || row.startedAt < 0 ||
        row.endedAt !== null && (!safeInteger(row.endedAt) || row.endedAt < row.startedAt) ||
        row.status === undefined || textBytes(row.status) !== row.statusBytes ||
        !['active', 'closed', 'interrupted'].includes(row.status) ||
        row.policyRevision === undefined || textBytes(row.policyRevision) !== row.policyRevisionBytes || row.policyRevisionBytes > 128) {
      overview.incomplete = true; overview.coverageTruncated = true; return
    }
    const rangeStart = state.range.bounds.get(state.range.from)?.start
    const rangeEnd = state.range.bounds.get(state.range.to)?.end
    if (rangeStart === undefined || rangeEnd === undefined) { overview.incomplete = true; overview.coverageTruncated = true; return }
    const asOf = state.binding.asOf
    const windowEnd = Math.min(row.endedAt ?? asOf, asOf)
    if (row.startedAt >= asOf || row.startedAt >= rangeEnd || windowEnd <= rangeStart) return
    if (overview.windows.length >= MAX_COVERAGE_WINDOWS) { overview.coverageTruncated = true; overview.incomplete = true; return }
    overview.windows.push({ id: row.id, startedAt: row.startedAt, endedAt: row.endedAt,
      status: row.status as CoverageWindowState['status'], policyRevision: row.policyRevision })
  }

  private validEventKey(row: DashboardReadEventPageRow, projectKey: string): boolean {
    return safeInteger(row.id) && row.id > 0 && row.projectKey === projectKey && row.projectKeyBytes === textBytes(projectKey) &&
      row.type !== undefined && textBytes(row.type) === row.typeBytes && row.typeBytes > 0 && row.typeBytes <= 64 &&
      safeInteger(row.createdAt) && row.createdAt >= 0 && safeInteger(row.count) && row.count >= 0 &&
      finiteNonnegative(row.tokens) && finiteNonnegative(row.rawTokens)
  }

  private eventTime(row: DashboardReadEventPageRow): number | undefined {
    const value = row.type === 'capture' ? row.createdAt : row.occurredAt ?? row.createdAt
    return safeInteger(value) && value >= 0 ? value : undefined
  }

  private captureEventIdentities(row: DashboardReadEventPageRow): string[] {
    // The direct capture identity remains an independent fence even when its
    // text collides with the linked L0 row ID; only exact duplicate IDs merge.
    return [...new Set([row.linkedL0SourceEventId, row.directSourceEventId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0 &&
        Buffer.byteLength(id, 'utf8') <= 2000))]
  }

  private verifyEvent(state: ReadState, row: DashboardReadEventPageRow): 'visible' | 'hidden' | 'unresolved' | 'budget' |
    { status: 'fatal'; outcome: DashboardReadFailure } {
    if (row.type === 'capture') {
      if (row.identityInvalid || row.sourceId === undefined && row.sourceEventId === undefined) return 'unresolved'
      // A same-project L0 can carry its own source_event_id plus direct capture
      // event identities. Prove every available identity in one batch; the
      // legacy helper prefers the L0 identity and can miss a direct revocation
      // of a second event that shares that L0.
      if (row.sourceId !== undefined && row.sourceIdBytes >= 1 && row.sourceIdBytes <= 256 && row.l0Found) {
        const result = state.reader.verifyRepeatedCaptureEvent(row.projectKey!, row.sourceId,
          this.captureEventIdentities(row))
        return this.visibilityResult(result)
      }
      const result = state.reader.verifyCaptureEvent(row.projectKey!, row.sourceId, row.sourceEventId)
      return this.visibilityResult(result)
    }
    if (row.type === 'initial_approval' || row.type === 'revision') {
      if (row.sourceId === undefined || row.sourceIdBytes < 1 || textBytes(row.sourceId) !== row.sourceIdBytes) return 'unresolved'
      return this.visibilityResult(state.reader.verifyEventMemory(row.projectKey!, row.sourceId, false))
    }
    if (row.type === 'inject_prepared') {
      if (row.memoryIdsInvalid || row.metadataInvalid || row.memoryIds === undefined || row.memoryIds.length === 0 ||
          row.memoryIds.length > MAX_EVENT_LINKS) return 'unresolved'
      let hidden = false
      for (const id of row.memoryIds) {
        const result = this.visibilityResult(state.reader.verifyEventMemory(row.projectKey!, id, false))
        if (typeof result === 'object') return result
        if (result === 'budget' || result === 'unresolved') return result
        if (result === 'hidden') hidden = true
      }
      return hidden ? 'hidden' : 'visible'
    }
    if (row.metadataInvalid) return 'unresolved'
    return 'visible'
  }

  private visibilityResult(result: DashboardReadOutcome<{ state: string; reason?: string }>): 'visible' | 'hidden' | 'unresolved' | 'budget' | { status: 'fatal'; outcome: DashboardReadFailure } {
    if (result.status === 'budget-exhausted' && result.reason === 'persona-call-headroom') return 'budget'
    if (result.status !== 'ok') return { status: 'fatal', outcome: result }
    if (result.value.state === 'visible') return 'visible'
    return result.value.state === 'hidden' ? 'hidden' : 'unresolved'
  }

  private eventExclusion(state: ReadState, row: DashboardReadEventPageRow): 'included' | 'excluded' | 'unknown' {
    if (row.agentPreset === undefined && row.agentPresetBytes === 0) return 'included'
    const preset = projectionValue(row.agentPreset, row.agentPresetBytes, 512)
    if (preset === undefined) return 'unknown'
    return state.excludedAgentPatterns.some((pattern) => matchesAgentGlob(preset, pattern)) ? 'excluded' : 'included'
  }

  private noteEventProjection(state: ReadState, row: DashboardReadEventPageRow): void {
    const fields: Array<[string | undefined, number, number]> = [
      [row.source, row.sourceBytes, 512], [row.agentId, row.agentIdBytes, 512],
      [row.agentPreset, row.agentPresetBytes, 512], [row.provider, row.providerBytes, 256],
      [row.model, row.modelBytes, 256], [row.fingerprint, row.fingerprintBytes, 512],
      [row.sessionId, row.sessionIdBytes, 512],
    ]
    const invalid = fields.some(([value, bytes, maximum]) => projectionValue(value, bytes, maximum) === undefined &&
      (value !== undefined || bytes !== 0))
    if (!invalid) return
    state.overview.incomplete = true
    if (row.type !== 'capture') return
    state.overview.sessionCaptureIncomplete = true
    const sessionId = row.sessionId
    if (row.projectKey !== undefined && row.sessionIdBytes > 0 && row.sessionIdBytes <= 512 &&
        sessionId !== undefined && textBytes(sessionId) === row.sessionIdBytes) {
      const aggregate = this.sessionAggregateFor(state, row.projectKey, sessionId)
      if (aggregate !== undefined) aggregate.projectionIncomplete = true
    } else state.overview.sessionIncomplete = true
  }

  private countEvent(state: ReadState, row: DashboardReadEventPageRow, date: string): void {
    const overview = state.overview
    const counts = overview.counts
    const day = overview.days.get(date)
    if (day === undefined) { overview.incomplete = true; return }
    const source = safeDimension(row.source, row.sourceBytes, 512)
    const agent = safeDimension(row.agentId, row.agentIdBytes, 512)
    const preset = safeDimension(row.agentPreset, row.agentPresetBytes, 512)
    const provider = safeDimension(row.provider, row.providerBytes, 256)
    const model = safeDimension(row.model, row.modelBytes, 256)
    if (row.sourceBytes > 512 || row.agentIdBytes > 512 || row.agentPresetBytes > 512 || row.providerBytes > 256 || row.modelBytes > 256) {
      overview.incomplete = true
    }
    addDimension(overview.dimensions.sources, source)
    addDimension(overview.dimensions.agents, agent)
    addDimension(overview.dimensions.agentPresets, preset)
    addDimension(overview.dimensions.providers, provider)
    addDimension(overview.dimensions.models, model)
    if (row.type === 'capture') addDimension(overview.captureSources, source)
    if (activityTypes(state.range.activity).has(row.type!)) {
      addDimension(overview.selectedDimensions.sources, source)
      addDimension(overview.selectedDimensions.agents, agent)
      addDimension(overview.selectedDimensions.agentPresets, preset)
      addDimension(overview.selectedDimensions.providers, provider)
      addDimension(overview.selectedDimensions.models, model)
    }
    if (agent === 'unknown') counts.unknownAgentEvents += 1
    if (preset === 'unknown') counts.unknownAgentPresetEvents += 1
    if (row.sessionId === undefined || row.sessionIdBytes === 0) {
      counts.unknownSessionEvents += 1
    } else if (textBytes(row.sessionId) !== row.sessionIdBytes || row.sessionIdBytes > 512) {
      counts.unknownSessionEvents += 1; overview.incomplete = true
    } else {
      addDimension(overview.dimensions.sessions, row.sessionId)
      if (overview.sessions.has(row.sessionId)) overview.sessionCounts.set(row.sessionId, (overview.sessionCounts.get(row.sessionId) ?? 0) + 1)
      else if (overview.sessions.size < MAX_SESSION_KEYS) { overview.sessions.add(row.sessionId); overview.sessionCounts.set(row.sessionId, 1) }
      else overview.incomplete = true
    }
    switch (row.type) {
      case 'capture': {
        counts.captures += 1; day.captures += 1
        if (row.originalMessageIdentity === null || row.originalMessageIdentity === undefined) counts.unknownOriginalMessageEvents += 1
        else if (/^[a-f0-9]{64}$/u.test(row.originalMessageIdentity)) {
          if (overview.identityDigests.size < MAX_IDENTITIES || overview.identityDigests.has(row.originalMessageIdentity)) overview.identityDigests.add(row.originalMessageIdentity)
          else overview.incomplete = true
        } else { counts.unknownOriginalMessageEvents += 1; overview.incomplete = true }
        if (!row.fingerprintInvalid && row.fingerprint !== undefined && row.fingerprint.length > 0 &&
            textBytes(row.fingerprint) === row.fingerprintBytes && row.fingerprintBytes <= 512) {
          addDimension(overview.dimensions.fingerprints, row.fingerprint)
          const prior = overview.fingerprintCounts.get(row.fingerprint)
          if (prior !== undefined) {
            overview.fingerprintCounts.set(row.fingerprint, prior + 1)
            if (prior === 1) overview.repeatedTotal += 1
          } else if (overview.fingerprintCounts.size < MAX_FINGERPRINTS) overview.fingerprintCounts.set(row.fingerprint, 1)
          else overview.incomplete = true
        } else if (row.fingerprintBytes > 0 || row.fingerprintInvalid) overview.incomplete = true
        break
      }
      case 'recall_returned': case 'recall_no_result':
        counts.recallRequests += 1
        if (row.type === 'recall_returned') { counts.recallResults += 1; day.recalls += 1 }
        break
      case 'revision': counts.acceptedRevisions += 1; day.revisions += 1; break
      case 'initial_approval': counts.initialApprovals += 1; day.initialApprovals += 1; break
      case 'inject_prepared':
        counts.preparedInjectionEvents += 1; counts.preparedInjectionMemories += row.memoryIds!.length; day.injections += 1
        overview.usage.preparedInjectionTokensEstimate += row.tokens
        if (row.count !== row.memoryIds!.length) overview.incomplete = true
        break
    }
  }

  /**
   * Accumulate one visible capture event into the bounded session aggregate.
   * The unit of `events` is a capture event; `linkedL0Messages` is the distinct
   * count of those events whose source_id resolves to an L0 row in the same
   * project (the store LEFT JOIN marks this explicitly, so a source-only event
   * never links a foreign-project L0). Per-session sets are capped; exceeding a
   * cap makes the DTO a lower bound instead of silently under-counting.
   */
  private noteSessionEvent(state: ReadState, row: DashboardReadEventPageRow): void {
    if (row.type !== 'capture') return
    const overview = state.overview
    overview.sessionScannedEvents += 1
    const projectKey = row.projectKey
    const sessionId = row.sessionId
    if (sessionId === undefined || row.sessionIdBytes < 1) {
      // A visible capture event without a session is counted as unknown, not
      // as a failed session scan; it simply cannot join a session aggregate.
      overview.sessionUnknownSessionEvents += 1
      return
    }
    if (projectKey === undefined || row.sessionIdBytes > 512 || textBytes(sessionId) !== row.sessionIdBytes) {
      overview.incomplete = true
      overview.sessionIncomplete = true
      overview.sessionUnknownSessionEvents += 1
      return
    }
    const aggregate = this.sessionAggregateFor(state, projectKey, sessionId)
    if (aggregate === undefined) return
    aggregate.events += 1
    if (row.l0Found && row.sourceId !== undefined && row.sourceIdBytes > 0 && row.sourceIdBytes <= 256 &&
        textBytes(row.sourceId) === row.sourceIdBytes) {
      if (aggregate.linkedL0.size < MAX_SESSION_LINKED_L0 || aggregate.linkedL0.has(row.sourceId)) {
        aggregate.linkedL0.add(row.sourceId)
      } else {
        aggregate.linkedTruncated = true
        overview.sessionIncomplete = true
        overview.incomplete = true
      }
    }
    const identity = row.originalMessageIdentity
    if (identity === null || identity === undefined) {
      aggregate.unknownIdentityEvents += 1
      overview.sessionUnknownIdentityEvents += 1
    } else if (!/^[a-f0-9]{64}$/u.test(identity)) {
      aggregate.unknownIdentityEvents += 1
      overview.sessionUnknownIdentityEvents += 1
      overview.sessionIncomplete = true
      overview.incomplete = true
    } else if (aggregate.identities.size < MAX_SESSION_IDENTITIES || aggregate.identities.has(identity)) {
      aggregate.identities.add(identity)
    } else {
      aggregate.identityTruncated = true
      overview.sessionIncomplete = true
      overview.incomplete = true
    }
  }

  private sessionAggregateFor(state: ReadState, projectKey: string, sessionId: string): OverviewSessionAgg | undefined {
    const overview = state.overview
    const projectKeyBytes = textBytes(projectKey)
    const sessionIdBytes = textBytes(sessionId)
    if (!state.projectByKey.has(projectKey) || projectKeyBytes < 1 || projectKeyBytes > 256 ||
        sessionIdBytes < 1 || sessionIdBytes > 512) {
      overview.sessionIncomplete = true
      overview.incomplete = true
      return undefined
    }
    const key = `${projectKey}\u0000${sessionId}`
    let aggregate = overview.sessionAgg.get(key)
    if (aggregate !== undefined) return aggregate
    if (overview.sessionAgg.size >= MAX_SESSION_KEYS) {
      overview.sessionTruncated = true
      overview.sessionIncomplete = true
      overview.incomplete = true
      return undefined
    }
    aggregate = { projectKey, projectName: state.projectByKey.get(projectKey)?.name ?? projectKey,
      sessionId, events: 0, linkedL0: new Set(), identities: new Set(), unknownIdentityEvents: 0,
      linkedTruncated: false, identityTruncated: false, projectionIncomplete: false }
    overview.sessionAgg.set(key, aggregate)
    return aggregate
  }

  private sessionItems(state: ReadState): NonNullable<ReadDashboardResult['sessions']> {
    const overview = state.overview
    const scannedComplete = state.projects.every((project) => project.eventDone)
    const sessionExact = scannedComplete && !overview.sessionTruncated && !overview.sessionIncomplete && !overview.sessionCaptureIncomplete
    const knownSessionRowsExact = scannedComplete && !overview.sessionTruncated && !overview.sessionIncomplete
    const complete = scannedComplete && sessionExact
    const visibleAggregates = [...overview.sessionAgg.values()].filter((aggregate) => aggregate.events > 0)
    const items = visibleAggregates.sort((left, right) => {
      if (left.linkedL0.size !== right.linkedL0.size) return right.linkedL0.size - left.linkedL0.size
      if (left.events !== right.events) return right.events - left.events
      if (left.projectKey !== right.projectKey) return left.projectKey < right.projectKey ? -1 : 1
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    }).slice(0, 10).map((aggregate) => ({
      projectKey: aggregate.projectKey, projectName: aggregate.projectName,
      sessionId: aggregate.sessionId, events: aggregate.events,
      linkedL0Messages: aggregate.linkedL0.size,
      linkedL0Complete: !aggregate.linkedTruncated && !aggregate.projectionIncomplete && knownSessionRowsExact,
      originalMessageCount: null as null,
      identityLowerBound: aggregate.identities.size,
      identityComplete: !aggregate.identityTruncated && !aggregate.projectionIncomplete && knownSessionRowsExact,
      unknownIdentityEvents: aggregate.unknownIdentityEvents,
    }))
    return {
      complete,
      truncated: overview.sessionTruncated,
      scannedEvents: overview.sessionScannedEvents,
      scannedSessions: visibleAggregates.length,
      items,
      unknownSessionEvents: overview.sessionUnknownSessionEvents,
      unknownIdentityEvents: overview.sessionUnknownIdentityEvents,
      ...(complete ? {} : { reason: 'bounded-session-scan-incomplete' }),
    }
  }

  private overviewResult(state: ReadState, statusOverride?: DashboardStatus): ReadDashboardResult {
    const stateComplete = this.overviewTasks(state).length === 0 && !state.overview.incomplete
    const overview = state.overview
    const countComplete = stateComplete
    const metrics: Record<string, Metric> = {
      effectiveMemories: makeMetric(overview.current.effectiveMemories, stateComplete && !overview.currentIncomplete.approved),
      candidates: makeMetric(overview.current.candidates, stateComplete && !overview.currentIncomplete.candidate),
      captures: makeMetric(overview.counts.captures, countComplete), sessions: makeMetric(overview.sessions.size, countComplete),
      unknownSessionEvents: makeMetric(overview.counts.unknownSessionEvents, countComplete),
      recallRequests: makeMetric(overview.counts.recallRequests, countComplete), recallResults: makeMetric(overview.counts.recallResults, countComplete),
      acceptedRevisions: makeMetric(overview.counts.acceptedRevisions, countComplete),
      initialApprovals: makeMetric(overview.counts.initialApprovals, countComplete),
      unknownAgentEvents: makeMetric(overview.counts.unknownAgentEvents, countComplete),
      unknownAgentPresetEvents: makeMetric(overview.counts.unknownAgentPresetEvents, countComplete),
      preparedInjectionEvents: makeMetric(overview.counts.preparedInjectionEvents, countComplete),
      preparedInjectionMemories: makeMetric(overview.counts.preparedInjectionMemories, countComplete),
      repeatedTotal: makeMetric(overview.repeatedTotal, countComplete),
      recordedOriginalMessageLowerBound: makeMetric(overview.identityDigests.size, countComplete, 'unique-digests-observed'),
    }
    const coverageKnown = overview.coverageDone && !overview.coverageTruncated
    const activity = state.range.dates.map((date) => ({ date, count: makeMetric(this.activityCount(state, overview.days.get(date)!), countComplete),
      coverage: coverageKnown ? this.coverageForDate(state, date) : 'unknown' as const }))
    const windows = overview.windows.slice().sort((left, right) => right.startedAt - left.startedAt || right.id - left.id).slice(0, 8)
    const coverageDays = activity.filter((day) => day.coverage === 'covered').length
    const coverageStatus = !coverageKnown ? 'unknown' : activity.every((day) => day.coverage === 'covered') ? 'covered'
      : activity.some((day) => day.coverage !== 'unknown') ? 'partial' : 'unknown'
    const usage = this.usageResult(state, countComplete)
    const page = this.overviewPage(state)
    const processing = this.processingResult(state)
    return response('overview', statusOverride ?? (stateComplete ? 'ok' : 'partial'), stateComplete, {
      readId: state.id, projects: state.projects.map((project) => ({ key: project.key, name: project.name })), metrics,
      page, processing, sessions: this.sessionItems(state),
      activity, dimensions: {
        sources: dimensionArray(overview.dimensions.sources, countComplete), agents: dimensionArray(overview.dimensions.agents, countComplete),
        agentPresets: dimensionArray(overview.dimensions.agentPresets, countComplete), providers: dimensionArray(overview.dimensions.providers, countComplete),
        models: dimensionArray(overview.dimensions.models, countComplete), sessions: dimensionArray(overview.dimensions.sessions, countComplete),
        fingerprints: dimensionArray(overview.dimensions.fingerprints, countComplete),
      }, scopedDimensions: {
        activity: state.range.activity,
        captureSources: dimensionArray(overview.captureSources, countComplete),
        selected: {
          sources: dimensionArray(overview.selectedDimensions.sources, countComplete),
          agents: dimensionArray(overview.selectedDimensions.agents, countComplete),
          agentPresets: dimensionArray(overview.selectedDimensions.agentPresets, countComplete),
          providers: dimensionArray(overview.selectedDimensions.providers, countComplete),
          models: dimensionArray(overview.selectedDimensions.models, countComplete),
        },
      }, identity: {
        recordedOriginalMessageLowerBound: makeMetric(overview.identityDigests.size, countComplete, 'unique-digests-observed'),
        unknownOriginalMessageEvents: makeMetric(overview.counts.unknownOriginalMessageEvents, countComplete),
      }, usage,
      coverage: { status: coverageStatus, coveredDays: coverageKnown ? makeMetric(coverageDays, true)
        : unknownMetric('coverage-scan-incomplete'), windows },
      reason: stateComplete ? undefined : 'bounded-scan-incomplete',
    })
  }

  private activityCount(state: ReadState, day: DayCounter): number {
    switch (state.range.activity) {
      case 'capture': return day.captures
      case 'recall': return day.recalls
      case 'revision': return day.revisions
      case 'initial_approval': return day.initialApprovals
      case 'injection': return day.injections
    }
  }

  private coverageForDate(state: ReadState, date: string): 'covered' | 'partial' | 'unknown' {
    const bounds = state.range.bounds.get(date)
    if (bounds === undefined) return 'unknown'
    const { start, end } = bounds
    const matching = state.overview.windows.filter((window) => window.startedAt < end &&
      (Math.min(window.endedAt ?? state.binding.asOf, state.binding.asOf) > start))
    if (matching.length === 0) return 'unknown'
    if (matching.some((window) => window.status === 'interrupted')) return 'partial'
    const intervals: Array<[number, number]> = []
    for (const window of matching) {
      if (window.status !== 'closed' && window.status !== 'active') continue
      const left = Math.max(start, window.startedAt)
      const right = Math.min(end, window.endedAt ?? state.binding.asOf, state.binding.asOf)
      if (right > left) intervals.push([left, right])
    }
    intervals.sort((left, right) => left[0] - right[0])
    let cursor = start
    let intersects = false
    for (const [left, right] of intervals) {
      intersects = true
      if (left > cursor) return 'partial'
      cursor = Math.max(cursor, right)
      if (cursor >= end) return 'covered'
    }
    if (cursor > start) return 'partial'
    return intersects ? 'partial' : 'unknown'
  }

  private overviewPage(state: ReadState): ReadDashboardPage {
    const byProject = (project: ProjectScan) => {
      const approved = makeMetric(project.approved.count, project.approved.done && !project.approved.incomplete)
      const candidates = makeMetric(project.candidate.count, project.candidate.done && !project.candidate.incomplete)
      const memories = project.approved.done && project.candidate.done && !project.approved.incomplete && !project.candidate.incomplete
        ? makeMetric(project.approved.count + project.candidate.count, true)
        : { value: project.approved.count + project.candidate.count, relation: 'lower_bound' as const, reason: 'checked_subset' }
      const forgotten = makeMetric(project.forgotten.count, project.forgotten.done && !project.forgotten.incomplete)
      return { key: project.key, name: project.name, memories, approved, candidates, forgotten }
    }
    return {
      ...(state.focusProjectKey === undefined ? {} : { activeProjectKey: state.focusProjectKey }),
      settings: this.options.settings(), projects: state.projects.map(byProject),
      candidates: state.page.candidates, recent: state.page.recent,
      ...(state.page.incomplete ? { lastError: 'page-projection-incomplete' } : {}),
      ...(this.options.lastError() === undefined ? {} : { lastError: this.options.lastError() }),
    }
  }

  private processingResult(state: ReadState): NonNullable<ReadDashboardResult['processing']> {
    const scan = state.processingScan
    const complete = scan.done && !scan.incomplete
    return {
      queued: makeMetric(scan.queued, complete),
      failed: makeMetric(scan.failed, complete),
      uncertainUsage: makeMetric(scan.uncertainUsage, complete),
      oldestWaiting: scan.oldestWaitingAt === null
        ? { state: complete ? 'none' as const : 'unknown' as const, value: null }
        : { state: complete ? 'exact' as const : 'partial' as const, value: scan.oldestWaitingAt },
    }
  }

  private usageResult(state: ReadState, complete: boolean): NonNullable<ReadDashboardResult['usage']> {
    const usage = state.overview.usage
    const fieldMetric = (field: FieldTotal, emptyComplete: boolean): Metric => {
      if (field.seen === 0) return field.missing > 0 || !emptyComplete ? unknownMetric('usage-unavailable') : makeMetric(0, true)
      const exact = emptyComplete && field.missing === 0 && field.uncertain === 0
      return makeMetric(field.sum, exact, field.uncertain > 0 ? 'usage-uncertain-lower-bound'
        : field.missing > 0 ? 'some-usage-fields-missing' : 'checked-subset')
    }
    const attemptScanComplete = state.overview.attemptsDone && !state.overview.attemptsIncomplete
    const billableScanComplete = state.overview.billableDone && !state.overview.billableIncomplete
    const fieldEvidence = (field: FieldTotal, scanComplete: boolean) => ({ ...fieldMetric(field, scanComplete),
      seen: field.seen, missing: field.missing, uncertain: field.uncertain })
    const models = [...(usage.modelGroups ?? []), ...(usage.modelOther === undefined ? [] : [usage.modelOther])]
    const purposes = [...(usage.purposeGroups ?? []), ...(usage.purposeOther === undefined ? [] : [usage.purposeOther])]
    return {
      attempts: {
        calls: makeMetric(usage.attempts, attemptScanComplete), knownCalls: makeMetric(usage.knownAttempts, attemptScanComplete),
        unknownCalls: makeMetric(usage.unknownAttempts, attemptScanComplete),
        inputTokens: fieldMetric(usage.inputTokens, attemptScanComplete), outputTokens: fieldMetric(usage.outputTokens, attemptScanComplete),
        cacheReadTokens: fieldMetric(usage.cacheReadTokens, attemptScanComplete), cacheWriteTokens: fieldMetric(usage.cacheWriteTokens, attemptScanComplete),
        reasoningTokens: fieldMetric(usage.reasoningTokens, attemptScanComplete), costMicros: fieldMetric(usage.costMicros, attemptScanComplete),
        byProvider: dimensionArray(usage.attemptProviders, attemptScanComplete),
        grouping: { selection: 'first_seen', overflow: usage.modelOther !== undefined,
          unknownIdentityCalls: makeMetric(usage.unknownModelCalls, attemptScanComplete) },
        byModel: models.map((group) => ({ key: group.key, provider: group.provider, model: group.model, other: group.other,
          count: makeMetric(group.calls, attemptScanComplete), knownCalls: makeMetric(group.knownCalls, attemptScanComplete),
          unknownCalls: makeMetric(group.unknownCalls, attemptScanComplete), unknownIdentityCalls: makeMetric(group.unknownIdentityCalls, attemptScanComplete),
          inputTokens: fieldEvidence(group.inputTokens, attemptScanComplete), outputTokens: fieldEvidence(group.outputTokens, attemptScanComplete),
          cacheReadTokens: fieldEvidence(group.cacheReadTokens, attemptScanComplete), cacheWriteTokens: fieldEvidence(group.cacheWriteTokens, attemptScanComplete),
          reasoningTokens: fieldEvidence(group.reasoningTokens, attemptScanComplete), costMicros: fieldEvidence(group.costMicros, attemptScanComplete) })),
      },
      billable: { calls: makeMetric(usage.billableCalls, billableScanComplete), tokens: fieldMetric(usage.billableTokens, billableScanComplete),
        grouping: { selection: 'first_seen', overflow: usage.purposeOther !== undefined,
          unknownIdentityCalls: makeMetric(usage.unknownPurposeCalls, billableScanComplete) },
        byPurpose: purposes.map((group) => ({ key: group.key, purpose: group.purpose, other: group.other,
          count: makeMetric(group.calls, billableScanComplete), knownCalls: makeMetric(group.knownCalls, billableScanComplete),
          unknownCalls: makeMetric(group.unknownCalls, billableScanComplete), unknownIdentityCalls: makeMetric(group.unknownIdentityCalls, billableScanComplete),
          actualTokens: fieldEvidence(group.actualTokens, billableScanComplete) })) },
      preparedInjectionTokensEstimate: makeMetric(usage.preparedInjectionTokensEstimate, complete, 'estimated-from-prepared-events'),
      preparedInjectionEstimateMethod: 'sum-prepared-event-tokens', mainModelCoverage: 'unavailable',
      actualInjectionReceipt: 'unavailable', comparableNetSavings: 'unavailable',
    }
  }

  private resumeForAction(state: ReadState, view: DashboardView): ReadDashboardResult | undefined {
    if (!state.reader.isPaused) return response(view, 'stale', false, { readId: state.id, reason: 'read-session-not-suspended' })
    const resumed = state.reader.resumeForRpc()
    state.exposedCursor = undefined
    if (resumed.status !== 'ok') return this.abortWithOutcome(state, resumed, view)
    return undefined
  }

  private reserveOutput(state: ReadState, view: DashboardView): ReadDashboardResult | undefined {
    if (state.outputReservation !== undefined) return undefined
    const output = state.reader.reserveReadState(MAX_RESPONSE_BYTES)
    if (output.status !== 'ok') return this.abortWithOutcome(state, output, view)
    state.outputReservation = output.value.reservationToken
    return undefined
  }

  private pauseWithResult(state: ReadState, body: ReadDashboardResult, exposeCursor: boolean,
    initialBootstrap: boolean): ReadDashboardResult {
    const output = this.reserveOutput(state, state.view)
    if (output !== undefined) return output
    const bodyWithPlaceholder = exposeCursor ? { ...body, cursor: '00000000-0000-4000-8000-000000000000' } : { ...body }
    const encoded = JSON.stringify(bodyWithPlaceholder)
    const size = Buffer.byteLength(encoded, 'utf8')
    if (size > MAX_RESPONSE_BYTES) {
      return this.abortState(state, 'budget-exhausted', 'dashboard-response-size-limit', state.view)
    }
    const reservation = state.outputReservation
    const suspended = state.reader.suspendForRpc(() => {
      if (reservation === undefined) return { status: 'stale', reason: 'dashboard-output-reservation-missing' }
      const released = state.reader.releaseReadState(reservation)
      if (released.status === 'ok') state.outputReservation = undefined
      return released
    })
    if (suspended.status !== 'ok') {
      if (suspended.status === 'handoff-exhausted') {
        if (suspended.proofComplete !== true) return this.abortState(state, 'stale', 'handoff-proof-incomplete', state.view)
        const { cursor: _cursor, ...withoutCursor } = bodyWithPlaceholder
        this.dropState(state, 'budget-exhausted', suspended.reason)
        return { ...withoutCursor, status: 'budget_exhausted', complete: false, reason: failureReason(suspended.reason) }
      }
      return this.abortWithOutcome(state, suspended, state.view)
    }
    if (initialBootstrap) state.awaitingFirstAction = true
    state.lastActivityAt = Date.now()
    this.scheduleSweep()
    if (exposeCursor) {
      state.exposedCursor = suspended.value.continuationToken
      return { ...bodyWithPlaceholder, cursor: suspended.value.continuationToken }
    }
    state.exposedCursor = undefined
    return body
  }

  private abortWithOutcome(state: ReadState, outcome: DashboardReadFailure, view: DashboardView): ReadDashboardResult {
    if (outcome.status === 'budget-exhausted') {
      this.dropState(state, 'budget-exhausted', outcome.reason)
      return response(view, 'budget_exhausted', false, { readId: state.id, reason: failureReason(outcome.reason) })
    }
    this.dropState(state, outcome.status, outcome.reason)
    return response(view, failureStatus(outcome.status), false, { readId: state.id, reason: failureReason(outcome.reason) })
  }

  private abortState(state: ReadState, status: DashboardReadFailureStatus, reason: string, view: DashboardView): ReadDashboardResult {
    this.dropState(state, status, reason)
    return response(view, failureStatus(status), false, { readId: state.id, reason: failureReason(reason) })
  }

  private stateFor(readId: string): ReadState | undefined {
    const state = this.states.get(readId)
    if (state === undefined) return undefined
    const now = Date.now()
    if (!safeInteger(now) || now < state.generatedAt || now - state.lastActivityAt >= DASHBOARD_IDLE_MS ||
        now - state.generatedAt >= DASHBOARD_ABSOLUTE_MS) {
      this.dropState(state, 'expired', 'dashboard-read-expired')
      return undefined
    }
    let generation: string | undefined
    let policy: string | undefined
    try { generation = this.currentGeneration(); policy = this.currentPolicyKey() } catch { /* converted to unavailable below */ }
    if (generation === undefined || policy === undefined) {
      this.dropState(state, 'unavailable-probe', 'dashboard-scope-unavailable')
      return undefined
    }
    if (state.binding.generationId !== generation || state.binding.policyKey !== policy) {
      this.dropState(state, 'stale', 'dashboard-scope-changed')
      return undefined
    }
    this.states.delete(readId)
    this.states.set(readId, state)
    return state
  }

  private currentGeneration(): string | undefined {
    try { const value = this.options.generationId(); return value.length > 0 && textBytes(value) <= 128 ? value : undefined }
    catch { return undefined }
  }

  private currentPolicyKey(): string | undefined {
    try {
      const patterns = [...this.options.excludedAgentPatterns()]
      if (patterns.length > 100 || patterns.some((value) => typeof value !== 'string' || textBytes(value) > 256)) return undefined
      return sha256(`${this.options.policyRevision()}\0${JSON.stringify(patterns)}`)
    } catch { return undefined }
  }

  private terminalOrStale(readId: string, view: DashboardView): ReadDashboardResult {
    const terminal = this.terminals.get(readId)
    return terminal === undefined ? response(view, 'stale', false, { readId, reason: 'unknown-or-finished-read' })
      : response(view, terminal.status, false, { readId, reason: terminal.reason })
  }

  private managerEnded(readId: string, state: ReadState | undefined, status: DashboardReadFailureStatus, reason: string): void {
    if (state?.explicitClose) return
    this.states.delete(readId)
    this.terminals.delete(readId)
    this.terminals.set(readId, { status: failureStatus(status), reason: failureReason(reason) })
    this.trimTerminalCache()
    this.scheduleSweep()
  }

  private dropState(state: ReadState, status: DashboardReadFailureStatus, reason: string): void {
    this.states.delete(state.id)
    // Cancel, invalidation, TTL, and authority loss release the resident scan
    // vector and every pending row before the reader lease is retired.
    state.repeatGroups = undefined
    state.repeatEvents = undefined
    state.repeatTarget = undefined
    state.explicitClose = true
    try { state.reader.cancel() } catch { /* terminal response is already selected */ }
    state.explicitClose = false
    this.terminals.delete(state.id)
    this.terminals.set(state.id, { status: failureStatus(status), reason: failureReason(reason) })
    this.trimTerminalCache()
    this.scheduleSweep()
  }

  private trimTerminalCache(): void {
    while (this.terminals.size > 16) this.terminals.delete(this.terminals.keys().next().value as string)
  }

  private closeRead(readId: string): ReadDashboardResult {
    const state = this.states.get(readId)
    if (state === undefined) {
      const directoryState = this.directoryStates.get(readId)
      if (directoryState === undefined) return this.terminalOrStale(readId, 'control')
      this.directoryStates.delete(readId)
      directoryState.explicitClose = true
      this.closeDirectoryState(directoryState)
      try { directoryState.reader.cancel() } catch { /* close remains successful */ }
      directoryState.explicitClose = false
      this.terminals.delete(readId)
      this.scheduleSweep()
      return response('control', 'ok', true, { readId })
    }
    state.explicitClose = true
    this.states.delete(readId)
    state.repeatGroups = undefined
    state.repeatEvents = undefined
    state.repeatTarget = undefined
    try { state.reader.cancel() } catch { /* close remains successful */ }
    this.terminals.delete(readId)
    this.scheduleSweep()
    return response('control', 'ok', true, { readId })
  }

  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer)
    this.sweepTimer = undefined
    if (this.closed || this.states.size === 0 && this.directoryStates.size === 0) return
    const now = Date.now()
    let deadline = Number.POSITIVE_INFINITY
    for (const state of this.states.values()) deadline = Math.min(deadline,
      state.lastActivityAt + DASHBOARD_IDLE_MS, state.generatedAt + DASHBOARD_ABSOLUTE_MS)
    for (const state of this.directoryStates.values()) deadline = Math.min(deadline,
      state.lastActivityAt + DIRECTORY_IDLE_MS, state.createdAt + DASHBOARD_ABSOLUTE_MS)
    const delay = Math.max(0, Math.min(DASHBOARD_IDLE_MS, deadline - now))
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined
      this.expireReadStates()
      this.scheduleSweep()
    }, delay)
    this.sweepTimer.unref?.()
  }

  private expireReadStates(): void {
    const now = Date.now()
    for (const state of [...this.states.values()]) {
      if (!safeInteger(now) || now < state.generatedAt || now - state.lastActivityAt >= DASHBOARD_IDLE_MS ||
          now - state.generatedAt >= DASHBOARD_ABSOLUTE_MS) this.dropState(state, 'expired', 'dashboard-read-expired')
    }
    for (const state of [...this.directoryStates.values()]) {
      if (!safeInteger(now) || now < state.createdAt || now - state.lastActivityAt >= DIRECTORY_IDLE_MS ||
          now - state.createdAt >= DASHBOARD_ABSOLUTE_MS) this.dropDirectoryState(state, 'expired', 'project-directory-read-expired')
    }
  }
}
