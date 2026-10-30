/**
 * Internal demand-driven visibility proofs for a caller-owned S1 read session.
 * This module never opens a database or starts a timer. It may retain only a
 * bounded, charged managed-page result inside the caller-owned S1 session;
 * directory member connections are opened by the owning runtime through the
 * injected `openDirectoryMember` callback and released with their handle.
 */
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { matchesAgentGlob } from './config.js'
import { isConversationSource } from './r41.js'
import type { ControlLedger, DashboardVisibilityFences } from './control.js'
import type {
  DashboardReadBinding, DashboardReadCost, DashboardReadFailureStatus,
  DashboardReadOutcome, DashboardReadSessionManager, DashboardReadVersionStamp, DashboardReadWorkLimit,
} from './dashboard-read.js'
import { isValidProjectKey } from './project-key.js'
import type {
  DashboardVisibilityLegacyEventPageRow, DashboardVisibilityMemoryCursor, DashboardVisibilityMemoryMeta,
  DashboardVisibilityMemoryPageRow, DashboardVisibilityRelationCursor, DashboardVisibilityRelationPageRow,
  DashboardVisibilityRevisionCursor, DashboardVisibilityRevisionPageRow, DashboardVisibilitySourceIdentity,
  DashboardVisibilityDirectCreationOrigin, MemoryRecord, MemoryStore,
  DashboardManagedMemoryView,
} from './store.js'
import type { ValidFromBasis, ValidFromPrecision } from './temporal.js'

const PAGE_ROWS = 16
const PAGE_ITEMS = 15
const PAGE_ROW_BYTES = 512
const MAX_MANAGED_PAGE_CONTINUATIONS = 64
const aggregateManagedPage = Symbol('dashboard-aggregate-managed-page')
const aggregateRecentManagedPage = Symbol('dashboard-aggregate-recent-managed-page')
const aggregateOverviewWork = Symbol('dashboard-aggregate-overview-work')
const OVERVIEW_FUSION_ENTRIES = 128
const OVERVIEW_FUSION_BYTES = 2 * 1024 * 1024
const MANAGED_PROOF_CONTEXT_BYTES = 512
const MAX_MANAGED_ITEM_STEP_CACHE_BYTES = 4 * 1024 * 1024
/** Parsed, resumable JSON/event stages are bounded separately from their raw leases. */
const MAX_MANAGED_ITEM_STAGE_BYTES = 4 * 1024 * 1024
const REVISION_ROW_BYTES = 2048
const RELATION_ROW_BYTES = 1024
const LEGACY_EVENT_ROW_BYTES = 4096
const MAX_ROW_BYTES = 64 * 1024
const MAX_ID_BYTES = 256
const MAX_DIRECT_ORIGIN_METADATA_BYTES = 4096
/** Index metadata is bounded to 16 entries/table, 3 key rows/index, 128/64-byte names, plus fixed origin JSON. */
const DIRECT_ORIGIN_KEY_OVERHEAD_BYTES = 8192
const DIRECT_ORIGIN_LOOKUP_COST = Object.freeze({
  sqlStatements: 25,
  rowsVisited: 96,
  materializedBytes: 100 * 1024,
})
const DIRECT_ORIGIN_SCHEMA_FENCE_COST = Object.freeze({
  sqlStatements: 1, rowsVisited: 1, materializedBytes: 256, keyBytes: 0,
})
const DIRECT_ORIGIN_SCOPE_CACHE_BASE_BYTES = 1024
const MAX_SQLITE_SCHEMA_VERSION_KEY = 9_999_999_999
const MAX_SOURCE_EVENT_BYTES = 2000
const MAX_NODES_PER_ROOT = 500
const MAX_RELATIONS_PER_NODE = 200
const MAX_SOURCE_IDS = 100
const NODE_ACCOUNTING_BYTES = 96
const EDGE_ACCOUNTING_BYTES = 96
const SOURCE_IDENTITY_MAX_TEXT_BYTES = 5 * 4096
const SOURCE_IDENTITY_ROW_BYTES = SOURCE_IDENTITY_MAX_TEXT_BYTES + 128
const ACCOUNTING_BLOCK = 32
const MAX_AGENT_PATTERNS = 100
const MAX_MEMO_ENTRIES = 2048
const MEMO_ENTRY_BYTES = 256
const BINDING_KEYS = ['asOf', 'filterKey', 'generationId', 'policyKey', 'projectKeys', 'viewKey'] as const
const MEMORY_STATUSES = new Set(['candidate', 'approved', 'forgotten'])
const REVISION_STATES = new Set(['known', 'unknown'])
const VALID_FROM_PRECISIONS = new Set(['instant', 'second', 'minute', 'day', 'month', 'year', 'unknown'])
const VALID_FROM_BASES = new Set(['default_record_time', 'explicit', 'explicit_unknown'])
const DEPENDENCY_TYPES = new Set(['depends_on', 'derived_from'])
/** Internal aggregate handoff, intentionally invisible to string-keyed DTO serialization. */
export const dashboardAggregateDirectOriginProof = Symbol('dashboard-aggregate-direct-origin-proof')

/**
 * Bounded directory-member label capability. These are conservative work
 * reservations for one label read, one pre-publication recheck on the same
 * connection, and the member's resident lease. The aggregate reserves this
 * envelope before it scans or labels; the capability charges the real values.
 */
const DIRECTORY_LABEL_MAX_KEYS = 15
const DIRECTORY_LABEL_MAX_ENUMERATED = 256
const DIRECTORY_LABEL_MAX_KEY_BYTES = 256
const DIRECTORY_LABEL_NAME_BYTES = 256
/**
 * A normal read-only MemoryStore open runs: PRAGMA user_version (1 row),
 * sqlite_master required-tables lookup (worst case 10 rows), schema_version
 * (1 row), then two PRAGMA setters. Charged before the opener runs.
 */
const DIRECTORY_LABEL_OPEN_SQL = 5
const DIRECTORY_LABEL_OPEN_ROWS = 12
const DIRECTORY_LABEL_OPEN_MATERIALIZED_BYTES = 2048
const DIRECTORY_LABEL_OPEN_KEY_BYTES = 512
const DIRECTORY_LABEL_META_SQL = 1
const DIRECTORY_LABEL_META_ROWS = 1
const DIRECTORY_LABEL_META_MATERIALIZED_BYTES = 512
const DIRECTORY_LABEL_VERSION_SQL = 2
const DIRECTORY_LABEL_VERSION_ROWS = 2
const DIRECTORY_LABEL_VERSION_MATERIALIZED_BYTES = 256
const DIRECTORY_LABEL_SQL = DIRECTORY_LABEL_OPEN_SQL + DIRECTORY_LABEL_META_SQL + DIRECTORY_LABEL_VERSION_SQL
const DIRECTORY_LABEL_ROWS = DIRECTORY_LABEL_OPEN_ROWS + DIRECTORY_LABEL_META_ROWS + DIRECTORY_LABEL_VERSION_ROWS
const DIRECTORY_LABEL_MATERIALIZED_BYTES = DIRECTORY_LABEL_OPEN_MATERIALIZED_BYTES +
  DIRECTORY_LABEL_META_MATERIALIZED_BYTES + DIRECTORY_LABEL_VERSION_MATERIALIZED_BYTES
const DIRECTORY_VERIFY_SQL = 3
const DIRECTORY_VERIFY_ROWS = 3
const DIRECTORY_VERIFY_MATERIALIZED_BYTES = DIRECTORY_LABEL_META_MATERIALIZED_BYTES + DIRECTORY_LABEL_VERSION_MATERIALIZED_BYTES
const DIRECTORY_MEMBER_HANDLE_BYTES = 1024

/** Work charged when a page's accumulated labels are rechecked before publication. */
export const DASHBOARD_DIRECTORY_VERIFY_RESERVE: Readonly<DashboardReadCost> = Object.freeze({
  sqlStatements: DIRECTORY_VERIFY_SQL,
  rowsVisited: DIRECTORY_VERIFY_ROWS,
  materializedBytes: DIRECTORY_VERIFY_MATERIALIZED_BYTES,
  keyBytes: DIRECTORY_LABEL_MAX_KEY_BYTES,
})

/** Per-member work envelope: label SQL, pre-publication recheck SQL, and resident lease. */
export const DASHBOARD_DIRECTORY_MEMBER_RESERVE: Readonly<DashboardReadCost> = Object.freeze({
  sqlStatements: DIRECTORY_LABEL_SQL + DIRECTORY_VERIFY_SQL,
  rowsVisited: DIRECTORY_LABEL_ROWS + DIRECTORY_VERIFY_ROWS,
  materializedBytes: DIRECTORY_LABEL_MATERIALIZED_BYTES + DIRECTORY_VERIFY_MATERIALIZED_BYTES + DIRECTORY_MEMBER_HANDLE_BYTES,
  keyBytes: DIRECTORY_LABEL_OPEN_KEY_BYTES + DIRECTORY_LABEL_MAX_KEY_BYTES * 2,
})

function isValidFromState(value: unknown): value is 'known' | 'unknown' {
  return typeof value === 'string' && REVISION_STATES.has(value)
}

function isValidFromPrecision(value: unknown): value is ValidFromPrecision {
  return typeof value === 'string' && VALID_FROM_PRECISIONS.has(value)
}

function isValidFromBasis(value: unknown): value is ValidFromBasis {
  return typeof value === 'string' && VALID_FROM_BASES.has(value)
}

type SelectedRevisionRow = DashboardVisibilityRevisionPageRow & {
  inlineSourceJson?: string
  validFromState: 'known' | 'unknown'
  validFromPrecision: ValidFromPrecision
  validFromBasis: ValidFromBasis
}

type ValidatedManagedMemoryView = DashboardManagedMemoryView & {
  validFromState: 'known' | 'unknown'
  validFromPrecision: ValidFromPrecision
  validFromBasis: ValidFromBasis
}

export type DashboardVisibilityState = 'visible' | 'hidden' | 'unresolved'

export interface DashboardVisibleMemory {
  id: string
  content: string
  kind: string
  scene?: string
  confidence: number
  status: 'approved'
  source: string
  sourceMessageIds: string[]
  createdAt: number
  updatedAt: number
  approvedAt?: number
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
  expiryAt?: number
}

export interface DashboardVisibilityItem {
  state: DashboardVisibilityState
  id?: string
  reason?: string
  record?: DashboardVisibleMemory | MemoryRecord
  summary?: DashboardVisibleMemorySummary
}

export interface DashboardVisibleMemorySummary {
  id: string
  kind: string
  scene?: string
  confidence: number
  status: 'candidate' | 'approved' | 'forgotten'
  source: string
  sourceMessageIds: string[]
  contentBytes: number
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
  expiryAt?: number
  /** Internal symbol only; JSON/RPC projections never expose creation provenance. */
  [dashboardAggregateDirectOriginProof]?: boolean
}

export interface DashboardVisibilityPage {
  items: DashboardVisibilityItem[]
  nextCursor?: DashboardVisibilityMemoryCursor
  /** True means the raw candidate page had an unexamined row or sentinel. */
  hasMore: boolean
}

/** Internal call/session capacity snapshot; combined is the conservative minimum. */
export interface DashboardReadRemainingWork {
  call: DashboardReadCost
  session: DashboardReadCost
  combined: DashboardReadCost
}

/** One trusted read-only member connection handed to directory label probes. */
export interface DashboardDirectoryMemberHandle {
  readonly store: MemoryStore
  /** Release this runtime's reference to the connection; must be idempotent. */
  release(): void
}

/** Immutable directory scope bound into an internal label capability. */
export interface DashboardDirectoryLabelScope {
  readonly readId: string
  readonly directory: string
  readonly marker: string
}

/** Fixed key/name projection returned by a directory label capability. */
export interface DashboardDirectoryMemberLabel {
  readonly key: string
  /** Friendly project_meta name when bounded and valid, otherwise the key itself. */
  readonly name: string
  /** UTF-8 byte length of the projected project_meta name, or 0 for the key fallback. */
  readonly nameBytes: number
  /** True only when this process opened the member store and matched its connection stamp. */
  readonly proven: boolean
}

export interface DashboardDirectoryMemberCapacity {
  call: number
  session: number
  combined: number
}

/**
 * Internal, non-RPC capability created only by the aggregate for the directory
 * it is currently enumerating. It can return fixed key/name projections for
 * enumerated keys only; it never changes the immutable body binding and never
 * exposes readProject/resolveRoot/source helpers.
 */
export interface DashboardDirectoryLabelReader {
  readonly readId: string
  readonly directory: string
  readonly marker: string
  enumerate(keys: readonly string[]): DashboardReadOutcome<void>
  remainingMemberCapacity(): DashboardDirectoryMemberCapacity | undefined
  readLabels(keys: readonly string[]): DashboardReadOutcome<DashboardDirectoryMemberLabel[]>
  verifyLabels(keys: readonly string[]): DashboardReadOutcome<void>
  release(): void
}

export interface DashboardSceneMetaRow {
  name?: string
  nameBytes: number
  memoryCount: number
  updatedAt: number
  summaryBytes: number
  summaryComplete: boolean
  sourceIdsBytes: number
  sourceRevisionsBytes: number
  dirty: boolean
  frontierReady: boolean
}

export interface DashboardSceneMemberRow { memoryId?: string; memoryIdBytes: number; revision: number; ordinal: number }

/** Stable digest over the normalized member identity/order, never over the stale JSON cache. */
export function dashboardSceneMemberDigest(rows: readonly DashboardSceneMemberRow[]): string {
  const hash = createHash('sha256')
  for (const row of rows) hash.update(`${row.memoryId ?? ''}\0${row.revision}\0${row.ordinal}\n`, 'utf8')
  return hash.digest('hex')
}

export function isValidDashboardSceneMember(row: DashboardSceneMemberRow): row is DashboardSceneMemberRow & { memoryId: string } {
  return typeof row.memoryId === 'string' && row.memoryId.length > 0 &&
    Number.isSafeInteger(row.memoryIdBytes) && row.memoryIdBytes >= 1 && row.memoryIdBytes <= 256 &&
    Buffer.byteLength(row.memoryId, 'utf8') === row.memoryIdBytes &&
    Number.isSafeInteger(row.revision) && row.revision >= 1 && Number.isSafeInteger(row.ordinal)
}

export interface DashboardManagedMemoryResult {
  state: DashboardVisibilityState
  record?: MemoryRecord
  summary?: DashboardVisibleMemorySummary
  reason?: string
}

export interface DashboardVisibilityOpenOptions {
  /** Trusted global-profile opener, charged once before its first SQLite statement. */
  prepareStores?: { cost: DashboardReadCost; run(): void }
  manager: DashboardReadSessionManager
  control: ControlLedger
  stores: ReadonlyMap<string, MemoryStore>
  binding: DashboardReadBinding
  excludedAgentPatterns?: readonly string[]
  wallNow?: () => number
  onEnd?: (status: DashboardReadFailureStatus, reason: string) => void
  /**
   * Trusted runtime opener for one internally enumerated directory member.
   * Supplied only by the runtime that owns the project directory; never by RPC
   * arguments. The handler must return a real store whose file is
   * `<directory>/<key>/memory.db` and an idempotent release.
   */
  openDirectoryMember?: (projectKey: string) => DashboardReadOutcome<DashboardDirectoryMemberHandle>
}

/** A continuation-budget failure is safe to expose only after the final proof passed. */
export type DashboardSuspendOutcome = DashboardReadOutcome<{ continuationToken: string }> |
  { status: 'handoff-exhausted'; proofComplete: true; reason: string }

interface NodeProof {
  state: DashboardVisibilityState
  revision?: number
  expiryAt?: number | null
  reason?: string
}

/** Scope-bound, resident-accounted raw rows and fully proved results for one task page. */
interface ManagedPageContinuation {
  key: string
  rows: DashboardVisibilityMemoryPageRow[]
  hasMore: boolean
  items: DashboardVisibilityItem[]
  itemReservations: string[]
  reservations: string[]
  pendingItem?: ManagedPageItemProgress
}

interface ManagedPageStep {
  signature: string
  value: unknown
  reservation: string
  bytes: number
}

interface DirectOriginSchemaScope {
  projectKey: string
  store: MemoryStore
  binding: DashboardReadBinding
  schemaVersion?: number
  cacheReservation: string
  keyReservation: string
  projectKeyBytes: number
}

interface DirectOriginProofCacheValue {
  trusted: boolean
  schemaVersion: number
}

interface ManagedPageResource {
  reservation: string
  bytes: number
}

interface ManagedPageStage {
  signature: string
  value: unknown
  bytes: number
}

interface ManagedPageItemProgress {
  key: string
  itemReservation: string
  incrementalOutput?: { baseBytes: number; reservedBytes: number }
  bytes: number
  stageBytes: number
  steps: Map<string, ManagedPageStep>
  resources: Map<string, ManagedPageResource>
  stages: Map<string, ManagedPageStage>
  approvedProof?: ManagedApprovedProofProgress
}

interface LoadedNode {
  projectKey: string
  id: string
  meta: DashboardVisibilityMemoryMeta
  revision: SelectedRevisionRow
  sourceIds: string[]
}

interface DependencyEdge {
  fromId: string
  toId: string
  fromRevision: number
  toRevision: number
  evidenceIds: string[]
}

interface LegacyIdentity {
  sourceEventId?: string
}

interface JsonResult {
  ok: boolean
  value?: unknown
}

interface NodeLoad {
  state: DashboardVisibilityState
  node?: LoadedNode
  reason?: string
}

interface RevisionSelection {
  state: 'selected' | 'none' | 'unresolved'
  revision?: SelectedRevisionRow
  reason?: string
}

interface RelationLoad {
  state: DashboardVisibilityState
  edges: DependencyEdge[]
  reason?: string
}

interface ManagedRelationProgress {
  identity: string
  after?: DashboardVisibilityRelationCursor
  rows?: DashboardVisibilityRelationPageRow[]
  hasMore: boolean
  rowIndex: number
  rowCounted: boolean
  rawCount: number
  edges: DependencyEdge[]
}

interface ManagedSourceBatchProgress {
  identity: string
  sourceIds: string[]
  eventIds: string[]
  nextSourceIndex: number
}

interface ManagedApprovedProofProgress {
  key: string
  root: LoadedNode
  graph: Map<string, LoadedNode>
  edges: DependencyEdge[]
  pending: string[]
  scheduled: Set<string>
  nodeCount: number
  rawRelationCount: number
  currentId?: string
  currentMemoDecision?: boolean
  inheritedEarliestExpiry?: number
  relation?: ManagedRelationProgress
  graphChecked: boolean
  expiryComputed: boolean
  earliestExpiry?: number
  sourceSets?: { memory: string[]; evidence: string[]; memoryBatches: string[][]; allBatches: string[][] }
  sourceBatches: Map<string, ManagedSourceBatchProgress>
  memoCommitted: boolean
}

interface SourceVerification {
  state: DashboardVisibilityState
  reason?: string
}

interface FenceCheck {
  state: DashboardVisibilityState
  fences?: DashboardVisibilityFences
  reason?: string
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * Accept only the one-key JSON shape emitted by the native approval writer.
 * Parsing a JSON string literal avoids materializing arbitrary nested metadata
 * objects while retaining the direct `source: "review"` writer path.
 */
function trustedDirectCreationOrigin(origin: DashboardVisibilityDirectCreationOrigin | undefined): boolean {
  if (origin === undefined || !safeInteger(origin.schemaVersion) || origin.schemaVersion < 0 ||
      !origin.lookupCapabilitySupported || !origin.creationApproved ||
      !origin.creationReasonIsText || !origin.approvalFound || !origin.approvalCountIsOne ||
      !origin.approvalCreatedAtIsSafe || !origin.approvalOccurredAtIsSafe ||
      !origin.approvalMetadataIsText || origin.approvalMetadata === undefined ||
      !safeInteger(origin.approvalMetadataBytes) || origin.approvalMetadataBytes < 1 ||
      origin.approvalMetadataBytes > MAX_DIRECT_ORIGIN_METADATA_BYTES ||
      Buffer.byteLength(origin.approvalMetadata, 'utf8') !== origin.approvalMetadataBytes) return false
  const metadata = origin.approvalMetadata
  const prefix = '{"source":"'
  if (!metadata.startsWith(prefix) || !metadata.endsWith('"}')) return false
  let source: unknown
  try { source = JSON.parse(`"${metadata.slice(prefix.length, -2)}"`) } catch { return false }
  return typeof source === 'string' && Buffer.byteLength(source, 'utf8') <= 512
}

function optionalInteger(value: number | null | undefined): boolean {
  return value === null || value === undefined || safeInteger(value)
}

/** Validate and copy the immutable visibility scope before a runtime looks up any project handle. */
export function normalizeDashboardVisibilityBinding(input: unknown): DashboardReadBinding | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return undefined
    const keys = Reflect.ownKeys(input)
    if (keys.length !== BINDING_KEYS.length || keys.some((key) => typeof key !== 'string' ||
        !BINDING_KEYS.includes(key as typeof BINDING_KEYS[number]))) return undefined
    const record = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined || !('value' in descriptor)) return undefined
      record[key] = descriptor.value
    }
    const asOf = record.asOf
    const generationId = record.generationId
    const policyKey = record.policyKey
    const filterKey = record.filterKey
    const viewKey = record.viewKey
    const boundedKey = (value: unknown, maxBytes: number): value is string =>
      typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= maxBytes
    if (!safeInteger(asOf) || asOf < 0 ||
        !boundedKey(generationId, 128) || !boundedKey(policyKey, 128) ||
        !boundedKey(filterKey, 128) || !/^[a-f0-9]{64}$/u.test(policyKey) ||
        !/^[a-f0-9]{64}$/u.test(filterKey) || !boundedKey(viewKey, 64) ||
        !/^[a-z][a-z0-9._-]{0,63}$/u.test(viewKey)) return undefined
    const rawProjects = record.projectKeys
    if (!Array.isArray(rawProjects) || rawProjects.length > 4 ||
        Reflect.ownKeys(rawProjects).some((key) => key !== 'length' &&
          (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= rawProjects.length))) return undefined
    const projectKeys: string[] = []
    for (let index = 0; index < rawProjects.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawProjects, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !boundedKey(descriptor.value, 256)) return undefined
      projectKeys.push(descriptor.value)
    }
    if (new Set(projectKeys).size !== projectKeys.length) return undefined
    projectKeys.sort()
    return Object.freeze({
      asOf, generationId, policyKey, filterKey, viewKey, projectKeys: Object.freeze(projectKeys),
    })
  } catch { return undefined }
}

interface DirectoryLabelMemberRecord {
  readonly label: DashboardDirectoryMemberLabel
  readonly handle?: DashboardDirectoryMemberHandle
  readonly lease?: string
  readonly rawName?: string
  readonly rawNameBytes: number
  readonly stamp?: DashboardReadVersionStamp
}

function boundedDirectoryMemberKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= DIRECTORY_LABEL_MAX_KEY_BYTES && isValidProjectKey(value)
}

function copyDirectoryMemberKeys(input: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(input) || input.length > limit) return undefined
  if (Reflect.ownKeys(input).some((key) => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= input.length))) return undefined
  const keys: string[] = []
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (descriptor === undefined || !('value' in descriptor) || !boundedDirectoryMemberKey(descriptor.value)) return undefined
    keys.push(descriptor.value)
  }
  return keys
}

/** Current dev/ino observation for the enumerated member database path. */
function currentMemberFileIdentity(directory: string, key: string): { dev: number; ino: number } | undefined {
  try {
    const stat = lstatSync(path.join(directory, key, 'memory.db'), { throwIfNoEntry: false })
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) return undefined
    return { dev: stat.dev, ino: stat.ino }
  } catch { return undefined }
}

/** A live member connection may label this key only when its saved path observation matches the current path observation. */
function connectionMatchesMemberFile(store: MemoryStore, directory: string, key: string): boolean {
  const current = currentMemberFileIdentity(directory, key)
  const opened = store.dashboardFileIdentity()
  return current !== undefined && opened !== undefined && current.dev === opened.dev && current.ino === opened.ino
}

function validDirectoryMemberProjection(
  meta: { name?: string; nameBytes: number } | undefined,
  stamp: DashboardReadVersionStamp | undefined,
): boolean {
  if (stamp === undefined || stamp.scope !== 'project' || typeof stamp.connectionId !== 'string' ||
      !Number.isSafeInteger(stamp.dataVersion) || stamp.dataVersion < 0 ||
      !Number.isSafeInteger(stamp.totalChanges) || stamp.totalChanges < 0) return false
  if (meta === undefined) return true
  if (!Number.isSafeInteger(meta.nameBytes) || meta.nameBytes < 0) return false
  if (meta.name !== undefined && Buffer.byteLength(meta.name, 'utf8') !== meta.nameBytes) return false
  return true
}

/** A single S1 session wrapper shared by pages, roots, probes, and memo entries. */
export class DashboardVisibilityReadSession {
  private readonly manager: DashboardReadSessionManager
  private readonly control: ControlLedger
  private readonly stores: Map<string, MemoryStore>
  private readonly globalHandles = new Map<string, DashboardDirectoryMemberHandle>()
  private binding: DashboardReadBinding
  private projectKeys: readonly string[]
  private personaReserve: { rounds: number } | undefined
  private readonly excludedAgentPatterns: readonly string[]
  private readonly wallNow: () => number
  private readonly onEnd?: (status: DashboardReadFailureStatus, reason: string) => void
  private readonly openDirectoryMember?: (projectKey: string) => DashboardReadOutcome<DashboardDirectoryMemberHandle>
  private callToken: string
  private continuationToken: string | undefined
  private paused = false
  private ended = false
  private lastWallNow: number | undefined
  private callGeneration = 0
  private readonly memo = new Map<string, NodeProof>()
  private readonly memoReservations: string[] = []
  private memoProofStateLost = false
  // Constant-size proof of a streamed derived index. The same native connection
  // probes stay alive across every batch; no body or unbounded ID set is retained.
  private derivedProof?: { token: string; projectKey: string; layer: 'L2' | 'L3'; identity: string;
    count: number; ordinal?: number; digest: Hash }
  private provenExpiryAt?: number
  private readonly managedPageContinuations = new Map<string, ManagedPageContinuation>()
  private readonly managedProofContinuations = new Map<string, ManagedPageItemProgress>()
  private readonly managedPageLeaseTokens = new Set<string>()
  private activeManagedPageItem: ManagedPageItemProgress | undefined
  private aggregateIntermediateReadDepth = 0
  private overviewFusionDepth = 0
  private overviewFusion: { binding: DashboardReadBinding; controlSchema: number; bytes: number;
    scopes: Map<MemoryStore, { connectionId: string; schemaVersion: number }>;
    entries: Map<string, { source: MemoryStore | ControlLedger; signature: string; value: unknown }> } | undefined
  private directOriginSchemaScopes: Map<string, DirectOriginSchemaScope> | undefined
  private directoryLabelRegistry: { dispose(): void } | undefined

  private constructor(options: DashboardVisibilityOpenOptions, callToken: string) {
    this.manager = options.manager
    this.control = options.control
    this.stores = new Map(options.stores)
    this.binding = Object.freeze({ ...options.binding, projectKeys: Object.freeze([...options.binding.projectKeys]) })
    this.projectKeys = this.binding.projectKeys
    this.excludedAgentPatterns = Object.freeze([...(options.excludedAgentPatterns ?? [])])
    this.wallNow = options.wallNow ?? Date.now
    this.onEnd = options.onEnd
    this.openDirectoryMember = options.openDirectoryMember
    this.callToken = callToken
  }

  static open(options: DashboardVisibilityOpenOptions): DashboardReadOutcome<DashboardVisibilityReadSession> {
    const binding = normalizeDashboardVisibilityBinding(options.binding)
    if (binding === undefined || options.prepareStores === undefined && binding.projectKeys.some((key) => !options.stores.has(key)) ||
        options.excludedAgentPatterns !== undefined && (!Array.isArray(options.excludedAgentPatterns) ||
          options.excludedAgentPatterns.length > MAX_AGENT_PATTERNS ||
          options.excludedAgentPatterns.some((pattern) => typeof pattern !== 'string' || Buffer.byteLength(pattern, 'utf8') > 256))) {
      return { status: 'unavailable-probe', reason: 'visibility-scope-invalid' }
    }
    let session: DashboardVisibilityReadSession | undefined
    const begun = options.manager.begin(binding, (status, reason) => session?.managerEnded(status, reason))
    if (begun.status !== 'ok') return begun
    if (options.prepareStores !== undefined) {
      try {
        const prepared = options.manager.run(begun.value.callToken, options.prepareStores.cost, () => options.prepareStores!.run())
        if (prepared.status !== 'ok') { options.manager.cancel(begun.value.callToken); return prepared }
        if (binding.projectKeys.some((key) => !options.stores.has(key))) throw new Error('prepared scope missing')
      } catch {
        options.manager.cancel(begun.value.callToken)
        return { status: 'unavailable-probe', reason: 'global-store-opening-failed' }
      }
    }
    session = new DashboardVisibilityReadSession({ ...options, binding }, begun.value.callToken)
    const probes = session.probeAllScopes()
    if (probes.status !== 'ok') {
      options.manager.cancel(session.callToken)
      session.end()
      return probes
    }
    if (session.readWallNow() === undefined) {
      session.finishOnFailure()
      return session.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    return { status: 'ok', value: session }
  }

  /** Every contributor stays bound until this publication window is closed; its memo and origin fences stay live. */
  globalPublicationSources(): readonly string[] { return this.projectKeys }
  globalPublicationSourceLimit(): number { return Math.min(4, this.manager.limits.perCall.projects) }
  selectGlobalSource(key: string): DashboardReadOutcome<void> {
    if (this.ended || this.paused || this.binding.viewKey !== 'memory.global.v7') return this.failure('stale', 'global-scope-unavailable')
    if (this.projectKeys.includes(key)) return { status: 'ok', value: undefined }
    if (this.projectKeys.length >= this.globalPublicationSourceLimit()) return this.failure('budget-exhausted', 'global-source-window-full')
    const headroom = this.remainingReadWork()
    const opening = this.stores.has(key) ? 0 : 1
    const originScopes = this.directOriginSchemaScopes?.size ?? 0
    const boundary = 2 * (2 + this.projectKeys.length) + originScopes
    const rounds = 1 + Math.max(2, this.personaReserve?.rounds ?? 0)
    // Admit the new full-scope probe AND both publication/handoff proofs before opening anything.
    if (headroom === undefined || headroom.sqlStatements < opening * 5 + boundary * rounds ||
        headroom.rowsVisited < opening * 12 + boundary * rounds ||
        headroom.materializedBytes < 16384 + originScopes * 256 * rounds || headroom.keyBytes < 16384) {
      return this.failure('budget-exhausted', 'global-source-handoff-headroom')
    }
    // Open is admitted against the old, fully probed scope BEFORE rebinding; its project is metered once.
    if (!this.stores.has(key)) {
      const reserved = this.reserveReadState(4096)
      if (reserved.status !== 'ok') return reserved
      const opened = this.manager.runMember(this.callToken, key, { sqlStatements: 5, rowsVisited: 12, materializedBytes: 2048, keyBytes: 512 }, () => this.openDirectoryMember?.(key))
      if (opened.status !== 'ok') { this.releaseReadState(reserved.value.reservationToken); return opened }
      if (opened.value === undefined || opened.value.status !== 'ok') {
        this.releaseReadState(reserved.value.reservationToken)
        return this.failure('unavailable-probe', 'global-source-opening-failed')
      }
      this.globalHandles.set(key, opened.value.value); this.stores.set(key, opened.value.value.store)
    }
    const selected = this.manager.selectGlobalSource(this.callToken, key)
    if (selected.status !== 'ok') return selected
    // These are completed per-source traversal scratch, never the shared visible-proof memo.
    this.releaseManagedPageContinuation(); this.releaseManagedProofContinuations()
    this.binding = selected.value; this.projectKeys = this.binding.projectKeys
    // Only project membership grew; asOf/filter/policy and each original store identity are unchanged.
    for (const scope of this.directOriginSchemaScopes?.values() ?? []) scope.binding = this.binding
    const proven = this.publishProof()
    if (proven.status !== 'ok') this.finishOnFailure()
    return proven
  }
  retainGlobalProgress(dispose: () => void, keep?: string): DashboardReadOutcome<string> {
    return this.manager.retainGlobalProgress(this.callToken, dispose, keep)
  }
  private releaseGlobalHandles(): void {
    for (const handle of this.globalHandles.values()) { try { handle.release() } catch { /* cleanup */ } }
    this.globalHandles.clear()
  }

  /** Resolve one exact memory ID; body bytes are fetched only after a complete proof. */
  resolveRoot(projectKey: string, memoryId: string, maxBodyBytes = MAX_ROW_BYTES): DashboardReadOutcome<DashboardVisibilityItem> {
    if (!this.isBoundProject(projectKey) || !this.validId(memoryId)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0 || maxBodyBytes > MAX_ROW_BYTES) {
      return this.failure('unavailable-probe', 'visibility-body-limit-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('root', projectKey, memoryId, maxBodyBytes),
        () => this.resolveRootInContext(projectKey, memoryId, maxBodyBytes))
    }
    return this.resolveRootInContext(projectKey, memoryId, maxBodyBytes)
  }

  private resolveRootInContext(projectKey: string, memoryId: string,
    maxBodyBytes: number): DashboardReadOutcome<DashboardVisibilityItem> {
    const outputReservations: string[] = []
    try {
      let item: DashboardVisibilityItem
      const proof = this.proveRoot(projectKey, memoryId, outputReservations)
      if (proof.status !== 'ok') {
        if (proof.status === 'budget-exhausted' && this.memoProofStateLost) {
          this.finishOnFailure()
          return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
        }
        if (proof.status === 'budget-exhausted' && proof.reason !== 'persona-call-headroom') this.finishOnFailure()
        return proof
      } else if (proof.value.state !== 'visible' || proof.value.node === undefined) {
        item = { state: proof.value.state, id: memoryId,
          ...(proof.value.reason === undefined ? {} : { reason: proof.value.reason }) }
      } else {
        const record = this.readVisibleRecord(proof.value.node, outputReservations, maxBodyBytes)
        if (record.status === 'ok') {
          item = record.value === undefined
            ? { state: 'unresolved', id: memoryId, reason: 'visible-body-incomplete' }
            : { state: 'visible', id: memoryId, record: record.value }
        } else {
          if (record.status === 'budget-exhausted' && this.memoProofStateLost) {
            this.finishOnFailure()
            return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
          }
          if (record.status === 'budget-exhausted' && record.reason !== 'persona-call-headroom') this.finishOnFailure()
          return record
        }
      }
      const validated = this.validateBeforeRelease([item])
      if (validated.status !== 'ok') return validated
      return { status: 'ok', value: validated.value[0]! }
    } finally {
      this.releaseReservations(outputReservations)
    }
  }

  /** Candidate and forgotten management proof; it is isolated from approved recall proofs. */
  resolveManagedMemory(projectKey: string, memoryId: string, status: 'candidate' | 'forgotten', contentLimit: number | null = 8192): DashboardReadOutcome<DashboardManagedMemoryResult> {
    if (!this.isBoundProject(projectKey) || !this.validId(memoryId) ||
        contentLimit !== null && (!Number.isSafeInteger(contentLimit) || contentLimit < 0 || contentLimit > MAX_ROW_BYTES)) {
      return this.failure('unavailable-probe', 'managed-memory-key-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    let projectionLimit = this.overviewFusionDepth > 0 && status === 'candidate' &&
      (contentLimit === null || contentLimit === 16 * 1024) ? 16 * 1024 : contentLimit ?? 0
    let sourceLimit = MAX_ROW_BYTES
    if (this.overviewFusionDepth > 0) {
      const heads = this.overviewHeads(projectKey)
      if (heads.status !== 'ok') return heads
      const head = heads.value.branches[status].find((candidate) => candidate.id === memoryId)
      if (head !== undefined && safeInteger(head.contentBytes) && head.contentBytes > 0 && head.contentBytes <= MAX_ROW_BYTES &&
          safeInteger(head.sourceIdsBytes) && head.sourceIdsBytes >= 2 && head.sourceIdsBytes <= MAX_ROW_BYTES) {
        projectionLimit = Math.min(projectionLimit, head.contentBytes)
        sourceLimit = head.sourceIdsBytes
      }
    }
    const row = this.run(store, {
      sqlStatements: 1, rowsVisited: 1,
      materializedBytes: projectionLimit + sourceLimit + (this.overviewFusionDepth > 0 ? 8192 : PAGE_ROW_BYTES),
      keyBytes: this.keyBytes(projectKey, memoryId),
    }, () => store.dashboardManagedMemory(memoryId, projectionLimit, sourceLimit),
    JSON.stringify(['managed-memory', projectKey, memoryId, status,
      this.overviewFusionDepth > 0 ? [projectionLimit, sourceLimit] : contentLimit]))
    if (row.status !== 'ok') return row
    if (row.value === undefined) return { status: 'ok', value: { state: 'hidden', reason: 'memory-not-found' } }
    const meta = row.value
    if (!this.validManagedMemoryProjection(memoryId, meta, status)) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'managed-memory-metadata-invalid' } }
    }
    const now = this.readWallNow()
    if (now === undefined) return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    if (status === 'candidate' && (meta.expiryAt !== undefined && meta.expiryAt !== null && meta.expiryAt <= now ||
        meta.validFromState === 'known' && meta.validFrom !== null && meta.validFrom !== undefined && meta.validFrom > this.binding.asOf ||
        meta.validTo !== null && meta.validTo !== undefined && meta.validTo <= this.binding.asOf)) {
      return { status: 'ok', value: { state: 'hidden', reason: 'candidate-outside-current-validity' } }
    }
    const memoryFence = this.readFences({ projectKey, memoryIds: [memoryId] })
    if (memoryFence.status !== 'ok') return memoryFence
    if (memoryFence.value.state !== 'visible') return { status: 'ok', value: { state: memoryFence.value.state, reason: memoryFence.value.reason } }
    if (memoryFence.value.fences!.deletedMemoryIds.includes(memoryId) ||
        status === 'candidate' && memoryFence.value.fences!.forgottenMemoryIds.includes(memoryId)) {
      return { status: 'ok', value: { state: 'hidden', reason: 'memory-control-fence' } }
    }
    // The row length is validated before parsing/copying its source list or
    // constructing the output. A SQL projection capped at those lengths paid
    // for the input separately; this lease owns the retained output copies.
    const output = this.reserveManagedItemOutput(meta.sourceMessageIdsBytes,
      contentLimit === null ? 0 : Math.min(meta.contentBytes, contentLimit))
    if (output.status !== 'ok') return output
    const sourceIdsResult = this.parseManagedSourceIds(meta)
    if (sourceIdsResult === undefined) return { status: 'ok', value: { state: 'unresolved', reason: 'managed-source-list-invalid' } }
    const verified = this.verifySources(projectKey, sourceIdsResult, [])
    if (verified.status !== 'ok') return verified
    if (verified.value.state !== 'visible') return { status: 'ok', value: { state: verified.value.state, reason: verified.value.reason } }
    const expiryAt = status === 'candidate' && meta.expiryAt !== undefined && meta.expiryAt !== null ? meta.expiryAt : undefined
    const memoized = this.memoize([{ key: `${status}\0${this.memoKey(projectKey, memoryId)}`, proof: { state: 'visible', expiryAt } }])
    if (memoized.status !== 'ok') return memoized
    if (contentLimit === null) {
      const boundary = this.validateSnapshotBoundary()
      return boundary.status === 'ok' ? { status: 'ok', value: {
        state: 'visible', summary: this.visibleSummary(meta, status, sourceIdsResult),
      } } : boundary
    }
    if (meta.content === undefined || meta.contentBytes > contentLimit) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'managed-body-over-response-limit' } }
    }
    const record: MemoryRecord = {
      id: memoryId, content: meta.content, kind: meta.kind!, ...(meta.scene == null ? {} : { scene: meta.scene }),
      confidence: meta.confidence, status, source: meta.source!, sourceMessageIds: sourceIdsResult,
      createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      ...(meta.approvedAt == null ? {} : { approvedAt: meta.approvedAt }),
      ...(meta.forgottenAt == null ? {} : { forgottenAt: meta.forgottenAt }), revision: meta.revision,
      ...(meta.validFrom == null ? {} : { validFrom: meta.validFrom }),
      validFromState: meta.validFromState,
      validFromPrecision: meta.validFromPrecision,
      validFromBasis: meta.validFromBasis,
      ...(meta.validFromUpper == null ? {} : { validFromUpper: meta.validFromUpper }),
      ...(meta.validFromLabel == null ? {} : { validFromLabel: meta.validFromLabel }),
      ...(meta.validTo == null ? {} : { validTo: meta.validTo }), recordedAt: meta.recordedAt,
      ...(meta.supersededAt == null ? {} : { supersededAt: meta.supersededAt }), sourceVerified: meta.sourceVerified === 1,
    }
    const boundary = this.validateSnapshotBoundary()
    if (boundary.status !== 'ok') return boundary
    return { status: 'ok', value: { state: 'visible', record } }
  }

  readManagedPage(projectKey: string, status: 'candidate' | 'approved' | 'forgotten',
    after?: DashboardVisibilityMemoryCursor, limit = 15, contentLimit: number | null = 8192,
    taskKey = 'direct'): DashboardReadOutcome<DashboardVisibilityPage> {
    return this.readManagedPageInternal(projectKey, status, after, limit, contentLimit, taskKey)
  }

  private [aggregateManagedPage](projectKey: string, status: 'candidate' | 'approved' | 'forgotten',
    after?: DashboardVisibilityMemoryCursor, limit = 15, contentLimit: number | null = 8192,
    taskKey = 'direct'): DashboardReadOutcome<DashboardVisibilityPage> {
    this.aggregateIntermediateReadDepth += 1
    try { return this.readManagedPageInternal(projectKey, status, after, limit, contentLimit, taskKey) }
    finally { this.aggregateIntermediateReadDepth -= 1 }
  }

  private [aggregateOverviewWork]<T>(operation: () => T): T {
    // Single-project behavior and public library/detail calls retain their
    // existing proof contexts. Only a trusted multi-project overview shares.
    if (this.projectKeys.length < 2) return operation()
    this.overviewFusionDepth += 1
    try { return operation() } finally { this.overviewFusionDepth -= 1 }
  }

  private overviewHeads(projectKey: string): DashboardReadOutcome<ReturnType<MemoryStore['dashboardOverviewMemoryHeads']>> {
    const store = this.stores.get(projectKey)!
    // Charge bounded PRAGMA input and CTE re-reads as well as the four data seeks.
    const result = this.run(store, { sqlStatements: 2, rowsVisited: 320, materializedBytes: 16 * PAGE_ROW_BYTES + 16384,
      keyBytes: 4 * this.keyBytes(projectKey) + 64 }, () => store.dashboardOverviewMemoryHeads(),
    JSON.stringify(['overview-heads', projectKey]))
    if (result.status !== 'ok') return result
    const observed = result.value
    if (observed.projectKey !== projectKey || typeof observed.connectionId !== 'string' ||
        observed.connectionId.length !== 36 || !safeInteger(observed.schemaVersion)) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'overview-schema-observation-invalid')
    }
    const prior = this.overviewFusion?.scopes.get(store)
    if (prior !== undefined && (prior.connectionId !== observed.connectionId || prior.schemaVersion !== observed.schemaVersion)) {
      this.finishOnFailure()
      return this.failure('stale', 'overview-schema-changed')
    }
    this.overviewFusion?.scopes.set(store, { connectionId: observed.connectionId, schemaVersion: observed.schemaVersion })
    return result
  }

  /** Trusted overview-only event ceiling, acquired with the bounded head/schema statement. */
  readOverviewEventTail(projectKey: string): DashboardReadOutcome<number> {
    if (this.overviewFusionDepth < 1 || !this.isBoundProject(projectKey)) {
      return this.failure('unavailable-probe', 'overview-event-scope-invalid')
    }
    const heads = this.overviewHeads(projectKey)
    if (heads.status !== 'ok') return heads
    if (!heads.value.ready || !safeInteger(heads.value.eventTailId)) {
      return this.failure('unavailable-probe', 'overview-event-tail-invalid')
    }
    return { status: 'ok', value: heads.value.eventTailId }
  }

  private overviewMemoryHeadPage(projectKey: string, status: 'candidate' | 'approved' | 'forgotten', limit: number):
    DashboardReadOutcome<ReturnType<MemoryStore['dashboardVisibilityMemoryPage']>> {
    const heads = this.overviewHeads(projectKey)
    if (heads.status !== 'ok') return heads
    if (!heads.value.ready || heads.value.projectKey !== projectKey) return this.failure('unavailable-probe', 'overview-head-index-missing')
    const rows = heads.value.branches[status]
    return { status: 'ok', value: { rows: rows.slice(0, limit), hasMore: rows.length >= limit } }
  }

  private overviewNodePage(projectKey: string, memoryId: string):
    DashboardReadOutcome<ReturnType<MemoryStore['dashboardVisibilityNodePage']>> {
    const heads = this.overviewHeads(projectKey)
    if (heads.status !== 'ok') return heads
    if (!heads.value.ready || heads.value.projectKey !== projectKey) return this.failure('unavailable-probe', 'overview-head-index-missing')
    const store = this.stores.get(projectKey)!
    const page = this.run(store, { sqlStatements: 1, rowsVisited: 192,
      materializedBytes: 2 * (PAGE_ROW_BYTES + REVISION_ROW_BYTES + 1024) + 16384,
      keyBytes: this.keyBytes(projectKey, memoryId, memoryId) }, () => store.dashboardVisibilityNodePage(memoryId, 2, 1024),
    JSON.stringify(['overview-node', projectKey, memoryId]))
    if (page.status !== 'ok') return page
    if (page.value.projectKey !== projectKey) return this.failure('unavailable-probe', 'overview-node-project-mismatch')
    return page
  }

  private overviewRecentHeadPage(projectKey: string, limit: number): DashboardReadOutcome<{
    ready: boolean; page?: ReturnType<MemoryStore['dashboardRecentApprovedPage']>
  }> {
    const heads = this.overviewHeads(projectKey)
    if (heads.status !== 'ok') return heads
    if (!heads.value.ready || heads.value.projectKey !== projectKey) return this.failure('unavailable-probe', 'overview-head-index-missing')
    const rows = heads.value.branches.recent
    return { status: 'ok', value: { ready: true, page: { rows: rows.slice(0, limit), hasMore: rows.length > limit } } }
  }

  private readManagedPageInternal(projectKey: string, status: 'candidate' | 'approved' | 'forgotten',
    after?: DashboardVisibilityMemoryCursor, limit = 15, contentLimit: number | null = 8192,
    taskKey = 'direct'): DashboardReadOutcome<DashboardVisibilityPage> {
    if (!this.isBoundProject(projectKey) || after !== undefined &&
        (!safeInteger(after.createdAt) || !this.validId(after.id)) || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_ITEMS ||
        contentLimit !== null && (!Number.isSafeInteger(contentLimit) || contentLimit < 0 || contentLimit > MAX_ROW_BYTES) ||
        typeof taskKey !== 'string' || taskKey.length < 1 || Buffer.byteLength(taskKey, 'utf8') > 256) {
      return this.failure('unavailable-probe', 'managed-memory-page-scope-invalid')
    }
    if (this.ended) return this.failure('stale', 'visibility-session-ended')
    if (this.paused) return this.failure('stale', 'visibility-session-suspended')
    if (this.memoProofStateLost) {
      this.finishOnFailure()
      return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
    }
    const key = this.managedPageContinuationKey(projectKey, status, after, contentLimit, taskKey)
    const releaseHandoffReserve = this.beginPersonaProofGuard(1)
    try {
      const live = this.ensureLive()
      if (live.status !== 'ok') return live
      let continuation = this.managedPageContinuations.get(key)
      if (continuation === undefined) {
        if (this.managedPageContinuations.size + this.managedProofContinuations.size >= MAX_MANAGED_PAGE_CONTINUATIONS) {
          return this.failure('budget-exhausted', 'managed-page-continuation-capacity')
        }
        const store = this.stores.get(projectKey)!
        const rawLimit = Math.min(PAGE_ROWS, limit + 1)
        const rawCost = { sqlStatements: 1, rowsVisited: rawLimit, materializedBytes: rawLimit * PAGE_ROW_BYTES,
          keyBytes: this.keyBytes(projectKey, after?.id) }
        const rawCacheBytes = rawLimit * PAGE_ROW_BYTES + Buffer.byteLength(key, 'utf8') + 512
        const admission = this.personaReserveStatus({ ...rawCost,
          materializedBytes: rawCost.materializedBytes + rawCacheBytes })
        if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
        const rawReservation = this.reserveManagedPageCache(rawCacheBytes)
        if (rawReservation.status !== 'ok') return rawReservation
        const page = this.overviewFusionDepth > 0 && after === undefined && rawLimit <= 4
          ? this.overviewMemoryHeadPage(projectKey, status, rawLimit)
          : this.run(store, rawCost, () => store.dashboardVisibilityMemoryPage(after, rawLimit, status))
        if (page.status !== 'ok') {
          this.releaseReservations([rawReservation.value])
          if (page.status === 'budget-exhausted' && this.memoProofStateLost) {
            this.finishOnFailure()
            return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
          }
          if (page.status === 'budget-exhausted' && page.reason !== 'persona-call-headroom') this.finishOnFailure()
          return page
        }
        continuation = { key, rows: page.value.rows.slice(0, limit),
          hasMore: page.value.rows.length > limit || page.value.hasMore, items: [], itemReservations: [],
          reservations: [rawReservation.value] }
        this.managedPageContinuations.set(key, continuation)
      }
      const deliveryLimit = Math.min(limit, continuation.rows.length)
      while (continuation.items.length < deliveryLimit) {
        const raw = continuation.rows[continuation.items.length]!
        if (raw.id === undefined || raw.idBytes < 1 || raw.idBytes > MAX_ID_BYTES ||
            Buffer.byteLength(raw.id, 'utf8') !== raw.idBytes || !safeInteger(raw.createdAt)) {
          this.finishOnFailure()
          return this.failure('unavailable-probe', 'managed-memory-key-invalid')
        }
        let pending = continuation.pendingItem
        const itemKey = JSON.stringify([this.binding, projectKey, status, raw.createdAt, raw.id, taskKey, contentLimit])
        if (pending === undefined) {
          const itemBytes = this.overviewFusionDepth > 0
            ? MANAGED_PROOF_CONTEXT_BYTES + Buffer.byteLength(itemKey, 'utf8') : this.managedPageItemCacheBytes(contentLimit)
          const itemReservation = this.reserveManagedPageCache(itemBytes)
          if (itemReservation.status !== 'ok') {
            if (itemReservation.status === 'budget-exhausted' && itemReservation.reason !== 'persona-call-headroom') {
              this.finishOnFailure()
            }
            return itemReservation
          }
          pending = { key: itemKey, itemReservation: itemReservation.value, bytes: 0, stageBytes: 0,
            ...(this.overviewFusionDepth > 0 ? { incrementalOutput: { baseBytes: itemBytes, reservedBytes: itemBytes } } : {}),
            steps: new Map(), resources: new Map(), stages: new Map() }
          continuation.pendingItem = pending
        } else if (pending.key !== itemKey) {
          this.finishOnFailure()
          return this.failure('stale', 'managed-page-item-scope-changed')
        }
        const outputReservations: string[] = []
        const previousProgress = this.activeManagedPageItem
        this.activeManagedPageItem = pending
        let resolved: DashboardReadOutcome<DashboardVisibilityItem>
        try {
          resolved = status === 'approved'
            ? contentLimit === null ? this.resolveApprovedSummary(projectKey, raw.id)
              : this.resolveItem(projectKey, raw.id, outputReservations, contentLimit)
            : this.resolveManagedPageItem(projectKey, status, raw.id, contentLimit)
        } finally { this.activeManagedPageItem = previousProgress }
        if (resolved.status !== 'ok') {
          this.releaseReservations(outputReservations)
          if (resolved.status === 'budget-exhausted' && this.memoProofStateLost) {
            this.finishOnFailure()
            return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
          }
          if (resolved.status !== 'budget-exhausted' || resolved.reason !== 'persona-call-headroom') {
            this.releaseManagedPageItemProgress(pending)
            continuation.pendingItem = undefined
          }
          if (resolved.status === 'budget-exhausted' && resolved.reason !== 'persona-call-headroom') {
            this.finishOnFailure()
          }
          return resolved
        }
        continuation.items.push(resolved.value)
        continuation.itemReservations.push(pending.itemReservation)
        this.releaseManagedPageItemSteps(pending)
        this.releaseManagedPageItemResources(pending)
        pending.approvedProof = undefined
        continuation.pendingItem = undefined
        this.releaseReservations(outputReservations)
      }
      const hasMore = continuation.hasMore || continuation.rows.length > deliveryLimit
      const deliveredLast = continuation.rows[deliveryLimit - 1]
      const nextCursor = hasMore && deliveredLast?.id !== undefined
        ? { createdAt: deliveredLast.createdAt, id: deliveredLast.id } : undefined
      if (deliveryLimit < continuation.rows.length) {
        const tailAfter = deliveredLast === undefined ? undefined : { createdAt: deliveredLast.createdAt, id: deliveredLast.id! }
        if (tailAfter === undefined) return this.failure('unavailable-probe', 'managed-page-tail-cursor-missing')
        const tailKey = this.managedPageContinuationKey(projectKey, status, tailAfter, contentLimit, taskKey)
        if (this.managedPageContinuations.has(tailKey)) {
          return this.failure('stale', 'managed-page-tail-already-pending')
        }
        const tail: ManagedPageContinuation = { key: tailKey,
          rows: continuation.rows.slice(deliveryLimit), hasMore: continuation.hasMore,
          items: continuation.items.slice(deliveryLimit), itemReservations: continuation.itemReservations.slice(deliveryLimit),
          reservations: continuation.reservations, ...(continuation.pendingItem === undefined ? {} : { pendingItem: continuation.pendingItem }) }
        continuation.rows = continuation.rows.slice(0, deliveryLimit)
        continuation.items = continuation.items.slice(0, deliveryLimit)
        continuation.itemReservations = continuation.itemReservations.slice(0, deliveryLimit)
        continuation.reservations = []
        continuation.pendingItem = undefined
        continuation.hasMore = true
        this.managedPageContinuations.set(tailKey, tail)
      }
      const boundary = this.validateSnapshotBoundary()
      if (boundary.status !== 'ok') return boundary
      const value = { items: continuation.items.slice(0, deliveryLimit), ...(nextCursor === undefined ? {} : { nextCursor }), hasMore }
      this.releaseManagedPageContinuation(key)
      return { status: 'ok', value }
    } finally { releaseHandoffReserve() }
  }

  /** Separate recent capability: updated_at/id keyset, exact index shape required. */
  readRecentManagedPage(projectKey: string, after: { updatedAt: number; id: string } | undefined,
    limit = 6, contentLimit = 16 * 1024): DashboardReadOutcome<{ items: DashboardVisibilityItem[];
      nextCursor?: { updatedAt: number; id: string }; hasMore: boolean }> {
    return this.readRecentManagedPageInternal(projectKey, after, limit, contentLimit)
  }

  private [aggregateRecentManagedPage](projectKey: string, after: { updatedAt: number; id: string } | undefined,
    limit = 6, contentLimit = 16 * 1024): DashboardReadOutcome<{ items: DashboardVisibilityItem[];
      nextCursor?: { updatedAt: number; id: string }; hasMore: boolean }> {
    this.aggregateIntermediateReadDepth += 1
    try { return this.readRecentManagedPageInternal(projectKey, after, limit, contentLimit) }
    finally { this.aggregateIntermediateReadDepth -= 1 }
  }

  private readRecentManagedPageInternal(projectKey: string, after: { updatedAt: number; id: string } | undefined,
    limit = 6, contentLimit = 16 * 1024): DashboardReadOutcome<{ items: DashboardVisibilityItem[];
      nextCursor?: { updatedAt: number; id: string }; hasMore: boolean }> {
    if (!this.isBoundProject(projectKey) || after !== undefined &&
        (!safeInteger(after.updatedAt) || !this.validId(after.id)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 15 ||
        !Number.isSafeInteger(contentLimit) || contentLimit < 0 || contentLimit > MAX_ROW_BYTES) {
      return this.failure('unavailable-probe', 'recent-page-scope-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const page = this.overviewFusionDepth > 0 && after === undefined && limit < 4
      ? this.overviewRecentHeadPage(projectKey, limit)
      : this.run(store, { sqlStatements: 2, rowsVisited: limit + 2,
      materializedBytes: (limit + 2) * PAGE_ROW_BYTES + 2048, keyBytes: this.keyBytes(projectKey, after?.id) },
    () => {
      if (!store.dashboardRecentIndexReady()) return { ready: false as const }
      return { ready: true as const, page: store.dashboardRecentApprovedPage(after, limit) }
    })
    if (page.status !== 'ok') return page
    if (!page.value.ready) return this.failure('unavailable-probe', 'recent-index-missing')
    const raw = page.value.page
    if (raw === undefined) return this.failure('unavailable-probe', 'recent-index-missing')
    const items: DashboardVisibilityItem[] = []
    let last: { updatedAt: number; id: string } | undefined
    for (const row of raw.rows) {
      if (row.id === undefined || row.idBytes < 1 || row.idBytes > MAX_ID_BYTES ||
          Buffer.byteLength(row.id, 'utf8') !== row.idBytes || !safeInteger(row.updatedAt)) {
        return this.failure('unavailable-probe', 'recent-page-key-invalid')
      }
      const resolved = this.resolveRoot(projectKey, row.id, contentLimit)
      if (resolved.status !== 'ok') return resolved
      items.push(resolved.value)
      last = { updatedAt: row.updatedAt, id: row.id }
    }
    const boundary = this.validateSnapshotBoundary()
    if (boundary.status !== 'ok') return boundary
    return { status: 'ok', value: { items, ...(raw.hasMore && last !== undefined ? { nextCursor: last } : {}),
      hasMore: raw.hasMore } }
  }

  resolveApprovedProof(projectKey: string, memoryId: string): DashboardReadOutcome<DashboardVisibilityItem> {
    if (!this.isBoundProject(projectKey) || !this.validId(memoryId)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('approved-proof', projectKey, memoryId),
        () => this.resolveApprovedProof(projectKey, memoryId))
    }
    const reservations: string[] = []
    try {
      const proof = this.proveRoot(projectKey, memoryId, reservations)
      if (proof.status !== 'ok') return proof
      if (proof.value.state !== 'visible') return { status: 'ok', value: { state: proof.value.state, id: memoryId,
        ...(proof.value.reason === undefined ? {} : { reason: proof.value.reason }) } }
      const boundary = this.validateSnapshotBoundary()
      return boundary.status === 'ok' ? { status: 'ok', value: { state: 'visible', id: memoryId } } : boundary
    } finally { this.releaseReservations(reservations) }
  }

  /** Bounded scene metadata rows. Names over 512 bytes remain visible internally for keyset progress. */
  readManagedSceneMetaPage(projectKey: string, after: { memoryCount: number; name: string } | undefined,
    limit = 6): DashboardReadOutcome<{ rows: DashboardSceneMetaRow[]; hasMore: boolean }> {
    if (!this.isBoundProject(projectKey) || after !== undefined &&
        (!Number.isSafeInteger(after.memoryCount) || after.memoryCount < 0 || typeof after.name !== 'string' ||
          after.name.length === 0 || Buffer.byteLength(after.name, 'utf8') > 4096)) {
      return this.failure('unavailable-probe', 'scene-meta-scope-invalid')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6) return this.failure('unavailable-probe', 'scene-meta-limit-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const bounded = limit
    const page = this.run(store, { sqlStatements: 1, rowsVisited: bounded + 1,
      materializedBytes: (bounded + 1) * 4096, keyBytes: this.keyBytes(projectKey, after?.name) },
    () => store.dashboardSceneMetaPage(after, bounded),
    JSON.stringify(['scene-meta-page', projectKey, after?.memoryCount ?? null, after?.name ?? null, bounded]))
    if (page.status !== 'ok') return page
    const rows: DashboardSceneMetaRow[] = []
    for (const row of page.value.rows) {
      if (!Number.isSafeInteger(row.nameBytes) || row.nameBytes < 0 ||
          row.name !== undefined && (Buffer.byteLength(row.name, 'utf8') !== row.nameBytes || row.nameBytes > 4096) ||
          row.name === undefined && row.nameBytes <= 4096 ||
          !Number.isSafeInteger(row.memoryCount) || row.memoryCount < 0 ||
          !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 ||
          !Number.isSafeInteger(row.summaryBytes) || row.summaryBytes < 0 ||
          !Number.isSafeInteger(row.sourceIdsBytes) || row.sourceIdsBytes < 0 ||
          !Number.isSafeInteger(row.sourceRevisionsBytes) || row.sourceRevisionsBytes < 0) {
        this.finishOnFailure()
        return this.failure('unavailable-probe', 'scene-meta-row-invalid')
      }
      rows.push({ ...(row.name === undefined ? {} : { name: row.name }), nameBytes: row.nameBytes,
        memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryBytes: row.summaryBytes,
        summaryComplete: row.summaryComplete, sourceIdsBytes: row.sourceIdsBytes,
        sourceRevisionsBytes: row.sourceRevisionsBytes, dirty: row.dirty, frontierReady: row.frontierReady })
    }
    return { status: 'ok', value: { rows, hasMore: page.value.hasMore } }
  }

  /** Bounded exact summary point read; callers must finish member proofs first. */
  readManagedSceneSummary(projectKey: string, name: string, maxBytes = 65_536): DashboardReadOutcome<{ bytes: number; summary?: string }> {
    if (!this.isBoundProject(projectKey) || typeof name !== 'string' || name.length === 0 ||
        Buffer.byteLength(name, 'utf8') > 512 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 65_536) {
      return this.failure('unavailable-probe', 'scene-summary-scope-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    return this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: maxBytes + 64,
      keyBytes: this.keyBytes(projectKey, name) }, () => store.dashboardSceneSummary(name, maxBytes),
    JSON.stringify(['scene-summary', projectKey, name, maxBytes]))
  }

  /** Normalized member authority page; negative ordinals remain valid identities. */
  readManagedSceneMembers(projectKey: string, name: string, afterOrdinal: number | undefined,
    limit = 15): DashboardReadOutcome<{ rows: DashboardSceneMemberRow[]; hasMore: boolean }> {
    if (!this.isBoundProject(projectKey) || typeof name !== 'string' || name.length === 0 ||
        Buffer.byteLength(name, 'utf8') > 512 ||
        afterOrdinal !== undefined && !Number.isSafeInteger(afterOrdinal) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 15) {
      return this.failure('unavailable-probe', 'scene-member-page-scope-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const page = this.run(store, { sqlStatements: 1, rowsVisited: limit + 1,
      materializedBytes: (limit + 1) * 512, keyBytes: this.keyBytes(projectKey, name, afterOrdinal === undefined ? undefined : String(afterOrdinal)) },
    () => store.dashboardSceneMemberPage(name, afterOrdinal, limit),
    JSON.stringify(['scene-member-page', projectKey, name, afterOrdinal ?? null, limit]))
    if (page.status !== 'ok') return page
    const rows: DashboardSceneMemberRow[] = []
    for (const row of page.value.rows) {
      rows.push({ ...(row.memoryId === undefined ? {} : { memoryId: row.memoryId }), memoryIdBytes: row.memoryIdBytes,
        revision: row.revision, ordinal: row.ordinal })
    }
    return { status: 'ok', value: { rows, hasMore: page.value.hasMore } }
  }

  /** Full root proof for one normalized scene member at the recorded revision. */
  beginManagedDerivedProof(projectKey: string, layer: 'L2' | 'L3', identity: string): DashboardReadOutcome<string> {
    if (this.binding.viewKey !== 'memory.global.v7' || !this.isBoundProject(projectKey) || this.derivedProof !== undefined) {
      return this.failure('stale', 'derived-proof-scope-invalid')
    }
    this.derivedProof = { token: randomUUID(), projectKey, layer, identity, count: 0, digest: createHash('sha256') }
    return { status: 'ok', value: this.derivedProof.token }
  }

  /** Compact a completed root/dependency proof under the still-live native version fence. */
  commitManagedDerivedMember(token: string, member: DashboardSceneMemberRow): DashboardReadOutcome<void> {
    const progress = this.derivedProof
    if (this.ended || this.paused || progress?.token !== token || !isValidDashboardSceneMember(member) ||
        progress.ordinal !== undefined && member.ordinal <= progress.ordinal) return this.failure('stale', 'derived-member-order-invalid')
    const proof = this.memo.get(this.memoKey(progress.projectKey, member.memoryId))
    const now = this.readWallNow()
    if (now === undefined || this.memoHasExpired(now) || proof?.state !== 'visible' || proof.revision !== member.revision) {
      return this.failure('stale', 'derived-member-not-proven')
    }
    this.provenExpiryAt = this.earliestVisibleExpiry()
    progress.digest.update(`${member.memoryId}\0${member.revision}\0${member.ordinal}\n`, 'utf8')
    progress.count += 1; progress.ordinal = member.ordinal
    this.discardMemo()
    return { status: 'ok', value: undefined }
  }

  managedDerivedDigest(token: string): DashboardReadOutcome<{ count: number; digest: string }> {
    const progress = this.derivedProof
    return progress?.token === token ? { status: 'ok', value: { count: progress.count, digest: progress.digest.copy().digest('hex') } } :
      this.failure('stale', 'derived-proof-missing')
  }

  finishManagedDerivedProof(token: string): void {
    if (this.derivedProof?.token === token) this.derivedProof = undefined
  }

  proveManagedSceneMember(projectKey: string, id: string, revision: number): DashboardReadOutcome<'visible' | 'hidden' | 'unresolved'> {
    if (!this.isBoundProject(projectKey) || !this.validId(id) || !Number.isSafeInteger(revision) || revision < 1) {
      return this.failure('unavailable-probe', 'scene-member-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('scene-member', projectKey, id, revision),
        () => this.proveManagedSceneMember(projectKey, id, revision))
    }
    const reservations: string[] = []
    try {
      const proof = this.proveRoot(projectKey, id, reservations)
      if (proof.status !== 'ok') return proof
      if (proof.value.state !== 'visible' || proof.value.node === undefined) {
        return { status: 'ok', value: proof.value.state === 'hidden' ? 'hidden' : 'unresolved' }
      }
      return { status: 'ok', value: proof.value.node.revision.revision === revision ? 'visible' : 'unresolved' }
    } finally { this.releaseReservations(reservations) }
  }

  /** Re-read the whole scene identity/digest/summary; only then may a summary leave the reader. */
  readManagedSceneFinal(projectKey: string, expected: { name: string; memoryCount: number; updatedAt: number;
    summaryBytes: number; summaryComplete: boolean; memberCount: number; memberDigest: string; proofToken?: string }):
    DashboardReadOutcome<{ state: 'visible' | 'hidden' | 'unresolved'; reason?: string; summary?: string; summaryComplete?: boolean }> {
    if (!this.isBoundProject(projectKey) || typeof expected.name !== 'string' || expected.name.length === 0 ||
        Buffer.byteLength(expected.name, 'utf8') > 512 || !Number.isSafeInteger(expected.memoryCount) || expected.memoryCount < 0 ||
        !Number.isSafeInteger(expected.updatedAt) || expected.updatedAt < 0 ||
        !Number.isSafeInteger(expected.summaryBytes) || expected.summaryBytes < 0 || expected.summaryBytes > 65_536 ||
        typeof expected.summaryComplete !== 'boolean' || !Number.isSafeInteger(expected.memberCount) || expected.memberCount < 0 ||
        !/^[a-f0-9]{64}$/u.test(expected.memberDigest)) {
      return this.failure('unavailable-probe', 'scene-final-scope-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('scene-final', projectKey, expected),
        () => this.readManagedSceneFinal(projectKey, expected))
    }
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const meta = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: 4096,
      keyBytes: this.keyBytes(projectKey, expected.name) }, () => store.dashboardSceneMeta(expected.name),
    JSON.stringify(['scene-final-meta', projectKey, expected.name, expected.memoryCount, expected.updatedAt,
      expected.summaryBytes, expected.summaryComplete]))
    if (meta.status !== 'ok') return meta
    const row = meta.value
    if (row === undefined) return { status: 'ok', value: { state: 'hidden', reason: 'scene-not-found' } }
    if (row.name === undefined || row.nameBytes !== Buffer.byteLength(expected.name, 'utf8') || row.name !== expected.name ||
        row.memoryCount !== expected.memoryCount || row.updatedAt !== expected.updatedAt ||
        row.summaryBytes !== expected.summaryBytes || row.summaryComplete !== expected.summaryComplete) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'scene-identity-changed' } }
    }
    if (!row.frontierReady) return { status: 'ok', value: { state: 'unresolved', reason: 'scene-frontier-not-ready' } }
    const stream = this.derivedProof
    if (expected.proofToken !== undefined && (stream?.token !== expected.proofToken || stream.layer !== 'L2' ||
        stream.projectKey !== projectKey || stream.identity !== JSON.stringify([expected.name, expected.memoryCount, expected.updatedAt,
          expected.summaryBytes, expected.summaryComplete]) || stream.count !== expected.memberCount || stream.count !== expected.memoryCount ||
        stream.digest.copy().digest('hex') !== expected.memberDigest)) return this.failure('stale', 'scene-stream-proof-invalid')
    if (expected.proofToken === undefined) {
    const members: DashboardSceneMemberRow[] = []
    let afterOrdinal: number | undefined
    let hasMore = true
    let memberPages = 0
    const memberPageLimit = Math.max(1, Math.ceil(expected.memberCount / 15) + 2)
    while (hasMore) {
      if (memberPages >= memberPageLimit) return { status: 'ok', value: { state: 'unresolved', reason: 'scene-member-pagination-limit' } }
      memberPages += 1
      const page = this.readManagedSceneMembers(projectKey, expected.name, afterOrdinal, 15)
      if (page.status !== 'ok') return page
      members.push(...page.value.rows)
      hasMore = page.value.hasMore
      if (page.value.rows.length === 0) break
      afterOrdinal = page.value.rows.at(-1)!.ordinal
      if (members.length > expected.memberCount) break
    }
    if (members.some((member) => !isValidDashboardSceneMember(member))) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'scene-member-identity-invalid' } }
    }
    if (members.length !== expected.memberCount || dashboardSceneMemberDigest(members) !== expected.memberDigest) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'scene-members-changed' } }
    }
    for (let offset = 0; offset < members.length; offset += 15) {
      const batch = members.slice(offset, offset + 15).map((member) => member.memoryId as string)
      const finalFences = this.readFences({ projectKey, memoryIds: batch })
      if (finalFences.status !== 'ok') return finalFences
      if (finalFences.value.state !== 'visible') return { status: 'ok', value: {
        state: finalFences.value.state, reason: finalFences.value.reason ?? 'scene-member-control-fence',
      } }
      if (finalFences.value.fences!.forgottenMemoryIds.length > 0 || finalFences.value.fences!.deletedMemoryIds.length > 0) {
        return { status: 'ok', value: { state: 'hidden', reason: 'scene-member-control-fence' } }
      }
    }
    const now = this.readWallNow()
    if (now === undefined) { this.finishOnFailure(); return this.failure('unavailable-probe', 'visibility-wall-clock-invalid') }
    if (this.memoProofStateLost) return { status: 'ok', value: { state: 'unresolved', reason: 'scene-proof-cache-lost' } }
    for (const member of members) {
      const proof = this.memo.get(this.memoKey(projectKey, member.memoryId!))
      if (proof?.state !== 'visible' || proof.revision !== member.revision ||
          proof.expiryAt !== undefined && proof.expiryAt !== null && proof.expiryAt <= now) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'scene-members-not-proven' } }
      }
    }
    }
    // Materialize the exact summary bytes; only project/name are lookup keys.
    const summary = this.readManagedSceneSummary(projectKey, expected.name, expected.summaryBytes)
    if (summary.status !== 'ok') return summary
    const summaryText = summary.value.summary
    if (summary.value.bytes !== expected.summaryBytes || summaryText === undefined ||
        Buffer.byteLength(summaryText, 'utf8') !== expected.summaryBytes) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'scene-summary-incomplete' } }
    }
    const boundary = this.validateSnapshotBoundary()
    if (boundary.status !== 'ok') return boundary
    return { status: 'ok', value: { state: 'visible', summary: summaryText,
      summaryComplete: expected.summaryComplete } }
  }

  /** Bind a bounded persona plan; the caller stores only this identity and source list. */
  readManagedPersonaPlan(projectKey: string, streaming = false): DashboardReadOutcome<{
    state: 'visible' | 'unresolved' | 'hidden'; reason?: string; sourceIds?: string[]; sourceRevisions?: Record<string, number>;
    contentBytes?: number; sourceCount?: number; updatedAt?: number; stale?: boolean
  }> {
    if (!this.isBoundProject(projectKey)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const meta = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: 512,
      keyBytes: this.keyBytes(projectKey) }, () => store.dashboardPersonaMeta(),
    JSON.stringify(['persona-meta', projectKey]))
    if (meta.status !== 'ok') return meta
    if (meta.value === undefined) return { status: 'ok', value: { state: 'hidden', reason: 'persona-not-found' } }
    const m = meta.value
    if (!safeInteger(m.sourceCount) || m.sourceCount !== m.sourceArrayCount || !safeInteger(m.updatedAt) ||
        !safeInteger(m.contentBytes) || m.contentBytes > 65_536) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
    }
    if (streaming) return { status: 'ok', value: { state: 'visible', sourceIds: [], sourceRevisions: {},
      contentBytes: m.contentBytes, sourceCount: m.sourceCount, updatedAt: m.updatedAt, stale: m.sourceCount === 0 } }
    if (m.contentBytes > 65_536 || m.sourceIdsBytes > 16_384 || m.sourceRevisionsBytes > 16_384 || m.sourceCount > 100) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-proof-over-budget' } }
    }
    const sources = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: m.sourceIdsBytes + m.sourceRevisionsBytes + 64,
      keyBytes: this.keyBytes(projectKey) + m.sourceIdsBytes + m.sourceRevisionsBytes }, () => store.dashboardPersonaSources(16_384),
    JSON.stringify(['persona-sources', projectKey, m.sourceIdsBytes, m.sourceRevisionsBytes]))
    if (sources.status !== 'ok') return sources
    if (sources.value.sourceIds === undefined || sources.value.sourceRevisions === undefined) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
    }
    let ids: unknown; let revisions: unknown
    try { ids = JSON.parse(sources.value.sourceIds); revisions = JSON.parse(sources.value.sourceRevisions) } catch {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-invalid' } }
    }
    if (!Array.isArray(ids) || ids.length !== m.sourceCount || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !this.validId(id)) ||
        revisions === null || typeof revisions !== 'object' || Array.isArray(revisions)) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
    }
    const revisionMap = revisions as Record<string, unknown>
    const sourceIds = [...new Set(ids as string[])]
    const sourceRevisions: Record<string, number> = {}
    for (const id of sourceIds) {
      const revision = revisionMap[id]
      if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
      }
      sourceRevisions[id] = Number(revision)
    }
    return { status: 'ok', value: { state: 'visible', sourceIds, sourceRevisions,
      contentBytes: m.contentBytes, sourceCount: m.sourceCount, updatedAt: m.updatedAt, stale: m.sourceCount === 0 } }
  }

  /** Full root proof for one persisted persona source; the aggregate owns the next index. */
  readManagedPersonaSourcePage(projectKey: string, afterOrdinal?: number): DashboardReadOutcome<{
    rows: DashboardSceneMemberRow[]; hasMore: boolean }> {
    if (!this.isBoundProject(projectKey)) return this.failure('stale', 'persona-source-scope-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    return this.run(this.stores.get(projectKey)!, { sqlStatements: 1, rowsVisited: 16,
      materializedBytes: 16 * 512, keyBytes: this.keyBytes(projectKey) },
    () => this.stores.get(projectKey)!.dashboardPersonaSourcePage(afterOrdinal, 15),
    JSON.stringify(['persona-source-page', projectKey, afterOrdinal ?? null]))
  }

  proveManagedPersonaSource(projectKey: string, id: string, revision: number): DashboardReadOutcome<'visible' | 'hidden' | 'unresolved'> {
    if (!this.isBoundProject(projectKey) || !this.validId(id) || !Number.isSafeInteger(revision) || revision < 1) {
      return this.failure('unavailable-probe', 'persona-source-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('persona-source', projectKey, id, revision),
        () => this.proveManagedPersonaSource(projectKey, id, revision))
    }
    const reservations: string[] = []
    try {
      const proof = this.proveRoot(projectKey, id, reservations)
      if (proof.status !== 'ok') return proof
      if (proof.value.state !== 'visible' || proof.value.node === undefined) {
        return { status: 'ok', value: proof.value.state === 'hidden' ? 'hidden' : 'unresolved' }
      }
      return { status: 'ok', value: proof.value.node.meta.currentRevision === revision &&
        proof.value.node.revision.revision === revision ? 'visible' : 'unresolved' }
    } finally { this.releaseReservations(reservations) }
  }

  /** Revalidate the persona identity and release the body only after all sources were proven. */
  readManagedPersonaBody(projectKey: string, expected: { sourceCount: number; updatedAt: number; contentBytes: number; sourceIds: string[]; sourceRevisions: Record<string, number>; proofToken?: string }):
    DashboardReadOutcome<{ state: 'visible' | 'unresolved' | 'hidden'; reason?: string; content?: string; stale?: boolean }> {
    if (!this.isBoundProject(projectKey)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('persona-body', projectKey, expected),
        () => this.readManagedPersonaBody(projectKey, expected))
    }
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const stream = this.derivedProof
    if (expected.proofToken !== undefined && (stream?.token !== expected.proofToken || stream.layer !== 'L3' ||
        stream.projectKey !== projectKey || stream.count !== expected.sourceCount ||
        stream.identity !== JSON.stringify([expected.sourceCount, expected.updatedAt, expected.contentBytes]))) {
      return this.failure('stale', 'persona-stream-proof-invalid')
    }
    const plan = this.readManagedPersonaPlan(projectKey, expected.proofToken !== undefined)
    if (plan.status !== 'ok') return plan
    if (plan.value.state !== 'visible' || plan.value.sourceIds === undefined || plan.value.sourceRevisions === undefined ||
        plan.value.sourceCount !== expected.sourceCount || plan.value.updatedAt !== expected.updatedAt ||
        plan.value.contentBytes !== expected.contentBytes || plan.value.sourceIds.length !== expected.sourceIds.length ||
        plan.value.sourceIds.some((id, index) => id !== expected.sourceIds[index]) ||
        plan.value.sourceIds.some((id) => plan.value.sourceRevisions![id] !== expected.sourceRevisions[id])) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-changed' } }
    }
    if (this.memoProofStateLost) return { status: 'ok', value: { state: 'unresolved', reason: 'persona-proof-cache-lost' } }
    const now = this.readWallNow()
    if (now === undefined) { this.finishOnFailure(); return this.failure('unavailable-probe', 'visibility-wall-clock-invalid') }
    for (const id of expected.proofToken === undefined ? expected.sourceIds : []) {
      const proof = this.memo.get(this.memoKey(projectKey, id))
      if (proof?.state !== 'visible' || proof.revision !== expected.sourceRevisions[id] ||
          proof.expiryAt !== undefined && proof.expiryAt !== null && proof.expiryAt <= now) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'persona-sources-not-proven' } }
      }
    }
    const body = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: expected.contentBytes + 64,
      keyBytes: this.keyBytes(projectKey) }, () => store.dashboardPersonaBody(65_536),
    JSON.stringify(['persona-body', projectKey, expected.contentBytes, expected.sourceCount, expected.updatedAt]))
    if (body.status !== 'ok') return body
    if (body.value.bytes !== expected.contentBytes || body.value.content === undefined ||
        Buffer.byteLength(body.value.content, 'utf8') !== expected.contentBytes) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-body-incomplete' } }
    }
    const boundary = this.validateSnapshotBoundary()
    return boundary.status !== 'ok' ? boundary : { status: 'ok', value: { state: 'visible', content: body.value.content,
      stale: expected.sourceCount === 0 } }
  }

  /** Bounded managed project persona proof; sources are paged within the same reader. */
  readManagedPersona(projectKey: string, options: { sourceAfterIndex?: number; sourceLimit?: number } = {}): DashboardReadOutcome<{
    state: 'visible' | 'unresolved' | 'hidden'; reason?: string; content?: string; sourceCount?: number; updatedAt?: number;
    stale?: boolean; nextSourceIndex?: number
  }> {
    if (!this.isBoundProject(projectKey)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    if (options.sourceAfterIndex !== undefined && options.sourceAfterIndex !== 0) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-offset-not-allowed' } }
    }
    const start = 0
    const limit = Number.isSafeInteger(options.sourceLimit) ? Math.max(1, Math.min(15, options.sourceLimit!)) : 15
    const meta = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: 512,
      keyBytes: this.keyBytes(projectKey) }, () => store.dashboardPersonaMeta())
    if (meta.status !== 'ok') return meta
    if (meta.value === undefined) return { status: 'ok', value: { state: 'hidden', reason: 'persona-not-found' } }
    const m = meta.value
    if (m.contentBytes > 65_536 || m.sourceIdsBytes > 16_384 || m.sourceRevisionsBytes > 16_384 || m.sourceCount > 100) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-proof-over-budget' } }
    }
    const sources = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: m.sourceIdsBytes + m.sourceRevisionsBytes + 64,
      keyBytes: this.keyBytes(projectKey) + m.sourceIdsBytes + m.sourceRevisionsBytes }, () => store.dashboardPersonaSources(16_384))
    if (sources.status !== 'ok') return sources
    if (sources.value.sourceIds === undefined || sources.value.sourceRevisions === undefined) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
    }
    let ids: unknown; let revisions: unknown
    try { ids = JSON.parse(sources.value.sourceIds); revisions = JSON.parse(sources.value.sourceRevisions) } catch {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-invalid' } }
    }
    if (!Array.isArray(ids) || ids.length !== m.sourceCount || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !this.validId(id)) ||
        revisions === null || typeof revisions !== 'object' || Array.isArray(revisions)) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
    }
    const revisionMap = revisions as Record<string, unknown>
    const memoryIds = [...new Set(ids as string[])]
    const reservations: string[] = []
    try {
      const now = this.readWallNow()
      if (now === undefined) { this.finishOnFailure(); return this.failure('unavailable-probe', 'visibility-wall-clock-invalid') }
      const window = memoryIds.slice(start, start + limit)
      for (let offset = 0; offset < window.length; offset += 15) {
        const batch = window.slice(offset, offset + 15)
        const fences = this.readFences({ projectKey, memoryIds: batch })
        if (fences.status !== 'ok') return fences
        if (fences.value.state !== 'visible') return { status: 'ok', value: { state: 'hidden', reason: fences.value.reason } }
        if (fences.value.fences!.forgottenMemoryIds.length > 0 || fences.value.fences!.deletedMemoryIds.length > 0) {
          return { status: 'ok', value: { state: 'hidden', reason: 'persona-control-fence' } }
        }
        for (const id of batch) {
          const expected = revisionMap[id]
          if (!Number.isSafeInteger(expected) || Number(expected) < 1) {
            return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-incomplete' } }
          }
          const proof = this.proveRoot(projectKey, id, reservations)
          if (proof.status !== 'ok') return proof
          if (proof.value.state !== 'visible' || proof.value.node === undefined ||
              proof.value.node.meta.currentRevision !== Number(expected) ||
              proof.value.node.revision.revision !== Number(expected)) {
            return { status: 'ok', value: { state: 'unresolved', reason: 'persona-source-not-current' } }
          }
        }
      }
      const nextSourceIndex = start + window.length
      if (nextSourceIndex < memoryIds.length) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'persona-proof-incomplete',
          sourceCount: m.sourceCount, updatedAt: m.updatedAt, nextSourceIndex } }
      }
      const body = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: m.contentBytes + 64,
        keyBytes: this.keyBytes(projectKey) }, () => store.dashboardPersonaBody(65_536))
      if (body.status !== 'ok') return body
      if (body.value.bytes !== m.contentBytes || body.value.content === undefined ||
          Buffer.byteLength(body.value.content, 'utf8') !== m.contentBytes) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'persona-body-incomplete' } }
      }
      const boundary = this.validateSnapshotBoundary()
      if (boundary.status !== 'ok') return boundary
      return { status: 'ok', value: { state: 'visible', content: body.value.content, sourceCount: m.sourceCount,
        updatedAt: m.updatedAt, stale: m.sourceCount === 0 } }
    } finally {
      this.releaseReservations(reservations)
    }
  }

  /** Bounded, read-only scenes page. Dirty normalized members remain authoritative. */
  readManagedScenePage(projectKey: string, after?: { memoryCount: number; name: string }, limit = 6): DashboardReadOutcome<{
    items: Array<{ name?: string; summary?: string; memoryCount: number; updatedAt: number; summaryComplete: boolean;
      state: 'visible' | 'unresolved' | 'hidden'; reason?: string }>
    next?: { memoryCount: number; name: string }
    hasMore: boolean
  }> {
    if (!this.isBoundProject(projectKey)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    if (!Number.isSafeInteger(limit) || limit < 1) return this.failure('unavailable-probe', 'scene-page-limit-invalid')
    const bounded = Math.min(6, limit)
    const page = this.readManagedSceneMetaPage(projectKey, after, bounded)
    if (page.status !== 'ok') return page
    const items: Array<{ name?: string; summary?: string; memoryCount: number; updatedAt: number; summaryComplete: boolean;
      state: 'visible' | 'unresolved' | 'hidden'; reason?: string }> = []
    let lastProcessed: DashboardSceneMetaRow | undefined
    for (const row of page.value.rows) {
      lastProcessed = row
      if (row.name === undefined) {
        items.push({ memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryComplete: false,
          state: 'unresolved', reason: 'scene-name-materialization-limit' })
        continue
      }
      const name = row.name
      if (row.nameBytes > 512) {
        items.push({ name, memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryComplete: false,
          state: 'unresolved', reason: 'scene-name-over-budget' })
        continue
      }
      if (!row.frontierReady) {
        items.push({ name, memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryComplete: false,
          state: 'unresolved', reason: 'scene-frontier-not-ready' })
        continue
      }
      if (row.summaryBytes > 65_536) {
        items.push({ name, memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryComplete: false,
          state: 'unresolved', reason: 'scene-summary-over-budget' })
        continue
      }
      const summary = this.readManagedSceneSummary(projectKey, name, row.summaryBytes)
      if (summary.status !== 'ok') return summary
      const summaryText = summary.value.summary
      if (summary.value.bytes !== row.summaryBytes || summaryText === undefined ||
          Buffer.byteLength(summaryText, 'utf8') !== row.summaryBytes) {
        items.push({ name, memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryComplete: false,
          state: 'unresolved', reason: 'scene-summary-incomplete' })
        continue
      }
      const members: DashboardSceneMemberRow[] = []
      let afterOrdinal: number | undefined
      let memberHasMore = true
      let memberFailure: { state: 'hidden' | 'unresolved'; reason: string } | undefined
      while (memberHasMore && members.length <= 100) {
        const memberPage = this.readManagedSceneMembers(projectKey, name, afterOrdinal, 15)
        if (memberPage.status !== 'ok') return memberPage
        if (memberPage.value.rows.some((member) => !isValidDashboardSceneMember(member))) {
          memberFailure = { state: 'unresolved', reason: 'scene-member-identity-invalid' }
          break
        }
        members.push(...memberPage.value.rows)
        memberHasMore = memberPage.value.hasMore
        afterOrdinal = memberPage.value.rows.at(-1)?.ordinal
        if (memberPage.value.rows.length === 0) break
        if (members.length > 100) { memberFailure = { state: 'unresolved', reason: 'scene-members-over-budget' }; break }
      }
      if (memberFailure === undefined && (memberHasMore || members.length !== row.memoryCount)) {
        memberFailure = { state: 'unresolved', reason: 'scene-members-incomplete' }
      }
      if (memberFailure === undefined) {
        for (const member of members) {
          const proof = this.proveManagedSceneMember(projectKey, member.memoryId!, member.revision)
          if (proof.status !== 'ok') {
            if (proof.status === 'budget-exhausted' && this.memoProofStateLost) {
              this.finishOnFailure()
              return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
            }
            if (proof.status === 'budget-exhausted' && proof.reason !== 'persona-call-headroom') this.finishOnFailure()
            return proof
          }
          if (proof.value !== 'visible') {
            memberFailure = { state: proof.value === 'hidden' ? 'hidden' : 'unresolved', reason: 'scene-members-not-current' }
            break
          }
        }
      }
      if (memberFailure !== undefined) {
        items.push({ name, memoryCount: row.memoryCount, updatedAt: row.updatedAt, summaryComplete: false,
          state: memberFailure.state, reason: memberFailure.reason })
        continue
      }
      items.push({ name, summary: summaryText, memoryCount: row.memoryCount,
        updatedAt: row.updatedAt, summaryComplete: row.summaryComplete, state: 'visible' })
    }
    const boundary = this.validateSnapshotBoundary()
    if (boundary.status !== 'ok') return boundary
    const next = lastProcessed === undefined || lastProcessed.name === undefined
      ? undefined : { memoryCount: lastProcessed.memoryCount, name: lastProcessed.name }
    return { status: 'ok', value: { items, hasMore: page.value.hasMore,
      ...(next === undefined ? {} : { next }) } }
  }

  private resolveApprovedSummary(projectKey: string, memoryId: string): DashboardReadOutcome<DashboardVisibilityItem> {
    if (!this.isBoundProject(projectKey) || !this.validId(memoryId)) return this.failure('unavailable-probe', 'visibility-key-invalid')
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const reservations: string[] = []
    try {
      const proof = this.proveRoot(projectKey, memoryId, reservations)
      if (proof.status !== 'ok') return proof
      if (proof.value.state !== 'visible' || proof.value.node === undefined) return {
        status: 'ok', value: { state: proof.value.state, id: memoryId,
          ...(proof.value.reason === undefined ? {} : { reason: proof.value.reason }) },
      }
      const store = this.stores.get(projectKey)!
      const node = proof.value.node
      let meta: DashboardVisibilityMemoryMeta | DashboardManagedMemoryView = node.meta
      if (this.aggregateIntermediateReadDepth === 0) {
        const projected = this.run(store, { sqlStatements: 1, rowsVisited: 1, materializedBytes: MAX_ROW_BYTES + PAGE_ROW_BYTES,
          keyBytes: this.keyBytes(projectKey, memoryId) }, () => store.dashboardManagedMemory(memoryId, 0),
        JSON.stringify(['managed-memory-summary', projectKey, memoryId]))
        if (projected.status !== 'ok') return projected
        if (projected.value === undefined || !this.validManagedMemoryProjection(memoryId, projected.value, 'approved')) {
          return { status: 'ok', value: { state: 'unresolved', id: memoryId, reason: 'approved-summary-invalid' } }
        }
        meta = projected.value
      }
      // Aggregate counts already hold these validated metadata fields from
      // proveRoot. Reuse them instead of reading the current body/source JSON
      // projection again; the same reader still proves origin and publication.
      // Current l1_memories is updated immediately when a revision is approved.
      // The proof above may intentionally select an earlier revision at this
      // reader's asOf point, so revision-scoped fields must come from that
      // already-proven revision rather than the mutable current row.
      const revision = node.revision
      const output = this.reserveManagedItemOutput(revision.sourceIdsBytes, 0)
      if (output.status !== 'ok') return output
      const summary: DashboardVisibleMemorySummary = {
        id: memoryId, kind: revision.kind!, ...(revision.scene == null ? {} : { scene: revision.scene }),
        confidence: meta.confidence!, status: 'approved', source: meta.source!, sourceMessageIds: [...node.sourceIds],
        contentBytes: revision.contentBytes, createdAt: meta.createdAt!, updatedAt: meta.updatedAt!,
        ...(meta.approvedAt == null ? {} : { approvedAt: meta.approvedAt }),
        revision: revision.revision, ...(revision.validFrom == null ? {} : { validFrom: revision.validFrom }),
        validFromState: revision.validFromState,
        validFromPrecision: revision.validFromPrecision, validFromBasis: revision.validFromBasis,
        ...(revision.validFromUpper == null ? {} : { validFromUpper: revision.validFromUpper }),
        ...(revision.validFromLabel == null ? {} : { validFromLabel: revision.validFromLabel }),
        ...(revision.validTo == null ? {} : { validTo: revision.validTo }), recordedAt: revision.recordedAt,
        ...(revision.supersededAt == null ? {} : { supersededAt: revision.supersededAt }),
        sourceVerified: revision.sourceVerified === 1,
        ...(typeof meta.expiryAt === 'number' ? { expiryAt: meta.expiryAt } : {}),
      }
      // Provenance affects aggregate membership only; ordinary library summaries stay unchanged.
      if (node.sourceIds.length === 0 && this.aggregateIntermediateReadDepth > 0) {
        const origin = this.readAggregateDirectOrigin(store, projectKey, memoryId)
        if (origin.status !== 'ok') return origin
        Object.defineProperty(summary, dashboardAggregateDirectOriginProof, {
          value: origin.value, enumerable: false, configurable: false, writable: false,
        })
      }
      const boundary = this.validateSnapshotBoundary()
      if (boundary.status !== 'ok') return boundary
      return { status: 'ok', value: { state: 'visible', id: memoryId,
        summary } }
    } finally { this.releaseReservations(reservations) }
  }

  private discardDirectOriginSchemaScope(scope: DirectOriginSchemaScope): void {
    if (this.directOriginSchemaScopes?.get(scope.projectKey) !== scope) return
    this.directOriginSchemaScopes.delete(scope.projectKey)
    if (this.directOriginSchemaScopes.size === 0) this.directOriginSchemaScopes = undefined
    if (this.ended || this.paused) return
    try { this.manager.releaseResident(this.callToken, scope.cacheReservation) } catch { /* cleanup remains manager-owned */ }
    try { this.manager.releaseResident(this.callToken, scope.keyReservation) } catch { /* cleanup remains manager-owned */ }
  }

  private directOriginOperationKey(projectKey: string, memoryId: string, schemaVersion: number): string {
    return JSON.stringify(['managed-direct-origin', projectKey, memoryId,
      `initial-approval:${memoryId}`, schemaVersion])
  }

  private directOriginStepCost(projectKey: string, memoryId: string, schemaVersion: number): DashboardReadCost {
    const eventId = `initial-approval:${memoryId}`
    const operationKey = this.directOriginOperationKey(projectKey, memoryId, schemaVersion)
    return {
      sqlStatements: DIRECT_ORIGIN_LOOKUP_COST.sqlStatements,
      rowsVisited: DIRECT_ORIGIN_LOOKUP_COST.rowsVisited,
      materializedBytes: DIRECT_ORIGIN_LOOKUP_COST.materializedBytes,
      keyBytes: this.keyBytes(projectKey, memoryId, memoryId, eventId) +
        Buffer.byteLength(operationKey, 'utf8') + DIRECT_ORIGIN_KEY_OVERHEAD_BYTES,
    }
  }

  private readAggregateDirectOrigin(store: MemoryStore, projectKey: string, memoryId: string): DashboardReadOutcome<boolean> {
    const progress = this.activeManagedPageItem
    let scope = this.directOriginSchemaScopes?.get(projectKey)
    if (scope !== undefined && (scope.store !== store || scope.binding !== this.binding || scope.projectKey !== projectKey ||
        scope.projectKeyBytes !== Buffer.byteLength(projectKey, 'utf8'))) {
      this.finishOnFailure()
      return this.failure('stale', 'direct-origin-schema-scope-changed')
    }
    const scopeIsNew = scope === undefined
    const projectKeyBytes = Buffer.byteLength(projectKey, 'utf8')
    const scopeCacheBytes = DIRECT_ORIGIN_SCOPE_CACHE_BASE_BYTES + 2 * projectKeyBytes
    const scopeCountAfterAdmission = (this.directOriginSchemaScopes?.size ?? 0) + (scopeIsNew ? 1 : 0)
    const maximumStepCost = this.directOriginStepCost(projectKey, memoryId, MAX_SQLITE_SCHEMA_VERSION_KEY)

    if (!scopeIsNew && scope?.schemaVersion !== undefined && progress !== undefined) {
      const operationKey = this.directOriginOperationKey(projectKey, memoryId, scope.schemaVersion)
      const cached = progress.steps.get(operationKey)
      if (cached !== undefined) {
        const expectedCost = this.directOriginStepCost(projectKey, memoryId, scope.schemaVersion)
        const expectedSignature = JSON.stringify(['project', operationKey, expectedCost])
        const cachedValue = cached.value as Partial<DirectOriginProofCacheValue> | undefined
        if (cached.signature !== expectedSignature || cached.bytes !== DIRECT_ORIGIN_LOOKUP_COST.materializedBytes ||
            typeof cachedValue?.trusted !== 'boolean' || cachedValue.schemaVersion !== scope.schemaVersion ||
            cached.reservation === '' || !this.managedPageLeaseTokens.has(cached.reservation)) {
          this.finishOnFailure()
          return this.failure('stale', 'direct-origin-cache-shape-changed')
        }
        // The paid lookup stays cached. Reserve its fresh fence plus the
        // required tail once, retaining any stronger enclosing guard.
        const admission = this.personaReserveStatus(DIRECT_ORIGIN_SCHEMA_FENCE_COST, scopeCountAfterAdmission, 1)
        if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
        const fence = this.runUncached(store, DIRECT_ORIGIN_SCHEMA_FENCE_COST,
          () => store.dashboardVisibilitySchemaVersion())
        if (fence.status !== 'ok') return fence
        if (fence.value !== scope.schemaVersion || this.stores.get(projectKey) !== scope.store ||
            scope.binding !== this.binding) {
          this.finishOnFailure()
          return this.failure('stale', 'direct-origin-schema-changed')
        }
        return { status: 'ok', value: cachedValue.trusted }
      }
    }

    const scopeLeaseCost = scopeIsNew ? {
      materializedBytes: scopeCacheBytes,
      keyBytes: projectKeyBytes,
    } : { materializedBytes: 0, keyBytes: 0 }
    const fullAdmissionCost: DashboardReadCost = {
      // Actual work only: personaReserveStatus owns the future boundary,
      // including the prospective N+1 scope before any SQL or lease.
      sqlStatements: DIRECT_ORIGIN_SCHEMA_FENCE_COST.sqlStatements +
        DIRECT_ORIGIN_LOOKUP_COST.sqlStatements,
      rowsVisited: DIRECT_ORIGIN_SCHEMA_FENCE_COST.rowsVisited +
        DIRECT_ORIGIN_LOOKUP_COST.rowsVisited,
      materializedBytes: DIRECT_ORIGIN_SCHEMA_FENCE_COST.materializedBytes +
        DIRECT_ORIGIN_LOOKUP_COST.materializedBytes + scopeLeaseCost.materializedBytes,
      keyBytes: maximumStepCost.keyBytes + scopeLeaseCost.keyBytes,
    }
    const admission = this.personaReserveStatus(fullAdmissionCost, scopeCountAfterAdmission, 1)
    if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
    if (scopeIsNew && scopeCountAfterAdmission > this.projectKeys.length) {
      return this.failure('stale', 'direct-origin-schema-scope-capacity')
    }
    if (progress !== undefined && progress.bytes + DIRECT_ORIGIN_LOOKUP_COST.materializedBytes >
        MAX_MANAGED_ITEM_STEP_CACHE_BYTES) {
      return this.failure('budget-exhausted', 'managed-page-progress-capacity')
    }

    let provisionalScope = false
    if (scopeIsNew) {
      const cacheLease = this.reserveReadState(scopeCacheBytes)
      if (cacheLease.status !== 'ok') return cacheLease
      const keyLease = this.reserveReadKeys(projectKeyBytes)
      if (keyLease.status !== 'ok') {
        this.releaseReadState(cacheLease.value.reservationToken)
        return keyLease
      }
      scope = {
        projectKey, store, binding: this.binding, cacheReservation: cacheLease.value.reservationToken,
        keyReservation: keyLease.value.reservationToken, projectKeyBytes,
      }
      try { (this.directOriginSchemaScopes ??= new Map()).set(projectKey, scope) }
      catch {
        this.releaseReadState(scope.cacheReservation)
        this.releaseReadState(scope.keyReservation)
        this.finishOnFailure()
        return this.failure('unavailable-probe', 'direct-origin-schema-registration-failed')
      }
      provisionalScope = true
    }

    let stepReservation: string | undefined
    if (progress !== undefined) {
      const reserved = this.reserveManagedPageCache(DIRECT_ORIGIN_LOOKUP_COST.materializedBytes)
      if (reserved.status !== 'ok') {
        if (provisionalScope && scope !== undefined) this.discardDirectOriginSchemaScope(scope)
        return reserved
      }
      stepReservation = reserved.value
    }
    const releaseStepReservation = (): void => {
      if (stepReservation === undefined) return
      this.releaseReservations([stepReservation])
      stepReservation = undefined
    }

    const fence = this.runUncached(store, DIRECT_ORIGIN_SCHEMA_FENCE_COST,
      () => store.dashboardVisibilitySchemaVersion())
    if (fence.status !== 'ok') {
      releaseStepReservation()
      if (provisionalScope && scope !== undefined) this.discardDirectOriginSchemaScope(scope)
      return fence
    }
    if (fence.value > MAX_SQLITE_SCHEMA_VERSION_KEY || this.stores.get(projectKey) !== store ||
        scope === undefined || scope.store !== store || scope.binding !== this.binding ||
        scope.schemaVersion !== undefined && scope.schemaVersion !== fence.value) {
      releaseStepReservation()
      this.finishOnFailure()
      return this.failure('stale', 'direct-origin-schema-changed')
    }
    if (scope.schemaVersion === undefined) scope.schemaVersion = fence.value
    const operationKey = this.directOriginOperationKey(projectKey, memoryId, fence.value)
    const stepCost = this.directOriginStepCost(projectKey, memoryId, fence.value)
    const signature = JSON.stringify(['project', operationKey, stepCost])
    if (progress !== undefined && progress.steps.has(operationKey)) {
      releaseStepReservation()
      this.finishOnFailure()
      return this.failure('stale', 'direct-origin-cache-appeared-during-read')
    }
    const originCost: DashboardReadCost = {
      ...stepCost,
      materializedBytes: progress === undefined ? DIRECT_ORIGIN_LOOKUP_COST.materializedBytes : 0,
    }
    const origin = this.runUncached(store, originCost,
      () => store.dashboardVisibilityDirectCreationOrigin(memoryId))
    if (origin.status !== 'ok') {
      releaseStepReservation()
      return origin
    }
    if (origin.value === undefined || origin.value.schemaVersion !== fence.value) {
      releaseStepReservation()
      this.finishOnFailure()
      return this.failure('stale', 'direct-origin-snapshot-stamp-changed')
    }
    const cachedValue: DirectOriginProofCacheValue = {
      trusted: trustedDirectCreationOrigin(origin.value), schemaVersion: origin.value.schemaVersion,
    }
    if (progress !== undefined) {
      if (this.activeManagedPageItem !== progress || stepReservation === undefined) {
        releaseStepReservation()
        this.finishOnFailure()
        return this.failure('stale', 'managed-page-origin-step-lost')
      }
      try {
        progress.steps.set(operationKey, {
          signature, value: cachedValue, reservation: stepReservation,
          bytes: DIRECT_ORIGIN_LOOKUP_COST.materializedBytes,
        })
        progress.bytes += DIRECT_ORIGIN_LOOKUP_COST.materializedBytes
        this.managedPageLeaseTokens.add(stepReservation)
        stepReservation = undefined
      } catch {
        releaseStepReservation()
        this.finishOnFailure()
        return this.failure('unavailable-probe', 'managed-page-origin-step-retain-failed')
      }
    }
    return { status: 'ok', value: cachedValue.trusted }
  }

  /** Read one raw candidate keyset page; hidden-only pages may still carry a cursor. */
  readPage(projectKey: string, after?: DashboardVisibilityMemoryCursor, limit = PAGE_ITEMS,
    maxBodyBytes = MAX_ROW_BYTES): DashboardReadOutcome<DashboardVisibilityPage> {
    if (!this.isBoundProject(projectKey) || after !== undefined &&
        (!safeInteger(after.createdAt) || !this.validId(after.id)) || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_ITEMS ||
        !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0 || maxBodyBytes > MAX_ROW_BYTES) {
      return this.failure('unavailable-probe', 'visibility-cursor-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    const store = this.stores.get(projectKey)!
    const page = this.run(store, {
      sqlStatements: 1, rowsVisited: limit + 1, materializedBytes: (limit + 1) * PAGE_ROW_BYTES,
      keyBytes: this.keyBytes(projectKey, after && after.id),
    }, () => store.dashboardVisibilityMemoryPage(after, limit + 1))
    if (page.status !== 'ok') {
      if (page.status === 'budget-exhausted' && this.memoProofStateLost) {
        this.finishOnFailure()
        return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
      }
      if (page.status === 'budget-exhausted' && page.reason !== 'persona-call-headroom') {
        this.finishOnFailure()
      }
      return page
    }
    const examined = page.value.rows.slice(0, limit)
    const items: DashboardVisibilityItem[] = []
    const outputReservations: string[] = []
    let lastExamined: DashboardVisibilityMemoryPageRow | undefined
    try {
      for (const row of examined) {
        lastExamined = row
        if (row.id === undefined || !safeInteger(row.idBytes) || row.idBytes < 1 || row.idBytes > MAX_ID_BYTES ||
            Buffer.byteLength(row.id, 'utf8') !== row.idBytes || !safeInteger(row.createdAt)) {
          this.finishOnFailure()
          return this.failure('unavailable-probe', 'candidate-key-overlong-range-incomplete')
        }
        const resolved = this.resolveItem(projectKey, row.id, outputReservations, maxBodyBytes)
        if (resolved.status !== 'ok') {
          if (resolved.status === 'budget-exhausted' && this.memoProofStateLost) {
            this.finishOnFailure()
            return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
          }
          if (resolved.status === 'budget-exhausted' && resolved.reason !== 'persona-call-headroom') {
            this.finishOnFailure()
          }
          return resolved
        }
        items.push(resolved.value)
      }
      const hasMore = page.value.rows.length > limit || page.value.hasMore
      const nextCursor = hasMore && lastExamined?.id !== undefined
        ? { createdAt: lastExamined.createdAt, id: lastExamined.id } : undefined
      const validated = this.validateBeforeRelease(items)
      if (validated.status !== 'ok') return validated
      return { status: 'ok', value: {
        items: validated.value, ...(nextCursor === undefined ? {} : { nextCursor }), hasMore,
      } }
    } finally {
      this.releaseReservations(outputReservations)
    }
  }

  /** Finish or continue the same S1 session without resetting work and visibility memo. */
  advance(hasMore: boolean): DashboardReadOutcome<void> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-ended')
    if (!hasMore) {
      if ((this.directOriginSchemaScopes?.size ?? 0) > 0) {
        const finalBoundary = this.validateSnapshotBoundary(true)
        if (finalBoundary.status !== 'ok') {
          this.finishOnFailure()
          return finalBoundary
        }
      }
      this.releaseManagedPageContinuation()
      this.releaseManagedProofContinuations()
      this.releaseMemoReservations()
      const result = this.manager.finish(this.callToken, false)
      this.end()
      return result.status === 'ok' ? { status: 'ok', value: undefined } : result
    }
    const finished = this.manager.finish(this.callToken, true)
    if (finished.status !== 'ok' || finished.value.continuationToken === undefined) {
      if (finished.status !== 'ok') this.finishOnFailure()
      return finished.status === 'ok' ? this.failure('stale', 'continuation-token-missing') : finished
    }
    const continued = this.manager.continue(finished.value.continuationToken, this.binding)
    if (continued.status !== 'ok') {
      if (continued.reason === 'session-call-active') {
        this.continuationToken = finished.value.continuationToken
        this.paused = true
        return continued
      }
      const cancelled = this.manager.cancelContinuation(finished.value.continuationToken)
      if (cancelled.status === 'ok') this.managerEnded()
      else if (!this.ended) {
        this.continuationToken = finished.value.continuationToken
        this.paused = true
      }
      return continued
    }
    this.callToken = continued.value.callToken
    this.callGeneration += 1
    const probes = this.probeAllScopes()
    if (probes.status !== 'ok') {
      this.finishOnFailure()
      return probes
    }
    return { status: 'ok', value: undefined }
  }

  /** Finish this RPC and suspend the same S1 session until a later RPC resumes it. */
  suspendForRpc(beforeHandoff?: () => DashboardReadOutcome<void>, nextGlobalWindow = false): DashboardSuspendOutcome {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    const finalCheck = this.validateSnapshotBoundary(true)
    if (finalCheck.status !== 'ok') {
      // A handoff cannot be exposed without its final scope proof. If even
      // that proof has no per-call headroom, retire the active lease while
      // returning the original typed cause to the caller.
      this.finishOnFailure()
      return finalCheck
    }
    if (beforeHandoff !== undefined) {
      let released: DashboardReadOutcome<void>
      try { released = beforeHandoff() } catch {
        this.finishOnFailure()
        return this.failure('unavailable-probe', 'suspend-release-failed')
      }
      if (released.status !== 'ok') {
        this.finishOnFailure()
        return released
      }
    }
    const finished = nextGlobalWindow ? this.manager.finishGlobalWindow(this.callToken) : this.manager.finish(this.callToken, true)
    if (finished.status !== 'ok' || finished.value.continuationToken === undefined) {
      // finish(true) can reject the seventeenth continuation without ending the
      // active call; always retire it on this failure path.
      this.manager.cancel(this.callToken)
      this.end()
      if (finished.status === 'budget-exhausted') {
        return { status: 'handoff-exhausted', proofComplete: true, reason: finished.reason }
      }
      return finished.status === 'ok' ? this.failure('stale', 'continuation-token-missing') : finished
    }
    this.continuationToken = finished.value.continuationToken
    this.paused = true
    return { status: 'ok', value: { continuationToken: this.continuationToken } }
  }

  /** Resume only when the next RPC actually arrives; replay cannot cancel a live call. */
  resumeForRpc(): DashboardReadOutcome<void> {
    if (this.ended) return this.failure('stale', 'visibility-session-ended')
    if (!this.paused || this.continuationToken === undefined) return this.failure('stale', 'visibility-session-call-active')
    const now = this.readWallNow()
    if (now === undefined || this.memoHasExpired(now)) {
      this.manager.cancelContinuation(this.continuationToken)
      this.managerEnded()
      return this.failure('stale', now === undefined ? 'visibility-wall-clock-invalid' : 'visibility-proof-expired-between-rpcs')
    }
    const continued = this.manager.continue(this.continuationToken, this.binding)
    if (continued.status !== 'ok') {
      // A duplicate/replayed token must not disturb a call already acquired by
      // another request. The manager rejects that case as session-call-active.
      if (continued.reason !== 'session-call-active') {
        this.manager.cancelContinuation(this.continuationToken)
        this.managerEnded()
      }
      return continued
    }
    this.callToken = continued.value.callToken
    this.callGeneration += 1
    this.continuationToken = undefined
    this.paused = false
    const probes = this.probeAllScopes()
    if (probes.status !== 'ok') {
      this.finishOnFailure()
      return probes
    }
    const afterProbe = this.readWallNow()
    if (afterProbe === undefined || this.memoHasExpired(afterProbe)) {
      this.finishOnFailure()
      return this.failure('stale', afterProbe === undefined ? 'visibility-wall-clock-invalid' : 'visibility-proof-expired-on-resume')
    }
    return { status: 'ok', value: undefined }
  }

  cancel(): DashboardReadOutcome<void> {
    if (this.ended) return this.failure('stale', 'visibility-session-ended')
    if (this.paused && this.continuationToken !== undefined) {
      const result = this.manager.cancelContinuation(this.continuationToken)
      this.managerEnded()
      return result
    }
    this.releaseManagedPageContinuation()
    this.releaseManagedProofContinuations()
    this.releaseMemoReservations()
    const result = this.manager.cancel(this.callToken)
    this.end()
    return result
  }

  /** Called before the shared S1 manager is invalidated by runtime state changes. */
  invalidate(): void {
    this.finishOnFailure()
  }

  /** Release this wrapper when the shared S1 manager has expired or evicted its call. */
  reapIfStale(): boolean {
    if (this.ended) return true
    if (this.paused && this.continuationToken !== undefined) {
      const result = this.manager.inspectContinuation(this.continuationToken)
      if (result.status === 'ok') return false
      this.managerEnded()
      return true
    }
    if (this.manager.counters(this.callToken).status === 'ok') return false
    this.finishOnFailure()
    return true
  }

  /** Trusted in-process adapter for bounded aggregators; never exposed through RPC. */
  readProject<T>(projectKey: string, cost: DashboardReadCost, operation: (store: MemoryStore) => T): DashboardReadOutcome<T> {
    if (!this.isBoundProject(projectKey)) return this.failure('unavailable-probe', 'visibility-project-not-bound')
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    return this.run(store, cost, () => operation(store))
  }

  /** Trusted in-process adapter for bounded control-ledger reads; never exposed through RPC. */
  readControl<T>(cost: DashboardReadCost, operation: (control: ControlLedger) => T): DashboardReadOutcome<T> {
    return this.run(this.control, cost, () => operation(this.control))
  }

  /**
   * Remaining S1 work for the active call and its session. Aggregators use it
   * to stop before the final version probes and output reservation would be
   * unaffordable, keeping the same readId resumable instead of dropping it.
   */
  remainingWork(): {
    readonly call: Readonly<DashboardReadWorkLimit>
    readonly session: Readonly<DashboardReadWorkLimit>
  } | undefined {
    if (this.ended || this.paused) return undefined
    const remaining = this.manager.remaining(this.callToken)
    return remaining.status === 'ok' ? remaining.value : undefined
  }

  /** Prove a capture event remains visible through its L0 source and direct Host-event fences. */
  verifyCaptureEvent(projectKey: string, sourceId?: string, sourceEventId?: string): DashboardReadOutcome<{
    state: DashboardVisibilityState; reason?: string
  }> {
    if (!this.isBoundProject(projectKey) || sourceId !== undefined && !this.validId(sourceId) ||
        sourceEventId !== undefined && !this.validSourceEventId(sourceEventId)) {
      return this.failure('unavailable-probe', 'capture-event-identity-invalid')
    }
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('capture-event', projectKey, sourceId ?? null,
        sourceEventId ?? null), () => this.verifyCaptureEvent(projectKey, sourceId, sourceEventId))
    }
    if (sourceId !== undefined) {
      const source = this.verifySources(projectKey, [sourceId], [])
      if (source.status !== 'ok') return source
      if (source.value.state !== 'visible') return { status: 'ok', value: source.value }
    }
    if (sourceEventId !== undefined) {
      const fences = this.readFences({ projectKey, sourceEventIds: [sourceEventId] })
      if (fences.status !== 'ok') return fences
      if (fences.value.state !== 'visible') return { status: 'ok', value: fences.value }
      if (fences.value.fences!.revokedSourceEventIds.includes(sourceEventId) ||
          fences.value.fences!.deletedSourceEventIds.includes(sourceEventId)) {
        return { status: 'ok', value: { state: 'hidden', reason: 'source-event-control-fence' } }
      }
    }
    return { status: 'ok', value: { state: 'visible' } }
  }

  /** Relation evidence must still be a present L0 identity; a legacy missing-source fallback is insufficient. */
  verifyGlobalRelationEvidence(projectKey: string, sourceId: string): DashboardReadOutcome<{ state: DashboardVisibilityState; reason?: string }> {
    if (!this.isBoundProject(projectKey) || !this.validId(sourceId)) return this.failure('unavailable-probe', 'relation-evidence-key-invalid')
    return this.withManagedProofContext(this.managedProofContextKey('global-relation-evidence', projectKey, sourceId),
      () => this.verifySources(projectKey, [], [sourceId]))
  }

  /**
   * Prove one repeated-capture event through its L0 source and any independent
   * Host event identities. The source fence and L0 identity are always checked;
   * when external event IDs are available, their fence is checked in the same
   * bounded batch. This route enumerated a real L0 member, so a missing event
   * identity does not trigger the unbounded legacy event-table scan used by
   * the general capture path. All query cost and identity residency are
   * admitted together before the first fence or identity query runs.
   */
  verifyRepeatedCaptureEvent(projectKey: string, sourceId: string,
    sourceEventIds: readonly string[]): DashboardReadOutcome<{ state: DashboardVisibilityState; reason?: string }> {
    if (!this.isBoundProject(projectKey) || !this.validId(sourceId) || !Array.isArray(sourceEventIds) ||
        sourceEventIds.length > 15 || sourceEventIds.some((id) => !this.validSourceEventId(id))) {
      return this.failure('unavailable-probe', 'repeat-capture-event-identity-invalid')
    }
    const ids = [...new Set(sourceEventIds)]
    const temporaryBytes = ids.reduce((sum, id) => sum + Math.max(256, Buffer.byteLength(id, 'utf8') * 2 + 128), 0)
    const projectAndSourceKeyBytes = this.keyBytes(projectKey, sourceId)
    const sourceEventKeyBytes = ids.length === 0 ? 0 : this.keyBytes(projectKey, ...ids)
    const fullCost: DashboardReadCost = {
      sqlStatements: 2 + (ids.length > 0 ? 1 : 0), rowsVisited: 2 + ids.length,
      materializedBytes: Math.max(256, 96) + Math.max(256, SOURCE_IDENTITY_ROW_BYTES) +
        (ids.length > 0 ? Math.max(256, ids.length * 96) : 0) + temporaryBytes,
      keyBytes: projectAndSourceKeyBytes * 2 + sourceEventKeyBytes,
    }
    const execute = (): DashboardReadOutcome<{ state: DashboardVisibilityState; reason?: string }> =>
      this.verifyRepeatedCaptureEventInContext(projectKey, sourceId, ids, temporaryBytes, fullCost)
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('repeat-capture-event', projectKey, sourceId, ids),
        execute, fullCost)
    }
    return execute()
  }

  private verifyRepeatedCaptureEventInContext(projectKey: string, sourceId: string, ids: readonly string[],
    temporaryBytes: number, fullCost: DashboardReadCost):
    DashboardReadOutcome<{ state: DashboardVisibilityState; reason?: string }> {
    const reserveStatus = this.personaReserveStatus(fullCost)
    if (!reserveStatus.ok) return this.failure('budget-exhausted', reserveStatus.reason)
    const reservations: string[] = []
    try {
      if (temporaryBytes > 0) {
        const reserved = this.reserveTemporary(temporaryBytes,
          JSON.stringify(['repeat-capture-event', projectKey, sourceId, ids]))
        if (reserved.status !== 'ok') return reserved
        this.trackTemporaryReservation(reserved.value, reservations)
      }
      const sourceFence = this.readFences({ projectKey, sourceIds: [sourceId] })
      if (sourceFence.status !== 'ok') return sourceFence
      if (sourceFence.value.state !== 'visible') return { status: 'ok', value: sourceFence.value }
      const sourceRows = sourceFence.value.fences!
      if (sourceRows.deletedSourceIds.length > 0 || sourceRows.revokedSourceIds.length > 0) {
        return { status: 'ok', value: { state: 'hidden', reason: 'source-control-fence' } }
      }
      const store = this.stores.get(projectKey)
      if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
      const batchIdentity = this.overviewFusionDepth > 0 ? this.readOverviewSourceBatch(projectKey, [sourceId]) : undefined
      if (batchIdentity !== undefined && batchIdentity.status !== 'ok') return batchIdentity
      const identity = batchIdentity?.status === 'ok'
        ? { status: 'ok' as const, value: batchIdentity.value[0]!.identity }
        : this.run(store, {
        sqlStatements: 1, rowsVisited: 1, materializedBytes: SOURCE_IDENTITY_ROW_BYTES,
        keyBytes: this.keyBytes(projectKey, sourceId),
      }, () => store.dashboardVisibilitySourceIdentity(sourceId),
      JSON.stringify(['repeat-source-identity', projectKey, sourceId]))
      if (identity.status !== 'ok') return identity
      if (typeof identity.value.found !== 'boolean') {
        return { status: 'ok', value: { state: 'unresolved', reason: 'source-identity-invalid' } }
      }
      if (!identity.value.found) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'source-identity-missing' } }
      }
      const checked = this.validateIdentity(identity.value)
      if (checked.state !== 'visible') return { status: 'ok', value: checked }
      if (identity.value.sourceEventId != null && !ids.includes(identity.value.sourceEventId)) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'capture-l0-event-identity-missing' } }
      }
      if (identity.value.agentPreset !== undefined && identity.value.agentPreset !== null &&
          this.excludedAgentPatterns.some((pattern) => matchesAgentGlob(identity.value.agentPreset!, pattern))) {
        return { status: 'ok', value: { state: 'hidden', reason: 'excluded-source-agent' } }
      }
      if (ids.length > 0) {
        const eventFence = this.readFences({ projectKey, sourceEventIds: ids })
        if (eventFence.status !== 'ok') return eventFence
        if (eventFence.value.state !== 'visible') return { status: 'ok', value: eventFence.value }
        const eventRows = eventFence.value.fences!
        if (eventRows.revokedSourceEventIds.length > 0 || eventRows.deletedSourceEventIds.length > 0) {
          return { status: 'ok', value: { state: 'hidden', reason: 'source-event-control-fence' } }
        }
      }
      return { status: 'ok', value: { state: 'visible' } }
    } finally { this.releaseReservations(reservations) }
  }

  /** Verify a memory linked from an approval, revision, recall, or injection event.
   *  Batch callers that will perform the final S1 boundary before publishing may
   *  defer this per-item probe to that final proof (`validateBoundary=false`). */
  verifyEventMemory(projectKey: string, memoryId: string, validateBoundary = true): DashboardReadOutcome<{
    state: DashboardVisibilityState; reason?: string
  }> {
    if (!this.isBoundProject(projectKey) || !this.validId(memoryId)) {
      return this.failure('unavailable-probe', 'linked-memory-identity-invalid')
    }
    const live = this.ensureLive()
    if (live.status !== 'ok') return live
    if (this.activeManagedPageItem === undefined) {
      return this.withManagedProofContext(this.managedProofContextKey('event-memory', projectKey, memoryId, validateBoundary),
        () => this.verifyEventMemory(projectKey, memoryId, validateBoundary))
    }
    const reservations: string[] = []
    try {
      const proof = this.proveRoot(projectKey, memoryId, reservations)
      if (proof.status !== 'ok') return proof
      if (proof.value.state !== 'visible') return { status: 'ok', value: {
        state: proof.value.state, ...(proof.value.reason === undefined ? {} : { reason: proof.value.reason }),
      } }
      if (!validateBoundary) return { status: 'ok', value: { state: 'visible' } }
      const boundary = this.validateSnapshotBoundary()
      return boundary.status === 'ok' ? { status: 'ok', value: { state: 'visible' } } : boundary
    } finally { this.releaseReservations(reservations) }
  }

  /** Public prepublication scope/version/TTL proof for aggregate-owned DTOs. */
  publishProof(): DashboardReadOutcome<void> { return this.validateSnapshotBoundary(true) }

  /** Carry only the earliest already-proven TTL across aggregate work windows. */
  earliestVisibleExpiry(): number | undefined {
    let earliest = this.provenExpiryAt
    for (const proof of this.memo.values()) if (proof.state === 'visible' && typeof proof.expiryAt === 'number') {
      earliest = earliest === undefined ? proof.expiryAt : Math.min(earliest, proof.expiryAt)
    }
    return earliest
  }

  reserveReadState(bytes: number): DashboardReadOutcome<{ reservationToken: string }> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    return this.classifyResidentFailure('cache', bytes, this.manager.reserveResident(this.callToken, 'cache', bytes))
  }

  releaseReadState(token: string): DashboardReadOutcome<void> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    return this.manager.releaseResident(this.callToken, token)
  }

  reserveReadKeys(bytes: number): DashboardReadOutcome<{ reservationToken: string }> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    return this.classifyResidentFailure('key', bytes, this.manager.reserveResident(this.callToken, 'key', bytes))
  }

  chargeRead<T>(cost: DashboardReadCost, operation: () => T): DashboardReadOutcome<T> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    const reserveStatus = this.personaReserveStatus(cost)
    if (!reserveStatus.ok) return this.failure('budget-exhausted', reserveStatus.reason)
    let result: DashboardReadOutcome<T>
    try { result = this.manager.run(this.callToken, cost, operation) }
    catch {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'dashboard-read-operation-failed')
    }
    if (result.status === 'ok' && this.readWallNow() === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    if (result.status !== 'ok' && result.status !== 'budget-exhausted') this.finishOnFailure()
    return result
  }

  /**
   * Create the internal fixed key/name capability for one aggregate-owned
   * directory read. Only a session whose immutable body binding is empty can
   * hold it; the capability never mutates that binding and exposes no body,
   * root, event, or source-read method. Label reads are metered under the
   * existing per-call/per-session project budget through
   * {@link DashboardReadSessionManager.runMember}.
   */
  createDirectoryLabelReader(input: DashboardDirectoryLabelScope): DashboardReadOutcome<DashboardDirectoryLabelReader> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    if (this.projectKeys.length !== 0) return this.failure('unavailable-probe', 'directory-label-scope-invalid')
    const opener = this.openDirectoryMember
    if (opener === undefined) return this.failure('unavailable-probe', 'directory-member-opener-missing')
    if (this.directoryLabelRegistry !== undefined) return this.failure('unavailable-probe', 'directory-label-reader-exists')
    if (input === null || typeof input !== 'object') return this.failure('unavailable-probe', 'directory-label-scope-invalid')
    const scope = input as Partial<Record<keyof DashboardDirectoryLabelScope, unknown>>
    const readId = scope.readId
    const directoryInput = scope.directory
    const marker = scope.marker
    if (typeof readId !== 'string' || readId.length === 0 || Buffer.byteLength(readId, 'utf8') > 128 ||
        typeof directoryInput !== 'string' || directoryInput.length === 0 || directoryInput.includes('\0') ||
        Buffer.byteLength(directoryInput, 'utf8') > 4096 || !path.isAbsolute(directoryInput) ||
        typeof marker !== 'string' || marker.length === 0 || Buffer.byteLength(marker, 'utf8') > 256) {
      return this.failure('unavailable-probe', 'directory-label-scope-invalid')
    }
    const directory = path.resolve(directoryInput)
    const session = this
    const enumerated = new Set<string>()
    const members = new Map<string, DirectoryLabelMemberRecord>()
    let disposed = false
    let registry: { dispose(): void } | undefined

    const live = (): DashboardReadOutcome<void> => {
      if (disposed) return { status: 'stale', reason: 'directory-label-reader-released' }
      if (session.ended) return { status: 'stale', reason: 'visibility-session-ended' }
      if (session.paused) return { status: 'stale', reason: 'visibility-session-suspended' }
      return { status: 'ok', value: undefined }
    }

    const dispose = (): void => {
      if (disposed) return
      disposed = true
      for (const member of members.values()) {
        if (member.lease !== undefined) session.releaseDirectoryMemberLease(member.lease)
        if (member.handle !== undefined) {
          try { member.handle.release() } catch { /* best-effort release of the owned connection */ }
        }
      }
      members.clear()
      enumerated.clear()
      if (registry !== undefined && session.directoryLabelRegistry === registry) session.directoryLabelRegistry = undefined
    }

    const reader: DashboardDirectoryLabelReader = {
      readId,
      directory,
      marker,
      enumerate(value: readonly string[]): DashboardReadOutcome<void> {
        const state = live()
        if (state.status !== 'ok') return state
        const keys = copyDirectoryMemberKeys(value, DIRECTORY_LABEL_MAX_ENUMERATED)
        if (keys === undefined) return { status: 'unavailable-probe', reason: 'directory-label-keys-invalid' }
        for (const key of keys) {
          if (enumerated.has(key)) continue
          if (enumerated.size >= DIRECTORY_LABEL_MAX_ENUMERATED) {
            return { status: 'budget-exhausted', reason: 'directory-label-key-limit' }
          }
          enumerated.add(key)
        }
        return { status: 'ok', value: undefined }
      },
      remainingMemberCapacity(): DashboardDirectoryMemberCapacity | undefined {
        if (disposed || session.ended || session.paused) return undefined
        const counters = session.manager.counters(session.callToken)
        if (counters.status !== 'ok') return undefined
        const limits = session.manager.limits
        const call = Math.max(0, limits.perCall.projects - counters.value.call.projects)
        const sessionRemaining = Math.max(0, limits.perSession.projects - counters.value.session.projects)
        return { call, session: sessionRemaining, combined: Math.min(call, sessionRemaining) }
      },
      readLabels(value: readonly string[]): DashboardReadOutcome<DashboardDirectoryMemberLabel[]> {
        const state = live()
        if (state.status !== 'ok') return state
        const keys = copyDirectoryMemberKeys(value, DIRECTORY_LABEL_MAX_KEYS)
        if (keys === undefined || new Set(keys).size !== keys.length) {
          return { status: 'unavailable-probe', reason: 'directory-label-keys-invalid' }
        }
        for (const key of keys) {
          if (!enumerated.has(key)) return { status: 'unavailable-probe', reason: 'directory-label-key-unenumerated' }
        }
        const labels: DashboardDirectoryMemberLabel[] = []
        for (const key of keys) {
          const existing = members.get(key)
          if (existing !== undefined) { labels.push(existing.label); continue }
          const lease = session.reserveDirectoryMemberLease()
          if (lease.status !== 'ok') return lease
          const leaseToken = lease.value
          // Ownership of a newly opened connection is held here until the
          // member registry takes it. Every exit before that transfer releases
          // the connection and the lease exactly once, including a post-callback
          // TTL expiry or an invalid wall clock after the opener succeeded.
          let pendingHandle: DashboardDirectoryMemberHandle | undefined
          let leaseTransferred = false
          try {
            const keyBytes = Buffer.byteLength(key, 'utf8')
            const cost: DashboardReadCost = {
              sqlStatements: DIRECTORY_LABEL_SQL,
              rowsVisited: DIRECTORY_LABEL_ROWS,
              materializedBytes: DIRECTORY_LABEL_MATERIALIZED_BYTES,
              keyBytes: DIRECTORY_LABEL_OPEN_KEY_BYTES + keyBytes,
            }
            const opened = session.runDirectoryMemberRecord(key, cost, () => {
              let handle: DashboardDirectoryMemberHandle
              try {
                const result = opener(key)
                if (result.status !== 'ok') return { opened: false as const }
                handle = result.value
              } catch { return { opened: false as const } }
              try {
                if (path.resolve(handle.store.file) !== path.join(directory, key, 'memory.db')) {
                  try { handle.release() } catch { /* the reported mismatch is authoritative */ }
                  return { opened: false as const, mismatch: true }
                }
                // Reused writer/read-only connections may be older than the
                // current directory entry. The path observation saved at its
                // open must match the current lstat() before the name is
                // proven; this is observation agreement, not proof of the
                // SQLite handle's underlying inode (external B→A(open)→B is
                // not excluded).
                if (!connectionMatchesMemberFile(handle.store, directory, key)) {
                  try { handle.release() } catch { /* a mismatched connection is never proven */ }
                  return { opened: false as const, identityMismatch: true }
                }
                const meta = handle.store.dashboardProjectMeta(DIRECTORY_LABEL_NAME_BYTES)
                const stamp = handle.store.dashboardReadVersion()
                if (!validDirectoryMemberProjection(meta, stamp)) {
                  try { handle.release() } catch { /* an invalid projection never becomes resident */ }
                  return { opened: false as const }
                }
                pendingHandle = handle
                return { opened: true as const, meta, stamp }
              } catch {
                try { handle.release() } catch { /* a failed probe releases its connection */ }
                return { opened: false as const }
              }
            })
            if (opened.status !== 'ok') return opened
            if (!opened.value.opened) {
              if ('identityMismatch' in opened.value) {
                return { status: 'unavailable-probe', reason: 'directory-member-identity-mismatch' }
              }
              if ('mismatch' in opened.value) return { status: 'unavailable-probe', reason: 'directory-member-store-mismatch' }
              const label: DashboardDirectoryMemberLabel = { key, name: key, nameBytes: 0, proven: false }
              members.set(key, { label, rawNameBytes: 0 })
              labels.push(label)
              continue
            }
            const meta = opened.value.meta
            const rawName = meta?.name
            const rawNameBytes = meta === undefined ? 0 : meta.nameBytes
            const friendlyName = rawName !== undefined && rawName.length > 0 &&
              rawNameBytes === Buffer.byteLength(rawName, 'utf8') ? rawName : undefined
            const handle = pendingHandle
            if (handle === undefined) return { status: 'unavailable-probe', reason: 'directory-member-handle-missing' }
            const label: DashboardDirectoryMemberLabel = {
              key,
              name: friendlyName ?? key,
              nameBytes: friendlyName === undefined ? 0 : rawNameBytes,
              proven: true,
            }
            members.set(key, { label, handle, lease: leaseToken, rawName, rawNameBytes, stamp: opened.value.stamp })
            pendingHandle = undefined
            leaseTransferred = true
            labels.push(label)
          } finally {
            if (pendingHandle !== undefined) {
              try { pendingHandle.release() } catch { /* one owned connection is released exactly once */ }
            }
            if (!leaseTransferred) session.releaseDirectoryMemberLease(leaseToken)
          }
        }
        return { status: 'ok', value: labels }
      },
      verifyLabels(value: readonly string[]): DashboardReadOutcome<void> {
        const state = live()
        if (state.status !== 'ok') return state
        const keys = copyDirectoryMemberKeys(value, DIRECTORY_LABEL_MAX_KEYS)
        if (keys === undefined || new Set(keys).size !== keys.length) {
          return { status: 'unavailable-probe', reason: 'directory-label-keys-invalid' }
        }
        for (const key of keys) {
          if (!enumerated.has(key)) return { status: 'unavailable-probe', reason: 'directory-label-key-unenumerated' }
          const member = members.get(key)
          if (member === undefined) return { status: 'unavailable-probe', reason: 'directory-label-missing' }
          const handle = member.handle
          const stamp = member.stamp
          if (handle === undefined || stamp === undefined) continue
          const keyBytes = Buffer.byteLength(key, 'utf8')
          const cost: DashboardReadCost = {
            sqlStatements: DIRECTORY_VERIFY_SQL,
            rowsVisited: DIRECTORY_VERIFY_ROWS,
            materializedBytes: DIRECTORY_VERIFY_MATERIALIZED_BYTES,
            keyBytes,
          }
          const verified = session.runDirectoryMemberRecord(key, cost, () => {
            try {
              // A path replacement after the label read must withdraw the page:
              // the connection's saved path observation must still match the
              // current lstat() (observation agreement, not handle identity).
              if (!connectionMatchesMemberFile(handle.store, directory, key)) return { changed: true as const }
              const meta = handle.store.dashboardProjectMeta(DIRECTORY_LABEL_NAME_BYTES)
              const current = handle.store.dashboardReadVersion()
              const rawName = meta?.name
              const rawNameBytes = meta === undefined ? 0 : meta.nameBytes
              if (current.connectionId !== stamp.connectionId || current.dataVersion !== stamp.dataVersion ||
                  current.totalChanges !== stamp.totalChanges || rawName !== member.rawName ||
                  rawNameBytes !== member.rawNameBytes) return { changed: true as const }
              return { changed: false as const }
            } catch { return { changed: true as const } }
          })
          if (verified.status !== 'ok') return verified
          if (verified.value.changed) return { status: 'stale', reason: 'directory-member-changed' }
        }
        return { status: 'ok', value: undefined }
      },
      release(): void { dispose() },
    }
    registry = { dispose }
    this.directoryLabelRegistry = registry
    return { status: 'ok', value: reader }
  }

  private reserveDirectoryMemberLease(): DashboardReadOutcome<string> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    let reserved: DashboardReadOutcome<{ reservationToken: string }>
    try { reserved = this.manager.reserveResident(this.callToken, 'cache', DIRECTORY_MEMBER_HANDLE_BYTES) }
    catch {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'directory-member-reservation-failed')
    }
    if (reserved.status !== 'ok') {
      if (reserved.status !== 'budget-exhausted') this.finishOnFailure()
      return reserved
    }
    return { status: 'ok', value: reserved.value.reservationToken }
  }

  private releaseDirectoryMemberLease(token: string): void {
    if (this.ended || this.paused) return
    try { this.manager.releaseResident(this.callToken, token) } catch { /* teardown owns the remaining lease */ }
  }

  private runDirectoryMemberRecord<T>(key: string, cost: DashboardReadCost, operation: () => T): DashboardReadOutcome<T> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    let result: DashboardReadOutcome<T>
    try { result = this.manager.runMember(this.callToken, key, cost, operation) }
    catch {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'directory-member-read-failed')
    }
    if (result.status === 'ok' && this.readWallNow() === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    if (result.status !== 'ok' && result.status !== 'budget-exhausted') this.finishOnFailure()
    return result
  }

  private disposeDirectoryLabelReader(): void {
    const registry = this.directoryLabelRegistry
    if (registry === undefined) return
    this.directoryLabelRegistry = undefined
    registry.dispose()
  }

  /** Trusted in-process capacity snapshot used to bound raw directory scans. */
  beginPersonaProofGuard(rounds = 2): () => void { return this.enterPersonaReserve(rounds) }

  private enterPersonaReserve(rounds: number): () => void {
    const previous = this.personaReserve
    this.personaReserve = { rounds: Math.max(previous?.rounds ?? 0, rounds) }
    return () => { this.personaReserve = previous }
  }

  private personaReserveCost(originScopeCount = this.directOriginSchemaScopes?.size ?? 0, minimumRounds = 0): DashboardReadCost {
    const rounds = Math.max(this.personaReserve?.rounds ?? 0, minimumRounds)
    const fusionFence = Number(this.overviewFusion !== undefined)
    const perRound = 2 * (1 + this.projectKeys.length) + originScopeCount + fusionFence
    return {
      sqlStatements: perRound * rounds,
      rowsVisited: perRound * rounds,
      materializedBytes: 256 * (originScopeCount + fusionFence) * rounds,
      keyBytes: 0,
    }
  }

  private personaReserveStatus(cost: DashboardReadCost, originScopeCount = this.directOriginSchemaScopes?.size ?? 0, minimumRounds = 0):
    { ok: true } | { ok: false; reason: 'persona-session-headroom' | 'persona-call-headroom' } {
    const reserve = this.personaReserveCost(originScopeCount, minimumRounds)
    if (reserve.sqlStatements === 0 && reserve.rowsVisited === 0 && reserve.materializedBytes === 0) return { ok: true }
    const remaining = this.remainingReadWorkBreakdown()
    if (remaining === undefined) return { ok: false, reason: 'persona-call-headroom' }
    const fits = (available: DashboardReadCost): boolean =>
      cost.sqlStatements + reserve.sqlStatements <= available.sqlStatements &&
      cost.rowsVisited + reserve.rowsVisited <= available.rowsVisited &&
      cost.materializedBytes + reserve.materializedBytes <= available.materializedBytes &&
      cost.keyBytes + reserve.keyBytes <= available.keyBytes
    if (!fits(remaining.session)) return { ok: false, reason: 'persona-session-headroom' }
    if (!fits(remaining.call)) return { ok: false, reason: 'persona-call-headroom' }
    return { ok: true }
  }

  remainingReadWorkBreakdown(): DashboardReadRemainingWork | undefined {
    if (this.ended || this.paused) return undefined
    const counters = this.manager.counters(this.callToken)
    if (counters.status !== 'ok') return undefined
    const limits = this.manager.limits
    const remaining = (limit: number, used: number): number => Math.max(0, limit - used)
    const cost = (limit: DashboardReadCost, used: DashboardReadCost): DashboardReadCost => ({
      sqlStatements: remaining(limit.sqlStatements, used.sqlStatements),
      rowsVisited: remaining(limit.rowsVisited, used.rowsVisited),
      materializedBytes: remaining(limit.materializedBytes, used.materializedBytes),
      keyBytes: remaining(limit.keyBytes, used.keyBytes),
    })
    const call = cost(limits.perCall, counters.value.call)
    const session = cost(limits.perSession, counters.value.session)
    return {
      call, session,
      combined: {
        sqlStatements: Math.min(call.sqlStatements, session.sqlStatements),
        rowsVisited: Math.min(call.rowsVisited, session.rowsVisited),
        materializedBytes: Math.min(call.materializedBytes, session.materializedBytes),
        keyBytes: Math.min(call.keyBytes, session.keyBytes),
      },
    }
  }

  /** Combined remaining work retained for callers that need only the minimum. */
  remainingReadWork(): DashboardReadCost | undefined {
    return this.remainingReadWorkBreakdown()?.combined
  }

  get isPaused(): boolean { return this.paused }

  private resolveItem(projectKey: string, id: string, outputReservations: string[], maxBodyBytes = MAX_ROW_BYTES): DashboardReadOutcome<DashboardVisibilityItem> {
    const proof = this.proveRoot(projectKey, id, outputReservations)
    if (proof.status !== 'ok') return proof
    if (proof.value.state !== 'visible' || proof.value.node === undefined) return { status: 'ok', value: {
      state: proof.value.state, id, ...(proof.value.reason === undefined ? {} : { reason: proof.value.reason }),
    } }
    const output = this.reserveManagedItemOutput(proof.value.node.revision.sourceIdsBytes,
      Math.min(proof.value.node.revision.contentBytes, maxBodyBytes))
    if (output.status !== 'ok') return output
    const record = this.readVisibleRecord(proof.value.node, outputReservations, maxBodyBytes)
    if (record.status !== 'ok') return record
    return record.value === undefined
      ? { status: 'ok', value: { state: 'unresolved', id, reason: 'visible-body-incomplete' } }
      : { status: 'ok', value: { state: 'visible', id, record: record.value } }
  }

  private resolveManagedPageItem(projectKey: string, status: 'candidate' | 'forgotten', memoryId: string,
    contentLimit: number | null): DashboardReadOutcome<DashboardVisibilityItem> {
    const resolved = this.resolveManagedMemory(projectKey, memoryId, status, contentLimit)
    if (resolved.status !== 'ok') return resolved
    return { status: 'ok', value: { state: resolved.value.state, id: memoryId,
      ...(resolved.value.reason === undefined ? {} : { reason: resolved.value.reason }),
      ...(resolved.value.record === undefined ? {} : { record: resolved.value.record }),
      ...(resolved.value.summary === undefined ? {} : { summary: resolved.value.summary }) } }
  }

  private proveRoot(projectKey: string, memoryId: string, outputReservations: string[]): DashboardReadOutcome<{ state: DashboardVisibilityState; node?: LoadedNode; reason?: string }> {
    const now = this.readWallNow()
    if (now === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    const temporaryReservations: string[] = []
    const proofKey = JSON.stringify(['approved-proof', this.binding, projectKey, memoryId])
    try {
      const root = this.loadNode(projectKey, memoryId, now, temporaryReservations)
      if (root.status !== 'ok') return root
      if (root.value.state !== 'visible' || root.value.node === undefined) {
        return { status: 'ok', value: { state: root.value.state, reason: root.value.reason } }
      }
      const rootNode = root.value.node
      let progress = this.activeManagedPageItem?.approvedProof
      if (progress !== undefined && (progress.key !== proofKey ||
          progress.root.revision.revision !== rootNode.revision.revision ||
          JSON.stringify(progress.root.sourceIds) !== JSON.stringify(rootNode.sourceIds))) {
        return this.failure('stale', 'managed-page-approved-proof-shape-changed')
      }
      if (progress === undefined) {
        progress = {
          key: proofKey, root: rootNode, graph: new Map(), edges: [], pending: [memoryId],
          scheduled: new Set([memoryId]), nodeCount: 0, rawRelationCount: 0,
          graphChecked: false, expiryComputed: false, sourceBatches: new Map(), memoCommitted: false,
        }
        if (this.activeManagedPageItem !== undefined) this.activeManagedPageItem.approvedProof = progress
      } else {
        progress.root = rootNode
      }

      for (const node of progress.graph.values()) {
        if (node.meta.expiryAt !== undefined && node.meta.expiryAt !== null && node.meta.expiryAt <= now) {
          return { status: 'ok', value: { state: 'hidden', reason: 'memory-expired' } }
        }
      }
      if (progress.expiryComputed && progress.earliestExpiry !== undefined && progress.earliestExpiry <= now) {
        return { status: 'ok', value: { state: 'hidden', reason: 'memory-expired' } }
      }

      let state: DashboardVisibilityState = 'visible'
      let reason: string | undefined
      while (progress.pending.length > 0 || progress.currentId !== undefined) {
        if (progress.currentId === undefined) {
          const nextId = progress.pending.pop()!
          const nextKey = this.memoKey(projectKey, nextId)
          if (progress.graph.has(nextKey)) continue
          if (progress.nodeCount >= MAX_NODES_PER_ROOT) {
            state = 'unresolved'
            reason = 'visibility-node-limit'
            break
          }
          if (progress.nodeCount % ACCOUNTING_BLOCK === 0) {
            const resourceKey = JSON.stringify(['approved-node-accounting', proofKey,
              Math.floor(progress.nodeCount / ACCOUNTING_BLOCK)])
            const reserved = this.reserveTemporary(NODE_ACCOUNTING_BYTES * ACCOUNTING_BLOCK, resourceKey)
            if (reserved.status !== 'ok') {
              // The node was popped before its accounting block was admitted.
              // A resumable per-call stop must put it back so the next RPC does
              // not silently prove a graph missing this dependency.
              progress.pending.push(nextId)
              return reserved
            }
            this.trackTemporaryReservation(reserved.value, temporaryReservations)
          }
          progress.nodeCount += 1
          progress.currentId = nextId
          progress.currentMemoDecision = undefined
        }

        const currentId = progress.currentId
        const currentKey = this.memoKey(projectKey, currentId)
        const currentNow = this.readWallNow()
        if (currentNow === undefined) {
          this.finishOnFailure()
          return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
        }
        const cachedNode = progress.graph.get(currentKey)
        const loaded = cachedNode !== undefined ? { status: 'ok' as const, value: { state: 'visible' as const, node: cachedNode } }
          : currentId === memoryId ? { status: 'ok' as const, value: root.value }
            : this.loadNode(projectKey, currentId, currentNow, temporaryReservations)
        if (loaded.status !== 'ok') return loaded
        if (loaded.value.state !== 'visible' || loaded.value.node === undefined) {
          state = loaded.value.state
          reason = loaded.value.reason
          break
        }
        const node = loaded.value.node
        progress.graph.set(currentKey, node)
        if (progress.currentMemoDecision === undefined) {
          const proofMemo = this.memo.get(currentKey)
          progress.currentMemoDecision = currentId === memoryId && proofMemo?.state === 'visible' &&
            proofMemo.revision === node.revision.revision &&
            (proofMemo.expiryAt === undefined || proofMemo.expiryAt === null || proofMemo.expiryAt > currentNow)
          if (progress.currentMemoDecision && typeof proofMemo?.expiryAt === 'number') {
            progress.inheritedEarliestExpiry = proofMemo.expiryAt
          }
        }
        if (progress.currentMemoDecision) {
          progress.currentId = undefined
          progress.currentMemoDecision = undefined
          progress.relation = undefined
          continue
        }

        const relationIdentity = JSON.stringify([proofKey, node.id, node.revision.revision])
        let relationProgress = progress.relation
        if (relationProgress === undefined) {
          relationProgress = { identity: relationIdentity, hasMore: false, rowIndex: 0,
            rowCounted: false, rawCount: 0, edges: [] }
          progress.relation = relationProgress
        } else if (relationProgress.identity !== relationIdentity) {
          return this.failure('stale', 'managed-page-relation-shape-changed')
        }
        const relationResult = this.readDependencies(node, relationProgress, temporaryReservations, () => {
          progress!.rawRelationCount += 1
          return progress!.rawRelationCount <= MAX_NODES_PER_ROOT * MAX_RELATIONS_PER_NODE
        })
        if (relationResult.status !== 'ok') return relationResult
        if (relationResult.value.state !== 'visible') {
          state = relationResult.value.state
          reason = relationResult.value.reason
          break
        }
        for (const edge of relationResult.value.edges) {
          if (edge.fromRevision !== node.revision.revision) {
            state = 'hidden'
            reason = 'dependency-source-revision-mismatch'
            break
          }
          progress.edges.push(edge)
          if (!progress.scheduled.has(edge.toId)) {
            progress.scheduled.add(edge.toId)
            progress.pending.push(edge.toId)
          }
        }
        if (state !== 'visible') break
        progress.currentId = undefined
        progress.currentMemoDecision = undefined
        progress.relation = undefined
      }
      if (state !== 'visible') return { status: 'ok', value: { state, reason } }

      if (!progress.graphChecked) {
        if (this.hasDependencyCycle(projectKey, [...progress.graph.keys()], progress.edges)) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'dependency-cycle' } }
        }
        for (const edge of progress.edges) {
          const target = progress.graph.get(this.memoKey(projectKey, edge.toId))
          if (target === undefined) return { status: 'ok', value: { state: 'unresolved', reason: 'dependency-proof-incomplete' } }
          if (target.revision.revision !== edge.toRevision) {
            return { status: 'ok', value: { state: 'hidden', reason: 'dependency-target-revision-mismatch' } }
          }
        }
        progress.graphChecked = true
      }

      const existingSets = progress.sourceSets
      let sourceSets: { memory: string[]; evidence: string[];
        memoryBatches: string[][]; allBatches: string[][] }
      if (existingSets === undefined) {
        const unique = (values: string[]): string[] => [...new Set(values)]
        const batches = (values: string[]): string[][] => {
          const result: string[][] = []
          for (let offset = 0; offset < values.length; offset += 15) result.push(values.slice(offset, offset + 15))
          return result
        }
        const memory = unique([...progress.graph.values()].flatMap((node) => node.sourceIds))
        const evidence = unique(progress.edges.flatMap((edge) => edge.evidenceIds))
        sourceSets = { memory, evidence, memoryBatches: batches([...progress.graph.values()].map((node) => node.id)),
          allBatches: batches(unique([...memory, ...evidence])) }
        progress.sourceSets = sourceSets
      } else {
        sourceSets = existingSets
      }

      const memoryFence = this.verifyMemoryFences(projectKey, [...progress.graph.values()].map((node) => node.id),
        sourceSets.memoryBatches)
      if (memoryFence.status !== 'ok') return memoryFence
      if (memoryFence.value.state !== 'visible') return { status: 'ok', value: { state: memoryFence.value.state, reason: memoryFence.value.reason } }

      const sourceProof = this.verifySources(projectKey, sourceSets.memory, sourceSets.evidence, progress)
      if (sourceProof.status !== 'ok') return sourceProof
      if (sourceProof.value.state !== 'visible') return { status: 'ok', value: { state: sourceProof.value.state, reason: sourceProof.value.reason } }

      if (!progress.expiryComputed) {
        const graphEarliestExpiry = [...progress.graph.values()].flatMap((node) => {
          const value = node.meta.expiryAt
          return value === undefined || value === null ? [] : [value]
        }).reduce<number | undefined>((prior, value) => prior === undefined ? value : Math.min(prior, value), undefined)
        progress.earliestExpiry = graphEarliestExpiry === undefined ? progress.inheritedEarliestExpiry
          : progress.inheritedEarliestExpiry === undefined ? graphEarliestExpiry : Math.min(graphEarliestExpiry, progress.inheritedEarliestExpiry)
        progress.expiryComputed = true
      }
      const finalNow = this.readWallNow()
      if (finalNow === undefined) {
        this.finishOnFailure()
        return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
      }
      if (progress.earliestExpiry !== undefined && progress.earliestExpiry <= finalNow) {
        return { status: 'ok', value: { state: 'hidden', reason: 'memory-expired' } }
      }
      if (!progress.memoCommitted) {
        const entries = [...progress.graph.values()].map((node) => ({
          key: this.memoKey(projectKey, node.id),
          proof: { state: 'visible' as const, revision: node.revision.revision, expiryAt: progress!.earliestExpiry },
        }))
        const memoized = this.memoize(entries)
        if (memoized.status !== 'ok') return memoized
        progress.memoCommitted = true
      }
      const rootKeyBytes = rootNode.sourceIds.reduce((sum, sourceId) => sum + Buffer.byteLength(sourceId, 'utf8') + 32, 0)
      const rootOutput = this.reserveTemporary(Math.max(1024, rootKeyBytes + 512),
        JSON.stringify(['approved-root-output', proofKey]))
      if (rootOutput.status !== 'ok') return rootOutput
      this.trackTemporaryReservation(rootOutput.value, outputReservations)
      return { status: 'ok', value: { state: 'visible', node: rootNode } }
    } finally {
      this.releaseReservations(temporaryReservations)
    }
  }

  private loadNode(projectKey: string, id: string, wallNow: number, reservations: string[]): DashboardReadOutcome<NodeLoad> {
    const store = this.stores.get(projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const combined = this.overviewFusionDepth > 0 ? this.overviewNodePage(projectKey, id) : undefined
    if (combined !== undefined && combined.status !== 'ok') return combined
    const metaResult = combined?.status === 'ok' ? { status: 'ok' as const, value: combined.value.meta } : this.run(store, {
      sqlStatements: 1, rowsVisited: 1, materializedBytes: PAGE_ROW_BYTES, keyBytes: this.keyBytes(projectKey, id),
    }, () => store.dashboardVisibilityMemoryMeta(id), JSON.stringify(['memory-meta', projectKey, id]))
    if (metaResult.status !== 'ok') return metaResult
    if (metaResult.value === undefined) return { status: 'ok', value: { state: 'hidden', reason: 'memory-not-found' } }
    const meta = metaResult.value
    if (meta.statusInvalid || meta.status === undefined || !MEMORY_STATUSES.has(meta.status) ||
        !Number.isSafeInteger(meta.sourceBytes) || meta.sourceBytes < 0 || meta.sourceBytes > 512 ||
        typeof meta.source !== 'string' || Buffer.byteLength(meta.source, 'utf8') !== meta.sourceBytes ||
        !Number.isFinite(meta.confidence) || meta.confidence! < 0 || meta.confidence! > 1 ||
        !safeInteger(meta.createdAt) || !safeInteger(meta.updatedAt) ||
        !optionalInteger(meta.approvedAt) || !optionalInteger(meta.forgottenAt) || !optionalInteger(meta.expiryAt)) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'memory-metadata-invalid' } }
    }
    if (meta.status !== 'approved') return { status: 'ok', value: { state: 'hidden', reason: 'memory-not-approved' } }
    if (meta.expiryAt !== undefined && meta.expiryAt !== null && meta.expiryAt <= wallNow) {
      return { status: 'ok', value: { state: 'hidden', reason: 'memory-expired' } }
    }
    const selected = this.selectRevision(store, projectKey, id, this.binding.asOf,
      combined?.status === 'ok' ? combined.value : undefined)
    if (selected.status !== 'ok') return selected
    if (selected.value.state === 'unresolved') return { status: 'ok', value: { state: 'unresolved', reason: selected.value.reason } }
    if (selected.value.state === 'none' || selected.value.revision === undefined) {
      return { status: 'ok', value: { state: 'hidden', reason: 'no-effective-revision' } }
    }
    const revision = selected.value.revision
    const ids = this.fetchJson(store, revision.sourceIdsBytes, id, (target) =>
      target.dashboardVisibilityRevisionSources(id, revision.revision), reservations,
    JSON.stringify(['revision-source-json', projectKey, id, revision.revision]),
    revision.inlineSourceJson === undefined ? undefined : { json: revision.inlineSourceJson, bytes: revision.sourceIdsBytes })
    if (ids.status !== 'ok') return ids
    if (!ids.value.ok || !Array.isArray(ids.value.value) || ids.value.value.length > MAX_SOURCE_IDS ||
        ids.value.value.some((item) => typeof item !== 'string' || !this.validId(item))) {
      return { status: 'ok', value: { state: 'unresolved', reason: 'revision-source-json-invalid' } }
    }
    const sourceIds = [...new Set(ids.value.value as string[])]
    return { status: 'ok', value: { state: 'visible', node: { projectKey, id, meta, revision, sourceIds } } }
  }

  private selectRevision(store: MemoryStore, projectKey: string, memoryId: string, asOf: number,
    initialPage?: ReturnType<MemoryStore['dashboardVisibilityNodePage']>): DashboardReadOutcome<RevisionSelection> {
    let after: DashboardVisibilityRevisionCursor | undefined
    while (true) {
      const page = after === undefined && initialPage !== undefined ? { status: 'ok' as const, value: initialPage } : this.run(store, {
        sqlStatements: 1, rowsVisited: PAGE_ROWS, materializedBytes: PAGE_ROWS * REVISION_ROW_BYTES,
        keyBytes: this.keyBytes(memoryId, after && String(after.revision)),
      }, () => store.dashboardVisibilityRevisionPage(memoryId, after, PAGE_ROWS),
      JSON.stringify(['revision-page', projectKey, memoryId, asOf, after?.recordedAt ?? null, after?.revision ?? null]))
      if (page.status !== 'ok') return page
      const examined = page.value.hasMore ? page.value.rows.slice(0, -1) : page.value.rows
      let last: DashboardVisibilityRevisionPageRow | undefined
      for (const row of examined) {
        last = row
        if (!safeInteger(row.revision) || row.revision < 1 || !safeInteger(row.recordedAt)) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'revision-key-invalid' } }
        }
        if (row.recordedAt > asOf) continue
        const validFromState = isValidFromState(row.validFromState) ? row.validFromState : undefined
        const validFromPrecision = isValidFromPrecision(row.validFromPrecision) ? row.validFromPrecision : undefined
        const validFromBasis = isValidFromBasis(row.validFromBasis) ? row.validFromBasis : undefined
        if (row.validFromStateInvalid || validFromState === undefined) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'revision-temporal-state-invalid' } }
        }
        if (validFromState === 'known' && row.validFrom !== null && row.validFrom !== undefined && !safeInteger(row.validFrom)) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'revision-valid-from-invalid' } }
        }
        if (validFromState === 'known' && (row.validFrom === null || row.validFrom === undefined)) continue
        if (validFromState === 'known' && row.validFrom! > asOf) continue
        if (!optionalInteger(row.validTo)) return { status: 'ok', value: { state: 'unresolved', reason: 'revision-valid-to-invalid' } }
        if (row.validTo !== null && row.validTo !== undefined && row.validTo <= asOf) continue
        if (row.validFromPrecisionInvalid || row.validFromBasisInvalid ||
            !Number.isSafeInteger(row.validFromPrecisionBytes) || row.validFromPrecisionBytes > 32 ||
            !Number.isSafeInteger(row.validFromBasisBytes) || row.validFromBasisBytes > 32 ||
            validFromPrecision === undefined || validFromBasis === undefined ||
            row.validFromLabelBytes > 512 || row.validFromLabel === undefined && row.validFromLabelBytes > 0 ||
            row.kind === undefined || !Number.isSafeInteger(row.kindBytes) || row.kindBytes < 0 || row.kindBytes > 256 ||
            !Number.isSafeInteger(row.sceneBytes) || row.sceneBytes < 0 || row.sceneBytes > 512 ||
            row.scene === undefined && row.sceneBytes > 0 ||
            !safeInteger(row.contentBytes) || row.contentBytes < 1 || row.contentBytes > MAX_ROW_BYTES ||
            !safeInteger(row.sourceIdsBytes) || row.sourceIdsBytes < 2 || row.sourceIdsBytes > MAX_ROW_BYTES ||
            !optionalInteger(row.validFrom) || !optionalInteger(row.validFromUpper) || !optionalInteger(row.supersededAt) ||
            row.sourceVerified !== 0 && row.sourceVerified !== 1) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'revision-metadata-invalid' } }
        }
        if (validFromPrecision === undefined || validFromBasis === undefined) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'revision-metadata-invalid' } }
        }
        const selected: SelectedRevisionRow = {
          ...row, validFromState, validFromPrecision, validFromBasis,
        }
        return { status: 'ok', value: { state: 'selected', revision: selected } }
      }
      if (!page.value.hasMore || last === undefined) return { status: 'ok', value: { state: 'none' } }
      after = { recordedAt: last.recordedAt, revision: last.revision }
    }
  }

  /**
   * Read one node's dependency pages into resumable state. A per-call budget
   * failure only leaves `progress` positioned on the current page row; a later
   * invocation continues exactly there instead of rebuilding the relation page
   * or charging its rows and evidence JSON again. Completed edges are returned
   * only when the whole node proof is complete so a resumed caller never pushes
   * a partially delivered relation set twice.
   */
  private readDependencies(node: LoadedNode, progress: ManagedRelationProgress, reservations: string[],
    countRaw: (rows: number) => boolean): DashboardReadOutcome<RelationLoad> {
    const store = this.stores.get(node.projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    while (true) {
      if (progress.rows === undefined) {
        const page = this.run(store, {
          sqlStatements: 1, rowsVisited: PAGE_ROWS, materializedBytes: PAGE_ROWS * RELATION_ROW_BYTES,
          keyBytes: this.keyBytes(node.id, progress.after && progress.after.toId, progress.after && progress.after.type),
        }, () => store.dashboardVisibilityRelationPage(node.id, progress.after, PAGE_ROWS),
        JSON.stringify(['relation-page', node.projectKey, node.id, node.revision.revision,
          progress.after?.toId ?? null, progress.after?.type ?? null]))
        if (page.status !== 'ok') return page
        const examined = page.value.hasMore ? page.value.rows.slice(0, PAGE_ITEMS) : page.value.rows
        progress.rows = examined
        progress.hasMore = page.value.hasMore
        progress.rowIndex = 0
        progress.rowCounted = false
        if (examined.length === 0) {
          return { status: 'ok', value: { state: page.value.hasMore ? 'unresolved' : 'visible',
            edges: progress.edges, ...(page.value.hasMore ? { reason: 'relation-page-incomplete' } : {}) } }
        }
      }
      const rows = progress.rows
      if (rows === undefined) return this.failure('stale', 'managed-page-relation-state-lost')
      while (progress.rowIndex < rows.length) {
        const row = rows[progress.rowIndex]!
        if (!progress.rowCounted) {
          progress.rowCounted = true
          progress.rawCount += 1
          if (!countRaw(1) || progress.rawCount > MAX_RELATIONS_PER_NODE) {
            return { status: 'ok', value: { state: 'unresolved', edges: progress.edges, reason: 'relation-row-limit' } }
          }
        }
        if (!safeInteger(row.toIdBytes) || row.toIdBytes < 0 || row.toIdBytes > MAX_ID_BYTES ||
            row.toId === undefined || row.type === undefined || row.typeBytes > 32 ||
            !this.validId(row.toId)) {
          return { status: 'ok', value: { state: 'unresolved', edges: progress.edges, reason: 'relation-key-overlong' } }
        }
        if (!DEPENDENCY_TYPES.has(row.type)) {
          progress.rowIndex += 1
          progress.rowCounted = false
          continue
        }
        if (row.id === undefined || row.idBytes > MAX_ID_BYTES ||
            !safeInteger(row.fromRevision) || row.fromRevision < 1 ||
            !safeInteger(row.toRevision) || row.toRevision < 1 ||
            !safeInteger(row.evidenceBytes) || row.evidenceBytes < 2 || row.evidenceBytes > MAX_ROW_BYTES) {
          return { status: 'ok', value: { state: 'unresolved', edges: progress.edges, reason: 'dependency-metadata-invalid' } }
        }
        if (progress.edges.length % ACCOUNTING_BLOCK === 0) {
          const block = Math.floor(progress.edges.length / ACCOUNTING_BLOCK)
          const reserved = this.reserveTemporary(EDGE_ACCOUNTING_BYTES * ACCOUNTING_BLOCK,
            JSON.stringify(['relation-edge-accounting', node.projectKey, node.id, node.revision.revision, block]))
          if (reserved.status !== 'ok') return reserved
          this.trackTemporaryReservation(reserved.value, reservations)
        }
        const evidence = this.fetchJson(store, row.evidenceBytes, row.id, (target) =>
          target.dashboardVisibilityRelationEvidence(row.id!), reservations,
        JSON.stringify(['relation-evidence-json', node.projectKey, node.id, node.revision.revision, row.id]))
        if (evidence.status !== 'ok') return evidence
        if (!evidence.value.ok || !Array.isArray(evidence.value.value) || evidence.value.value.length === 0 ||
            evidence.value.value.length > MAX_SOURCE_IDS ||
            evidence.value.value.some((item) => typeof item !== 'string' || !this.validId(item))) {
          return { status: 'ok', value: { state: 'unresolved', edges: progress.edges, reason: 'dependency-evidence-invalid' } }
        }
        progress.edges.push({
          fromId: node.id, toId: row.toId, fromRevision: row.fromRevision, toRevision: row.toRevision,
          evidenceIds: [...new Set(evidence.value.value as string[])],
        })
        progress.rowIndex += 1
        progress.rowCounted = false
      }
      if (!progress.hasMore) return { status: 'ok', value: { state: 'visible', edges: progress.edges } }
      const last = rows[rows.length - 1]
      if (last === undefined) {
        return { status: 'ok', value: { state: 'unresolved', edges: progress.edges, reason: 'relation-page-cursor-missing' } }
      }
      const lastToId = last.toId
      const lastType = last.type
      if (lastToId === undefined || lastType === undefined) {
        return { status: 'ok', value: { state: 'unresolved', edges: progress.edges, reason: 'relation-page-cursor-missing' } }
      }
      progress.after = { toId: lastToId, type: lastType }
      progress.rows = undefined
      progress.rowIndex = 0
      progress.rowCounted = false
    }
  }

  private hasDependencyCycle(projectKey: string, nodeKeys: string[], edges: DependencyEdge[]): boolean {
    const outgoing = new Map<string, string[]>()
    for (const edge of edges) {
      const from = this.memoKey(projectKey, edge.fromId)
      const to = this.memoKey(projectKey, edge.toId)
      const targets = outgoing.get(from) ?? []
      targets.push(to)
      outgoing.set(from, targets)
    }
    const colors = new Map<string, 0 | 1 | 2>()
    for (const start of nodeKeys) {
      if ((colors.get(start) ?? 0) !== 0) continue
      colors.set(start, 1)
      const stack: Array<{ key: string; next: number }> = [{ key: start, next: 0 }]
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!
        const targets = outgoing.get(frame.key) ?? []
        if (frame.next >= targets.length) {
          colors.set(frame.key, 2)
          stack.pop()
          continue
        }
        const target = targets[frame.next]!
        frame.next += 1
        const color = colors.get(target) ?? 0
        if (color === 1) return true
        if (color === 0) {
          colors.set(target, 1)
          stack.push({ key: target, next: 0 })
        }
      }
    }
    return false
  }

  /**
   * Prove the memory control fences in the proof's precomputed semantic
   * batches. The batches are supplied by a resumable approved proof so a
   * per-call budget stop never changes the grouping or the charged identity of
   * an already completed fence step; each completed batch is a stable
   * (project, operation, parameters) step that is reused on the next RPC.
   */
  private verifyMemoryFences(projectKey: string, memoryIds: string[],
    batches?: string[][]): DashboardReadOutcome<SourceVerification> {
    const unique = [...new Set(memoryIds)]
    let groups: string[][]
    if (batches === undefined) {
      groups = []
      for (let offset = 0; offset < unique.length; offset += 15) groups.push(unique.slice(offset, offset + 15))
    } else {
      if (!Array.isArray(batches) || batches.some((batch) => !Array.isArray(batch) ||
          batch.length < 1 || batch.length > 15)) {
        return this.failure('stale', 'managed-page-memory-fence-shape-changed')
      }
      const flat = batches.flat()
      if (flat.length !== unique.length ||
          flat.some((memoryId, index) => memoryId !== unique[index])) {
        return this.failure('stale', 'managed-page-memory-fence-shape-changed')
      }
      groups = batches.map((batch) => [...batch])
    }
    for (const batch of groups) {
      const result = this.readFences({ projectKey, memoryIds: batch })
      if (result.status !== 'ok') return result
      if (result.value.state !== 'visible') return { status: 'ok', value: { state: result.value.state, reason: result.value.reason } }
      const fences = result.value.fences!
      if (fences.forgottenMemoryIds.length > 0 || fences.deletedMemoryIds.length > 0) {
        return { status: 'ok', value: { state: 'hidden', reason: 'memory-control-fence' } }
      }
    }
    return { status: 'ok', value: { state: 'visible' } }
  }

  /**
   * Prove source identities and their fences in bounded semantic batches. An
   * approved proof supplies its precomputed batches plus a per-batch progress
   * record (`nextSourceIndex` and the collected `eventIds`) so a mid-batch
   * per-call budget stop resumes at the next unproven source and still runs the
   * event fence over exactly the identities already collected. Every retained
   * event-ID resource has a semantic key, so resuming reuses its lease instead
   * of charging the same bytes twice.
   */
  private verifySources(projectKey: string, memorySourceIds: string[], evidenceSourceIds: string[],
    progress?: ManagedApprovedProofProgress): DashboardReadOutcome<SourceVerification> {
    const memorySources = [...new Set(memorySourceIds)]
    const evidenceSources = [...new Set(evidenceSourceIds)]
    const all = [...new Set([...memorySources, ...evidenceSources])]
    let groups: string[][]
    if (progress === undefined) {
      groups = []
      for (let offset = 0; offset < all.length; offset += 15) groups.push(all.slice(offset, offset + 15))
    } else {
      const sourceSets = progress.sourceSets
      if (sourceSets === undefined) return this.failure('stale', 'managed-page-source-sets-missing')
      const batches = sourceSets.allBatches
      if (!Array.isArray(batches) || batches.some((batch) => !Array.isArray(batch) ||
          batch.length < 1 || batch.length > 15)) {
        return this.failure('stale', 'managed-page-source-batch-shape-changed')
      }
      const flat = batches.flat()
      if (flat.length !== all.length || flat.some((sourceId, index) => sourceId !== all[index])) {
        return this.failure('stale', 'managed-page-source-batch-shape-changed')
      }
      groups = batches
    }
    for (const batch of groups) {
      const identity = JSON.stringify(['source-batch', projectKey, batch])
      let state: ManagedSourceBatchProgress | undefined
      if (progress !== undefined) {
        state = progress.sourceBatches.get(identity)
        if (state === undefined) {
          state = { identity, sourceIds: [...batch], eventIds: [], nextSourceIndex: 0 }
          progress.sourceBatches.set(identity, state)
        } else if (state.identity !== identity ||
            state.sourceIds.length !== batch.length ||
            state.sourceIds.some((sourceId, index) => sourceId !== batch[index]) ||
            !Array.isArray(state.eventIds) ||
            !Number.isSafeInteger(state.nextSourceIndex) || state.nextSourceIndex < 0 ||
            state.nextSourceIndex > batch.length) {
          return this.failure('stale', 'managed-page-source-batch-shape-changed')
        }
      }
      const eventIds: string[] = state === undefined ? [] : state.eventIds
      const eventReservations: string[] = []
      try {
        const fences = this.readFences({ projectKey, sourceIds: batch })
        if (fences.status !== 'ok') return fences
        if (fences.value.state !== 'visible') return { status: 'ok', value: { state: fences.value.state, reason: fences.value.reason } }
        const control = fences.value.fences!
        if (control.deletedSourceIds.length > 0 || control.revokedSourceIds.length > 0) {
          return { status: 'ok', value: { state: 'hidden', reason: 'source-control-fence' } }
        }
        const addEventId = (eventId: string): DashboardReadOutcome<void> => {
          if (eventIds.includes(eventId)) return { status: 'ok', value: undefined }
          const bytes = Buffer.byteLength(eventId, 'utf8')
          const reserved = this.reserveTemporary(Math.max(256, bytes * 2 + 128),
            JSON.stringify(['source-event-id', projectKey, eventId]))
          if (reserved.status !== 'ok') return reserved
          eventReservations.push(reserved.value)
          eventIds.push(eventId)
          return { status: 'ok', value: undefined }
        }
        const start = state === undefined ? 0 : state.nextSourceIndex
        const identities = this.overviewFusionDepth > 0 ? this.readOverviewSourceBatch(projectKey, batch) : undefined
        if (identities !== undefined && identities.status !== 'ok') return identities
        for (let index = start; index < batch.length; index += 1) {
          const sourceId = batch[index]!
          const store = this.stores.get(projectKey)!
          const result = identities?.status === 'ok'
            ? { status: 'ok' as const, value: identities.value.find((row) => row.id === sourceId)!.identity }
            : this.run(store, {
            sqlStatements: 1, rowsVisited: 1, materializedBytes: SOURCE_IDENTITY_ROW_BYTES,
            keyBytes: this.keyBytes(projectKey, sourceId),
          }, () => store.dashboardVisibilitySourceIdentity(sourceId),
          JSON.stringify(['source-identity', projectKey, sourceId]))
          if (result.status !== 'ok') return result
          if (typeof result.value.found !== 'boolean') {
            return { status: 'ok', value: { state: 'unresolved', reason: 'source-identity-invalid' } }
          }
          if (result.value.found) {
            const checked = this.validateIdentity(result.value)
            if (checked.state !== 'visible') return { status: 'ok', value: checked }
            if (result.value.agentPreset !== undefined && this.excludedAgentPatterns.some((pattern) =>
              matchesAgentGlob(result.value.agentPreset!, pattern))) {
              return { status: 'ok', value: { state: 'hidden', reason: 'excluded-source-agent' } }
            }
            if (result.value.sourceEventId !== undefined && result.value.sourceEventId !== null) {
              const added = addEventId(result.value.sourceEventId)
              if (added.status !== 'ok') return added
            }
          } else if (evidenceSources.includes(sourceId)) {
            return { status: 'ok', value: { state: 'hidden', reason: 'dependency-evidence-source-missing' } }
          } else {
            const legacy = this.findLegacyIdentity(store, projectKey, sourceId)
            if (legacy.status !== 'ok') return legacy
            if (legacy.value.state !== 'visible') return { status: 'ok', value: { state: legacy.value.state, reason: legacy.value.reason } }
            if (legacy.value.identity?.sourceEventId !== undefined) {
              const added = addEventId(legacy.value.identity.sourceEventId)
              if (added.status !== 'ok') return added
            }
          }
          if (state !== undefined) state.nextSourceIndex = index + 1
        }
        if (eventIds.length > 0) {
          const eventFences = this.readFences({ projectKey, sourceEventIds: eventIds })
          if (eventFences.status !== 'ok') return eventFences
          if (eventFences.value.state !== 'visible') {
            return { status: 'ok', value: { state: eventFences.value.state, reason: eventFences.value.reason } }
          }
          if (eventFences.value.fences!.revokedSourceEventIds.length > 0 ||
              eventFences.value.fences!.deletedSourceEventIds.length > 0) {
            return { status: 'ok', value: { state: 'hidden', reason: 'source-event-control-fence' } }
          }
        }
      } finally {
        this.releaseReservations(eventReservations)
      }
    }
    return { status: 'ok', value: { state: 'visible' } }
  }

  private readOverviewSourceBatch(projectKey: string, sourceIds: string[]):
    DashboardReadOutcome<ReturnType<MemoryStore['dashboardVisibilitySourceIdentities']>> {
    const ids = [...new Set(sourceIds)].sort()
    if (ids.length < 1 || ids.length > 15 || ids.some((id) => !this.validId(id))) {
      return this.failure('unavailable-probe', 'source-batch-shape-invalid')
    }
    const heads = this.overviewHeads(projectKey)
    if (heads.status !== 'ok') return heads
    const store = this.stores.get(projectKey)!
    const read = (fieldLimit: number) => this.run(store, { sqlStatements: 1, rowsVisited: 2 * ids.length + 8,
      materializedBytes: ids.length * (5 * fieldLimit + 512) + 1024,
      keyBytes: this.keyBytes(projectKey, ...ids) }, () => store.dashboardVisibilitySourceIdentities(ids, fieldLimit),
    JSON.stringify(['source-identity-batch', projectKey, ids, fieldLimit]))
    let result = read(512)
    if (result.status !== 'ok') return result
    const validShape = (rows: ReturnType<MemoryStore['dashboardVisibilitySourceIdentities']>): boolean =>
      Array.isArray(rows) && rows.length === ids.length && rows.every((row, index) =>
        row.id === ids[index] && typeof row.identity?.found === 'boolean')
    if (!validShape(result.value)) return this.failure('unavailable-probe', 'source-batch-shape-invalid')
    if (result.value.some(({ identity }) => [identity.sourceEventIdBytes, identity.originBytes, identity.sourceKindBytes,
      identity.sessionIdBytes, identity.agentPresetBytes].some((bytes) => safeInteger(bytes) && bytes > 512 && bytes <= 4096))) {
      // Pay for the wider SQL bound before asking SQLite to return its text.
      result = read(4096)
      if (result.status !== 'ok') return result
      if (!validShape(result.value)) return this.failure('unavailable-probe', 'source-batch-shape-invalid')
    }
    return result
  }

  private validateIdentity(identity: DashboardVisibilitySourceIdentity): SourceVerification {
    const sizes = [identity.sourceEventIdBytes, identity.originBytes, identity.sourceKindBytes,
      identity.sessionIdBytes, identity.agentPresetBytes]
    const fields: Array<[string | null | undefined, number]> = [
      [identity.sourceEventId, identity.sourceEventIdBytes], [identity.origin, identity.originBytes],
      [identity.sourceKind, identity.sourceKindBytes], [identity.sessionId, identity.sessionIdBytes],
      [identity.agentPreset, identity.agentPresetBytes],
    ]
    const projectionBytes = sizes.reduce((sum, size) => sum + size, 0)
    if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0 || size > 4096) ||
        !Number.isSafeInteger(identity.projectionBytes) || identity.projectionBytes < 0 || identity.projectionBytes > 20_480 ||
        identity.projectionBytes !== projectionBytes || fields.some(([value, bytes]) => value === null || value === undefined
          ? bytes !== 0 : typeof value !== 'string' || Buffer.byteLength(value, 'utf8') !== bytes) ||
        identity.sourceEventIdBytes > MAX_SOURCE_EVENT_BYTES ||
        identity.sourceEventId !== undefined && identity.sourceEventId !== null &&
          !this.validSourceEventId(identity.sourceEventId)) {
      return { state: 'unresolved', reason: 'source-identity-invalid' }
    }
    if (!isConversationSource(identity.sourceKind)) return { state: 'hidden', reason: 'non-conversation-source' }
    return { state: 'visible' }
  }

  private findLegacyIdentity(store: MemoryStore, projectKey: string, sourceId: string): DashboardReadOutcome<{ state: DashboardVisibilityState; identity?: LegacyIdentity; reason?: string }> {
    let afterId: number | undefined
    const newest: DashboardVisibilityLegacyEventPageRow[] = []
    while (true) {
      const page = this.run(store, {
        sqlStatements: 1, rowsVisited: PAGE_ROWS, materializedBytes: PAGE_ROWS * LEGACY_EVENT_ROW_BYTES,
        keyBytes: this.keyBytes(sourceId, afterId === undefined ? undefined : String(afterId)),
      }, () => store.dashboardVisibilityLegacyEventPage(sourceId, afterId, PAGE_ROWS),
      JSON.stringify(['legacy-event-page', projectKey, sourceId, afterId ?? null]))
      if (page.status !== 'ok') return page
      for (const row of page.value.rows) {
        if (!safeInteger(row.id) || !safeInteger(row.createdAt)) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-key-invalid' } }
        }
        if (!row.matches) continue
        newest.push(row)
        newest.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id)
        if (newest.length > 20) newest.pop()
      }
      if (!page.value.hasMore || page.value.rows.length === 0) break
      afterId = page.value.rows[page.value.rows.length - 1]!.id
    }
    newest.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id)
    for (const row of newest) {
      if (!Number.isSafeInteger(row.eventIdBytes) || row.eventIdBytes! < 0 || row.eventIdBytes! > 2008 ||
          row.eventId === undefined && row.eventIdBytes! > 0 ||
          !Number.isSafeInteger(row.sessionIdBytes) || row.sessionIdBytes! < 0 || row.sessionIdBytes! > 512 ||
          row.sessionId === undefined && row.sessionIdBytes! > 0) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-identity-overlong' } }
      }
      const eventId = row.eventId ?? ''
      if (!eventId.startsWith('capture:') || eventId.length <= 8) continue
      const sourceEventId = eventId.slice(8)
      if (sourceEventId === sourceId) continue
      if (!this.validSourceEventId(sourceEventId)) return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-source-event-key-invalid' } }
      if (!safeInteger(row.agentPresetBytes) || row.agentPresetBytes < 0 || row.agentPresetBytes > 256 ||
          row.agentPreset === undefined && row.agentPresetBytes > 0) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-agent-identity-invalid' } }
      }
      if (row.agentPreset !== undefined && this.excludedAgentPatterns.some((pattern) => matchesAgentGlob(row.agentPreset!, pattern))) {
        return { status: 'ok', value: { state: 'hidden', reason: 'excluded-source-agent' } }
      }
      const metadataBytes = row.metadataBytes ?? 0
      if (!safeInteger(metadataBytes) || metadataBytes < 0 || metadataBytes > 16_384) {
        return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-metadata-overlong' } }
      }
      const reserved = this.reserveTemporary(Math.max(1024, metadataBytes * 2 + 256),
        JSON.stringify(['legacy-metadata', projectKey, sourceId, row.id]))
      if (reserved.status !== 'ok') return reserved
      try {
        const metadata = this.run(store, {
          sqlStatements: 1, rowsVisited: 1, materializedBytes: 16_384,
          keyBytes: this.keyBytes(String(row.id)),
        }, () => store.dashboardVisibilityLegacyEventMetadata(row.id),
        JSON.stringify(['legacy-event-metadata', projectKey, sourceId, row.id]))
        if (metadata.status !== 'ok') return metadata
        if (metadata.value === undefined || metadata.value.bytes !== metadataBytes || metadata.value.json === undefined ||
            Buffer.byteLength(metadata.value.json, 'utf8') !== metadataBytes) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-metadata-incomplete' } }
        }
        let parsed: unknown
        try { parsed = JSON.parse(metadata.value.json) as unknown } catch {
          return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-metadata-invalid' } }
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-metadata-invalid' } }
        }
        const sourceKind = (parsed as Record<string, unknown>).sourceKind
        if (sourceKind !== undefined && (typeof sourceKind !== 'string' || Buffer.byteLength(sourceKind, 'utf8') > 512)) {
          return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-event-source-kind-invalid' } }
        }
        if (!isConversationSource(sourceKind as string | undefined)) return { status: 'ok', value: { state: 'hidden', reason: 'non-conversation-source' } }
        return { status: 'ok', value: { state: 'visible', identity: { sourceEventId } } }
      } finally { this.releaseReservations([reserved.value]) }
    }
    return { status: 'ok', value: { state: 'unresolved', reason: 'legacy-source-identity-not-proven' } }
  }

  private readFences(input: { projectKey: string; memoryIds?: readonly string[]; sourceIds?: readonly string[];
    sourceEventIds?: readonly string[] }): DashboardReadOutcome<FenceCheck> {
    const memoryIds = input.memoryIds ?? []
    const sourceIds = input.sourceIds ?? []
    const sourceEventIds = input.sourceEventIds ?? []
    const groups = Number(memoryIds.length > 0) + Number(sourceIds.length > 0) + Number(sourceEventIds.length > 0)
    if (groups === 0) return { status: 'ok', value: { state: 'visible', fences: {
      forgottenMemoryIds: [], deletedMemoryIds: [], deletedSourceIds: [], revokedSourceIds: [],
      revokedSourceEventIds: [], deletedSourceEventIds: [],
    } } }
    const rowCount = memoryIds.length + sourceIds.length + sourceEventIds.length
    const result = this.run(this.control, {
      sqlStatements: groups, rowsVisited: rowCount, materializedBytes: rowCount * 96,
      keyBytes: this.keyBytes(input.projectKey, ...memoryIds, ...sourceIds, ...sourceEventIds),
    }, () => this.control.dashboardVisibilityFences(input),
    // Semantic step identity: project + operation + exact parameters. It must
    // not depend on the RPC sequence so a resumable item reuses a completed
    // fence read instead of paying for it again; each new RPC still re-proves
    // the control/project version and TTL at the final boundary.
    JSON.stringify(['visibility-fences', input.projectKey, memoryIds, sourceIds, sourceEventIds]))
    if (result.status !== 'ok') return result
    return { status: 'ok', value: { state: 'visible', fences: result.value } }
  }

  private fetchJson(store: MemoryStore, bytes: number, key: string,
    read: (store: MemoryStore) => { json?: string; bytes: number } | undefined,
    reservations: string[], stageIdentity?: string, inline?: { json: string; bytes: number }): DashboardReadOutcome<JsonResult> {
    if (!Number.isSafeInteger(bytes) || bytes < 2 || bytes > MAX_ROW_BYTES) {
      return { status: 'ok', value: { ok: false } }
    }
    if (this.activeManagedPageItem !== undefined && stageIdentity === undefined) {
      return this.failure('stale', 'managed-page-json-identity-missing')
    }
    const stageKey = stageIdentity === undefined ? undefined : JSON.stringify(['json', stageIdentity])
    const stageSignature = JSON.stringify([bytes, key])
    if (stageKey !== undefined) {
      const cached = this.managedPageStage<JsonResult>(stageKey, stageSignature)
      if (cached.status !== 'ok') return cached
      if (cached.value.found) return { status: 'ok', value: cached.value.value! }
    }
    const resourceKey = stageIdentity === undefined ? undefined : JSON.stringify(['json-buffer', stageIdentity])
    const temporaryBytes = Math.max(1024, bytes * 2 + 512)
    const reserved = this.reserveTemporary(temporaryBytes, resourceKey)
    if (reserved.status !== 'ok') return reserved
    let retained = false
    try {
      const retain = (value: JsonResult): DashboardReadOutcome<JsonResult> => {
        if (stageKey !== undefined) {
          const staged = this.retainManagedPageStage(stageKey, stageSignature, value, temporaryBytes)
          if (staged.status !== 'ok') return staged
        }
        this.trackTemporaryReservation(reserved.value, reservations)
        retained = true
        return { status: 'ok', value }
      }
      const fetched = inline === undefined ? this.run(store, {
        sqlStatements: 1, rowsVisited: 1, materializedBytes: bytes + 64,
        keyBytes: this.keyBytes(key) + bytes,
      }, () => read(store), stageIdentity === undefined ? undefined : JSON.stringify(['json-read', stageIdentity]))
        : this.runUncached(store, { sqlStatements: 0, rowsVisited: 0, materializedBytes: 0,
          keyBytes: this.keyBytes(key) + bytes }, () => inline)
      if (fetched.status !== 'ok') return fetched
      if (fetched.value === undefined || fetched.value.bytes !== bytes || fetched.value.json === undefined ||
          Buffer.byteLength(fetched.value.json, 'utf8') !== bytes) {
        return retain({ ok: false })
      }
      try {
        const parsed = JSON.parse(fetched.value.json) as unknown
        return retain({ ok: true, value: parsed })
      }
      catch {
        return retain({ ok: false })
      }
    } finally {
      if (!retained) this.releaseReservations([reserved.value])
    }
  }

  private readVisibleRecord(node: LoadedNode, outputReservations: string[], maxBodyBytes = MAX_ROW_BYTES): DashboardReadOutcome<DashboardVisibleMemory | undefined> {
    const revision = node.revision
    if (revision.contentBytes > maxBodyBytes) return { status: 'ok', value: undefined }
    const store = this.stores.get(node.projectKey)
    if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
    const reserved = this.reserveTemporary(Math.max(1024, revision.contentBytes + 256),
      JSON.stringify(['revision-body', node.projectKey, node.id, revision.revision, maxBodyBytes]))
    if (reserved.status !== 'ok') return reserved
    this.trackTemporaryReservation(reserved.value, outputReservations)
    const body = this.run(store, {
      sqlStatements: 1, rowsVisited: 1, materializedBytes: revision.contentBytes + 32,
      keyBytes: this.keyBytes(node.id, String(revision.revision)),
    }, () => store.dashboardVisibilityRevisionBody(node.id, revision.revision),
    JSON.stringify(['revision-body', node.projectKey, node.id, revision.revision, maxBodyBytes]))
    if (body.status !== 'ok') return body
    if (body.value === undefined || body.value.bytes !== revision.contentBytes || body.value.content === undefined ||
        Buffer.byteLength(body.value.content, 'utf8') !== revision.contentBytes || body.value.bytes > MAX_ROW_BYTES) {
      return { status: 'ok', value: undefined }
    }
    const meta = node.meta
    return { status: 'ok', value: {
      id: node.id, content: body.value.content, kind: revision.kind!, ...(revision.scene == null ? {} : { scene: revision.scene }),
      confidence: meta.confidence!, status: 'approved', source: meta.source!, sourceMessageIds: node.sourceIds,
      createdAt: meta.createdAt!, updatedAt: meta.updatedAt!,
      ...(meta.approvedAt === null || meta.approvedAt === undefined ? {} : { approvedAt: meta.approvedAt }),
      revision: revision.revision, ...(revision.validFrom === null || revision.validFrom === undefined ? {} : { validFrom: revision.validFrom }),
      validFromState: revision.validFromState,
      validFromPrecision: revision.validFromPrecision, validFromBasis: revision.validFromBasis,
      ...(revision.validFromUpper === null || revision.validFromUpper === undefined ? {} : { validFromUpper: revision.validFromUpper }),
      ...(revision.validFromLabel === null || revision.validFromLabel === undefined ? {} : { validFromLabel: revision.validFromLabel }),
      ...(revision.validTo === null || revision.validTo === undefined ? {} : { validTo: revision.validTo }),
      recordedAt: revision.recordedAt,
      ...(revision.supersededAt === null || revision.supersededAt === undefined ? {} : { supersededAt: revision.supersededAt }),
      sourceVerified: revision.sourceVerified === 1,
      ...(meta.expiryAt === null || meta.expiryAt === undefined ? {} : { expiryAt: meta.expiryAt }),
    } }
  }

  private memoize(entries: Array<{ key: string; proof: NodeProof }>): DashboardReadOutcome<void> {
    const uniqueEntries = [...new Map(entries.map((entry) => [entry.key, entry])).values()]
    if (uniqueEntries.length === 0) return { status: 'ok', value: undefined }
    if (this.memo.size + uniqueEntries.filter((entry) => !this.memo.has(entry.key)).length > MAX_MEMO_ENTRIES) {
      this.discardMemo()
      this.memoProofStateLost = true
      return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
    }
    const additional = uniqueEntries.filter((entry) => !this.memo.has(entry.key)).length
    const requiredBlocks = Math.ceil((this.memo.size + additional) / ACCOUNTING_BLOCK)
    const memoStart = this.memoReservations.length
    while (this.memoReservations.length < requiredBlocks) {
      const reserveStatus = this.personaReserveStatus({ sqlStatements: 0, rowsVisited: 0, materializedBytes: ACCOUNTING_BLOCK * MEMO_ENTRY_BYTES, keyBytes: 0 })
      if (!reserveStatus.ok) {
        while (this.memoReservations.length > memoStart) {
          const token = this.memoReservations.pop()!
          try { this.manager.releaseResident(this.callToken, token) } catch { /* retain original failure */ }
        }
        return this.failure('budget-exhausted', reserveStatus.reason)
      }
      const reserved = this.manager.reserveResident(this.callToken, 'cache', ACCOUNTING_BLOCK * MEMO_ENTRY_BYTES)
      if (reserved.status !== 'ok') {
        this.discardMemo()
        this.memoProofStateLost = true
        if (reserved.status !== 'budget-exhausted') this.finishOnFailure()
        return reserved.status === 'budget-exhausted'
          ? this.failure('budget-exhausted', 'visibility-proof-cache-lost') : reserved
      }
      this.memoReservations.push(reserved.value.reservationToken)
    }
    for (const entry of uniqueEntries) this.memo.set(entry.key, entry.proof)
    return { status: 'ok', value: undefined }
  }

  private validateBeforeRelease(items: DashboardVisibilityItem[]): DashboardReadOutcome<DashboardVisibilityItem[]> {
    if (this.memoProofStateLost) {
      this.finishOnFailure()
      return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
    }
    if (this.aggregateIntermediateReadDepth === 0) {
      const versions = this.probeAllScopes()
      if (versions.status !== 'ok') {
        if (!(versions.status === 'budget-exhausted' && versions.reason === 'persona-call-headroom')) this.finishOnFailure()
        return versions
      }
    }
    const now = this.readWallNow()
    if (now === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    const staleMemo = [...this.memo.values()].some((proof) => proof.state === 'visible' &&
      proof.expiryAt !== undefined && proof.expiryAt !== null && proof.expiryAt <= now)
    if (staleMemo) {
      this.discardMemo()
      for (const item of items) if (item.state === 'visible') {
        item.state = 'unresolved'
        item.reason = 'visibility-proof-expired-during-read'
        delete item.record
        delete item.summary
      }
      this.finishOnFailure()
    } else {
      for (const item of items) {
        if (item.state !== 'visible') continue
        const record = item.record
        if (record !== undefined && 'expiryAt' in record && typeof record.expiryAt === 'number' && record.expiryAt <= now) {
          item.state = 'hidden'
          item.reason = 'memory-expired-during-read'
          delete item.record
          delete item.summary
        }
      }
      for (const item of items) {
        if (item.state !== 'visible') continue
        const summary = item.summary
        if (summary !== undefined && typeof summary.expiryAt === 'number' && summary.expiryAt <= now) {
          item.state = 'hidden'
          item.reason = 'memory-expired-during-read'
          delete item.summary
        }
      }
    }
    return { status: 'ok', value: items }
  }

  private validateSnapshotBoundary(forceAllScopes = false): DashboardReadOutcome<void> {
    if (this.memoProofStateLost) {
      this.finishOnFailure()
      return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
    }
    if (this.aggregateIntermediateReadDepth === 0 || forceAllScopes &&
        ((this.directOriginSchemaScopes?.size ?? 0) > 0 || this.overviewFusion !== undefined)) {
      const versions = this.probeAllScopes()
      if (versions.status !== 'ok') {
        if (!(versions.status === 'budget-exhausted' && versions.reason === 'persona-call-headroom')) this.finishOnFailure()
        return versions
      }
    }
    const now = this.readWallNow()
    if (now === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    if (this.memoHasExpired(now)) {
      this.finishOnFailure()
      return this.failure('stale', 'visibility-proof-expired-at-rpc-boundary')
    }
    return { status: 'ok', value: undefined }
  }

  private memoHasExpired(now: number): boolean {
    return this.provenExpiryAt !== undefined && this.provenExpiryAt <= now || [...this.memo.values()].some((proof) => proof.state === 'visible' &&
      proof.expiryAt !== undefined && proof.expiryAt !== null && proof.expiryAt <= now)
  }

  private validManagedMemoryProjection(id: string, row: DashboardManagedMemoryView, status: string):
    row is ValidatedManagedMemoryView {
    const bytesMatch = (value: string | undefined, bytes: number, maximum: number, nullable = false): boolean =>
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maximum &&
      (value === undefined ? bytes === 0 || nullable && bytes === 0 : Buffer.byteLength(value, 'utf8') === bytes)
    return row.id === id && row.idBytes === Buffer.byteLength(id, 'utf8') && row.status === status &&
      Number.isSafeInteger(row.contentBytes) && row.contentBytes > 0 && row.contentBytes <= MAX_ROW_BYTES &&
      (row.content === undefined || Buffer.byteLength(row.content, 'utf8') === row.contentBytes) &&
      bytesMatch(row.kind, row.kindBytes, 256) && row.kind !== undefined &&
      bytesMatch(row.scene ?? undefined, row.sceneBytes, 512, true) &&
      bytesMatch(row.source, row.sourceBytes, 512) && row.source !== undefined &&
      bytesMatch(row.sourceMessageIds, row.sourceMessageIdsBytes, MAX_ROW_BYTES) && row.sourceMessageIds !== undefined &&
      Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1 &&
      safeInteger(row.createdAt) && safeInteger(row.updatedAt) && safeInteger(row.revision) && row.revision >= 1 &&
      safeInteger(row.recordedAt) && optionalInteger(row.approvedAt) && optionalInteger(row.forgottenAt) &&
      optionalInteger(row.validFrom) && optionalInteger(row.validFromUpper) && optionalInteger(row.validTo) &&
      optionalInteger(row.supersededAt) && optionalInteger(row.expiryAt) && row.sourceVerified >= 0 && row.sourceVerified <= 1 &&
      !row.validFromStateInvalid && isValidFromState(row.validFromState) &&
      !row.validFromPrecisionInvalid && isValidFromPrecision(row.validFromPrecision) &&
      Number.isSafeInteger(row.validFromPrecisionBytes) && row.validFromPrecisionBytes <= 32 &&
      Buffer.byteLength(row.validFromPrecision ?? '', 'utf8') === row.validFromPrecisionBytes &&
      !row.validFromBasisInvalid && isValidFromBasis(row.validFromBasis) &&
      Number.isSafeInteger(row.validFromBasisBytes) && row.validFromBasisBytes <= 32 &&
      Buffer.byteLength(row.validFromBasis ?? '', 'utf8') === row.validFromBasisBytes &&
      Number.isSafeInteger(row.validFromLabelBytes) && row.validFromLabelBytes <= 512 &&
      (row.validFromLabel === null || row.validFromLabel === undefined
        ? row.validFromLabelBytes === 0 : Buffer.byteLength(row.validFromLabel, 'utf8') === row.validFromLabelBytes)
  }

  private parseManagedSourceIds(row: DashboardManagedMemoryView): string[] | undefined {
    if (row.sourceMessageIds === undefined || row.sourceMessageIdsBytes > MAX_ROW_BYTES ||
        Buffer.byteLength(row.sourceMessageIds, 'utf8') !== row.sourceMessageIdsBytes) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(row.sourceMessageIds) as unknown } catch { return undefined }
    if (!Array.isArray(parsed) || parsed.length > MAX_SOURCE_IDS ||
        parsed.some((id) => typeof id !== 'string' || !this.validId(id))) return undefined
    return [...new Set(parsed as string[])]
  }

  private visibleSummary(row: ValidatedManagedMemoryView, status: 'candidate' | 'approved' | 'forgotten',
    sourceMessageIds: string[]): DashboardVisibleMemorySummary {
    return {
      id: row.id!, kind: row.kind!, ...(row.scene == null ? {} : { scene: row.scene }),
      confidence: row.confidence, status, source: row.source!, sourceMessageIds: [...sourceMessageIds],
      contentBytes: row.contentBytes, createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(row.approvedAt == null ? {} : { approvedAt: row.approvedAt }),
      ...(row.forgottenAt == null ? {} : { forgottenAt: row.forgottenAt }),
      revision: row.revision, ...(row.validFrom == null ? {} : { validFrom: row.validFrom }),
      validFromState: row.validFromState,
      validFromPrecision: row.validFromPrecision, validFromBasis: row.validFromBasis,
      ...(row.validFromUpper == null ? {} : { validFromUpper: row.validFromUpper }),
      ...(row.validFromLabel == null ? {} : { validFromLabel: row.validFromLabel }),
      ...(row.validTo == null ? {} : { validTo: row.validTo }), recordedAt: row.recordedAt,
      ...(row.supersededAt == null ? {} : { supersededAt: row.supersededAt }),
      sourceVerified: row.sourceVerified === 1,
      ...(typeof row.expiryAt === 'number' ? { expiryAt: row.expiryAt } : {}),
    }
  }

  private probeAllScopes(): DashboardReadOutcome<void> {
    const baseProbeWork = 2 * (1 + this.projectKeys.length)
    const originScopeCount = this.directOriginSchemaScopes?.size ?? 0
    const fusionFence = Number(this.overviewFusion !== undefined)
    const probeCost = {
      sqlStatements: baseProbeWork + originScopeCount + fusionFence,
      rowsVisited: baseProbeWork + originScopeCount + fusionFence,
      materializedBytes: 256 * (originScopeCount + fusionFence),
      keyBytes: 0,
    }
    const reserve = this.personaReserveCost(originScopeCount)
    const remaining = this.remainingReadWorkBreakdown()
    if (remaining === undefined) return this.failure('stale', 'visibility-session-not-active')
    const fits = (available: DashboardReadCost): boolean =>
      probeCost.sqlStatements + reserve.sqlStatements <= available.sqlStatements &&
      probeCost.rowsVisited + reserve.rowsVisited <= available.rowsVisited &&
      probeCost.materializedBytes + reserve.materializedBytes <= available.materializedBytes &&
      probeCost.keyBytes + reserve.keyBytes <= available.keyBytes
    if (!fits(remaining.session)) return this.failure('budget-exhausted', 'persona-session-headroom')
    if (!fits(remaining.call)) return this.failure('budget-exhausted', 'persona-call-headroom')
    const control = this.manager.probeControl(this.callToken, this.control)
    if (control.status !== 'ok') return control
    for (const projectKey of this.projectKeys) {
      const store = this.stores.get(projectKey)
      if (store === undefined) return this.failure('unavailable-probe', 'visibility-project-store-missing')
      const prior = this.overviewFusion?.scopes.get(store)
      const observed: { value?: ReturnType<MemoryStore['dashboardOverviewReadVersion']> } = {}
      const source = prior === undefined ? store : { dashboardReadVersion: () => {
        observed.value = store.dashboardOverviewReadVersion()
        return observed.value.stamp
      } }
      const result = this.manager.probeProject(this.callToken, projectKey, source)
      if (result.status !== 'ok') return result
      if (prior !== undefined) {
        if (observed.value === undefined || observed.value.stamp.connectionId !== prior.connectionId ||
            observed.value.schemaVersion !== prior.schemaVersion) {
          this.finishOnFailure()
          return this.failure('stale', 'overview-schema-changed')
        }
      }
    }
    if (this.overviewFusion !== undefined) {
      const schema = this.readOverviewControlSchema()
      if (schema.status !== 'ok') return schema
      if (schema.value !== this.overviewFusion.controlSchema || this.overviewFusion.binding !== this.binding ||
          [...this.overviewFusion.scopes.keys()].some((store) => ![...this.stores.values()].includes(store))) {
        this.finishOnFailure()
        return this.failure('stale', 'overview-schema-changed')
      }
    }
    if (this.directOriginSchemaScopes === undefined) return { status: 'ok', value: undefined }
    for (const [projectKey, scope] of this.directOriginSchemaScopes) {
      const store = this.stores.get(projectKey)
      if (store === undefined || store !== scope.store || scope.binding !== this.binding ||
          scope.projectKeyBytes !== Buffer.byteLength(projectKey, 'utf8') ||
          !safeInteger(scope.schemaVersion) || scope.schemaVersion < 0) {
        this.finishOnFailure()
        return this.failure('stale', 'direct-origin-schema-scope-changed')
      }
      const fenced = this.runUncached(store, DIRECT_ORIGIN_SCHEMA_FENCE_COST,
        () => store.dashboardVisibilitySchemaVersion())
      if (fenced.status !== 'ok') return fenced
      if (fenced.value !== scope.schemaVersion) {
        this.finishOnFailure()
        return this.failure('stale', 'direct-origin-schema-changed')
      }
    }
    return { status: 'ok', value: undefined }
  }

  private ensureLive(): DashboardReadOutcome<void> {
    if (this.ended) return this.failure('stale', 'visibility-session-ended')
    if (this.paused) return this.failure('stale', 'visibility-session-suspended')
    const counters = this.manager.counters(this.callToken)
    if (counters.status !== 'ok') {
      this.finishOnFailure()
      return counters
    }
    if (this.readWallNow() === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    return { status: 'ok', value: undefined }
  }

  private managedProofContextKey(operation: string, ...identity: unknown[]): string {
    return JSON.stringify(['managed-proof-continuation', this.binding, operation, ...identity])
  }

  /** Retain one bounded proof across call-local headroom only. */
  private withManagedProofContext<T>(key: string, operation: () => DashboardReadOutcome<T>,
    admissionCost?: DashboardReadCost): DashboardReadOutcome<T> {
    if (this.activeManagedPageItem !== undefined) return operation()
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    let progress = this.managedProofContinuations.get(key)
    if (progress === undefined) {
      if (this.managedProofContinuations.size + this.managedPageContinuations.size >= MAX_MANAGED_PAGE_CONTINUATIONS) {
        return this.failure('budget-exhausted', 'managed-page-continuation-capacity')
      }
      const itemBytes = MANAGED_PROOF_CONTEXT_BYTES + Buffer.byteLength(key, 'utf8')
      if (admissionCost !== undefined) {
        const admission = this.personaReserveStatus({ ...admissionCost,
          materializedBytes: admissionCost.materializedBytes + itemBytes })
        if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
      }
      const item = this.reserveManagedPageCache(itemBytes)
      if (item.status !== 'ok') return item
      progress = { key, itemReservation: item.value, bytes: 0, stageBytes: 0,
        steps: new Map(), resources: new Map(), stages: new Map() }
    }
    const previous = this.activeManagedPageItem
    this.activeManagedPageItem = progress
    let result: DashboardReadOutcome<T>
    try { result = operation() }
    catch {
      this.finishOnFailure()
      result = this.failure('unavailable-probe', 'managed-proof-operation-failed')
    } finally { this.activeManagedPageItem = previous }
    if (this.ended) return result
    if (result.status === 'budget-exhausted' && result.reason === 'persona-call-headroom') {
      this.managedProofContinuations.set(key, progress)
      return result
    }
    this.managedProofContinuations.delete(key)
    this.releaseManagedPageItemProgress(progress)
    return result
  }

  private classifyResidentFailure<T>(kind: 'cache' | 'key', bytes: number,
    result: DashboardReadOutcome<{ reservationToken: string }>): DashboardReadOutcome<{ reservationToken: string }> {
    if (result.status !== 'budget-exhausted' || result.reason !== 'resident-capacity-or-work') return result
    const remaining = this.remainingReadWorkBreakdown()
    if (remaining === undefined) return result
    const dimension = kind === 'cache' ? 'materializedBytes' : 'keyBytes'
    if (remaining.call[dimension] < bytes) return this.failure('budget-exhausted', 'work-limit')
    if (remaining.session[dimension] < bytes) return this.failure('budget-exhausted', 'session-work-limit')
    return this.failure('budget-exhausted', 'resident-capacity')
  }

  /** Same tail cost used by the reader and its trusted overview scheduler. */
  finalBoundaryCost(): DashboardReadCost { return this.personaReserveCost(this.directOriginSchemaScopes?.size ?? 0, 1) }

  private readOverviewControlSchema(): DashboardReadOutcome<number> {
    return this.runUncached(this.control, { sqlStatements: 1, rowsVisited: 1, materializedBytes: 256, keyBytes: 0 },
      () => this.control.dashboardReadSchemaVersion())
  }

  private sharedOverviewRead<T>(source: MemoryStore | ControlLedger, cost: DashboardReadCost,
    operation: () => T, operationKey: string): DashboardReadOutcome<T> | undefined {
    if (Buffer.byteLength(operationKey, 'utf8') > 8192) return undefined
    const bytes = Math.max(256, cost.materializedBytes) + 512
    const keyBytes = Buffer.byteLength(operationKey, 'utf8')
    let fusion = this.overviewFusion
    if (fusion === undefined) {
      // Include the initial schema read and its added future final fence before
      // allocating the shared scope. Executed work still uses the real manager.
      const addedSchemaReads = 1 + (this.personaReserve?.rounds ?? 0)
      const admission = this.personaReserveStatus({ ...cost, sqlStatements: cost.sqlStatements + addedSchemaReads,
        rowsVisited: cost.rowsVisited + addedSchemaReads,
        materializedBytes: bytes + 1024 + 256 * addedSchemaReads, keyBytes: cost.keyBytes + keyBytes })
      if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
      const scope = this.reserveReadState(1024)
      if (scope.status !== 'ok') return scope
      fusion = { binding: this.binding, controlSchema: -1, bytes: 1024, scopes: new Map(), entries: new Map() }
      this.overviewFusion = fusion
      const schema = this.readOverviewControlSchema()
      if (schema.status !== 'ok') {
        this.overviewFusion = undefined
        this.releaseReadState(scope.value.reservationToken)
        return schema
      }
      fusion.controlSchema = schema.value
    }
    if (fusion.binding !== this.binding) {
      this.finishOnFailure()
      return this.failure('stale', 'overview-binding-changed')
    }
    if (source !== this.control) {
      const store = source as MemoryStore
      if (![...this.stores.values()].includes(store)) {
        this.finishOnFailure()
        return this.failure('stale', 'overview-store-changed')
      }
      const projectKey = [...this.stores].find(([, member]) => member === store)?.[0]
      if (!fusion.scopes.has(store) && operationKey !== JSON.stringify(['overview-heads', projectKey])) {
        this.finishOnFailure()
        return this.failure('stale', 'overview-schema-scope-missing')
      }
    }
    const signature = JSON.stringify(cost)
    const cached = fusion.entries.get(operationKey)
    if (cached !== undefined) {
      if (cached.source !== source || cached.signature !== signature) {
        this.finishOnFailure()
        return this.failure('stale', 'overview-projection-changed')
      }
      if (this.readWallNow() === undefined) {
        this.finishOnFailure()
        return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
      }
      return { status: 'ok', value: cached.value as T }
    }
    // A full bounded cache falls back to the original charged proof context;
    // it neither evicts evidence still referenced by a task nor grants budget.
    if (fusion.entries.size >= OVERVIEW_FUSION_ENTRIES || fusion.bytes + bytes > OVERVIEW_FUSION_BYTES) return undefined
    const admission = this.personaReserveStatus({ ...cost, materializedBytes: bytes, keyBytes: cost.keyBytes + keyBytes })
    if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
    const retained = this.reserveReadState(bytes)
    if (retained.status !== 'ok') return retained
    const key = this.reserveReadKeys(keyBytes)
    if (key.status !== 'ok') { this.releaseReadState(retained.value.reservationToken); return key }
    const result = this.runUncached(source, { ...cost, materializedBytes: 0 }, operation)
    if (result.status !== 'ok') {
      this.releaseReadState(key.value.reservationToken)
      this.releaseReadState(retained.value.reservationToken)
      return result
    }
    // Payload + fixed entry metadata and semantic keys have separate leases.
    // The reader owns them until its manager ends/cancels this exact session.
    fusion.entries.set(operationKey, { source, signature, value: result.value })
    fusion.bytes += bytes
    return result
  }

  private run<T>(source: MemoryStore | ControlLedger, cost: DashboardReadCost, operation: () => T,
    operationKey?: string): DashboardReadOutcome<T> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    if (this.overviewFusionDepth > 0 && operationKey !== undefined &&
        /^\["(?:overview-heads|overview-node|memory-meta|revision-page|relation-page|json-read|revision-body|managed-memory|source-identity-batch|visibility-fences)"[,\]]/u.test(operationKey)) {
      const shared = this.sharedOverviewRead(source, cost, operation, operationKey)
      if (shared !== undefined) return shared
    }
    const progress = this.activeManagedPageItem
    if (progress !== undefined) {
      if (operationKey === undefined) return this.failure('stale', 'managed-page-operation-identity-missing')
      // The lookup identity is the caller's semantic operation key (project,
      // operation, parameters, revision). The cost shape is only a defensive
      // check that a replayed key cannot silently change the SQL it names.
      const signature = JSON.stringify([source === this.control ? 'control' : 'project', operationKey, cost])
      const cached = progress.steps.get(operationKey)
      if (cached !== undefined) {
        if (cached.signature !== signature) return this.failure('stale', 'managed-page-step-shape-changed')
        if (this.readWallNow() === undefined) {
          this.finishOnFailure()
          return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
        }
        return { status: 'ok', value: cached.value as T }
      }
      const cacheBytes = Math.max(256, cost.materializedBytes)
      if (progress.bytes + cacheBytes > MAX_MANAGED_ITEM_STEP_CACHE_BYTES) {
        return this.failure('budget-exhausted', 'managed-page-progress-capacity')
      }
      // The resident lease is also the single materialized-work charge for the
      // retained query result. Charging the same projection again in run()
      // would count one database result twice in both call and session work.
      const uncachedCost = { ...cost, materializedBytes: 0 }
      const admission = this.personaReserveStatus({ ...uncachedCost, materializedBytes: cacheBytes })
      if (!admission.ok) return this.failure('budget-exhausted', admission.reason)
      const cacheReservation = this.reserveManagedPageCache(cacheBytes)
      if (cacheReservation.status !== 'ok') return cacheReservation
      const result = this.runUncached(source, uncachedCost, operation)
      if (result.status !== 'ok') {
        this.releaseReservations([cacheReservation.value])
        return result
      }
      progress.steps.set(operationKey, { signature, value: result.value, reservation: cacheReservation.value, bytes: cacheBytes })
      this.managedPageLeaseTokens.add(cacheReservation.value)
      progress.bytes += cacheBytes
      return result
    }
    return this.runUncached(source, cost, operation)
  }

  private runUncached<T>(source: MemoryStore | ControlLedger, cost: DashboardReadCost,
    operation: () => T): DashboardReadOutcome<T> {
    if (this.ended || this.paused) return this.failure('stale', 'visibility-session-not-active')
    const reserveStatus = this.personaReserveStatus(cost)
    if (!reserveStatus.ok) return this.failure('budget-exhausted', reserveStatus.reason)
    let result: DashboardReadOutcome<T>
    try { result = this.manager.run(this.callToken, cost, operation) }
    catch {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-read-helper-failed')
    }
    if (result.status !== 'ok') {
      if (result.status !== 'budget-exhausted') this.finishOnFailure()
      return result
    }
    // S1 revalidates token/call lifecycle after each callback. Database stamps
    // are checked at open, continuation start, and final release; repeating
    // every full scope probe after each helper would spend the call budget on
    // duplicate SQL and leave too little for the bounded page itself.
    if (this.readWallNow() === undefined) {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-wall-clock-invalid')
    }
    void source
    return result
  }

  private reserveTemporary(bytes: number, resourceKey?: string): DashboardReadOutcome<string> {
    const progress = this.activeManagedPageItem
    if (progress !== undefined) {
      if (resourceKey === undefined) return this.failure('stale', 'managed-page-resource-identity-missing')
      const cached = progress.resources.get(resourceKey)
      if (cached !== undefined) {
        return cached.bytes === bytes ? { status: 'ok', value: cached.reservation }
          : this.failure('stale', 'managed-page-resource-shape-changed')
      }
      if (progress.bytes + bytes > MAX_MANAGED_ITEM_STEP_CACHE_BYTES) {
        return this.failure('budget-exhausted', 'managed-page-progress-capacity')
      }
    }
    const reserveStatus = this.personaReserveStatus({ sqlStatements: 0, rowsVisited: 0, materializedBytes: bytes, keyBytes: 0 })
    if (!reserveStatus.ok) return this.failure('budget-exhausted', reserveStatus.reason)
    try {
      const reserved = this.manager.reserveResident(this.callToken, 'cache', bytes)
      if (reserved.status !== 'ok' && reserved.status !== 'budget-exhausted') this.finishOnFailure()
      if (reserved.status !== 'ok') return reserved
      if (progress !== undefined) {
        progress.resources.set(resourceKey!, { reservation: reserved.value.reservationToken, bytes })
        progress.bytes += bytes
        this.managedPageLeaseTokens.add(reserved.value.reservationToken)
      }
      return { status: 'ok', value: reserved.value.reservationToken }
    } catch {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'visibility-reservation-failed')
    }
  }

  private trackTemporaryReservation(token: string, reservations: string[]): void {
    if (this.activeManagedPageItem === undefined) reservations.push(token)
  }

  private managedPageStage<T>(key: string, signature: string): DashboardReadOutcome<{ found: boolean; value?: T }> {
    const progress = this.activeManagedPageItem
    if (progress === undefined) return { status: 'ok', value: { found: false } }
    const stage = progress.stages.get(key)
    if (stage === undefined) return { status: 'ok', value: { found: false } }
    if (stage.signature !== signature) return this.failure('stale', 'managed-page-stage-shape-changed')
    return { status: 'ok', value: { found: true, value: stage.value as T } }
  }

  /**
   * Retain one parsed JSON stage inside the item's bounded stage map. The
   * caller has already reserved the matching raw JSON lease; the separate
   * stage budget bounds the parsed values (entry count and bytes) so a long
   * resume chain cannot grow the map without limit. Re-retaining the same
   * semantic key replaces its previous accounting instead of adding a new
   * entry, matching the idempotent lease reuse in `reserveTemporary`.
   */
  private retainManagedPageStage(key: string, signature: string, value: unknown,
    bytes: number): DashboardReadOutcome<void> {
    const progress = this.activeManagedPageItem
    if (progress === undefined) return { status: 'ok', value: undefined }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return this.failure('budget-exhausted', 'managed-page-stage-capacity')
    }
    const previous = progress.stages.get(key)
    const nextBytes = progress.stageBytes - (previous === undefined ? 0 : previous.bytes) + bytes
    if (!Number.isSafeInteger(nextBytes) || nextBytes > MAX_MANAGED_ITEM_STAGE_BYTES) {
      return this.failure('budget-exhausted', 'managed-page-stage-capacity')
    }
    progress.stages.set(key, { signature, value, bytes })
    progress.stageBytes = nextBytes
    return { status: 'ok', value: undefined }
  }

  private clearManagedPageStages(progress: ManagedPageItemProgress): void {
    progress.stages.clear()
    progress.stageBytes = 0
  }

  private readWallNow(): number | undefined {
    let now: number
    try { now = this.wallNow() } catch { return undefined }
    if (!Number.isSafeInteger(now) || now < 0 || this.lastWallNow !== undefined && now < this.lastWallNow) return undefined
    this.lastWallNow = now
    return now
  }

  private isBoundProject(projectKey: string): boolean { return this.projectKeys.includes(projectKey) }

  private validId(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && !id.includes('\0') && Buffer.byteLength(id, 'utf8') <= MAX_ID_BYTES
  }

  private validSourceEventId(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && !id.includes('\0') && Buffer.byteLength(id, 'utf8') <= MAX_SOURCE_EVENT_BYTES
  }

  private managedPageContinuationKey(projectKey: string, status: 'candidate' | 'approved' | 'forgotten',
    after: DashboardVisibilityMemoryCursor | undefined, contentLimit: number | null, taskKey: string): string {
    return JSON.stringify([this.binding, projectKey, status, after?.createdAt ?? null, after?.id ?? null, contentLimit, taskKey])
  }

  /** Grow a retained output lease only from already validated byte lengths.
   * The old work charge is never refunded; both lease overheads are real at replacement. */
  private reserveManagedItemOutput(sourceJsonBytes: number, bodyBytes: number): DashboardReadOutcome<void> {
    const progress = this.activeManagedPageItem
    const output = progress?.incrementalOutput
    if (progress === undefined || output === undefined) return { status: 'ok', value: undefined }
    if (!safeInteger(sourceJsonBytes) || sourceJsonBytes > MAX_ROW_BYTES ||
        !safeInteger(bodyBytes) || bodyBytes > MAX_ROW_BYTES) {
      return this.failure('unavailable-probe', 'managed-output-bound-invalid')
    }
    // A retained nonempty string ID needs at least four JSON bytes including
    // its separator/brackets. Account for array/string slots as well as text.
    const sourceSlots = Math.min(MAX_SOURCE_IDS, Math.max(0, Math.floor((sourceJsonBytes - 1) / 4)))
    const needed = output.baseBytes + 8 * PAGE_ROW_BYTES + MAX_ID_BYTES +
      2 * sourceJsonBytes + 32 * sourceSlots + bodyBytes
    if (needed <= output.reservedBytes) return { status: 'ok', value: undefined }
    const reserved = this.reserveManagedPageCache(needed)
    if (reserved.status !== 'ok') return reserved
    const released = this.releaseReadState(progress.itemReservation)
    if (released.status !== 'ok') {
      this.releaseReadState(reserved.value)
      return released
    }
    progress.itemReservation = reserved.value
    output.reservedBytes = needed
    return { status: 'ok', value: undefined }
  }

  private managedPageItemCacheBytes(contentLimit: number | null): number {
    return 2 * MAX_SOURCE_IDS * MAX_ID_BYTES + 8 * PAGE_ROW_BYTES + MAX_ID_BYTES + (contentLimit ?? 0)
  }

  private reserveManagedPageCache(bytes: number): DashboardReadOutcome<string> {
    const admitted = this.personaReserveStatus({ sqlStatements: 0, rowsVisited: 0, materializedBytes: bytes, keyBytes: 0 })
    if (!admitted.ok) return this.failure('budget-exhausted', admitted.reason)
    let reserved: DashboardReadOutcome<{ reservationToken: string }>
    try { reserved = this.manager.reserveResident(this.callToken, 'cache', bytes) }
    catch {
      this.finishOnFailure()
      return this.failure('unavailable-probe', 'managed-page-cache-reservation-failed')
    }
    if (reserved.status === 'ok') return { status: 'ok', value: reserved.value.reservationToken }
    if (reserved.status === 'budget-exhausted') {
      this.finishOnFailure()
      return this.failure('budget-exhausted', 'visibility-proof-cache-lost')
    }
    this.finishOnFailure()
    return reserved
  }

  private releaseManagedPageItemSteps(progress: ManagedPageItemProgress): void {
    if (this.ended) {
      progress.steps.clear()
      progress.bytes = 0
      progress.resources.clear()
      this.clearManagedPageStages(progress)
      progress.approvedProof = undefined
      return
    }
    const steps = [...progress.steps.values()]
    const bytes = steps.reduce((sum, step) => sum + step.bytes, 0)
    for (const step of steps) this.managedPageLeaseTokens.delete(step.reservation)
    this.releaseReservations(steps.map((step) => step.reservation))
    progress.steps.clear()
    progress.bytes = Math.max(0, progress.bytes - bytes)
  }

  private releaseManagedPageItemResources(progress: ManagedPageItemProgress): void {
    if (this.ended) {
      progress.resources.clear()
      this.clearManagedPageStages(progress)
      progress.approvedProof = undefined
      progress.bytes = 0
      return
    }
    const resources = [...progress.resources.values()]
    const bytes = resources.reduce((sum, resource) => sum + resource.bytes, 0)
    for (const resource of resources) this.managedPageLeaseTokens.delete(resource.reservation)
    this.releaseReservations(resources.map((resource) => resource.reservation))
    progress.resources.clear()
    this.clearManagedPageStages(progress)
    progress.approvedProof = undefined
    progress.bytes = Math.max(0, progress.bytes - bytes)
  }

  private releaseManagedPageItemProgress(progress: ManagedPageItemProgress): void {
    this.releaseManagedPageItemSteps(progress)
    this.releaseManagedPageItemResources(progress)
    if (!this.ended) this.releaseReservations([progress.itemReservation])
  }

  private releaseManagedPageContinuation(key?: string): void {
    const continuations = key === undefined
      ? [...this.managedPageContinuations.values()]
      : [this.managedPageContinuations.get(key)].filter((item): item is ManagedPageContinuation => item !== undefined)
    for (const continuation of continuations) {
      this.managedPageContinuations.delete(continuation.key)
      if (continuation.pendingItem !== undefined) this.releaseManagedPageItemProgress(continuation.pendingItem)
      this.releaseReservations(continuation.itemReservations)
      this.releaseReservations(continuation.reservations)
    }
  }

  private releaseManagedProofContinuations(): void {
    const continuations = [...this.managedProofContinuations.values()]
    this.managedProofContinuations.clear()
    for (const progress of continuations) this.releaseManagedPageItemProgress(progress)
  }

  private keyBytes(...keys: Array<string | undefined>): number {
    return keys.reduce((sum, key) => sum + (key === undefined ? 0 : Buffer.byteLength(key, 'utf8')), 0)
  }

  private failure<T>(status: DashboardReadFailureStatus, reason: string): DashboardReadOutcome<T> {
    return { status, reason }
  }

  private end(status: DashboardReadFailureStatus = 'stale', reason = 'visibility-session-ended'): void {
    if (this.ended) return
    this.ended = true
    this.releaseGlobalHandles()
    this.overviewFusion = undefined
    this.managedPageContinuations.clear()
    this.managedProofContinuations.clear()
    this.managedPageLeaseTokens.clear()
    this.directOriginSchemaScopes?.clear()
    this.directOriginSchemaScopes = undefined
    this.activeManagedPageItem = undefined
    this.disposeDirectoryLabelReader()
    this.memo.clear()
    this.memoReservations.length = 0
    this.derivedProof = undefined; this.provenExpiryAt = undefined
    try { this.onEnd?.(status, reason) } catch { /* best-effort listener cleanup */ }
  }

  /** Manager already discarded all leases before notifying this callback. */
  private managerEnded(status: DashboardReadFailureStatus = 'stale', reason = 'visibility-session-ended'): void {
    if (this.ended) return
    this.ended = true
    this.releaseGlobalHandles()
    this.overviewFusion = undefined
    this.paused = false
    this.continuationToken = undefined
    this.managedPageContinuations.clear()
    this.managedProofContinuations.clear()
    this.managedPageLeaseTokens.clear()
    this.directOriginSchemaScopes?.clear()
    this.directOriginSchemaScopes = undefined
    this.activeManagedPageItem = undefined
    this.disposeDirectoryLabelReader()
    this.memo.clear()
    this.memoReservations.length = 0
    this.derivedProof = undefined; this.provenExpiryAt = undefined
    try { this.onEnd?.(status, reason) } catch { /* best-effort listener cleanup */ }
  }

  private releaseMemoReservations(): void {
    for (const token of this.memoReservations) this.manager.releaseResident(this.callToken, token)
    this.memoReservations.length = 0
    this.memo.clear()
  }

  private releaseReservations(tokens: string[]): void {
    for (const token of tokens) {
      if (!this.managedPageLeaseTokens.has(token)) this.manager.releaseResident(this.callToken, token)
    }
    tokens.length = 0
  }

  private discardMemo(): void { this.releaseMemoReservations() }

  private finishOnFailure(): void {
    if (this.ended) return
    if (this.paused && this.continuationToken !== undefined) {
      this.manager.cancelContinuation(this.continuationToken)
      this.managerEnded()
      return
    }
    this.releaseManagedPageContinuation()
    this.releaseManagedProofContinuations()
    this.discardMemo()
    this.manager.cancel(this.callToken)
    this.end()
  }

  private memoKey(projectKey: string, id: string): string { return projectKey + '\0' + id }
}

export function withDashboardOverviewFusion<T>(reader: DashboardVisibilityReadSession, operation: () => T): T {
  const capability = reader as unknown as { [aggregateOverviewWork]?: (operation: () => T) => T }
  return typeof capability[aggregateOverviewWork] === 'function' ? capability[aggregateOverviewWork]!(operation) : operation()
}

/** Aggregate-only managed pages stay private until the enclosing RPC final proof. */
export function readDashboardManagedPageForAggregate(reader: DashboardVisibilityReadSession,
  projectKey: string, status: 'candidate' | 'approved' | 'forgotten', after: DashboardVisibilityMemoryCursor | undefined,
  limit: number, contentLimit: number | null, taskKey: string): DashboardReadOutcome<DashboardVisibilityPage> {
  const capability = reader as unknown as { [aggregateManagedPage](projectKey: string,
    status: 'candidate' | 'approved' | 'forgotten', after?: DashboardVisibilityMemoryCursor, limit?: number,
    contentLimit?: number | null, taskKey?: string): DashboardReadOutcome<DashboardVisibilityPage> }
  if (typeof capability[aggregateManagedPage] !== 'function') {
    // Lightweight aggregate fixtures keep exercising the public contract; a
    // real reader always carries the private aggregate capability.
    return reader.readManagedPage(projectKey, status, after, limit, contentLimit, taskKey)
  }
  return capability[aggregateManagedPage](projectKey, status, after, limit, contentLimit, taskKey)
}

/** Aggregate-only recent pages defer repeated scope probes to the enclosing RPC boundary. */
export function readDashboardRecentManagedPageForAggregate(reader: DashboardVisibilityReadSession,
  projectKey: string, after: { updatedAt: number; id: string } | undefined, limit: number,
  contentLimit: number): DashboardReadOutcome<{ items: DashboardVisibilityItem[];
    nextCursor?: { updatedAt: number; id: string }; hasMore: boolean }> {
  const capability = reader as unknown as { [aggregateRecentManagedPage](projectKey: string,
    after: { updatedAt: number; id: string } | undefined, limit?: number, contentLimit?: number):
      DashboardReadOutcome<{ items: DashboardVisibilityItem[]; nextCursor?: { updatedAt: number; id: string }; hasMore: boolean }> }
  if (typeof capability[aggregateRecentManagedPage] !== 'function') {
    // Lightweight aggregate fixtures keep exercising the public contract; a
    // real reader always carries the private aggregate capability.
    return reader.readRecentManagedPage(projectKey, after, limit, contentLimit)
  }
  return capability[aggregateRecentManagedPage](projectKey, after, limit, contentLimit)
}
