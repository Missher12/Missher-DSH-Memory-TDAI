/**
 * Internal bounded state for future dashboard reads. It owns no database
 * connections, timers, query results, credentials, or message bodies.
 */
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export type DashboardReadFailureStatus = 'stale' | 'expired' | 'evicted' | 'budget-exhausted' | 'unavailable-probe'

export type DashboardReadOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: DashboardReadFailureStatus; reason: string }

export interface DashboardReadVersionStamp {
  readonly scope: 'project' | 'control'
  /** Unique for the lifetime of the actual SQLite connection. */
  readonly connectionId: string
  /** Comparable only to a later data_version from this same live connection. */
  readonly dataVersion: number
  /** Connection-local row-change count, never a cross-connection revision. */
  readonly totalChanges: number
  /** Present only for control-ledger probes. */
  readonly writerEpoch?: number
  readonly observedWriterEpoch?: number
}

export interface DashboardReadVersionSource {
  dashboardReadVersion(): DashboardReadVersionStamp
}

export interface DashboardReadBinding {
  generationId: string
  policyKey: string
  filterKey: string
  asOf: number
  viewKey: string
  projectKeys: readonly string[]
}

export interface DashboardReadCost {
  sqlStatements: number
  rowsVisited: number
  materializedBytes: number
  keyBytes: number
}

export interface DashboardReadWorkLimit {
  sqlStatements: number
  rowsVisited: number
  materializedBytes: number
  keyBytes: number
  projects: number
}

export interface DashboardReadLimits {
  idleMilliseconds: number
  absoluteMilliseconds: number
  maxContinuations: number
  perCall: Readonly<DashboardReadWorkLimit>
  perSession: Readonly<DashboardReadWorkLimit & { continuations: number }>
}

export interface DashboardReadManagerOptions {
  monotonicNow?: () => number
  limits?: Partial<Omit<DashboardReadLimits, 'perCall' | 'perSession'>> & {
    perCall?: Partial<DashboardReadWorkLimit>
    perSession?: Partial<DashboardReadWorkLimit & { continuations: number }>
  }
}

export interface DashboardReadCounters {
  sqlStatements: number
  rowsVisited: number
  materializedBytes: number
  keyBytes: number
  projects: number
  continuations: number
}

export interface DashboardReadCounterSnapshot {
  readonly call: Readonly<DashboardReadCounters>
  readonly session: Readonly<DashboardReadCounters>
  readonly sessionAccountedBytes: number
  readonly accountedBytes: number
}

const MIB = 1024 * 1024
const MAX_SESSIONS = 2
const MAX_SESSION_ACCOUNTED_BYTES = 4 * MIB
const MAX_ACCOUNTED_BYTES = 8 * MIB
const MAX_BINDING_BYTES = 16 * 1024
const MAX_PROJECT_KEYS = 64
const MAX_RESERVATIONS_PER_SESSION = 256
const MAX_RETIRED_TOKENS = 256
const SESSION_OVERHEAD_BYTES = 256
const CALL_OVERHEAD_BYTES = 128
const CALL_PROBE_ENTRY_OVERHEAD_BYTES = 48
const SESSION_PROBE_ENTRY_OVERHEAD_BYTES = 192
const MAX_CONNECTION_ID_BYTES = 36
const TOKEN_ACCOUNTING_BYTES = 64
const RESERVATION_OVERHEAD_BYTES = 64
const SOFT_OPERATION_WINDOW_MS = 100

const DEFAULT_LIMITS: DashboardReadLimits = Object.freeze({
  idleMilliseconds: 15_000,
  absoluteMilliseconds: 60_000,
  maxContinuations: 16,
  perCall: Object.freeze({
    sqlStatements: 64,
    rowsVisited: 2_048,
    materializedBytes: MIB,
    keyBytes: 64 * 1024,
    projects: 4,
  }),
  perSession: Object.freeze({
    sqlStatements: 512,
    rowsVisited: 32_768,
    materializedBytes: 8 * MIB,
    keyBytes: 256 * 1024,
    projects: 16,
    continuations: 16,
  }),
})

const COST_KEYS = ['keyBytes', 'materializedBytes', 'rowsVisited', 'sqlStatements'] as const
const WORK_LIMIT_KEYS = ['keyBytes', 'materializedBytes', 'projects', 'rowsVisited', 'sqlStatements'] as const

type SessionState = {
  readonly id: string
  binding: DashboardReadBinding
  bindingKey: string
  startedAt: number
  lastUsedAt: number
  readonly work: DashboardReadCounters
  readonly probes: Map<string, DashboardReadVersionStamp>
  readonly tokens: Set<string>
  readonly reservations: Map<string, { bytes: number; kind: 'key' | 'cache' }>
  residentBytes: number
  activeCallId?: string
  progressRetained: boolean
  readonly onEnd?: (status: DashboardReadFailureStatus, reason: string) => void
}

type CallState = {
  readonly id: string
  readonly sessionId: string
  readonly startedAt: number
  readonly work: DashboardReadCounters
  readonly probedProjects: Set<string>
  /** Enumerated directory members already metered against this call's project budget. */
  readonly memberProjects: Set<string>
  residentBytes: number
  controlProbed: boolean
  busy: boolean
  reentrancyViolation: boolean
}

type RetiredToken = { status: DashboardReadFailureStatus; reason: string }
type WorkDelta = DashboardReadCounters
type ResidentDelta = { callBytes: number; sessionBytes: number }

function failure<T>(status: DashboardReadFailureStatus, reason: string): DashboardReadOutcome<T> {
  return { status, reason }
}

function emptyCounters(): DashboardReadCounters {
  return { sqlStatements: 0, rowsVisited: 0, materializedBytes: 0, keyBytes: 0, projects: 0, continuations: 0 }
}

function strictRecord(value: unknown, expectedKeys: readonly string[], label: string,
  requiredKeys: readonly string[] = expectedKeys): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(String(key))) ||
      requiredKeys.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has unexpected or missing fields`)
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) throw new TypeError(`${label}.${key} must be a data property`)
    record[key] = descriptor.value
  }
  return record
}

function safeNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a finite nonnegative safe integer`)
  }
  return value
}

function safePositiveInteger(value: unknown, label: string): number {
  const result = safeNonnegativeInteger(value, label)
  if (result === 0) throw new RangeError(`${label} must be positive`)
  return result
}

function copyLimit(input: unknown, defaults: Readonly<DashboardReadWorkLimit>, label: string): DashboardReadWorkLimit {
  const source = input === undefined ? Object.create(null) as Record<string, unknown>
    : strictRecord(input, WORK_LIMIT_KEYS, label, [])
  const result = Object.create(null) as DashboardReadWorkLimit
  for (const key of WORK_LIMIT_KEYS) {
    const value = source[key] === undefined ? defaults[key] : safeNonnegativeInteger(source[key], `${label}.${key}`)
    if (value > defaults[key]) throw new RangeError(`${label}.${key} cannot exceed the server maximum`)
    result[key] = value
  }
  return Object.freeze(result)
}

function normalizeLimits(input: DashboardReadManagerOptions['limits']): DashboardReadLimits {
  if (input === undefined) return DEFAULT_LIMITS
  const record = strictRecord(input, ['absoluteMilliseconds', 'idleMilliseconds', 'maxContinuations', 'perCall', 'perSession'], 'limits', [])
  const idleMilliseconds = record.idleMilliseconds === undefined ? DEFAULT_LIMITS.idleMilliseconds
    : safePositiveInteger(record.idleMilliseconds, 'limits.idleMilliseconds')
  const absoluteMilliseconds = record.absoluteMilliseconds === undefined ? DEFAULT_LIMITS.absoluteMilliseconds
    : safePositiveInteger(record.absoluteMilliseconds, 'limits.absoluteMilliseconds')
  let maxContinuations = record.maxContinuations === undefined ? DEFAULT_LIMITS.maxContinuations
    : safeNonnegativeInteger(record.maxContinuations, 'limits.maxContinuations')
  if (idleMilliseconds > absoluteMilliseconds || absoluteMilliseconds > DEFAULT_LIMITS.absoluteMilliseconds ||
      idleMilliseconds > DEFAULT_LIMITS.idleMilliseconds || maxContinuations > DEFAULT_LIMITS.maxContinuations) {
    throw new RangeError('limits exceed the fixed server lifetime or continuation maximum')
  }
  const perCall = copyLimit(record.perCall, DEFAULT_LIMITS.perCall, 'limits.perCall')
  const defaultSessionLimit = DEFAULT_LIMITS.perSession
  const suppliedSession = record.perSession
  let perSession: DashboardReadWorkLimit & { continuations: number }
  if (suppliedSession === undefined) {
    perSession = { ...defaultSessionLimit }
  } else {
    const sessionRecord = strictRecord(suppliedSession, [...WORK_LIMIT_KEYS, 'continuations'], 'limits.perSession', [])
    const work = copyLimit(Object.fromEntries(WORK_LIMIT_KEYS.map((key) => [key, sessionRecord[key]])), defaultSessionLimit, 'limits.perSession')
    const continuations = sessionRecord.continuations === undefined ? defaultSessionLimit.continuations
      : safeNonnegativeInteger(sessionRecord.continuations, 'limits.perSession.continuations')
    if (continuations > defaultSessionLimit.continuations) throw new RangeError('limits.perSession.continuations cannot exceed the server maximum')
    perSession = { ...work, continuations }
  }
  for (const key of WORK_LIMIT_KEYS) {
    if (perSession[key] < perCall[key]) throw new RangeError(`limits.perSession.${key} must cover at least one call`)
  }
  if (perSession.continuations < maxContinuations) maxContinuations = perSession.continuations
  return Object.freeze({
    idleMilliseconds,
    absoluteMilliseconds,
    maxContinuations,
    perCall,
    perSession: Object.freeze(perSession),
  })
}

function boundedKey(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${label} must be a nonempty bounded opaque key`)
  }
  return value
}

function copyBinding(input: unknown): DashboardReadBinding {
  const record = strictRecord(input, ['asOf', 'filterKey', 'generationId', 'policyKey', 'projectKeys', 'viewKey'], 'binding')
  const asOf = safeNonnegativeInteger(record.asOf, 'binding.asOf')
  const generationId = boundedKey(record.generationId, 'binding.generationId', 128)
  const policyKey = boundedKey(record.policyKey, 'binding.policyKey', 128)
  const filterKey = boundedKey(record.filterKey, 'binding.filterKey', 128)
  if (!/^[a-f0-9]{64}$/u.test(policyKey) || !/^[a-f0-9]{64}$/u.test(filterKey)) {
    throw new TypeError('binding policy and filter keys must be opaque SHA-256 digests')
  }
  const viewKey = boundedKey(record.viewKey, 'binding.viewKey', 64)
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(viewKey)) throw new TypeError('binding.viewKey must be a stable view label')
  const projects = record.projectKeys
  if (!Array.isArray(projects) || projects.length > MAX_PROJECT_KEYS) throw new TypeError('binding.projectKeys must be a bounded string array')
  if (Reflect.ownKeys(projects).some((key) => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= projects.length))) {
    throw new TypeError('binding.projectKeys cannot have extra properties')
  }
  const projectKeys = Array.from({ length: projects.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(projects, String(index))
    if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('binding.projectKeys must be a dense data array')
    return boundedKey(descriptor.value, `binding.projectKeys[${index}]`, 256)
  })
  if (new Set(projectKeys).size !== projectKeys.length) throw new TypeError('binding.projectKeys must be unique')
  projectKeys.sort()
  return Object.freeze({ asOf, filterKey, generationId, policyKey, viewKey, projectKeys: Object.freeze(projectKeys) })
}

function copyStamp(value: unknown, expectedScope: 'project' | 'control'): DashboardReadVersionStamp | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.scope !== expectedScope || typeof record.connectionId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.connectionId) ||
      !Number.isSafeInteger(record.dataVersion) || Number(record.dataVersion) < 0 ||
      !Number.isSafeInteger(record.totalChanges) || Number(record.totalChanges) < 0) return undefined
  if (expectedScope === 'control') {
    if (!Number.isSafeInteger(record.writerEpoch) || Number(record.writerEpoch) < 1 ||
        !Number.isSafeInteger(record.observedWriterEpoch) || Number(record.observedWriterEpoch) < 1) return undefined
    return Object.freeze({ scope: 'control', connectionId: record.connectionId, dataVersion: Number(record.dataVersion),
      totalChanges: Number(record.totalChanges), writerEpoch: Number(record.writerEpoch), observedWriterEpoch: Number(record.observedWriterEpoch) })
  }
  if (record.writerEpoch !== undefined || record.observedWriterEpoch !== undefined) return undefined
  return Object.freeze({ scope: 'project', connectionId: record.connectionId, dataVersion: Number(record.dataVersion), totalChanges: Number(record.totalChanges) })
}

function sameStamp(left: DashboardReadVersionStamp, right: DashboardReadVersionStamp): boolean {
  return left.scope === right.scope && left.connectionId === right.connectionId && left.dataVersion === right.dataVersion &&
    left.totalChanges === right.totalChanges && left.writerEpoch === right.writerEpoch &&
    left.observedWriterEpoch === right.observedWriterEpoch
}

function emptyWorkDelta(): WorkDelta {
  return emptyCounters()
}

function isAsyncFunction(callback: () => unknown): boolean {
  return (callback as unknown as { constructor?: { name?: unknown } }).constructor?.name === 'AsyncFunction'
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Per-MemoryRuntime accounting and opaque-token lifecycle for future reads.
 * No timer or project/database enumeration is performed by construction or
 * invalidation. SQL work must be reserved before its synchronous callback.
 */
export class DashboardReadSessionManager {
  readonly #monotonicNow: () => number
  readonly #limits: DashboardReadLimits
  readonly #sessions = new Map<string, SessionState>()
  readonly #calls = new Map<string, CallState>()
  readonly #continuations = new Map<string, string>()
  readonly #retired = new Map<string, RetiredToken>()
  readonly #progress = new Map<string, { bytes: number; at: number; dispose: () => void }>()
  #progressBytes = 0
  #sessionBytes = 0
  #tombstoneBytes = 0
  #lastNow: number | undefined
  #clockUnavailable = false
  #closed = false
  #closing = false
  #invalidating = false
  #endNotificationDepth = 0
  #lifecycleEpoch = 0

  constructor(options: DashboardReadManagerOptions = {}) {
    const record = strictRecord(options, ['limits', 'monotonicNow'], 'manager options', [])
    if (record.monotonicNow !== undefined && typeof record.monotonicNow !== 'function') {
      throw new TypeError('monotonicNow must be a function')
    }
    this.#monotonicNow = (record.monotonicNow as (() => number) | undefined) ?? (() => performance.now())
    this.#limits = normalizeLimits(record.limits as DashboardReadManagerOptions['limits'] | undefined)
  }

  get limits(): DashboardReadLimits { return this.#limits }

  begin(bindingInput: DashboardReadBinding, onEnd?: (status: DashboardReadFailureStatus, reason: string) => void): DashboardReadOutcome<{ callToken: string }> {
    if (this.#closed || this.#closing || this.#invalidating || this.#endNotificationDepth > 0) {
      return failure('stale', this.#closed || this.#closing ? 'manager-closed' : 'manager-lifecycle-transition')
    }
    const lifecycleEpoch = this.#lifecycleEpoch
    const now = this.#observeClock()
    if (now === undefined) return failure('unavailable-probe', 'monotonic-clock')
    this.#expire(now)
    if (this.#closed || this.#closing || this.#invalidating || this.#lifecycleEpoch !== lifecycleEpoch) {
      return failure('stale', 'manager-lifecycle-transition')
    }
    const binding = copyBinding(bindingInput)
    if (binding.projectKeys.length > this.#limits.perCall.projects) {
      return failure('budget-exhausted', 'binding-project-limit')
    }
    const bindingKey = JSON.stringify(binding)
    const bindingBytes = Buffer.byteLength(bindingKey, 'utf8')
    if (bindingBytes > MAX_BINDING_BYTES) return failure('budget-exhausted', 'binding-key-bytes')
    const callToken = randomUUID()
    const sessionToken = randomUUID()
    const sessionResidentBytes = SESSION_OVERHEAD_BYTES + bindingBytes + CALL_OVERHEAD_BYTES + TOKEN_ACCOUNTING_BYTES
    const initialWork = emptyWorkDelta()
    initialWork.keyBytes = bindingBytes
    if (binding.viewKey === 'memory.global.v7') { initialWork.materializedBytes = 32 * 1024; initialWork.keyBytes += 16 * 1024 }
    if (!this.#withinLimits(initialWork, initialWork, 0)) return failure('budget-exhausted', 'session-work-limit')
    while (this.#sessions.size >= MAX_SESSIONS ||
        sessionResidentBytes > MAX_ACCOUNTED_BYTES - this.#accountedBytes()) {
      const idle = [...this.#sessions.values()].filter((session) => session.activeCallId === undefined)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.startedAt - b.startedAt)[0]
      if (idle === undefined) return failure('budget-exhausted', 'session-capacity')
      this.#dropSession(idle, 'evicted', 'session-capacity')
      if (this.#closed || this.#closing || this.#invalidating || this.#lifecycleEpoch !== lifecycleEpoch) {
        return failure('stale', 'manager-lifecycle-transition')
      }
    }
    if (!this.#withinLimits(initialWork, initialWork, sessionResidentBytes)) return failure('budget-exhausted', 'accounted-capacity')
    const session: SessionState = {
      id: sessionToken, binding, bindingKey, startedAt: now, lastUsedAt: now,
      work: { ...initialWork }, probes: new Map(), tokens: new Set([callToken]), reservations: new Map(),
      residentBytes: sessionResidentBytes, activeCallId: callToken, progressRetained: false,
      ...(onEnd === undefined ? {} : { onEnd }),
    }
    const call: CallState = { id: callToken, sessionId: sessionToken, startedAt: now, work: { ...initialWork },
      probedProjects: new Set(), memberProjects: new Set(), residentBytes: CALL_OVERHEAD_BYTES, controlProbed: false, busy: false, reentrancyViolation: false }
    this.#sessions.set(sessionToken, session)
    this.#calls.set(callToken, call)
    this.#sessionBytes += sessionResidentBytes
    return { status: 'ok', value: { callToken } }
  }

  /** Trusted profile coordinator only: extend one publication binding on the SAME call/session ledger. */
  selectGlobalSource(callToken: string, projectKey: string): DashboardReadOutcome<DashboardReadBinding> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { session, call } = resolved
    if (session.binding.viewKey !== 'memory.global.v7' || call.busy) return failure('stale', 'global-scope-transition-invalid')
    let key: string
    try { key = boundedKey(projectKey, 'projectKey', 256) } catch { return failure('stale', 'global-source-invalid') }
    if (session.binding.projectKeys.includes(key)) return { status: 'ok', value: session.binding }
    if (session.binding.projectKeys.length >= Math.min(4, this.#limits.perCall.projects)) return failure('budget-exhausted', 'global-source-window-full')
    if (!call.probedProjects.has(key) && !call.memberProjects.has(key) && (call.work.projects >= this.#limits.perCall.projects || session.work.projects >= this.#limits.perSession.projects)) {
      return failure('budget-exhausted', 'global-project-budget')
    }
    // An extension never removes a contributor: earlier versions and dependency TTLs remain publication obligations.
    const binding = Object.freeze({ ...session.binding, projectKeys: Object.freeze([...session.binding.projectKeys, key].sort()) })
    const bindingKey = JSON.stringify(binding), bytes = Buffer.byteLength(bindingKey, 'utf8')
    const admitted = this.run(callToken, { sqlStatements: 0, rowsVisited: 0, materializedBytes: bytes * 2, keyBytes: bytes }, () => undefined)
    if (admitted.status !== 'ok') return admitted
    const reserved = this.reserveResident(callToken, 'key', bytes * 2 + 128)
    if (reserved.status !== 'ok') return reserved
    session.binding = binding
    session.bindingKey = bindingKey
    return { status: 'ok', value: session.binding }
  }

  /** Small server-only scan positions survive an EXPLICIT next budget window, never a source switch. */
  retainGlobalProgress(callToken: string, dispose: () => void, keep?: string): DashboardReadOutcome<string> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    if (resolved.session.binding.viewKey !== 'memory.global.v7' || resolved.session.progressRetained) return failure('stale', 'progress-owner-invalid')
    const bytes = 512 * 1024
    while (this.#progress.size >= 2) this.dropGlobalProgress([...this.#progress.keys()].find((token) => token !== keep)!)
    const live = this.#resolveCall(callToken)
    if ('status' in live) return live
    if (live.session !== resolved.session || bytes > MAX_ACCOUNTED_BYTES - this.#accountedBytes() || bytes > MAX_SESSION_ACCOUNTED_BYTES - live.session.residentBytes) return failure('budget-exhausted', 'progress-capacity')
    // Progress construction was prepaid at begin; exhaustion cannot consume its final key/materialization allowance.
    resolved.session.progressRetained = true
    const token = randomUUID()
    this.#progress.set(token, { bytes, at: resolved.now, dispose }); this.#progressBytes += bytes
    return { status: 'ok', value: token }
  }
  inspectGlobalProgress(token: string): boolean {
    const now = this.#readNowAndExpire()
    if ('failure' in now) return false
    const value = this.#progress.get(token)
    if (value === undefined) return false
    // A fresh bounded read may replay this position for result offsets or response-budget retries.
    // The native in-session continuation token remains strictly single use.
    return true
  }
  dropGlobalProgress(token: string): void {
    const value = this.#progress.get(token)
    if (value === undefined) return
    this.#progress.delete(token); this.#progressBytes -= value.bytes
    try { value.dispose() } catch { /* progress cleanup is best effort */ }
  }

  continue(token: string, bindingInput: DashboardReadBinding): DashboardReadOutcome<{ callToken: string }> {
    const now = this.#readNowAndExpire()
    if ('failure' in now) return now.failure
    const tokenId = this.#validToken(token)
    if (tokenId === undefined) return failure('stale', 'unknown-token')
    const sessionId = this.#continuations.get(tokenId)
    if (sessionId === undefined) return this.#retiredFailure(tokenId)
    const session = this.#sessions.get(sessionId)
    if (session === undefined) return this.#retiredFailure(tokenId)
    if (session.activeCallId !== undefined) return failure('stale', 'session-call-active')
    let binding: DashboardReadBinding
    try { binding = copyBinding(bindingInput) }
    catch {
      this.#dropSession(session, 'stale', 'binding-invalid')
      return failure('stale', 'binding-invalid')
    }
    if (JSON.stringify(binding) !== session.bindingKey) {
      this.#dropSession(session, 'stale', 'binding-changed')
      return failure('stale', 'binding-changed')
    }
    const callToken = randomUUID()
    const nextResidentBytes = CALL_OVERHEAD_BYTES + TOKEN_ACCOUNTING_BYTES
    const delta = emptyWorkDelta()
    if (!this.#withinLimits(delta, delta, nextResidentBytes, session,
      nextResidentBytes - TOKEN_ACCOUNTING_BYTES)) {
      this.#dropSession(session, 'budget-exhausted', 'accounted-capacity')
      return failure('budget-exhausted', 'accounted-capacity')
    }
    this.#consumeToken(session, tokenId, 'stale', 'continuation-consumed')
    session.lastUsedAt = now.value
    session.residentBytes += nextResidentBytes
    this.#sessionBytes += nextResidentBytes
    const call: CallState = { id: callToken, sessionId, startedAt: now.value, work: emptyCounters(),
      probedProjects: new Set(), memberProjects: new Set(), residentBytes: CALL_OVERHEAD_BYTES, controlProbed: false, busy: false, reentrancyViolation: false }
    session.tokens.add(callToken)
    session.activeCallId = callToken
    this.#calls.set(callToken, call)
    return { status: 'ok', value: { callToken } }
  }

  /** Check a suspended continuation without consuming it or refreshing idle lifetime. */
  inspectContinuation(token: string): DashboardReadOutcome<{ suspended: true }> {
    const now = this.#readNowAndExpire()
    if ('failure' in now) return now.failure
    const tokenId = this.#validToken(token)
    if (tokenId === undefined) return failure('stale', 'unknown-continuation-token')
    const sessionId = this.#continuations.get(tokenId)
    if (sessionId === undefined) return this.#retiredFailure(tokenId)
    const session = this.#sessions.get(sessionId)
    if (session === undefined) return this.#retiredFailure(tokenId)
    if (session.activeCallId !== undefined) return failure('stale', 'session-call-active')
    return { status: 'ok', value: { suspended: true } }
  }

  /** Cancel only the suspended session owning this token; replay cannot cancel a resumed call. */
  cancelContinuation(token: string): DashboardReadOutcome<void> {
    const now = this.#readNowAndExpire()
    if ('failure' in now) return now.failure
    const tokenId = this.#validToken(token)
    if (tokenId === undefined) return failure('stale', 'unknown-continuation-token')
    const sessionId = this.#continuations.get(tokenId)
    if (sessionId === undefined) return this.#retiredFailure(tokenId)
    const session = this.#sessions.get(sessionId)
    if (session === undefined) return this.#retiredFailure(tokenId)
    if (session.activeCallId !== undefined) return failure('stale', 'session-call-active')
    this.#dropSession(session, 'stale', 'continuation-cancelled')
    return { status: 'ok', value: undefined }
  }

  /** Charges one bounded operation before running it; thrown errors do not refund work. */
  run<T>(callToken: string, costInput: DashboardReadCost, operation: () => T): DashboardReadOutcome<T> {
    const cost = this.#copyCost(costInput)
    if (typeof operation !== 'function') throw new TypeError('dashboard read operation must be a function')
    if (isAsyncFunction(operation)) return failure('unavailable-probe', 'async-callback-not-supported')
    return this.#run(callToken, cost, emptyWorkDelta(), operation)
  }

  /**
   * Charges one enumerated directory member access. Members live outside the
   * immutable body binding, so this path never registers a body probe; it only
   * consumes the same per-call/per-session `projects` budget as a probe and is
   * deduplicated per call so a label read and its pre-publication recheck count
   * once.
   */
  runMember<T>(callToken: string, memberKeyInput: string, costInput: DashboardReadCost, operation: () => T): DashboardReadOutcome<T> {
    const cost = this.#copyCost(costInput)
    if (typeof operation !== 'function') throw new TypeError('dashboard read operation must be a function')
    if (isAsyncFunction(operation)) return failure('unavailable-probe', 'async-callback-not-supported')
    let memberKey: string
    try { memberKey = boundedKey(memberKeyInput, 'directory member key', 256) }
    catch { return failure('unavailable-probe', 'directory-member-key-invalid') }
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const extra = emptyWorkDelta()
    if (!resolved.call.memberProjects.has(memberKey)) extra.projects = 1
    return this.#run(callToken, cost, extra, operation, false, { callBytes: 0, sessionBytes: 0 }, memberKey)
  }

  probeProject(callToken: string, projectKeyInput: string, source: DashboardReadVersionSource): DashboardReadOutcome<DashboardReadVersionStamp> {
    return this.#probe(callToken, 'project', projectKeyInput, source)
  }

  probeControl(callToken: string, source: DashboardReadVersionSource): DashboardReadOutcome<DashboardReadVersionStamp> {
    return this.#probe(callToken, 'control', 'control', source)
  }

  finish(callToken: string, hasMore: boolean): DashboardReadOutcome<{ continuationToken?: string }> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session, now } = resolved
    if (call.busy) { call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
    if (typeof hasMore !== 'boolean') throw new TypeError('hasMore must be boolean')
    if (hasMore) {
      if (session.work.continuations >= this.#limits.maxContinuations ||
          session.work.continuations >= this.#limits.perSession.continuations) {
        return failure('budget-exhausted', 'continuation-limit')
      }
      const delta = emptyWorkDelta()
      delta.continuations = 1
      const globalResidentDelta = -call.residentBytes + TOKEN_ACCOUNTING_BYTES
      if (!this.#withinLimits(delta, delta, globalResidentDelta, session, -call.residentBytes)) {
        return failure('budget-exhausted', 'accounted-capacity')
      }
      if (!this.#charge(session, call, delta)) return failure('budget-exhausted', 'continuation-limit')
    }
    session.lastUsedAt = now
    this.#calls.delete(call.id)
    session.activeCallId = undefined
    this.#removeSessionBytes(session, call.residentBytes)
    this.#consumeToken(session, call.id, 'stale', 'call-finished')
    if (!hasMore) {
      this.#dropSession(session, 'stale', 'session-finished')
      return { status: 'ok', value: {} }
    }
    const continuationToken = randomUUID()
    session.tokens.add(continuationToken)
    session.residentBytes += TOKEN_ACCOUNTING_BYTES
    this.#sessionBytes += TOKEN_ACCOUNTING_BYTES
    this.#continuations.set(continuationToken, session.id)
    return { status: 'ok', value: { continuationToken } }
  }

  /** Start the next bounded global work window without replacing live connection probes.
   * Only the trusted global coordinator calls this, after its final publication proof.
   * Resident leases and original version stamps survive; work counters and window age do not.
   */
  finishGlobalWindow(callToken: string): DashboardReadOutcome<{ continuationToken?: string }> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { session, now } = resolved
    if (session.binding.viewKey !== 'memory.global.v7') return failure('stale', 'global-window-scope-invalid')
    const finished = this.finish(callToken, true)
    if (finished.status !== 'ok') return finished
    Object.assign(session.work, emptyCounters())
    session.startedAt = now
    session.progressRetained = false
    return finished
  }

  cancel(callToken: string): DashboardReadOutcome<void> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    if (resolved.call.busy) { resolved.call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
    this.#dropSession(resolved.session, 'stale', 'call-cancelled')
    return { status: 'ok', value: undefined }
  }

  /** Resident key/cache leases are accounted separately from cumulative work. */
  reserveResident(callToken: string, kind: 'key' | 'cache', bytesInput: number): DashboardReadOutcome<{ reservationToken: string }> {
    const bytes = safeNonnegativeInteger(bytesInput, 'resident bytes')
    if (kind !== 'key' && kind !== 'cache') throw new TypeError('resident kind is invalid')
    const cost = { sqlStatements: 0, rowsVisited: 0, materializedBytes: kind === 'cache' ? bytes : 0,
      keyBytes: kind === 'key' ? bytes : 0 }
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session, now } = resolved
    if (call.busy) { call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
    if (session.reservations.size >= MAX_RESERVATIONS_PER_SESSION) return failure('budget-exhausted', 'resident-reservation-count')
    const residentBytes = bytes + RESERVATION_OVERHEAD_BYTES
    const delta = emptyWorkDelta()
    delta.materializedBytes = cost.materializedBytes
    delta.keyBytes = cost.keyBytes
    if (!this.#hasCurrentProbeSet(call, session)) return failure('unavailable-probe', 'current-call-probes-required')
    if (!this.#withinLimits(delta, delta, residentBytes, session) || !this.#charge(session, call, delta)) {
      return failure('budget-exhausted', 'resident-capacity-or-work')
    }
    const reservationToken = randomUUID()
    session.reservations.set(reservationToken, { bytes: residentBytes, kind })
    session.residentBytes += residentBytes
    this.#sessionBytes += residentBytes
    session.lastUsedAt = now
    return { status: 'ok', value: { reservationToken } }
  }

  releaseResident(callToken: string, reservationToken: string): DashboardReadOutcome<void> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session, now } = resolved
    if (call.busy) { call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
    const tokenId = this.#validToken(reservationToken)
    if (tokenId === undefined) return failure('stale', 'unknown-reservation')
    const reservation = session.reservations.get(tokenId)
    if (reservation === undefined) return failure('stale', 'reservation-released')
    session.reservations.delete(tokenId)
    this.#removeSessionBytes(session, reservation.bytes)
    session.lastUsedAt = now
    return { status: 'ok', value: undefined }
  }

  withResident<T>(callToken: string, kind: 'key' | 'cache', bytes: number, operation: () => T): DashboardReadOutcome<T> {
    if (typeof operation !== 'function') throw new TypeError('resident operation must be a function')
    if (isAsyncFunction(operation)) return failure('unavailable-probe', 'async-callback-not-supported')
    const reserved = this.reserveResident(callToken, kind, bytes)
    if (reserved.status !== 'ok') return reserved
    const call = this.#calls.get(callToken)
    const session = call === undefined ? undefined : this.#sessions.get(call.sessionId)
    try {
      if (session === undefined) return failure('stale', 'session-invalidated')
      if (call === undefined) return failure('stale', 'call-unavailable')
      const resolved = this.#resolveCall(callToken)
      if ('status' in resolved) return resolved
      if (resolved.call !== call || resolved.session !== session) return failure('stale', 'state-invalidated-before-operation')
      if (call.busy) { call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
      if (resolved.now - call.startedAt >= SOFT_OPERATION_WINDOW_MS) {
        return failure('budget-exhausted', 'cooperative-soft-window')
      }
      call.busy = true
      const value = operation()
      if (isThenable(value)) {
        if (value instanceof Promise) void value.catch(() => undefined)
        this.#invalidateSession(session, 'stale', 'async-operation-not-supported')
        return failure('unavailable-probe', 'async-operation-not-supported')
      }
      if (call.reentrancyViolation) {
        this.#invalidateSession(session, 'stale', 'call-reentrant')
        return failure('stale', 'call-reentrant')
      }
      const after = this.#revalidateAfterCallback(call, session)
      if (after.status !== 'ok') return after
      return { status: 'ok', value }
    } catch (error) {
      if (call?.reentrancyViolation && session !== undefined && this.#sessions.get(session.id) === session) {
        this.#invalidateSession(session, 'stale', 'call-reentrant')
      }
      throw error
    } finally {
      if (call !== undefined) call.busy = false
      const liveSession = this.#sessions.get(session?.id ?? '')
      if (liveSession !== undefined) {
        const reservation = liveSession.reservations.get(reserved.value.reservationToken)
        if (reservation !== undefined) {
          liveSession.reservations.delete(reserved.value.reservationToken)
          this.#removeSessionBytes(liveSession, reservation.bytes)
        }
      }
    }
  }

  counters(callToken: string): DashboardReadOutcome<DashboardReadCounterSnapshot> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session } = resolved
    return { status: 'ok', value: Object.freeze({
      call: Object.freeze({ ...call.work }),
      session: Object.freeze({ ...session.work }),
      sessionAccountedBytes: session.residentBytes,
      accountedBytes: this.#accountedBytes(),
    }) }
  }

  /**
   * Remaining per-call and per-session work for one live call. Aggregators use
   * this before a charged operation so they can stop early and still afford
   * the pre-publication version probes and output reservation; the method is
   * read-only and does not refresh idle lifetime.
   */
  remaining(callToken: string): DashboardReadOutcome<{
    readonly call: Readonly<DashboardReadWorkLimit>
    readonly session: Readonly<DashboardReadWorkLimit>
  }> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session } = resolved
    const callRemaining = Object.create(null) as DashboardReadWorkLimit
    const sessionRemaining = Object.create(null) as DashboardReadWorkLimit
    for (const key of WORK_LIMIT_KEYS) {
      callRemaining[key] = Math.max(0, this.#limits.perCall[key] - call.work[key])
      sessionRemaining[key] = Math.max(0, this.#limits.perSession[key] - session.work[key])
    }
    return { status: 'ok', value: Object.freeze({
      call: Object.freeze(callRemaining), session: Object.freeze(sessionRemaining),
    }) }
  }

  stats(): Readonly<{ sessions: number; activeCalls: number; accountedBytes: number; closed: boolean }> {
    return Object.freeze({ sessions: this.#sessions.size, activeCalls: this.#calls.size,
      accountedBytes: this.#accountedBytes(), closed: this.#closed })
  }

  /** Policy, generation, maintenance, and close hooks only discard bounded in-memory state. */
  invalidate(reason = 'state-invalidated'): void {
    const boundedReason = typeof reason === 'string' ? reason.slice(0, 80) : 'state-invalidated'
    if (this.#invalidating) return
    this.#lifecycleEpoch += 1
    this.#invalidating = true
    try {
      for (const session of [...this.#sessions.values()]) this.#dropSession(session, 'stale', boundedReason)
      for (const token of [...this.#progress.keys()]) this.dropGlobalProgress(token)
    } finally { this.#invalidating = false }
  }

  close(): void {
    if (this.#closed || this.#closing) return
    this.#closing = true
    this.#lifecycleEpoch += 1
    try {
      this.invalidate('manager-closed')
      this.#closed = true
      this.#retired.clear()
      this.#tombstoneBytes = 0
    } finally { this.#closing = false }
  }

  #probe(callToken: string, expectedScope: 'project' | 'control', scopeKeyInput: string,
    source: DashboardReadVersionSource): DashboardReadOutcome<DashboardReadVersionStamp> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session } = resolved
    if (call.busy) { call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
    let scopeKey: string
    try { scopeKey = expectedScope === 'project' ? boundedKey(scopeKeyInput, 'projectKey', 256) : 'control' }
    catch {
      this.#invalidateSession(session, 'stale', 'probe-scope-invalid')
      return failure('stale', 'probe-scope-invalid')
    }
    if (expectedScope === 'project' && !session.binding.projectKeys.includes(scopeKey)) {
      this.#invalidateSession(session, 'stale', 'project-binding-changed')
      return failure('stale', 'project-binding-changed')
    }
    const probeKey = expectedScope === 'project' ? `project:${scopeKey}` : 'control:ledger'
    const prior = session.probes.get(probeKey)
    const unavailable = (reason: string): DashboardReadOutcome<DashboardReadVersionStamp> => {
      if (prior !== undefined && this.#sessions.get(session.id) === session) {
        this.#invalidateSession(session, 'unavailable-probe', reason)
      }
      return failure('unavailable-probe', reason)
    }
    let probe: unknown
    try { probe = source?.dashboardReadVersion }
    catch { return unavailable('probe-source-unavailable') }
    if (typeof probe !== 'function') return unavailable('probe-source-missing')
    try {
      if (isAsyncFunction(probe as () => unknown)) return unavailable('async-probe-not-supported')
    } catch { return unavailable('probe-source-invalid') }
    const delta = emptyWorkDelta()
    const addProject = expectedScope === 'project' && !call.probedProjects.has(scopeKey) &&
      !(session.binding.viewKey === 'memory.global.v7' && call.memberProjects.has(scopeKey))
    if (addProject) delta.projects = 1
    const probedInCall = expectedScope === 'project' ? call.probedProjects.has(scopeKey) : call.controlProbed
    delta.keyBytes = probedInCall ? 0 : Buffer.byteLength(scopeKey, 'utf8')
    const callMetadataBytes = probedInCall ? 0 : CALL_PROBE_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(scopeKey, 'utf8')
    const sessionMetadataBytes = prior === undefined
      ? SESSION_PROBE_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(probeKey, 'utf8') + MAX_CONNECTION_ID_BYTES : 0
    const residentDelta: ResidentDelta = { callBytes: callMetadataBytes, sessionBytes: sessionMetadataBytes }
    const cost: DashboardReadCost = { sqlStatements: 2, rowsVisited: 2, materializedBytes: 0, keyBytes: 0 }
    let read: DashboardReadOutcome<DashboardReadVersionStamp>
    try { read = this.#run(callToken, cost, delta, () => (probe as () => DashboardReadVersionStamp).call(source), true, residentDelta) }
    catch {
      if (this.#sessions.get(session.id) === session && this.#calls.get(call.id) === call) {
        call.residentBytes = Math.max(CALL_OVERHEAD_BYTES, call.residentBytes - callMetadataBytes)
        this.#removeSessionBytes(session, callMetadataBytes + sessionMetadataBytes)
      }
      return unavailable('sqlite-probe-failed')
    }
    if (read.status !== 'ok') {
      if (prior !== undefined && this.#sessions.get(session.id) === session) {
        this.#invalidateSession(session, read.status, read.reason)
      }
      return read
    }
    let stamp: DashboardReadVersionStamp | undefined
    try { stamp = copyStamp(read.value, expectedScope) }
    catch { stamp = undefined }
    if (stamp === undefined) {
      if (this.#sessions.get(session.id) === session && this.#calls.get(call.id) === call) {
        call.residentBytes = Math.max(CALL_OVERHEAD_BYTES, call.residentBytes - callMetadataBytes)
        this.#removeSessionBytes(session, callMetadataBytes + sessionMetadataBytes)
      }
      return unavailable('invalid-version-stamp')
    }
    if (stamp.scope === 'control' && stamp.writerEpoch !== stamp.observedWriterEpoch) {
      this.#invalidateSession(session, 'stale', 'writer-epoch-changed')
      return failure('stale', 'writer-epoch-changed')
    }
    if (prior !== undefined && !sameStamp(prior, stamp)) {
      this.#invalidateSession(session, 'stale', 'database-version-changed')
      return failure('stale', 'database-version-changed')
    }
    if (prior === undefined) session.probes.set(probeKey, stamp)
    if (expectedScope === 'project') call.probedProjects.add(scopeKey)
    else call.controlProbed = true
    return { status: 'ok', value: stamp }
  }

  #copyCost(input: DashboardReadCost): DashboardReadCost {
    const record = strictRecord(input, COST_KEYS, 'cost')
    return Object.freeze({
      sqlStatements: safeNonnegativeInteger(record.sqlStatements, 'cost.sqlStatements'),
      rowsVisited: safeNonnegativeInteger(record.rowsVisited, 'cost.rowsVisited'),
      materializedBytes: safeNonnegativeInteger(record.materializedBytes, 'cost.materializedBytes'),
      keyBytes: safeNonnegativeInteger(record.keyBytes, 'cost.keyBytes'),
    })
  }

  #run<T>(callToken: string, cost: DashboardReadCost, extra: WorkDelta, operation: () => T,
    versionProbe = false, residentDelta: ResidentDelta = { callBytes: 0, sessionBytes: 0 },
    memberKey?: string): DashboardReadOutcome<T> {
    const resolved = this.#resolveCall(callToken)
    if ('status' in resolved) return resolved
    const { call, session, now } = resolved
    if (call.busy) { call.reentrancyViolation = true; return failure('stale', 'call-reentrant') }
    if (now - call.startedAt >= SOFT_OPERATION_WINDOW_MS) return failure('budget-exhausted', 'cooperative-soft-window')
    if (!versionProbe && !this.#hasCurrentProbeSet(call, session)) return failure('unavailable-probe', 'current-call-probes-required')
    const totalResidentDelta = residentDelta.callBytes + residentDelta.sessionBytes
    if (!this.#withinLimits(emptyWorkDelta(), emptyWorkDelta(), totalResidentDelta, session)) {
      return failure('budget-exhausted', 'accounted-capacity')
    }
    const delta = emptyWorkDelta()
    delta.sqlStatements = cost.sqlStatements + extra.sqlStatements
    delta.rowsVisited = cost.rowsVisited + extra.rowsVisited
    delta.materializedBytes = cost.materializedBytes + extra.materializedBytes
    delta.keyBytes = cost.keyBytes + extra.keyBytes
    delta.projects = extra.projects
    delta.continuations = extra.continuations
    if (!this.#charge(session, call, delta)) return failure('budget-exhausted', 'work-limit')
    if (memberKey !== undefined) call.memberProjects.add(memberKey)
    session.residentBytes += totalResidentDelta
    call.residentBytes += residentDelta.callBytes
    this.#sessionBytes += totalResidentDelta
    call.busy = true
    session.lastUsedAt = now
    try {
      const value = operation()
      if (isThenable(value)) {
        if (value instanceof Promise) void value.catch(() => undefined)
        const reason = versionProbe ? 'async-probe-not-supported' : 'async-operation-not-supported'
        this.#invalidateSession(session, versionProbe ? 'unavailable-probe' : 'stale', reason)
        return failure('unavailable-probe', reason)
      }
      if (call.reentrancyViolation) {
        this.#invalidateSession(session, 'stale', 'call-reentrant')
        return failure('stale', 'call-reentrant')
      }
      const after = this.#revalidateAfterCallback(call, session)
      if (after.status !== 'ok') return after
      return { status: 'ok', value }
    } catch (error) {
      if (call.reentrancyViolation && this.#sessions.get(session.id) === session) {
        this.#invalidateSession(session, 'stale', 'call-reentrant')
      }
      throw error
    }
    finally { call.busy = false }
  }

  #charge(session: SessionState, call: CallState, delta: WorkDelta): boolean {
    if (!this.#fits(call.work, delta, this.#limits.perCall) ||
        !this.#fits(session.work, delta, this.#limits.perSession) ||
        delta.continuations > this.#limits.perSession.continuations - session.work.continuations) return false
    for (const key of WORK_LIMIT_KEYS) {
      call.work[key] += delta[key]
      session.work[key] += delta[key]
    }
    call.work.continuations += delta.continuations
    session.work.continuations += delta.continuations
    return true
  }

  #hasCurrentProbeSet(call: CallState, session: SessionState): boolean {
    return call.controlProbed && session.binding.projectKeys.every((projectKey) => call.probedProjects.has(projectKey))
  }

  #revalidateAfterCallback(call: CallState, session: SessionState): DashboardReadOutcome<void> {
    const resolved = this.#resolveCall(call.id)
    if ('status' in resolved) return resolved
    if (resolved.call !== call || resolved.session !== session) {
      if (this.#sessions.get(session.id) === session) {
        this.#invalidateSession(session, 'stale', 'state-invalidated-during-operation')
      }
      return failure('stale', 'state-invalidated-during-operation')
    }
    return { status: 'ok', value: undefined }
  }

  #fits(used: DashboardReadCounters, delta: WorkDelta, limits: Readonly<DashboardReadWorkLimit>): boolean {
    return WORK_LIMIT_KEYS.every((key) => delta[key] <= limits[key] - used[key])
  }

  #withinLimits(callDelta: WorkDelta, sessionDelta: WorkDelta, managerResidentDelta: number,
    session?: SessionState, sessionResidentDelta = managerResidentDelta): boolean {
    const currentSessionResidentBytes = session?.residentBytes ?? 0
    const nextSessionResidentBytes = currentSessionResidentBytes + sessionResidentDelta
    const nextManagerResidentBytes = this.#accountedBytes() + managerResidentDelta
    if (!Number.isSafeInteger(sessionResidentDelta) || !Number.isSafeInteger(managerResidentDelta) ||
        !Number.isSafeInteger(nextSessionResidentBytes) || nextSessionResidentBytes < 0 ||
        nextSessionResidentBytes > MAX_SESSION_ACCOUNTED_BYTES ||
        !Number.isSafeInteger(nextManagerResidentBytes) || nextManagerResidentBytes < 0 ||
        nextManagerResidentBytes > MAX_ACCOUNTED_BYTES) return false
    const callZero = emptyCounters()
    const sessionZero = emptyCounters()
    return this.#fits(callZero, callDelta, this.#limits.perCall) &&
      this.#fits(sessionZero, sessionDelta, this.#limits.perSession) &&
      sessionDelta.continuations <= this.#limits.perSession.continuations
  }

  #resolveCall(callToken: string): { call: CallState; session: SessionState; now: number } | DashboardReadOutcome<never> {
    const now = this.#readNowAndExpire()
    if ('failure' in now) return now.failure
    const tokenId = this.#validToken(callToken)
    if (tokenId === undefined) return failure('stale', 'unknown-call-token')
    const call = this.#calls.get(tokenId)
    if (call === undefined) return this.#retiredFailure(tokenId)
    const session = this.#sessions.get(call.sessionId)
    if (session === undefined) return this.#retiredFailure(tokenId)
    if (session.activeCallId !== call.id) return failure('stale', 'call-not-active')
    return { call, session, now: now.value }
  }

  #readNowAndExpire(): { value: number } | { failure: DashboardReadOutcome<never> } {
    if (this.#closed) return { failure: failure('stale', 'manager-closed') }
    const now = this.#observeClock()
    if (now === undefined) return { failure: failure('unavailable-probe', 'monotonic-clock') }
    this.#expire(now)
    return { value: now }
  }

  #observeClock(): number | undefined {
    if (this.#clockUnavailable) return undefined
    let now: number
    try { now = this.#monotonicNow() }
    catch { now = Number.NaN }
    if (!Number.isFinite(now) || now < 0 || (this.#lastNow !== undefined && now < this.#lastNow)) {
      this.#clockUnavailable = true
      this.invalidate('monotonic-clock-invalid')
      return undefined
    }
    this.#lastNow = now
    return now
  }

  #expire(now: number): void {
    for (const [token, value] of this.#progress) if (now - value.at >= this.#limits.absoluteMilliseconds) this.dropGlobalProgress(token)
    for (const session of [...this.#sessions.values()]) {
      if (now - session.startedAt >= this.#limits.absoluteMilliseconds ||
          now - session.lastUsedAt >= this.#limits.idleMilliseconds) {
        this.#dropSession(session, 'expired', 'session-lifetime')
      }
    }
  }

  #tokenFailure(token: string): DashboardReadOutcome<never> {
    return this.#retiredFailure(token)
  }

  #retiredFailure(token: string): DashboardReadOutcome<never> {
    const retired = this.#retired.get(token)
    return retired === undefined ? failure('stale', 'token-unavailable') : failure(retired.status, retired.reason)
  }

  #validToken(token: unknown): string | undefined {
    return typeof token === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(token)
      ? token : undefined
  }

  #consumeToken(session: SessionState, token: string, status: DashboardReadFailureStatus, reason: string): void {
    session.tokens.delete(token)
    this.#continuations.delete(token)
    if (this.#calls.delete(token)) this.#removeSessionBytes(session, CALL_OVERHEAD_BYTES)
    this.#removeSessionBytes(session, TOKEN_ACCOUNTING_BYTES)
    this.#rememberToken(token, status, reason)
  }

  #rememberToken(token: string, status: DashboardReadFailureStatus, reason: string): void {
    // A nested close() from an onEnd callback may finish while an outer
    // invalidate() is still dropping sessions. Do not recreate tombstones
    // after close() has cleared the accounting ledger.
    if (this.#closed) return
    if (this.#retired.has(token)) return
    this.#retired.set(token, { status, reason })
    this.#tombstoneBytes += TOKEN_ACCOUNTING_BYTES
    while (this.#retired.size > MAX_RETIRED_TOKENS) {
      const oldest = this.#retired.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#retired.delete(oldest)
      this.#tombstoneBytes = Math.max(0, this.#tombstoneBytes - TOKEN_ACCOUNTING_BYTES)
    }
  }

  #dropSession(session: SessionState, status: DashboardReadFailureStatus, reason: string): void {
    if (!this.#sessions.has(session.id)) return
    this.#sessions.delete(session.id)
    for (const token of session.tokens) {
      this.#continuations.delete(token)
      this.#calls.delete(token)
    }
    this.#sessionBytes = Math.max(0, this.#sessionBytes - session.residentBytes)
    session.residentBytes = 0
    session.reservations.clear()
    session.probes.clear()
    session.activeCallId = undefined
    for (const token of session.tokens) this.#rememberToken(token, status, reason)
    session.tokens.clear()
    this.#endNotificationDepth += 1
    try { session.onEnd?.(status, reason) } catch { /* lifecycle notification cannot interrupt accounting cleanup */ }
    finally { this.#endNotificationDepth = Math.max(0, this.#endNotificationDepth - 1) }
  }

  #invalidateSession(session: SessionState, status: DashboardReadFailureStatus, reason: string): void {
    this.#dropSession(session, status, reason)
  }

  #removeSessionBytes(session: SessionState, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) return
    const removed = Math.min(amount, session.residentBytes)
    session.residentBytes -= removed
    this.#sessionBytes = Math.max(0, this.#sessionBytes - removed)
  }

  #accountedBytes(): number { return this.#sessionBytes + this.#tombstoneBytes + this.#progressBytes }
}
