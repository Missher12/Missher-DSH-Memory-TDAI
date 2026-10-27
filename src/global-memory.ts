/** Profile-wide, pathless browse. Physical project keys are provenance, never UI scope choices. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, opendirSync, realpathSync, readFileSync, openSync, fstatSync, closeSync, constants, type Dir } from 'node:fs'
import path from 'node:path'
import { tokenize, type MemoryStore, type MemoryRecord } from './store.js'
import { isValidProjectKey } from './project.js'
import type { ResolvedConfig } from './config.js'
import type { DashboardReadBinding, DashboardReadOutcome } from './dashboard-read.js'
import { dashboardSceneMemberDigest, isValidDashboardSceneMember, type DashboardSceneMetaRow,
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
const HOME_STATE_BYTES = 192 * 1024
const PAGE_STATE_BYTES = 128 * 1024
// Preserve the existing 100-member ceiling. Each scene reserves 4KiB +1KiB/member
// and a separate 512 +288 bytes/member key lease; no summary body is retained.
const SCENE_MEMBER_LIMIT = 100
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

type Request = Extract<ReadDashboardRequest, { action: 'global' }>
type Layer = GlobalMemoryItem['layer']
type Options = { root(): string; policy(): string; config: ResolvedConfig;
  inspectProgress(token: string): boolean; dropProgress(token: string): void;
  open(binding: DashboardReadBinding, ended: () => void): DashboardReadOutcome<DashboardVisibilityReadSession> }
type RelationRow = NonNullable<ReturnType<MemoryStore['globalRelationRow']>>
type SearchNode = { projectKey: string; id: string; revision: number; depth: number; score: number; direction: 'from' | 'to'; after: number }
type SearchState = { emitted: Map<string, 'profile_lexical' | 'relation'>; visited: Set<string>; queue: SearchNode[];
  pending?: { row: RelationRow; phase: number; evidenceIndex: number }; seeds: number; rows: number; relations: number; bodyBytes: number }
const newSearch = (saved?: SearchState): SearchState => ({ emitted: new Map(), visited: new Set(saved?.visited),
  queue: saved?.queue.map((node) => ({ ...node })) ?? [], seeds: 0, rows: 0, relations: 0, bodyBytes: 0 })
const searchKey = (projectKey: string, id: string): string => `${projectKey}\0${id}`
type SceneProgress = {
  row: DashboardSceneMetaRow; name: string; hasMore: boolean; members: DashboardSceneMemberRow[];
  nextMember: number; afterOrdinal?: number; memberHasMore: boolean; phase: 'members' | 'proof' | 'final'; restarted: boolean;
  lease: string; keyLease: string;
}
type PersonaPlan = Parameters<DashboardVisibilityReadSession['readManagedPersonaBody']>[1]
type PersonaProgress = { key: string; plan?: PersonaPlan; nextIndex: number; restarted: boolean; lease?: string; keyLease?: string }
type State = {
  id: string; cursor?: string; bookmark?: string; reader: DashboardVisibilityReadSession; request: Request; root: string; marker: string; policy: string;
  search?: SearchState; sourceDone: boolean; globalPersonaLease?: string; persona?: PersonaProgress; personaRestart?: string;
  filePins: Map<string, { dev: number; ino: number }>; directory?: DirectoryPosition; directoryDone: boolean; resumed: boolean;
  keys: string[]; index: number; stage: number; ordinal: number; memoryAfter?: { createdAt: number; id: string };
  sceneAfter?: { memoryCount: number; name: string }; scene?: SceneProgress; sceneRestart?: string; counts: Record<Layer, number>; incomplete: boolean;
  days: Map<string, { date: string; added: number; updated: number; records: string[] }>;
  globalDone: boolean; globalLoaded: boolean; globalIndex: number; globalFile?: { file: string; identity: string }; globalPersona?: { content: string; updatedAt: number; sources: Array<{ projectKey: string; id: string; revision: number }> };
  dayBytes: number; recentAdded: number; recent: GlobalMemoryItem[]; dayKeys: Set<string>; date: Intl.DateTimeFormat; now: number; rounds: number;
}
type Progress = Pick<State, 'root' | 'marker' | 'policy' | 'request' | 'directory' | 'directoryDone' | 'stage' | 'ordinal' | 'memoryAfter' | 'sceneAfter' | 'sourceDone' | 'sceneRestart' | 'personaRestart'> & { search?: SearchState; key?: string; pin?: { dev: number; ino: number } }
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
  owns(id: string): boolean { return this.states.has(id) || this.terminals.has(id) }
  close(): void { for (const state of [...this.states.values()]) this.retire(state); for (const token of [...this.progress.keys()]) this.options.dropProgress(token) }
  private ended(id: string): void {
    const state = this.states.get(id)
    if (state) closeDirectory(state.directory)
    this.states.delete(id); this.terminals.add(id)
    while (this.terminals.size > 128) this.terminals.delete(this.terminals.values().next().value!)
  }
  private retire(state: State): void { this.ended(state.id); state.reader.cancel() }
  read(input: ReadDashboardRequest): ReadDashboardResult {
    let state: State | undefined
    try {
      const request = ReadDashboardRequestSchema.parse(input)
      if (request.action === 'global') {
        if (request.relationDepth !== undefined && request.layer !== 'L1') throw new Error('unavailable')
        const root = realpathSync(this.options.root()), id = randomUUID(), marker = directoryMarker(root)
        if (Buffer.byteLength(root) > 4096) throw new Error('unavailable')
        const policy = this.options.policy()
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: request.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        const { resume, ...filter } = request
        const saved = resume === undefined ? undefined : this.progress.get(resume)
        if (resume !== undefined && (saved === undefined || saved.root !== root || saved.policy !== policy || saved.marker !== marker ||
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
        const binding: DashboardReadBinding = { generationId: hash(root), policyKey: policy,
          filterKey: hash(JSON.stringify(filter)), asOf: Date.now(), viewKey: 'memory.global.v7', projectKeys: [] }
        const directory = saved?.directory?.fork() ?? (marker === 'absent' || saved?.directoryDone ? undefined : new DirectoryStream(opendirSync(path.join(root, 'projects'))).position())
        let reader: DashboardVisibilityReadSession
        try {
          reader = unwrap(this.options.open(binding, () => this.ended(id)))
          try {
            unwrap(reader.reserveReadState(BASE_STATE_BYTES))
            if (request.layer === 'home') unwrap(reader.reserveReadState(HOME_STATE_BYTES))
            if (request.relationDepth !== undefined) unwrap(reader.reserveReadState(SEARCH_STATE_BYTES))
          }
          catch (error) { reader.cancel(); throw error }
        } catch (error) { closeDirectory(directory); throw error }
        state = { id, reader, bookmark: resume, request: filter, root, marker, policy, filePins: new Map(), keys: saved?.key === undefined ? [] : [saved.key], index: 0,
          directory,
          search: request.relationDepth === undefined ? undefined : newSearch(saved?.search), sourceDone: saved?.sourceDone ?? false,
          directoryDone: saved?.directoryDone ?? marker === 'absent', resumed: saved !== undefined,
          stage: saved?.stage ?? 0, ordinal: saved?.ordinal ?? 0, memoryAfter: saved?.memoryAfter, sceneAfter: saved?.sceneAfter, sceneRestart: saved?.sceneRestart, personaRestart: saved?.personaRestart,
          counts: emptyCounts(), incomplete: saved !== undefined, days: new Map(), globalDone: request.layer !== 'home' && request.layer !== 'L3',
          globalLoaded: false, globalIndex: 0, dayBytes: 0, recentAdded: 0, recent: [], dayKeys: new Set(), date, now: binding.asOf, rounds: 0 }
        this.states.set(id, state)
      } else if (request.action === 'continue' || request.action === 'close') {
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
      if (state.index >= state.keys.length) { this.globalPersonaStep(state, items); continue }
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
      if (done) {
        state.sourceDone = false
        state.ordinal = 0; state.memoryAfter = undefined; state.sceneAfter = undefined; state.sceneRestart = undefined; state.personaRestart = undefined
        if (state.request.layer === 'home' && state.stage < 4) state.stage += 1
        else { state.stage = 0; state.index += 1 }
      }
      } catch (error) {
        if (error instanceof Error && error.message === 'budget-exhausted' && state.reader.remainingReadWork() !== undefined) break
        throw error
      }
    }
    } finally { leaveProofGuard() }
    const finished = state.directoryDone && state.index >= state.keys.length && state.globalDone && (state.search?.queue.length ?? 0) === 0
    const work = state.reader.remainingWork()
    // Reserve serialization, the final proof and the small progress lease before exhausting a ledger.
    const exhausted = !finished && (windowFull || ++state.rounds >= 15 || work === undefined ||
      work.session.projects < state.reader.globalPublicationSources().length ||
      // A fresh call may consume its full existing allowance; close before a session tail can undercut it.
      work.session.sqlStatements < 64 || work.session.rowsVisited < 2048 ||
      work.session.materializedBytes < 1024 * 1024 || work.session.keyBytes < 64 * 1024)
    // Bookmarks carry positions/restart identities, never trusted scene or persona proofs.
    // If a whole fresh window still cannot finish that item, fail without payload or another retry.
    if (exhausted && (state.scene?.restarted || state.persona?.restarted)) throw new Error('budget-exhausted')
    const complete = finished && !state.incomplete
    const relation = complete ? 'exact' as const : 'lower_bound' as const
    const counts = Object.fromEntries(layers.map((layer) => [layer, state.request.layer === 'home' || state.request.layer === layer
      ? { value: state.counts[layer], relation } : { value: null, relation: 'unknown' }])) as GlobalMemoryPage['counts']
    const global: GlobalMemoryPage = { layer: state.request.layer, query: state.request.query, items: state.request.layer === 'home' ? state.recent : items, counts,
      days: [...state.days.values()].sort((a, b) => a.date.localeCompare(b.date)), activityComplete: complete && state.request.layer === 'home',
      recentAdded: state.request.layer === 'home' ? { value: state.recentAdded, relation: complete ? 'exact' : 'lower_bound' } : { value: null, relation: 'unknown' },
      year: state.request.year, timeZone: state.request.timeZone, generateMemory: this.options.config.generateMemory && this.options.config.capture.enabled && this.options.config.extraction.enabled,
      useMemory: this.options.config.useMemory && this.options.config.recall.enabled, paused: this.options.config.budget.automaticDailyTokens === 0 || this.options.config.budget.automaticDailyTasks === 0 }
    const bytes = jsonBytes(global)
    if (bytes > WIRE_BYTES - 64) throw new Error('budget-exhausted')
    if (state.globalFile !== undefined) {
      const stat = lstatSync(state.globalFile.file, { throwIfNoEntry: false })
      const identity = stat === undefined ? 'absent' : stat.isSymbolicLink() ? 'symlink' : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      if (identity !== state.globalFile.identity) throw new Error('stale')
    }
    if (state.policy !== this.options.policy() || state.root !== realpathSync(this.options.root()) || directoryMarker(state.root) !== state.marker) throw new Error('stale')
    for (const [key, pin] of state.filePins) {
      const folder = path.join(state.root, 'projects', key), file = path.join(folder, 'memory.db'), stat = lstatSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || realpathSync(folder) !== folder) throw new Error('stale')
    }
    unwrap(state.reader.publishProof())
    release()
    if (finished || exhausted) {
      let next: string | undefined
      if (exhausted && (!state.directoryDone || state.index < state.keys.length)) {
        const saved: Progress = { root: state.root, marker: state.marker, policy: state.policy, request: state.request,
          directory: state.directory?.fork(), directoryDone: state.directoryDone, key: state.keys[state.index], pin: state.filePins.get(state.keys[state.index] ?? ''), stage: state.stage,
          ordinal: state.ordinal, memoryAfter: state.memoryAfter, sceneAfter: state.sceneAfter, sourceDone: state.sourceDone,
          sceneRestart: state.scene === undefined ? undefined : globalMemoryKey(state.keys[state.index]!, state.scene.name),
          personaRestart: state.persona?.key,
          search: state.search === undefined ? undefined : newSearch(state.search) }
        try { next = unwrap(state.reader.retainGlobalProgress(() => { closeDirectory(saved.directory); if (next !== undefined) this.progress.delete(next) }, state.bookmark)) }
        catch (error) { closeDirectory(saved.directory); throw error }
        this.progress.set(next, saved)
      }
      try { unwrap(state.reader.advance(false)) } catch (error) { if (next !== undefined) this.options.dropProgress(next); throw error }
      this.ended(state.id)
      if (next !== undefined) global.next = next
      return result(complete ? 'ok' : 'partial', complete, { readId: state.id, global,
        ...(!complete ? { reason: windowFull ? 'global-source-window-limit' : exhausted ? 'global-total-budget-limit' : 'global-readable-set-partial' } : {}) })
    }
    const suspended = state.reader.suspendForRpc()
    if (suspended.status !== 'ok') throw new Error('budget-exhausted')
    state.cursor = randomUUID()
    return result('partial', false, { readId: state.id, cursor: state.cursor, global, reason: 'global-scan-pending' })
  }
  private globalPersonaStep(state: State, items: GlobalMemoryItem[]): void {
    if (!state.globalLoaded) {
      const folder = path.join(state.root, 'global'), file = path.join(folder, 'persona.json')
      const directory = lstatSync(folder, { throwIfNoEntry: false }), stat = lstatSync(file, { throwIfNoEntry: false })
      if (stat === undefined) { state.globalFile = { file, identity: 'absent' }; state.globalDone = true; return }
      if (!directory?.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) { state.incomplete = true; state.globalDone = true; return }
      if (state.globalPersonaLease === undefined) state.globalPersonaLease = unwrap(state.reader.reserveReadState(128 * 1024)).reservationToken
      const raw = unwrap(state.reader.chargeRead({ sqlStatements: 0, rowsVisited: 1, materializedBytes: stat.size * 32 + 4096, keyBytes: 1024 }, () => {
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
          raw.stale === true || typeof raw.updatedAt !== 'number' || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0 || raw.updatedAt > 8640000000000000 || !Array.isArray(raw.sources) || raw.sources.length === 0 || raw.sources.length > 100) { state.incomplete = true; state.globalDone = true; return }
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
        state.incomplete = true; state.globalDone = true; return
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
    if (Buffer.byteLength(item.content) > 8192 || itemResidentBytes(item) > PAGE_STATE_BYTES - 8192) { state.incomplete = true; return }
    const query = state.request.query.toLocaleLowerCase()
    if (!item.routes?.includes('relation') && query !== '' && !tokenize(query).slice(0, 32).some((term) => `${item.content}\n${item.scene ?? ''}`.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) return
    if (state.request.scene !== undefined && (item.layer !== 'L1' || item.projectKey !== state.request.scene.projectKey || item.scene !== state.request.scene.name)) return
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
        const terms = tokenize(query).slice(0, 32), text = item.content.toLocaleLowerCase()
        item.score = terms.length === 0 ? 0 : terms.filter((term) => text.includes(term.toLocaleLowerCase())).length / terms.length
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

  /** Resume only within this reader's version/TTL-fenced memo; bookmarks restart from sceneAfter. */
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
      if (row.nameBytes > 512 || !row.frontierReady || row.summaryBytes > 65_536 || row.memoryCount > SCENE_MEMBER_LIMIT) {
        state.incomplete = true; state.sceneAfter = { memoryCount: row.memoryCount, name: row.name }; state.sceneRestart = undefined
        return !page.hasMore
      }
      const lease = unwrap(reader.reserveReadState(4096 + row.memoryCount * 1024))
      let keyLease: string
      try { keyLease = unwrap(reader.reserveReadKeys(512 + row.memoryCount * 288)).reservationToken }
      catch (error) { reader.releaseReadState(lease.reservationToken); throw error }
      state.scene = { row, name: row.name, hasMore: page.hasMore, members: [], nextMember: 0,
        memberHasMore: true, phase: 'members', restarted: state.sceneRestart === globalMemoryKey(key, row.name),
        lease: lease.reservationToken, keyLease }
      return false
    }
    const current = state.scene
    const finish = (unresolved = false): boolean => {
      if (unresolved) state.incomplete = true
      unwrap(reader.releaseReadState(current.lease)); unwrap(reader.releaseReadState(current.keyLease))
      state.sceneAfter = { memoryCount: current.row.memoryCount, name: current.name }
      state.scene = undefined; state.sceneRestart = undefined
      return !current.hasMore
    }
    if (current.phase === 'members') {
      const page = unwrap(reader.readManagedSceneMembers(key, current.name, current.afterOrdinal, 15))
      if (page.rows.length === 0 && page.hasMore) throw new Error('unavailable')
      if (page.rows.some((member, index) => !isValidDashboardSceneMember(member) ||
          (index > 0 ? member.ordinal <= page.rows[index - 1]!.ordinal :
            current.afterOrdinal !== undefined && member.ordinal <= current.afterOrdinal)) ||
          current.members.length + page.rows.length > Math.min(SCENE_MEMBER_LIMIT, current.row.memoryCount)) return finish(true)
      current.members.push(...page.rows)
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
        current.nextMember += 1
      } else {
        if (current.memberHasMore) current.phase = 'members'
        else if (current.members.length !== current.row.memoryCount) return finish(true)
        else current.phase = 'final'
      }
      return false
    }
    const final = unwrap(reader.readManagedSceneFinal(key, { name: current.name, memoryCount: current.row.memoryCount,
      updatedAt: current.row.updatedAt, summaryBytes: current.row.summaryBytes, summaryComplete: current.row.summaryComplete,
      memberCount: current.members.length, memberDigest: dashboardSceneMemberDigest(current.members) }))
    if (final.state !== 'visible' || final.summary === undefined) return finish(final.state !== 'hidden')
    this.emit(state, { key: globalMemoryKey(key, `scene/${current.name}`), layer: 'L2', projectKey: key, id: current.name,
      content: final.summary, scene: current.name, createdAt: current.row.updatedAt, updatedAt: current.row.updatedAt,
      sources: [], sourcesComplete: false }, items)
    return finish()
  }

  /** Only this reader owns source proof progress; a fresh bookmark starts again with Plan. */
  private personaStep(state: State, key: string, items: GlobalMemoryItem[]): boolean {
    const reader = state.reader
    // The small pre-plan marker fits BASE_STATE_BYTES and also bounds failures before plan admission.
    const current: PersonaProgress = state.persona ??= { key, nextIndex: 0, restarted: state.personaRestart === key }
    if (current.key !== key) throw new Error('stale')
    const finish = (unresolved = false): boolean => {
      if (unresolved) state.incomplete = true
      if (current.lease !== undefined) unwrap(reader.releaseReadState(current.lease))
      if (current.keyLease !== undefined) unwrap(reader.releaseReadState(current.keyLease))
      state.persona = undefined; state.personaRestart = undefined
      return true
    }
    if (current.plan === undefined) {
      const plan = unwrap(reader.readManagedPersonaPlan(key))
      if (plan.state !== 'visible') return finish(plan.state !== 'hidden')
      if (plan.sourceIds === undefined || plan.sourceRevisions === undefined || plan.sourceCount === undefined ||
          plan.updatedAt === undefined || plan.contentBytes === undefined) return finish(true)
      if (plan.stale === true) return finish()
      // The bounded transient plan fits the current page lease. Adopt it only after both
      // resident charges succeed: <=100 IDs plus revision-map entries; no body is retained.
      const lease = unwrap(reader.reserveReadState(4096 + plan.sourceIds.length * 1024))
      let keyLease: string
      try { keyLease = unwrap(reader.reserveReadKeys(512 + plan.sourceIds.reduce((bytes, id) => bytes + Buffer.byteLength(id) + 32, 0))).reservationToken }
      catch (error) { reader.releaseReadState(lease.reservationToken); throw error }
      current.plan = { sourceIds: plan.sourceIds, sourceRevisions: plan.sourceRevisions, sourceCount: plan.sourceCount,
        updatedAt: plan.updatedAt, contentBytes: plan.contentBytes }
      current.lease = lease.reservationToken; current.keyLease = keyLease
      return false
    }
    const plan = current.plan
    if (current.nextIndex < plan.sourceIds.length) {
      const id = plan.sourceIds[current.nextIndex]!
      const proof = unwrap(reader.proveManagedPersonaSource(key, id, plan.sourceRevisions[id]!))
      if (proof !== 'visible') return finish(true)
      current.nextIndex += 1
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
      const page = unwrap(reader.readManagedPage(key, 'approved', state.memoryAfter, 1, 8192, 'global-v7'))
      for (const item of page.items) {
        if (item.state !== 'visible' || item.record === undefined) { if (item.state === 'unresolved') state.incomplete = true; continue }
        this.emit(state, this.memoryItem(state, key, item.record), items)
      }
      state.memoryAfter = page.nextCursor
      return !page.hasMore
    }
    if (stage === 2) return this.sceneStep(state, key, items)
    if (stage === 3) return this.personaStep(state, key, items)
    const row = unwrap(reader.readProject(key, cost(2048), (store) => store.globalRevisionRow(state.ordinal)))
    if (row === undefined) return true
    if (row.id === undefined || row.at === undefined || row.revision === undefined || row.reason === undefined) { state.incomplete = true; state.ordinal = row.ordinal; return false }
    if (row.at <= state.now && (row.revision === 1 || !/approv|forget|reject|review/i.test(row.reason))) {
      const parts = Object.fromEntries(state.date.formatToParts(row.at).map((part) => [part.type, part.value]))
      const date = `${parts.year}-${parts.month}-${parts.day}`
      const todayParts = Object.fromEntries(state.date.formatToParts(state.now).map((part) => [part.type, part.value]))
      const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`
      const recent = row.revision === 1 && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`) < 30 * 86400000
      if (Number(parts.year) === state.request.year || recent) {
        const proof = unwrap(reader.verifyEventMemory(key, row.id))
        if (proof.state === 'visible') {
          const id = globalMemoryKey(key, row.id), kind = row.revision === 1 ? 'added' : 'updated', identity = `${date}:${kind}:${id}`
          if (!state.dayKeys.has(identity)) {
            const retainedBytes = 2 * Buffer.byteLength(identity) + 4 * Buffer.byteLength(id) + 512
            if (state.dayKeys.size >= 128 || state.dayBytes + retainedBytes > 48 * 1024) state.incomplete = true
            else {
              state.dayBytes += retainedBytes
              state.dayKeys.add(identity)
              if (recent) state.recentAdded += 1
              if (Number(parts.year) !== state.request.year) { state.ordinal = row.ordinal; return false }
              const day = state.days.get(date) ?? { date, added: 0, updated: 0, records: [] }
              day[kind] += 1
              if (!day.records.includes(id)) day.records.push(id)
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
