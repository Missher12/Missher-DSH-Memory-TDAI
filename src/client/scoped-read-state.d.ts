import type { ReadDashboardRequest, ReadDashboardResult } from '../remote-contract.js'

export type LibraryReadState = 'idle' | 'loading' | 'ready' | 'error'

export function libraryReadState(input: {
  active: boolean
  hasProject: boolean
  hasReader: boolean
  scope: string
  loadedScope: string
  errorScope: string | undefined
}): LibraryReadState

export type OverviewRestoreDecision = 'cancel' | 'wait' | 'restore'

export function overviewRestoreDecision(input: {
  pending: boolean
  active: boolean
  scopeMatches: boolean
  canRead: boolean
  loading: boolean
  contentReady: boolean
  targetReady: boolean
  failed: boolean
  interacted: boolean
}): OverviewRestoreDecision

type RepeatedEventDto = NonNullable<NonNullable<ReadDashboardResult['repeated']>['events']>[number]

export type RepeatedResultClassification =
  | { kind: 'failed'; reason: string; clear: true }
  | { kind: 'complete'; repeated: NonNullable<ReadDashboardResult['repeated']>; reason: undefined }
  | { kind: 'incomplete'; repeated: NonNullable<ReadDashboardResult['repeated']>; reason: string; status: string }

export function classifyRepeatedResult(result: ReadDashboardResult | undefined, target: 'groups' | 'events'): RepeatedResultClassification

export interface RepeatedReadController {
  /** Start a new generation; every in-flight result from an older token is stale. */
  start(): number | undefined
  isCurrent(token: number | undefined): boolean
  load(token: number | undefined, request: ReadDashboardRequest, options?: {
    maxContinuations?: number
    collectEvents?: boolean
  }): Promise<{ stale: true } | { error: unknown } | { result: ReadDashboardResult; events: RepeatedEventDto[] }>
  next(token: number | undefined, request: { readId: string; cursor: string }):
    Promise<{ stale: true } | { error: unknown } | { result: ReadDashboardResult }>
  resume(token: number | undefined, request: { readId: string; cursor: string }, options?: {
    maxContinuations?: number
    collectEvents?: boolean
  }): Promise<{ stale: true } | { error: unknown } | { result: ReadDashboardResult; events: RepeatedEventDto[] }>
  dispose(): void
}

export function createRepeatedReadController(input: {
  readDashboard?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>
}): RepeatedReadController

export interface DashboardReadController {
  start(transport?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>): number
  rebind(transport?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>): number
  isCurrent(token: number | undefined): boolean
  bind(readId: string | undefined): void
  load(token: number | undefined, request: ReadDashboardRequest, options?: { maxContinuations?: number }):
    Promise<{ stale: true } | { error: unknown } | { result: ReadDashboardResult }>
  /** Cancel admission and wait for in-flight work and its origin close to settle. */
  closeCurrent(): Promise<void>
  invalidate(): void
  dispose(): Promise<void>
  readonly readId: string | undefined
}
export function createDashboardReadController(input: {
  readDashboard?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>
}): DashboardReadController

/** At most twelve page owners; a transport admits two complete reader lifetimes. */
export interface DashboardReaderPool {
  get(name: string): DashboardReadController | undefined
  dispose(): Promise<void>
}
export function createDashboardReaderPool(input: {
  readDashboard?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>
}): DashboardReaderPool

export type DashboardScopeRange = NonNullable<Extract<ReadDashboardRequest, { action: 'bootstrap' }>['range']>
export function openDashboardScope(controller: DashboardReadController | undefined, token: number | undefined,
  projectKey: string, range: DashboardScopeRange): Promise<
    | { stale: true }
    | { error: unknown; result?: ReadDashboardResult }
    | { readId: string; result: ReadDashboardResult }
  >

export type DashboardScopedPageAction = 'overview' | 'persona' | 'globalPersona' | 'scene' | 'detail'
type OmitReadIdDistributively<T> = T extends unknown ? Omit<T, 'readId'> : never
type DashboardScopedPageRequest = OmitReadIdDistributively<Extract<ReadDashboardRequest, { action: DashboardScopedPageAction }>>
export function continueDashboardScopedPage(controller: DashboardReadController | undefined, token: number | undefined,
  readId: string, cursor: string, action: DashboardScopedPageAction, maxContinuations?: number): Promise<
    | { stale: true }
    | { error: unknown }
    | { readId: string; result: ReadDashboardResult; complete: boolean; cursor?: string }
  >

export function readDashboardScopedPage(controller: DashboardReadController | undefined, token: number | undefined, input: {
  projectKey: string
  range: DashboardScopeRange
  request: DashboardScopedPageRequest
  maxContinuations?: number
}): Promise<
  | { stale: true }
  | { error: unknown; result?: ReadDashboardResult }
  | { readId: string; result: ReadDashboardResult; complete: boolean; cursor?: string }
>


export interface DashboardProjectDirectorySnapshot {
  source: unknown
  status: 'idle' | 'loading' | 'ready' | 'partial' | 'error'
  projects: Array<{ key: string; name: string }>
  activeProjectKey?: string
}
export function createDashboardProjectDirectory(): {
  snapshot(): DashboardProjectDirectorySnapshot
  invalidate(source?: unknown): void
  begin(source: unknown): number
  fail(token: number, source: unknown): boolean
  commit(token: number, source: unknown, request: ReadDashboardRequest, result: ReadDashboardResult,
    projects?: Array<{ key: string; name: string }>): boolean
}


export interface OverviewDetailReturnContext {
  scope: string
  transport: unknown
  active: boolean
}

export function createOverviewDetailReturnController<T>(): {
  sync(context: OverviewDetailReturnContext): void
  capture(context: OverviewDetailReturnContext, origin: T): void
  close(context: OverviewDetailReturnContext): number | undefined
  peek(token: number | undefined): T | undefined
  interact(): void
  cancel(): void
  take(context: OverviewDetailReturnContext, token: number | undefined, readiness: {
    detailOpen: boolean
    rootReady: boolean
    targetReady: boolean
    scrollReady: boolean
  }): { origin: T; target: 'origin' | 'fallback'; restoreScroll: boolean } | undefined
}

export function resolveDashboardTheme(colorScheme: string | undefined, systemDark: boolean): 'light' | 'dark'
export function observeDashboardTheme(root: HTMLElement, onTheme: (theme: 'light' | 'dark') => void): () => void
