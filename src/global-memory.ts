/** Profile-wide, pathless browse. Physical project keys are provenance, never UI scope choices. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, opendirSync, realpathSync, readFileSync, openSync, fstatSync, closeSync, constants, type Dir } from 'node:fs'
import path from 'node:path'
import { recallQueryTerms, recallTermMatches, type MemoryStore, type MemoryRecord } from './store.js'
import { isValidProjectKey } from './project.js'
import type { ResolvedConfig } from './config.js'
import type { DashboardReadBinding, DashboardReadOutcome } from './dashboard-read.js'
import { isValidDashboardSceneMember, type DashboardSceneMetaRow,
  type DashboardSceneMemberRow, type DashboardVisibilityReadSession } from './dashboard-visibility.js'
import { ReadDashboardRequestSchema, type ReadDashboardRequest, type ReadDashboardResult,
  type GlobalMemoryItem, type GlobalMemoryPage } from './remote-contract.js'

export const globalMemoryKey = (projectKey: string, id: string): string =>
  `g:${encodeURIComponent(projectKey)}:${encodeURIComponent(id)}`
export function parseGlobalMemoryKey(key: string): { projectKey: string; id: string } | undefined {
  const parts = key.split(':')
  if (parts.length !== 3 || parts[0] !== 'g') return undefined
  try {
    const projectKey = decodeURIComponent(parts[1]!), id = decodeURIComponent(parts[2]!)
    return isValidProjectKey(projectKey) && id.length > 0 && Buffer.byteLength(id) <= 256 && !id.includes('\0') &&
      globalMemoryKey(projectKey, id) === key ? { projectKey, id } : undefined
  } catch { return undefined }
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
// Base: bounded paths/filter, <=5 source keys/4 pins, counters, and the OS directory buffer.
// Bodies never accumulate here. Home retains <=128KiB recent items +48KiB calendar +16KiB metadata.
const BASE_STATE_BYTES = 64 * 1024
const HOME_STATE_BYTES = 256 * 1024
const PAGE_STATE_BYTES = 256 * 1024
// A derived index retains only one 15-member page and a constant-size proof.
const DERIVED_STATE_BYTES = 32 * 1024
// Search also owns the server-side accumulated candidate bodies until the final window proof.
const SEARCH_STATE_BYTES = 256 * 1024
const WIRE_BYTES = 128 * 1024
/** Bound JSON output before allocating its UTF-16 serialization, including escape expansion. */
function jsonBytes(value: unknown, limit = WIRE_BYTES): number {
  let bytes = 0
  const add = (n: number): void => { bytes += n; if (bytes > limit) throw new Error('budget-exhausted') }
  const walk = (input: unknown): void => {
    if (typeof input === 'string') {
      add(2)
      for (const char of input) { const code = char.codePointAt(0)!; add(code < 32 || code >= 0xd800 && code <= 0xdfff ? 6 : char === '\"' || char === '\\' ? 2 : Buffer.byteLength(char)) }
    } else if (typeof input === 'number') add(Number.isFinite(input) ? String(input).length : 4)
    else if (typeof input === 'boolean') add(input ? 4 : 5)
    else if (input === null) add(4)
    else if (Array.isArray(input)) { add(2 + Math.max(0, input.length - 1)); for (const item of input) walk(item === undefined ? null : item) }
    else if (typeof input === 'object') {
      add(2); let first = true
      for (const [key, item] of Object.entries(input)) if (item !== undefined) { if (!first) add(1); first = false; walk(key); add(1); walk(item) }
    }
  }
  walk(value); return bytes
}
// Object/array/string overhead is included; records share their already-proven body strings.
const itemResidentBytes = (item: GlobalMemoryItem): number => 4096 + 2 * Buffer.byteLength(item.content) +
  2 * Buffer.byteLength(item.key) + 2 * Buffer.byteLength(item.id) + 2 * Buffer.byteLength(item.projectKey) +
  (item.scene === undefined ? 0 : 2 * Buffer.byteLength(item.scene)) +
  (item.memory?.sourceMessageIds.reduce((sum, id) => sum + 2 * Buffer.byteLength(id) + 64, 0) ?? 0) +
  item.sources.reduce((sum, source) => sum + 2 * Buffer.byteLength(source.id) + 2 * Buffer.byteLength(source.sessionId ?? '') +
    2 * Buffer.byteLength(source.projectKey ?? '') + 128, 0)

/** One immutable bounded enumeration; symlinks and foreign paths never become stores. */
export function profileSources(root: string): { keys: string[]; complete: boolean; marker: string } {
  const directory = path.join(root, 'projects'), stat = lstatSync(directory, { throwIfNoEntry: false })
  if (stat === undefined) return { keys: [], complete: true, marker: 'absent' }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== path.join(realpathSync(root), 'projects')) {
    throw new Error('profile directory unavailable')
  }
  const keys: string[] = [], identities: string[] = [], dir = opendirSync(directory)
  let complete = true, entries = 0
  try {
    for (;;) {
      const entry = dir.readSync()
      if (entry === null) break
      if (++entries > 256) { complete = false; break }
      if (!entry.isDirectory() || !isValidProjectKey(entry.name)) continue
      const file = path.join(directory, entry.name, 'memory.db'), db = lstatSync(file, { throwIfNoEntry: false })
      if (db?.isFile() && !db.isSymbolicLink() && realpathSync(path.dirname(file)) === path.join(directory, entry.name)) {
        const folder = lstatSync(path.dirname(file))
        keys.push(entry.name); identities.push(`${entry.name}:${folder.dev}:${folder.ino}:${db.dev}:${db.ino}`)
      }
    }
  } finally { dir.closeSync() }
  keys.sort()
  // Diagnostic directory sample only. The reader below owns a streaming directory cursor, not this sample.
  return { keys, complete,
    marker: hash(`${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${identities.sort().join("|")}`) }
}

/** Metadata-only fence across budget windows; bodies and prior visibility proofs are never reused. */
function scanSnapshot(root: string): { stamp: string; complete: boolean } {
  const sources = profileSources(root), digest = createHash('sha256').update(sources.marker)
  const files = ['control/control.db', 'control/control.db-wal', 'global/persona.json']
  for (const key of sources.keys) files.push(`projects/${key}/memory.db`, `projects/${key}/memory.db-wal`)
  for (const file of files) {
    const stat = lstatSync(path.join(root, file), { bigint: true, throwIfNoEntry: false })
    // SQLite may create an empty WAL while opening a read-only connection.
    // No frames means no data change; actual commits alter WAL frames or the main DB.
    const identity = file.endsWith('-wal') && (stat === undefined || stat.size <= 32n) ? 'no-frames' :
      stat === undefined ? 'absent' : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    digest.update(`${file}:${identity};`)
  }
  return { stamp: digest.digest('hex'), complete: sources.complete }
}

type Request = Extract<ReadDashboardRequest, { action: 'global' }>
type Layer = GlobalMemoryItem['layer']
type Options = { root(): string; policy(): string; config: ResolvedConfig;
  inspectProgress(token: string): boolean; dropProgress(token: string): void;
  open(binding: DashboardReadBinding, ended: () => void): DashboardReadOutcome<DashboardVisibilityReadSession> }
type RelationRow = NonNullable<ReturnType<MemoryStore['globalRelationRow']>>
type SearchNode = { projectKey: string; id: string; revision: number; depth: number; score: number; direction: 'from' | 'to'; after: number }
type SearchState = { emitted: Map<string, 'profile_lexical' | 'relation'>; visited: Set<string>; queue: SearchNode[];
  pending?: { row: RelationRow; phase: number; evidenceIndex: number }; seeds: number; rows: number; relations: number; bodyBytes: number }
const newSearch = (saved?: SearchState): SearchState => ({ emitted: new Map(saved?.emitted), visited: new Set(saved?.visited),
  queue: saved?.queue.map((node) => ({ ...node })) ?? [], seeds: saved?.seeds ?? 0, rows: saved?.rows ?? 0, relations: saved?.relations ?? 0, bodyBytes: 0 })
const searchKey = (projectKey: string, id: string): string => `${projectKey}\0${id}`
type SceneProgress = {
  row: DashboardSceneMetaRow; name: string; hasMore: boolean; members: DashboardSceneMemberRow[];
  nextMember: number; afterOrdinal?: number; memberHasMore: boolean; phase: 'members' | 'proof' | 'final'; proofToken: string;
  lease: string;
}
type PersonaPlan = Parameters<DashboardVisibilityReadSession['readManagedPersonaBody']>[1]
type PersonaProgress = { key: string; plan?: PersonaPlan; nextIndex: number; members: DashboardSceneMemberRow[]; afterOrdinal?: number; hasMore: boolean; lease?: string }
type State = {
  snapshot: string;
  expiresAt?: number;
  processing: { queued: number; failed: number; uncertain: number; pendingApproval: number; latestIssue?: string }; latestIssueAt: number;
  id: string; cursor?: string; bookmark?: string; lastBatchPosition?: string; reader: DashboardVisibilityReadSession; request: Request; root: string; marker: string; policy: string;
  search?: SearchState; sourceDone: boolean; globalPersonaLease?: string; persona?: PersonaProgress;
  filePins: Map<string, { dev: number; ino: number }>; directory?: DirectoryPosition; directoryDone: boolean; resumed: boolean;
  keys: string[]; index: number; stage: number; ordinal: number; memoryAfter?: { createdAt: number; id: string };
  sceneAfter?: { memoryCount: number; name: string }; scene?: SceneProgress; counts: Record<Layer, number>; incomplete: boolean;
  days: Map<string, { date: string; added: number; updated: number; records: string[] }>;
  globalDone: boolean; globalLoaded: boolean; globalIndex: number; globalFile?: { file: string; identity: string }; globalPersona?: { content: string; updatedAt: number; sources: Array<{ projectKey: string; id: string; revision: number }> };
  calendarAfter?: { id: string; revision: number }; calendarId?: string;
  recentAdded: number; recent: GlobalMemoryItem[]; dayKeys: Set<string>; date: Intl.DateTimeFormat; now: number; rounds: number;
}
type Progress = Pick<State, 'root' | 'marker' | 'policy' | 'request' | 'directory' | 'directoryDone' | 'stage' | 'ordinal' | 'memoryAfter' | 'sceneAfter' | 'sourceDone' | 'snapshot' | 'now' | 'counts' | 'incomplete' | 'days' | 'dayKeys' | 'recent' | 'recentAdded' | 'processing' | 'latestIssueAt' | 'expiresAt' | 'calendarAfter' | 'calendarId' | 'globalLoaded' | 'globalDone' | 'globalIndex' | 'globalFile' | 'globalPersona'> & { search?: SearchState; key?: string; pin?: { dev: number; ino: number }; active?: State }
function directoryMarker(root: string): string {
  const directory = path.join(root, 'projects'), stat = lstatSync(directory, { throwIfNoEntry: false })
  if (stat === undefined) return 'absent'
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== path.join(realpathSync(root), 'projects')) throw new Error('stale')
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`
}
/** Bounded replay of directory positions: no bodies, and no unmetered rewind from the directory prefix. */
type DirectoryEntry = { name: string; directory: boolean }
class DirectoryStream {
  private base = 0
  private readonly entries: Array<DirectoryEntry | null> = []
  private readonly positions = new Map<DirectoryPosition, number>()
  constructor(private readonly dir: Dir) {}
  position(at = this.base): DirectoryPosition {
    if (at < this.base || at > this.base + this.entries.length) throw new Error('stale')
    const cursor = new DirectoryPosition(this)
    this.positions.set(cursor, at)
    return cursor
  }
  fork(cursor: DirectoryPosition): DirectoryPosition {
    const at = this.positions.get(cursor)
    if (at === undefined) throw new Error('stale')
    return this.position(at)
  }
  read(cursor: DirectoryPosition): DirectoryEntry | null {
    const at = this.positions.get(cursor)
    if (at === undefined) throw new Error('stale')
    const offset = at - this.base
    if (offset === this.entries.length) {
      if (this.entries.length >= 512) throw new Error('budget-exhausted')
      const entry = this.dir.readSync()
      // <=512 compact entries * (512 UTF-16 bytes +64 metadata) fit the existing 512KiB progress lease.
      this.entries.push(entry === null ? null : Buffer.byteLength(entry.name) > 256
        ? { name: '', directory: false } : { name: entry.name, directory: entry.isDirectory() })
    }
    const entry = this.entries[offset]!
    this.positions.set(cursor, at + 1); this.prune()
    return entry
  }
  release(cursor: DirectoryPosition): void {
    this.positions.delete(cursor)
    if (this.positions.size === 0) { this.entries.length = 0; try { this.dir.closeSync() } catch { /* closed */ } }
    else this.prune()
  }
  private prune(): void {
    const first = Math.min(...this.positions.values())
    if (Number.isFinite(first) && first > this.base) { this.entries.splice(0, first - this.base); this.base = first }
  }
}
class DirectoryPosition {
  constructor(private readonly stream: DirectoryStream) {}
  readSync(): DirectoryEntry | null { return this.stream.read(this) }
  fork(): DirectoryPosition { return this.stream.fork(this) }
  closeSync(): void { this.stream.release(this) }
}
function closeDirectory(directory?: DirectoryPosition): void { try { directory?.closeSync() } catch { /* already closed */ } }
const layers: Layer[] = ['L0', 'L1', 'L2', 'L3']
const emptyCounts = (): Record<Layer, number> => ({ L0: 0, L1: 0, L2: 0, L3: 0 })
const cost = (bytes: number) => ({ sqlStatements: 1, rowsVisited: 1, materializedBytes: bytes, keyBytes: 1024 })
function unwrap<T>(outcome: DashboardReadOutcome<T>): T {
  if (outcome.status !== 'ok') throw new Error(outcome.status)
  return outcome.value
}
function result(status: ReadDashboardResult['status'], complete: boolean, extra: Partial<ReadDashboardResult> = {}): ReadDashboardResult {
  return { version: 1, view: 'global', generatedAt: Date.now(), status, complete, ...extra }
}

export class GlobalMemoryReader {
  private readonly states = new Map<string, State>()
  private readonly progress = new Map<string, Progress>()
  private readonly terminals = new Set<string>()
  constructor(private readonly options: Options) {}
  owns(id: string): boolean { return this.states.has(id) || this.terminals.has(id) || this.progress.has(id) }
  close(): void { for (const state of [...this.states.values()]) this.retire(state); for (const token of [...this.progress.keys()]) this.options.dropProgress(token) }
  private ended(id: string): void {
    const state = this.states.get(id)
    if (state) closeDirectory(state.directory)
    this.states.delete(id); this.terminals.add(id)
    if (state?.bookmark !== undefined && this.progress.get(state.bookmark)?.active === state) {
      this.options.dropProgress(state.bookmark)
    }
    while (this.terminals.size > 128) this.terminals.delete(this.terminals.values().next().value!)
  }
  private retire(state: State): void { this.ended(state.id); state.reader.cancel() }
  read(input: ReadDashboardRequest): ReadDashboardResult {
    let state: State | undefined
    try {
      const request = ReadDashboardRequestSchema.parse(input)
      if (request.action === 'global') {
        if (request.relationDepth !== undefined && request.layer !== 'L1') throw new Error('unavailable')
        if (request.status !== undefined && (request.layer !== 'L1' || request.status === 'candidate' && request.relationDepth !== undefined)) throw new Error('unavailable')
        const root = realpathSync(this.options.root()), id = randomUUID(), marker = directoryMarker(root)
        if (Buffer.byteLength(root) > 4096) throw new Error('unavailable')
        const policy = this.options.policy(), snapshot = scanSnapshot(root)
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: request.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        const { resume, ...filter } = request
        const saved = resume === undefined ? undefined : this.progress.get(resume)
        if (resume !== undefined && (saved === undefined || saved.root !== root || saved.policy !== policy || saved.marker !== marker || saved.snapshot !== snapshot.stamp ||
            saved.expiresAt !== undefined && saved.expiresAt <= Date.now() ||
            JSON.stringify(saved.request) !== JSON.stringify(filter) || !this.options.inspectProgress(resume))) {
          if (resume !== undefined) this.options.dropProgress(resume)
          throw new Error('stale')
        }
        if (saved?.key !== undefined && saved.pin !== undefined) {
          const file = path.join(root, 'projects', saved.key, 'memory.db'), stat = lstatSync(file, { throwIfNoEntry: false })
          if (!stat?.isFile() || stat.isSymbolicLink() || stat.dev !== saved.pin.dev || stat.ino !== saved.pin.ino) {
            this.options.dropProgress(resume!); throw new Error('stale')
          }
        }
        if (saved?.active !== undefined) {
          state = saved.active
          if (this.states.get(state.id) !== state) throw new Error('stale')
          saved.active = undefined
          this.options.dropProgress(resume!); this.terminals.add(resume!)
          state.bookmark = undefined; state.rounds = 0
          unwrap(state.reader.resumeForRpc())
          return this.page(state)
        }
        const binding: DashboardReadBinding = { generationId: hash(root), policyKey: policy,
          filterKey: hash(JSON.stringify(filter)), asOf: saved?.now ?? Date.now(), viewKey: 'memory.global.v7', projectKeys: [] }
        const directory = saved?.directory?.fork() ?? (marker === 'absent' || saved?.directoryDone ? undefined : new DirectoryStream(opendirSync(path.join(root, 'projects'))).position())
        let reader: DashboardVisibilityReadSession
        try {
          reader = unwrap(this.options.open(binding, () => this.ended(state?.id ?? id)))
          try {
            unwrap(reader.reserveReadState(BASE_STATE_BYTES))
            if (request.layer === 'home') unwrap(reader.reserveReadState(HOME_STATE_BYTES))
            if (request.relationDepth !== undefined) unwrap(reader.reserveReadState(SEARCH_STATE_BYTES))
          }
          catch (error) { reader.cancel(); throw error }
        } catch (error) { closeDirectory(directory); throw error }
        state = { id, reader, bookmark: resume, request: filter, root, marker, policy, snapshot: snapshot.stamp, filePins: new Map(), keys: saved?.key === undefined ? [] : [saved.key], index: 0,
          expiresAt: saved?.expiresAt, calendarAfter: saved?.calendarAfter, calendarId: saved?.calendarId,
          processing: { ...(saved?.processing ?? { queued: 0, failed: 0, uncertain: 0, pendingApproval: 0 }) }, latestIssueAt: saved?.latestIssueAt ?? -1,
          directory,
          search: request.relationDepth === undefined ? undefined : newSearch(saved?.search), sourceDone: saved?.sourceDone ?? false,
          directoryDone: saved?.directoryDone ?? marker === 'absent', resumed: saved !== undefined,
          stage: saved?.stage ?? 0, ordinal: saved?.ordinal ?? 0, memoryAfter: saved?.memoryAfter, sceneAfter: saved?.sceneAfter,
          counts: { ...(saved?.counts ?? emptyCounts()) }, incomplete: (saved?.incomplete ?? false) || !snapshot.complete,
          days: new Map([...(saved?.days ?? [])].map(([key, day]) => [key, { ...day, records: [...day.records] }])), globalDone: saved?.globalDone ?? (request.layer !== 'home' && request.layer !== 'L3'),
          globalLoaded: saved?.globalLoaded ?? false, globalIndex: saved?.globalIndex ?? 0, globalFile: saved?.globalFile, globalPersona: saved?.globalPersona, recentAdded: saved?.recentAdded ?? 0,
          recent: [...(saved?.recent ?? [])], dayKeys: new Set(saved?.dayKeys), date, now: binding.asOf, rounds: 0 }
        this.states.set(id, state)
      } else if (request.action === 'continue' || request.action === 'close') {
        if (request.action === 'close' && this.progress.has(request.readId)) {
          this.options.dropProgress(request.readId); this.terminals.add(request.readId)
          return result('ok', true, { readId: request.readId })
        }
        state = this.states.get(request.readId)
        if (state === undefined && request.action === 'close' && this.terminals.has(request.readId)) return result('ok', true, { readId: request.readId })
        if (state === undefined) return result('stale', false, { reason: 'global-read-expired' })
        if (request.action === 'close') { this.retire(state); return result('ok', true, { readId: state.id }) }
        if (request.cursor !== state.cursor) return result('stale', false, { reason: 'global-cursor-used' })
        state.cursor = undefined
        unwrap(state.reader.resumeForRpc())
      } else return result('unavailable', false, { reason: 'global-request-invalid' })
      if (state.root !== realpathSync(this.options.root()) || state.policy !== this.options.policy() ||
          directoryMarker(state.root) !== state.marker) throw new Error('stale')
      return this.page(state)
    } catch (error) {
      if (state !== undefined) this.retire(state)
      const reason = error instanceof Error ? error.message : ''
      // Never return a payload from a failed final proof, nor leak provider/path errors.
      return result(reason === 'budget-exhausted' ? 'budget_exhausted' : reason === 'stale' ? 'stale' : 'unavailable', false,
        { ...(state === undefined ? {} : { readId: state.id }), reason: 'global-read-incomplete' })
    }
  }
  private page(state: State): ReadDashboardResult {
    const lease = unwrap(state.reader.reserveReadState(PAGE_STATE_BYTES))
    let released = false
    const release = (): void => { if (!released) { released = true; unwrap(state.reader.releaseReadState(lease.reservationToken)) } }
    try { return this.pageWithLease(state, release) }
    finally { if (!released) state.reader.releaseReadState(lease.reservationToken) }
  }
  private pageWithLease(state: State, release: () => void): ReadDashboardResult {
    const items: GlobalMemoryItem[] = []
    // One non-home item, bounded before serialization; no output body remains in State after handoff.
    unwrap(state.reader.chargeRead({ sqlStatements: 0, rowsVisited: 0, materializedBytes: 2 * WIRE_BYTES, keyBytes: 0 }, () => undefined))
    let steps = 0, windowFull = false
    const leaveProofGuard = state.reader.beginPersonaProofGuard(2)
    try {
    while ((!state.directoryDone || state.index < state.keys.length || !state.globalDone) && steps++ < 32 && items.length < 1) {
      const remaining = state.reader.remainingReadWork()
      if (remaining === undefined) throw new Error('stale')
      if (remaining.sqlStatements < 8 || remaining.materializedBytes < 64 * 1024 || remaining.keyBytes < 4096 || remaining.rowsVisited < 16 || items.reduce((bytes, item) => bytes + 4096 + Buffer.byteLength(item.content) * 4 +
        (item.memory?.sourceMessageIds.reduce((sum, id) => sum + Buffer.byteLength(id) * 2 + 32, 0) ?? 0) +
        item.sources.reduce((sum, source) => sum + Buffer.byteLength(source.id) * 2 + (source.sessionId?.length ?? 0) * 4 + 128, 0), 0) > 64 * 1024) break
      try {
      if (state.index >= state.keys.length && !state.directoryDone) {
        // One admitted directory entry at a time, retaining the OS iterator across budget windows.
        const entry = unwrap(state.reader.chargeRead({ sqlStatements: 0, rowsVisited: 1, materializedBytes: 4096, keyBytes: 1024 }, () => state.directory!.readSync()))
        if (entry === null) { closeDirectory(state.directory); state.directory = undefined; state.directoryDone = true; continue }
        if (!entry.directory || !isValidProjectKey(entry.name)) continue
        const file = path.join(state.root, 'projects', entry.name, 'memory.db'), stat = lstatSync(file, { throwIfNoEntry: false })
        if (!stat?.isFile() || stat.isSymbolicLink() || realpathSync(path.dirname(file)) !== path.join(state.root, 'projects', entry.name)) continue
        state.keys.push(entry.name)
      }
      if (state.index >= state.keys.length) {
        const nextSource = state.globalPersona?.sources[state.globalIndex]?.projectKey
        if (nextSource !== undefined && !state.reader.globalPublicationSources().includes(nextSource) &&
            state.reader.globalPublicationSources().length >= state.reader.globalPublicationSourceLimit()) { windowFull = true; break }
        this.globalPersonaStep(state, items); continue
      }
      const key = state.keys[state.index]!
      const bound = state.reader.globalPublicationSources()
      if (!bound.includes(key) && bound.length >= state.reader.globalPublicationSourceLimit()) { windowFull = true; break }
      unwrap(state.reader.selectGlobalSource(key))
      if (!state.filePins.has(key)) {
        const pin = unwrap(state.reader.readProject(key, { sqlStatements: 0, rowsVisited: 0, materializedBytes: 512, keyBytes: 256 }, (store) => store.dashboardFileIdentity()))
        if (pin === undefined) throw new Error('stale')
        state.filePins.set(key, pin)
      }
      const stage = state.request.layer === 'home' ? state.stage : layers.indexOf(state.request.layer)
      if (state.search !== undefined && state.search.queue.length > 0) { this.relationStep(state, items); continue }
      const done = state.sourceDone || this.step(state, key, stage, items)
      if (done && state.search !== undefined && state.search.queue.length > 0) { state.sourceDone = true; continue }
      if (done) this.advanceStage(state)
      } catch (error) {
        if (error instanceof Error && error.message === 'budget-exhausted' && state.reader.remainingReadWork() !== undefined) break
        throw error
      }
    }
    } finally { leaveProofGuard() }
    const finished = state.directoryDone && state.index >= state.keys.length && state.globalDone && (state.search?.queue.length ?? 0) === 0
    const expiry = state.reader.earliestVisibleExpiry()
    if (expiry !== undefined) state.expiresAt = state.expiresAt === undefined ? expiry : Math.min(state.expiresAt, expiry)
    if (state.expiresAt !== undefined && state.expiresAt <= Date.now()) throw new Error('stale')
    const complete = finished && !state.incomplete
    const relation = complete ? 'exact' as const : 'lower_bound' as const
    const counts = Object.fromEntries(layers.map((layer) => [layer, state.request.layer === 'home' || state.request.layer === layer
      ? { value: state.counts[layer], relation } : { value: null, relation: 'unknown' }])) as GlobalMemoryPage['counts']
    const config = this.options.config
    const pauseReasons: NonNullable<GlobalMemoryPage['pauseReasons']> = []
    if (!config.generateMemory) pauseReasons.push('generation_disabled')
    if (!config.capture.enabled) pauseReasons.push('capture_disabled')
    if (!config.extraction.enabled) pauseReasons.push('extraction_disabled')
    const global: GlobalMemoryPage = { layer: state.request.layer, query: state.request.query, items: state.request.layer === 'home' ? state.recent : items, counts,
      ...(state.request.layer === 'home' ? { processing: { ...state.processing } } : {}),
      days: [...state.days.values()].sort((a, b) => a.date.localeCompare(b.date)), activityComplete: complete && state.request.layer === 'home',
      recentAdded: state.request.layer === 'home' ? { value: state.recentAdded, relation: complete ? 'exact' : 'lower_bound' } : { value: null, relation: 'unknown' },
      year: state.request.year, timeZone: state.request.timeZone, generateMemory: this.options.config.generateMemory && this.options.config.capture.enabled && this.options.config.extraction.enabled,
      useMemory: config.useMemory && config.recall.enabled, paused: pauseReasons.length > 0, pauseReasons }
    const bytes = jsonBytes(global)
    if (bytes > WIRE_BYTES - 64) throw new Error('budget-exhausted')
    if (state.globalFile !== undefined) {
      const stat = lstatSync(state.globalFile.file, { throwIfNoEntry: false })
      const identity = stat === undefined ? 'absent' : stat.isSymbolicLink() ? 'symlink' : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      if (identity !== state.globalFile.identity) throw new Error('stale')
    }
    if (state.policy !== this.options.policy() || state.root !== realpathSync(this.options.root()) || directoryMarker(state.root) !== state.marker || scanSnapshot(state.root).stamp !== state.snapshot) throw new Error('stale')
    for (const [key, pin] of state.filePins) {
      const folder = path.join(state.root, 'projects', key), file = path.join(folder, 'memory.db'), stat = lstatSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || realpathSync(folder) !== folder) throw new Error('stale')
    }
    unwrap(state.reader.publishProof())
    release()
    const work = state.reader.remainingWork(), handoff = state.reader.finalBoundaryCost()
    // Measure AFTER publication, and reserve the still-unpaid suspend proof. The next
    // call's full allowance includes its resume probes; serialization was charged above.
    const exhausted = !finished && (windowFull || ++state.rounds >= 15 || work === undefined ||
      work.session.projects < state.reader.globalPublicationSources().length ||
      work.session.sqlStatements - handoff.sqlStatements < 64 || work.session.rowsVisited - handoff.rowsVisited < 2048 ||
      work.session.materializedBytes - handoff.materializedBytes < 1024 * 1024 || work.session.keyBytes - handoff.keyBytes < 64 * 1024)
    if (exhausted && (state.scene !== undefined || state.persona !== undefined)) {
      // Keep the ORIGINAL connections/version stamps. Reset only this bounded work
      // window; completed root proofs have been compacted, never replayed or skipped.
      const position = JSON.stringify([state.index, state.stage, state.scene?.name, state.scene?.phase,
        state.scene?.afterOrdinal, state.scene?.nextMember, state.persona?.afterOrdinal, state.persona?.nextIndex])
      if (position === state.lastBatchPosition) throw new Error('unavailable')
      state.lastBatchPosition = position
      const oldId = state.id
      const saved: Progress = { ...state, active: state, directory: undefined, key: state.keys[state.index],
        pin: state.filePins.get(state.keys[state.index] ?? '') }
      let next: string | undefined
      next = unwrap(state.reader.retainGlobalProgress(() => {
        if (saved.active !== undefined) { const active = saved.active; saved.active = undefined; this.retire(active) }
        if (next !== undefined) { this.progress.delete(next); this.terminals.add(next) }
      }, state.bookmark))
      this.progress.set(next, saved)
      const suspended = state.reader.suspendForRpc(undefined, true)
      if (suspended.status !== 'ok') { this.options.dropProgress(next); throw new Error(suspended.status) }
      this.states.delete(oldId); this.terminals.add(oldId)
      state.id = randomUUID(); state.bookmark = next; this.states.set(state.id, state)
      global.next = next
      return result('partial', false, { generatedAt: state.now, readId: oldId, global, reason: 'global-total-budget-limit' })
    }
    if (finished || exhausted) {
      let next: string | undefined
      if (exhausted && (!state.directoryDone || state.index < state.keys.length || !state.globalDone)) {
        const saved: Progress = { root: state.root, marker: state.marker, policy: state.policy, request: state.request,
          snapshot: state.snapshot, now: state.now, counts: { ...state.counts }, incomplete: state.incomplete,
          processing: { ...state.processing }, latestIssueAt: state.latestIssueAt,
          globalLoaded: state.globalLoaded, globalDone: state.globalDone, globalIndex: state.globalIndex, globalFile: state.globalFile, globalPersona: state.globalPersona,
          expiresAt: state.expiresAt, calendarAfter: state.calendarAfter, calendarId: state.calendarId,
          days: new Map([...state.days].map(([key, day]) => [key, { ...day, records: [...day.records] }])),
          dayKeys: new Set(state.dayKeys), recent: [...state.recent], recentAdded: state.recentAdded,
          directory: state.directory?.fork(), directoryDone: state.directoryDone, key: state.keys[state.index], pin: state.filePins.get(state.keys[state.index] ?? ''), stage: state.stage,
          ordinal: state.ordinal, memoryAfter: state.memoryAfter, sceneAfter: state.sceneAfter, sourceDone: state.sourceDone,
          search: state.search === undefined ? undefined : newSearch(state.search) }
        try { next = unwrap(state.reader.retainGlobalProgress(() => { closeDirectory(saved.directory); if (next !== undefined) { this.progress.delete(next); this.ended(next) } }, state.bookmark)) }
        catch (error) { closeDirectory(saved.directory); throw error }
        this.progress.set(next, saved)
      }
      try { unwrap(state.reader.advance(false)) } catch (error) { if (next !== undefined) this.options.dropProgress(next); throw error }
      this.ended(state.id)
      if (next !== undefined) global.next = next
      return result(complete ? 'ok' : 'partial', complete, { generatedAt: state.now, readId: state.id, global,
        ...(!complete ? { reason: windowFull ? 'global-source-window-limit' : exhausted ? 'global-total-budget-limit' : 'global-readable-set-partial' } : {}) })
    }
    const suspended = state.reader.suspendForRpc()
    if (suspended.status !== 'ok') throw new Error('budget-exhausted')
    state.cursor = randomUUID()
    return result('partial', false, { generatedAt: state.now, readId: state.id, cursor: state.cursor, global, reason: 'global-scan-pending' })
  }

  private advanceStage(state: State): void {
    state.sourceDone = false
    state.calendarAfter = undefined; state.calendarId = undefined; state.dayKeys.clear()
    state.ordinal = 0; state.memoryAfter = undefined; state.sceneAfter = undefined
    if (state.request.layer === 'home' && state.stage < 6) state.stage += 1
    else { state.stage = 0; state.index += 1 }
  }
  private globalPersonaStep(state: State, items: GlobalMemoryItem[]): void {
    if (state.globalLoaded && state.globalPersonaLease === undefined) state.globalPersonaLease = unwrap(state.reader.reserveReadState(512 * 1024)).reservationToken
    if (!state.globalLoaded) {
      const folder = path.join(state.root, 'global'), file = path.join(folder, 'persona.json')
      const directory = lstatSync(folder, { throwIfNoEntry: false }), stat = lstatSync(file, { throwIfNoEntry: false })
      if (stat === undefined) { state.globalFile = { file, identity: 'absent' }; state.globalDone = true; return }
      if (!directory?.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) { state.incomplete = true; state.globalDone = true; return }
      if (state.globalPersonaLease === undefined) state.globalPersonaLease = unwrap(state.reader.reserveReadState(512 * 1024)).reservationToken
      const raw = unwrap(state.reader.chargeRead({ sqlStatements: 0, rowsVisited: 1, materializedBytes: stat.size * 8 + 4096, keyBytes: 1024 }, () => {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        let value: unknown
        try {
          const opened = fstatSync(fd)
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('stale')
          value = JSON.parse(readFileSync(fd, 'utf8'))
        } finally { closeSync(fd) }
        const after = lstatSync(file)
        if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) throw new Error('stale')
        return value
      })) as Record<string, unknown>
      if (raw === null || typeof raw !== 'object' || typeof raw.content !== 'string' || Buffer.byteLength(raw.content) > 8192 ||
          raw.stale === true || typeof raw.updatedAt !== 'number' || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0 || raw.updatedAt > 8640000000000000 || !Array.isArray(raw.sources) || raw.sources.length === 0) { state.incomplete = true; state.globalDone = true; return }
      const sources: Array<{ projectKey: string; id: string; revision: number }> = []
      for (const item of raw.sources) {
        if (typeof item !== 'object' || item === null || typeof item.projectKey !== 'string' || !isValidProjectKey(item.projectKey) ||
            typeof item.id !== 'string' || Buffer.byteLength(item.id) > 256 || !Number.isSafeInteger(item.revision) || item.revision < 1) { state.incomplete = true; state.globalDone = true; return }
        sources.push({ projectKey: item.projectKey, id: item.id, revision: item.revision })
      }
      state.globalLoaded = true
      state.globalFile = { file, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }
      state.globalPersona = { content: raw.content, updatedAt: Number(raw.updatedAt), sources }
    }
    const persona = state.globalPersona
    if (persona === undefined) { state.globalDone = true; return }
    const source = persona.sources[state.globalIndex]
    if (source !== undefined) {
      const bound = state.reader.globalPublicationSources()
      if (!bound.includes(source.projectKey) && bound.length >= state.reader.globalPublicationSourceLimit()) {
        throw new Error('budget-exhausted')
      }
      unwrap(state.reader.selectGlobalSource(source.projectKey))
      if (!state.filePins.has(source.projectKey)) {
        const pin = unwrap(state.reader.readProject(source.projectKey, { sqlStatements: 0, rowsVisited: 0, materializedBytes: 512, keyBytes: 256 }, (store) => store.dashboardFileIdentity()))
        if (pin === undefined) throw new Error('stale')
        state.filePins.set(source.projectKey, pin)
      }
      const proof = unwrap(state.reader.proveManagedPersonaSource(source.projectKey, source.id, source.revision))
      if (proof !== 'visible') { state.incomplete = true; state.globalDone = true; return }
      state.globalIndex += 1
      return
    }
    const origin = persona.sources[0]!.projectKey
    this.emit(state, { key: globalMemoryKey(origin, 'global-persona'), layer: 'L3', projectKey: origin, id: 'global-persona',
      content: persona.content, createdAt: persona.updatedAt, updatedAt: persona.updatedAt,
      sources: persona.sources.map((source) => ({ id: source.id, projectKey: source.projectKey })), sourcesComplete: false }, items)
    state.globalDone = true
  }

  private emit(state: State, item: GlobalMemoryItem, items: GlobalMemoryItem[]): void {
    if (Buffer.byteLength(item.content) > (item.layer === 'L0' ? 32768 : item.layer === 'L1' ? 8192 : 65536) || itemResidentBytes(item) > PAGE_STATE_BYTES - 8192) { state.incomplete = true; return }
    const query = state.request.query.toLocaleLowerCase()
    if (!item.routes?.includes('relation') && query !== '' && !recallQueryTerms(query).some((term) => recallTermMatches(`${item.content}\n${item.scene ?? ''}`, term))) return
    if (state.request.scene !== undefined && (item.layer !== 'L1' || item.projectKey !== state.request.scene.projectKey ||
        (item.scene?.trim() || 'general') !== state.request.scene.name)) return
    const search = state.search, key = searchKey(item.projectKey, item.id)
    const route = item.routes?.includes('relation') ? 'relation' as const : 'profile_lexical' as const
    const prior = search?.emitted.get(key)
    if (prior !== undefined && (prior === 'profile_lexical' || route === 'relation')) return
    if (search !== undefined) {
      const retainedBytes = itemResidentBytes(item)
      if (prior === undefined && (search.emitted.size >= 50 || search.bodyBytes + retainedBytes > 128 * 1024)) { state.incomplete = true; return }
      if (prior === undefined) {
        unwrap(state.reader.reserveReadKeys(4 * Buffer.byteLength(key) + 128))
        search.bodyBytes += retainedBytes
      }
      search.emitted.set(key, route)
      item.routes = prior === 'relation' ? ['profile_lexical', 'relation'] : [route]
      if (route === 'profile_lexical') {
        const terms = recallQueryTerms(query), text = item.content.toLocaleLowerCase()
        item.score = terms.length === 0 ? 0 : terms.filter((term) => recallTermMatches(text, term)).length / terms.length
        if ((state.request.relationDepth ?? 0) > 0 && item.score > 0 && item.revision !== undefined && search.seeds < 8) {
          search.seeds += 1; search.visited.clear(); search.visited.add(key)
          search.queue.push({ projectKey: item.projectKey, id: item.id, revision: item.revision, depth: 0,
            score: item.score, direction: 'from', after: 0 })
        }
      }
    }
    if (prior === undefined) state.counts[item.layer] += 1
    if (state.request.layer !== 'home') items.push(item)
    else if (item.layer === 'L1') {
      state.recent = [...state.recent, { ...item, memory: undefined }].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)).slice(0, 8)
      while (state.recent.reduce((sum, row) => sum + itemResidentBytes(row), 0) > 128 * 1024) { state.recent.pop(); state.incomplete = true }
    }
  }
  private memoryItem(state: State, key: string, record: MemoryRecord): GlobalMemoryItem {
    const sources: GlobalMemoryItem['sources'] = []
    for (const id of record.sourceMessageIds.slice(0, 4)) {
      const label = unwrap(state.reader.readProject(key, cost(1024), (store) => store.globalSourceLabel(id)))
      if (label.createdAt === undefined || label.sessionId === undefined) state.incomplete = true
      sources.push({ id, ...label })
    }
    return { memory: { ...record, projectKey: key, projectName: key }, key: globalMemoryKey(key, record.id), layer: 'L1',
      projectKey: key, id: record.id, content: record.content, createdAt: record.createdAt, updatedAt: record.updatedAt,
      revision: record.revision, scene: record.scene, sources,
      sourcesComplete: sources.length === record.sourceMessageIds.length && sources.length > 0 && sources.every((source) => source.sessionId !== undefined && source.createdAt !== undefined) }
  }

  private relationStep(state: State, items: GlobalMemoryItem[]): void {
    const search = state.search!, node = search.queue[0]!
    if (search.relations >= 16 || search.emitted.size >= 50 || search.rows >= 40 && search.pending === undefined) {
      search.queue.length = 0; search.pending = undefined; state.incomplete = true; return
    }
    if (node.depth >= (state.request.relationDepth ?? 0)) { search.queue.shift(); return }
    if (search.pending === undefined) {
      // At most one indexed physical row, <=8 evidence strings; 64KiB covers raw JSON, decoded strings and row objects.
      const row = unwrap(state.reader.readProject(node.projectKey, { sqlStatements: 1, rowsVisited: 16,
        materializedBytes: 64 * 1024, keyBytes: 4096 }, (store) => store.globalRelationRow(node.id, node.direction, node.after)))
      if (row === undefined) {
        if (node.direction === 'from') { node.direction = 'to'; node.after = 0 }
        else search.queue.shift()
        return
      }
      search.rows += 1; search.pending = { row, phase: 0, evidenceIndex: 0 }
    }
    const pending = search.pending, row = pending.row
    const finish = (): void => { node.after = row.ordinal; search.pending = undefined }
    if (row.id === undefined || row.fromId === undefined || row.toId === undefined || row.type === undefined ||
        row.fromRevision === undefined || row.toRevision === undefined || row.createdAt === undefined || row.evidenceIds === undefined ||
        row.createdAt > state.now || (node.direction === 'from' ? row.fromId : row.toId) !== node.id) {
      state.incomplete = true; finish(); return
    }
    const other = row.fromId === node.id ? row.toId : row.fromId, key = searchKey(node.projectKey, other)
    if (search.visited.has(key)) { finish(); return }
    if (pending.phase < 2) {
      const id = pending.phase === 0 ? row.fromId : row.toId, revision = pending.phase === 0 ? row.fromRevision : row.toRevision
      const proof = unwrap(state.reader.resolveRoot(node.projectKey, id, 8192))
      if (proof.state !== 'visible' || proof.record === undefined || proof.record.revision !== revision ||
          id === node.id && revision !== node.revision) { if (proof.state === 'unresolved') state.incomplete = true; finish(); return }
      pending.phase += 1; return
    }
    if (pending.evidenceIndex < row.evidenceIds.length) {
      const proof = unwrap(state.reader.verifyGlobalRelationEvidence(node.projectKey, row.evidenceIds[pending.evidenceIndex]!))
      if (proof.state !== 'visible') { if (proof.state === 'unresolved') state.incomplete = true; finish(); return }
      pending.evidenceIndex += 1; return
    }
    // Re-read the emitted endpoint in this same ledger; earlier endpoints/evidence stay fenced by the final native proof.
    const target = unwrap(state.reader.resolveRoot(node.projectKey, other, 8192))
    const expectedRevision = row.fromId === other ? row.fromRevision : row.toRevision
    if (target.state !== 'visible' || target.record === undefined || target.record.revision !== expectedRevision) {
      if (target.state === 'unresolved') state.incomplete = true; finish(); return
    }
    const item = this.memoryItem(state, node.projectKey, target.record)
    const score = Math.max(.01, Math.min(.99, node.score * (node.depth === 0 ? .5 : .35)))
    item.routes = ['relation']; item.score = score
    unwrap(state.reader.reserveReadKeys(2 * Buffer.byteLength(key) + 64))
    this.emit(state, item, items)
    search.visited.add(key); search.relations += 1
    if (node.depth + 1 < (state.request.relationDepth ?? 0)) search.queue.push({ projectKey: node.projectKey, id: other,
      revision: target.record.revision, depth: node.depth + 1, score, direction: 'from', after: 0 })
    finish()
  }

  /** Stream complete membership under the original connection/version/TTL fence. */
  private sceneStep(state: State, key: string, items: GlobalMemoryItem[]): boolean {
    const reader = state.reader
    if (state.scene === undefined) {
      const page = unwrap(reader.readManagedSceneMetaPage(key, state.sceneAfter, 1))
      const row = page.rows[0]
      if (row === undefined) {
        if (page.hasMore) throw new Error('unavailable')
        return true
      }
      if (row.name === undefined) { state.incomplete = true; return true }
      if (row.nameBytes > 512 || !row.frontierReady || row.summaryBytes > 65_536) {
        state.incomplete = true; state.sceneAfter = { memoryCount: row.memoryCount, name: row.name }
        return !page.hasMore
      }
      const lease = unwrap(reader.reserveReadState(DERIVED_STATE_BYTES))
      const proofToken = unwrap(reader.beginManagedDerivedProof(key, 'L2', JSON.stringify([row.name, row.memoryCount,
        row.updatedAt, row.summaryBytes, row.summaryComplete])))
      state.scene = { row, name: row.name, hasMore: page.hasMore, members: [], nextMember: 0,
        memberHasMore: true, phase: 'members', proofToken, lease: lease.reservationToken }
      return false
    }
    const current = state.scene
    const finish = (unresolved = false): boolean => {
      if (unresolved) state.incomplete = true
      unwrap(reader.releaseReadState(current.lease)); reader.finishManagedDerivedProof(current.proofToken)
      state.sceneAfter = { memoryCount: current.row.memoryCount, name: current.name }
      state.scene = undefined
      return !current.hasMore
    }
    if (current.phase === 'members') {
      const page = unwrap(reader.readManagedSceneMembers(key, current.name, current.afterOrdinal, 15))
      if (page.rows.length === 0 && page.hasMore) throw new Error('unavailable')
      if (page.rows.some((member, index) => !isValidDashboardSceneMember(member) ||
          (index > 0 ? member.ordinal <= page.rows[index - 1]!.ordinal :
            current.afterOrdinal !== undefined && member.ordinal <= current.afterOrdinal)) ||
          unwrap(reader.managedDerivedDigest(current.proofToken)).count + page.rows.length > current.row.memoryCount) return finish(true)
      current.members = page.rows; current.nextMember = 0
      current.afterOrdinal = page.rows.at(-1)?.ordinal ?? current.afterOrdinal
      current.memberHasMore = page.hasMore
      current.phase = 'proof'
      return false
    }
    if (current.phase === 'proof') {
      if (current.nextMember < current.members.length) {
        const member = current.members[current.nextMember]!
        const proof = unwrap(reader.proveManagedSceneMember(key, member.memoryId!, member.revision))
        if (proof !== 'visible') return finish(proof !== 'hidden')
        unwrap(reader.commitManagedDerivedMember(current.proofToken, member))
        current.nextMember += 1
      } else {
        if (current.memberHasMore) current.phase = 'members'
        else if (unwrap(reader.managedDerivedDigest(current.proofToken)).count !== current.row.memoryCount) return finish(true)
        else current.phase = 'final'
      }
      return false
    }
    const final = unwrap(reader.readManagedSceneFinal(key, { name: current.name, memoryCount: current.row.memoryCount,
      updatedAt: current.row.updatedAt, summaryBytes: current.row.summaryBytes, summaryComplete: current.row.summaryComplete,
      memberCount: unwrap(reader.managedDerivedDigest(current.proofToken)).count,
      memberDigest: unwrap(reader.managedDerivedDigest(current.proofToken)).digest, proofToken: current.proofToken }))
    if (final.state !== 'visible' || final.summary === undefined) return finish(final.state !== 'hidden')
    this.emit(state, { key: globalMemoryKey(key, `scene/${current.name}`), layer: 'L2', projectKey: key, id: current.name,
      content: final.summary, scene: current.name, createdAt: current.row.updatedAt, updatedAt: current.row.updatedAt,
      sources: [], sourcesComplete: false }, items)
    return finish()
  }

  /** Page every persona source, compacting proofs before the next member. */
  private personaStep(state: State, key: string, items: GlobalMemoryItem[]): boolean {
    const reader = state.reader
    // The small pre-plan marker fits BASE_STATE_BYTES and also bounds failures before plan admission.
    const current: PersonaProgress = state.persona ??= { key, nextIndex: 0, members: [], hasMore: true }
    if (current.key !== key) throw new Error('stale')
    const finish = (unresolved = false): boolean => {
      if (unresolved) state.incomplete = true
      if (current.lease !== undefined) unwrap(reader.releaseReadState(current.lease))
      if (current.plan?.proofToken !== undefined) reader.finishManagedDerivedProof(current.plan.proofToken)
      state.persona = undefined
      return true
    }
    if (current.plan === undefined) {
      const plan = unwrap(reader.readManagedPersonaPlan(key, true))
      if (plan.state !== 'visible') return finish(plan.state !== 'hidden')
      if (plan.sourceIds === undefined || plan.sourceRevisions === undefined || plan.sourceCount === undefined ||
          plan.updatedAt === undefined || plan.contentBytes === undefined) return finish(true)
      if (plan.stale === true) return finish()
      const lease = unwrap(reader.reserveReadState(DERIVED_STATE_BYTES))
      current.plan = { sourceIds: [], sourceRevisions: {}, sourceCount: plan.sourceCount,
        updatedAt: plan.updatedAt, contentBytes: plan.contentBytes,
        proofToken: unwrap(reader.beginManagedDerivedProof(key, 'L3', JSON.stringify([plan.sourceCount, plan.updatedAt, plan.contentBytes]))) }
      current.lease = lease.reservationToken
      return false
    }
    const plan = current.plan
    if (current.nextIndex < current.members.length) {
      const member = current.members[current.nextIndex]!
      const proof = unwrap(reader.proveManagedPersonaSource(key, member.memoryId!, member.revision))
      if (proof !== 'visible') return finish(proof !== 'hidden')
      unwrap(reader.commitManagedDerivedMember(plan.proofToken!, member))
      current.nextIndex += 1
      return false
    }
    if (current.hasMore) {
      const page = unwrap(reader.readManagedPersonaSourcePage(key, current.afterOrdinal))
      const completed = unwrap(reader.managedDerivedDigest(plan.proofToken!)).count
      if (page.rows.length === 0 && page.hasMore || completed + page.rows.length > plan.sourceCount ||
          page.rows.some((row, index) => !isValidDashboardSceneMember(row) || row.ordinal !== completed + index)) return finish(true)
      current.members = page.rows; current.nextIndex = 0; current.hasMore = page.hasMore
      current.afterOrdinal = page.rows.at(-1)?.ordinal ?? current.afterOrdinal
      if (!page.hasMore && completed + page.rows.length !== plan.sourceCount) return finish(true)
      return false
    }
    const body = unwrap(reader.readManagedPersonaBody(key, plan))
    if (body.state !== 'visible' || body.content === undefined) return finish(body.state !== 'hidden')
    if (body.stale !== true) this.emit(state, { key: globalMemoryKey(key, 'persona'), layer: 'L3', projectKey: key,
      id: 'persona', content: body.content, createdAt: plan.updatedAt, updatedAt: plan.updatedAt, sources: [], sourcesComplete: false }, items)
    return finish()
  }

  private step(state: State, key: string, stage: number, items: GlobalMemoryItem[]): boolean {
    const reader = state.reader
    if (stage === 6) {
      const page = unwrap(reader.readManagedPage(key, 'candidate', state.memoryAfter, 1, 8192, 'global-v7'))
      for (const item of page.items) {
        if (item.state === 'visible') state.processing.pendingApproval++
        else if (item.state === 'unresolved') state.incomplete = true
      }
      state.memoryAfter = page.nextCursor
      return !page.hasMore
    }
    if (stage === 5) {
      // One job + at most 25 ownership keys and 24 indexed L0 identity probes; no source body is read.
      const row = unwrap(reader.readProject(key, { ...cost(4096), rowsVisited: 80 }, store => store.globalExtractionJobRow(state.ordinal)))
      if (row === undefined) return true
      state.ordinal = row.ordinal
      if (!row.sourcesComplete) state.incomplete = true
      if (row.hasPendingConversation && ['queued', 'ready', 'dispatching', 'result_ready'].includes(row.status)) state.processing.queued++
      if (row.status === 'failed') state.processing.failed++
      if (row.status === 'uncertain_remote') state.processing.uncertain++
      if (['failed', 'uncertain_remote'].includes(row.status) && row.updatedAt > state.latestIssueAt && row.error !== 'content_deleted') {
        state.latestIssueAt = row.updatedAt
        const reason = row.error.includes('max-tokens') ? '输出达到上限' : row.error.includes('invalid-json') ? '返回内容不是完整 JSON' :
          row.error.includes('policy_changed') ? '设置在提炼前发生变化' : '提炼未完成，原始对话仍保留'
        const time = Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 && row.updatedAt <= 8_640_000_000_000_000
          ? new Intl.DateTimeFormat('zh-CN', { timeZone: state.request.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(row.updatedAt) : '时间未知'
        state.processing.latestIssue = `${time} · ${row.provider || '未知来源'}/${row.model || '未知模型'}：${reason}`
      }
      return false
    }
    if (stage === 0) {
      const row = unwrap(reader.readProject(key, cost(34 * 1024), (store) => store.globalSourceRow(state.ordinal)))
      if (row === undefined) return true
      if (row.id === undefined || row.content === undefined || row.createdAt === undefined) { state.incomplete = true; state.ordinal = row.ordinal; return false }
      const proof = unwrap(reader.verifyCaptureEvent(key, row.id))
      if (proof.state === 'visible') this.emit(state, { key: globalMemoryKey(key, row.id), layer: 'L0', projectKey: key, id: row.id,
        content: row.content, createdAt: row.createdAt, updatedAt: row.createdAt,
        sources: [{ id: row.id, ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }), createdAt: row.createdAt }], sourcesComplete: row.sessionId !== undefined }, items)
      else if (proof.state === 'unresolved') state.incomplete = true
      state.ordinal = row.ordinal
      return false
    }
    if (stage === 1) {
      const page = unwrap(reader.readManagedPage(key, state.request.status ?? 'approved', state.memoryAfter, 1, 8192, 'global-v7'))
      for (const item of page.items) {
        if (item.state !== 'visible' || item.record === undefined) { if (item.state === 'unresolved') state.incomplete = true; continue }
        this.emit(state, this.memoryItem(state, key, item.record), items)
      }
      state.memoryAfter = page.nextCursor
      return !page.hasMore
    }
    if (stage === 2) return this.sceneStep(state, key, items)
    if (stage === 3) return this.personaStep(state, key, items)
    const row = unwrap(reader.readProject(key, cost(2048), (store) => store.globalCalendarRevision(state.calendarAfter)))
    if (row === undefined) return true
    if (row.id === undefined || row.revision === undefined) throw new Error('unavailable')
    state.calendarAfter = { id: row.id, revision: row.revision }
    if (state.calendarId !== row.id) { state.dayKeys.clear(); state.calendarId = row.id }
    if (row.at === undefined || row.reason === undefined) { state.incomplete = true; state.ordinal = row.ordinal; return false }
    if (row.at <= state.now && (row.revision === 1 || !/approv|forget|reject|review/i.test(row.reason))) {
      const parts = Object.fromEntries(state.date.formatToParts(row.at).map((part) => [part.type, part.value]))
      const date = `${parts.year}-${parts.month}-${parts.day}`
      const todayParts = Object.fromEntries(state.date.formatToParts(state.now).map((part) => [part.type, part.value]))
      const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`
      const recent = row.revision === 1 && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`) < 30 * 86400000
      if (Number(parts.year) === state.request.year || recent) {
        const proof = unwrap(reader.verifyEventMemory(key, row.id))
        if (proof.state === 'visible') {
          const kind = row.revision === 1 ? 'added' : 'updated', identity = `${date}:${kind}`
          if (!state.dayKeys.has(identity)) {
            state.dayKeys.add(identity)
            if (recent) state.recentAdded += 1
            if (Number(parts.year) === state.request.year) {
              const day = state.days.get(date) ?? { date, added: 0, updated: 0, records: [] }
              day[kind] += 1
              state.days.set(date, day)
            }
          }
        } else if (proof.state === 'unresolved') state.incomplete = true
      }
    }
    state.ordinal = row.ordinal
    return false
  }
}
