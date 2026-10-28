import { memoryYear, memoryMetric, readGlobalMemory, createMemorySettingsMutation, memoryDayPresentation, type MemoryDay } from './memory-v7-model.js'
import type { GlobalMemoryItem, GlobalMemoryPage } from '../remote-contract.js'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type {
  DashboardSnapshot, ExplainResult, ExportResult, LibraryResult, MemoryView, OverviewRequest, OverviewResult,
  ReadDashboardAck, ReadDashboardRequest, ReadDashboardResult, ReadDashboardSettings, UpdateSettingsRequest,
} from '../remote-contract.js'
import { boundedDimensionRows, boundedEventDetailRequest, boundedOverviewModel, boundedProjectSummaries, metricText } from './dashboard-view-model.js'
import { classifyRepeatedResult, continueDashboardScopedPage, createDashboardProjectDirectory, createDashboardReaderPool, createDashboardReadController, createOverviewDetailReturnController, createRepeatedReadController, libraryReadState, observeDashboardTheme, openDashboardScope, overviewRestoreDecision, readDashboardScopedPage } from './scoped-read-state.js'
import { createSettingsReadController, parseSettingsNumberDraft } from './settings-read-state.js'

export interface DashboardActions {
  load: () => Promise<DashboardSnapshot>
  review: (request: { projectKey: string; id: string; action: 'approve' | 'forget' }) => Promise<DashboardSnapshot>
  updateSettings: (request: {
    mode?: string
    recallMaxTokens?: number
    dedupeSession?: boolean
    includePersona?: boolean
    extractionEveryN?: number
    extractionEnabled?: boolean
    globalPersona?: boolean
  }) => Promise<DashboardSnapshot>
  updateSettingsAck?: (request: UpdateSettingsRequest) => Promise<ReadDashboardAck>
  reviewAck?: (request: { projectKey: string; id: string; action: 'approve' | 'forget' }) => Promise<ReadDashboardAck>
  refreshPersonaAck?: (projectKey: string) => Promise<ReadDashboardAck>
  refreshGlobalPersonaAck?: () => Promise<ReadDashboardAck>
  readDashboard?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>
  exportProject: (projectKey: string) => Promise<ExportResult>
  refreshPersona?: (projectKey: string) => Promise<DashboardSnapshot>
  refreshGlobalPersona?: () => Promise<DashboardSnapshot>
  overview?: (request: OverviewRequest) => Promise<OverviewResult>
  explain?: (request: { projectKey: string; query: string; limit?: number }) => Promise<ExplainResult>
  library?: (request: { projectKey: string; status?: 'candidate' | 'approved' | 'forgotten'; after?: { createdAt: number; id: string }; limit?: number }) => Promise<LibraryResult>
  manage?: (request: { projectKey: string; operation: string; payload?: Record<string, unknown> }) => Promise<unknown>
}

export interface DashboardProps extends Partial<DashboardActions> {
  /** Optional snapshot used by server-side previews and tests. */
  initialSnapshot?: DashboardSnapshot
}

type BoundedPage = NonNullable<ReadDashboardResult['page']>
type BoundedPersona = NonNullable<BoundedPage['personas']>[number]
type BoundedGlobal = NonNullable<BoundedPage['globalPersona']>
type BoundedScene = NonNullable<BoundedPage['scenes']>[number]
type BoundedRepeated = NonNullable<ReadDashboardResult['repeated']>
type BoundedRepeatedGroup = NonNullable<BoundedRepeated['groups']>[number]
type BoundedRepeatedEvent = NonNullable<BoundedRepeated['events']>[number]
type BoundedAreaState<T> = { status: 'idle' | 'loading' | 'ready' | 'partial' | 'error'; data?: T; error?: string; complete?: boolean; readId?: string; cursor?: string; hasHidden?: boolean }

/** Convert the bounded capture-event projection to the existing event card shape. */
function repeatedEventRow(event: BoundedRepeatedEvent): Record<string, unknown> {
  return { ...event, type: 'capture', occurredAt: event.createdAt, count: 1 } as Record<string, unknown>
}

type OverviewReturnState = {
  query: string
  libraryStatus: 'all' | 'candidate' | 'approved' | 'forgotten'
  scope: string
  scrollTarget: HTMLElement | null
  scrollTop: number
  focusKey?: string
}

type OverviewDetailOrigin = {
  trigger: HTMLElement
  root: HTMLElement
  scrollTarget: HTMLElement | null
  scrollTop: number
  scrollLeft: number
}

export function Dashboard(props: DashboardProps): ReactNode {
  if (!props.readDashboard || !props.updateSettingsAck || !props.manage) return <p role="alert">全局记忆服务不可用，请重新打开设置。</p>
  return <MemoryV7 {...props} readDashboard={props.readDashboard} updateSettingsAck={props.updateSettingsAck} manage={props.manage} />
}

interface BoundedClientView {
  activeProjectKey?: string
  projects: ReturnType<typeof boundedProjectSummaries>
  personas: BoundedPersona[]
  globalPersona: BoundedGlobal | null
  scenes: BoundedScene[]
  candidates: MemoryView[]
  recent: MemoryView[]
  lastError?: string
}

function boundedViewFromResult(result: ReadDashboardResult, extras: {
  personas?: BoundedPersona[]; globalPersona?: BoundedGlobal | null; scenes?: BoundedScene[]
} = {}): BoundedClientView {
  const page = result.page
  const memories = (items: NonNullable<typeof page>['candidates'] | undefined): MemoryView[] => (items ?? [])
    .filter((item) => item.content !== undefined)
    .map((item) => ({ ...item, content: item.content! }) as unknown as MemoryView)
  const global = extras.globalPersona ?? page?.globalPersona
  return {
    ...(page?.activeProjectKey === undefined ? {} : { activeProjectKey: page.activeProjectKey }),
    projects: boundedProjectSummaries(result),
    candidates: memories(page?.candidates), recent: memories(page?.recent),
    scenes: (extras.scenes ?? page?.scenes ?? []).map((scene) => ({ projectKey: scene.projectKey, projectName: scene.projectName,
      name: scene.name, summary: scene.summary, memoryCount: scene.memoryCount, summaryComplete: scene.summaryComplete })) as unknown as BoundedScene[],
    personas: (extras.personas ?? page?.personas ?? []).map((persona) => ({ projectKey: persona.projectKey, projectName: persona.projectName,
      content: persona.content, sourceCount: persona.sourceCount, updatedAt: persona.updatedAt, stale: persona.stale })),
    globalPersona: global === undefined || global === null ? null : {
      content: global.content, sourceCount: global.sourceCount, updatedAt: global.updatedAt, stale: global.stale,
    },
    ...(page?.lastError === undefined ? {} : { lastError: page.lastError }),
  }
}

function Loaded(props: DashboardActions & { initialSnapshot?: DashboardSnapshot }): ReactNode {
  const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const timeZoneOptions = [...new Set([systemTimeZone, 'UTC', 'Asia/Shanghai'])]
  const [previewSnapshot, setPreviewSnapshot] = useState<DashboardSnapshot | undefined>(props.initialSnapshot)
  const [boundedView, setBoundedView] = useState<BoundedClientView>()
  const snapshot = props.readDashboard !== undefined ? boundedView : previewSnapshot
  const [projectDirectory] = useState(createDashboardProjectDirectory)
  const [directoryState, setDirectoryState] = useState(projectDirectory.snapshot)
  const [directoryRefresh, setDirectoryRefresh] = useState(0)
  const scopeDirectory = directoryState.source === props.readDashboard ? directoryState : undefined
  const scopeProjects = scopeDirectory?.projects ?? []
  // Scoped summaries cannot replace the independently authorized directory.
  const viewProjectIdentities = props.readDashboard !== undefined ? scopeProjects
    : (previewSnapshot?.projects ?? []).map(({ key, name }) => ({ key, name }))
  const [boundedLibraryCursor, setBoundedLibraryCursor] = useState<string | undefined>(undefined)
  const scopeGeneration = useRef(0)
  const [failed, setFailed] = useState(false)
  const [scopeError, setScopeError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const settingsPreviewInitial = props.readDashboard === undefined && props.initialSnapshot?.settings !== undefined
  const [settingsPreview, setSettingsPreview] = useState(settingsPreviewInitial)
  const [settingsValue, setSettingsValue] = useState<ReadDashboardSettings | undefined>(() =>
    settingsPreviewInitial ? props.initialSnapshot?.settings : undefined)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsError, setSettingsError] = useState<string>()
  const [settingsNotice, setSettingsNotice] = useState<string>()
  const [settingsLastError, setSettingsLastError] = useState<string>()
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsReadRevision, setSettingsReadRevision] = useState(0)
  const [readViewsSuspended, setReadViewsSuspended] = useState(false)
  const readMutationHolds = useRef(0)
  const settingsControllerRef = useRef<ReturnType<typeof createSettingsReadController> | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string>()
  const [activeView, setActiveView] = useState<'overview' | 'memories' | 'review' | 'processing' | 'explain' | 'settings' | 'continuity' | 'experiences' | 'relations' | 'knowledge' | 'evaluation' | 'governance' | 'recovery'>('overview')
  const [selectedProjectKey, setSelectedProjectKey] = useState('')
  const [overviewTimeZone, setOverviewTimeZone] = useState(systemTimeZone)
  const [from, setFrom] = useState(() => shiftIsoCalendarDate(isoDateInTimeZone(new Date(), systemTimeZone), -364))
  const [to, setTo] = useState(() => isoDateInTimeZone(new Date(), systemTimeZone))
  const [heatmapMonth, setHeatmapMonth] = useState(() => isoDateInTimeZone(new Date(), systemTimeZone).slice(0, 7))
  const [activity, setActivity] = useState<'capture' | 'recall' | 'revision' | 'initial_approval' | 'injection'>('capture')
  const [overviewData, setOverviewData] = useState<OverviewResult>()
  const [boundedOverviewData, setBoundedOverviewData] = useState<ReadDashboardResult>()
  const [boundedOverviewCursor, setBoundedOverviewCursor] = useState<string>()
  const [overviewLoadedScope, setOverviewLoadedScope] = useState('')
  const [overviewError, setOverviewError] = useState<string>()
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [boundedPersonaArea, setBoundedPersonaArea] = useState<BoundedAreaState<BoundedPersona>>({ status: 'idle' })
  const [boundedGlobalArea, setBoundedGlobalArea] = useState<BoundedAreaState<BoundedGlobal | null>>({ status: 'idle' })
  const [boundedSceneArea, setBoundedSceneArea] = useState<BoundedAreaState<BoundedScene[]>>({ status: 'idle' })
  const [boundedAreaRefresh, setBoundedAreaRefresh] = useState({ persona: 0, global: 0, scene: 0 })
  const [explainQuery, setExplainQuery] = useState('')
  const [explainData, setExplainData] = useState<ExplainResult>()
  const [explainError, setExplainError] = useState<string>()
  const explainGeneration = useRef(0)
  const [libraryStatus, setLibraryStatus] = useState<'all' | 'candidate' | 'approved' | 'forgotten'>('all')
  const [libraryRecords, setLibraryRecords] = useState<MemoryView[]>([])
  const [libraryCursor, setLibraryCursor] = useState<{ createdAt: number; id: string }>()
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryPartial, setLibraryPartial] = useState(false)
  const [libraryLoadedScope, setLibraryLoadedScope] = useState('')
  const [libraryError, setLibraryError] = useState<{ scope: string; message: string }>()
  const [libraryRefresh, setLibraryRefresh] = useState(0)
  const [overviewRefresh, setOverviewRefresh] = useState(0)
  const [manageRefresh, setManageRefresh] = useState(0)
  const [manageData, setManageData] = useState<Record<string, unknown>>({})
  const [manageError, setManageError] = useState<string>()
  const [manageBusy, setManageBusy] = useState(false)
  const [manageResult, setManageResult] = useState<unknown>()
  const [manageResultProjectKey, setManageResultProjectKey] = useState<string>()
  const [processingJobsLoading, setProcessingJobsLoading] = useState(false)
  const [processingJobsFilter, setProcessingJobsFilter] = useState<'all' | 'queued' | 'failed' | 'uncertain' | 'oldest'>('all')
  const [evaluationRunsLoading, setEvaluationRunsLoading] = useState(false)
  const [evaluationCorpusFocus, setEvaluationCorpusFocus] = useState<{ caseId: string; recordId: string } | undefined>(undefined)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [repeatedExtra, setRepeatedExtra] = useState<Array<{ fingerprint: string; repeatCount: number }>>([])
  const [repeatedVisibleCount, setRepeatedVisibleCount] = useState(10)
  const [repeatedLoading, setRepeatedLoading] = useState(false)
  const [repeatedExhausted, setRepeatedExhausted] = useState(false)
  const [repeatedGroups, setRepeatedGroups] = useState<BoundedRepeatedGroup[]>([])
  const [repeatedReadState, setRepeatedReadState] = useState<'idle' | 'loading' | 'ready' | 'partial' | 'error'>('idle')
  const [repeatedReadNotice, setRepeatedReadNotice] = useState<string>()
  const [repeatedReadError, setRepeatedReadError] = useState<string>()
  const [repeatedScanCursor, setRepeatedScanCursor] = useState<string>()
  const [repeatedHasMore, setRepeatedHasMore] = useState(false)
  const [repeatedDetailCursor, setRepeatedDetailCursor] = useState<string>()
  const [detailReadError, setDetailReadError] = useState<string>()
  const [detailNotice, setDetailNotice] = useState<string>()
  const repeatedGroupGeneration = useRef(0)
  const repeatedDetailGeneration = useRef(0)
  const repeatedGroupControllerRef = useRef<ReturnType<typeof createRepeatedReadController> | undefined>(undefined)
  const repeatedDetailControllerRef = useRef<ReturnType<typeof createRepeatedReadController> | undefined>(undefined)
  const overviewReadTokenRef = useRef<number | undefined>(undefined)
  const personaReadTokenRef = useRef<number | undefined>(undefined)
  const globalPersonaReadTokenRef = useRef<number | undefined>(undefined)
  const sceneReadTokenRef = useRef<number | undefined>(undefined)
  const repeatedGroupReadTokenRef = useRef<number | undefined>(undefined)
  const repeatedDetailReadTokenRef = useRef<number | undefined>(undefined)
  const detailReadTokenRef = useRef<number | undefined>(undefined)
  const dashboardReaderPoolRef = useRef<ReturnType<typeof createDashboardReaderPool> | undefined>(undefined)
  if (dashboardReaderPoolRef.current === undefined) dashboardReaderPoolRef.current = createDashboardReaderPool({ readDashboard: props.readDashboard })
  const dashboardReader = (name: string): ReturnType<ReturnType<typeof createDashboardReaderPool>['get']> => dashboardReaderPoolRef.current?.get(name)
  useEffect(() => () => { dashboardReaderPoolRef.current?.dispose(); dashboardReaderPoolRef.current = undefined }, [])
  const [detailActivityOverride, setDetailActivityOverride] = useState<HeatmapActivity>()
  const detailActivity = detailActivityOverride ?? activity
  const [detailDate, setDetailDate] = useState('')
  const [detailRange, setDetailRange] = useState(false)
  const [detailDimension, setDetailDimension] = useState<'source' | 'agent' | 'agent_preset' | 'provider' | 'model'>('source')
  const [detailValue, setDetailValue] = useState('')
  const [detailFingerprint, setDetailFingerprint] = useState('')
  const [detailIncludeExcerpt, setDetailIncludeExcerpt] = useState(false)
  const [detailData, setDetailData] = useState<{ events: Array<Record<string, unknown>>; next?: { occurredAt: number; id: number } }>()
  const [boundedDetailCursor, setBoundedDetailCursor] = useState<string>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [knowledgeExpandedId, setKnowledgeExpandedId] = useState('')
  const [knowledgeFocusId, setKnowledgeFocusId] = useState('')
  const [knowledgeDetails, setKnowledgeDetails] = useState<Record<string, Record<string, unknown>>>({})
  const [knowledgeLoadingId, setKnowledgeLoadingId] = useState('')
  const knowledgeDetailGeneration = useRef(0)
  const [detailReturn] = useState(() => createOverviewDetailReturnController<OverviewDetailOrigin>())
  const [detailRestoreToken, setDetailRestoreToken] = useState<number>()
  const overviewReturnRef = useRef<OverviewReturnState | undefined>(undefined)
  const pendingOverviewRestoreRef = useRef<OverviewReturnState | undefined>(undefined)
  const sourceRevocationGeneration = useRef(0)
  const [taskRef, setTaskRef] = useState('')
  const [taskGoal, setTaskGoal] = useState('')
  const [taskConstraints, setTaskConstraints] = useState('')
  const [taskCompleted, setTaskCompleted] = useState('')
  const [taskPending, setTaskPending] = useState('')
  const [taskKnownUnknowns, setTaskKnownUnknowns] = useState('')
  const [taskConfirmedFacts, setTaskConfirmedFacts] = useState('')
  const [taskAssumptions, setTaskAssumptions] = useState('')
  const [taskBlockers, setTaskBlockers] = useState('')
  const [taskArtifactRefs, setTaskArtifactRefs] = useState('[]')
  const [taskSources, setTaskSources] = useState('')
  const [taskStatus, setTaskStatus] = useState('active')
  const [taskExpectedRevision, setTaskExpectedRevision] = useState<number>()
  const [experienceTitle, setExperienceTitle] = useState('')
  const [experienceStatus, setExperienceStatus] = useState<'candidate' | 'episode'>('candidate')
  const [experienceSymptom, setExperienceSymptom] = useState('')
  const [experienceEnvironment, setExperienceEnvironment] = useState('{}')
  const [experiencePrerequisites, setExperiencePrerequisites] = useState('')
  const [experienceSteps, setExperienceSteps] = useState('')
  const [experienceOutcomes, setExperienceOutcomes] = useState('')
  const [experienceCounterexamples, setExperienceCounterexamples] = useState('')
  const [experienceCounterexampleDrafts, setExperienceCounterexampleDrafts] = useState<Record<string, string>>({})
  const [experienceEvidence, setExperienceEvidence] = useState('')
  const [revisionMemoryId, setRevisionMemoryId] = useState('')
  const [revisionNumber, setRevisionNumber] = useState(1)
  const [revisionContent, setRevisionContent] = useState('')
  const [revisionReason, setRevisionReason] = useState('')
  const [revisionEvidence, setRevisionEvidence] = useState('')
  const [revisionValidFrom, setRevisionValidFrom] = useState('')
  const [revisionValidFromUnknown, setRevisionValidFromUnknown] = useState(false)
  const [selectedDeleteMemoryIds, setSelectedDeleteMemoryIds] = useState<string[]>([])
  const [selectedDeleteSourceIds, setSelectedDeleteSourceIds] = useState<string[]>([])
  const [selectedDeleteOffloadIds, setSelectedDeleteOffloadIds] = useState<string[]>([])
  const [contentDeletionPreview, setContentDeletionPreview] = useState<Record<string, unknown>>()
  const [revokeSourceId, setRevokeSourceId] = useState('')
  const [sourceRevocationPreview, setSourceRevocationPreview] = useState<Record<string, unknown>>()
  const [knowledgeHistory, setKnowledgeHistory] = useState<Record<string, Record<string, unknown>>>({})
  const [historyEffectiveAt, setHistoryEffectiveAt] = useState(() => dateTimeLocalValue(Date.now()))
  const [historyKnownAt, setHistoryKnownAt] = useState(() => dateTimeLocalValue(Date.now()))
  const [relationFrom, setRelationFrom] = useState('')
  const [relationTo, setRelationTo] = useState('')
  const [relationEvidence, setRelationEvidence] = useState('')
  const [relationType, setRelationType] = useState('supports')
  const [decisionId, setDecisionId] = useState('')
  const [evaluationId, setEvaluationId] = useState('')
  const [evaluationTitle, setEvaluationTitle] = useState('')
  const [evaluationQuery, setEvaluationQuery] = useState('')
  const [evaluationExpected, setEvaluationExpected] = useState('')
  const [evaluationForbidden, setEvaluationForbidden] = useState('')
  const [evaluationFixture, setEvaluationFixture] = useState('{"split":"train","records":[]}')
  const [evaluationStrategyId, setEvaluationStrategyId] = useState('')
  const [strategyTitle, setStrategyTitle] = useState('')
  const [strategyCandidates, setStrategyCandidates] = useState(50)
  const [strategyResults, setStrategyResults] = useState(6)
  const [attemptId, setAttemptId] = useState('')
  const [billableCallId, setBillableCallId] = useState('')
  const [attemptReason, setAttemptReason] = useState('')
  const [attemptDisposition, setAttemptDisposition] = useState<'charged' | 'retain_unknown'>('retain_unknown')
  const [recoverySnapshotId, setRecoverySnapshotId] = useState('')
  const libraryGeneration = useRef(0)
  const libraryReadTokenRef = useRef<number | undefined>(undefined)
  const generation = useRef(0)
  const overviewGeneration = useRef(0)
  const manageGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const actionScopeGeneration = useRef(0)
  const busyGeneration = useRef(0)
  const [overviewRestoreRevision, setOverviewRestoreRevision] = useState(0)
  const selectedProjectKeyRef = useRef(selectedProjectKey)
  selectedProjectKeyRef.current = selectedProjectKey
  const overviewScope = JSON.stringify([selectedProjectKey, from, to, overviewTimeZone, activity])
  const detailReturnScope = JSON.stringify([overviewScope, query])
  const detailReturnActive = activeView === 'overview' && selectedProjectKey !== '' && !readViewsSuspended && props.readDashboard !== undefined
  const detailReturnContext = { scope: detailReturnScope, transport: props.readDashboard, active: detailReturnActive }
  const captureDetailOrigin = (trigger: HTMLElement): void => {
    const root = trigger.closest<HTMLElement>('.tdai-root')
    if (root === null) { detailReturn.cancel(); return }
    const scrollTarget = scrollableAncestor(trigger)
    detailReturn.capture(detailReturnContext, { trigger, root, scrollTarget,
      scrollTop: scrollTarget?.scrollTop ?? window.scrollY, scrollLeft: scrollTarget?.scrollLeft ?? window.scrollX })
  }
  const closeOverviewDetail = (): void => {
    setDetailRestoreToken(detailReturn.close(detailReturnContext))
    setDetailActivityOverride(undefined)
    setDetailDate(''); setDetailValue(''); setDetailRange(false); setDetailFingerprint(''); setDetailIncludeExcerpt(false)
  }
  useLayoutEffect(() => {
    const onInteraction = (): void => detailReturn.interact()
    document.addEventListener('pointerdown', onInteraction, true)
    document.addEventListener('wheel', onInteraction, { capture: true, passive: true })
    document.addEventListener('touchstart', onInteraction, { capture: true, passive: true })
    document.addEventListener('keydown', onInteraction, true)
    document.addEventListener('focusin', onInteraction, true)
    return () => {
      detailReturn.cancel()
      document.removeEventListener('pointerdown', onInteraction, true)
      document.removeEventListener('wheel', onInteraction, true)
      document.removeEventListener('touchstart', onInteraction, true)
      document.removeEventListener('keydown', onInteraction, true)
      document.removeEventListener('focusin', onInteraction, true)
    }
  }, [detailReturn])
  useLayoutEffect(() => {
    const context = { scope: detailReturnScope, transport: props.readDashboard, active: detailReturnActive }
    detailReturn.sync(context)
    const saved = detailReturn.peek(detailRestoreToken)
    if (saved === undefined || detailDate !== '' || detailRange) return
    const frame = window.requestAnimationFrame(() => {
      const rootReady = detailReturnTargetReady(saved.root)
      const targetReady = saved.root.contains(saved.trigger) && detailReturnTargetReady(saved.trigger)
      const scrollReady = saved.scrollTarget === null || (saved.scrollTarget.isConnected && saved.scrollTarget.contains(saved.trigger))
      const result = detailReturn.take(context, detailRestoreToken, { detailOpen: false, rootReady, targetReady, scrollReady })
      if (result === undefined) return
      const fallback = saved.root.querySelector<HTMLElement>('[data-tdai-focus-key="overview-nav"]')
      const target = result.target === 'origin' ? saved.trigger
        : fallback !== null && detailReturnTargetReady(fallback) ? fallback : saved.root
      if (result.restoreScroll) {
        if (saved.scrollTarget !== null) {
          saved.scrollTarget.scrollTop = saved.scrollTop
          saved.scrollTarget.scrollLeft = saved.scrollLeft
        } else window.scrollTo({ top: saved.scrollTop, left: saved.scrollLeft, behavior: 'instant' })
      }
      target.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [detailReturn, detailRestoreToken, detailReturnScope, detailReturnActive, props.readDashboard, detailDate, detailRange])
  const invalidateActionScope = (): void => {
    actionScopeGeneration.current += 1
    busyGeneration.current += 1
    setBusy(false)
    setManageBusy(false)
  }
  const holdReadViews = (): void => {
    readMutationHolds.current += 1
    setReadViewsSuspended(true)
  }
  const releaseReadViews = (): void => {
    readMutationHolds.current = Math.max(0, readMutationHolds.current - 1)
    setReadViewsSuspended(readMutationHolds.current > 0)
  }
  const navigateView = (view: typeof activeView, trigger?: HTMLElement): void => {
    if (activeView === view) return
    if (activeView === 'overview' && view !== 'overview') {
      pendingOverviewRestoreRef.current = undefined
      const focus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      const scrollTarget = focus === null ? null : scrollableAncestor(focus)
      overviewReturnRef.current = { query, libraryStatus, scope: overviewScope, scrollTarget,
        scrollTop: scrollTarget?.scrollTop ?? window.scrollY,
        ...(focus?.dataset.tdaiFocusKey === undefined ? {} : { focusKey: focus.dataset.tdaiFocusKey }) }
    }
    if (activeView !== 'overview' && view === 'overview' && overviewReturnRef.current !== undefined) {
      const saved = overviewReturnRef.current
      if (saved.scope === overviewScope) {
        setQuery(saved.query)
        setLibraryStatus(saved.libraryStatus)
        setOverviewData(undefined)
        setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined)
        setOverviewLoadedScope('')
        setOverviewError(undefined)
        setOverviewLoading(selectedProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined))
        pendingOverviewRestoreRef.current = saved
      } else pendingOverviewRestoreRef.current = undefined
      overviewReturnRef.current = undefined
    }
    if ((activeView === 'memories' || activeView === 'review') && view !== 'memories' && view !== 'review') setLibraryLoadedScope('')
    invalidateActionScope()
    manageGeneration.current += 1
    knowledgeDetailGeneration.current += 1
    setManageData({})
    setManageError(undefined)
    setKnowledgeLoadingId('')
    setManageResult(undefined)
    setManageResultProjectKey(undefined)
    setActiveView(view)
  }
  const requestedLibraryStatus = activeView === 'review' ? 'candidate' : libraryStatus === 'all' ? undefined : libraryStatus
  const libraryScope = `${selectedProjectKey}\u0000${requestedLibraryStatus ?? 'all'}`
  const currentLibraryState = libraryReadState({ active: activeView === 'memories' || activeView === 'review',
    hasProject: selectedProjectKey !== '', hasReader: props.library !== undefined || props.readDashboard !== undefined, scope: libraryScope,
    loadedScope: libraryLoadedScope, errorScope: libraryError?.scope })
  const visibleLibraryRecords = currentLibraryState === 'ready' ? libraryRecords : []
  const visibleLibraryCursor = currentLibraryState === 'ready' ? libraryCursor : undefined
  const visibleBoundedLibraryCursor = currentLibraryState === 'ready' ? boundedLibraryCursor : undefined
  const visibleLibraryLoading = currentLibraryState === 'loading' || (currentLibraryState === 'ready' && libraryLoading)
  const visibleLibraryError = currentLibraryState === 'error' ? libraryError?.message : undefined

  const changeLibraryQuery = (nextQuery: string): void => {
    setQuery(nextQuery)
    if (overviewReturnRef.current !== undefined) overviewReturnRef.current = { ...overviewReturnRef.current, query: nextQuery }
  }
  const changeLibraryStatus = (nextStatus: typeof libraryStatus): void => {
    setLibraryStatus(nextStatus)
    if (overviewReturnRef.current !== undefined) overviewReturnRef.current = { ...overviewReturnRef.current, libraryStatus: nextStatus }
  }

  const invalidateSnapshotReads = (): void => { generation.current += 1 }

  const refreshBounded = useCallback(async (): Promise<void> => {
    const readDashboard = props.readDashboard
    if (readDashboard === undefined) return
    const controller = dashboardReader('scope')
    if (controller === undefined) return
    let controllerToken = controller.start(readDashboard)
    const current = scopeGeneration.current + 1
    scopeGeneration.current = current
    let directoryToken: number | undefined
    setBoundedLibraryCursor(undefined)
    setBoundedView(undefined)
    setFailed(false)
    setScopeError(undefined)
    try {
      const known = projectDirectory.snapshot()
      if (selectedProjectKey === '' || known.source !== readDashboard || (known.status !== 'ready' && known.status !== 'partial')) {
        const request: ReadDashboardRequest = { version: 1, action: 'bootstrap', projectKeys: [] }
        directoryToken = projectDirectory.begin(readDashboard)
        setDirectoryState(projectDirectory.snapshot())
        const first = await controller.load(controllerToken, request)
        if ('stale' in first) return
        if ('error' in first) throw first.error
        let directory = first.result
        const directoryReadId = directory.readId
        const projects = new Map<string, { key: string; name: string }>()
        for (const project of directory.projects ?? []) projects.set(project.key, { key: project.key, name: project.name })
        let directoryPages = 0
        while (directoryReadId !== undefined && directory.cursor !== undefined && !directory.complete && directoryPages < 16) {
          const page = await controller.load(controllerToken, { version: 1, action: 'continue', readId: directoryReadId, cursor: directory.cursor })
          if ('stale' in page) return
          if ('error' in page) throw page.error
          directory = page.result
          for (const project of directory.projects ?? []) projects.set(project.key, { key: project.key, name: project.name })
          directoryPages += 1
        }
        if (scopeGeneration.current !== current || !controller.isCurrent(controllerToken)) return
        if (!projectDirectory.commit(directoryToken, readDashboard, request, directory, [...projects.values()])) return
        const nextDirectory = projectDirectory.snapshot()
        setDirectoryState(nextDirectory)
        if (nextDirectory.status === 'error') throw new Error(directory.reason ?? '项目目录读取失败')
        if (nextDirectory.status === 'partial') setScopeError('项目目录读取不完整；可刷新目录。')
        await controller.closeCurrent()
        if (scopeGeneration.current !== current || !controller.isCurrent(controllerToken)) return
        if (selectedProjectKey === '' || !nextDirectory.projects.some((project) => project.key === selectedProjectKey)) return
        controllerToken = controller.start(readDashboard)
      }
      const scoped = await controller.load(controllerToken, { version: 1, action: 'bootstrap',
        projectKeys: [selectedProjectKey], range: { from, to, timeZone: overviewTimeZone, activity } })
      if ('stale' in scoped) return
      if ('error' in scoped) throw scoped.error
      if (scopeGeneration.current !== current || !controller.isCurrent(controllerToken)) return
      setBoundedView(boundedViewFromResult(scoped.result))
    } catch (error: unknown) {
      if (scopeGeneration.current === current) {
        if (directoryToken !== undefined && projectDirectory.snapshot().status === 'loading') {
          projectDirectory.fail(directoryToken, readDashboard)
          setDirectoryState(projectDirectory.snapshot())
        }
        setFailed(true)
        setScopeError(error instanceof Error ? error.message : 'bounded project scope unavailable')
      }
    } finally {
      if (scopeGeneration.current === current && controller.isCurrent(controllerToken)) await controller.closeCurrent()
    }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, overviewScope, projectDirectory, directoryRefresh])

  useEffect(() => () => {
    scopeGeneration.current += 1
    projectDirectory.invalidate()
    setDirectoryState(projectDirectory.snapshot())
    setBoundedLibraryCursor(undefined)
  }, [props.readDashboard, projectDirectory])

  const refresh = useCallback(async (): Promise<void> => {
    if (props.readDashboard !== undefined) { await refreshBounded(); return }
    if (props.initialSnapshot !== undefined) return
    const current = generation.current + 1
    generation.current = current
    setFailed(false)
    try {
      const next = await props.load()
      if (generation.current === current) setPreviewSnapshot(next)
    } catch {
      if (generation.current === current) setFailed(true)
    }
  }, [props.load, props.readDashboard, props.initialSnapshot, refreshBounded])

  useEffect(() => {
    if (props.readDashboard !== undefined) {
      if (readViewsSuspended) { setOverviewLoading(false); return }
      if (selectedProjectKey !== '') setOverviewLoading(true)
      void refreshBounded()
    } else void refresh()
    return () => {
      generation.current += 1
      scopeGeneration.current += 1
      dashboardReaderPoolRef.current?.get('scope')?.start(props.readDashboard)
    }
  }, [refresh, refreshBounded, props.readDashboard, selectedProjectKey, readViewsSuspended])

  const readSettings = useCallback(async (): Promise<boolean> => {
    const controller = settingsControllerRef.current
    if (controller === undefined) return false
    const read = controller.startRead()
    const readToken = read.token
    if (readToken === undefined) return false
    setSettingsLoading(true)
    setSettingsError(undefined)
    setSettingsNotice(undefined)
    setSettingsLastError(undefined)
    const result = await read.promise
    if (!controller.isLatestRead(readToken)) return false
    setSettingsLoading(false)
    if (result.kind === 'applied') {
      setSettingsValue(result.settings)
      setSettingsLastError(result.lastError)
      setSettingsReadRevision((revision) => revision + 1)
      setSettingsPreview(false)
      return true
    }
    if (result.kind === 'failure') setSettingsError(result.message)
    return false
  }, [])

  useEffect(() => {
    const settingsReader = dashboardReaderPoolRef.current?.get('settings')
      ?? createDashboardReadController({ readDashboard: props.readDashboard })
    const controller = createSettingsReadController({
      readDashboard: props.readDashboard === undefined ? undefined : async (request) => {
        const token = settingsReader.start(props.readDashboard)
        const outcome = await settingsReader.load(token, request)
        if ('stale' in outcome || !settingsReader.isCurrent(token)) throw new Error('配置读取已取消')
        if ('error' in outcome) throw outcome.error
        await settingsReader.closeCurrent()
        if (!settingsReader.isCurrent(token)) throw new Error('配置读取已取消')
        // This adapter has awaited the close; the settings controller receives
        // the metadata without a live reader to close a second time.
        const metadata = { ...outcome.result }
        delete metadata.readId
        return metadata
      },
      updateSettingsAck: props.updateSettingsAck,
    })
    settingsControllerRef.current = controller
    setSettingsLoading(false)
    setSettingsSaving(false)
    setSettingsReadRevision((revision) => revision + 1)
    if (props.readDashboard !== undefined && settingsPreview) {
      setSettingsPreview(false)
      setSettingsValue(undefined)
    }
    if (props.readDashboard === undefined && settingsPreview) return () => {
      controller.dispose()
      settingsReader.start(props.readDashboard)
      if (settingsControllerRef.current === controller) settingsControllerRef.current = undefined
    }
    if (props.readDashboard === undefined) setSettingsValue(undefined)
    void readSettings()
    return () => {
      controller.dispose()
      settingsReader.start(props.readDashboard)
      if (settingsControllerRef.current === controller) settingsControllerRef.current = undefined
    }
  }, [props.readDashboard, props.updateSettingsAck, readSettings])

  const saveSettings = useCallback(async (patch: UpdateSettingsRequest, message?: string): Promise<void> => {
    const controller = settingsControllerRef.current
    if (controller === undefined) return
    const save = controller.startSave(patch)
    if (!save.started) {
      if (save.reason === 'unavailable') setSettingsError('配置保存接口不可用')
      return
    }
    const saveToken = save.token
    setSettingsLoading(false)
    setSettingsSaving(true)
    setSettingsError(undefined)
    setSettingsNotice(undefined)
    const result = await save.promise
    if (!controller.isLatestSave(saveToken)) return
    setSettingsSaving(false)
    if (result.kind === 'saved') {
      setSettingsValue(result.settings)
      setSettingsLastError(result.lastError)
      setSettingsReadRevision((revision) => revision + 1)
      setSettingsPreview(false)
      setSettingsNotice(`${result.acknowledgement}${message === undefined ? '' : ` · ${message}`}`)
      return
    }
    if (result.kind === 'read-failed') {
      setSettingsError(result.message)
      setSettingsNotice(`${result.acknowledgement}；配置回读失败`)
      setSettingsReadRevision((revision) => revision + 1)
      return
    }
    if (result.kind === 'rejected' || result.kind === 'failed') {
      setSettingsError(result.message)
      setSettingsReadRevision((revision) => revision + 1)
    }
  }, [])

  useEffect(() => {
    if (props.readDashboard !== undefined) {
      if (scopeDirectory === undefined || scopeDirectory.status === 'idle' || scopeDirectory.status === 'loading') return
      if (selectedProjectKey === '' && scopeDirectory.activeProjectKey !== undefined) setSelectedProjectKey(scopeDirectory.activeProjectKey)
      if (selectedProjectKey !== '' && !scopeDirectory.projects.some((project) => project.key === selectedProjectKey)) setSelectedProjectKey('')
      return
    }
    if (selectedProjectKey === '' && snapshot?.activeProjectKey !== undefined) setSelectedProjectKey(snapshot.activeProjectKey)
    if (snapshot !== undefined && selectedProjectKey !== '' && !snapshot.projects.some((project) => project.key === selectedProjectKey)) setSelectedProjectKey('')
  }, [snapshot, selectedProjectKey, props.readDashboard, scopeDirectory])

  useEffect(() => { invalidateActionScope() }, [props.readDashboard])

  useEffect(() => {
    invalidateActionScope()
    setManageResult(undefined)
    setManageResultProjectKey(undefined)
    setManageError(undefined)
    setNotice(undefined)
    setDetailActivityOverride(undefined)
    setDetailDate('')
    setDetailRange(false)
    setDetailValue('')
    setDetailFingerprint('')
    setDetailIncludeExcerpt(false)
    setDetailData(undefined)
    knowledgeDetailGeneration.current += 1
    setKnowledgeExpandedId('')
    setKnowledgeFocusId('')
    setKnowledgeDetails({})
    setKnowledgeLoadingId('')
    sourceRevocationGeneration.current += 1
    setSourceRevocationPreview(undefined)
    return () => { actionScopeGeneration.current += 1 }
  }, [selectedProjectKey])

  useEffect(() => {
    setManageResult(undefined)
    setManageResultProjectKey(undefined)
    setManageError(undefined)
    setTaskRef(''); setTaskGoal(''); setTaskConstraints(''); setTaskCompleted(''); setTaskPending('')
    setTaskKnownUnknowns(''); setTaskConfirmedFacts(''); setTaskAssumptions(''); setTaskBlockers(''); setTaskArtifactRefs('[]')
    setTaskSources(''); setTaskStatus('active'); setTaskExpectedRevision(undefined)
    setExperienceTitle(''); setExperienceSymptom(''); setExperienceEnvironment('{}'); setExperiencePrerequisites('')
    setExperienceStatus('candidate')
    setExperienceSteps(''); setExperienceOutcomes(''); setExperienceCounterexamples(''); setExperienceEvidence(''); setExperienceCounterexampleDrafts({})
    setRevisionMemoryId(''); setRevisionNumber(1); setRevisionContent(''); setRevisionReason(''); setRevisionEvidence('')
    setRevisionValidFrom(''); setRevisionValidFromUnknown(false)
    setSelectedDeleteMemoryIds([]); setSelectedDeleteSourceIds([]); setSelectedDeleteOffloadIds([]); setContentDeletionPreview(undefined)
    setRevokeSourceId(''); setSourceRevocationPreview(undefined); setKnowledgeHistory({})
    setHistoryEffectiveAt(dateTimeLocalValue(Date.now())); setHistoryKnownAt(dateTimeLocalValue(Date.now()))
    setRelationFrom(''); setRelationTo(''); setRelationEvidence(''); setRelationType('supports'); setDecisionId('')
    setEvaluationId(''); setEvaluationTitle(''); setEvaluationQuery(''); setEvaluationExpected(''); setEvaluationForbidden('')
    setEvaluationFixture('{"split":"train","records":[]}'); setEvaluationStrategyId(''); setStrategyTitle(''); setStrategyCandidates(50); setStrategyResults(6)
    setAttemptId(''); setBillableCallId(''); setAttemptReason(''); setAttemptDisposition('retain_unknown'); setRecoverySnapshotId('')
  }, [selectedProjectKey])

  useEffect(() => {
    if (props.readDashboard !== undefined) return
    const current = overviewGeneration.current + 1
    overviewGeneration.current = current
    const scope = overviewScope
    const canReadOverview = activeView === 'overview' || activeView === 'processing'
    if (selectedProjectKey === '' || props.overview === undefined) {
      setOverviewData(undefined); setOverviewLoadedScope(''); setOverviewError(undefined); setOverviewLoading(false); return
    }
    if (!canReadOverview) { setOverviewLoading(false); return }
    setOverviewData(undefined)
    setOverviewLoadedScope('')
    setOverviewError(undefined)
    setOverviewLoading(true)
    void props.overview({ projectKey: selectedProjectKey, from, to, timeZone: overviewTimeZone, activity })
      .then((next) => { if (overviewGeneration.current === current) { setOverviewData(next); setOverviewLoadedScope(scope) } })
      .catch((error: unknown) => { if (overviewGeneration.current === current) setOverviewError(error instanceof Error ? error.message : 'overview failed') })
      .finally(() => { if (overviewGeneration.current === current) setOverviewLoading(false) })
    return () => { overviewGeneration.current += 1 }
  }, [props.overview, selectedProjectKey, from, to, overviewTimeZone, activity, overviewRefresh, activeView, overviewScope])

  useEffect(() => {
    if (props.readDashboard === undefined) return
    if (readViewsSuspended) {
      setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined); setOverviewLoadedScope(''); setOverviewLoading(false)
      return
    }
    const current = overviewGeneration.current + 1
    overviewGeneration.current = current
    const scope = overviewScope
    const canRead = activeView === 'overview' || activeView === 'processing'
    const reader = dashboardReaderPoolRef.current?.get('overview')
    if (!canRead) { setOverviewLoading(false); return }
    setBoundedOverviewData(undefined)
    setBoundedOverviewCursor(undefined)
    setOverviewLoadedScope('')
    setOverviewError(undefined)
    if (selectedProjectKey === '') {
      setOverviewLoading(false)
      return
    }
    if (reader === undefined) {
      setOverviewError('有界概览读取器不可用')
      setOverviewLoading(false)
      return
    }
    setOverviewLoading(true)
    const token = reader.start(props.readDashboard)
    overviewReadTokenRef.current = token
    void readDashboardScopedPage(reader, token, { projectKey: selectedProjectKey,
      range: { from, to, timeZone: overviewTimeZone, activity },
      request: { version: 1, action: 'overview', focusProjectKey: selectedProjectKey }, maxContinuations: 16 })
      .then((outcome) => {
        if (overviewGeneration.current !== current || !reader.isCurrent(token) || 'stale' in outcome) return
        if ('error' in outcome) {
          setBoundedOverviewData(undefined)
          setOverviewError(outcome.error instanceof Error ? outcome.error.message : '有界概览读取失败')
          void reader.closeCurrent()
          return
        }
        const result = outcome.result
        if (result.status !== 'ok' && result.status !== 'partial' && result.status !== 'budget_exhausted') {
          setBoundedOverviewData(undefined)
          setOverviewError(result.reason ?? `概览不可用（${result.status}）`)
          void reader.closeCurrent()
          return
        }
        setBoundedOverviewData(result)
        setBoundedOverviewCursor(outcome.cursor)
        setOverviewLoadedScope(scope)
        setOverviewError(undefined)
        if (outcome.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (overviewGeneration.current === current) {
          setBoundedOverviewData(undefined)
          setOverviewError(error instanceof Error ? error.message : '有界概览读取失败')
          void reader.closeCurrent()
        }
      })
      .finally(() => {
        if (overviewGeneration.current === current) setOverviewLoading(false)
      })
    return () => {
      overviewGeneration.current += 1
      if (reader.isCurrent(token)) reader.start(props.readDashboard)
    }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, overviewRefresh,
    activeView, overviewScope, readViewsSuspended])

  useEffect(() => {
    if (props.readDashboard === undefined) return
    if (readViewsSuspended || activeView !== 'overview') { setBoundedPersonaArea({ status: 'idle' }); return }
    const reader = dashboardReaderPoolRef.current?.get('persona')
    if (selectedProjectKey === '' || reader === undefined) {
      setBoundedPersonaArea({ status: selectedProjectKey === '' ? 'idle' : 'error',
        ...(selectedProjectKey === '' ? {} : { error: '画像读取器不可用' }) })
      return
    }
    setBoundedPersonaArea({ status: 'loading' })
    const token = reader.start(props.readDashboard)
    personaReadTokenRef.current = token
    void readDashboardScopedPage(reader, token, { projectKey: selectedProjectKey,
      range: { from, to, timeZone: overviewTimeZone, activity },
      request: { version: 1, action: 'persona', projectKey: selectedProjectKey }, maxContinuations: 16 })
      .then((outcome) => {
        if (!reader.isCurrent(token) || 'stale' in outcome) return
        if ('error' in outcome) {
          setBoundedPersonaArea({ status: 'error', error: outcome.error instanceof Error ? outcome.error.message : '画像读取失败' })
          void reader.closeCurrent()
          return
        }
        const result = outcome.result
        const persona = result.persona
        if (result.status !== 'ok' && result.status !== 'partial' || persona === undefined) {
          setBoundedPersonaArea({ status: 'error', error: result.reason ?? '画像数据未返回' })
          void reader.closeCurrent()
          return
        }
        if (persona.state !== 'visible' || persona.content === undefined) {
          setBoundedPersonaArea({ status: 'partial', complete: false, readId: outcome.readId, cursor: outcome.cursor,
            error: persona.reason ?? (persona.state === 'hidden' ? '画像因权限或来源状态不可见' : '画像状态尚未确认') })
          if (outcome.cursor === undefined) void reader.closeCurrent()
          return
        }
        const projectName = result.projects?.find((project) => project.key === selectedProjectKey)?.name ?? selectedProjectKey
        const data: BoundedPersona = { projectKey: selectedProjectKey, projectName, content: persona.content,
          sourceCount: persona.sourceCount, updatedAt: persona.updatedAt, stale: persona.stale }
        const complete = result.complete && outcome.complete && !persona.stale
        setBoundedPersonaArea({ status: complete ? 'ready' : 'partial', data, complete, readId: outcome.readId, cursor: outcome.cursor,
          ...(persona.stale ? { error: '画像来源状态可能已过期，显示为部分结果' }
            : complete ? {} : { error: result.reason ?? '画像读取尚未完整' }) })
        if (outcome.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (reader.isCurrent(token)) {
          setBoundedPersonaArea({ status: 'error', error: error instanceof Error ? error.message : '画像读取失败' })
          void reader.closeCurrent()
        }
      })
    return () => { if (reader.isCurrent(token)) reader.start(props.readDashboard) }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, boundedAreaRefresh.persona, readViewsSuspended, activeView])

  useEffect(() => {
    if (props.readDashboard === undefined) return
    if (readViewsSuspended || activeView !== 'overview') { setBoundedGlobalArea({ status: 'idle' }); return }
    const reader = dashboardReaderPoolRef.current?.get('global-persona')
    if (selectedProjectKey === '' || reader === undefined) {
      setBoundedGlobalArea({ status: selectedProjectKey === '' ? 'idle' : 'error',
        ...(selectedProjectKey === '' ? {} : { error: '全局画像读取器不可用' }) })
      return
    }
    setBoundedGlobalArea({ status: 'loading' })
    const token = reader.start(props.readDashboard)
    globalPersonaReadTokenRef.current = token
    void readDashboardScopedPage(reader, token, { projectKey: selectedProjectKey,
      range: { from, to, timeZone: overviewTimeZone, activity },
      request: { version: 1, action: 'globalPersona' }, maxContinuations: 16 })
      .then((outcome) => {
        if (!reader.isCurrent(token) || 'stale' in outcome) return
        if ('error' in outcome) {
          setBoundedGlobalArea({ status: 'error', error: outcome.error instanceof Error ? outcome.error.message : '全局画像读取失败' })
          void reader.closeCurrent()
          return
        }
        const result = outcome.result
        if ((result.status !== 'ok' && result.status !== 'partial') || result.globalPersona === undefined) {
          setBoundedGlobalArea({ status: 'error', error: result.reason ?? '全局画像状态未返回' })
          void reader.closeCurrent()
          return
        }
        const complete = result.complete && outcome.complete
        setBoundedGlobalArea({ status: complete ? 'ready' : 'partial', data: result.globalPersona, complete,
          readId: outcome.readId, cursor: outcome.cursor,
          ...(complete ? {} : { error: result.reason ?? '全局画像读取尚未完整' }) })
        if (outcome.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (reader.isCurrent(token)) {
          setBoundedGlobalArea({ status: 'error', error: error instanceof Error ? error.message : '全局画像读取失败' })
          void reader.closeCurrent()
        }
      })
    return () => { if (reader.isCurrent(token)) reader.start(props.readDashboard) }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, boundedAreaRefresh.global, readViewsSuspended, activeView])

  useEffect(() => {
    if (props.readDashboard === undefined) return
    if (readViewsSuspended || activeView !== 'overview') { setBoundedSceneArea({ status: 'idle' }); return }
    const reader = dashboardReaderPoolRef.current?.get('scene')
    if (selectedProjectKey === '' || reader === undefined) {
      setBoundedSceneArea({ status: selectedProjectKey === '' ? 'idle' : 'error',
        ...(selectedProjectKey === '' ? {} : { error: '场景读取器不可用' }) })
      return
    }
    setBoundedSceneArea({ status: 'loading' })
    const token = reader.start(props.readDashboard)
    sceneReadTokenRef.current = token
    void readDashboardScopedPage(reader, token, { projectKey: selectedProjectKey,
      range: { from, to, timeZone: overviewTimeZone, activity },
      request: { version: 1, action: 'scene', projectKey: selectedProjectKey }, maxContinuations: 16 })
      .then((outcome) => {
        if (!reader.isCurrent(token) || 'stale' in outcome) return
        if ('error' in outcome) {
          setBoundedSceneArea({ status: 'error', error: outcome.error instanceof Error ? outcome.error.message : '场景读取失败' })
          void reader.closeCurrent()
          return
        }
        const result = outcome.result
        if ((result.status !== 'ok' && result.status !== 'partial') || result.scene === undefined) {
          setBoundedSceneArea({ status: 'error', error: result.reason ?? '场景状态未返回' })
          void reader.closeCurrent()
          return
        }
        const scenes = result.scene.items.flatMap((item) => item.state === 'visible' && item.name !== undefined && item.summary !== undefined
          ? [{ projectKey: item.projectKey, projectName: item.projectName, name: item.name,
            summary: item.summary, memoryCount: item.memoryCount, summaryComplete: item.summaryComplete }]
          : [])
        const visibleOnly = scenes.length === result.scene.items.length
        const complete = result.complete && outcome.complete && visibleOnly && scenes.every((item) => item.summaryComplete)
        setBoundedSceneArea({ status: complete ? 'ready' : 'partial', data: scenes, complete,
          readId: outcome.readId, cursor: outcome.cursor,
          hasHidden: !visibleOnly,
          ...(complete ? {} : { error: result.reason ?? '部分场景因权限、来源或摘要完整度限制而未展示' }) })
        if (outcome.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (reader.isCurrent(token)) {
          setBoundedSceneArea({ status: 'error', error: error instanceof Error ? error.message : '场景读取失败' })
          void reader.closeCurrent()
        }
      })
    return () => { if (reader.isCurrent(token)) reader.start(props.readDashboard) }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, boundedAreaRefresh.scene, readViewsSuspended, activeView])

  useEffect(() => {
    const saved = pendingOverviewRestoreRef.current
    if (saved === undefined) return
    const clearPending = (): void => {
      if (pendingOverviewRestoreRef.current !== saved) return
      pendingOverviewRestoreRef.current = undefined
      setOverviewRestoreRevision((revision) => revision + 1)
    }
    const onUserInteraction = (): void => clearPending()
    document.addEventListener('pointerdown', onUserInteraction, true)
    document.addEventListener('wheel', onUserInteraction, { capture: true, passive: true })
    document.addEventListener('touchstart', onUserInteraction, { capture: true, passive: true })
    document.addEventListener('keydown', onUserInteraction, true)
    const focusTargets = [...document.querySelectorAll<HTMLElement>('[data-tdai-focus-key]')]
    const targetReady = saved.focusKey === undefined || focusTargets.some((element) =>
      element.dataset.tdaiFocusKey === saved.focusKey && !(element instanceof HTMLButtonElement && element.disabled)) ||
      focusTargets.some((element) => element.dataset.tdaiFocusKey === 'overview-nav')
    const decision = overviewRestoreDecision({ pending: pendingOverviewRestoreRef.current === saved,
      active: activeView === 'overview', scopeMatches: saved.scope === overviewScope,
      canRead: selectedProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined), loading: overviewLoading,
      contentReady: overviewLoadedScope === overviewScope && (overviewData !== undefined || boundedOverviewData !== undefined),
      targetReady, failed: overviewError !== undefined, interacted: pendingOverviewRestoreRef.current !== saved })
    if (decision === 'cancel') {
      pendingOverviewRestoreRef.current = undefined
      setOverviewRestoreRevision((revision) => revision + 1)
      return () => {
        document.removeEventListener('pointerdown', onUserInteraction, true)
        document.removeEventListener('wheel', onUserInteraction, true)
        document.removeEventListener('touchstart', onUserInteraction, true)
        document.removeEventListener('keydown', onUserInteraction, true)
      }
    }
    if (decision === 'wait') return () => {
      document.removeEventListener('pointerdown', onUserInteraction, true)
      document.removeEventListener('wheel', onUserInteraction, true)
      document.removeEventListener('touchstart', onUserInteraction, true)
      document.removeEventListener('keydown', onUserInteraction, true)
    }
    const frame = window.requestAnimationFrame(() => {
      if (pendingOverviewRestoreRef.current !== saved) return
      if (saved.scope !== overviewScope || overviewLoading || overviewLoadedScope !== overviewScope ||
          (overviewData === undefined && boundedOverviewData === undefined)) {
        pendingOverviewRestoreRef.current = undefined
        setOverviewRestoreRevision((revision) => revision + 1)
        return
      }
      if (saved.scrollTarget?.isConnected) saved.scrollTarget.scrollTop = saved.scrollTop
      else window.scrollTo({ top: saved.scrollTop })
      if (saved.focusKey !== undefined) {
        const target = [...document.querySelectorAll<HTMLElement>('[data-tdai-focus-key]')]
          .find((element) => element.dataset.tdaiFocusKey === saved.focusKey)
        if (target !== undefined && !(target instanceof HTMLButtonElement && target.disabled)) target.focus({ preventScroll: true })
        else document.querySelector<HTMLElement>('[data-tdai-focus-key="overview-nav"]')?.focus({ preventScroll: true })
      }
      pendingOverviewRestoreRef.current = undefined
      setOverviewRestoreRevision((revision) => revision + 1)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onUserInteraction, true)
      document.removeEventListener('wheel', onUserInteraction, true)
      document.removeEventListener('touchstart', onUserInteraction, true)
      document.removeEventListener('keydown', onUserInteraction, true)
    }
  }, [activeView, overviewLoading, overviewLoadedScope, overviewData, boundedOverviewData, overviewError, overviewScope,
    selectedProjectKey, props.overview, props.readDashboard, overviewRestoreRevision])

  useEffect(() => {
    const months = monthKeys(from, to)
    if (months.length > 0 && !months.includes(heatmapMonth)) setHeatmapMonth(months.at(-1)!)
  }, [from, to, heatmapMonth])

  useEffect(() => {
    explainGeneration.current += 1
    setExplainData(undefined)
    setExplainError(undefined)
  }, [selectedProjectKey, explainQuery])

  useEffect(() => {
    const current = libraryGeneration.current + 1
    libraryGeneration.current = current
    if (readViewsSuspended) {
      setLibraryRecords([]); setLibraryLoadedScope(''); setLibraryError(undefined); setLibraryLoading(false)
      setBoundedLibraryCursor(undefined); setLibraryPartial(false)
      return
    }
    const canReadLibrary = activeView === 'memories' || activeView === 'review'
    if (!canReadLibrary) { setLibraryLoading(false); setLibraryLoadedScope(''); setLibraryError(undefined); return }
    const readDashboard = props.readDashboard
    if (readDashboard !== undefined) {
      const reader = dashboardReaderPoolRef.current?.get('library')
      if (selectedProjectKey === '' || reader === undefined) {
        setLibraryRecords([]); setLibraryLoadedScope(''); setLibraryError(undefined); setLibraryLoading(false); setBoundedLibraryCursor(undefined); setLibraryPartial(false); return
      }
      const scope = libraryScope
      setLibraryLoading(true)
      setLibraryRecords([])
      setLibraryLoadedScope('')
      setBoundedLibraryCursor(undefined)
      setLibraryError(undefined)
      setLibraryPartial(false)
      const projectKey = selectedProjectKey
      const token = reader.start(readDashboard)
      libraryReadTokenRef.current = token
      void openDashboardScope(reader, token, projectKey, { from, to, timeZone: overviewTimeZone, activity })
        .then(async (opened) => {
          if (libraryGeneration.current !== current || !reader.isCurrent(token) || 'stale' in opened) return
          if ('error' in opened) throw opened.error
          const page = await reader.load(token, { version: 1, action: 'library', readId: opened.readId, projectKey,
            status: requestedLibraryStatus ?? 'all', limit: 6, ...(query.trim() === '' ? {} : { query: query.slice(0, 200) }) },
          { maxContinuations: 16 })
          if ('stale' in page) return
          if ('error' in page) throw page.error
          if (libraryGeneration.current !== current || !reader.isCurrent(token)) return
          const result = page.result
          if (result.status !== 'ok' && result.status !== 'partial' && result.status !== 'budget_exhausted') {
            throw new Error(result.reason ?? `记忆库不可用（${result.status}）`)
          }
          if (result.records === undefined) throw new Error(result.reason ?? '记忆库页面未返回记录状态')
          setLibraryRecords(result.records.filter((record) => record.content !== undefined) as unknown as MemoryView[])
          setBoundedLibraryCursor(result.cursor)
          setLibraryPartial(result.status !== 'ok' || !result.complete)
          setLibraryLoadedScope(scope)
          if (result.cursor === undefined) void reader.closeCurrent()
        })
        .catch((error: unknown) => {
          if (libraryGeneration.current === current) {
            setLibraryError({ scope, message: error instanceof Error ? error.message : 'library load failed' })
            void reader.closeCurrent()
          }
        })
        .finally(() => { if (libraryGeneration.current === current) setLibraryLoading(false) })
      return () => {
        libraryGeneration.current += 1
        if (reader.isCurrent(token)) reader.start(readDashboard)
      }
    }
    if (selectedProjectKey === '' || props.library === undefined) {
      setLibraryRecords([]); setLibraryCursor(undefined); setLibraryLoadedScope(''); setLibraryError(undefined); setLibraryLoading(false); setLibraryPartial(false); return
    }
    const scope = libraryScope
    setLibraryLoading(true)
    setLibraryRecords([])
    setLibraryCursor(undefined)
    setLibraryLoadedScope('')
    setLibraryError(undefined)
    setLibraryPartial(false)
    void props.library({ projectKey: selectedProjectKey, ...(requestedLibraryStatus === undefined ? {} : { status: requestedLibraryStatus }), limit: 100 })
      .then((result) => { if (libraryGeneration.current === current) { setLibraryRecords(result.records); setLibraryCursor(result.next); setLibraryLoadedScope(scope) } })
      .catch((error: unknown) => { if (libraryGeneration.current === current) setLibraryError({ scope, message: error instanceof Error ? error.message : 'library load failed' }) })
      .finally(() => { if (libraryGeneration.current === current) setLibraryLoading(false) })
    return () => { libraryGeneration.current += 1 }
  }, [props.library, props.readDashboard, selectedProjectKey, requestedLibraryStatus, libraryRefresh, activeView,
    libraryScope, query, from, to, overviewTimeZone, activity, readViewsSuspended])

  useEffect(() => {
    const current = manageGeneration.current + 1
    manageGeneration.current = current
    const managedViews = ['processing', 'continuity', 'experiences', 'relations', 'knowledge', 'evaluation', 'governance', 'recovery', 'settings']
    if (readViewsSuspended || selectedProjectKey === '' || props.manage === undefined || !managedViews.includes(activeView)) {
      setManageData({})
      setManageError(undefined)
      return
    }
    setManageData({})
    setManageError(undefined)
    const read = async (operation: string, payload: Record<string, unknown> = {}): Promise<unknown> => unwrapManagement(await props.manage!({ projectKey: selectedProjectKey, operation, payload }))
    const loadView = async (): Promise<Record<string, unknown>> => {
      switch (activeView) {
        case 'processing': {
          const [jobs, coverage] = await Promise.allSettled([read('processing.jobs', { limit: 20, filter: processingJobsFilter }), read('processing.coverage', { limit: 20 })])
          if (jobs.status === 'rejected' && coverage.status === 'rejected') throw jobs.reason
          return {
            ...(jobs.status === 'fulfilled' ? { processingJobsPage: jobs.value } : { processingJobsError: jobs.reason instanceof Error ? jobs.reason.message : 'jobs failed' }),
            ...(coverage.status === 'fulfilled' ? { processingCoveragePage: coverage.value } : { processingCoverageError: coverage.reason instanceof Error ? coverage.reason.message : 'coverage failed' }),
          }
        }
        case 'continuity': return { tasks: await read('task.list') }
        case 'experiences': return { experiences: await read('experience.list') }
        case 'relations': {
          const [revisions, relations] = await Promise.all([read('revision.list'), read('relation.list')])
          return { revisions, relations }
        }
        case 'knowledge': return { knowledge: await read('knowledge.list') }
        case 'evaluation': {
          const [evaluation, strategies] = await Promise.all([read('evaluation.list'), read('strategy.list')])
          return { evaluation, strategies }
        }
        case 'governance': {
          const [attempts, billableCalls, billableUsage] = await Promise.all([read('attempt.list'), read('billable.list'), read('billable.summary')])
          return { attempts, billableCalls, billableUsage }
        }
        case 'recovery': return { recovery: await read('recovery.list') }
        case 'settings': return { contentInventory: await read('content.delete.inventory') }
        default: return {}
      }
    }
    void loadView().then((data) => { if (manageGeneration.current === current) setManageData(data) })
      .catch((error: unknown) => { if (manageGeneration.current === current) setManageError(error instanceof Error ? error.message : 'management data unavailable') })
    return () => { manageGeneration.current += 1 }
  }, [props.manage, selectedProjectKey, activeView, manageRefresh, processingJobsFilter, readViewsSuspended])

  useEffect(() => {
    setRepeatedExtra([])
    setRepeatedVisibleCount(10)
    setRepeatedExhausted(false)
    setRepeatedLoading(false)
  }, [selectedProjectKey, from, to, overviewTimeZone, overviewRefresh, manageRefresh])

  useEffect(() => {
    setProcessingJobsLoading(false)
    setCoverageLoading(false)
    setEvaluationRunsLoading(false)
  }, [selectedProjectKey, activeView, processingJobsFilter, manageRefresh])

  useEffect(() => { setEvaluationCorpusFocus(undefined) }, [selectedProjectKey, activeView])

  useEffect(() => {
    const scopedTransport = (name: string, tokenRef: { current: number | undefined }) => async (request: ReadDashboardRequest): Promise<ReadDashboardResult> => {
      const reader = dashboardReaderPoolRef.current?.get(name)
      if (reader === undefined || !reader.isCurrent(tokenRef.current)) throw new Error('重复线索读取已取消')
      const outcome = await reader.load(tokenRef.current, request, { maxContinuations: 0 })
      if ('stale' in outcome) throw new Error('重复线索读取已取消')
      if ('error' in outcome) throw outcome.error
      return outcome.result
    }
    const controller = createRepeatedReadController({ readDashboard: props.readDashboard === undefined ? undefined
      : scopedTransport('repeated-groups', repeatedGroupReadTokenRef) })
    const detailController = createRepeatedReadController({ readDashboard: props.readDashboard === undefined ? undefined
      : scopedTransport('repeated-detail', repeatedDetailReadTokenRef) })
    repeatedGroupControllerRef.current = controller
    repeatedDetailControllerRef.current = detailController
    return () => {
      controller.dispose()
      detailController.dispose()
      if (repeatedGroupControllerRef.current === controller) repeatedGroupControllerRef.current = undefined
      if (repeatedDetailControllerRef.current === detailController) repeatedDetailControllerRef.current = undefined
    }
  }, [props.readDashboard])

  useEffect(() => {
    const controller = repeatedGroupControllerRef.current
    const resetRepeated = (): void => {
      repeatedGroupGeneration.current += 1
      controller?.start()
      setRepeatedGroups([])
      setRepeatedHasMore(false)
      setRepeatedScanCursor(undefined)
      setRepeatedReadState('idle')
      setRepeatedReadNotice(undefined)
      setRepeatedReadError(undefined)
    }
    const reader = dashboardReaderPoolRef.current?.get('repeated-groups')
    if (readViewsSuspended || activeView !== 'overview' || props.readDashboard === undefined || selectedProjectKey === '' ||
        activity !== 'capture' || controller === undefined || reader === undefined) {
      resetRepeated()
      return
    }
    const projectKey = selectedProjectKey
    const readerToken = reader.start(props.readDashboard)
    repeatedGroupReadTokenRef.current = readerToken
    const generation = repeatedGroupGeneration.current + 1
    repeatedGroupGeneration.current = generation
    const token = controller.start()
    setRepeatedGroups([])
    setRepeatedHasMore(false)
    setRepeatedScanCursor(undefined)
    setRepeatedReadNotice(undefined)
    setRepeatedReadError(undefined)
    setRepeatedReadState('loading')
    void openDashboardScope(reader, readerToken, projectKey, { from, to, timeZone: overviewTimeZone, activity })
      .then(async (opened) => {
        if (repeatedGroupGeneration.current !== generation || !reader.isCurrent(readerToken) || 'stale' in opened) return
        if ('error' in opened) throw opened.error
        const outcome = await controller.load(token, {
          version: 1, action: 'repeated', readId: opened.readId,
          target: { kind: 'groups', projectKeys: [projectKey], limit: 10 },
        }, { maxContinuations: 15 })
        if (repeatedGroupGeneration.current !== generation || 'stale' in outcome) return
        if ('error' in outcome) throw outcome.error
        const result = outcome.result as ReadDashboardResult | undefined
        const classified = classifyRepeatedResult(result, 'groups')
        if (classified.kind === 'failed') {
          setRepeatedGroups([])
          setRepeatedHasMore(false)
          setRepeatedScanCursor(undefined)
          setRepeatedReadState('error')
          setRepeatedReadError(classified.reason)
          void reader.closeCurrent()
          return
        }
        setRepeatedGroups((classified.repeated.groups ?? []).map((item) => ({ ...item })))
        setRepeatedHasMore(classified.kind === 'complete' && classified.repeated.hasMore === true &&
          typeof result?.cursor === 'string')
        setRepeatedScanCursor(classified.kind === 'incomplete' && typeof result?.cursor === 'string' ? result?.cursor : undefined)
        setRepeatedReadState(classified.kind === 'complete' ? 'ready' : 'partial')
        setRepeatedReadNotice(classified.kind === 'complete' ? undefined : classified.reason)
        if (result?.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (repeatedGroupGeneration.current !== generation) return
        setRepeatedReadState('error')
        setRepeatedReadError(error instanceof Error ? error.message : '重复线索读取失败')
        void reader.closeCurrent()
      })
    return () => {
      repeatedGroupGeneration.current += 1
      if (reader.isCurrent(readerToken)) reader.start(props.readDashboard)
    }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, overviewRefresh, readViewsSuspended, activeView])

  const continueRepeatedScan = (): void => {
    const controller = repeatedGroupControllerRef.current
    const cursor = repeatedScanCursor
    const reader = dashboardReaderPoolRef.current?.get('repeated-groups')
    if (controller === undefined || reader?.readId === undefined || cursor === undefined || repeatedLoading) return
    const generation = repeatedGroupGeneration.current + 1
    repeatedGroupGeneration.current = generation
    const token = controller.start()
    setRepeatedLoading(true)
    void controller.resume(token, { readId: reader.readId, cursor }, { maxContinuations: 15 }).then((outcome) => {
      if (repeatedGroupGeneration.current !== generation || 'stale' in outcome) return
      if ('error' in outcome) {
        setRepeatedScanCursor(undefined); setRepeatedHasMore(false); void reader.closeCurrent()
        setRepeatedReadError(outcome.error instanceof Error ? outcome.error.message : '重复线索读取失败')
        return
      }
      const result = outcome.result as ReadDashboardResult | undefined
      const classified = classifyRepeatedResult(result, 'groups')
      if (classified.kind === 'failed') {
        setRepeatedReadState('error')
        setRepeatedReadError(classified.reason)
        setRepeatedScanCursor(undefined); setRepeatedHasMore(false); void reader.closeCurrent()
        return
      }
      setRepeatedGroups((classified.repeated.groups ?? []).map((item) => ({ ...item })))
      setRepeatedHasMore(classified.kind === 'complete' && classified.repeated.hasMore === true &&
        typeof result?.cursor === 'string')
      setRepeatedScanCursor(classified.kind === 'incomplete' && typeof result?.cursor === 'string' ? result?.cursor : undefined)
      setRepeatedReadState(classified.kind === 'complete' ? 'ready' : 'partial')
      setRepeatedReadNotice(classified.kind === 'complete' ? undefined : classified.reason)
      setRepeatedReadError(undefined)
      if (result?.cursor === undefined) void reader.closeCurrent()
    }).catch((error: unknown) => {
      if (repeatedGroupGeneration.current === generation) {
        setRepeatedScanCursor(undefined); setRepeatedHasMore(false); void reader.closeCurrent()
        setRepeatedReadError(error instanceof Error ? error.message : '重复线索读取失败')
      }
    }).finally(() => {
      if (repeatedGroupGeneration.current === generation) setRepeatedLoading(false)
    })
  }

  useEffect(() => {
    if (props.readDashboard === undefined || detailFingerprint === '') return
    if (readViewsSuspended || activeView !== 'overview') { setDetailData(undefined); setRepeatedDetailCursor(undefined); setDetailLoading(false); return }
    const reader = dashboardReaderPoolRef.current?.get('repeated-detail')
    const generation = repeatedDetailGeneration.current + 1
    repeatedDetailGeneration.current = generation
    setRepeatedDetailCursor(undefined)
    setDetailReadError(undefined)
    setDetailNotice(undefined)
    if (selectedProjectKey === '' || (!detailRange && detailDate === '') || reader === undefined) {
      setDetailData(undefined); setDetailLoading(false); return
    }
    const controller = repeatedDetailControllerRef.current
    if (controller === undefined) {
      setDetailLoading(false)
      setDetailData(undefined)
      setDetailReadError('事件读取接口不可用')
      return
    }
    const projectKey = selectedProjectKey
    const readerToken = reader.start(props.readDashboard)
    repeatedDetailReadTokenRef.current = readerToken
    setDetailLoading(true)
    setDetailData(undefined)
    const token = controller.start()
    void openDashboardScope(reader, readerToken, projectKey, { from, to, timeZone: overviewTimeZone, activity })
      .then(async (opened) => {
        if (repeatedDetailGeneration.current !== generation || !reader.isCurrent(readerToken) || 'stale' in opened) return
        if ('error' in opened) throw opened.error
        const outcome = await controller.load(token, {
          version: 1, action: 'repeated', readId: opened.readId,
          target: { kind: 'events', projectKey, fingerprint: detailFingerprint,
            includeExcerpt: detailIncludeExcerpt, limit: 15 },
        }, { maxContinuations: 8, collectEvents: true })
        if (repeatedDetailGeneration.current !== generation || 'stale' in outcome) return
        if ('error' in outcome) throw outcome.error
        const result = outcome.result as ReadDashboardResult | undefined
        const classified = classifyRepeatedResult(result, 'events')
        if (classified.kind === 'failed') {
          setDetailData(undefined)
          setDetailReadError(classified.reason)
          void reader.closeCurrent()
          return
        }
        setDetailData({ events: (outcome.events as BoundedRepeatedEvent[]).map(repeatedEventRow) })
        setRepeatedDetailCursor(typeof result?.cursor === 'string' ? result?.cursor : undefined)
        if (classified.kind === 'incomplete' &&
            (result?.status === 'budget_exhausted' || typeof result?.cursor !== 'string')) setDetailNotice(classified.reason)
        if (result?.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (repeatedDetailGeneration.current !== generation) return
        setDetailData(undefined)
        setDetailReadError(error instanceof Error ? error.message : 'event detail unavailable')
        void reader.closeCurrent()
      })
      .finally(() => {
        if (repeatedDetailGeneration.current === generation) setDetailLoading(false)
      })
    return () => {
      repeatedDetailGeneration.current += 1
      if (reader.isCurrent(readerToken)) reader.start(props.readDashboard)
    }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, detailDate, detailRange,
    detailFingerprint, detailIncludeExcerpt, detailRefresh, readViewsSuspended, activeView])

  useEffect(() => {
    if (props.readDashboard === undefined) return
    if (readViewsSuspended || activeView !== 'overview') { setDetailData(undefined); setDetailLoading(false); setBoundedDetailCursor(undefined); return }
    if (detailFingerprint !== '') return
    const reader = dashboardReaderPoolRef.current?.get('detail')
    if (detailValue === '__other__' && detailDate === '') return
    const current = detailGeneration.current + 1
    detailGeneration.current = current
    if (selectedProjectKey === '' || (!detailRange && detailDate === '') || (detailDate === '' && detailValue === '') || reader === undefined) {
      setDetailData(undefined); setDetailLoading(false); setBoundedDetailCursor(undefined)
      return
    }
    const projectKey = selectedProjectKey
    const token = reader.start(props.readDashboard)
    detailReadTokenRef.current = token
    setDetailData(undefined)
    setDetailLoading(true)
    setDetailReadError(undefined)
    setDetailNotice(undefined)
    setBoundedDetailCursor(undefined)
    const detailRequest = boundedEventDetailRequest({ projectKey,
      range: { from, to, timeZone: overviewTimeZone, activity }, activity: detailActivity,
      dimension: detailDimension, value: detailValue, date: detailDate })
    void readDashboardScopedPage(reader, token, { projectKey, ...detailRequest, maxContinuations: 12 })
      .then((outcome) => {
        if (detailGeneration.current !== current || !reader.isCurrent(token) || 'stale' in outcome) return
        if ('error' in outcome) throw outcome.error
        const result = outcome.result
        if (result.status !== 'ok' && result.status !== 'partial' && result.status !== 'budget_exhausted') {
          setDetailData(undefined)
          setDetailReadError(result.reason ?? `事件不可用（${result.status}）`)
          return
        }
        if (result.events === undefined) throw new Error(result.reason ?? '事件明细未返回')
        setDetailData({ events: result.events.map((event) => ({ ...event, occurredAt: event.createdAt, eventId: event.id })) })
        setBoundedDetailCursor(outcome.cursor)
        if (!outcome.complete) setDetailNotice(result.reason ?? '事件明细只包含当前有界可读部分')
        if (outcome.cursor === undefined) void reader.closeCurrent()
      })
      .catch((error: unknown) => {
        if (detailGeneration.current === current) {
          setDetailData(undefined)
          setDetailReadError(error instanceof Error ? error.message : '事件明细读取失败')
          void reader.closeCurrent()
        }
      })
      .finally(() => { if (detailGeneration.current === current) setDetailLoading(false) })
    return () => {
      detailGeneration.current += 1
      if (reader.isCurrent(token)) reader.start(props.readDashboard)
    }
  }, [props.readDashboard, selectedProjectKey, from, to, overviewTimeZone, activity, detailDate, detailRange,
    detailDimension, detailValue, detailRefresh, readViewsSuspended, activeView, detailFingerprint, detailActivity])

  useEffect(() => {
    if (props.readDashboard !== undefined && detailValue !== '__other__') return
    if (readViewsSuspended) { setDetailData(undefined); setDetailLoading(false); return }
    const current = detailGeneration.current + 1
    detailGeneration.current = current
    if (selectedProjectKey === '' || (!detailRange && detailDate === '') || props.manage === undefined) {
      setDetailData(undefined); setDetailLoading(false); return
    }
    const otherValues = props.readDashboard !== undefined ? boundedDimensionValues(boundedOverviewData, detailDimension, detailActivity)
      : detailDimensionValues(overviewData, detailDimension)
    if (detailValue === '__other__' && otherValues === undefined) {
      setDetailData(undefined); setDetailLoading(false); setDetailNotice('当前活动分组不可用，请刷新统计。'); return
    }
    setDetailLoading(true)
    setDetailData(undefined)
    void props.manage({ projectKey: selectedProjectKey, operation: 'overview.detail', payload: {
      ...(detailRange ? { from, to } : { date: detailDate }), timeZone: overviewTimeZone, activity: detailActivity,
      ...(detailValue === '' ? {} : { dimension: detailDimension, value: detailValue,
        ...(detailValue === '__other__' ? { otherValues } : {}) }), limit: 50,
      ...(detailFingerprint === '' ? {} : { fingerprint: detailFingerprint, includeExcerpt: detailIncludeExcerpt }),
    } }).then((value) => {
      const result = unwrapManagement(value) as { events?: Array<Record<string, unknown>>; next?: { occurredAt: number; id: number } }
      if (detailGeneration.current === current) setDetailData({ events: result.events ?? [], ...(result.next === undefined ? {} : { next: result.next }) })
    }).catch((error: unknown) => { if (detailGeneration.current === current) setManageError(error instanceof Error ? error.message : 'event detail unavailable') })
      .finally(() => { if (detailGeneration.current === current) setDetailLoading(false) })
    return () => { detailGeneration.current += 1 }
  }, [props.manage, props.readDashboard, selectedProjectKey, detailDate, detailRange, from, to, overviewTimeZone,
    detailDimension, detailValue, detailFingerprint, detailIncludeExcerpt, activity, detailActivity, detailRefresh, overviewData, boundedOverviewData, readViewsSuspended])

  const invalidateReadViews = (): void => {
    detailReturn.cancel()
    setDetailActivityOverride(undefined)
    invalidateActionScope()
    projectDirectory.invalidate(props.readDashboard)
    setDirectoryState(projectDirectory.snapshot())
    setDirectoryRefresh((value) => value + 1)
    overviewGeneration.current += 1
    explainGeneration.current += 1
    libraryGeneration.current += 1
    manageGeneration.current += 1
    detailGeneration.current += 1
    for (const name of ['scope', 'overview', 'library', 'persona', 'global-persona', 'scene', 'repeated-groups', 'repeated-detail', 'detail']) {
      dashboardReaderPoolRef.current?.get(name)?.start(props.readDashboard)
    }
    repeatedGroupControllerRef.current?.start()
    repeatedDetailControllerRef.current?.start()
    pendingOverviewRestoreRef.current = undefined
    overviewReturnRef.current = undefined
    setOverviewData(undefined); setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined); setBoundedView(undefined); setOverviewLoadedScope(''); setOverviewError(undefined)
    setBoundedPersonaArea({ status: 'idle' }); setBoundedGlobalArea({ status: 'idle' }); setBoundedSceneArea({ status: 'idle' })
    setBoundedAreaRefresh((value) => ({ persona: value.persona + 1, global: value.global + 1, scene: value.scene + 1 }))
    setExplainData(undefined); setExplainError(undefined)
    setLibraryRecords([]); setLibraryCursor(undefined); setBoundedLibraryCursor(undefined); setLibraryLoadedScope(''); setLibraryError(undefined); setLibraryPartial(false); setLibraryRefresh((value) => value + 1)
    setManageData({}); setManageError(undefined); setManageResult(undefined); setManageResultProjectKey(undefined); setManageRefresh((value) => value + 1)
    knowledgeDetailGeneration.current += 1
    setKnowledgeExpandedId(''); setKnowledgeFocusId(''); setKnowledgeDetails({}); setKnowledgeLoadingId('')
    setDetailDate(''); setDetailRange(false); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false)
    setDetailData(undefined); setDetailLoading(false); setBoundedDetailCursor(undefined); setDetailRefresh((value) => value + 1)
    repeatedGroupGeneration.current += 1
    repeatedDetailGeneration.current += 1
    setRepeatedGroups([]); setRepeatedHasMore(false); setRepeatedScanCursor(undefined)
    setRepeatedReadState('idle'); setRepeatedReadNotice(undefined); setRepeatedReadError(undefined)
    setRepeatedDetailCursor(undefined); setDetailReadError(undefined); setDetailNotice(undefined)
    setOverviewRefresh((value) => value + 1)
    setManageBusy(false)
  }

  const mutate = (operation: () => Promise<DashboardSnapshot>, message = 'saved'): void => {
    if (busy) return
    invalidateSnapshotReads()
    const busyToken = ++busyGeneration.current
    const scopeToken = actionScopeGeneration.current
    const projectKey = selectedProjectKey
    setBusy(true)
    setNotice(undefined)
    void operation()
      .then((next) => {
        if (busyGeneration.current !== busyToken || actionScopeGeneration.current !== scopeToken || selectedProjectKeyRef.current !== projectKey) return
        invalidateSnapshotReads(); setPreviewSnapshot(next); invalidateReadViews(); setNotice(message)
      })
      .catch((error: unknown) => {
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeToken) setNotice(error instanceof Error ? error.message : 'operation failed')
      })
      .finally(() => { if (busyGeneration.current === busyToken) setBusy(false) })
  }

  const reviewMemory = (memory: MemoryView, action: 'approve' | 'forget'): void => {
    if (busy) return
    if (props.readDashboard !== undefined && props.reviewAck !== undefined) {
      const suspendPageReads = action === 'forget'
      if (suspendPageReads) { holdReadViews(); invalidateReadViews() }
      const projectKey = memory.projectKey
      const scopeGeneration = actionScopeGeneration.current
      const busyToken = ++busyGeneration.current
      setBusy(true)
      setNotice(undefined)
      void props.reviewAck({ projectKey, id: memory.id, action }).then(async (ack) => {
        if (busyGeneration.current !== busyToken || actionScopeGeneration.current !== scopeGeneration || selectedProjectKeyRef.current !== projectKey) return
        if (ack.ok !== true || ack.scope !== 'project' || !ack.operation.startsWith('review.') || ack.result === 'rejected') {
          throw new Error(ack.reason ?? 'review rejected')
        }
        await refreshBounded()
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) {
          setNotice(action === 'approve' ? 'approved' : 'forgotten')
          setLibraryRefresh((value) => value + 1)
        }
      }).catch((error: unknown) => {
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) {
          setNotice(error instanceof Error ? error.message : 'operation failed')
        }
      }).finally(() => {
        if (suspendPageReads) releaseReadViews()
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) setBusy(false)
      })
      return
    }
    if (action === 'forget') invalidateReadViews()
    mutate(() => props.review({ projectKey: memory.projectKey, id: memory.id, action }), action === 'approve' ? 'approved' : 'forgotten')
  }

  const manageAction = (operation: string, payload: Record<string, unknown> = {}, message: string | ((result: unknown) => string) = '操作已保存'): void => {
    if (selectedProjectKey === '' || props.manage === undefined || manageBusy) return
    const invalidateBeforeWrite = operation === 'source.revoke' || operation === 'content.delete.apply'
    if (invalidateBeforeWrite) { holdReadViews(); invalidateReadViews() }
    invalidateSnapshotReads()
    const projectKey = selectedProjectKey
    let scopeGeneration = actionScopeGeneration.current
    setManageBusy(true)
    setManageError(undefined)
    setManageResult(undefined)
    setManageResultProjectKey(undefined)
    setNotice(undefined)
    void props.manage({ projectKey, operation, payload })
      .then((value) => {
        if (actionScopeGeneration.current !== scopeGeneration || selectedProjectKeyRef.current !== projectKey) return
        const result = unwrapManagement(value)
        invalidateReadViews()
        scopeGeneration = actionScopeGeneration.current
        setManageResult(result)
        setManageResultProjectKey(projectKey)
        setNotice(typeof message === 'function' ? message(result) : message)
        invalidateSnapshotReads()
        void refresh()
      })
      .catch((error: unknown) => {
        if (actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) {
          if (invalidateBeforeWrite) {
            invalidateReadViews()
            scopeGeneration = actionScopeGeneration.current
          }
          setManageError(error instanceof Error ? error.message : 'operation failed')
        }
      })
      .finally(() => {
        if (invalidateBeforeWrite) releaseReadViews()
        if (actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) setManageBusy(false)
      })
  }

  const requestManagementRecord = (operation: string, payload: Record<string, unknown>, onResult: (result: Record<string, unknown>) => void): void => {
    if (selectedProjectKey === '' || props.manage === undefined || manageBusy) return
    const projectKey = selectedProjectKey
    const scopeGeneration = actionScopeGeneration.current
    setManageBusy(true)
    setManageError(undefined)
    void props.manage({ projectKey, operation, payload }).then((value) => {
      if (actionScopeGeneration.current !== scopeGeneration || selectedProjectKeyRef.current !== projectKey) return
      const result = unwrapManagement(value)
      if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('管理操作返回了无效结果')
      onResult(result as Record<string, unknown>)
    }).catch((error: unknown) => {
      if (actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) {
        setManageError(error instanceof Error ? error.message : '管理数据读取失败')
      }
    }).finally(() => {
      if (actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) setManageBusy(false)
    })
  }

  const toggleKnowledgeDetail = (id: string): void => {
    if (knowledgeExpandedId === id) { setKnowledgeExpandedId(''); setKnowledgeFocusId(''); return }
    setKnowledgeExpandedId(id)
    setKnowledgeFocusId(id)
    if (knowledgeDetails[id] !== undefined || selectedProjectKey === '' || props.manage === undefined) return
    const projectKey = selectedProjectKey
    const scopeGeneration = actionScopeGeneration.current
    const requestGeneration = knowledgeDetailGeneration.current + 1
    knowledgeDetailGeneration.current = requestGeneration
    setKnowledgeLoadingId(id)
    setManageError(undefined)
    void props.manage({ projectKey, operation: 'knowledge.detail', payload: { id } })
      .then((value) => {
        if (knowledgeDetailGeneration.current !== requestGeneration || actionScopeGeneration.current !== scopeGeneration || selectedProjectKeyRef.current !== projectKey) return
        const result = unwrapManagement(value)
        if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
          setKnowledgeDetails((current) => ({ ...current, [id]: result as Record<string, unknown> }))
        } else setManageError('知识详情格式无效')
      })
      .catch((error: unknown) => {
        if (knowledgeDetailGeneration.current === requestGeneration && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) {
          setManageError(error instanceof Error ? error.message : '知识详情读取失败')
        }
      })
      .finally(() => {
        if (knowledgeDetailGeneration.current === requestGeneration && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) setKnowledgeLoadingId('')
      })
  }

  const openKnowledgeDetail = (id: string): void => {
    const memoryId = id.trim()
    if (memoryId === '') return
    setKnowledgeFocusId(memoryId)
    setKnowledgeExpandedId(memoryId)
    navigateView('knowledge')
    if (knowledgeDetails[memoryId] !== undefined || selectedProjectKey === '' || props.manage === undefined) return
    const projectKey = selectedProjectKey
    const scopeGeneration = actionScopeGeneration.current
    const requestGeneration = knowledgeDetailGeneration.current + 1
    knowledgeDetailGeneration.current = requestGeneration
    setKnowledgeLoadingId(memoryId)
    setManageError(undefined)
    void props.manage({ projectKey, operation: 'knowledge.detail', payload: { id: memoryId } })
      .then((value) => {
        if (knowledgeDetailGeneration.current !== requestGeneration || actionScopeGeneration.current !== scopeGeneration || selectedProjectKeyRef.current !== projectKey) return
        const result = unwrapManagement(value)
        if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
          setKnowledgeDetails((current) => ({ ...current, [memoryId]: result as Record<string, unknown> }))
        } else setManageError('知识详情不可用，可能是合成评测 ID 或已删除记忆')
      })
      .catch((error: unknown) => {
        if (knowledgeDetailGeneration.current === requestGeneration && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) {
          setManageError(error instanceof Error ? error.message : '知识详情读取失败')
        }
      })
      .finally(() => {
        if (knowledgeDetailGeneration.current === requestGeneration && actionScopeGeneration.current === scopeGeneration && selectedProjectKeyRef.current === projectKey) setKnowledgeLoadingId('')
      })
  }

  const regenerate = (): void => {
    const project = snapshot?.projects.find((item) => item.key === selectedProjectKey)
    if (project === undefined || busy) return
    if (props.readDashboard !== undefined && props.refreshPersonaAck !== undefined) {
      const scopeGeneration = actionScopeGeneration.current
      const busyToken = ++busyGeneration.current
      setBusy(true); setNotice(undefined)
      void props.refreshPersonaAck(project.key).then(async (ack) => {
        if (busyGeneration.current !== busyToken || actionScopeGeneration.current !== scopeGeneration || selectedProjectKeyRef.current !== project.key) return
        if (ack.ok !== true || ack.result === 'rejected') throw new Error(ack.reason ?? 'profile refresh rejected')
        await refreshBounded()
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration) {
          setBoundedAreaRefresh((value) => ({ ...value, persona: value.persona + 1 }))
          setNotice('profile generated')
        }
      }).catch((error: unknown) => {
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration) setNotice(error instanceof Error ? error.message : 'operation failed')
      }).finally(() => { if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration) setBusy(false) })
      return
    }
    if (props.refreshPersona === undefined) return
    mutate(() => props.refreshPersona!(project.key), 'profile generated')
  }

  const regenerateGlobal = (): void => {
    if (busy) return
    if (props.readDashboard !== undefined && props.refreshGlobalPersonaAck !== undefined) {
      const scopeGeneration = actionScopeGeneration.current
      const busyToken = ++busyGeneration.current
      setBusy(true); setNotice(undefined)
      void props.refreshGlobalPersonaAck().then(async (ack) => {
        if (busyGeneration.current !== busyToken || actionScopeGeneration.current !== scopeGeneration) return
        if (ack.ok !== true || ack.result === 'rejected') throw new Error(ack.reason ?? 'global profile refresh rejected')
        await refreshBounded()
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration) {
          setBoundedAreaRefresh((value) => ({ ...value, global: value.global + 1 }))
          setNotice('global profile generated')
        }
      }).catch((error: unknown) => {
        if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration) setNotice(error instanceof Error ? error.message : 'operation failed')
      }).finally(() => { if (busyGeneration.current === busyToken && actionScopeGeneration.current === scopeGeneration) setBusy(false) })
      return
    }
    if (props.refreshGlobalPersona === undefined) return
    mutate(() => props.refreshGlobalPersona!(), 'global profile generated')
  }

  const download = (): void => {
    const project = snapshot?.projects.find((item) => item.key === selectedProjectKey)
    if (project === undefined || busy) return
    const busyToken = ++busyGeneration.current
    setBusy(true)
    void props.exportProject(project.key)
      .then((result) => {
        if (busyGeneration.current !== busyToken || selectedProjectKeyRef.current !== project.key) return
        const url = URL.createObjectURL(new Blob([result.content], { type: 'application/x-ndjson' }))
        const link = document.createElement('a')
        link.href = url
        link.download = result.fileName
        link.click()
        URL.revokeObjectURL(url)
      })
      .catch((error: unknown) => { if (busyGeneration.current === busyToken) setNotice(error instanceof Error ? error.message : 'export failed') })
      .finally(() => { if (busyGeneration.current === busyToken) setBusy(false) })
  }

  const loadMoreBoundedOverview = (): void => {
    const reader = dashboardReaderPoolRef.current?.get('overview')
    const token = overviewReadTokenRef.current
    const cursor = boundedOverviewCursor
    if (reader === undefined || token === undefined || reader.readId === undefined || cursor === undefined || overviewLoading) return
    const current = overviewGeneration.current
    const projectKey = selectedProjectKey
    setOverviewLoading(true)
    setOverviewError(undefined)
    void reader.load(token, { version: 1, action: 'continue', readId: reader.readId, cursor }, { maxContinuations: 12 }).then((outcome) => {
      if (overviewGeneration.current !== current || selectedProjectKeyRef.current !== projectKey || !reader.isCurrent(token) || 'stale' in outcome) return
      if ('error' in outcome) throw outcome.error
      const result = outcome.result
      if (result.status !== 'ok' && result.status !== 'partial' && result.status !== 'budget_exhausted') {
        setBoundedOverviewData(undefined)
        setBoundedOverviewCursor(undefined)
        setOverviewLoadedScope('')
        setOverviewError(result.reason ?? `概览不可用（${result.status}）`)
        void reader.closeCurrent()
        return
      }
      setBoundedOverviewData(result)
      setBoundedOverviewCursor(result.complete ? undefined : result.cursor)
      setOverviewLoadedScope(overviewScope)
      if (result.cursor === undefined) void reader.closeCurrent()
    }).catch((error: unknown) => {
      if (overviewGeneration.current === current) {
        setBoundedOverviewData(undefined)
        setBoundedOverviewCursor(undefined)
        setOverviewError(error instanceof Error ? error.message : '概览续页读取失败')
        void reader.closeCurrent()
      }
    }).finally(() => { if (overviewGeneration.current === current) setOverviewLoading(false) })
  }

  const continuePersonaRead = (): void => {
    const area = boundedPersonaArea
    const reader = dashboardReaderPoolRef.current?.get('persona')
    const token = personaReadTokenRef.current
    if (reader === undefined || token === undefined || area.readId === undefined || area.cursor === undefined || reader.readId !== area.readId) return
    setBoundedPersonaArea({ ...area, status: 'loading', error: undefined })
    void continueDashboardScopedPage(reader, token, area.readId, area.cursor, 'persona', 12).then((outcome) => {
      if ('stale' in outcome || !reader.isCurrent(token)) return
      if ('error' in outcome) {
        setBoundedPersonaArea({ status: 'error', error: outcome.error instanceof Error ? outcome.error.message : '画像续页读取失败' })
        void reader.closeCurrent()
        return
      }
      const result = outcome.result
      const persona = result.persona
      if ((result.status !== 'ok' && result.status !== 'partial') || persona === undefined) {
        setBoundedPersonaArea({ status: 'error', error: result.reason ?? '画像状态未返回' })
        void reader.closeCurrent()
        return
      }
      if (persona.state !== 'visible' || persona.content === undefined) {
        setBoundedPersonaArea({ status: 'partial', complete: false, readId: outcome.readId, cursor: outcome.cursor,
          error: persona.reason ?? '画像正文或来源证明当前不可见' })
        if (outcome.cursor === undefined) void reader.closeCurrent()
        return
      }
      const projectName = result.projects?.find((project) => project.key === selectedProjectKey)?.name ?? selectedProjectKey
      const data: BoundedPersona = { projectKey: selectedProjectKey, projectName, content: persona.content,
        sourceCount: persona.sourceCount, updatedAt: persona.updatedAt, stale: persona.stale }
      const complete = result.complete && outcome.complete && !persona.stale
      setBoundedPersonaArea({ status: complete ? 'ready' : 'partial', data, complete, readId: outcome.readId,
        cursor: outcome.cursor, ...(complete ? {} : { error: persona.stale ? '画像来源状态可能已过期' : result.reason ?? '画像续页仍不完整' }) })
      if (outcome.cursor === undefined) void reader.closeCurrent()
    }).catch((error: unknown) => {
      if (reader.isCurrent(token)) {
        setBoundedPersonaArea({ status: 'error', error: error instanceof Error ? error.message : '画像续页读取失败' })
        void reader.closeCurrent()
      }
    })
  }

  const continueGlobalPersonaRead = (): void => {
    const area = boundedGlobalArea
    const reader = dashboardReaderPoolRef.current?.get('global-persona')
    const token = globalPersonaReadTokenRef.current
    if (reader === undefined || token === undefined || area.readId === undefined || area.cursor === undefined || reader.readId !== area.readId) return
    setBoundedGlobalArea({ ...area, status: 'loading', error: undefined })
    void continueDashboardScopedPage(reader, token, area.readId, area.cursor, 'globalPersona', 12).then((outcome) => {
      if ('stale' in outcome || !reader.isCurrent(token)) return
      if ('error' in outcome) {
        setBoundedGlobalArea({ status: 'error', error: outcome.error instanceof Error ? outcome.error.message : '全局画像续页读取失败' })
        void reader.closeCurrent()
        return
      }
      const result = outcome.result
      if ((result.status !== 'ok' && result.status !== 'partial') || result.globalPersona === undefined) {
        setBoundedGlobalArea({ status: 'error', error: result.reason ?? '全局画像状态未返回' })
        void reader.closeCurrent()
        return
      }
      const complete = result.complete && outcome.complete && result.globalPersona?.stale !== true
      setBoundedGlobalArea({ status: complete ? 'ready' : 'partial', data: result.globalPersona, complete,
        readId: outcome.readId, cursor: outcome.cursor,
        ...(complete ? {} : { error: result.globalPersona?.stale ? '全局画像来源状态可能已过期' : result.reason ?? '全局画像续页仍不完整' }) })
      if (outcome.cursor === undefined) void reader.closeCurrent()
    }).catch((error: unknown) => {
      if (reader.isCurrent(token)) {
        setBoundedGlobalArea({ status: 'error', error: error instanceof Error ? error.message : '全局画像续页读取失败' })
        void reader.closeCurrent()
      }
    })
  }

  const continueSceneRead = (): void => {
    const area = boundedSceneArea
    const reader = dashboardReaderPoolRef.current?.get('scene')
    const token = sceneReadTokenRef.current
    if (reader === undefined || token === undefined || area.readId === undefined || area.cursor === undefined || reader.readId !== area.readId) return
    setBoundedSceneArea({ ...area, status: 'loading', error: undefined })
    void continueDashboardScopedPage(reader, token, area.readId, area.cursor, 'scene', 12).then((outcome) => {
      if ('stale' in outcome || !reader.isCurrent(token)) return
      if ('error' in outcome) {
        setBoundedSceneArea({ status: 'error', error: outcome.error instanceof Error ? outcome.error.message : '场景续页读取失败' })
        void reader.closeCurrent()
        return
      }
      const result = outcome.result
      if ((result.status !== 'ok' && result.status !== 'partial') || result.scene === undefined) {
        setBoundedSceneArea({ status: 'error', error: result.reason ?? '场景状态未返回' })
        void reader.closeCurrent()
        return
      }
      const visible = result.scene.items.flatMap((item) => item.state === 'visible' && item.name !== undefined && item.summary !== undefined
        ? [{ projectKey: item.projectKey, projectName: item.projectName, name: item.name,
          summary: item.summary, memoryCount: item.memoryCount, summaryComplete: item.summaryComplete }]
        : [])
      const byName = new Map((area.data ?? []).map((item) => [`${item.projectKey}\u0000${item.name}`, item]))
      for (const item of visible) byName.set(`${item.projectKey}\u0000${item.name}`, item)
      const scenes = [...byName.values()]
      const hasHidden = area.hasHidden === true || visible.length !== result.scene.items.length
      const complete = result.complete && outcome.complete && !hasHidden && scenes.every((item) => item.summaryComplete)
      setBoundedSceneArea({ status: complete ? 'ready' : 'partial', data: scenes, complete, readId: outcome.readId,
        cursor: outcome.cursor, hasHidden,
        ...(complete ? {} : { error: result.reason ?? '部分场景因权限、来源或摘要完整度限制而未展示' }) })
      if (outcome.cursor === undefined) void reader.closeCurrent()
    }).catch((error: unknown) => {
      if (reader.isCurrent(token)) {
        setBoundedSceneArea({ status: 'error', error: error instanceof Error ? error.message : '场景续页读取失败' })
        void reader.closeCurrent()
      }
    })
  }

  const loadMoreMemories = (): void => {
    if (selectedProjectKey === '' || visibleLibraryLoading || libraryLoadedScope !== libraryScope ||
        (activeView !== 'memories' && activeView !== 'review')) return
    if (props.readDashboard !== undefined) {
      const reader = dashboardReaderPoolRef.current?.get('library')
      const token = libraryReadTokenRef.current
      const cursor = visibleBoundedLibraryCursor
      if (reader === undefined || token === undefined || cursor === undefined) return
      const currentGeneration = libraryGeneration.current
      const projectKey = selectedProjectKey
      const scope = libraryScope
      setLibraryLoading(true)
      void reader.load(token, { version: 1, action: 'continue', readId: reader.readId!, cursor }, { maxContinuations: 16 }).then((outcome) => {
        if (libraryGeneration.current !== currentGeneration || selectedProjectKeyRef.current !== projectKey || libraryLoadedScope !== scope || 'stale' in outcome) return
        if ('error' in outcome) throw outcome.error
        const result = outcome.result
        if (result.status !== 'ok' && result.status !== 'partial' && result.status !== 'budget_exhausted') {
          setLibraryRecords([])
          setBoundedLibraryCursor(undefined)
          setLibraryLoadedScope('')
          setLibraryError({ scope, message: result.reason ?? `记忆库不可用（${result.status}）` })
          void reader.closeCurrent()
          return
        }
        if (result.records === undefined) throw new Error(result.reason ?? '记忆库续页未返回记录状态')
        setLibraryRecords((items) => [...items, ...(result.records ?? []).filter((record) => record.content !== undefined) as unknown as MemoryView[]])
        setBoundedLibraryCursor(result.cursor)
        setLibraryPartial(result.status !== 'ok' || !result.complete)
        if (result.cursor === undefined) void reader.closeCurrent()
      }).catch((error: unknown) => {
        if (libraryGeneration.current === currentGeneration) {
          setBoundedLibraryCursor(undefined)
          setLibraryError({ scope, message: error instanceof Error ? error.message : 'library page load failed' })
          void reader.closeCurrent()
        }
      }).finally(() => { if (libraryGeneration.current === currentGeneration) setLibraryLoading(false) })
      return
    }
    if (visibleLibraryCursor === undefined || props.library === undefined) return
    const currentGeneration = libraryGeneration.current
    const projectKey = selectedProjectKey
    const status = requestedLibraryStatus
    const scope = libraryScope
    const after = visibleLibraryCursor
    setLibraryLoading(true)
    void props.library({ projectKey, ...(status === undefined ? {} : { status }), after, limit: 100 })
      .then((result) => { if (libraryGeneration.current === currentGeneration && selectedProjectKey === projectKey && libraryLoadedScope === scope) { setLibraryRecords((items) => [...items, ...result.records]); setLibraryCursor(result.next) } })
      .catch((error: unknown) => { if (libraryGeneration.current === currentGeneration) setNotice(error instanceof Error ? error.message : 'library page load failed') })
      .finally(() => { if (libraryGeneration.current === currentGeneration) setLibraryLoading(false) })
  }

  const loadMoreDetails = (): void => {
    if (selectedProjectKey === '' || (!detailRange && detailDate === '') || detailLoading) return
    if (props.readDashboard !== undefined && detailFingerprint === '' && boundedDetailCursor !== undefined) {
      const reader = dashboardReaderPoolRef.current?.get('detail')
      const token = detailReadTokenRef.current
      const readId = reader?.readId
      if (reader === undefined || token === undefined || readId === undefined) return
      const current = detailGeneration.current
      const cursor = boundedDetailCursor
      setDetailLoading(true)
      setDetailReadError(undefined)
      void reader.load(token, { version: 1, action: 'continue', readId, cursor }, { maxContinuations: 12 }).then((outcome) => {
        if (detailGeneration.current !== current || !reader.isCurrent(token) || 'stale' in outcome) return
        if ('error' in outcome) throw outcome.error
        const result = outcome.result
        if (result.status !== 'ok' && result.status !== 'partial' && result.status !== 'budget_exhausted') {
          setDetailData(undefined)
          setBoundedDetailCursor(undefined)
          setDetailReadError(result.reason ?? `事件不可用（${result.status}）`)
          void reader.closeCurrent()
          return
        }
        if (result.events === undefined) throw new Error(result.reason ?? '事件续页未返回')
        const rows = result.events.map((event) => ({ ...event, occurredAt: event.createdAt, eventId: event.id }))
        if (rows.length > 0) setDetailData((previous) => ({ events: [...(previous?.events ?? []), ...rows] }))
        setBoundedDetailCursor(result.cursor)
        setDetailNotice(result.complete ? undefined : result.reason ?? '后续事件仍未完成读取')
        if (result.cursor === undefined) void reader.closeCurrent()
      }).catch((error: unknown) => {
        if (detailGeneration.current === current) {
          setBoundedDetailCursor(undefined)
          setDetailReadError(error instanceof Error ? error.message : '事件续页读取失败')
          void reader.closeCurrent()
        }
      }).finally(() => { if (detailGeneration.current === current) setDetailLoading(false) })
      return
    }
    if (props.readDashboard !== undefined && detailFingerprint !== '') {
      const controller = repeatedDetailControllerRef.current
      const reader = dashboardReaderPoolRef.current?.get('repeated-detail')
      const cursor = repeatedDetailCursor
      if (controller === undefined || reader?.readId === undefined || cursor === undefined) return
      const generation = repeatedDetailGeneration.current + 1
      repeatedDetailGeneration.current = generation
      const token = controller.start()
      setDetailLoading(true)
      setDetailReadError(undefined)
      void controller.next(token, { readId: reader.readId, cursor }).then((outcome) => {
        if (repeatedDetailGeneration.current !== generation || 'stale' in outcome) return
        if ('error' in outcome) {
          // Transport failure keeps the already loaded page but must still be
          // shown as an error; it is never converted into an empty success.
          setRepeatedDetailCursor(undefined); void reader.closeCurrent()
          setDetailReadError(outcome.error instanceof Error ? outcome.error.message : 'event detail unavailable')
          return
        }
        const result = outcome.result as ReadDashboardResult | undefined
        const classified = classifyRepeatedResult(result, 'events')
        if (classified.kind === 'failed') {
          // Revocation/invalidity withdraws the old body before the failure.
          setDetailData(undefined)
          setRepeatedDetailCursor(undefined)
          setDetailNotice(undefined)
          setDetailReadError(classified.reason)
          void reader.closeCurrent()
          return
        }
        const rows = (classified.repeated.events ?? []).map(repeatedEventRow)
        if (rows.length > 0) setDetailData((previous) => ({ events: [...(previous?.events ?? []), ...rows] }))
        setRepeatedDetailCursor(typeof result?.cursor === 'string' ? result?.cursor : undefined)
        if (result?.cursor === undefined) void reader.closeCurrent()
        setDetailNotice(classified.kind === 'incomplete' &&
          (result?.status === 'budget_exhausted' || typeof result?.cursor !== 'string') ? classified.reason : undefined)
      }).catch((error: unknown) => {
        if (repeatedDetailGeneration.current === generation) {
          setRepeatedDetailCursor(undefined); void reader.closeCurrent()
          setDetailReadError(error instanceof Error ? error.message : 'event detail unavailable')
        }
      }).finally(() => {
        if (repeatedDetailGeneration.current === generation) setDetailLoading(false)
      })
      return
    }
    if (detailData?.next === undefined || props.manage === undefined) return
    const current = detailGeneration.current
    const projectKey = selectedProjectKey
    const next = detailData.next
    const otherValues = props.readDashboard !== undefined ? boundedDimensionValues(boundedOverviewData, detailDimension, detailActivity)
      : detailDimensionValues(overviewData, detailDimension)
    if (detailValue === '__other__' && otherValues === undefined) { setDetailNotice('当前活动分组不可用，请刷新统计。'); return }
    setDetailLoading(true)
    void props.manage({ projectKey, operation: 'overview.detail', payload: {
      ...(detailRange ? { from, to } : { date: detailDate }), timeZone: overviewTimeZone, activity: detailActivity,
      ...(detailValue === '' ? {} : { dimension: detailDimension, value: detailValue,
        ...(detailValue === '__other__' ? { otherValues } : {}) }), after: next, limit: 50,
      ...(detailFingerprint === '' ? {} : { fingerprint: detailFingerprint, includeExcerpt: detailIncludeExcerpt }),
    } }).then((value) => {
      const result = unwrapManagement(value) as { events?: Array<Record<string, unknown>>; next?: { occurredAt: number; id: number } }
      if (detailGeneration.current === current && selectedProjectKey === projectKey) setDetailData((previous) => ({ events: [...(previous?.events ?? []), ...(result.events ?? [])], ...(result.next === undefined ? {} : { next: result.next }) }))
    }).catch((error: unknown) => { if (detailGeneration.current === current) setManageError(error instanceof Error ? error.message : 'event detail unavailable') })
      .finally(() => { if (detailGeneration.current === current) setDetailLoading(false) })
  }

  const loadMoreProcessingJobs = (): void => {
    const page = asRecord(manageData.processingJobsPage)
    const next = page.next !== null && typeof page.next === 'object' ? page.next as Record<string, unknown> : undefined
    if (selectedProjectKey === '' || props.manage === undefined || next === undefined || processingJobsLoading) return
    const projectKey = selectedProjectKey
    const currentGeneration = manageGeneration.current
    setProcessingJobsLoading(true)
    void props.manage({ projectKey, operation: 'processing.jobs', payload: { after: next, filter: processingJobsFilter, limit: 20 } }).then((value) => {
      if (manageGeneration.current !== currentGeneration || selectedProjectKeyRef.current !== projectKey) return
      const result = asRecord(unwrapManagement(value))
      const oldJobs = asRecords(page.jobs)
      setManageData((current) => ({ ...current, processingJobsPage: { ...result, jobs: [...oldJobs, ...asRecords(result.jobs)] } }))
    }).catch((error: unknown) => { if (manageGeneration.current === currentGeneration) setManageError(error instanceof Error ? error.message : '任务分页读取失败') })
      .finally(() => { if (manageGeneration.current === currentGeneration) setProcessingJobsLoading(false) })
  }

  const loadMoreEvaluationRuns = (): void => {
    const page = asRecord(manageData.evaluation)
    const next = page.next !== null && typeof page.next === 'object' ? page.next as Record<string, unknown> : undefined
    if (selectedProjectKey === '' || props.manage === undefined || next === undefined || evaluationRunsLoading || manageBusy) return
    const projectKey = selectedProjectKey
    const currentGeneration = manageGeneration.current
    setEvaluationRunsLoading(true)
    void props.manage({ projectKey, operation: 'evaluation.list', payload: { after: next, limit: 40 } }).then((value) => {
      if (manageGeneration.current !== currentGeneration || selectedProjectKeyRef.current !== projectKey) return
      const result = asRecord(unwrapManagement(value))
      const additionalRuns = asRecords(result.runs)
      setManageData((current) => {
        const previous = asRecord(current.evaluation)
        const byId = new Map(asRecords(previous.runs).map((run) => [String(run.id), run]))
        for (const run of additionalRuns) byId.set(String(run.id), run)
        return { ...current, evaluation: { ...previous, ...result, runs: [...byId.values()] } }
      })
    }).catch((error: unknown) => { if (manageGeneration.current === currentGeneration) setManageError(error instanceof Error ? error.message : '评测历史分页读取失败') })
      .finally(() => { if (manageGeneration.current === currentGeneration) setEvaluationRunsLoading(false) })
  }

  const loadMoreCoverage = (): void => {
    const page = asRecord(manageData.processingCoveragePage)
    const beforeId = typeof page.nextBeforeId === 'number' ? page.nextBeforeId : undefined
    if (selectedProjectKey === '' || props.manage === undefined || beforeId === undefined || coverageLoading) return
    const projectKey = selectedProjectKey
    const currentGeneration = manageGeneration.current
    setCoverageLoading(true)
    void props.manage({ projectKey, operation: 'processing.coverage', payload: { beforeId, limit: 20 } }).then((value) => {
      if (manageGeneration.current !== currentGeneration || selectedProjectKeyRef.current !== projectKey) return
      const result = asRecord(unwrapManagement(value))
      const oldWindows = asRecords(page.windows)
      setManageData((current) => ({ ...current, processingCoveragePage: { ...result, windows: [...oldWindows, ...asRecords(result.windows)] } }))
    }).catch((error: unknown) => { if (manageGeneration.current === currentGeneration) setManageError(error instanceof Error ? error.message : '覆盖窗口分页读取失败') })
      .finally(() => { if (manageGeneration.current === currentGeneration) setCoverageLoading(false) })
  }

  const showMoreRepeated = (): void => {
    if (props.readDashboard !== undefined) {
      if (repeatedScanCursor !== undefined) { continueRepeatedScan(); return }
      if (repeatedVisibleCount < repeatedGroups.length) {
        setRepeatedVisibleCount((count) => Math.min(repeatedGroups.length, count + 10)); return
      }
      const controller = repeatedGroupControllerRef.current
      const reader = dashboardReaderPoolRef.current?.get('repeated-groups')
      const last = repeatedGroups[repeatedGroups.length - 1]
      if (controller === undefined || reader?.readId === undefined || last === undefined || repeatedLoading || !repeatedHasMore) return
      const generation = repeatedGroupGeneration.current + 1
      repeatedGroupGeneration.current = generation
      const token = controller.start()
      setRepeatedLoading(true)
      // Ranking pagination re-enters the stable (repeatCount, fingerprint,
      // projectKey) cursor instead of a transient continuation, so a later
      // event drill-down or scope check cannot invalidate it.
      void controller.load(token, {
        version: 1, action: 'repeated', readId: reader.readId,
        target: { kind: 'groups', projectKeys: [selectedProjectKey], limit: 10,
          after: { repeatCount: last.repeatCount, fingerprint: last.fingerprint, projectKey: last.projectKey } },
      }).then((outcome) => {
        if (repeatedGroupGeneration.current !== generation || 'stale' in outcome) return
        if ('error' in outcome) {
          setRepeatedScanCursor(undefined); setRepeatedHasMore(false); void reader.closeCurrent()
          setRepeatedReadError(outcome.error instanceof Error ? outcome.error.message : '重复线索分页读取失败')
          return
        }
        const result = outcome.result as ReadDashboardResult | undefined
        const classified = classifyRepeatedResult(result, 'groups')
        if (classified.kind === 'failed') {
          // An invalidated ranking cursor withdraws the old group counts and
          // source entry points together with the failed page.
          setRepeatedGroups([])
          setRepeatedVisibleCount(10)
          setRepeatedHasMore(false)
          setRepeatedScanCursor(undefined)
          setRepeatedReadState('error')
          setRepeatedReadNotice(undefined)
          setRepeatedReadError(classified.reason)
          void reader.closeCurrent()
          return
        }
        const rows = (classified.repeated.groups ?? []) as BoundedRepeatedGroup[]
        if (rows.length > 0) {
          setRepeatedGroups((items) => {
            const known = new Set(items.map((item) => `${item.projectKey}\u0000${item.fingerprint}`))
            return [...items, ...rows.filter((item) => !known.has(`${item.projectKey}\u0000${item.fingerprint}`))]
          })
          setRepeatedVisibleCount((count) => count + 10)
        }
        setRepeatedHasMore(classified.kind === 'complete' && classified.repeated.hasMore === true &&
          typeof result?.cursor === 'string')
        setRepeatedReadNotice(classified.kind === 'complete' ? undefined : classified.reason)
        setRepeatedReadError(undefined)
        setRepeatedScanCursor(classified.kind === 'incomplete' ? result?.cursor : undefined)
        if (result?.cursor === undefined) void reader.closeCurrent()
      }).catch((error: unknown) => {
        if (repeatedGroupGeneration.current === generation) {
          setRepeatedScanCursor(undefined); setRepeatedHasMore(false); void reader.closeCurrent()
          setRepeatedReadError(error instanceof Error ? error.message : '重复线索分页读取失败')
        }
      }).finally(() => {
        if (repeatedGroupGeneration.current === generation) setRepeatedLoading(false)
      })
      return
    }
    const currentRows = [...(overviewData?.period.repeated ?? []), ...repeatedExtra]
    if (repeatedVisibleCount < currentRows.length) { setRepeatedVisibleCount((count) => Math.min(currentRows.length, count + 10)); return }
    const after = currentRows.at(-1)
    if (selectedProjectKey === '' || props.manage === undefined || after === undefined || repeatedLoading || repeatedExhausted || currentRows.length < 100) return
    const projectKey = selectedProjectKey
    const generationAtStart = overviewGeneration.current
    setRepeatedLoading(true)
    void props.manage({ projectKey, operation: 'overview.repeated', payload: {
      from, to, timeZone: overviewTimeZone,
      after: { repeatCount: after.repeatCount, fingerprint: after.fingerprint }, limit: 100,
    } }).then((value) => {
      if (overviewGeneration.current !== generationAtStart || selectedProjectKeyRef.current !== projectKey) return
      const page = asRecord(unwrapManagement(value))
      const rows = asRecords(page.items).flatMap((item) => typeof item.fingerprint === 'string' && typeof item.repeatCount === 'number'
        ? [{ fingerprint: item.fingerprint, repeatCount: item.repeatCount }] : [])
      const known = new Set([...currentRows, ...repeatedExtra].map((item) => item.fingerprint))
      const uniqueRows = rows.filter((item) => !known.has(item.fingerprint))
      setRepeatedExtra((items) => {
        const existing = new Set([...currentRows, ...items].map((item) => item.fingerprint))
        return [...items, ...uniqueRows.filter((item) => !existing.has(item.fingerprint))]
      })
      setRepeatedVisibleCount((count) => count + 10)
      if (page.next === undefined || uniqueRows.length === 0) setRepeatedExhausted(true)
    }).catch((error: unknown) => { if (overviewGeneration.current === generationAtStart) setManageError(error instanceof Error ? error.message : '重复线索分页读取失败') })
      .finally(() => { if (overviewGeneration.current === generationAtStart) setRepeatedLoading(false) })
  }

  const settingsStatus = (): ReactNode => (
    <>
      {settingsLoading && <p className="tdai-muted" role="status">正在读取配置…</p>}
      {settingsSaving && <p className="tdai-muted" role="status">正在保存配置…</p>}
      {settingsError !== undefined && <div className="tdai-danger-text" role="alert">
        <span>{settingsError}</span>
        <button type="button" disabled={settingsLoading || settingsSaving || props.readDashboard === undefined} onClick={() => void readSettings()}>重试</button>
      </div>}
      {settingsLastError !== undefined && <p className="tdai-muted" role="status">运行时提示：{settingsLastError}</p>}
      {settingsNotice !== undefined && <p className="tdai-notice" role="status">{settingsNotice}</p>}
    </>
  )

  const renderSettingsPanel = (compact: boolean): ReactNode => {
    if (settingsValue === undefined) {
      return <section className="tdai-panel tdai-settings"><div className="tdai-panel-head">
        <h3>行为设置</h3><span>独立读取，不依赖项目或概览</span></div>{settingsStatus()}</section>
    }
    const disabled = settingsSaving || settingsLoading || props.updateSettingsAck === undefined || props.readDashboard === undefined
    return <section className="tdai-panel tdai-settings">
      <div className="tdai-panel-head"><h3>行为设置</h3><span>{compact ? '与配置页共用实际值' : '仅本地保存'}</span></div>
      {settingsPreview && <p className="tdai-muted" role="status">预览配置：仅显示 initialSnapshot 提供的值，当前没有实际读取/保存接口。</p>}
      <label className="tdai-field"><span>记忆模式</span><select value={settingsValue.mode} disabled={disabled}
        onChange={(event) => void saveSettings({ mode: event.currentTarget.value as UpdateSettingsRequest['mode'] }, 'mode saved')}>
        <option value="review">review — 全部人工审核</option><option value="balanced">balanced — 高置信度自动通过</option><option value="auto">auto — 立即可用</option>
      </select></label>
      <SettingsNumberField label="召回 Token 预算" value={settingsValue.recallMaxTokens} minimum={40} maximum={4000}
        disabled={disabled} resetToken={settingsReadRevision} onCommit={(value) => void saveSettings({ recallMaxTokens: value }, 'budget saved')}
        onInvalid={(message) => setSettingsNotice(message)} />
      {!compact && <>
        <SettingsNumberField label="每 N 轮提取" value={settingsValue.extractionEveryN} minimum={1} maximum={100}
          disabled={disabled} resetToken={settingsReadRevision} onCommit={(value) => void saveSettings({ extractionEveryN: value }, 'schedule saved')}
          onInvalid={(message) => setSettingsNotice(message)} />
        <label className="tdai-check"><input type="checkbox" checked={settingsValue.extractionEnabled} disabled={disabled}
          onChange={(event) => void saveSettings({ extractionEnabled: event.currentTarget.checked }, event.currentTarget.checked ? 'extraction enabled' : 'automatic extraction paused')} /><span>启用自动提取（关闭后仅停止自动排程）</span></label>
        <p className="tdai-muted">每次请求都会按当前批准状态、修订、排除和遗忘规则重建有界记忆块；缺少 Host 保留回执时不会跳过重读。旧版会话去重设置仅为兼容保留。</p>
      </>}
      <label className="tdai-check"><input type="checkbox" checked={settingsValue.includePersona} disabled={disabled}
        onChange={(event) => void saveSettings({ includePersona: event.currentTarget.checked }, 'profile saved')} /><span>召回时包含项目画像</span></label>
      <label className="tdai-check"><input type="checkbox" checked={settingsValue.globalPersona} disabled={disabled}
        onChange={(event) => void saveSettings({ globalPersona: event.currentTarget.checked }, 'global profile saved')} /><span>项目无画像时允许全局画像</span></label>
      {!compact && <div className="tdai-toolbar">
        <button type="button" disabled={disabled || busy || selectedProjectKey === '' || props.refreshPersona === undefined} onClick={regenerate}>重新生成项目画像</button>
        <button type="button" disabled={disabled || busy || props.refreshGlobalPersona === undefined} onClick={regenerateGlobal}>重新生成全局画像</button>
      </div>}
      {!compact && notice !== undefined && <p className="tdai-notice" role="status">{notice}</p>}
      {settingsStatus()}
    </section>
  }

  const shellNavigation = (
    <nav className="tdai-nav" aria-label="记忆功能分区">
      {([
        ['overview', '概览'], ['memories', '记忆库'], ['review', '待确认'], ['processing', '处理状态'], ['explain', '召回解释'],
        ['continuity', '任务接续'], ['experiences', '经验卡'], ['relations', '修订关系'], ['knowledge', '决策知识'],
        ['evaluation', '本地评测'], ['governance', '用量治理'], ['recovery', '恢复'], ['settings', '配置'],
      ] as const).map(([view, label]) => <button key={view} type="button" aria-current={activeView === view ? 'page' : undefined}
        data-tdai-focus-key={view === 'overview' ? 'overview-nav' : undefined}
        className={activeView === view ? 'active' : ''} onClick={(event) => navigateView(view, event.currentTarget)}>{label}</button>)}
    </nav>
  )

  const shellProjectPicker = (
    <label className="tdai-field tdai-project-picker"><span>项目</span>
      <select value={selectedProjectKey} disabled={props.readDashboard !== undefined ? scopeProjects.length === 0 : snapshot === undefined} onChange={(event) => {
      const nextProjectKey = event.currentTarget.value
      invalidateActionScope()
      pendingOverviewRestoreRef.current = undefined
        overviewReturnRef.current = undefined
        setOverviewData(undefined); setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined)
        setOverviewLoadedScope(''); setOverviewError(undefined)
        setOverviewLoading(nextProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined) && (activeView === 'overview' || activeView === 'processing'))
        setLibraryError(undefined)
        setSelectedProjectKey(nextProjectKey)
      }} aria-label="当前项目">
        <option value="">选择项目</option>
        {viewProjectIdentities.map((project) => <option key={project.key} value={project.key}>{project.name}</option>)}
      </select>
    </label>
  )

  if (!snapshot && activeView === 'overview' && props.readDashboard === undefined) {
    return <Shell>
      <header className="tdai-header"><div className="tdai-brand"><span className="tdai-glyph" aria-hidden="true">◈</span><div>
        <div className="tdai-kicker">TDAI MEMORY <span>· 项目记忆</span></div><h2>长期记忆</h2></div></div>{shellProjectPicker}</header>
      {shellNavigation}
      {failed
        ? <div className="tdai-error"><p>无法读取本地记忆概览。</p><button type="button" onClick={() => void refresh()}>重试</button></div>
        : <div className="tdai-loading">正在读取本地记忆状态…</div>}
    </Shell>
  }
  const viewCandidates = snapshot?.candidates ?? []
  const viewRecent = snapshot?.recent ?? []
  const viewPersona = props.readDashboard !== undefined ? boundedPersonaArea.data : snapshot?.personas.find((persona) => persona.projectKey === selectedProjectKey)
  const viewGlobalPersona = props.readDashboard !== undefined ? boundedGlobalArea.data ?? null : snapshot?.globalPersona ?? null
  const viewScenes = props.readDashboard !== undefined ? boundedSceneArea.data ?? [] : snapshot?.scenes ?? []
  const viewLastError = snapshot?.lastError
  const selectedProject = viewProjectIdentities.find((project) => project.key === selectedProjectKey)
  const selectedBoundedProject = props.readDashboard !== undefined
    ? boundedView?.projects.find((project) => project.key === selectedProjectKey)
    : undefined
  const selectedLegacyProject = props.readDashboard === undefined
    ? previewSnapshot?.projects.find((project) => project.key === selectedProjectKey)
    : undefined
  const forgottenSummaryText = selectedProject === undefined ? '—'
    : selectedBoundedProject !== undefined
      ? selectedBoundedProject.forgottenMetric === undefined ? '—' : metricText(selectedBoundedProject.forgottenMetric)
      : selectedLegacyProject === undefined || selectedLegacyProject.memories === undefined ||
          selectedLegacyProject.approved === undefined || selectedLegacyProject.candidates === undefined
        ? '—' : String(selectedLegacyProject.memories - selectedLegacyProject.approved - selectedLegacyProject.candidates)
  const selectedPersona = viewPersona
  const taskItems = asRecords(manageData.tasks)
  const experienceItems = asRecords(manageData.experiences)
  const relationItems = asRecords(manageData.relations)
  const revisionItems = asRecords(manageData.revisions)
  const knowledgeItems = asRecords(manageData.knowledge)
  const knowledgeFocusIsListed = knowledgeFocusId !== '' && knowledgeItems.some((group) => asRecords(group.entries).some((entry) => String(entry.id ?? '') === knowledgeFocusId))
  const focusedKnowledge = asRecord(knowledgeDetails[knowledgeFocusId])
  const focusedKnowledgeMemory = asRecord(focusedKnowledge.memory)
  const focusedKnowledgeImpact = asRecord(focusedKnowledge.derivedImpact)
  const evaluationState = asRecord(manageData.evaluation)
  const evaluationCases = asRecords(evaluationState.cases)
  const evaluationRuns = asRecords(evaluationState.runs)
  const evaluationRunGroups = (() => {
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const run of evaluationRuns) {
      const pairId = typeof run.pairId === 'string' && run.pairId !== '' ? run.pairId : `single:${String(run.id)}`
      const current = groups.get(pairId) ?? []
      current.push(run)
      groups.set(pairId, current)
    }
    return [...groups.entries()]
  })()
  const scopedManageResult = manageResultProjectKey === selectedProjectKey ? manageResult : undefined
  const latestEvaluation = asRecord(activeView === 'evaluation' ? scopedManageResult : undefined)
  const latestBaseline = asRecord(latestEvaluation.baseline)
  const latestCandidate = asRecord(latestEvaluation.candidate)
  const latestBaselineResult = asRecord(latestBaseline.result)
  const latestCandidateResult = asRecord(latestCandidate.result)
  const strategyState = asRecord(manageData.strategies)
  const strategies = asRecords(strategyState.strategies)
  const governanceAttempts = asRecords(manageData.attempts)
  const billableCalls = asRecords(manageData.billableCalls)
  const contentInventory = asRecord(manageData.contentInventory)
  const deletionMemoryOptions = asRecords(contentInventory.memories)
  const deletionSourceOptions = asRecords(contentInventory.sources)
  const deletionOffloadOptions = displayList(contentInventory.offloadIds)
  const billableUsage = asRecord(manageData.billableUsage)
  const recoveryItems = asRecords(manageData.recovery)
  const processingJobsPage = asRecord(manageData.processingJobsPage)
  const processingCoveragePage = asRecord(manageData.processingCoveragePage)
  const boundedSessions = boundedOverviewData?.sessions
  const processingQueuedText = props.readDashboard !== undefined ? metricText(boundedOverviewData?.processing?.queued)
    : String(overviewData?.processing.queued ?? '—')
  const processingFailedText = props.readDashboard !== undefined ? metricText(boundedOverviewData?.processing?.failed)
    : String(overviewData?.processing.failed ?? '—')
  const processingUncertainText = props.readDashboard !== undefined ? metricText(boundedOverviewData?.processing?.uncertainUsage)
    : String(overviewData?.processing.uncertainUsage ?? '—')
  const processingJobs = (manageData.processingJobsPage === undefined ? overviewData?.processing.jobs ?? [] : asRecords(processingJobsPage.jobs)) as Array<{ id: string; status: OverviewResult['processing']['jobs'][number]['status']; createdAt?: number; updatedAt: number; provider?: string; model?: string; hasError: boolean; error?: string }>
  const processingCoverageWindows = (manageData.processingCoveragePage === undefined ? overviewData?.coverage.windows.slice(-8).reverse() ?? [] : asRecords(processingCoveragePage.windows)) as Array<{ id: number; startedAt: number; endedAt: number | null; status: 'active' | 'closed' | 'interrupted'; policyRevision: string }>
  const recoveryPlanState = asRecord(activeView === 'recovery' ? scopedManageResult : undefined)
  const recoveryPlanReady = recoveryPlanState.snapshotId === recoverySnapshotId && recoveryPlanState.restoreApplyReady === true
  const projectCandidates = selectedProjectKey === '' ? [] : activeView === 'review'
    ? visibleLibraryRecords.filter((memory) => memory.status === 'candidate')
    : viewCandidates.filter((memory) => memory.projectKey === selectedProjectKey)
  const projectRecent = selectedProjectKey === '' ? [] : viewRecent.filter((memory) => memory.projectKey === selectedProjectKey)
  const filteredCandidates = filterMemories(projectCandidates, query)
  const filteredRecent = filterMemories(projectRecent, query)
  const sourceList = overviewData?.period.sources ?? []
  const maxSource = Math.max(1, ...sourceList.map((source) => source.count))
  const activityValues = overviewData?.period.activity.map((day) => activity === 'capture' ? day.captures : activity === 'recall' ? day.recalls : activity === 'initial_approval' ? day.initialApprovals : activity === 'injection' ? day.preparedInjectionEvents : day.revisions) ?? []
  const maxActivity = Math.max(1, ...activityValues)
  const dimensionGroups = overviewData === undefined ? [] : detailDimension === 'source'
    ? overviewData.period.sources.map((item) => ({ value: item.other ? '__other__' : item.source, count: item.count }))
    : detailDimension === 'agent' ? overviewData.period.agents.map((item) => ({ value: item.other ? '__other__' : item.agentId, count: item.count }))
      : detailDimension === 'agent_preset' ? overviewData.period.agentPresets.map((item) => ({ value: item.other ? '__other__' : item.agentPreset, count: item.count }))
        : detailDimension === 'provider' ? overviewData.period.providers.map((item) => ({ value: item.other ? '__other__' : item.provider, count: item.count }))
          : overviewData.period.models.map((item) => ({ value: item.other ? '__other__' : item.model, count: item.count }))
  const heatmap = makeHeatmapDays(from, to, overviewData?.period.activity ?? [], activity)
  const heatmapMonths = monthKeys(from, to)
  const monthlyHeatmap = makeMonthlyHeatmapDays(heatmapMonth, from, to, overviewData?.period.activity ?? [], activity)
  // The bounded chain owns the repeated-capture list; the old overview DTO is
  // only a legacy/preview fallback when no bounded reader is wired.
  const boundedRepeated = props.readDashboard !== undefined
  const repeatedItems: Array<{ fingerprint: string; repeatCount: number }> = boundedRepeated
    ? repeatedGroups.map((item) => ({ fingerprint: item.fingerprint, repeatCount: item.repeatCount }))
    : [...(overviewData?.period.repeated ?? []), ...repeatedExtra]
  const repeatedReady = boundedRepeated
    ? repeatedReadState === 'ready' || repeatedReadState === 'partial'
    : overviewData !== undefined
  const clearDetailScope = (): void => {
    setDetailActivityOverride(undefined)
    pendingOverviewRestoreRef.current = undefined
    setOverviewData(undefined); setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined)
    setOverviewLoadedScope(''); setOverviewError(undefined)
    setBoundedPersonaArea({ status: 'idle' }); setBoundedGlobalArea({ status: 'idle' }); setBoundedSceneArea({ status: 'idle' })
    setOverviewLoading(selectedProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined) && (activeView === 'overview' || activeView === 'processing'))
    detailGeneration.current += 1
    setDetailDate(''); setDetailRange(false); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false)
    setDetailData(undefined); setDetailLoading(false)
    setRepeatedDetailCursor(undefined)
    setDetailReadError(undefined); setDetailNotice(undefined)
  }
  const changeOverviewTimeZone = (nextTimeZone: string): void => {
    if (nextTimeZone === overviewTimeZone || !timeZoneOptions.includes(nextTimeZone)) return
    invalidateActionScope()
    pendingOverviewRestoreRef.current = undefined
    overviewGeneration.current += 1
    detailGeneration.current += 1
    setDetailActivityOverride(undefined)
    setOverviewTimeZone(nextTimeZone)
    setOverviewData(undefined); setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined)
    setOverviewLoadedScope(''); setOverviewError(undefined)
    setBoundedPersonaArea({ status: 'idle' }); setBoundedGlobalArea({ status: 'idle' }); setBoundedSceneArea({ status: 'idle' })
    setOverviewLoading(selectedProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined) && (activeView === 'overview' || activeView === 'processing'))
    setDetailDate(''); setDetailRange(false); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false)
    setDetailData(undefined); setDetailLoading(false)
    setRepeatedExtra([]); setRepeatedVisibleCount(10); setRepeatedExhausted(false); setRepeatedLoading(false)
    repeatedGroupGeneration.current += 1; repeatedDetailGeneration.current += 1
    setRepeatedGroups([]); setRepeatedHasMore(false); setRepeatedScanCursor(undefined)
    setRepeatedReadState('idle'); setRepeatedReadNotice(undefined); setRepeatedReadError(undefined)
    setRepeatedDetailCursor(undefined); setDetailReadError(undefined); setDetailNotice(undefined)
  }
  const setManualRangeDate = (field: 'from' | 'to', value: string): void => {
    invalidateActionScope()
    if (field === 'from') setFrom(value)
    else setTo(value)
    clearDetailScope()
  }
  const setQuickRange = (days: number | 'year'): void => {
    invalidateActionScope()
    const end = isoDateInTimeZone(new Date(), overviewTimeZone)
    const start = days === 'year' ? `${end.slice(0, 4)}-01-01` : shiftIsoCalendarDate(end, -days + 1)
    setFrom(start); setTo(end); clearDetailScope()
  }
  const shiftMonth = (offset: number): void => {
    invalidateActionScope()
    const current = parseIsoCalendarDate(from) ?? isoDateInTimeZone(new Date(), overviewTimeZone)
    const [year, month] = current.split('-').map(Number)
    const target = new Date(Date.UTC(year!, month! - 1 + offset, 1))
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0))
    setFrom(formatUtcCalendarDate(target)); setTo(formatUtcCalendarDate(last)); clearDetailScope()
  }
  const changeOverviewActivity = (nextActivity: typeof activity): void => {
    if (nextActivity === activity) return
    invalidateActionScope()
    pendingOverviewRestoreRef.current = undefined
    setOverviewData(undefined); setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined)
    setOverviewLoadedScope(''); setOverviewError(undefined)
    setBoundedPersonaArea({ status: 'idle' }); setBoundedGlobalArea({ status: 'idle' }); setBoundedSceneArea({ status: 'idle' })
    setOverviewLoading(selectedProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined) && (activeView === 'overview' || activeView === 'processing'))
    setDetailActivityOverride(undefined)
    setActivity(nextActivity)
    setDetailFingerprint(''); setDetailIncludeExcerpt(false)
  }
  const range = selectedProjectKey === '' ? '请选择项目' : `${from} — ${to} · ${overviewTimeZone}`

  const projectPicker = (
    <label className="tdai-field tdai-project-picker"><span>项目</span>
      <select value={selectedProjectKey} onChange={(event) => {
      const nextProjectKey = event.currentTarget.value
      invalidateActionScope()
      pendingOverviewRestoreRef.current = undefined
        overviewReturnRef.current = undefined
        setOverviewData(undefined); setBoundedOverviewData(undefined); setBoundedOverviewCursor(undefined)
        setOverviewLoadedScope(''); setOverviewError(undefined)
        setOverviewLoading(nextProjectKey !== '' && (props.overview !== undefined || props.readDashboard !== undefined) && (activeView === 'overview' || activeView === 'processing'))
        setLibraryError(undefined)
        setSelectedProjectKey(nextProjectKey)
      }} aria-label="当前项目">
        <option value="">选择项目</option>
        {viewProjectIdentities.map((project) => <option key={project.key} value={project.key}>{project.name}</option>)}
      </select>
    </label>
  )
  const navigation = (
      <nav className="tdai-nav" aria-label="记忆功能分区">
      {([
        ['overview', '概览'], ['memories', '记忆库'], ['review', '待确认'], ['processing', '处理状态'], ['explain', '召回解释'],
        ['continuity', '任务接续'], ['experiences', '经验卡'], ['relations', '修订关系'], ['knowledge', '决策知识'],
        ['evaluation', '本地评测'], ['governance', '用量治理'], ['recovery', '恢复'], ['settings', '配置'],
      ] as const).map(([view, label]) => <button key={view} type="button" aria-current={activeView === view ? 'page' : undefined}
        data-tdai-focus-key={view === 'overview' ? 'overview-nav' : undefined}
        className={activeView === view ? 'active' : ''} onClick={(event) => navigateView(view, event.currentTarget)}>{label}</button>)}
    </nav>
  )

  if (activeView !== 'overview') {
    return <Shell>
      <header className="tdai-header"><div className="tdai-brand"><span className="tdai-glyph" aria-hidden="true">◈</span><div>
        <div className="tdai-kicker">TDAI MEMORY <span>· 项目记忆</span></div><h2>长期记忆</h2></div></div>{projectPicker}</header>
      {navigation}
      {activeView === 'memories' && <section className="tdai-panel"><div className="tdai-panel-head"><h3>记忆库</h3><span>{selectedProject?.name ?? '先选择项目'}</span></div>
        <div className="tdai-toolbar"><select value={libraryStatus} onChange={(event) => changeLibraryStatus(event.currentTarget.value as typeof libraryStatus)} aria-label="记忆状态">
          <option value="all">全部状态</option><option value="approved">已审核</option><option value="candidate">待确认</option><option value="forgotten">已遗忘</option></select>
          <input value={query} onChange={(event) => changeLibraryQuery(event.currentTarget.value)} placeholder="筛选记忆…" aria-label="筛选记忆" />
          <button type="button" onClick={download} disabled={busy || selectedProject === undefined}>导出</button></div>
        {selectedProject === undefined && <p className="tdai-muted">请选择一个项目，记忆不会跨项目混排。</p>}
        <div className="tdai-list">{filterMemories(visibleLibraryRecords, query).map((memory) => <article className="tdai-memory" key={memory.id}>
          <div className="tdai-memory-top"><code>{memory.id}</code><span>{memory.status} · {memory.kind}</span></div><p>{memory.content}</p>
          <p className="tdai-muted">有效起始：{formatValidStart(memory as unknown as Record<string, unknown>)}</p>
          <div className="tdai-memory-actions"><span className="tdai-pill">r{memory.revision}</span><span className="tdai-pill">来源 {memory.sourceMessageIds.length}</span>
            {memory.status === 'approved' && <button type="button" disabled={knowledgeLoadingId === memory.id} onClick={() => openKnowledgeDetail(memory.id)}>{knowledgeLoadingId === memory.id ? '正在读取详情…' : '查看完整知识详情'}</button>}
            {memory.status === 'candidate' && <button type="button" disabled={busy} onClick={() => reviewMemory(memory, 'approve')}>审核通过</button>}
            {memory.status !== 'forgotten' && <button type="button" className="tdai-danger" disabled={busy} onClick={() => reviewMemory(memory, 'forget')}>遗忘</button>}</div>
          {knowledgeExpandedId === memory.id && knowledgeDetails[memory.id] !== undefined && <div className="tdai-detail-block"><h4>来源原文（每条最多 4000 字符）</h4>
            {asRecords(knowledgeDetails[memory.id]?.sources).length === 0 ? <p className="tdai-muted">当前没有可读取的来源文本。</p> : asRecords(knowledgeDetails[memory.id]?.sources).map((source) => <p key={String(source.id)}><span className="tdai-muted">{String(source.role ?? '')} · {source.createdAt === undefined ? '时间未知' : new Date(Number(source.createdAt)).toLocaleString()}</span><br />{String(source.content ?? '')}{source.contentTruncated === true ? ' …（已截断）' : ''}</p>)}
          </div>}
        </article>)}</div>
        {visibleLibraryLoading && <p className="tdai-muted" role="status">正在读取记忆库…</p>}
        {visibleLibraryError !== undefined && <div className="tdai-danger-text" role="alert"><span>记忆库读取失败：{visibleLibraryError}</span>
          <button type="button" onClick={() => { setLibraryError(undefined); setLibraryRefresh((value) => value + 1) }}>重试</button></div>}
        {(visibleLibraryCursor !== undefined || visibleBoundedLibraryCursor !== undefined) && <button type="button" className="tdai-load-more" disabled={visibleLibraryLoading} onClick={loadMoreMemories}>加载更多</button>}
      </section>}
        {activeView === 'review' && <section className="tdai-panel"><div className="tdai-panel-head"><h3>待确认</h3><span>{overviewData?.current.candidates ?? projectCandidates.length} 条</span></div>
        <div className="tdai-toolbar"><input value={query} onChange={(event) => changeLibraryQuery(event.currentTarget.value)} placeholder="筛选候选…" aria-label="筛选候选" /></div>
        {selectedProject === undefined && <p className="tdai-muted">请选择一个项目。</p>}
        <div className="tdai-list">{filteredCandidates.map((memory) => <article className="tdai-memory" key={memory.id}><div className="tdai-memory-top"><code>{memory.id}</code><span>{memory.kind} · {Math.round(memory.confidence * 100)}%</span></div>
          <p>{memory.content}</p><p className="tdai-muted">有效起始：{formatValidStart(memory as unknown as Record<string, unknown>)}</p><div className="tdai-memory-actions"><button type="button" disabled={busy} onClick={() => reviewMemory(memory, 'approve')}>审核通过</button><button type="button" className="tdai-danger" disabled={busy} onClick={() => reviewMemory(memory, 'forget')}>遗忘</button></div></article>)}</div>
        {visibleLibraryLoading && <p className="tdai-muted" role="status">正在读取候选…</p>}
        {visibleLibraryError !== undefined && <div className="tdai-danger-text" role="alert"><span>候选读取失败：{visibleLibraryError}</span>
          <button type="button" onClick={() => { setLibraryError(undefined); setLibraryRefresh((value) => value + 1) }}>重试</button></div>}
        {(visibleLibraryCursor !== undefined || visibleBoundedLibraryCursor !== undefined) && <button type="button" className="tdai-load-more" disabled={visibleLibraryLoading} onClick={loadMoreMemories}>加载更多候选</button>}
      </section>}
      {activeView === 'processing' && <section className="tdai-panel"><div className="tdai-panel-head"><h3>处理状态</h3><span>{boundedOverviewData?.projects?.[0]?.name ?? overviewData?.project.name ?? '先选择项目'}</span></div>
        {overviewError && <p className="tdai-danger-text" role="alert">{overviewError}</p>}
        {props.readDashboard !== undefined && <BoundedProcessingSummary data={boundedOverviewData} error={overviewError}
          loading={overviewLoading} onRetry={() => setOverviewRefresh((value) => value + 1)} />}
        {typeof manageData.processingJobsError === 'string' && <p className="tdai-danger-text" role="alert">任务列表读取失败：{manageData.processingJobsError}</p>}
        {typeof manageData.processingCoverageError === 'string' && <p className="tdai-danger-text" role="alert">覆盖窗口读取失败：{manageData.processingCoverageError}</p>}
        {overviewData === undefined ? (props.readDashboard !== undefined ? null : <p className="tdai-muted">选择项目并等待本地状态读取。</p>) : <dl className="tdai-facts">
          <div><dt>排队中</dt><dd>{overviewData.processing.queued}</dd></div><div><dt>最早等待</dt><dd>{overviewData.processing.oldestWaitingAt === null ? '—' : new Date(overviewData.processing.oldestWaitingAt).toLocaleString()}</dd></div>
          <div><dt>失败或来源过期</dt><dd>{overviewData.processing.failed}</dd></div><div><dt>用量待核实</dt><dd>{overviewData.processing.uncertainUsage}</dd></div>
          <div><dt>运行覆盖</dt><dd>{coverageLabel(overviewData.coverage.status)}</dd></div><div><dt>待核用量尝试</dt><dd>{overviewData.usage.unknownAttempts}</dd></div>
          <div><dt>插件辅助调用用量</dt><dd>{overviewData.usage.inputTokens === null || overviewData.usage.outputTokens === null ? '部分未知' : `${overviewData.usage.inputTokens} in / ${overviewData.usage.outputTokens} out`}</dd></div>
          <div><dt>缓存读取</dt><dd>{overviewData.usage.cacheReadTokens === null ? '未知' : `${overviewData.usage.cacheReadTokens} tokens`}</dd></div>
          <div><dt>缓存写入</dt><dd>{overviewData.usage.cacheWriteTokens === null ? '未知' : `${overviewData.usage.cacheWriteTokens} tokens`}</dd></div>
          <div><dt>推理 Token</dt><dd>{overviewData.usage.reasoningTokens === null ? '未知' : `${overviewData.usage.reasoningTokens} tokens`}</dd></div>
          <div><dt>插件辅助调用 Provider costMicros</dt><dd>{overviewData.usage.costMicros === null ? '未知' : String(overviewData.usage.costMicros)}</dd></div>
          <div><dt>实际注入回执</dt><dd>{overviewData.usage.actualInjectionReceipt === 'unavailable' ? '不可用' : overviewData.usage.actualInjectionReceipt}</dd></div>
          <div><dt>可比净节省</dt><dd>{overviewData.usage.comparableNetSavings === 'unavailable' ? '不可计算' : overviewData.usage.comparableNetSavings}</dd></div>
        </dl>}
        {(overviewData !== undefined || props.readDashboard !== undefined) && <><div className="tdai-panel-head"><h3>抽取任务</h3><span>服务端按筛选条件分页，不含会话正文</span></div>
          <div className="tdai-toolbar" aria-label="抽取任务筛选">
            {([['all', '全部'], ['queued', `排队 ${processingQueuedText}`], ['failed', `失败 ${processingFailedText}`], ['uncertain', `用量待核 ${processingUncertainText}`], ['oldest', '最早等待']] as const).map(([filter, label]) =>
              <button type="button" key={filter} aria-pressed={processingJobsFilter === filter} className={processingJobsFilter === filter ? 'selected' : ''}
                onClick={() => setProcessingJobsFilter(filter)}>{label}</button>)}
          </div>
          <div className="tdai-list">{processingJobs.map((job) => <article className="tdai-memory" key={String(job.id)}>
            <div className="tdai-memory-top"><code>{job.id}</code><span>{jobStatusLabel(job.status)} · {new Date(job.updatedAt).toLocaleString()}</span></div>
            <p className="tdai-muted">{[job.provider, job.model].filter((value) => typeof value === 'string').join(' / ') || '模型路由未知'}{job.hasError ? ` · ${job.error ?? '有错误记录'}` : ''}</p>
          </article>)}{processingJobs.length === 0 && typeof manageData.processingJobsError !== 'string' && <p className="tdai-muted">暂无可见任务。</p>}</div>
          {processingJobsPage.next !== undefined && <button type="button" className="tdai-load-more" disabled={processingJobsLoading} onClick={loadMoreProcessingJobs}>{processingJobsLoading ? '正在读取…' : '加载更多任务'}</button>}
          <div className="tdai-panel-head"><h3>采集覆盖窗口</h3><span>最近窗口预览 · {processingCoverageWindows.length} 个 · 历史按需分页</span></div>
          <p className="tdai-muted">以上用量只来自本插件账本记录的辅助调用，不代表整段聊天的总用量或总费用；所选日期范围见页面顶部。此处列出全历史覆盖窗口；上方统计覆盖状态仅对应当前所选日期范围。缓存读取优先使用 cacheReadTokens，缺失时回退 cachedInputTokens，不重复相加；缓存写入和推理字段按 Provider 原始口径单列，不与输入/输出盲目相加。costMicros 只显示 Provider 报告值；缺失价格或可比基线时，净节省保持不可计算。</p>
          <div className="tdai-list">{processingCoverageWindows.map((window) => <article className="tdai-memory" key={String(window.id)}>
            <div className="tdai-memory-top"><code>窗口 #{window.id}</code><span>{window.status === 'active' ? '活动中' : window.status === 'closed' ? '已结束' : '中断'}</span></div>
            <p className="tdai-muted">{new Date(window.startedAt).toLocaleString()} — {window.endedAt === null ? '现在' : new Date(window.endedAt).toLocaleString()} · 策略 {window.policyRevision.slice(0, 12)}</p>
          </article>)}{processingCoverageWindows.length === 0 && typeof manageData.processingCoverageError !== 'string' && <p className="tdai-muted">没有覆盖窗口记录。</p>}</div>
          {typeof processingCoveragePage.nextBeforeId === 'number' && <button type="button" className="tdai-load-more" disabled={coverageLoading} onClick={loadMoreCoverage}>{coverageLoading ? '正在读取…' : '加载更多覆盖窗口'}</button>}
          <p className="tdai-muted">本机估算约按汉字、日文假名和韩文每字符 1 Token，其他字符每 4 个约 1 Token；Provider 分词器不同，属于预算近似值。注入 Token 不能视为 Provider 实际用量，也不能单独证明净节省。</p>
        </>}
      </section>}
      {activeView === 'explain' && <section className="tdai-panel"><div className="tdai-panel-head"><h3>召回解释</h3><span>本机检索，不调用模型</span></div>
        <div className="tdai-toolbar"><input value={explainQuery} onChange={(event) => setExplainQuery(event.currentTarget.value)} placeholder="输入查询…" aria-label="召回解释查询" />
          <button type="button" disabled={selectedProject === undefined || props.explain === undefined || explainQuery.trim() === ''} onClick={() => {
            if (selectedProject === undefined || props.explain === undefined) return
            const current = explainGeneration.current + 1
            explainGeneration.current = current
            const projectKey = selectedProject.key
            const queryText = explainQuery
            setExplainError(undefined); setExplainData(undefined)
            void props.explain({ projectKey, query: queryText, limit: 12 }).then((result) => {
              if (explainGeneration.current === current && selectedProjectKey === projectKey && explainQuery === queryText) setExplainData(result)
            }).catch((error: unknown) => {
              if (explainGeneration.current === current && selectedProjectKey === projectKey && explainQuery === queryText) setExplainError(error instanceof Error ? error.message : 'explanation failed')
            })
          }}>解释</button></div>
        {explainError && <p className="tdai-danger-text" role="alert">{explainError}</p>}
        {explainData && <><p className="tdai-muted">意图：{explainData.intent} · 规范化：{explainData.normalizedQuestion}</p>
          <div className="tdai-list">{explainData.candidates.map((candidate) => <article className="tdai-memory" key={`${candidate.id}@${candidate.revision}`}>
            <div className="tdai-memory-top"><code>{candidate.id}@r{candidate.revision}</code><span>{candidate.routes.join(' + ')} · {candidate.score.toFixed(3)}</span></div><p>{candidate.content}</p>
            <p className="tdai-muted">有效起始：{formatValidStart(candidate as unknown as Record<string, unknown>)}{candidate.temporalUncertainAt === true ? ' · 时间结论不确定' : ''}</p>
            <p className="tdai-muted">来源：{candidate.evidence.map((item) => `${item.role} ${new Date(item.createdAt).toLocaleString()} — ${item.excerpt}`).join(' · ') || '不可用'}</p></article>)}</div>
          {explainData.gaps.map((gap) => <p className="tdai-muted" key={gap}>信息缺口：{gap}</p>)}</>}
      </section>}
      {activeView === 'settings' && <>
        {renderSettingsPanel(false)}
        <section className="tdai-panel">
          <div className="tdai-panel-head"><h3>来源事件撤权</h3><span>只作用于单条可验证 Host 事件</span></div>
          <p className="tdai-muted">输入来源消息 ID，先查看影响，再撤销该稳定事件的后续提取、读取和恢复资格。撤权不会按 Agent 预设排除其他事件；已经发送给 Provider 的输入无法收回。</p>
          <div className="tdai-toolbar"><input value={revokeSourceId} onChange={(event) => { sourceRevocationGeneration.current += 1; setRevokeSourceId(event.currentTarget.value); setSourceRevocationPreview(undefined) }} placeholder="来源消息 ID" aria-label="撤权来源消息 ID" />
            <button type="button" disabled={manageBusy || selectedProject === undefined || revokeSourceId.trim() === '' || props.manage === undefined}
              onClick={() => {
                const sourceId = revokeSourceId.trim()
                const projectKey = selectedProjectKey
                const requestGeneration = sourceRevocationGeneration.current + 1
                sourceRevocationGeneration.current = requestGeneration
                requestManagementRecord('source.revoke.preview', { sourceId }, (result) => {
                  if (sourceRevocationGeneration.current === requestGeneration && selectedProjectKeyRef.current === projectKey) {
                    setSourceRevocationPreview({ ...result, _sourceId: sourceId, _projectKey: projectKey })
                  }
                })
              }}>查看影响</button></div>
          {sourceRevocationPreview !== undefined && sourceRevocationPreview._sourceId === revokeSourceId.trim() && sourceRevocationPreview._projectKey === selectedProjectKey && <div className="tdai-detail-block">
            <p className="tdai-muted">{sourceRevocationPreview.verifiable === true ? 'Host 事件身份可验证' : 'Host 事件身份不可验证'} · 已撤权：{sourceRevocationPreview.alreadyRevoked === true ? '是' : '否'} · 关联记忆 {String(sourceRevocationPreview.affectedMemories ?? 0)} · 相关评测运行 {String(sourceRevocationPreview.affectedEvaluationRuns ?? 0)} · 排队任务 {String(sourceRevocationPreview.queuedJobs ?? 0)} · 已保存响应 {String(sourceRevocationPreview.savedJobs ?? 0)} · 在途任务 {String(sourceRevocationPreview.inFlightJobs ?? 0)}</p>
            <p className="tdai-muted">{String(sourceRevocationPreview.note ?? '')}</p>
            <button type="button" className="tdai-danger" disabled={manageBusy || sourceRevocationPreview.verifiable !== true || sourceRevocationPreview.alreadyRevoked === true}
              onClick={() => {
                const sourceId = String(sourceRevocationPreview._sourceId)
                const inFlight = Number(sourceRevocationPreview.inFlightJobs ?? 0)
                if (sourceId === revokeSourceId.trim() && sourceRevocationPreview._projectKey === selectedProjectKey && window.confirm(`撤销来源 ${sourceId}？${inFlight > 0 ? `已有 ${inFlight} 个请求进入在途状态，其 Provider 输入无法收回。` : ''}撤销后将保留账单证据并阻止该事件再次进入记忆。`)) {
                  manageAction('source.revoke', { sourceId }, (value) => {
                    const result = asRecord(value)
                    setSourceRevocationPreview(undefined)
                    return result.revoked === true
                      ? `来源已撤权；移除保存响应 ${String(result.removedSavedResponses ?? 0)} 项`
                      : `来源撤权未完成：${String(result.reason ?? '服务端未确认撤权')}`
                  })
                }
              }}>撤销该来源</button>
          </div>}
        </section>
        <section className="tdai-panel">
          <div className="tdai-panel-head"><h3>选择性删除托管内容</h3><span>先预览影响，再确认删除</span></div>
          {selectedProject === undefined ? <p className="tdai-muted">请先选择项目。</p> : <>
            <p className="tdai-muted">选择记忆、来源原文和工具输出。选中来源时会扩展到引用它的记忆及其来源闭包；删除围栏先写入独立控制账本，再清理内容与派生副本。账单、已知与未知用量证据不清除、不重算，也不会因此复活。</p>
            <div className="tdai-panel-head"><h4>记忆 {deletionMemoryOptions.length} 项</h4><span>最多展示最近 500 条来源、1000 条记忆</span></div>
            <div className="tdai-list">{deletionMemoryOptions.map((item) => {
              const id = String(item.id ?? '')
              return <label className="tdai-check" key={id}><input type="checkbox" checked={selectedDeleteMemoryIds.includes(id)} disabled={manageBusy}
                onChange={(event) => { const checked = event.currentTarget.checked; setSelectedDeleteMemoryIds((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id)); setContentDeletionPreview(undefined) }} />
                <span><code>{id}</code> · {String(item.status ?? '')} · {String(item.kind ?? 'fact')} · {String(item.content ?? '')}</span></label>
            })}{deletionMemoryOptions.length === 0 && <p className="tdai-muted">没有可选择的记忆。</p>}</div>
            <div className="tdai-panel-head"><h4>来源原文 {deletionSourceOptions.length} 项</h4><span>最近捕获</span></div>
            <div className="tdai-list">{deletionSourceOptions.map((item) => {
              const id = String(item.id ?? '')
              return <label className="tdai-check" key={id}><input type="checkbox" checked={selectedDeleteSourceIds.includes(id)} disabled={manageBusy}
                onChange={(event) => { const checked = event.currentTarget.checked; setSelectedDeleteSourceIds((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id)); setContentDeletionPreview(undefined) }} />
                <span><code>{id}</code> · {String(item.role ?? '')} · {String(item.origin ?? '')}/{String(item.sourceKind ?? '')} · {String(item.preview ?? '')}</span></label>
            })}{deletionSourceOptions.length === 0 && <p className="tdai-muted">没有可选择的来源原文。</p>}</div>
            <div className="tdai-panel-head"><h4>工具输出 {deletionOffloadOptions.length} 项</h4><span>仅本项目本地输出</span></div>
            <div className="tdai-list">{deletionOffloadOptions.map((id) => <label className="tdai-check" key={id}><input type="checkbox" checked={selectedDeleteOffloadIds.includes(id)} disabled={manageBusy}
              onChange={(event) => { const checked = event.currentTarget.checked; setSelectedDeleteOffloadIds((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id)); setContentDeletionPreview(undefined) }} /><span><code>{id}</code></span></label>)}
              {deletionOffloadOptions.length === 0 && <p className="tdai-muted">没有可选择的工具输出。</p>}</div>
            <div className="tdai-toolbar"><button type="button" disabled={manageBusy || props.manage === undefined || selectedDeleteMemoryIds.length + selectedDeleteSourceIds.length + selectedDeleteOffloadIds.length === 0}
              onClick={() => requestManagementRecord('content.delete.preview', { memoryIds: selectedDeleteMemoryIds, sourceIds: selectedDeleteSourceIds, offloadIds: selectedDeleteOffloadIds }, setContentDeletionPreview)}>预览删除影响</button></div>
            {contentDeletionPreview !== undefined && <div className="tdai-detail-block">
              <p>直接选择记忆 {String(contentDeletionPreview.selectedMemoryCount ?? 0)} 项 · 派生闭包新增 {String(contentDeletionPreview.derivedMemoryCount ?? 0)} 项 · 修订 {String(contentDeletionPreview.revisionCount ?? 0)} 条 · 原文 {String(contentDeletionPreview.rawSourceCount ?? 0)} 条 · 原文缺失 {String(contentDeletionPreview.missingSourceCount ?? 0)} 条 · 工具输出 {String(contentDeletionPreview.selectedOffloadCount ?? 0)} 个</p>
              <p>关系 {String(contentDeletionPreview.relationCount ?? 0)} 项 · 任务接续 {String(contentDeletionPreview.taskContextCount ?? 0)} 项 · 经验卡 {String(contentDeletionPreview.experienceCount ?? 0)} 项 · 评测集 {String(contentDeletionPreview.evaluationCaseCount ?? 0)} 项 / 运行 {String(contentDeletionPreview.evaluationRunCount ?? 0)} 条 · 项目画像受影响 {contentDeletionPreview.personaAffected === true ? '是' : '否'} · 场景 {String(contentDeletionPreview.sceneCount ?? 0)} 项</p>
              <p>提取任务 {asRecords(contentDeletionPreview.relatedExtractionJobs).length} 项 · 在途 {String(contentDeletionPreview.inFlightJobs ?? 0)} 项 · 保存响应 {String(contentDeletionPreview.savedResponseJobs ?? 0)} 项 · 账单与未知用量证据会保留。</p>
              <p className="tdai-muted">{String(contentDeletionPreview.recoverySnapshotLimit ?? '')}</p>
              <button type="button" className="tdai-danger" disabled={manageBusy || typeof contentDeletionPreview.previewToken !== 'string'} onClick={() => {
                const token = String(contentDeletionPreview.previewToken)
                const inFlight = Number(contentDeletionPreview.inFlightJobs ?? 0)
                if (window.confirm(`删除当前预览中的托管内容？${inFlight > 0 ? `有 ${inFlight} 个 Provider 请求处于在途状态。` : ''}旧恢复快照可能继续保留历史字节；控制围栏会在后续恢复时再次执行。账单和未知用量证据会保留。`)) {
                  manageAction('content.delete.apply', { memoryIds: selectedDeleteMemoryIds, sourceIds: selectedDeleteSourceIds, offloadIds: selectedDeleteOffloadIds, previewToken: token, confirm: true }, (result) => {
                    const receipt = asRecord(result)
                    if (receipt.cleanupStatus === 'complete') {
                      setSelectedDeleteMemoryIds([]); setSelectedDeleteSourceIds([]); setSelectedDeleteOffloadIds([]); setContentDeletionPreview(undefined)
                      return `内容已清理；控制围栏序号 ${String(receipt.controlFenceSeq ?? '?')}，用量证据保留`
                    }
                    const remaining = displayList(receipt.remaining)
                    const errors = asRecords(receipt.errors).map((item) => [item.stage, item.reason].filter((part) => typeof part === 'string' && part !== '').join(': ')).filter(Boolean).slice(0, 4)
                    return `删除围栏已写入，但清理仍有待完成阶段：${remaining.join('、') || '状态待核实'}${errors.length > 0 ? `；${errors.join('；')}` : ''}。保留当前选择和预览，可再次确认以续跑。`
                  })
                }
              }}>确认删除所选内容</button>
            </div>}
          </>}
          {manageError !== undefined && <p className="tdai-danger-text" role="alert">{manageError}</p>}
        </section>
      </>}
      {['continuity', 'experiences', 'relations', 'knowledge', 'evaluation', 'governance', 'recovery'].includes(activeView) && <>
        <section className="tdai-panel">
          <div className="tdai-panel-head"><h3>{selectedProject?.name ?? '项目内管理'}</h3><span>{manageBusy ? '正在处理…' : '本机数据 · 项目隔离'}</span></div>
          {selectedProject === undefined && <p className="tdai-muted">请先选择项目；管理操作只读取和写入当前项目。</p>}
          {manageError && <p className="tdai-danger-text" role="alert">{manageError}</p>}
          {notice && <p className="tdai-notice" role="status">{notice}</p>}
          {scopedManageResult !== undefined && <details className="tdai-result"><summary>最近操作回执</summary><pre>{JSON.stringify(scopedManageResult, null, 2)}</pre></details>}
        </section>

        {activeView === 'continuity' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>任务连续性</h3><span>目标、约束、完成项、待办、未知和来源修订</span></div>
            <div className="tdai-list">{taskItems.map((item) => <article className="tdai-memory" key={String(item.taskRef)}>
              <div className="tdai-memory-top"><code>{String(item.taskRef ?? 'task')}</code><span>{String(item.status ?? 'unknown')} · r{String(item.revision ?? '?')}</span></div>
              {item.redacted === true ? <p className="tdai-muted">来源已失效、过期、排除或修订；敏感任务正文已隐藏。</p> : <>
                <p>{String(item.goal ?? '')}</p>
                <p className="tdai-muted">约束：{displayList(item.constraints).join(' · ') || '无'} · 已完成：{displayList(item.completed).join(' · ') || '无'}</p>
                <p className="tdai-muted">待办：{displayList(item.pending).join(' · ') || '无'} · 阻塞：{displayList(item.blockers).join(' · ') || '无'}</p>
                <p className="tdai-muted">已确认：{displayList(item.confirmedFacts).join(' · ') || '无'} · 假设：{displayList(item.assumptions).join(' · ') || '无'}</p>
                <p className="tdai-muted">已知未知：{displayList(item.knownUnknowns).join(' · ') || '无'}</p>
                <p className="tdai-muted">产物引用：{displayList(asRecords(item.artifactRefs).map((ref) => ref.ref)).join(' · ') || '无'} · 文件状态：未核验</p>
              </>}
              <div className="tdai-memory-actions"><span className="tdai-pill">来源 {displayList(item.sourceMemoryIds).length}</span><button type="button" disabled={manageBusy || item.redacted === true} onClick={() => {
                setTaskRef(String(item.taskRef ?? '')); setTaskGoal(String(item.goal ?? '')); setTaskPending(displayList(item.pending).join('\n'))
                setTaskConstraints(displayList(item.constraints).join('\n')); setTaskCompleted(displayList(item.completed).join('\n'))
                setTaskKnownUnknowns(displayList(item.knownUnknowns).join('\n')); setTaskConfirmedFacts(displayList(item.confirmedFacts).join('\n'))
                setTaskAssumptions(displayList(item.assumptions).join('\n')); setTaskBlockers(displayList(item.blockers).join('\n'))
                setTaskArtifactRefs(JSON.stringify(Array.isArray(item.artifactRefs) ? item.artifactRefs : [], null, 2))
                setTaskSources(displayList(item.sourceMemoryIds).join('\n')); setTaskStatus(String(item.status ?? 'active'))
                setTaskExpectedRevision(Number(item.revision ?? 0))
              }}>载入续写</button></div>
            </article>)}</div>
            {taskItems.length === 0 && <p className="tdai-muted">当前项目暂无任务接续记录。</p>}
          </section>
          <section className="tdai-panel tdai-form-grid"><div className="tdai-panel-head"><h3>保存任务状态</h3><span>来源记忆必须当前有效且已批准</span></div>
            <label className="tdai-field"><span>任务引用</span><input value={taskRef} onChange={(event) => setTaskRef(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>目标</span><textarea value={taskGoal} onChange={(event) => setTaskGoal(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>约束（一行一项）</span><textarea value={taskConstraints} onChange={(event) => setTaskConstraints(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>已完成（一行一项）</span><textarea value={taskCompleted} onChange={(event) => setTaskCompleted(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>待办（一行一项）</span><textarea value={taskPending} onChange={(event) => setTaskPending(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>已知未知（一行一项）</span><textarea value={taskKnownUnknowns} onChange={(event) => setTaskKnownUnknowns(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>已确认事实（一行一项）</span><textarea value={taskConfirmedFacts} onChange={(event) => setTaskConfirmedFacts(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>假设（一行一项）</span><textarea value={taskAssumptions} onChange={(event) => setTaskAssumptions(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>阻塞项（一行一项）</span><textarea value={taskBlockers} onChange={(event) => setTaskBlockers(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>产物引用 JSON（ref，可选 hash/revision）</span><textarea value={taskArtifactRefs} onChange={(event) => setTaskArtifactRefs(event.currentTarget.value)} /></label>
            <p className="tdai-muted">产物引用只保存用户提供的标识和版本信息；当前没有文件系统核验能力，不能据此确认文件未变化。</p>
            <label className="tdai-field"><span>来源记忆 ID（一行一个）</span><textarea value={taskSources} onChange={(event) => setTaskSources(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>状态</span><select value={taskStatus} onChange={(event) => setTaskStatus(event.currentTarget.value)}><option value="active">进行中</option><option value="paused">暂停</option><option value="complete">已完成</option><option value="cancelled">已取消</option></select></label>
            <button type="button" disabled={manageBusy || selectedProject === undefined} onClick={() => {
              try {
                const artifactRefs = parseArtifactRefs(taskArtifactRefs)
                manageAction('task.save', {
                  taskRef, goal: taskGoal, constraints: splitLines(taskConstraints), completed: splitLines(taskCompleted), pending: splitLines(taskPending),
                  knownUnknowns: splitLines(taskKnownUnknowns), confirmedFacts: splitLines(taskConfirmedFacts), assumptions: splitLines(taskAssumptions),
                  blockers: splitLines(taskBlockers), artifactRefs, sourceMemoryIds: splitLines(taskSources), status: taskStatus,
                  ...(taskExpectedRevision === undefined ? {} : { expectedRevision: taskExpectedRevision }),
                }, '任务状态已保存')
              } catch (error) { setManageError(error instanceof Error ? error.message : '产物引用 JSON 无效') }
            }}>保存任务状态</button>
          </section>
        </>}

        {activeView === 'experiences' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>经验卡</h3><span>匹配时重新核对证据；失效来源不会进入召回</span></div>
            <div className="tdai-list">{experienceItems.map((item) => <article className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.id)}</code><span>{String(item.status)} · 独立来源 {String(item.independentSources ?? 0)}</span></div>
              <p><strong>{String(item.title)}</strong> — {String(item.symptom)}</p>
              <p className="tdai-muted">环境：{Object.entries(asRecord(item.environment)).map(([key, value]) => `${key}=${String(value)}`).join(' · ') || '未填写'} · 前提：{displayList(item.prerequisites).join(' · ') || '无'}</p>
              <p className="tdai-muted">步骤：{displayList(item.steps).join(' → ') || '未填写'}</p>
              <p className="tdai-muted">结果：{displayList(item.outcomes).join(' · ') || '未填写'} · 反例：{displayList(item.counterexamples).join(' · ') || '无'} · 证据 {displayList(item.evidenceMemoryIds).length}</p>
              <label className="tdai-field"><span>补充反例</span><textarea value={experienceCounterexampleDrafts[String(item.id)] ?? ''} onChange={(event) => {
                const value = event.currentTarget.value
                setExperienceCounterexampleDrafts((current) => ({ ...current, [String(item.id)]: value }))
              }} /></label>
              <div className="tdai-memory-actions">{item.status === 'candidate' && <button type="button" disabled={manageBusy} onClick={() => manageAction('experience.review', { id: item.id, approve: true }, '经验卡已审核')}>审核通过</button>}
                {item.status === 'episode' && <button type="button" disabled={manageBusy} onClick={() => manageAction('experience.save', {
                  id: item.id, title: item.title, symptom: item.symptom, environment: asRecord(item.environment),
                  prerequisites: displayList(item.prerequisites), steps: displayList(item.steps), outcomes: displayList(item.outcomes),
                  counterexamples: displayList(item.counterexamples), evidenceMemoryIds: displayList(item.evidenceMemoryIds), status: 'candidate',
                }, '经验记录已转为候选；仍需审核')}>转为候选</button>}
                <button type="button" disabled={manageBusy || !(experienceCounterexampleDrafts[String(item.id)] ?? '').trim()} onClick={() => manageAction('experience.counterexample', { id: item.id, counterexample: experienceCounterexampleDrafts[String(item.id)] }, '反例已记录，经验卡回到候选状态')}>记录反例</button>
                {item.status !== 'rejected' && <button type="button" className="tdai-danger" disabled={manageBusy} onClick={() => manageAction('experience.review', { id: item.id, approve: false }, '经验卡已拒绝')}>拒绝</button>}</div>
            </article>)}</div>
            {experienceItems.length === 0 && <p className="tdai-muted">当前项目暂无可用经验卡。</p>}
          </section>
          <section className="tdai-panel tdai-form-grid"><div className="tdai-panel-head"><h3>记录经验</h3><span>仅保存结构化本地经验，不触发模型调用</span></div>
            <label className="tdai-field"><span>标题</span><input value={experienceTitle} onChange={(event) => setExperienceTitle(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>症状 / 适用问题</span><textarea value={experienceSymptom} onChange={(event) => setExperienceSymptom(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>环境 JSON</span><textarea value={experienceEnvironment} onChange={(event) => setExperienceEnvironment(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>前提（一行一项）</span><textarea value={experiencePrerequisites} onChange={(event) => setExperiencePrerequisites(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>步骤（一行一项）</span><textarea value={experienceSteps} onChange={(event) => setExperienceSteps(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>结果（一行一项）</span><textarea value={experienceOutcomes} onChange={(event) => setExperienceOutcomes(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>已有反例（一行一项）</span><textarea value={experienceCounterexamples} onChange={(event) => setExperienceCounterexamples(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>证据记忆 ID（一行一个）</span><textarea value={experienceEvidence} onChange={(event) => setExperienceEvidence(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>保存状态</span><select value={experienceStatus} onChange={(event) => setExperienceStatus(event.currentTarget.value as 'candidate' | 'episode')}><option value="candidate">候选，等待审核</option><option value="episode">仅记录，不进入候选审核</option></select></label>
            <button type="button" disabled={manageBusy || selectedProject === undefined} onClick={() => {
              try {
                const environment = JSON.parse(experienceEnvironment) as Record<string, string>
                if (environment === null || Array.isArray(environment) || typeof environment !== 'object' || Object.values(environment).some((value) => typeof value !== 'string')) throw new Error('环境必须是字符串键值 JSON 对象')
                manageAction('experience.save', { title: experienceTitle, symptom: experienceSymptom, environment, prerequisites: splitLines(experiencePrerequisites), steps: splitLines(experienceSteps), outcomes: splitLines(experienceOutcomes), counterexamples: splitLines(experienceCounterexamples), evidenceMemoryIds: splitLines(experienceEvidence), status: experienceStatus }, experienceStatus === 'candidate' ? '候选经验已保存；尚未验证' : '经验记录已保存')
              } catch (error) { setManageError(error instanceof Error ? error.message : '环境 JSON 无效') }
            }}>保存经验卡</button>
          </section>
        </>}

        {activeView === 'relations' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>待审核修订</h3><span>{revisionItems.length} 项</span></div>
            <div className="tdai-list">{revisionItems.map((item) => <article className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.memoryId)} · r{String(item.expectedRevision)}</code><span>{String(item.reason ?? '修订候选')}</span></div>
              <p>{String(item.content ?? '')}</p><p className="tdai-muted">证据：{displayList(item.sourceMessageIds).join(' · ') || '无'}</p>
              <div className="tdai-memory-actions"><button type="button" disabled={manageBusy} onClick={() => manageAction('revision.review', { id: item.id, approve: true }, '修订已通过')}>通过</button><button type="button" className="tdai-danger" disabled={manageBusy} onClick={() => manageAction('revision.review', { id: item.id, approve: false }, '修订已拒绝')}>拒绝</button></div>
            </article>)}</div>{revisionItems.length === 0 && <p className="tdai-muted">没有待审核修订。</p>}
          </section>
          <section className="tdai-panel tdai-form-grid"><div className="tdai-panel-head"><h3>提出记忆修订</h3><span>需提供当前修订号和有效来源消息</span></div>
            <label className="tdai-field"><span>记忆 ID</span><input value={revisionMemoryId} onChange={(event) => setRevisionMemoryId(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>当前修订号</span><input type="number" min={1} value={revisionNumber} onChange={(event) => setRevisionNumber(Number(event.currentTarget.value))} /></label>
            <label className="tdai-field"><span>新内容</span><textarea value={revisionContent} onChange={(event) => setRevisionContent(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>修订原因</span><input value={revisionReason} onChange={(event) => setRevisionReason(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>来源消息 ID（一行一个）</span><textarea value={revisionEvidence} onChange={(event) => setRevisionEvidence(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>有效起始时间（可留空使用记录时间默认；支持年、年月、日期和带时区时间）</span><input value={revisionValidFrom} disabled={revisionValidFromUnknown} onChange={(event) => setRevisionValidFrom(event.currentTarget.value)} placeholder="例如 2026-04 或 2026-04-12" /></label>
            <label className="tdai-check"><input type="checkbox" checked={revisionValidFromUnknown} onChange={(event) => setRevisionValidFromUnknown(event.currentTarget.checked)} /><span>来源明确表示开始时间未知</span></label>
            <button type="button" disabled={manageBusy || selectedProject === undefined} onClick={() => manageAction('revision.propose', { memoryId: revisionMemoryId, expectedRevision: revisionNumber, content: revisionContent, reason: revisionReason, sourceMessageIds: splitLines(revisionEvidence),
              validFrom: revisionValidFromUnknown ? null : revisionValidFrom.trim() === '' ? undefined : revisionValidFrom.trim() }, '修订候选已提交')}>提交修订</button>
          </section>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>待审核关系</h3><span>{relationItems.length} 项</span></div>
            <div className="tdai-list">{relationItems.map((item) => <article className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.fromId)} —{String(item.type)}→ {String(item.toId)}</code><span>{String(item.status)}</span></div>
              <p className="tdai-muted">证据：{displayList(item.evidenceIds).join(' · ') || '无'}</p>
              <div className="tdai-memory-actions"><button type="button" disabled={manageBusy} onClick={() => manageAction('relation.review', { id: item.id, approve: true }, '关系已通过')}>通过</button><button type="button" className="tdai-danger" disabled={manageBusy} onClick={() => manageAction('relation.review', { id: item.id, approve: false }, '关系已拒绝')}>拒绝</button></div>
            </article>)}</div>{relationItems.length === 0 && <p className="tdai-muted">没有待审核关系。</p>}
          </section>
          <section className="tdai-panel tdai-form-grid"><div className="tdai-panel-head"><h3>提出记忆关系</h3><span>两端和证据必须在当前项目内可读</span></div>
            <label className="tdai-field"><span>起点记忆 ID</span><input value={relationFrom} onChange={(event) => setRelationFrom(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>关系类型</span><select value={relationType} onChange={(event) => setRelationType(event.currentTarget.value)}><option value="supports">支持</option><option value="contradicts">冲突</option><option value="depends_on">依赖</option><option value="supersedes">取代</option><option value="derived_from">派生自</option></select></label>
            <label className="tdai-field"><span>终点记忆 ID</span><input value={relationTo} onChange={(event) => setRelationTo(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>证据消息 ID（一行一个）</span><textarea value={relationEvidence} onChange={(event) => setRelationEvidence(event.currentTarget.value)} /></label>
            <button type="button" disabled={manageBusy || selectedProject === undefined} onClick={() => manageAction('relation.propose', { fromId: relationFrom, toId: relationTo, type: relationType, evidenceIds: splitLines(relationEvidence) }, '关系候选已提交')}>提交关系</button>
          </section>
        </>}

        {activeView === 'knowledge' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>知识视图</h3><span>依据当前有效事实机械分组；无模型生成</span></div>
            {knowledgeFocusId !== '' && !knowledgeFocusIsListed && <article className="tdai-memory">
              <div className="tdai-memory-top"><code>{knowledgeFocusId}</code><span>{knowledgeLoadingId === knowledgeFocusId ? '正在读取详情…' : '直接打开的完整详情'}</span></div>
              {focusedKnowledgeMemory.id === undefined
                ? <p className="tdai-muted">该 ID 不在当前知识分组中；可能是合成评测 ID、不可读取或已删除的记忆。</p>
                : <div className="tdai-detail-block">
                  <h4>当前有效知识</h4><p>{String(focusedKnowledgeMemory.content ?? '')}</p>
                  <p className="tdai-muted">修订 r{String(focusedKnowledgeMemory.revision ?? '?')} · 起始 {formatValidStart(focusedKnowledgeMemory)} · 来源 ID：{displayList(focusedKnowledgeMemory.sourceMessageIds).join(' · ') || '无'}</p>
                  <h4>来源原文</h4>{asRecords(focusedKnowledge.sources).length === 0 ? <p className="tdai-muted">当前没有可读取的来源文本。</p> : asRecords(focusedKnowledge.sources).map((source) => <p key={String(source.id)}><span className="tdai-muted"><code>{String(source.id)}</code> · {String(source.role ?? '')} · {source.createdAt === undefined ? '时间未知' : new Date(Number(source.createdAt)).toLocaleString()}</span><br />{String(source.content ?? '')}{source.contentTruncated === true ? ' …（已截断）' : ''}</p>)}
                  <h4>修订历史</h4>{asRecords(focusedKnowledge.revisions).map((revision) => <p key={String(revision.id)}><span className="tdai-muted">r{String(revision.revision)} · {formatValidStart(revision)} · 记录于 {revision.recordedAt === undefined ? '未知' : new Date(Number(revision.recordedAt)).toLocaleString()}</span><br />{String(revision.content ?? '')}</p>)}
                  <h4>派生影响</h4><p className="tdai-muted">任务：{displayList(focusedKnowledgeImpact.taskRefs).join(' · ') || '无'} · 经验卡：{displayList(focusedKnowledgeImpact.experienceIds).join(' · ') || '无'} · 关系：{asRecords(focusedKnowledgeImpact.relations).length}</p>
                </div>}
            </article>}
            <div className="tdai-list">{knowledgeItems.map((item) => <article className="tdai-memory" key={String(item.key)}>
              <div className="tdai-memory-top"><code>{String(item.key)}</code><span>{displayList(item.memoryIds).length} 条事实</span></div>
              <div className="tdai-list">{asRecords(item.entries).map((entry) => {
                const id = String(entry.id ?? '')
                const detail = knowledgeDetails[id]
                const impact = detail?.derivedImpact !== null && typeof detail?.derivedImpact === 'object' ? detail.derivedImpact as Record<string, unknown> : undefined
                const history = knowledgeHistory[id]
                return <article className="tdai-memory" key={id}>
                  <div className="tdai-memory-top"><code>{id}</code><span>r{String(entry.revision ?? '?')} · {String(entry.kind ?? 'fact')}</span></div>
                  <p className="tdai-muted">有效自 {formatValidStart(entry)} · 记录于 {entry.recordedAt === undefined ? '未知' : new Date(Number(entry.recordedAt)).toLocaleString()}{entry.validTo === undefined ? '' : ` · 有效至 ${new Date(Number(entry.validTo)).toLocaleString()}`}</p>
                  <button type="button" disabled={knowledgeLoadingId === id} aria-expanded={knowledgeExpandedId === id} onClick={() => toggleKnowledgeDetail(id)}>
                    {knowledgeLoadingId === id ? '正在读取…' : knowledgeExpandedId === id ? '收起详情' : '展开来源与修订'}
                  </button>
                  {knowledgeExpandedId === id && detail !== undefined && <div className="tdai-detail-block">
                    <h4>当前有效知识</h4><p>{String((detail.memory as Record<string, unknown> | undefined)?.content ?? '')}</p>
                    <h4>来源原文（最多显示 20 条，每条最多 4000 字符）</h4><p className="tdai-muted">当前修订 r{String((detail.memory as Record<string, unknown> | undefined)?.revision ?? entry.revision ?? '?')} · 来源 ID：{displayList((detail.memory as Record<string, unknown> | undefined)?.sourceMessageIds).join(' · ') || '无'}</p>{asRecords(detail.sources).length === 0 ? <p className="tdai-muted">当前没有可读取的来源文本。</p> : asRecords(detail.sources).map((source) => <p key={String(source.id)}><span className="tdai-muted"><code>{String(source.id)}</code> · {String(source.role ?? '')} · {source.createdAt === undefined ? '时间未知' : new Date(Number(source.createdAt)).toLocaleString()}</span><br />{String(source.content ?? '')}{source.contentTruncated === true ? ' …（已截断）' : ''}</p>)}
                    {Number(detail.omittedSourceCount ?? 0) > 0 && <p className="tdai-muted">另有 {String(detail.omittedSourceCount)} 条来源因当前范围、共享引用权限或详情上限未显示。</p>}
                    <h4>修订历史</h4>{asRecords(detail.revisions).map((revision) => <p key={String(revision.id)}><span className="tdai-muted">r{String(revision.revision)} · 来源 {displayList(revision.sourceMessageIds).join(' · ') || '无'} · 记录于 {revision.recordedAt === undefined ? '未知' : new Date(Number(revision.recordedAt)).toLocaleString()} · 有效自 {formatValidStart(revision)}{revision.temporalUncertainAt === true ? ' · 时间结论不确定' : ''}{revision.validTo === undefined ? '' : ` 至 ${new Date(Number(revision.validTo)).toLocaleString()}`}</span><br />{String(revision.content ?? '')}</p>)}
                    <h4>按有效时间与记录时间查询</h4>
                    <div className="tdai-toolbar"><label>有效时间 <input type="datetime-local" value={historyEffectiveAt} onChange={(event) => setHistoryEffectiveAt(event.currentTarget.value)} /></label>
                      <label>已知时间 <input type="datetime-local" value={historyKnownAt} onChange={(event) => setHistoryKnownAt(event.currentTarget.value)} /></label>
                      <button type="button" disabled={manageBusy || props.manage === undefined || dateTimeLocalMillis(historyEffectiveAt) === undefined || dateTimeLocalMillis(historyKnownAt) === undefined}
                        onClick={() => requestManagementRecord('knowledge.history', { id, effectiveAt: dateTimeLocalMillis(historyEffectiveAt), knownAt: dateTimeLocalMillis(historyKnownAt) }, (result) => setKnowledgeHistory((current) => ({ ...current, [id]: result })))}>查询历史</button></div>
                    {history !== undefined && <p className={history.temporalConclusionUncertain === true ? 'tdai-danger-text' : 'tdai-muted'}>
                      {history.selected === undefined ? '该时点没有可确认的修订。' : `命中 r${String(asRecord(history.selected).revision ?? '?')}：${formatValidStart(asRecord(history.selected))}`}
                      {history.temporalConclusionUncertain === true ? ' · 结论受起始时间精度影响，需按不确定结果处理。' : ' · 未发现起始时间精度导致的结论不确定。'}
                    </p>}
                    <h4>派生影响</h4><p className="tdai-muted">任务：{displayList(impact?.taskRefs).join(' · ') || '无'} · 经验卡：{displayList(impact?.experienceIds).join(' · ') || '无'}</p>
                    {asRecords(impact?.relations).length > 0 && <p className="tdai-muted">关系：{asRecords(impact?.relations).map((item) => {
                      const relation = item.relation !== null && typeof item.relation === 'object' ? item.relation as Record<string, unknown> : {}
                      return `${String(relation.type ?? 'relation')} ${String(relation.fromId ?? '')}@r${String(relation.fromRevision ?? '?')} → ${String(relation.toId ?? '')}@r${String(relation.toRevision ?? '?')} · 证据 ${displayList(relation.evidenceIds).join(', ') || '无'}`
                    }).join(' · ')}</p>}
                  </div>}
                </article>
              })}</div>
            </article>)}</div>{knowledgeItems.length === 0 && <p className="tdai-muted">没有当前有效的已批准知识。</p>}
            <div className="tdai-toolbar"><input value={decisionId} onChange={(event) => setDecisionId(event.currentTarget.value)} placeholder="决策记忆 ID" aria-label="决策记忆 ID" />
              <button type="button" disabled={manageBusy || decisionId.trim() === ''} onClick={() => manageAction('decision.impact', { id: decisionId }, '已生成影响图')}>查看决策影响</button></div>
          </section>
        </>}

        {activeView === 'evaluation' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>本地检索评测</h3><span>确定性离线执行，不访问模型或向量服务</span></div>
            <label className="tdai-field"><span>成对对照策略</span><select value={evaluationStrategyId} onChange={(event) => setEvaluationStrategyId(event.currentTarget.value)}>
              <option value="">仅重跑当前基线</option>{strategies.filter((item) => ['candidate', 'shadow', 'selected'].includes(String(item.status))).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.title)} · {String(item.status)}</option>)}
            </select></label>
            {latestBaseline.result !== undefined && latestCandidate.result !== undefined && <article className="tdai-memory">
              <div className="tdai-memory-top"><strong>最近成对比较</strong><span>{String(latestBaseline.role)} / {String(latestCandidate.role)}</span></div>
              <p>得分差（对照 − 基线）：{(Number(latestCandidateResult.score ?? 0) - Number(latestBaselineResult.score ?? 0)).toFixed(3)} · 安全门：{String(latestBaselineResult.hardGate ?? '—')} → {String(latestCandidateResult.hardGate ?? '—')}</p>
              <p className="tdai-muted">基线命中：{displayList(latestBaselineResult.hits).join(' · ') || '无'}；对照命中：{displayList(latestCandidateResult.hits).join(' · ') || '无'}</p>
              <p className="tdai-muted">基线缺失 / 禁止：{displayList(latestBaselineResult.missing).join(' · ') || '无'} / {displayList(latestBaselineResult.forbidden).join(' · ') || '无'}；对照缺失 / 禁止：{displayList(latestCandidateResult.missing).join(' · ') || '无'} / {displayList(latestCandidateResult.forbidden).join(' · ') || '无'}</p>
              <details><summary>评分与安全详情</summary><pre>{JSON.stringify({ baseline: latestBaselineResult, candidate: latestCandidateResult }, null, 2)}</pre></details>
            </article>}
            <div className="tdai-list">{evaluationCases.map((item) => {
              const fixtureRows = asRecords(asRecord(item.fixture).records)
              const caseFocusedRecordId = evaluationCorpusFocus?.caseId === String(item.id) ? evaluationCorpusFocus.recordId : ''
              const focusedFixtureRows = caseFocusedRecordId === '' ? fixtureRows
                : fixtureRows.filter((row) => String(row.id ?? '') === caseFocusedRecordId)
              return <article id={`evaluation-case-${String(item.id)}`} tabIndex={-1} className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.id)}</code><span>{String(item.source)} · {String(asRecord(item.fixture).split ?? 'train')}</span></div><p><strong>{String(item.title)}</strong> — {String(item.query)}</p>
              <p className="tdai-muted">预期：{displayList(item.expectedIds).join(' · ') || '无'} · 禁止：{displayList(item.forbiddenIds).join(' · ') || '无'}</p>
              {item.source === 'synthetic' && fixtureRows.length > 0 && <details open={focusedFixtureRows.some((row) => String(row.id ?? '') === caseFocusedRecordId)}>
                <summary>合成语料 {caseFocusedRecordId !== '' && focusedFixtureRows.length > 0 ? `· 定位 ${caseFocusedRecordId}` : `· ${fixtureRows.length} 条`}</summary>
                <pre>{JSON.stringify(focusedFixtureRows, null, 2).slice(0, 6000)}</pre>
              </details>}
              <button type="button" disabled={manageBusy} onClick={() => manageAction('evaluation.run', { caseId: item.id, ...(evaluationStrategyId === '' ? {} : { strategyId: evaluationStrategyId }) }, '同一时间点的基线 / 对照结果已保存')}>运行成对比较</button>
            </article>
            })}</div>{evaluationCases.length === 0 && <p className="tdai-muted">至少创建两条 split=holdout 的合成案例，才可进行策略影子回放。</p>}
            <div className="tdai-list">{evaluationRunGroups.map(([groupId, groupRuns]) => {
              const baseline = groupRuns.find((run) => run.role === 'baseline')
              const comparison = groupRuns.find((run) => run.role === 'candidate' || run.role === 'shadow')
              const baselineResult = asRecord(baseline?.result)
              const comparisonResult = asRecord(comparison?.result)
              const baselinePacket = baselineResult.renderedPacketAvailable === true && typeof baselineResult.renderedPacket === 'string' ? baselineResult.renderedPacket : undefined
              const comparisonPacket = comparisonResult.renderedPacketAvailable === true && typeof comparisonResult.renderedPacket === 'string' ? comparisonResult.renderedPacket : undefined
              const baselineLines = new Set((baselinePacket ?? '').split('\n').slice(0, 120))
              const comparisonLines = new Set((comparisonPacket ?? '').split('\n').slice(0, 120))
              const removedPacketLines = [...baselineLines].filter((line) => line !== '' && !comparisonLines.has(line)).slice(0, 30)
              const addedPacketLines = [...comparisonLines].filter((line) => line !== '' && !baselineLines.has(line)).slice(0, 30)
              return <article className="tdai-memory" key={groupId}>
                <div className="tdai-memory-top"><code>{String(groupRuns[0]?.pairId ?? groupRuns[0]?.id ?? groupId)}</code><span>{groupRuns.length > 1 ? '成对历史' : typeof groupRuns[0]?.pairId === 'string' ? '配对记录待补齐' : '单次记录'} · {groupRuns.map((run) => String(run.role)).join(' / ')}</span></div>
                {groupRuns.length === 1 && typeof groupRuns[0]?.pairId === 'string' && <p className="tdai-muted">配对中的另一条记录可能位于下一页。</p>}
                {groupRuns.map((run) => {
                  const result = asRecord(run.result)
                  const reasons = asRecords(result.filterReasons)
                  const jumpIds = [...new Set([...displayList(result.hits), ...displayList(result.missing), ...displayList(result.forbidden),
                    ...reasons.map((item) => String(item.id ?? '')).filter(Boolean), ...asRecords(result.routes).map((item) => String(item.id ?? '')).filter(Boolean)])].slice(0, 20)
                  return <div key={String(run.id)}>
                    <div className="tdai-memory-top"><code>{String(run.caseId)} / {String(run.strategyId)}</code><span>{String(run.role)} · {run.createdAt === undefined ? '' : new Date(Number(run.createdAt)).toLocaleString()}</span></div>
                    <p>得分 {String(result.score ?? '—')} · 安全门 {String(result.hardGate ?? '—')} · 命中 {displayList(result.hits).join(' · ') || '无'}</p>
                    <p className="tdai-muted">缺失预期 ID：{displayList(result.missing).join(' · ') || '无'} · 禁止命中：{displayList(result.forbidden).join(' · ') || '无'}</p>
                    <p className="tdai-muted">预算省略 / 截断线索：{JSON.stringify(result.budgetGaps ?? []).slice(0, 600)} · 过滤原因：{reasons.map((item) => `${String(item.id)}（${String(item.reason)}）`).join('；').slice(0, 1200) || '无'}</p>
                    {jumpIds.length > 0 && <div className="tdai-memory-actions">{jumpIds.map((id) => {
                      const caseItem = evaluationCases.find((item) => String(item.id) === String(run.caseId))
                      const syntheticCaseId = caseItem?.source === 'synthetic' && asRecords(asRecord(caseItem.fixture).records)
                        .some((record) => String(record.id ?? '') === id) ? String(caseItem.id) : undefined
                      return syntheticCaseId !== undefined
                        ? <button type="button" key={id} onClick={() => {
                          setEvaluationCorpusFocus({ caseId: syntheticCaseId, recordId: id })
                          const target = document.getElementById(`evaluation-case-${syntheticCaseId}`)
                          target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          target?.focus({ preventScroll: true })
                        }}>定位合成案例 {id}</button>
                        : caseItem?.source === 'approved'
                          ? <button type="button" key={id} onClick={() => openKnowledgeDetail(id)}>打开知识详情 {id}</button>
                          : <span className="tdai-muted" role="status" key={id}>来源不可得：案例未知或合成语料已变更（{id}）</span>
                    })}</div>}
                    {strategies.some((item) => String(item.id ?? '') === String(run.strategyId ?? '')) && <div className="tdai-memory-actions">
                      <button type="button" onClick={() => {
                        const strategyId = String(run.strategyId ?? '')
                        const target = document.getElementById(`evaluation-strategy-${strategyId}`)
                        target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        target?.focus({ preventScroll: true })
                      }}>定位策略详情 {String(run.strategyId)}</button>
                    </div>}
                  </div>
                })}
                {baseline !== undefined && comparison !== undefined && <details><summary>成对结果与实际记忆包</summary>
                  <pre>{JSON.stringify({ baseline: { hits: baselineResult.hits, missing: baselineResult.missing, filterReasons: baselineResult.filterReasons },
                    comparison: { hits: comparisonResult.hits, missing: comparisonResult.missing, filterReasons: comparisonResult.filterReasons } }, null, 2).slice(0, 4000)}</pre>
                  {baselinePacket !== undefined && comparisonPacket !== undefined
                    ? <><p className="tdai-muted">实际渲染包差异（按行比较，最多列出 30 条差异；两侧正文各最多显示 6000 字符）。</p>
                      <p className="tdai-muted">基线中有、对照中无：</p><pre>{removedPacketLines.join('\n').slice(0, 3000) || '无差异行'}</pre>
                      <p className="tdai-muted">对照中新增：</p><pre>{addedPacketLines.join('\n').slice(0, 3000) || '无差异行'}</pre>
                      <details><summary>查看基线实际包</summary><pre>{baselinePacket.slice(0, 6000) || '实际包为空（无命中）'}</pre></details>
                      <details><summary>查看对照实际包</summary><pre>{comparisonPacket.slice(0, 6000) || '实际包为空（无命中）'}</pre></details></>
                    : <p className="tdai-muted">不可展示；历史包未保存完整来源，或当前来源权限已变化。</p>}
                </details>}
              </article>
            })}</div>
            {evaluationRuns.length === 0 && <p className="tdai-muted">尚无评测运行记录。</p>}
            {evaluationState.next !== undefined && <button type="button" className="tdai-load-more" disabled={evaluationRunsLoading || manageBusy} onClick={loadMoreEvaluationRuns}>{evaluationRunsLoading ? '正在读取…' : '加载更早的成对历史'}</button>}
          </section>
          <section className="tdai-panel tdai-form-grid"><div className="tdai-panel-head"><h3>新增合成评测案例</h3><span>禁止将未过滤候选作为命中</span></div>
            <label className="tdai-field"><span>ID</span><input value={evaluationId} onChange={(event) => setEvaluationId(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>标题</span><input value={evaluationTitle} onChange={(event) => setEvaluationTitle(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>查询</span><input value={evaluationQuery} onChange={(event) => setEvaluationQuery(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>预期 ID（一行一个）</span><textarea value={evaluationExpected} onChange={(event) => setEvaluationExpected(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>禁止 ID（一行一个）</span><textarea value={evaluationForbidden} onChange={(event) => setEvaluationForbidden(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>合成语料 JSON（字段 split 可用 train/holdout）</span><textarea value={evaluationFixture} onChange={(event) => setEvaluationFixture(event.currentTarget.value)} /></label>
            <button type="button" disabled={manageBusy || selectedProject === undefined} onClick={() => {
              try { const fixture = JSON.parse(evaluationFixture) as Record<string, unknown>; manageAction('evaluation.save', { id: evaluationId, title: evaluationTitle, query: evaluationQuery, expectedIds: splitLines(evaluationExpected), forbiddenIds: splitLines(evaluationForbidden), fixture, source: 'synthetic' }, '评测案例已保存') }
              catch (error) { setManageError(error instanceof Error ? error.message : '评测 JSON 无效') }
            }}>保存案例</button>
          </section>
          <section className="tdai-panel tdai-form-grid"><div className="tdai-panel-head"><h3>检索策略</h3><span>必须通过至少两条 holdout 安全门和非劣门槛</span></div>
            <p className="tdai-muted">当前策略：{String(strategyState.selectedId ?? 'builtin-v1')}</p>
            <div className="tdai-list">{strategies.map((item) => <article id={`evaluation-strategy-${String(item.id)}`} tabIndex={-1} className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.id)}</code><span>{String(item.status)} · 基于 {String(item.baseId)}</span></div><p>{String(item.title)} · 候选 {String(asRecord(item.config).maxCandidates)} / 结果 {String(asRecord(item.config).maxResults)}</p>
              <div className="tdai-memory-actions">{item.status === 'candidate' && <button type="button" disabled={manageBusy} onClick={() => manageAction('strategy.shadow', { strategyId: item.id }, '影子回放完成')}>影子回放</button>}
                {item.status === 'shadow' && <button type="button" disabled={manageBusy} onClick={() => manageAction('strategy.select', { strategyId: item.id }, (result) => {
                  const selection = asRecord(result)
                  const blockers = Array.isArray(selection.blockers) ? selection.blockers : []
                  const selected = asRecord(selection.selected)
                  return blockers.length > 0 ? `未选用：${blockers.length} 项门槛未通过` : selected.status === 'selected' ? '策略已选用' : '策略状态未改变'
                })}>检查门槛并选用</button>}
                {item.status === 'selected' && <button type="button" disabled={manageBusy} onClick={() => manageAction('strategy.rollback', { expectedCurrentId: item.id }, '策略已回滚')}>回滚到基线</button>}</div>
            </article>)}</div>
            <label className="tdai-field"><span>候选策略标题</span><input value={strategyTitle} onChange={(event) => setStrategyTitle(event.currentTarget.value)} /></label>
            <label className="tdai-field"><span>最大候选 / 结果数</span><span><input type="number" min={1} max={200} value={strategyCandidates} onChange={(event) => setStrategyCandidates(Number(event.currentTarget.value))} /> / <input type="number" min={1} max={40} value={strategyResults} onChange={(event) => setStrategyResults(Number(event.currentTarget.value))} /></span></label>
            <button type="button" disabled={manageBusy} onClick={() => manageAction('strategy.propose', { title: strategyTitle, maxCandidates: strategyCandidates, maxResults: strategyResults }, '候选策略已创建')}>创建候选</button>
          </section>
        </>}

        {activeView === 'governance' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>用量与调用状态</h3><span>今日已记录用量与在途估计</span></div>
            <dl className="tdai-facts">
              <div><dt>自动已用/预留</dt><dd>{String(asRecord(billableUsage.automatic).tokens ?? 0)} tokens · {String(asRecord(billableUsage.automatic).tasks ?? 0)} 次</dd></div>
              <div><dt>手动已用/预留</dt><dd>{String(asRecord(billableUsage.manual).tokens ?? 0)} tokens · {String(asRecord(billableUsage.manual).tasks ?? 0)} 次</dd></div>
              <div><dt>当前全局调用</dt><dd>{asRecord(billableUsage.active).id ? String(asRecord(billableUsage.active).state) : '空闲'}</dd></div>
            </dl>
            <p className="tdai-muted">不设每日 Token 或任务配额。未知调用继续持有防重闸门；人工核实只记审计，不会自动重试。</p>
          </section>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>调用尝试</h3><span>{governanceAttempts.length} 项</span></div>
            <div className="tdai-list">{governanceAttempts.map((item) => <article className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.id)}</code><span>{String(item.state)} · {String(item.provider)}/{String(item.model)}</span></div>
              <p>{String(item.purpose ?? item.jobId)} · 输入 {String(asRecord(item.usage).inputTokens ?? '未知')} / 输出 {String(asRecord(item.usage).outputTokens ?? '未知')}</p>
              <p className="tdai-muted">审计：{JSON.stringify(item.manualReviews ?? [])}</p>
            </article>)}</div>
            <div className="tdai-form-grid">
              <label className="tdai-field"><span>未知用量尝试 ID</span><input value={attemptId} onChange={(event) => setAttemptId(event.currentTarget.value)} /></label>
              <label className="tdai-field"><span>审计结论</span><select value={attemptDisposition} onChange={(event) => setAttemptDisposition(event.currentTarget.value as typeof attemptDisposition)}><option value="retain_unknown">保留未知</option><option value="charged">标记已计费</option></select></label>
              <label className="tdai-field"><span>理由（至少 8 字）</span><input value={attemptReason} onChange={(event) => setAttemptReason(event.currentTarget.value)} /></label>
              <button type="button" disabled={manageBusy || attemptId.trim() === '' || attemptReason.trim().length < 8} onClick={() => manageAction('attempt.reviewUnknown', { attemptId, disposition: attemptDisposition, reason: attemptReason }, '人工用量审计已记录')}>记录人工审计</button>
            </div>
          </section>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>用量预留与未知调用</h3><span>{billableCalls.length} 项 · 未知记录保留全局闸门</span></div>
            <div className="tdai-list">{billableCalls.map((item) => <article className="tdai-memory" key={String(item.id)}>
              <div className="tdai-memory-top"><code>{String(item.id)}</code><span>{String(item.state)} · {String(item.budgetClass)} · {String(item.purpose)}</span></div>
              <p>预留 {String(item.reservedTokens)} tokens · 实际 {item.actualTokens === null || item.actualTokens === undefined ? '未知' : String(item.actualTokens) + ' tokens'} · {new Date(Number(item.updatedAt)).toLocaleString()}</p>
              <p className="tdai-muted">人工审计：{JSON.stringify(item.reviews ?? [])}</p>
              {item.state === 'uncertain' && <button type="button" disabled={manageBusy} onClick={() => setBillableCallId(String(item.id))}>审计此未知调用</button>}
            </article>)}</div>
            {billableCallId !== '' && <div className="tdai-form-grid">
              <p className="tdai-muted">选中 {billableCallId}；人工审计只追加记录，不会解除未知调用占用或重发请求。</p>
              <label className="tdai-field"><span>审计结论</span><select value={attemptDisposition} onChange={(event) => setAttemptDisposition(event.currentTarget.value as typeof attemptDisposition)}><option value="retain_unknown">保留未知</option><option value="charged">标记已计费</option></select></label>
              <label className="tdai-field"><span>审计理由（至少 8 字）</span><input value={attemptReason} onChange={(event) => setAttemptReason(event.currentTarget.value)} /></label>
              <button type="button" disabled={manageBusy || attemptReason.trim().length < 8} onClick={() => manageAction('billable.reviewUnknown', { callId: billableCallId, disposition: attemptDisposition, reason: attemptReason }, '未知调用审计已记录')}>记录调用审计</button>
            </div>}
          </section>
        </>}

        {activeView === 'recovery' && <>
          <section className="tdai-panel"><div className="tdai-panel-head"><h3>本地恢复快照</h3><span>SQLite 一致性副本 · SHA-256 文件清单</span></div>
            <p className="tdai-muted">恢复仅对通过 v3 原始数据校验的快照开放。应用前会隔离迁移到新 generation 并核对 L0/L1 ID 与来源映射；稳定控制账本保留遗忘栅栏和高水位。</p>
            <button type="button" disabled={manageBusy || selectedProject === undefined} onClick={() => manageAction('recovery.snapshot', {}, '快照已创建；校验状态见列表')}>创建并校验快照</button>
            <div className="tdai-list">{recoveryItems.map((item, index) => {
              const snapshotId = typeof item.snapshotId === 'string' ? item.snapshotId : ''
              const snapshotIdValid = /^snap-\d+-[a-f0-9]{12}$/u.test(snapshotId)
              return (
                <article className="tdai-memory" key={snapshotId || `invalid-snapshot-${index}`}>
                  <div className="tdai-memory-top"><code>{snapshotId || '快照 ID 无效'}</code><span>{item.verified === true ? '校验通过' : '不完整/校验失败'} · {String(item.files)} 个文件</span></div>
                  <p className="tdai-muted">{String(item.createdAt ? new Date(Number(item.createdAt)).toLocaleString() : '时间未知')} · {displayList(item.blockers).join('；') || '文件哈希匹配'}</p>
                  <button type="button" disabled={manageBusy || !snapshotIdValid} onClick={() => { setRecoverySnapshotId(snapshotId); manageAction('recovery.plan', { snapshotId }, '恢复计划已生成；可执行状态与阻塞项见回执') }}>检查回滚计划</button>
                  {recoverySnapshotId === snapshotId && recoveryPlanState.snapshotId === snapshotId && <>
                    <p className={recoveryPlanReady ? 'tdai-good-text' : 'tdai-muted'}>{recoveryPlanReady ? '该快照当前满足恢复前置条件。' : '该快照尚不能应用。'} {displayList(recoveryPlanState.blockers).join('；')}</p>
                    <p className="tdai-muted">控制账本：保留未知状态 {String(recoveryPlanState.preservedUnknowns ?? 0)} 项 · 快照后的控制事件 {asRecords(asRecord(recoveryPlanState.controlReplay).replay).length} 条；账本本身不会回滚。</p>
                    <button type="button" className="tdai-danger" disabled={manageBusy || !snapshotIdValid || !recoveryPlanReady} onClick={() => manageAction('recovery.apply', { snapshotId }, '恢复已应用；运行状态正在重新读取')}>应用此快照</button>
                  </>}
                </article>
              )
            })}</div>{recoveryItems.length === 0 && <p className="tdai-muted">尚无完整快照。</p>}
            {recoverySnapshotId !== '' && <p className="tdai-muted">当前检查：{recoverySnapshotId}</p>}
          </section>
        </>}
      </>}
    </Shell>
  }

  return (
    <Shell>
      <header className="tdai-header">
        <div className="tdai-brand">
          <span className="tdai-glyph" aria-hidden="true">◈</span>
          <div>
            <div className="tdai-kicker">TDAI MEMORY <span>· 项目记忆</span></div>
            <h2>长期记忆</h2>
          </div>
        </div>
        <div className="tdai-header-side"><div className="tdai-range">{range}</div>{projectPicker}</div>
      </header>

      {navigation}
      {props.readDashboard !== undefined ? <BoundedOverviewSummary
        data={boundedOverviewData} error={overviewError ?? scopeError} loading={overviewLoading}
        projectName={selectedProject?.name} from={from} to={to} timeZone={overviewTimeZone} timeZones={timeZoneOptions}
        activity={activity} heatmapMonth={heatmapMonth} heatmapMonths={heatmapMonths}
        repeatedItems={repeatedItems} repeatedReady={repeatedReady} repeatedState={repeatedReadState}
        repeatedError={repeatedReadError} repeatedNotice={repeatedReadNotice} repeatedHasMore={repeatedHasMore}
        repeatedScanCursor={repeatedScanCursor} repeatedLoading={repeatedLoading} repeatedShowMore={showMoreRepeated}
        overviewHasMore={boundedOverviewCursor !== undefined}
        detailDimension={detailDimension} detailValue={detailValue} detailFingerprint={detailFingerprint} detailActivity={detailActivity}
        detailIncludeExcerpt={detailIncludeExcerpt} detailDate={detailDate} detailRange={detailRange}
        detailData={detailData} detailLoading={detailLoading} detailError={detailReadError} detailNotice={detailNotice}
        detailHasMore={boundedDetailCursor !== undefined || repeatedDetailCursor !== undefined || detailData?.next !== undefined}
        onRefresh={() => setOverviewRefresh((value) => value + 1)} onContinue={loadMoreBoundedOverview}
        onRangeDate={setManualRangeDate} onQuickRange={setQuickRange} onActivity={changeOverviewActivity}
        onTimeZone={changeOverviewTimeZone} onMonth={setHeatmapMonth}
        onDetailOpen={captureDetailOrigin}
        onDate={(date) => { setDetailActivityOverride(undefined); setDetailRange(false); setDetailDate(date); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }}
        onDimensionChange={(dimension) => { setDetailActivityOverride(undefined); setDetailDimension(dimension); setDetailValue(''); setDetailDate(''); setDetailRange(false); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }}
        onDimensionSelect={(dimension, value, readActivity) => {
          setDetailActivityOverride(readActivity)
          setDetailDimension(dimension); setDetailDate(''); setDetailValue(value); setDetailRange(true)
          setDetailFingerprint(''); setDetailIncludeExcerpt(false)
        }}
        onRepeatedSelect={(fingerprint) => { setDetailActivityOverride('capture'); setDetailDate(''); setDetailValue(''); setDetailRange(true); setDetailFingerprint(fingerprint); setDetailIncludeExcerpt(false) }}
        onClearDetail={closeOverviewDetail}
        onLoadMoreDetails={loadMoreDetails}
        onOpenMemories={() => { setQuery(''); setLibraryStatus('approved'); navigateView('memories') }}
        onOpenReview={() => navigateView('review')}
      /> : <>
      {notice !== undefined && <p className="tdai-notice" role="status">{notice}</p>}
      <section className="tdai-panel tdai-overview-controls">
        <div className="tdai-panel-head"><h3>项目范围</h3><span>{selectedProject?.name ?? '请选择项目，统计不会默认切换到列表首项'}</span></div>
        <div className="tdai-toolbar tdai-range-controls">
          <label>开始 <input type="date" value={from} onChange={(event) => setManualRangeDate('from', event.currentTarget.value)} /></label>
          <label>结束 <input type="date" value={to} onChange={(event) => setManualRangeDate('to', event.currentTarget.value)} /></label>
          <label>活动 <select value={activity} onChange={(event) => changeOverviewActivity(event.currentTarget.value as typeof activity)}>
            <option value="capture">捕获</option><option value="recall">召回</option><option value="injection">准备注入</option><option value="revision">已接受修订</option><option value="initial_approval">首次批准</option>
          </select></label>
          <label>时区 <select value={overviewTimeZone} onChange={(event) => changeOverviewTimeZone(event.currentTarget.value)} aria-label="概览时区">
            {timeZoneOptions.map((zone) => <option key={zone} value={zone}>{zone}{zone === systemTimeZone ? ' · 系统默认' : ''}</option>)}
          </select></label>
          <div className="tdai-shortcuts" aria-label="常用日期范围">
            <button type="button" onClick={() => shiftMonth(-1)}>上月</button><button type="button" onClick={() => shiftMonth(1)}>下月</button>
            <button type="button" onClick={() => setQuickRange(7)}>7 天</button><button type="button" onClick={() => setQuickRange(30)}>30 天</button>
            <button type="button" onClick={() => setQuickRange(90)}>90 天</button><button type="button" onClick={() => setQuickRange(365)}>365 天</button>
            <button type="button" onClick={() => setQuickRange('year')}>本年</button>
          </div>
          <span className="tdai-muted">期间统计按所选日期和时区；当前存量不受日期范围影响。后续修订与首次批准分开统计 · 最多 400 天。</span>
          <span className="tdai-muted">概览快照时间：{overviewData === undefined ? (overviewLoading ? '正在读取' : overviewError ? '读取失败' : '尚未读取') : formatOverviewTimestamp(overviewData.generatedAt, overviewTimeZone)} · 时区 {overviewTimeZone}</span>
        </div>
        {overviewError && <p className="tdai-danger-text" role="alert">{overviewError}</p>}
        {!overviewError && overviewLoading && <p className="tdai-muted" role="status">正在读取当前项目的本地概览统计…</p>}
        {!overviewError && !overviewLoading && selectedProjectKey === '' && <p className="tdai-muted" role="status">请选择项目后读取统计；当前不会默认切换到列表首项。</p>}
      </section>

      <div className="tdai-overview-hero">
        <section className="tdai-current-primary" aria-labelledby="tdai-current-title">
          <div className="tdai-current-head"><span>当前存量</span><span>{overviewData === undefined ? '截至当前读取' : `读取于 ${formatOverviewTimestamp(overviewData.generatedAt, overviewTimeZone)}`}</span></div>
          <button type="button" className="tdai-current-link" data-tdai-focus-key="overview-current-count"
            disabled={overviewData === undefined || props.library === undefined}
            aria-label={`当前有效记忆：${overviewData?.current.effectiveMemories.toLocaleString() ?? '尚未读取'}。点击查看已审核记忆`}
            onClick={(event) => { setQuery(''); setLibraryStatus('approved'); navigateView('memories', event.currentTarget) }}>
            <strong className="tdai-current-count">{overviewData === undefined ? '—' : overviewData.current.effectiveMemories.toLocaleString()}</strong>
            <span id="tdai-current-title" className="tdai-current-label">当前有效记忆 · 截至快照时间</span>
            <span className="tdai-current-hint">当前项目中已批准、未遗忘、未过期且通过来源与修订可读性检查的逻辑记忆。点击查看记忆库。</span>
          </button>
          <details className="tdai-metric-help"><summary>指标说明</summary><p>这是当前存量，不受上方日期范围影响。按逻辑记忆去重；已排除 Agent、来源撤权、删除围栏、无效修订及过期记录不会计入。快照读取时间为当前统计请求的生成时间。</p></details>
          <div className="tdai-current-pending"><span>当前待确认</span><strong>{overviewData === undefined ? '—' : overviewData.current.candidates.toLocaleString()}</strong>
            <span>{overviewData === undefined ? overviewStateText(selectedProjectKey, overviewLoading, overviewError) : '当前存量；不受日期范围影响'}</span></div>
        </section>

        <section className="tdai-panel tdai-provenance">
          <div className="tdai-panel-head"><h3>所选期间 · 捕获来源</h3><span>{overviewData === undefined ? '—' : `${overviewData.period.captures.toLocaleString()} 条已记录捕获`}</span></div>
          <p className="tdai-muted">按捕获来源的已记录事件分组；只反映当前项目与日期范围，不代表所有应用或 Agent 的总量。</p>
          {overviewData === undefined && <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p>}
          {overviewData !== undefined && sourceList.length === 0 && <p className="tdai-muted">所选期间没有可识别的捕获来源记录；覆盖状态见下方。</p>}
          {sourceList.map((source) => (
            <button type="button" className="tdai-source" key={source.other ? 'other' : source.source}
              aria-pressed={detailDimension === 'source' && detailRange && detailValue === (source.other ? '__other__' : source.source)}
              onClick={() => { setDetailDimension('source'); setDetailValue((current) => current === (source.other ? '__other__' : source.source) ? '' : (source.other ? '__other__' : source.source)); setDetailDate(''); setDetailRange(true); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }}>
              <span className="tdai-source-name">{source.other ? '其他来源' : source.source}</span>
              <span className="tdai-source-bar"><i style={{ width: `${Math.max(4, (source.count / maxSource) * 100)}%` }} /></span>
              <strong>{source.count}</strong>
            </button>
          ))}
          <div className="tdai-saved">
            <span>统计覆盖</span>
            <strong>{overviewData === undefined ? '—' : coverageLabel(overviewData.coverage.status)}</strong>
          </div>
          <p className="tdai-muted">{overviewData === undefined ? '未知 Agent 统计等待读取。' : `Agent 实例 ID 未知：${overviewData.period.unknownAgentEvents} 个事件 · Agent 预设 ID 未知：${overviewData.period.unknownAgentPresetEvents} 个事件`}</p>
        </section>
      </div>

      <div className="tdai-stats">
        <Stat value={overviewData?.period.captures ?? '—'} label="期间捕获消息" hint={overviewData === undefined ? overviewStateText(selectedProjectKey, overviewLoading, overviewError) : '所选期间已记录的捕获消息'} help="按本插件记录的捕获事件统计；日期与时区来自上方范围。导入或无法映射到事件的历史原文不推断为已捕获。" disabled={overviewData === undefined} onClick={() => { changeOverviewActivity('capture'); setDetailRange(true); setDetailDate(''); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }} />
        <Stat value={overviewData?.period.sessions ?? '—'} label="期间会话" hint={overviewData === undefined ? overviewStateText(selectedProjectKey, overviewLoading, overviewError) : `${overviewData.period.unknownSessionEvents} 条事件的会话身份未知`} help="所选期间内出现过可观察事件的不同 session ID 数；未知身份事件单列，不据此推断整台设备或全部 Agent 的会话数。" disabled={overviewData === undefined} onClick={() => { changeOverviewActivity('capture'); setDetailRange(true); setDetailDate(''); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }} />
        <Stat value={boundedRepeated ? (repeatedReady ? `${repeatedItems.length}${repeatedHasMore ? '+' : ''}` : '—') : (overviewData?.period.repeatedTotal ?? '—')} label="重复文本线索组" hint={boundedRepeated ? (repeatedReady ? `有界读取已载入 ${repeatedItems.length} 组${repeatedHasMore ? '，可继续加载' : ''}；相同文本线索不代表浪费` : '等待有界重复线索读取') : overviewData === undefined ? overviewStateText(selectedProjectKey, overviewLoading, overviewError) : `已载入 ${overviewData.period.repeated.length} 组；相同文本线索不代表浪费`} help="基于可见捕获事件的确定性文本指纹；重复次数为 n−1。相同表达不能单独证明提问多余或可节省用量。" disabled={boundedRepeated ? !repeatedReady : overviewData === undefined} onClick={() => {
          const first = repeatedItems[0]
          if (first === undefined) return
          changeOverviewActivity('capture'); setDetailRange(true); setDetailDate(''); setDetailValue(''); setDetailFingerprint(first.fingerprint); setDetailIncludeExcerpt(true)
        }} />
        <Stat value={overviewData === undefined ? '—' : formatCompact(overviewData.usage.preparedInjectionTokensEstimate)} label="期间准备注入 Token 估算" hint={overviewData === undefined ? overviewStateText(selectedProjectKey, overviewLoading, overviewError) : `${overviewData.period.preparedInjectionEvents} 个准备事件 · ${overviewData.period.preparedInjectionMemories} 条入选记忆`} help="只统计本地记录的准备注入事件和估算 Token，不是 Host 实际发送回执，也不代表模型采用或回答收益。" disabled={overviewData === undefined} onClick={() => { changeOverviewActivity('injection'); setDetailRange(true); setDetailDate(''); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }} />
      </div>

      <section className="tdai-panel tdai-activity">
        <div className="tdai-panel-head"><h3>{activity === 'capture' ? '捕获' : activity === 'recall' ? '成功召回结果' : activity === 'injection' ? '准备注入' : activity === 'initial_approval' ? '首次批准' : '已接受修订'}</h3>
          <span>{overviewData === undefined ? '—' : activity === 'recall' ? `${overviewData.period.recallRequests} 次请求 · ${overviewData.period.recallResults} 个去重返回结果` : `${overviewData.period.activity.length} 天 · 覆盖状态按日标注`}</span></div>
        {overviewData === undefined ? <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p> : <div className="tdai-day-list">{overviewData.period.activity.map((day) => {
          const value = activity === 'capture' ? day.captures : activity === 'recall' ? day.recalls : activity === 'initial_approval' ? day.initialApprovals : activity === 'injection' ? day.preparedInjectionEvents : day.revisions
          return <div className="tdai-day-row" key={day.date}><time dateTime={day.date}>{day.date}</time>
            <span className="tdai-day-bar"><i style={{ width: `${Math.max(value > 0 ? 3 : 0, (value / maxActivity) * 100)}%` }} /></span>
            <strong>{day.coverage === 'covered' ? value : `已记录 ${value}`}</strong>{activity === 'injection' && <span className="tdai-muted">{day.preparedInjections} 条记忆</span>}<span className={`tdai-coverage tdai-coverage-${day.coverage}`}>{coverageLabel(day.coverage)}</span></div>
        })}</div>}
      </section>

      <div className="tdai-grid tdai-lower">
        <section className="tdai-panel"><div className="tdai-panel-head"><h3>重复文本线索</h3><span>按指纹聚合，不显示原文</span></div>
        {boundedRepeated && activity !== 'capture' && <p className="tdai-muted" role="status">重复文本线索只在“捕获”活动范围内计算。</p>}
        {boundedRepeated && repeatedReadState === 'loading' && <p className="tdai-muted" role="status">正在有界读取重复线索…</p>}
        {boundedRepeated && repeatedReadError !== undefined && <p className="tdai-danger-text" role="status">{repeatedReadError}</p>}
        {boundedRepeated && repeatedReadState === 'error' && repeatedReadError === undefined &&
          <p className="tdai-danger-text" role="status">{repeatedReadNotice ?? '重复线索读取失败'}</p>}
        {boundedRepeated && repeatedReadState === 'partial' && repeatedReadNotice !== undefined &&
          <p className="tdai-muted" role="status">重复线索不完整：{repeatedReadNotice}；已载入 {repeatedItems.length} 组，不能当作完整排名</p>}
        {boundedRepeated && repeatedScanCursor !== undefined &&
          <button type="button" className="tdai-load-more" disabled={repeatedLoading} onClick={continueRepeatedScan}>
            {repeatedLoading ? '正在继续读取…' : '继续有界扫描（同一 readId）'}
          </button>}
        {!boundedRepeated && overviewData === undefined && <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p>}
        {repeatedReady && <div className="tdai-list">{repeatedItems.slice(0, repeatedVisibleCount).map((item) => <article className="tdai-memory" key={`${selectedProjectKey}:${item.fingerprint}`}>
            <div className="tdai-memory-top"><code title={item.fingerprint}>{item.fingerprint.length > 20 ? item.fingerprint.slice(0, 20) + '…' : item.fingerprint}</code><span>重复 {item.repeatCount} 次</span></div>
            <button type="button" onClick={() => { changeOverviewActivity('capture'); setDetailRange(true); setDetailDate(''); setDetailValue(''); setDetailFingerprint(item.fingerprint); setDetailIncludeExcerpt(true) }}>查看来源摘录与更多事件</button>
          </article>)}{repeatedItems.length === 0 && repeatedReadError === undefined &&
            (boundedRepeated ? repeatedReadState === 'ready' : true) &&
            <p className="tdai-muted">所选期间没有已记录的重复文本线索；这不代表内容在语义上没有重复。</p>}</div>}
        {repeatedReady && repeatedScanCursor === undefined && ((repeatedVisibleCount < repeatedItems.length) ||
          (boundedRepeated ? repeatedHasMore && !repeatedLoading : !repeatedExhausted && repeatedItems.length >= 100)) &&
          <button type="button" className="tdai-load-more" disabled={repeatedLoading} onClick={showMoreRepeated}>{repeatedLoading ? '正在读取…' : '加载更多重复线索'}</button>}
        </section>
        <section className="tdai-panel"><div className="tdai-panel-head"><h3>当前可见采集记录中的会话</h3><span>所选期间 · 按仍可关联的本地记录与采集事件排序；不代表完整聊天总量</span></div>
          {props.readDashboard !== undefined ? <>
            {boundedSessions === undefined
              ? <p className="tdai-muted" role="status">{overviewLoading ? '正在有界读取会话关联…' : '会话关联尚未读取。'}</p>
              : <>
                <p className="tdai-muted">已扫描 {boundedSessions.scannedEvents} 个可见采集事件、{boundedSessions.scannedSessions} 个会话；身份缺失、旧版或无效的可见采集事件 {boundedSessions.unknownIdentityEvents} 个；没有可识别会话的事件 {boundedSessions.unknownSessionEvents} 个。完整 Host 消息总数未知，这不是完整会话总数。</p>
                {boundedSessions.complete !== true && <p className="tdai-muted" role="status">会话关联扫描未完成（{boundedSessions.reason ?? 'bounded-session-scan-incomplete'}）；下列本地关联数是已扫描子集的下界，不能当作完整排名。</p>}
                <div className="tdai-list">{boundedSessions.items.map((item) => <article className="tdai-memory" key={`${item.projectKey}:${item.sessionId}`}>
                  <div className="tdai-memory-top"><code title={item.sessionId}>{item.sessionId.length > 24 ? item.sessionId.slice(0, 24) + '…' : item.sessionId}</code><span>{item.linkedL0Messages} 条关联本地消息记录{item.linkedL0Complete ? '' : '（下界）'} · {item.events} 个可见采集事件 · 已确认至少 {item.identityLowerBound} 条原始消息{item.identityComplete ? '' : '（下界）'} · 身份未知事件 {item.unknownIdentityEvents} · 完整会话消息总数未知</span></div>
                  <p className="tdai-muted">{item.projectName} · 本地 L0 关联只按同一项目内仍存在的来源记录计数；不补零、不冒充跨项目关联。</p>
                </article>)}{boundedSessions.items.length === 0 && boundedSessions.complete === true && <p className="tdai-muted">所选期间没有可识别的会话记录。</p>}</div>
              </>}
          </> : overviewData === undefined ? <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p> : <>
            <p className="tdai-muted">{overviewData.period.recordedOriginalMessageLowerBound === undefined ? '所选期间已确认消息数未知' : `所选期间已确认至少 ${overviewData.period.recordedOriginalMessageLowerBound} 条消息`}；身份缺失、旧版或无效的可见采集事件 {overviewData.period.unknownOriginalMessageEvents ?? '未知'} 个。旧记录和未覆盖消息无法确认，这不是完整会话总数。</p>
            <div className="tdai-list">{overviewData.period.topSessions.map((item) => <article className="tdai-memory" key={item.sessionId}>
              <div className="tdai-memory-top"><code title={item.sessionId}>{item.sessionId.length > 24 ? item.sessionId.slice(0, 24) + '…' : item.sessionId}</code><span>{item.linkedL0Messages === undefined ? '关联本地记录数未知' : `${item.linkedL0Messages} 条关联的本地消息记录`} · {item.recordedOriginalMessageLowerBound === undefined ? '已确认消息数未知' : `已确认至少 ${item.recordedOriginalMessageLowerBound} 条消息`} · 身份未知事件 {item.unknownOriginalMessageEvents ?? '未知'} · {item.originalMessageCount === null || item.originalMessageCount === undefined ? '完整会话消息总数未知' : `${item.originalMessageCount} 条原始消息`} · {item.events} 个可见采集事件</span></div>
          </article>)}{overviewData.period.topSessions.length === 0 && <p className="tdai-muted">所选期间没有可识别的会话记录。</p>}</div>
          </>}
        </section>
      </div>

      <div className="tdai-grid tdai-lower">
        <section className="tdai-panel"><div className="tdai-panel-head"><h3>插件辅助调用 · 按模型</h3><span>本插件账本中的抽取尝试</span></div>
          <p className="tdai-muted">这是 Memory-TDAI 插件记录的辅助调用用量，不代表整段聊天的总用量。未知值保留为“未知”。</p>
          {overviewData === undefined ? <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p> : <div className="tdai-list">{overviewData.usage.byModel.map((item) => <article className="tdai-memory" key={item.other ? 'other-models' : `${item.provider}:${item.model}`}>
            <div className="tdai-memory-top"><code>{item.other ? '其他模型（合并）' : `${item.provider} / ${item.model}`}</code><span>{item.calls} 次 · 未知 {item.unknownCalls}</span></div>
            <p className="tdai-muted">输入 {item.inputTokens === null ? '未知' : item.inputTokens} · 输出 {item.outputTokens === null ? '未知' : item.outputTokens}</p>
          </article>)}{overviewData.usage.byModel.length === 0 && <p className="tdai-muted">所选期间没有已记录的插件辅助抽取尝试。</p>}</div>}
        </section>
        <section className="tdai-panel"><div className="tdai-panel-head"><h3>插件辅助调用 · 按调用阶段</h3><span>用量账本已记录实际 Token</span></div>
          <p className="tdai-muted">仅覆盖本插件账本内的辅助调用；准备注入量是估算，未被计作实际调用回执。</p>
          {overviewData === undefined ? <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p> : <div className="tdai-list">{overviewData.usage.byPurpose.map((item) => <article className="tdai-memory" key={item.other ? 'other-purposes' : item.purpose}>
            <div className="tdai-memory-top"><code>{item.other ? '其他阶段（合并）' : item.purpose}</code><span>{item.calls} 次 · 未知 {item.unknownCalls}</span></div>
            <p className="tdai-muted">{item.tokens === null ? 'Token 用量未知' : `${item.tokens} tokens`}</p>
          </article>)}{overviewData.usage.byPurpose.length === 0 && <p className="tdai-muted">所选期间没有已记录的插件辅助调用。</p>}</div>}
        </section>
      </div>

      <section className="tdai-panel tdai-heatmap-panel"><div className="tdai-panel-head"><h3>活动热图</h3><span>{from} 至 {to} · {overviewData?.timezone ?? '时区未知'}</span></div>
        {overviewData === undefined && <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p>}
        {overviewData !== undefined && <>
        <div className="tdai-annual-heatmap">
        <div className="tdai-heatmap-scroll"><div className="tdai-heatmap" role="group" aria-label="每日活动热图">
          {heatmap.map((day, index) => {
            if (day.date === '') return <span className="tdai-heat-empty" key={'pad-' + index} aria-hidden="true" />
            const description = heatmapDayDescription(day.date, day.value, day.coverage, activity)
            return <button type="button" key={day.date} className={`tdai-heat-cell tdai-level-${heatLevel(day.value, maxActivity)} tdai-coverage-cell-${day.coverage}${!detailRange && detailDate === day.date ? ' selected' : ''}`}
              aria-label={description} title={description}
              onClick={() => { setDetailRange(false); setDetailDate(day.date); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }} />
          })}
        </div></div>
        </div>
        <div className="tdai-monthly-heatmap">
          <label className="tdai-field"><span>月份</span><select aria-label="热图月份" value={heatmapMonth} onChange={(event) => setHeatmapMonth(event.currentTarget.value)}>
            {heatmapMonths.map((month) => <option key={month} value={month}>{month}</option>)}
          </select></label>
          <div className="tdai-month-calendar" role="group" aria-label={`${heatmapMonth} 每日活动热图`}>
            {['一', '二', '三', '四', '五', '六', '日'].map((weekday) => <span className="tdai-month-weekday" key={weekday}>{weekday}</span>)}
            {monthlyHeatmap.map((day, index) => {
              if (day.date === '') return <span className="tdai-month-empty" key={'month-pad-' + index} aria-hidden="true" />
              const description = heatmapDayDescription(day.date, day.value, day.coverage, activity)
              return <button type="button" key={day.date} disabled={!day.inRange}
                className={`tdai-heat-cell tdai-level-${heatLevel(day.value, maxActivity)} tdai-coverage-cell-${day.coverage}${!detailRange && detailDate === day.date ? ' selected' : ''}`}
                aria-label={description} title={description}
                onClick={() => { setDetailRange(false); setDetailDate(day.date); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }} />
            })}
          </div>
        </div>
        <div className="tdai-legend"><span>记录量</span><i className="tdai-heat-cell tdai-level-0 tdai-coverage-cell-covered" /><i className="tdai-heat-cell tdai-level-1 tdai-coverage-cell-covered" /><i className="tdai-heat-cell tdai-level-2 tdai-coverage-cell-covered" /><i className="tdai-heat-cell tdai-level-3 tdai-coverage-cell-covered" /><i className="tdai-heat-cell tdai-level-4 tdai-coverage-cell-covered" /><span>少 → 多</span></div>
        <div className="tdai-coverage-legend"><span><i className="tdai-heat-cell tdai-level-0 tdai-coverage-cell-covered" />已覆盖：0 表示记录到零</span><span><i className="tdai-heat-cell tdai-level-0 tdai-coverage-cell-partial" />部分覆盖：零不代表整日为零</span><span><i className="tdai-heat-cell tdai-level-0 tdai-coverage-cell-unknown" />未知/未记录：数量未知</span></div>
        <p className="tdai-muted">选择日期可读取事件明细；统计数据来自本地记录，不会为统计调用模型。</p>
        </>}
      </section>

      <section className="tdai-panel"><div className="tdai-panel-head"><h3>来源与运行维度</h3><span>点击分组可筛选整个所选范围</span></div>
        <div className="tdai-toolbar"><label className="tdai-field"><span>维度</span><select value={detailDimension} onChange={(event) => { setDetailDimension(event.currentTarget.value as typeof detailDimension); setDetailValue(''); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }}>
          <option value="source">来源</option><option value="agent">Agent 实例 ID</option><option value="agent_preset">Agent 预设 ID</option><option value="provider">模型提供方</option><option value="model">模型</option>
        </select></label>{detailValue && <button type="button" onClick={() => setDetailValue('')}>清除筛选：{detailValue}</button>}</div>
        {overviewData === undefined ? <p className="tdai-muted" role="status">{overviewStateText(selectedProjectKey, overviewLoading, overviewError)}</p> : dimensionGroups.length === 0
          ? <p className="tdai-muted">所选期间没有可分组的本地活动记录。</p> : <div className="tdai-dimension-groups">{dimensionGroups.map((group) => <button type="button" key={group.value + ':' + group.count}
          className={detailValue === group.value ? 'selected' : ''} aria-pressed={detailValue === group.value}
          onClick={() => { setDetailValue((current) => current === group.value ? '' : group.value); setDetailDate(''); setDetailRange(true); setDetailFingerprint(''); setDetailIncludeExcerpt(false) }}>
          <span>{group.value === '__other__' ? '其他未展开分组' : group.value === 'unknown' ? detailDimension === 'agent' ? '未知 Agent 实例 ID' : detailDimension === 'agent_preset' ? '未知 Agent 预设 ID' : group.value : detailDimension === 'agent_preset' ? `预设 ID：${group.value}` : group.value}</span><strong>{group.count}</strong></button>)}</div>}
      </section>

      {(detailDate !== '' || detailRange) && <section className="tdai-panel"><div className="tdai-panel-head"><h3>{detailRange ? `${from} 至 ${to} 事件明细` : `${detailDate} 事件明细`}</h3><span>{detailFingerprint !== ''
        ? `重复指纹 ${detailFingerprint.slice(0, 12)} · ${detailIncludeExcerpt ? '按请求显示最多 160 字符摘录' : '不含原始消息正文'}`
        : detailValue ? (detailDimension === 'agent' ? 'Agent 实例 ID' : detailDimension === 'agent_preset' ? 'Agent 预设 ID' : detailDimension) + ': ' + (detailValue === '__other__' ? '其他未展开分组' : detailValue) : '不含原始消息正文'}</span></div>
        {detailReadError !== undefined && <p className="tdai-danger-text" role="status">事件读取失败：{detailReadError}</p>}
        {detailNotice !== undefined && <p className="tdai-muted" role="status">事件读取未完成：{detailNotice}</p>}
        {detailLoading && <p className="tdai-muted">正在读取本地事件…</p>}
        {!detailLoading && detailReadError === undefined && detailNotice === undefined &&
          (detailData?.events.length ?? 0) === 0 && <p className="tdai-muted">所选日期和维度没有事件。</p>}
        <div className="tdai-list">{detailData?.events.map((event) => <article className="tdai-memory" key={String(event.id) + ':' + String(event.eventId)}>
          <div className="tdai-memory-top"><code>{String(event.type)} · {new Date(Number(event.occurredAt)).toLocaleTimeString(undefined, { timeZone: overviewTimeZone })}</code><span>{event.type === 'inject_prepared' ? '1 个事件' : `${String(event.count ?? 0)} 次`}</span></div>
          {event.type === 'inject_prepared' && <p className="tdai-muted">准备 {String(event.count ?? 0)} 条入选记忆 · {String(event.tokens ?? 0)} 估算 Token{event.rawTokens === undefined ? '' : ` · 内容估算 ${String(event.rawTokens)} Token`}{event.tokenEstimate === true ? ' · 本地估算值' : ''}</p>}
          {event.sourceOccurredAt !== undefined && <p className="tdai-muted">原始事件时间：{new Date(Number(event.sourceOccurredAt)).toLocaleString(undefined, { timeZone: overviewTimeZone })}</p>}
          <p className="tdai-muted">{[event.source, typeof event.agentId === 'string' ? `Agent 实例 ID ${event.agentId}` : 'Agent 实例 ID 未知', typeof event.agentPreset === 'string' ? `Agent 预设 ID ${event.agentPreset}` : 'Agent 预设 ID 未知', event.provider, event.model].filter((value) => typeof value === 'string').join(' · ')}</p>
          <p className="tdai-muted">事件 {String(event.eventId)}{event.sourceId ? ' · 来源记录 ' + String(event.sourceId) : ''}{event.fingerprint ? ' · 指纹 ' + String(event.fingerprint).slice(0, 12) : ''}</p>
          {typeof event.sessionId === 'string' && <p className="tdai-muted">会话 ID：<code>{event.sessionId}</code></p>}
          {typeof event.excerpt === 'string' && <p className="tdai-detail-excerpt">{event.excerpt}{event.excerptTruncated === true ? '…' : ''}</p>}
        </article>)}</div>
        {(detailData?.next !== undefined || repeatedDetailCursor !== undefined) && <button type="button" className="tdai-load-more" disabled={detailLoading} onClick={loadMoreDetails}>加载更多事件</button>}
      </section>}

      <div className="tdai-grid tdai-lower">
        <section className="tdai-panel">
          <div className="tdai-panel-head">
            <h3>待确认队列</h3>
            <span>{projectCandidates.length} 条</span>
          </div>
          {projectCandidates.length === 0 && <p className="tdai-muted">当前项目没有待确认记忆。</p>}
          <div className="tdai-list">
            {filteredCandidates.slice(0, 6).map((memory) => (
              <article className="tdai-memory" key={memory.id}>
                <div className="tdai-memory-top"><code>{memory.id}</code><span>{memory.projectName}</span></div>
                <p>{memory.content}</p>
                <div className="tdai-memory-actions">
                  <span className="tdai-pill">{memory.kind}</span>
                  <span className="tdai-pill">{Math.round(memory.confidence * 100)}%</span>
                  <button type="button" disabled={busy} onClick={() => reviewMemory(memory, 'approve')}>通过</button>
                  <button type="button" className="tdai-danger" disabled={busy} onClick={() => reviewMemory(memory, 'forget')}>遗忘</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="tdai-panel">
          <div className="tdai-panel-head"><h3>近期记忆</h3><span>{projectRecent.length} 条</span></div>
          <div className="tdai-list">
            {filteredRecent.length === 0 && <p className="tdai-muted">尚无已批准记忆。</p>}
            {filteredRecent.slice(0, 6).map((memory) => (
              <article className="tdai-memory tdai-recent" key={memory.id}>
                <div className="tdai-memory-top"><code>{memory.id}</code><span>{memory.projectName}</span></div>
                <p>{memory.content}</p>
                <div className="tdai-memory-actions"><span className="tdai-pill">{memory.kind}</span><span className="tdai-pill">{new Date(memory.updatedAt).toLocaleDateString()}</span></div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="tdai-panel tdai-profile">
        <div className="tdai-panel-head">
          <h3>画像与主题</h3>
          <div className="tdai-profile-head">
            <span>{selectedPersona?.projectName ?? selectedProject?.name ?? '请选择项目'} · {props.readDashboard !== undefined
              ? boundedGlobalArea.status === 'loading' ? '全局画像读取中' : boundedGlobalArea.status === 'error' ? '全局画像读取失败' : boundedGlobalArea.data === null && boundedGlobalArea.status === 'ready' ? '无全局画像' : '全局画像状态已读取'
              : viewGlobalPersona === null ? '无全局画像' : '已有全局画像'}</span>
            <button type="button" disabled={busy || viewProjectIdentities.length === 0 || (props.refreshPersona === undefined && props.refreshPersonaAck === undefined)} onClick={regenerate}>生成项目画像</button>
            <button type="button" disabled={busy || (props.refreshGlobalPersona === undefined && props.refreshGlobalPersonaAck === undefined)} onClick={regenerateGlobal}>生成全局画像</button>
          </div>
        </div>
        {props.readDashboard !== undefined ? <>
          {boundedPersonaArea.status === 'loading' && <p className="tdai-muted" role="status">正在独立读取项目画像…</p>}
          {boundedPersonaArea.error !== undefined && <div className="tdai-danger-text" role="alert"><span>{boundedPersonaArea.error}</span>
            <button type="button" onClick={() => setBoundedAreaRefresh((value) => ({ ...value, persona: value.persona + 1 }))}>重试项目画像</button></div>}
          {boundedPersonaArea.cursor !== undefined && <button type="button" className="tdai-load-more" disabled={boundedPersonaArea.status === 'loading'} onClick={continuePersonaRead}>
            {boundedPersonaArea.status === 'loading' ? '正在继续读取项目画像…' : '继续读取项目画像'}</button>}
          {boundedPersonaArea.status === 'partial' && boundedPersonaArea.cursor === undefined && <button type="button" onClick={() => setBoundedAreaRefresh((value) => ({ ...value, persona: value.persona + 1 }))}>刷新项目画像状态</button>}
          {boundedPersonaArea.data !== undefined && <div className="tdai-profile-body">
            <div className="tdai-profile-meta">{boundedPersonaArea.data.projectName} · 来源记忆 {boundedPersonaArea.data.sourceCount} 条 · {new Date(boundedPersonaArea.data.updatedAt).toLocaleDateString()}</div>
            <pre className="tdai-profile-text">{boundedPersonaArea.data.content}</pre>
          </div>}
          {boundedPersonaArea.status === 'ready' && boundedPersonaArea.data === undefined && <p className="tdai-muted">当前项目没有可显示画像。</p>}
          {boundedGlobalArea.status === 'loading' && <p className="tdai-muted" role="status">正在独立读取全局画像…</p>}
          {boundedGlobalArea.error !== undefined && <div className="tdai-danger-text" role="alert"><span>{boundedGlobalArea.error}</span>
            <button type="button" onClick={() => setBoundedAreaRefresh((value) => ({ ...value, global: value.global + 1 }))}>重试全局画像</button></div>}
          {boundedGlobalArea.cursor !== undefined && <button type="button" className="tdai-load-more" disabled={boundedGlobalArea.status === 'loading'} onClick={continueGlobalPersonaRead}>
            {boundedGlobalArea.status === 'loading' ? '正在继续读取全局画像…' : '继续读取全局画像'}</button>}
          {boundedGlobalArea.status === 'partial' && boundedGlobalArea.cursor === undefined && <button type="button" onClick={() => setBoundedAreaRefresh((value) => ({ ...value, global: value.global + 1 }))}>刷新全局画像状态</button>}
          {boundedGlobalArea.status === 'ready' && boundedGlobalArea.data === null && <p className="tdai-muted">已确认当前没有全局画像。</p>}
          {boundedGlobalArea.data !== undefined && boundedGlobalArea.data !== null && <div className="tdai-profile-body">
            <div className="tdai-profile-meta">全局 · 来源记忆 {boundedGlobalArea.data.sourceCount} 条 · {new Date(boundedGlobalArea.data.updatedAt).toLocaleDateString()}</div>
            <pre className="tdai-profile-text">{boundedGlobalArea.data.content}</pre>
          </div>}
          {boundedSceneArea.status === 'loading' && <p className="tdai-muted" role="status">正在独立读取场景…</p>}
          {boundedSceneArea.error !== undefined && <div className="tdai-danger-text" role="alert"><span>{boundedSceneArea.error}</span>
            <button type="button" onClick={() => setBoundedAreaRefresh((value) => ({ ...value, scene: value.scene + 1 }))}>重试场景</button></div>}
          {boundedSceneArea.cursor !== undefined && <button type="button" className="tdai-load-more" disabled={boundedSceneArea.status === 'loading'} onClick={continueSceneRead}>
            {boundedSceneArea.status === 'loading' ? '正在继续读取场景…' : '继续读取场景'}</button>}
          {boundedSceneArea.status === 'partial' && boundedSceneArea.cursor === undefined && <button type="button" onClick={() => setBoundedAreaRefresh((value) => ({ ...value, scene: value.scene + 1 }))}>刷新场景状态</button>}
          {boundedSceneArea.status === 'ready' && (boundedSceneArea.data?.length ?? 0) === 0 && <p className="tdai-muted">已完整确认当前没有可显示场景。</p>}
        </> : <>
          {selectedPersona === undefined && viewGlobalPersona === null && (
            <p className="tdai-muted">还没有 L3 画像。至少批准 3 条记忆后，可从已批准事实生成精简画像。此操作为可选项，会调用一次 Host 模型。</p>
          )}
          {selectedPersona !== undefined && [selectedPersona].map((persona) => (
            <div className="tdai-profile-body" key={persona.projectKey}>
              <div className="tdai-profile-meta">{persona.projectName} · 来源记忆 {persona.sourceCount} 条 · {new Date(persona.updatedAt).toLocaleDateString()}</div>
              <pre className="tdai-profile-text">{persona.content}</pre>
            </div>
          ))}
          {selectedPersona === undefined && viewGlobalPersona !== null && (
            <div className="tdai-profile-body">
              <div className="tdai-profile-meta">全局 · 来源记忆 {viewGlobalPersona.sourceCount} 条 · {new Date(viewGlobalPersona.updatedAt).toLocaleDateString()}</div>
              <pre className="tdai-profile-text">{viewGlobalPersona.content}</pre>
            </div>
          )}
        </>}
        <div className="tdai-scenes">
          {viewScenes
            .filter((scene) => scene.projectKey === selectedProjectKey)
            .slice(0, 6)
            .map((scene) => (
              <span className="tdai-scene" key={`${scene.projectKey}:${scene.name}`} title={scene.summary}>
                {scene.name} <b>{scene.memoryCount}</b>
              </span>
            ))}
        </div>
        {props.readDashboard !== undefined && boundedSceneArea.status === 'partial' && <p className="tdai-muted" role="status">场景列表为部分结果；已明确标记隐藏或不完整数据状态。</p>}
      </section>

      <div className="tdai-grid tdai-lower">
        {renderSettingsPanel(true)}

        <section className="tdai-panel tdai-footer-panel">
          <div className="tdai-panel-head"><h3>概况</h3><span>{selectedProject?.name ?? '本地'}</span></div>
          <dl className="tdai-facts">
            <div><dt>关联本地记录最多的可见会话</dt><dd>{overviewData === undefined || overviewData.period.mostLinkedL0Session === null || overviewData.period.mostLinkedL0Session === undefined ? '—' : `${overviewData.period.mostLinkedL0Session.linkedL0Messages} 条本地消息记录；${overviewData.period.mostLinkedL0Session.recordedOriginalMessageLowerBound === undefined ? '已确认消息数未知' : `已确认至少 ${overviewData.period.mostLinkedL0Session.recordedOriginalMessageLowerBound} 条消息`}；身份未知事件 ${overviewData.period.mostLinkedL0Session.unknownOriginalMessageEvents ?? '未知'} 个；完整会话消息总数未知`}</dd></div>
            <div><dt>已遗忘</dt><dd>{forgottenSummaryText}</dd></div>
            <div><dt>召回请求</dt><dd>{overviewData?.period.recallRequests ?? '—'}</dd></div>
            <div><dt>最近错误</dt><dd className={viewLastError ? 'tdai-danger-text' : ''}>{viewLastError ?? '无'}</dd></div>
          </dl>
          <div className="tdai-toolbar">
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="筛选当前视图…" />
            <button type="button" onClick={() => { void refresh(); invalidateReadViews() }} disabled={busy}>刷新</button>
            <button type="button" onClick={download} disabled={busy || selectedProject === undefined}>导出 JSONL</button>
          </div>
          <p className="tdai-muted">召回记忆是历史证据，不是指令。除 Host 已负责发起的模型调用外，内容不会离开本机。</p>
        </section>
      </div>
      </>}
    </Shell>
  )
}

function SettingsNumberField({ label, value, minimum, maximum, disabled, resetToken, onCommit, onInvalid }: {
  label: string
  value: number
  minimum: number
  maximum: number
  disabled: boolean
  resetToken: number
  onCommit: (value: number) => void
  onInvalid: (message: string) => void
}): ReactNode {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    // A current successful read always resets the displayed draft, even when
    // the normalized value happens to equal the previous value.
    setDraft(String(value))
  }, [value, resetToken])
  return <label className="tdai-field"><span>{label}</span>
    <input type="number" min={minimum} max={maximum} step={1} value={draft} disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => {
        const parsed = parseSettingsNumberDraft(event.currentTarget.value, minimum, maximum)
        if (!parsed.valid) {
          setDraft(String(value))
          onInvalid(parsed.reason === 'empty' ? '数值不能为空，已恢复实际值' : `数值必须是 ${minimum}–${maximum} 的整数，已恢复实际值`)
          return
        }
        setDraft(String(parsed.value))
        if (parsed.value !== value) onCommit(parsed.value)
      }} />
  </label>
}

type DashboardDimensionCategory = 'source' | 'agent' | 'agent_preset' | 'provider' | 'model'
type DashboardDimensionItem = NonNullable<ReadDashboardResult['dimensions']>['sources'][number]

/** Build category-aware dimension rows; the same projection supplies rendered buttons and their click handlers. */
export function dashboardDimensionRows(items: DashboardDimensionItem[], category: DashboardDimensionCategory,
  selectedCategory: DashboardDimensionCategory, selectedValue: string,
  onSelect: (category: DashboardDimensionCategory, value: string) => void) {
  const maxCount = Math.max(1, ...items.flatMap((item) => item.count.value === null ? [] : [item.count.value]))
  return items.map((item, index) => {
    const overflow = items.length === 10 && index === 9 && item.key === 'other'
    const value = overflow ? '__other__' : item.key
    const unknownLabel = category === 'agent' ? '未知 Agent' : category === 'provider' ? '未知 Provider'
      : category === 'model' ? '未知模型' : category === 'source' ? '未知来源' : '未知 Agent 预设'
    const count = item.count.value
    return {
      reactKey: `${category}:${index}:${item.key}`,
      category,
      value,
      label: overflow ? '其他（合并）' : item.key === 'unknown' ? unknownLabel : item.key,
      countText: metricText(item.count),
      width: count === null ? 0 : Math.max(2, Math.min(100, count / maxCount * 100)),
      selected: category === selectedCategory && selectedValue === value,
      onSelect: () => onSelect(category, value),
      title: `${item.key}：${metricText(item.count)} 条唯一事件`,
    }
  })
}

/** The active bounded activity panel uses observed ledger fields without inferred allocations. */
export function BoundedUsagePanel({ data }: { data: ReadDashboardResult | undefined }) {
  const usage = data?.usage
  const model = boundedOverviewModel(data)
  const renderGroups = (rows: typeof model.modelUsageRows, emptyText: string, purpose = false) =>
    rows.length === 0 ? <p className="tdai-muted">{data === undefined ? '尚未读取用量。' : emptyText}</p>
      : <div className="tdai-list">{rows.map((row) => <article className="tdai-memory" key={row.reactKey}>
        <div className="tdai-memory-top"><strong style={{ overflowWrap: 'anywhere' }}>{row.label}</strong><span>{row.countText} 次</span></div>
        <p className="tdai-muted">{purpose ? '实际 Token 已确认' : '全部用量字段齐全'} {row.knownText} 次 · 字段缺失或待核实 {row.unknownText} 次 · 身份未知 {row.unknownIdentityText} 次</p>
        <dl className="tdai-facts">{row.fields.map((field) => <div key={field.key}>
          <dt>{field.label}</dt><dd>{field.valueText}<br /><small className="tdai-muted">{field.evidenceText}</small></dd>
        </div>)}</dl>
      </article>)}</div>
  return <section className="tdai-panel" aria-label="插件辅助调用用量">
    <div className="tdai-panel-head"><h3>插件辅助调用用量</h3><span>已观察的本地记录</span></div>
    <p className="tdai-muted">尝试 {metricText(usage?.attempts.calls)} 次 · 全部字段齐全 {metricText(usage?.attempts.knownCalls)} 次 · 字段缺失或待核实 {metricText(usage?.attempts.unknownCalls)} 次</p>
    <dl className="tdai-facts"><div><dt>输入 / 输出 Token</dt><dd>{metricText(usage?.attempts.inputTokens)} / {metricText(usage?.attempts.outputTokens)}</dd></div>
      <div><dt>缓存读取 / 写入 / 推理</dt><dd>{metricText(usage?.attempts.cacheReadTokens)} / {metricText(usage?.attempts.cacheWriteTokens)} / {metricText(usage?.attempts.reasoningTokens)}</dd></div>
      <div><dt>记录费用（微单位）</dt><dd>{metricText(usage?.attempts.costMicros)}</dd></div>
    </dl>
    <p className="tdai-muted">缓存和推理是诊断子项，不与输入／输出重复相加。缺少费用记录不表示 Token 未知，也不按价格推算费用。</p>
    <h4>按模型 · 实际辅助用量</h4>
    <p className="tdai-muted">按首次遇到的身份列出，最多九组及其他合并项，不代表全局用量排名。{usage?.attempts.grouping?.overflow ? '其余模型已合并，合计仍包含其记录。' : ''} 身份未知 {metricText(usage?.attempts.grouping?.unknownIdentityCalls)} 次。</p>
    {renderGroups(model.modelUsageRows, model.modelUsageEmptyText)}
    <h4>按用途 · 账本实际用量</h4>
    <p className="tdai-muted">账本 {metricText(usage?.billable.calls)} 次 · 实际 Token {metricText(usage?.billable.tokens)}。与上方尝试记录分别观察，不相加；预留 Token 不当作实际用量。{usage?.billable.grouping?.overflow ? '其余用途已合并。' : ''}</p>
    {renderGroups(model.purposeUsageRows, model.purposeUsageEmptyText, true)}
    <h4>准备注入估算</h4>
    <dl className="tdai-facts"><div><dt>准备注入 Token 估算</dt><dd>{metricText(usage?.preparedInjectionTokensEstimate)}</dd></div>
      <div><dt>估算方法</dt><dd>{usage?.preparedInjectionEstimateMethod === 'sum-prepared-event-tokens' ? '按本地准备事件的 Token 估算值求和' : '未知'}</dd></div>
    </dl>
    <h4>可比节省</h4>
    <p className="tdai-muted">主模型用量覆盖：不可用 · 实际注入回执：不可用 · 可比净节省：不可计算。准备结果不代表实际发送、模型采用或回答收益。</p>
  </section>
}

export function BoundedOverviewSummary(props: {
  data: ReadDashboardResult | undefined
  error?: string
  loading: boolean
  projectName?: string
  from: string
  to: string
  timeZone: string
  timeZones: string[]
  activity: 'capture' | 'recall' | 'revision' | 'initial_approval' | 'injection'
  heatmapMonth: string
  heatmapMonths: string[]
  repeatedItems: Array<{ fingerprint: string; repeatCount: number }>
  repeatedReady: boolean
  repeatedState: 'idle' | 'loading' | 'ready' | 'partial' | 'error'
  repeatedError?: string
  repeatedNotice?: string
  repeatedHasMore: boolean
  repeatedScanCursor?: string
  repeatedLoading: boolean
  repeatedShowMore: () => void
  overviewHasMore: boolean
  detailDimension: 'source' | 'agent' | 'agent_preset' | 'provider' | 'model'
  detailValue: string
  detailFingerprint: string
  detailIncludeExcerpt: boolean
  detailActivity?: HeatmapActivity
  detailDate: string
  detailRange: boolean
  detailData?: { events: Array<Record<string, unknown>>; next?: { occurredAt: number; id: number } }
  detailLoading: boolean
  detailError?: string
  detailNotice?: string
  detailHasMore: boolean
  onRefresh: () => void
  onContinue: () => void
  onRangeDate: (field: 'from' | 'to', value: string) => void
  onQuickRange: (days: number | 'year') => void
  onActivity: (activity: 'capture' | 'recall' | 'revision' | 'initial_approval' | 'injection') => void
  onTimeZone: (timeZone: string) => void
  onMonth: (month: string) => void
  onDetailOpen: (trigger: HTMLElement) => void
  onDate: (date: string) => void
  onDimensionChange: (dimension: 'source' | 'agent' | 'agent_preset' | 'provider' | 'model') => void
  onDimensionSelect: (category: DashboardDimensionCategory, value: string, activity: HeatmapActivity) => void
  onRepeatedSelect: (fingerprint: string) => void
  onClearDetail: () => void
  onLoadMoreDetails: () => void
  onOpenMemories: () => void
  onOpenReview: () => void
}): ReactNode {
  const model = boundedOverviewModel(props.data, props.activity)
  const metrics = model.period
  const sourceRows = model.captureSources
  const selected = model.selectedDimensions
  const dimensions = props.detailDimension === 'source' ? selected?.sources
    : props.detailDimension === 'agent' ? selected?.agents
      : props.detailDimension === 'agent_preset' ? selected?.agentPresets
        : props.detailDimension === 'provider' ? selected?.providers : selected?.models
  const activityLabel = props.activity === 'capture' ? '捕获事件' : props.activity === 'recall' ? '召回事件'
    : props.activity === 'revision' ? '已接受修订事件' : props.activity === 'initial_approval' ? '首次批准事件' : '准备注入事件'
  const heatmap = boundedHeatmapDays(props.from, props.to, model.activity)
  const monthlyHeatmap = boundedMonthlyHeatmapDays(props.heatmapMonth, props.from, props.to, model.activity)
  const maxActivity = Math.max(1, ...model.activity.flatMap((day) => day.count.value === null ? [] : [day.count.value]))
  const oldest = model.processing?.oldestWaiting
  const oldestText = oldest === undefined || oldest.state === 'unknown' ? '未知'
    : oldest.state === 'none' ? '已完整确认无等待'
      : `${oldest.state === 'partial' ? '部分已读集合中的最早' : '完整集合的最早'}${oldest.value === null ? '：未知' : `：${new Date(oldest.value).toLocaleString()}`}`
  const dimensionLabel = props.detailDimension === 'agent_preset' ? 'Agent 预设 ID'
    : props.detailDimension === 'agent' ? 'Agent 实例 ID' : props.detailDimension === 'provider' ? '模型提供方'
      : props.detailDimension === 'model' ? '模型' : '来源'
  const overviewStatus = props.error !== undefined ? `读取失败 · ${props.error}`
    : props.data === undefined ? props.loading ? '正在读取本地统计' : '尚未读取'
      : props.data.complete && props.data.status === 'ok' ? '完整读取' : `部分结果 · ${props.data.reason ?? props.data.status}`
  const renderDimensionRows = (items: NonNullable<typeof model.captureSources>, category: DashboardDimensionCategory,
    readActivity: HeatmapActivity = props.activity): ReactNode =>
    items.length === 0 ? <p className="tdai-muted">此范围没有可识别的{category === 'source' ? '来源' : dimensionLabel}记录。</p>
      : <div className="tdai-dimension-groups">{dashboardDimensionRows(items, category, props.detailDimension,
        (props.detailActivity ?? props.activity) === readActivity ? props.detailValue : '',
        (dimension, value) => props.onDimensionSelect(dimension, value, readActivity)).map((row) => <button type="button" key={row.reactKey} className={row.selected ? 'selected' : ''}
          aria-pressed={row.selected} title={row.title} onClick={(event) => { props.onDetailOpen(event.currentTarget); row.onSelect() }}>
          <span>{row.label}</span><strong>{row.countText} 次</strong>
          <i className="tdai-source-bar"><b style={{ width: `${row.width}%` }} /></i>
        </button>)}</div>
  return <>
    <section className="tdai-panel tdai-overview-controls">
      <div className="tdai-panel-head"><h3>项目范围</h3><span>{props.projectName ?? '请选择项目，统计不会默认切换到列表首项'}</span></div>
      <div className="tdai-toolbar tdai-range-controls">
        <label>开始 <input type="date" value={props.from} onChange={(event) => props.onRangeDate('from', event.currentTarget.value)} /></label>
        <label>结束 <input type="date" value={props.to} onChange={(event) => props.onRangeDate('to', event.currentTarget.value)} /></label>
        <label>活动 <select value={props.activity} onChange={(event) => props.onActivity(event.currentTarget.value as typeof props.activity)}>
          <option value="capture">捕获</option><option value="recall">召回</option><option value="injection">准备注入</option><option value="revision">已接受修订</option><option value="initial_approval">首次批准</option>
        </select></label>
        <label>时区 <select value={props.timeZone} onChange={(event) => props.onTimeZone(event.currentTarget.value)} aria-label="概览时区">
          {props.timeZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
        </select></label>
        <div className="tdai-shortcuts" aria-label="常用日期范围">
          <button type="button" onClick={() => props.onQuickRange(7)}>7 天</button><button type="button" onClick={() => props.onQuickRange(30)}>30 天</button>
          <button type="button" onClick={() => props.onQuickRange(90)}>90 天</button><button type="button" onClick={() => props.onQuickRange(365)}>365 天</button>
          <button type="button" onClick={() => props.onQuickRange('year')}>本年</button>
          <button type="button" onClick={props.onRefresh} disabled={props.loading}>刷新</button>
        </div>
        <span className="tdai-muted">期间统计按所选日期、时区和活动类型；当前存量独立标记为“截至当前”。</span>
      </div>
      {props.error !== undefined && <p className="tdai-danger-text" role="alert">概览读取失败：{props.error} <button type="button" onClick={props.onRefresh}>重试</button></p>}
      {props.loading && <p className="tdai-muted" role="status">正在读取当前项目的本地统计…</p>}
      {props.data !== undefined && (!props.data.complete || props.data.status !== 'ok') && <p className="tdai-muted" role="status">统计范围不完整：{props.data.reason ?? props.data.status}；下界、未知值和覆盖状态按原始口径显示。</p>}
      {props.data === undefined && props.error === undefined && !props.loading && <p className="tdai-muted" role="status">{props.projectName === undefined ? '请选择项目后读取统计。' : '概览数据尚未加载。'}</p>}
      {props.overviewHasMore && <button type="button" className="tdai-load-more" disabled={props.loading} onClick={props.onContinue}>继续读取概览</button>}
    </section>

    <div className="tdai-overview-hero">
      <section className="tdai-current-primary" aria-labelledby="tdai-current-title">
        <div className="tdai-current-head"><span>当前存量</span><span>{props.data === undefined ? '截至当前' : `读取于 ${new Date(props.data.generatedAt).toLocaleString(undefined, { timeZone: props.timeZone })}`}</span></div>
        <button type="button" className="tdai-current-link" data-tdai-focus-key="overview-current-count"
          disabled={props.data === undefined || props.projectName === undefined}
          aria-label={`当前有效记忆：${metricText(model.current.effectiveMemories)}。点击查看已审核记忆`} onClick={props.onOpenMemories}>
          <strong className="tdai-current-count">{metricText(model.current.effectiveMemories)}</strong>
          <span id="tdai-current-title" className="tdai-current-label">当前有效记忆 · 截至快照时间</span>
          <span className="tdai-current-hint">当前 scope 内已批准、未遗忘、未过期且可读的逻辑记忆；不是期间新增量或 L0 原文条数。</span>
        </button>
        <div className="tdai-current-pending"><span>当前待确认</span><strong>{metricText(model.current.candidates)}</strong>
          <button type="button" disabled={props.projectName === undefined} onClick={props.onOpenReview}>查看待确认队列</button></div>
      </section>
      <section className="tdai-panel tdai-source-panel">
        <div className="tdai-panel-head"><h3>所选期间 · 捕获来源</h3><span>{metricText(metrics.captures)} 条捕获事件</span></div>
        <p className="tdai-muted">单位：唯一采集事件；每个根事件只计一个主来源，未知与 lower_bound 保持可见。</p>
        {props.data === undefined ? <p className="tdai-muted">{overviewStatus}</p> : sourceRows === undefined
          ? <p className="tdai-muted">捕获来源分组不可用，请刷新统计。</p> : renderDimensionRows(sourceRows, 'source', 'capture')}
      </section>
    </div>

    <section className="tdai-grid tdai-stats">
      <Stat value={metricText(metrics.captures)} label="期间捕获事件" hint="按所选期间记录的唯一捕获事件数。" help="导入或无法映射到事件的历史原文不推断为已捕获。" disabled={props.data === undefined} onClick={() => props.onActivity('capture')} />
      <Stat value={metricText(metrics.sessions)} label="期间会话" hint="只统计有可观察事件且身份可识别的 session ID。" help="未知身份不会推断为完整会话总数。" disabled={props.data === undefined} />
      <Stat value={`${metricText(metrics.recallRequests)} / ${metricText(metrics.recallResults)}`} label="召回请求 / 返回" hint="请求与去重返回结果分开统计。" help="返回记忆不等于回答成功或模型实际采用。" disabled={props.data === undefined} onClick={() => props.onActivity('recall')} />
      <Stat value={`${metricText(metrics.acceptedRevisions)} / ${metricText(metrics.initialApprovals)}`} label="修订 / 首次批准" hint="两种审核事件分别计数。" help="仅按已接受修订与首次批准事件统计。" disabled={props.data === undefined} onClick={() => props.onActivity('revision')} />
      <Stat value={`${metricText(metrics.preparedInjectionEvents)} / ${metricText(metrics.preparedInjectionMemories)}`} label="准备注入事件 / 记忆" hint="只表示本地准备结果。" help="Host 实际注入回执与可比净节省当前不可用。" disabled={props.data === undefined} onClick={() => props.onActivity('injection')} />
      <Stat value={props.repeatedReady ? `${props.repeatedItems.length}${props.repeatedHasMore ? '+' : ''}` : '未知'} label="重复文本线索组" hint={props.repeatedNotice ?? (props.repeatedState === 'loading' ? '正在读取有界重复线索' : '相同表达不代表浪费。')} help="确定性相同文本指纹，不判断提问多余或可节省用量。" disabled={!props.repeatedReady} />
    </section>

    <section className="tdai-panel tdai-heatmap-panel"><div className="tdai-panel-head"><h3>{activityLabel}热图</h3><span>{props.from} 至 {props.to} · {props.timeZone}</span></div>
      {props.data === undefined ? <p className="tdai-muted">{overviewStatus}</p> : <>
        <div className="tdai-annual-heatmap"><div className="tdai-heatmap-scroll"><div className="tdai-heatmap" role="group" aria-label={`${activityLabel}每日热图`}>
          {heatmap.map((day, index) => day.date === '' ? <span className="tdai-heat-empty" key={`pad-${index}`} aria-hidden="true" /> : <button type="button"
            key={day.date} className={`tdai-heat-cell tdai-level-${heatLevel(day.value, maxActivity)} tdai-coverage-cell-${day.coverage}${!props.detailRange && props.detailDate === day.date ? ' selected' : ''}`}
            aria-label={`${day.date}：${day.countText} ${activityLabel}；${heatmapCoverageText(day.coverage)}`}
            title={`${day.date}：${day.countText} ${activityLabel}；${heatmapCoverageText(day.coverage)}`} onClick={(event) => { props.onDetailOpen(event.currentTarget); props.onDate(day.date) }} />)}
        </div></div></div>
        <div className="tdai-monthly-heatmap">
          <div className="tdai-toolbar"><button type="button" disabled={props.heatmapMonths[0] === props.heatmapMonth} onClick={() => {
            const index = props.heatmapMonths.indexOf(props.heatmapMonth); if (index > 0) props.onMonth(props.heatmapMonths[index - 1]!)
          }}>上个月</button><label className="tdai-field"><span>月份</span><select aria-label="热图月份" value={props.heatmapMonth} onChange={(event) => props.onMonth(event.currentTarget.value)}>
            {props.heatmapMonths.map((month) => <option key={month} value={month}>{month}</option>)}
          </select></label><button type="button" disabled={props.heatmapMonths.at(-1) === props.heatmapMonth} onClick={() => {
            const index = props.heatmapMonths.indexOf(props.heatmapMonth); if (index >= 0 && index < props.heatmapMonths.length - 1) props.onMonth(props.heatmapMonths[index + 1]!)
          }}>下个月</button></div>
          <div className="tdai-month-calendar" role="group" aria-label={`${props.heatmapMonth} 每日${activityLabel}热图`}>
            {['一', '二', '三', '四', '五', '六', '日'].map((weekday) => <span className="tdai-month-weekday" key={weekday}>{weekday}</span>)}
            {monthlyHeatmap.map((day, index) => day.date === '' ? <span className="tdai-month-empty" key={`month-pad-${index}`} aria-hidden="true" /> : <button type="button"
              key={day.date} disabled={!day.inRange} className={`tdai-heat-cell tdai-level-${heatLevel(day.value, maxActivity)} tdai-coverage-cell-${day.coverage}${!props.detailRange && props.detailDate === day.date ? ' selected' : ''}`}
              aria-label={`${day.date}：${day.countText} ${activityLabel}；${heatmapCoverageText(day.coverage)}`} title={`${day.date}：${day.countText} ${activityLabel}；${heatmapCoverageText(day.coverage)}`}
              onClick={(event) => { props.onDetailOpen(event.currentTarget); props.onDate(day.date) }} />)}
          </div>
        </div>
        <div className="tdai-legend"><span>记录量</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`tdai-heat-cell tdai-level-${level} tdai-coverage-cell-covered`} />)}<span>少 → 多</span></div>
        <div className="tdai-coverage-legend"><span><i className="tdai-heat-cell tdai-coverage-cell-covered" />已覆盖：0 为确认零</span><span><i className="tdai-heat-cell tdai-coverage-cell-partial" />部分覆盖：0 不代表整日为零</span><span><i className="tdai-heat-cell tdai-coverage-cell-unknown" />未知/未记录：不可视为零</span></div>
      </>}
    </section>

    <div className="tdai-grid tdai-lower">
      <section className="tdai-panel"><div className="tdai-panel-head"><h3>来源与运行维度</h3><span>{activityLabel} · 唯一事件数 · 点击分组查看明细</span></div>
        <div className="tdai-toolbar"><label className="tdai-field"><span>维度</span><select value={props.detailDimension} onChange={(event) => props.onDimensionChange(event.currentTarget.value as typeof props.detailDimension)}>
          <option value="source">来源</option><option value="agent">Agent 实例 ID</option><option value="agent_preset">Agent 预设 ID</option><option value="provider">模型提供方</option><option value="model">模型</option>
        </select></label>{props.detailValue !== '' && <button type="button" onClick={props.onClearDetail}>清除筛选：{props.detailValue}</button>}</div>
        {props.data === undefined ? <p className="tdai-muted">{overviewStatus}</p> : dimensions === undefined
          ? <p className="tdai-muted">当前活动分组不可用，请刷新统计。</p> : renderDimensionRows(dimensions, props.detailDimension)}
      </section>
      <BoundedUsagePanel data={props.data} />
    </div>

    <section className="tdai-panel"><div className="tdai-panel-head"><h3>处理状态</h3><span>当前队列与期间覆盖分开</span></div>
      <dl className="tdai-facts"><div><dt>排队中</dt><dd>{metricText(model.processing?.queued)}</dd></div><div><dt>失败或来源过期</dt><dd>{metricText(model.processing?.failed)}</dd></div>
        <div><dt>用量待核实</dt><dd>{metricText(model.processing?.uncertainUsage)}</dd></div><div><dt>最早等待</dt><dd>{oldestText}</dd></div>
        <div><dt>期间覆盖</dt><dd>{model.coverage?.status ?? '未知'} · {metricText(model.coverage?.coveredDays)} 天</dd></div>
      </dl>
    </section>

    <section className="tdai-panel"><div className="tdai-panel-head"><h3>重复文本线索</h3><span>{props.repeatedReady ? `${props.repeatedItems.length}${props.repeatedHasMore ? '+' : ''} 组` : '数量未知'}</span></div>
      {props.repeatedState === 'loading' && <p className="tdai-muted" role="status">正在读取有界重复线索…</p>}
      {props.repeatedError !== undefined && <p className="tdai-danger-text" role="alert">{props.repeatedError}</p>}
      {props.repeatedNotice !== undefined && <p className="tdai-muted" role="status">线索读取不完整：{props.repeatedNotice}</p>}
      {props.repeatedReady && props.repeatedItems.length === 0 && props.repeatedState === 'ready' && <p className="tdai-muted">已完整确认当前范围没有重复文本线索。</p>}
      <div className="tdai-list">{props.repeatedItems.slice(0, 10).map((item) => <button type="button" className="tdai-source" key={item.fingerprint}
        onClick={(event) => { props.onDetailOpen(event.currentTarget); props.onRepeatedSelect(item.fingerprint) }}>
        <span>指纹 {item.fingerprint.slice(0, 12)}</span><strong>{item.repeatCount} 次重复线索</strong></button>)}</div>
      {(props.repeatedHasMore || props.repeatedScanCursor !== undefined) && <button type="button" className="tdai-load-more" disabled={props.repeatedLoading} onClick={props.repeatedShowMore}>
        {props.repeatedLoading ? '正在继续…' : props.repeatedScanCursor !== undefined ? '继续读取' : '加载更多线索'}</button>}
    </section>

    {(props.detailDate !== '' || props.detailRange) && <section className="tdai-panel"><div className="tdai-panel-head"><h3>{props.detailRange ? `${props.from} 至 ${props.to} 事件明细` : `${props.detailDate} 事件明细`}</h3>
      <span>{({ capture: '捕获事件', recall: '召回事件', revision: '已接受修订事件', initial_approval: '首次批准事件', injection: '准备注入事件' })[props.detailActivity ?? props.activity]} · {props.detailFingerprint !== '' ? `重复指纹：${props.detailFingerprint} · ${props.detailIncludeExcerpt ? '按需显示短摘录' : '不含原文'}`
        : props.detailValue === '' ? '不含原始消息正文' : `${dimensionLabel}：${props.detailValue === '__other__' ? '其他未展开分组' : props.detailValue}`}</span>
      <button type="button" onClick={props.onClearDetail}>关闭明细</button></div>
      {props.detailError !== undefined && <p className="tdai-danger-text" role="alert">事件读取失败：{props.detailError}</p>}
      {props.detailNotice !== undefined && <p className="tdai-muted" role="status">事件读取未完成：{props.detailNotice}</p>}
      {props.detailLoading && <p className="tdai-muted" role="status">正在读取本地事件…</p>}
      {!props.detailLoading && props.detailError === undefined && props.detailNotice === undefined && (props.detailData?.events.length ?? 0) === 0 && <p className="tdai-muted">当前读取范围没有可显示事件；若结果不完整请重试。</p>}
      <div className="tdai-list">{props.detailData?.events.map((event) => <article className="tdai-memory" key={`${String(event.id)}:${String(event.eventId)}`}>
        <div className="tdai-memory-top"><code>{String(event.type)} · {event.occurredAt === undefined ? '时间未知' : new Date(Number(event.occurredAt)).toLocaleString(undefined, { timeZone: props.timeZone })}</code><span>{String(event.count ?? event.eventCount ?? 1)} 次</span></div>
        <p className="tdai-muted">{[event.source, typeof event.agentId === 'string' ? `Agent ${event.agentId}` : undefined, event.provider, event.model].filter((value) => typeof value === 'string').join(' · ') || '来源维度未知'}</p>
        {typeof event.sessionId === 'string' && <p className="tdai-muted">会话 ID：<code>{event.sessionId}</code></p>}
        {typeof event.excerpt === 'string' && <p className="tdai-detail-excerpt">{event.excerpt}{event.excerptTruncated === true ? '…' : ''}</p>}
      </article>)}</div>
      {props.detailHasMore && <button type="button" className="tdai-load-more" disabled={props.detailLoading} onClick={props.onLoadMoreDetails}>加载更多事件</button>}
    </section>}

    <p className="tdai-muted">{overviewStatus} · 未知和 lower_bound 不按 0 显示；来源、Agent、Provider、模型分列；只读统计不调用模型。</p>
  </>
}

function BoundedProcessingSummary({ data, error, loading, onRetry }: {
  data: ReadDashboardResult | undefined; error?: string; loading: boolean; onRetry: () => void
}): ReactNode {
  if (data === undefined && error !== undefined) return <div className="tdai-danger-text" role="alert">
    <span>处理摘要读取失败：{error}</span><button type="button" onClick={onRetry}>重试处理摘要</button>
  </div>
  if (data === undefined) return loading
    ? <p className="tdai-muted" role="status">正在读取当前项目处理摘要。</p>
    : <p className="tdai-muted">当前处理摘要尚未读取。</p>
  const processing = data.processing
  const oldest = processing?.oldestWaiting
  const label = oldest === undefined || oldest.state === 'unknown' ? '未知（扫描未完成且未观察到等待）'
    : oldest.state === 'none' ? '已完整确认无等待'
      : `${oldest.state === 'partial' ? '部分已读集合中的最早' : '完整集合的最早'}：${oldest.value === null ? '未知' : new Date(oldest.value).toLocaleString()}`
  return <dl className="tdai-facts">
    <div><dt>排队中</dt><dd>{metricText(processing?.queued)}</dd></div>
    <div><dt>最早等待</dt><dd>{label}</dd></div>
    <div><dt>失败或来源过期</dt><dd>{metricText(processing?.failed)}</dd></div>
    <div><dt>用量待核实</dt><dd>{metricText(processing?.uncertainUsage)}</dd></div>
    <div><dt>当前期间覆盖</dt><dd>{data.coverage?.status ?? '未知'} · {metricText(data.coverage?.coveredDays)}</dd></div>
    <div><dt>待核用量尝试</dt><dd>{metricText(data.usage?.attempts.unknownCalls)}</dd></div>
    <div><dt>实际注入回执</dt><dd>不可用</dd></div>
    <div><dt>可比净节省</dt><dd>不可计算</dd></div>
  </dl>
}

function Shell({ children }: { children: ReactNode }): ReactNode {
  const rootRef = useRef<HTMLElement>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>()
  useLayoutEffect(() => {
    if (rootRef.current === null) return
    return observeDashboardTheme(rootRef.current, setTheme)
  }, [])
  return (
    <section className="tdai-root" ref={rootRef} data-tdai-theme={theme} tabIndex={-1}>
      <style>{CSS}</style>
      {children}
    </section>
  )
}

function Stat({ value, label, hint, help, disabled = false, onClick }: {
  value: number | string
  label: string
  hint: string
  help: string
  disabled?: boolean
  onClick?: () => void
}): ReactNode {
  const formatted = typeof value === 'number' ? value.toLocaleString() : value
  return <article className="tdai-stat">
    <button type="button" className="tdai-stat-button" disabled={disabled} onClick={onClick}
      aria-label={`${label}：${formatted}。${hint}`}>
      <div className="tdai-stat-value">{formatted}</div>
      <div className="tdai-stat-label">{label}</div>
      <div className="tdai-stat-hint">{hint}</div>
    </button>
    <details className="tdai-metric-help"><summary>指标说明</summary><p>{help}</p></details>
  </article>
}

function filterMemories(memories: MemoryView[], query: string): MemoryView[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return memories
  return memories.filter((memory) => memory.content.toLowerCase().includes(needle) || memory.projectName.toLowerCase().includes(needle))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : []
}

function displayList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function formatValidStart(value: Record<string, unknown>): string {
  if (value.validFromState === 'unknown' || value.validFromBasis === 'explicit_unknown') return '明确未知'
  const precision = value.validFromPrecision
  const precisionLabel = precision === 'year' ? '年' : precision === 'month' ? '月' : precision === 'day' ? '日' :
    precision === 'minute' ? '分钟' : precision === 'second' ? '秒' : precision === 'instant' ? '时刻' : '未知'
  const raw = typeof value.validFromLabel === 'string' ? value.validFromLabel
    : typeof value.validFrom === 'number' && Number.isFinite(value.validFrom) ? new Date(value.validFrom).toLocaleString() : undefined
  if (raw === undefined) return '未知'
  if (value.validFromBasis === 'default_record_time') return `记录时间默认（${raw}）`
  return `${raw}（${precisionLabel}精度）`
}

function dateTimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

function dateTimeLocalMillis(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = new Date(value).getTime()
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function coverageLabel(value: OverviewResult['coverage']['status'] | undefined): string {
  return value === 'covered' ? '完整' : value === 'partial' ? '部分' : '未知'
}

function overviewStateText(projectKey: string, loading: boolean, error: string | undefined): string {
  if (projectKey === '') return '请选择项目后读取统计。'
  if (loading) return '统计读取中；当前数值尚未确认。'
  if (error !== undefined) return '统计读取失败；当前数值未知，不会用 0 代替。'
  return '统计尚未读取；当前数值未知。'
}

function formatOverviewTimestamp(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short', hour12: false }).format(new Date(timestamp))
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))]
}

function parseArtifactRefs(value: string): Array<{ ref: string; hash?: string; revision?: string }> {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('产物引用必须是最多 100 项的 JSON 数组')
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`第 ${index + 1} 项必须是对象`)
    const item = entry as Record<string, unknown>
    if (typeof item.ref !== 'string' || item.ref.trim() === '' || item.ref.length > 2000) throw new Error(`第 ${index + 1} 项需要有效的 ref`)
    const result: { ref: string; hash?: string; revision?: string } = { ref: item.ref.trim() }
    for (const key of ['hash', 'revision'] as const) {
      const field = item[key]
      if (field === undefined) continue
      if (typeof field !== 'string' || field.length > 500) throw new Error(`第 ${index + 1} 项的 ${key} 必须是 500 字符以内的文本`)
      if (field.trim() !== '') result[key] = field.trim()
    }
    return result
  })
}

function unwrapManagement(value: unknown): unknown {
  const record = asRecord(value)
  return Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : value
}

function monthKeys(from: string, to: string): string[] {
  const start = new Date(`${from}T12:00:00`)
  const end = new Date(`${to}T12:00:00`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return []
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12)
  const last = new Date(end.getFullYear(), end.getMonth(), 1, 12)
  const months: string[] = []
  while (cursor <= last && months.length < 14) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}

type HeatmapActivity = 'capture' | 'recall' | 'revision' | 'initial_approval' | 'injection'

function activityLabel(kind: HeatmapActivity): string {
  return kind === 'capture' ? '捕获' : kind === 'recall' ? '成功召回结果' : kind === 'initial_approval' ? '首次批准' : kind === 'injection' ? '准备注入' : '已接受修订'
}

function heatmapDayDescription(date: string, value: number, coverage: string, kind: HeatmapActivity): string {
  const coverageText = coverage === 'covered' ? '采集完整覆盖' : coverage === 'partial' ? '仅部分覆盖，存在未记录区间' : '覆盖未知或未记录'
  const countText = value > 0 ? `${value} 次已记录${activityLabel(kind)}` : coverage === 'covered'
    ? `0 次${activityLabel(kind)}` : coverage === 'partial'
      ? `当前记录为 0 次${activityLabel(kind)}，但整日可能存在未记录活动` : `${activityLabel(kind)}数量未知，不能视作 0`
  return `${date}：${countText}；${coverageText}`
}

function activityDayValue(day: OverviewResult['period']['activity'][number], kind: HeatmapActivity): number {
  return kind === 'capture' ? day.captures : kind === 'recall' ? day.recalls : kind === 'initial_approval' ? day.initialApprovals : kind === 'injection' ? day.preparedInjectionEvents : day.revisions
}

type BoundedActivityDay = NonNullable<ReadDashboardResult['activity']>[number]
type BoundedHeatmapDay = { date: string; value: number; countText: string; coverage: 'covered' | 'partial' | 'unknown' }

function boundedHeatmapDays(from: string, to: string, activity: ReadDashboardResult['activity']): BoundedHeatmapDay[] {
  const start = new Date(`${from}T12:00:00`)
  const end = new Date(`${to}T12:00:00`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return []
  const daily = new Map((activity ?? []).map((day) => [day.date, day]))
  const days: BoundedHeatmapDay[] = Array.from({ length: start.getDay() }, () => ({ date: '', value: 0, countText: '未知', coverage: 'unknown' }))
  const cursor = new Date(start)
  let count = 0
  while (cursor <= end && count < 400) {
    const date = localIsoDate(cursor)
    const item = daily.get(date)
    days.push(item === undefined
      ? { date, value: 0, countText: '未知', coverage: 'unknown' }
      : { date, value: item.count.value ?? 0, countText: metricText(item.count), coverage: item.coverage })
    cursor.setDate(cursor.getDate() + 1)
    count += 1
  }
  return days
}

function boundedMonthlyHeatmapDays(month: string, from: string, to: string,
  activity: ReadDashboardResult['activity']): Array<BoundedHeatmapDay & { inRange: boolean }> {
  const match = /^(\d{4})-(\d{2})$/u.exec(month)
  if (match === null) return []
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (monthIndex < 0 || monthIndex > 11) return []
  const fromDate = new Date(`${from}T12:00:00`)
  const toDate = new Date(`${to}T12:00:00`)
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) return []
  const daily = new Map((activity ?? []).map((day) => [day.date, day]))
  const first = new Date(year, monthIndex, 1, 12)
  const daysInMonth = new Date(year, monthIndex + 1, 0, 12).getDate()
  const leading = (first.getDay() + 6) % 7
  const cells: Array<BoundedHeatmapDay & { inRange: boolean }> = Array.from({ length: leading }, () =>
    ({ date: '', value: 0, countText: '未知', coverage: 'unknown', inRange: false }))
  for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
    const date = localIsoDate(new Date(year, monthIndex, dayNumber, 12))
    const item = daily.get(date)
    cells.push({ date, value: item?.count.value ?? 0, countText: item === undefined ? '未知' : metricText(item.count),
      coverage: item?.coverage ?? 'unknown', inRange: date >= from && date <= to })
  }
  while (cells.length % 7 !== 0) cells.push({ date: '', value: 0, countText: '未知', coverage: 'unknown', inRange: false })
  return cells
}

function heatmapCoverageText(coverage: BoundedActivityDay['coverage']): string {
  return coverage === 'covered' ? '整日覆盖；未记录代表确认零'
    : coverage === 'partial' ? '部分覆盖；未记录不代表整日为零' : '覆盖未知或未记录；不能视为零'
}

function makeHeatmapDays(from: string, to: string, activity: OverviewResult['period']['activity'], kind: HeatmapActivity): Array<{ date: string; value: number; coverage: string }> {
  const start = new Date(from + 'T12:00:00')
  const end = new Date(to + 'T12:00:00')
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return []
  const daily = new Map<string, { value: number; coverage: string }>()
  for (const day of activity) daily.set(day.date, { value: activityDayValue(day, kind), coverage: day.coverage })
  const days: Array<{ date: string; value: number; coverage: string }> = Array.from({ length: start.getDay() }, () => ({ date: '', value: 0, coverage: 'unknown' }))
  const cursor = new Date(start)
  let count = 0
  while (cursor <= end && count < 400) {
    const date = localIsoDate(cursor)
    const entry = daily.get(date)
    days.push({ date, value: entry?.value ?? 0, coverage: entry?.coverage ?? 'unknown' })
    cursor.setDate(cursor.getDate() + 1)
    count += 1
  }
  return days
}

function makeMonthlyHeatmapDays(month: string, from: string, to: string, activity: OverviewResult['period']['activity'], kind: HeatmapActivity): Array<{ date: string; value: number; coverage: string; inRange: boolean }> {
  const match = /^(\d{4})-(\d{2})$/u.exec(month)
  if (match === null) return []
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (monthIndex < 0 || monthIndex > 11) return []
  const fromDate = new Date(`${from}T12:00:00`)
  const toDate = new Date(`${to}T12:00:00`)
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) return []
  const daily = new Map(activity.map((day) => [day.date, { value: activityDayValue(day, kind), coverage: day.coverage }]))
  const first = new Date(year, monthIndex, 1, 12)
  const count = new Date(year, monthIndex + 1, 0, 12).getDate()
  const leading = (first.getDay() + 6) % 7
  const cells: Array<{ date: string; value: number; coverage: string; inRange: boolean }> = Array.from({ length: leading }, () => ({ date: '', value: 0, coverage: 'unknown', inRange: false }))
  for (let dayNumber = 1; dayNumber <= count; dayNumber += 1) {
    const date = localIsoDate(new Date(year, monthIndex, dayNumber, 12))
    const item = daily.get(date)
    cells.push({ date, value: item?.value ?? 0, coverage: item?.coverage ?? 'unknown', inRange: date >= from && date <= to })
  }
  while (cells.length % 7 !== 0) cells.push({ date: '', value: 0, coverage: 'unknown', inRange: false })
  return cells
}

function detailDimensionValues(data: OverviewResult | undefined, dimension: 'source' | 'agent' | 'agent_preset' | 'provider' | 'model'): string[] {
  if (data === undefined) return []
  if (dimension === 'source') return data.period.sources.filter((item) => !item.other).map((item) => item.source)
  if (dimension === 'agent') return data.period.agents.filter((item) => !item.other).map((item) => item.agentId)
  if (dimension === 'agent_preset') return data.period.agentPresets.filter((item) => !item.other).map((item) => item.agentPreset)
  if (dimension === 'provider') return data.period.providers.filter((item) => !item.other).map((item) => item.provider)
  return data.period.models.filter((item) => !item.other).map((item) => item.model)
}

function boundedDimensionValues(data: ReadDashboardResult | undefined,
  dimension: 'source' | 'agent' | 'agent_preset' | 'provider' | 'model', activity: HeatmapActivity): string[] | undefined {
  const model = boundedOverviewModel(data, activity)
  const selected = model.selectedDimensions
  const items = dimension === 'source' ? activity === 'capture' ? model.captureSources : selected?.sources
    : dimension === 'agent' ? selected?.agents : dimension === 'agent_preset' ? selected?.agentPresets
      : dimension === 'provider' ? selected?.providers : selected?.models
  if (items === undefined) return undefined
  const rows = items.length === 10 && items.at(-1)?.key === 'other' ? items.slice(0, -1) : items
  return rows.map((item) => item.key)
}

function jobStatusLabel(status: OverviewResult['processing']['jobs'][number]['status']): string {
  const labels: Record<OverviewResult['processing']['jobs'][number]['status'], string> = {
    queued: '排队中', ready: '待运行', dispatching: '调用中', result_ready: '结果待处理', completed: '已完成',
    failed: '失败', source_pruned: '来源已清理', uncertain_remote: '远端状态未知', blocked_charged: '已计费并阻断',
  }
  return labels[status]
}

function heatLevel(value: number, max: number): number {
  if (value <= 0) return 0
  const ratio = value / Math.max(1, max)
  return ratio <= .25 ? 1 : ratio <= .5 ? 2 : ratio <= .75 ? 3 : 4
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isoDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

function parseIsoCalendarDate(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? date : undefined
}

function formatUtcCalendarDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function shiftIsoCalendarDate(date: string, days: number): string {
  const validDate = parseIsoCalendarDate(date)
  if (validDate === undefined) throw new Error('invalid calendar date')
  const [year, month, day] = validDate.split('-').map(Number)
  return formatUtcCalendarDate(new Date(Date.UTC(year!, month! - 1, day! + days)))
}

function detailReturnTargetReady(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled, [aria-disabled="true"]') ||
      element.closest('[inert], [hidden], [aria-hidden="true"]') !== null || element.getClientRects().length === 0) return false
  const visibility = window.getComputedStyle(element).visibility
  return visibility !== 'hidden' && visibility !== 'collapse'
}

function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  for (let current = element.parentElement; current !== null && current !== document.body; current = current.parentElement) {
    const style = window.getComputedStyle(current)
    if (/(auto|scroll|overlay)/u.test(`${style.overflowY} ${style.overflow}`) && current.scrollHeight > current.clientHeight) return current
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

const LIGHT_THEME_CSS = `
  .tdai-root {
    color-scheme: light;
    --tdai-bg: #f5f3fa; --tdai-panel: #ffffff; --tdai-card: #faf9fd; --tdai-line: #ddd7e9;
    --tdai-control: #fff; --tdai-control-border: #ccc3dd; --tdai-button: #f1edfa;
    --tdai-ink: #241c34; --tdai-muted: #655b75; --tdai-accent: #6941b7; --tdai-accent-strong: #6941b7;
    --tdai-primary: #b45309; --tdai-coverage-pattern: rgba(50,35,75,.32); --tdai-coverage-outline: rgba(50,35,75,.48);
    --tdai-good: #087c69; --tdai-bad: #b42348;
    background: radial-gradient(1000px 240px at 8% -20%, rgba(139, 92, 246, .1), transparent 60%), var(--tdai-bg);
  }
  .tdai-root .tdai-memory { border-color: var(--tdai-line); background: var(--tdai-card); }
  .tdai-root .tdai-memory p, .tdai-root .tdai-profile-text, .tdai-root .tdai-facts dd { color: #342b44; }
  .tdai-root .tdai-glyph { border-color: #cfc1eb; background: #eee8fa; }
  .tdai-root .tdai-source-bar, .tdai-root .tdai-day-bar, .tdai-root .tdai-heat-cell { background: #e8e3f1; }
  .tdai-root .tdai-heat-cell.tdai-level-1 { background: #ded3f1; } .tdai-root .tdai-heat-cell.tdai-level-2 { background: #c3ade7; }
  .tdai-root .tdai-heat-cell.tdai-level-3 { background: #a285d5; } .tdai-root .tdai-heat-cell.tdai-level-4 { background: #7554b8; }
`

const CSS = `
.tdai-root {
  color-scheme: dark;
  --tdai-bg: #12111a;
  --tdai-panel: #191722;
  --tdai-card: #15131d;
  --tdai-line: #2a2637;
  --tdai-control: #15131d;
  --tdai-control-border: #332c45;
  --tdai-button: #211b31;
  --tdai-ink: #f4f1ff;
  --tdai-muted: #8f899f;
  --tdai-accent: #a78bfa;
  --tdai-accent-strong: #8b5cf6;
  --tdai-primary: #f59e0b;
  --tdai-coverage-pattern: rgba(255,255,255,.24);
  --tdai-coverage-outline: rgba(255,255,255,.4);
  --tdai-good: #5eead4;
  --tdai-bad: #fb7185;
  display: flex;
  width: 100%;
  min-width: 0;
  container-type: inline-size;
  flex-direction: column;
  gap: 14px;
  padding: 20px 22px 28px;
  border-radius: 14px;
  color: var(--tdai-ink);
  background:
    radial-gradient(1000px 240px at 8% -20%, rgba(139, 92, 246, .22), transparent 60%),
    var(--tdai-bg);
  border: 1px solid var(--tdai-line);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
.tdai-root, .tdai-root * { box-sizing: border-box; }
.tdai-root input, .tdai-root select, .tdai-root textarea, .tdai-root button { min-width: 0; }
.tdai-root :focus-visible { outline: 2px solid var(--tdai-accent); outline-offset: 2px; }
.tdai-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.tdai-header-side { display: flex; align-items: flex-end; gap: 16px; }
.tdai-nav { display: flex; gap: 5px; overflow-x: auto; padding: 0 0 4px; border-bottom: 1px solid var(--tdai-line); scrollbar-width: thin; }
.tdai-nav button { flex: 0 0 auto; padding: 7px 11px; border: 1px solid transparent; border-radius: 6px 6px 0 0; color: var(--tdai-muted); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.tdai-nav button:hover, .tdai-nav button:focus-visible { color: var(--tdai-ink); border-color: #453a62; outline: none; }
.tdai-nav button.active { color: var(--tdai-accent); border-color: var(--tdai-line); border-bottom-color: var(--tdai-panel); background: var(--tdai-panel); }
.tdai-project-picker { min-width: 230px; margin: 0; }
.tdai-project-picker select { max-width: 72%; }
.tdai-overview-controls { padding-block: 10px; }
.tdai-range-controls { flex-wrap: wrap; }
.tdai-range-controls label { display: flex; align-items: center; gap: 5px; color: var(--tdai-muted); font-size: 10px; }
.tdai-range-controls input, .tdai-range-controls select, .tdai-toolbar select { max-width: none; padding: 5px 7px; border: 1px solid var(--tdai-control-border); border-radius: 5px; background: var(--tdai-control); color: var(--tdai-ink); font: inherit; font-size: 10px; }
.tdai-range-controls > span { margin-left: auto; }
.tdai-shortcuts { display: flex; flex-wrap: wrap; gap: 4px; }
.tdai-shortcuts button { padding: 4px 7px; border: 1px solid var(--tdai-control-border); border-radius: 5px; color: var(--tdai-ink); background: var(--tdai-button); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-shortcuts button:hover, .tdai-shortcuts button:focus-visible { border-color: var(--tdai-accent); outline: none; }
.tdai-overview-hero { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 12px; min-width: 0; }
.tdai-current-primary { min-width: 0; padding: 18px 20px; border: 1px solid var(--tdai-line); border-radius: 10px; background: linear-gradient(135deg, rgba(245,158,11,.14), transparent 70%), var(--tdai-panel); }
.tdai-current-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; color: var(--tdai-muted); font-size: 10px; }
.tdai-current-link { display: flex; flex-direction: column; align-items: flex-start; width: 100%; margin-top: 8px; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; }
.tdai-current-link:disabled { cursor: default; }
.tdai-current-link:focus-visible { outline: 2px solid var(--tdai-primary); outline-offset: 5px; border-radius: 4px; }
.tdai-current-count { max-width: 100%; color: var(--tdai-primary); font-size: clamp(38px, 7vw, 68px); font-weight: 700; line-height: .98; letter-spacing: -.06em; overflow-wrap: anywhere; }
.tdai-current-label { margin-top: 7px; font-size: 14px; font-weight: 600; }
.tdai-current-hint { max-width: 58ch; margin-top: 7px; color: var(--tdai-muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; line-height: 1.5; }
.tdai-current-pending { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; margin-top: 16px; padding-top: 11px; border-top: 1px solid var(--tdai-line); color: var(--tdai-muted); font-size: 10px; }
.tdai-current-pending strong { color: var(--tdai-ink); font-size: 16px; font-weight: 600; }
.tdai-current-pending span:last-child { flex-basis: 100%; }
.tdai-metric-help { margin-top: 10px; color: var(--tdai-muted); font-size: 10px; }
.tdai-metric-help summary { width: fit-content; cursor: pointer; }
.tdai-metric-help p { margin: 6px 0 0; color: var(--tdai-muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; line-height: 1.5; }
.tdai-brand { display: flex; align-items: center; gap: 12px; }
.tdai-glyph { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid #4c3a7a; border-radius: 10px; color: var(--tdai-accent); background: #1e1930; font-size: 20px; }
.tdai-kicker { color: var(--tdai-accent); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
.tdai-kicker span { color: var(--tdai-muted); letter-spacing: .06em; }
.tdai-header h2 { margin: 2px 0 0; font-size: 22px; line-height: 1.1; letter-spacing: -.02em; }
.tdai-range { color: var(--tdai-muted); font-size: 11px; white-space: nowrap; }
.tdai-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tdai-stat { min-width: 0; padding: 14px 16px 12px; border: 1px solid var(--tdai-line); border-radius: 10px; background: linear-gradient(180deg, rgba(167,139,250,.08), transparent 70%), var(--tdai-panel); }
.tdai-stat:focus-within { border-color: var(--tdai-accent); }
.tdai-stat-button { display: block; width: 100%; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; }
.tdai-stat-button:focus-visible { outline: 2px solid var(--tdai-accent); outline-offset: 4px; border-radius: 4px; }
.tdai-stat-button:disabled { color: inherit; cursor: default; opacity: .82; }
.tdai-stat-value { color: var(--tdai-accent); font-size: clamp(26px, 4vw, 40px); line-height: 1; letter-spacing: -.04em; }
.tdai-stat-label { margin-top: 9px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.tdai-stat-hint, .tdai-muted { color: var(--tdai-muted); font-size: 11px; }
.tdai-stat-hint { margin-top: 4px; }
.tdai-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 12px; }
.tdai-grid.tdai-lower { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.tdai-panel { min-width: 0; padding: 14px 16px; border: 1px solid var(--tdai-line); border-radius: 10px; background: var(--tdai-panel); }
.tdai-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.tdai-panel-head h3 { margin: 0; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
.tdai-panel-head span { color: var(--tdai-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tdai-source { display: grid; grid-template-columns: 86px minmax(0, 1fr) 30px; align-items: center; gap: 8px; margin: 8px 0; font-size: 11px; }
.tdai-source { width: 100%; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; }
.tdai-source:hover .tdai-source-name, .tdai-source:focus-visible .tdai-source-name { color: var(--tdai-accent); }
.tdai-source-name { color: var(--tdai-muted); overflow: hidden; text-overflow: ellipsis; }
.tdai-source-bar { height: 8px; border-radius: 2px; background: #211d2d; overflow: hidden; }
.tdai-source-bar i { display: block; height: 100%; background: linear-gradient(90deg, #6d4bd8, var(--tdai-accent)); border-radius: 2px; }
.tdai-source strong { font-weight: 600; text-align: right; }
.tdai-saved { display: flex; justify-content: space-between; gap: 10px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--tdai-line); color: var(--tdai-muted); font-size: 10px; }
.tdai-saved strong { color: var(--tdai-good); font-weight: 500; }
.tdai-day-list { display: flex; flex-direction: column; gap: 6px; max-height: 265px; overflow: auto; }
.tdai-day-row { display: grid; grid-template-columns: 88px minmax(30px, 1fr) 38px 70px; align-items: center; gap: 8px; font-size: 10px; }
.tdai-day-row time { color: var(--tdai-muted); }
.tdai-day-row strong { text-align: right; }
.tdai-day-bar { height: 7px; border-radius: 99px; background: #211d2d; overflow: hidden; }
.tdai-day-bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6d4bd8, var(--tdai-accent)); }
.tdai-coverage { text-align: right; color: var(--tdai-muted); }
.tdai-coverage-covered { color: var(--tdai-good); }
.tdai-coverage-partial { color: #fbbf24; }
.tdai-coverage-unknown { color: var(--tdai-muted); }
.tdai-heat { overflow: hidden; }
.tdai-heat-body { display: flex; gap: 5px; }
.tdai-weekdays { display: grid; grid-template-rows: repeat(7, 10px); gap: 3px; padding-top: 15px; color: var(--tdai-muted); font-size: 7px; line-height: 10px; }
.tdai-heat-weeks { display: flex; gap: 3px; flex: 1; min-width: 0; }
.tdai-heat-col { display: grid; grid-template-rows: repeat(7, 10px); gap: 3px; flex: 1; min-width: 0; }
.tdai-months { display: grid; gap: 3px; margin-left: 17px; margin-bottom: 3px; color: var(--tdai-muted); font-size: 8px; }
.tdai-months span { overflow: visible; white-space: nowrap; }
.tdai-cell { display: block; width: 100%; min-width: 3px; height: 10px; border-radius: 2px; background: #211d2d; }
.tdai-level-1 { background: #3b2e58; }
.tdai-level-2 { background: #58408f; }
.tdai-level-3 { background: #7c5cce; }
.tdai-level-4 { background: #b59cff; }
.tdai-legend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 8px; color: var(--tdai-muted); font-size: 9px; }
.tdai-legend .tdai-cell { width: 9px; height: 9px; }
.tdai-coverage-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 8px; color: var(--tdai-muted); font-size: 9px; }
.tdai-coverage-legend span { display: inline-flex; align-items: center; gap: 5px; }
.tdai-coverage-legend .tdai-heat-cell { flex: 0 0 auto; }
.tdai-heatmap-panel { container-type: inline-size; }
.tdai-monthly-heatmap { display: none; }
.tdai-month-calendar { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
.tdai-month-weekday { color: var(--tdai-muted); font-size: 10px; text-align: center; }
.tdai-month-empty { aspect-ratio: 1; }
.tdai-month-calendar .tdai-heat-cell { width: 100%; height: auto; aspect-ratio: 1; border-radius: 5px; }
.tdai-month-calendar .tdai-heat-cell:disabled { opacity: .28; cursor: default; }
.tdai-heatmap-scroll { overflow-x: auto; padding: 2px 1px 8px; scrollbar-width: thin; }
.tdai-heatmap { display: grid; grid-template-rows: repeat(7, 11px); grid-auto-columns: 11px; grid-auto-flow: column; gap: 3px; width: max-content; min-width: 100%; }
.tdai-heat-empty { width: 11px; height: 11px; }
.tdai-heat-cell { display: block; width: 11px; height: 11px; padding: 0; border: 0; border-radius: 2px; background: #211d2d; }
.tdai-heat-cell.tdai-level-1 { background: #3b2e58; } .tdai-heat-cell.tdai-level-2 { background: #58408f; }
.tdai-heat-cell.tdai-level-3 { background: #7c5cce; } .tdai-heat-cell.tdai-level-4 { background: #b59cff; }
.tdai-heat-cell.tdai-coverage-cell-partial { background-image: repeating-linear-gradient(135deg, transparent 0 2px, var(--tdai-coverage-pattern) 2px 4px); }
.tdai-heat-cell.tdai-coverage-cell-unknown { background-image: repeating-linear-gradient(135deg, transparent 0 2px, var(--tdai-coverage-pattern) 2px 4px); box-shadow: inset 0 0 0 1px var(--tdai-coverage-outline); }
button.tdai-heat-cell { cursor: pointer; }
.tdai-heat-cell:hover, .tdai-heat-cell:focus-visible, .tdai-heat-cell.selected { outline: 2px solid var(--tdai-accent); outline-offset: 1px; }
.tdai-dimension-groups { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.tdai-dimension-groups button { display: flex; align-items: center; gap: 10px; padding: 6px 9px; border: 1px solid var(--tdai-control-border); border-radius: 7px; color: var(--tdai-muted); background: var(--tdai-card); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-dimension-groups button.selected, .tdai-dimension-groups button:hover { color: var(--tdai-ink); border-color: var(--tdai-accent); }
.tdai-dimension-groups strong { color: var(--tdai-accent); }
.tdai-list { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow: auto; padding-right: 2px; }
.tdai-memory { padding: 10px 11px; border: 1px solid #272235; border-radius: 8px; background: #15131d; }
.tdai-memory p { margin: 6px 0 8px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; line-height: 1.55; color: #ddd8ed; }
.tdai-memory-top { display: flex; justify-content: space-between; gap: 10px; color: var(--tdai-muted); font-size: 9px; }
.tdai-memory-top code { color: #b7a6ea; }
.tdai-memory-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tdai-pill { padding: 1px 6px; border: 1px solid #332c45; border-radius: 99px; color: var(--tdai-muted); font-size: 9px; }
.tdai-memory-actions button, .tdai-toolbar button, .tdai-error button { margin-left: auto; padding: 3px 9px; border: 1px solid var(--tdai-control-border); border-radius: 5px; background: var(--tdai-button); color: var(--tdai-ink); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-memory-actions button + button { margin-left: 0; }
.tdai-memory-actions button:hover, .tdai-toolbar button:hover { border-color: var(--tdai-accent); }
.tdai-memory-actions button:disabled, .tdai-toolbar button:disabled { opacity: .45; cursor: default; }
.tdai-danger { color: var(--tdai-bad) !important; border-color: #5b2b3a !important; }
.tdai-field, .tdai-check { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 8px 0; color: var(--tdai-muted); font-size: 11px; }
.tdai-field select, .tdai-field input, .tdai-toolbar input { max-width: 62%; padding: 5px 7px; border: 1px solid var(--tdai-control-border); border-radius: 5px; background: var(--tdai-control); color: var(--tdai-ink); font: inherit; font-size: 10px; }
.tdai-field input[type="number"] { width: 92px; text-align: right; }
.tdai-check { justify-content: flex-start; }
.tdai-check input { accent-color: var(--tdai-accent-strong); }
.tdai-notice { margin: 10px 0 0; color: var(--tdai-good); font-size: 10px; }
.tdai-form-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; }
.tdai-form-grid > .tdai-panel-head { grid-column: 1 / -1; }
.tdai-field textarea { flex: 1; max-width: 72%; min-height: 56px; padding: 7px; resize: vertical; border: 1px solid var(--tdai-control-border); border-radius: 5px; color: var(--tdai-ink); background: var(--tdai-control); font: inherit; font-size: 11px; }
.tdai-form-grid > button { justify-self: start; padding: 6px 10px; border: 1px solid var(--tdai-control-border); border-radius: 5px; color: var(--tdai-ink); background: var(--tdai-button); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-form-grid > button:disabled { opacity: .5; }
.tdai-result { border-top: 1px solid var(--tdai-line); padding-top: 8px; color: var(--tdai-muted); font-size: 10px; }
.tdai-result pre { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--tdai-ink); }
.tdai-detail-block { margin-top: 10px; padding: 10px; border-left: 2px solid var(--tdai-accent); background: var(--tdai-control); overflow-wrap: anywhere; }
.tdai-detail-block h4 { margin: 10px 0 4px; font-size: 12px; }
.tdai-detail-excerpt { padding-left: 8px; border-left: 2px solid var(--tdai-accent); white-space: pre-wrap; overflow-wrap: anywhere; }
.tdai-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 0 0 12px; }
.tdai-facts div { min-width: 0; }
.tdai-facts dt { color: var(--tdai-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; }
.tdai-facts dd { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ddd8ed; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; }
.tdai-danger-text { color: var(--tdai-bad) !important; }
.tdai-good-text { color: var(--tdai-good) !important; }
.tdai-toolbar { display: flex; gap: 6px; align-items: center; }
.tdai-toolbar input { flex: 1; max-width: none; }
.tdai-toolbar button { margin-left: 0; white-space: nowrap; }
.tdai-profile-head { display: flex; align-items: center; gap: 10px; }
.tdai-profile-head button { padding: 3px 9px; border: 1px solid var(--tdai-control-border); border-radius: 5px; background: var(--tdai-button); color: var(--tdai-ink); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-profile-head button:disabled { opacity: .45; cursor: default; }
.tdai-load-more { align-self: flex-start; margin-top: 10px; padding: 6px 10px; border: 1px solid var(--tdai-control-border); border-radius: 5px; background: var(--tdai-button); color: var(--tdai-ink); font: inherit; font-size: 10px; cursor: pointer; }
.tdai-load-more:focus-visible, .tdai-memory-actions button:focus-visible, .tdai-toolbar button:focus-visible { outline: 2px solid var(--tdai-accent); outline-offset: 2px; }
.tdai-profile-body { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 12px; align-items: start; }
.tdai-profile-meta { color: var(--tdai-muted); font-size: 10px; line-height: 1.5; }
.tdai-profile-text { margin: 0; max-height: 170px; overflow: auto; color: #ddd8ed; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
.tdai-scenes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.tdai-scene { padding: 2px 7px; border: 1px solid #332c45; border-radius: 4px; color: var(--tdai-muted); font-size: 9px; }
.tdai-scene b { color: var(--tdai-accent); font-weight: 500; }
@container (max-width: 700px) { .tdai-profile-body { grid-template-columns: 1fr; } }
${LIGHT_THEME_CSS.replaceAll('.tdai-root', '.tdai-root[data-tdai-theme="light"]')}
@media (prefers-color-scheme: light) {
${LIGHT_THEME_CSS.replaceAll('.tdai-root', '.tdai-root:not([data-tdai-theme])')}
}
@container (max-width: 600px) {
  .tdai-root { padding: 14px 12px 20px; }
  .tdai-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tdai-header, .tdai-header-side { align-items: flex-start; flex-direction: column; width: 100%; }
  .tdai-project-picker { width: 100%; min-width: 0; }
  .tdai-panel-head { align-items: flex-start; flex-direction: column; gap: 5px; }
}
.tdai-loading, .tdai-error { padding: 42px 8px; color: var(--tdai-muted); font-size: 12px; text-align: center; }
.tdai-error button { margin-top: 10px; }
@container (max-width: 900px) {
  .tdai-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tdai-grid, .tdai-grid.tdai-lower { grid-template-columns: minmax(0, 1fr); }
  .tdai-header { align-items: flex-start; flex-direction: column; }
  .tdai-header-side { align-items: flex-start; flex-direction: column; width: 100%; }
  .tdai-project-picker { width: 100%; }
}
@container (max-width: 760px) { .tdai-overview-hero { grid-template-columns: minmax(0, 1fr); } }
@container (max-width: 520px) {
  .tdai-annual-heatmap { display: none; }
  .tdai-monthly-heatmap { display: block; }
  .tdai-root { padding: 14px 12px 20px; }
  .tdai-stats { grid-template-columns: minmax(0, 1fr); }
  .tdai-toolbar, .tdai-range-controls { align-items: stretch; flex-direction: column; }
  .tdai-range-controls > span { margin-left: 0; }
  .tdai-day-row { grid-template-columns: 72px minmax(24px, 1fr) 28px 56px; gap: 5px; font-size: 9px; }
  .tdai-field textarea { max-width: 100%; }
  .tdai-form-grid .tdai-field { align-items: stretch; flex-direction: column; }
  .tdai-form-grid .tdai-field input, .tdai-form-grid .tdai-field select, .tdai-form-grid .tdai-field textarea { max-width: 100%; width: 100%; }
}
`

/** Demo v7's normal Settings surface. No project selector or legacy management navigation. */
function MemoryV7(props: DashboardProps & Required<Pick<DashboardActions, 'readDashboard' | 'updateSettingsAck' | 'manage'>>): ReactNode {
  const [view, setView] = useState<'home' | 'library'>('home')
  const [layer, setLayer] = useState<GlobalMemoryItem['layer']>('L1')
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>()
  const [relatedScan, setRelatedScan] = useState<{ key: string; token: string } | undefined>()
  const [related, setRelated] = useState<{ items: GlobalMemoryItem[]; complete: boolean; next?: string } | undefined>()
  const [relatedError, setRelatedError] = useState('')
  const [scene, setScene] = useState<{ projectKey: string; name: string } | undefined>()
  const [scan, setScan] = useState<{ filter: string; token: string } | undefined>()
  const [data, setData] = useState<GlobalMemoryPage | undefined>()
  const [detail, setDetail] = useState<GlobalMemoryItem | undefined>()
  const [settings, setSettings] = useState(false), [confirm, setConfirm] = useState(false)
  const [switches, setSwitches] = useState<{ generateMemory: boolean; useMemory: boolean } | undefined>()
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [complete, setComplete] = useState(false), [error, setError] = useState('')
  const [revision, setRevision] = useState(0), [page, setPage] = useState(0)
  const [day, setDay] = useState<{ cell: MemoryDay; index: number } | undefined>()
  const [settingsFailed, setSettingsFailed] = useState(false)
  const loadedScope = useRef<{ filter: string; transport: DashboardActions['readDashboard'] } | undefined>()
  const settingsMutation = useRef<ReturnType<typeof createMemorySettingsMutation> | undefined>()
  const savingNow = useRef(false)
  const [theme, setTheme] = useState<'light' | 'dark' | undefined>()
  const root = useRef<HTMLElement | null>(null), returnKey = useRef<string | undefined>()
  const mounted = useRef(true), mutation = useRef(0)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const year = new Date().getFullYear()
  const scanFilter = JSON.stringify([view, layer, search, scene, revision, year, zone])
  const contentFilter = JSON.stringify([view, layer, search, scene, year, zone])
  useLayoutEffect(() => {
    if (root.current === null) return
    return observeDashboardTheme(root.current, setTheme)
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current += 1 } }, [])
  useEffect(() => {
    const controller = createMemorySettingsMutation({ readDashboard: props.readDashboard, updateSettingsAck: props.updateSettingsAck })
    settingsMutation.current = controller; savingNow.current = false; setSaving(false); setSettingsFailed(false)
    setSwitches(undefined)
    return () => { controller.dispose(); settingsMutation.current = undefined; mutation.current += 1; savingNow.current = false }
  }, [props.readDashboard, props.updateSettingsAck])
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(0) }, 200); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    let cancelled = false
    const readMutation = mutation.current
    setLoading(true); setError(''); setDetail(undefined); setDay(undefined); setPage(0)
    // Retain the same view during refresh; a different scope/transport never displays old records.
    if (loadedScope.current?.filter !== contentFilter || loadedScope.current?.transport !== props.readDashboard) setData(undefined)
    void readGlobalMemory(props.readDashboard, { version: 1, action: 'global', layer: view === 'home' ? 'home' : layer,
      query: view === 'home' ? '' : search, year, timeZone: zone, ...(scan?.filter === scanFilter ? { resume: scan.token } : {}), ...(view === 'library' && scene ? { scene } : {}) }, () => cancelled)
      .then((result) => {
        if (cancelled || readMutation !== mutation.current || !result?.global) return
        setData(result.global); loadedScope.current = { filter: contentFilter, transport: props.readDashboard }
        if (!savingNow.current && !settingsMutation.current?.hasFailed()) setSwitches({ generateMemory: result.global.generateMemory, useMemory: result.global.useMemory })
        setComplete(result.complete); setLoading(false)
      }).catch(() => { if (!cancelled && readMutation === mutation.current) { setData(undefined); setLoading(false); setError('读取未完成，请重试。') } })
    return () => { cancelled = true }
  }, [props.readDashboard, props.updateSettingsAck, view, layer, search, scene, revision, year, zone, scan, scanFilter, contentFilter])
  useEffect(() => {
    let cancelled = false
    setRelated(undefined); setRelatedError('')
    const item = data?.items.find((row) => row.key === expanded && row.layer === 'L2')
    if (!item) setRelatedScan(undefined)
    if (item) void readGlobalMemory(props.readDashboard, { version: 1, action: 'global', layer: 'L1', query: '',
      year, timeZone: zone, ...(relatedScan?.key === item.key ? { resume: relatedScan.token } : {}), scene: { projectKey: item.projectKey, name: item.scene ?? item.id } }, () => cancelled)
      .then((answer) => { if (!cancelled && answer?.global) setRelated({ items: answer.global.items, complete: answer.complete, next: answer.global.next }) })
      .catch(() => { if (!cancelled) setRelatedError('关联记忆读取未完成') })
    return () => { cancelled = true }
  }, [expanded, data, props.readDashboard, year, zone, relatedScan])
  useLayoutEffect(() => {
    if (detail || returnKey.current === undefined) return
    const key = returnKey.current; returnKey.current = undefined
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-memory-key]') ?? [])].find((element) => element.dataset.memoryKey === key)
    ;(target ?? root.current)?.focus({ preventScroll: true })
  }, [detail])
  const open = (item: GlobalMemoryItem): void => { returnKey.current = item.key; setConfirm(false); setDetail(item); setError('') }
  const library = (next: GlobalMemoryItem['layer']): void => {
    setExpanded(undefined); setScene(undefined); setQuery(''); setSearch(''); setLayer(next); setView('library'); setDetail(undefined)
  }
  const saveSwitch = async (key?: 'generateMemory' | 'useMemory'): Promise<void> => {
    const controller = settingsMutation.current
    if (!controller || savingNow.current || key !== undefined && (loading || !switches || controller.hasFailed())) return
    const token = ++mutation.current
    savingNow.current = true; setSaving(true); setError('')
    try {
      const outcome = await (key === undefined ? controller.retry() : controller.save(
        key === 'generateMemory' ? { generateMemory: !switches!.generateMemory } : { useMemory: !switches!.useMemory }))
      if (!mounted.current || token !== mutation.current || controller !== settingsMutation.current) return
      if (outcome.kind === 'saved') {
        setSwitches(outcome.settings)
        setData((old) => old ? { ...old, generateMemory: outcome.settings.generateMemory, useMemory: outcome.settings.useMemory } : old)
      }
      setSettingsFailed(controller.hasFailed())
    } finally {
      if (mounted.current && token === mutation.current && controller === settingsMutation.current) {
        mutation.current += 1 // Read responses issued before the confirmed save cannot restore old switches.
        savingNow.current = false; setSaving(false); setRevision((n) => n + 1)
      }
    }
  }
  const forget = async (): Promise<void> => {
    if (!detail || detail.layer !== 'L1' || savingNow.current) return
    const token = ++mutation.current
    savingNow.current = true; setSaving(true); setError('')
    try {
      const answer = await props.manage({ projectKey: detail.projectKey, operation: 'v7.forget',
        payload: { layer: detail.layer, id: detail.id, updatedAt: detail.updatedAt, confirmed: true } }) as { data?: { applied?: boolean }; applied?: boolean }
      if ((answer.data ?? answer).applied !== true) throw new Error('not confirmed')
      if (mounted.current && token === mutation.current) { setDetail(undefined); setConfirm(false); setRevision((n) => n + 1) }
    } catch { if (mounted.current && token === mutation.current) setError('遗忘未确认完成，请重试。已生效的遗忘不会回滚。') }
    finally { if (mounted.current && token === mutation.current) { savingNow.current = false; setSaving(false) } }
  }
  const validDate = (at?: number): Date | undefined => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000 ? new Date(at) : undefined
  const dateText = (at?: number): string => validDate(at)?.toLocaleString() ?? '时间不可用'
  const title = (item: GlobalMemoryItem): string => item.layer === 'L2' ? item.scene ?? item.id : item.content.trim().split('\n')[0]?.slice(0, 90) || '无正文'
  const layerNames = { L0: '原始对话', L1: '提炼记忆', L2: '场景索引', L3: '画像' }
  const pauseLabels = { generation_disabled: '自动生成已关闭', capture_disabled: '对话采集已关闭',
    extraction_disabled: '提炼已关闭' }
  const pauseText = data?.pauseReasons?.map((reason) => pauseLabels[reason]).join('；')
  const calendar = memoryYear(year, zone, data?.days ?? [], data?.activityComplete ?? false)
  const dayTip = day && memoryDayPresentation(day.cell, day.index, calendar.firstWeekday, calendar.weeks)
  const rows = (items: GlobalMemoryItem[]): ReactNode => <div className="mv7-rows">{items.map((item) =>
    <div key={`${item.layer}:${item.key}`}>
    <button type="button" data-memory-key={item.key} className="mv7-row" aria-expanded={item.layer === 'L2' ? expanded === item.key : undefined}
      disabled={loading} onClick={() => item.layer === 'L2' ? setExpanded((old) => old === item.key ? undefined : item.key) : open(item)}>
      <span className="mv7-row-icon" aria-hidden="true">{item.layer === 'L0' ? '◌' : item.layer === 'L2' ? '▱' : '◇'}</span>
      <span className="mv7-row-text"><strong>{title(item)}</strong><small>{item.content.replace(/\s+/g, ' ').slice(0, 160)}</small></span>
      <time dateTime={validDate(item.updatedAt)?.toISOString()}>{validDate(item.updatedAt)?.toLocaleDateString() ?? '时间不可用'}</time><span aria-hidden="true">›</span>
    </button>
    {item.layer === 'L2' && expanded === item.key && <div className="mv7-inline" role="region" aria-label={`${title(item)}关联记忆`}>
      <p>{item.content}</p>{relatedError ? <p role="alert">{relatedError}</p> : related ? <>{rows(related.items)}
        {!related.complete && <p className="mv7-muted">关联记忆已读取部分。</p>}{related.next && <button type="button" onClick={() => setRelatedScan({ key: item.key, token: related.next! })}>继续读取关联记忆</button>}</> : <p role="status">正在读取关联记忆…</p>}
    </div>}</div>)}</div>
  return <section className="tdai-root mv7" ref={root} onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); setConfirm(false); setDay(undefined); setExpanded(undefined)
      if (detail) setDetail(undefined); else if (query) { setQuery(''); setSearch('') } else setSettings(false)
    }} data-tdai-theme={theme} tabIndex={-1} aria-label="全局记忆" aria-busy={loading}>
    <style>{MEMORY_V7_CSS}</style>
    {detail ? <>
      <button type="button" className="mv7-back" onClick={() => { setDetail(undefined); setConfirm(false) }}>‹ 返回{view === 'home' ? '首页' : '记忆库'}</button>
      <h2>{title(detail)}</h2><p className="mv7-muted">{detail.layer} · {dateText(detail.updatedAt)} 更新</p>
      <div className="mv7-body">{detail.content}</div>
      <details className="mv7-sources"><summary>来源与更新</summary>
        <p>来源项目：{detail.projectKey}（来源标识）</p><p>更新于：{dateText(detail.updatedAt)}</p>
        {detail.sources.map((source) => <p key={source.id}>会话：{source.sessionId ?? '不可用'}<br />来源：{source.id}<br />时间：{dateText(source.createdAt)}</p>)}
        {!detail.sourcesComplete && <p className="mv7-muted">来源信息不完整；缺失的会话名称或时间不会推测补全。</p>}
      </details>
      {detail.layer === 'L1' && (!confirm ? <button type="button" className="mv7-forget" onClick={() => setConfirm(true)}>遗忘</button> : <div className="mv7-confirm" role="group" aria-label="确认遗忘">
        <p>确认遗忘这条记忆？之后的对话不再使用这些内容，相关派生内容也会失效。</p>
        <button type="button" disabled={saving} onClick={() => void forget()}>确认遗忘</button><button type="button" disabled={saving} onClick={() => setConfirm(false)}>取消</button>
      </div>)}
    </> : view === 'home' ? <>
      <header className="mv7-header"><h2>全局记忆</h2><button type="button" aria-label="记忆设置" aria-expanded={settings} onClick={() => setSettings((old) => !old)}>⚙</button></header>
      {settings && <div className="mv7-settings">
        {(['generateMemory', 'useMemory'] as const).map((key) => <label key={key}><span>{key === 'generateMemory' ? '自动生成记忆' : '在对话中使用记忆'}</span>
          <button type="button" role="switch" aria-checked={switches?.[key] ?? false} aria-label={key === 'generateMemory' ? '自动生成记忆' : '在对话中使用记忆'} disabled={!data || loading || saving || settingsFailed} onClick={() => void saveSwitch(key)}><span /></button></label>)}
        <p className="mv7-muted">不设插件每日配额；按相关性召回，提炼调用仍记录实际用量。</p>
      </div>}
      <div className="mv7-status"><span>{loading ? '正在读取…' : !data ? '状态不可用' : !data.generateMemory ? '自动记忆已关闭' : data.paused ? '自动记忆已暂停' : '自动记忆已启用'}</span><button type="button" onClick={() => library('L1')}>查看全部 ›</button></div>
      {pauseText && <p className="mv7-pause" role="status">{pauseText} <button type="button" onClick={() => setSettings(true)}>查看设置</button></p>}
      <div className="mv7-stats">{(['L0', 'L1', 'L2', 'L3'] as const).map((key) => <button type="button" key={key} onClick={() => library(key)}><span>{key} {layerNames[key]}</span><strong>{memoryMetric(data?.counts[key])}<small>{key === 'L2' ? '组' : key === 'L3' ? '份' : '条'}</small></strong></button>)}</div>
      <div className="mv7-activity"><div className="mv7-header"><h3>记忆活动</h3><span className="mv7-muted">{year} 年</span></div>
        <div className="mv7-heatmap-stage">
          {dayTip && <div className="mv7-tooltip" role="tooltip" data-edge={dayTip.edge} style={{ left: `${dayTip.x}%` }}>{dayTip.text}</div>}
          <div className="mv7-calendar" style={{ gridTemplateColumns: `repeat(${calendar.weeks}, minmax(0, 1fr))` }} role="group" aria-label="全年新增与更新的记忆记录">
            {calendar.grid.map((cell, slot) => {
              if (cell === null) return <span key={`pad-${slot}`} aria-hidden="true" data-padding="true" />
              const index = slot - calendar.firstWeekday
              const presentation = memoryDayPresentation(cell, index, calendar.firstWeekday, calendar.weeks)
              return <button key={cell.date} type="button" disabled={cell.future} data-day={cell.date}
                data-level={presentation.level} data-unknown={!cell.known} aria-label={presentation.text}
                onMouseEnter={() => setDay({ cell, index })} onMouseLeave={() => setDay(undefined)} onFocus={() => setDay({ cell, index })} onBlur={() => setDay(undefined)} onClick={() => setDay({ cell, index })}
                onKeyDown={(event) => { const delta = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[event.key]; if (delta === undefined) return; event.preventDefault();
                  const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-day]') ?? [])], position = buttons.indexOf(event.currentTarget)
                  buttons[Math.max(0, Math.min(buttons.length - 1, position + delta))]?.focus() }} />
            })}
          </div>
        </div>
        <div className="mv7-months" style={{ gridTemplateColumns: `repeat(${calendar.weeks}, minmax(0, 1fr))` }} aria-hidden="true">{calendar.months.map((month) => <span key={month.month} style={{ gridColumn: `${month.column} / span ${month.span}` }}>{month.month}月</span>)}</div>
        <p className="mv7-muted">近 30 天新增 {memoryMetric(data?.recentAdded)} 条</p>
      </div>
      <details className="mv7-recent"><summary>最近活动</summary>{data?.items.length ? rows(data.items) : <p className="mv7-muted">{loading ? '正在读取…' : complete ? '暂无记忆活动' : '尚无可确认的活动'}</p>}</details>
    </> : <>
      <button type="button" className="mv7-back" onClick={() => { setView('home'); setScene(undefined); setQuery(''); setSearch('') }}>‹ 返回首页</button>
      <header className="mv7-header"><h2>记忆库</h2><span className="mv7-muted">全局共享</span></header>
      <div className="mv7-tabs" role="tablist" aria-label="记忆层级">{(['L0', 'L1', 'L2', 'L3'] as const).map((key) => <button type="button" key={key} role="tab" aria-selected={key === layer} onClick={() => library(key)}>{key} {layerNames[key]}</button>)}</div>
      <div className="mv7-search-wrap"><input className="mv7-search" aria-label="搜索记忆" type="search" placeholder="搜索记忆…" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); setSearch(''); root.current?.querySelector<HTMLInputElement>('.mv7-search')?.focus() }}>×</button>}</div>
      {scene && <p className="mv7-muted">场景：{scene.name} <button type="button" onClick={() => setScene(undefined)}>查看全部</button></p>}
      <p className="mv7-muted">{memoryMetric(data?.counts[layer])} {layerNames[layer]}</p>
      {loading && <p className="mv7-loading" role="status">正在读取…</p>}
      {data?.items.length ? rows(data.items.slice(page * 12, page * 12 + 12)) : !loading && !error && <p>{search ? complete ? '没有匹配结果' : '已读取部分没有匹配结果' : complete ? '暂无记录' : '尚无可确认的记录'}</p>}
      {data && data.items.length > 12 && <nav className="mv7-pagination" aria-label="列表分页"><button type="button" disabled={page === 0} onClick={() => setPage((old) => old - 1)}>上一页</button><span>{page + 1} / {Math.ceil(data.items.length / 12)}</span><button type="button" disabled={(page + 1) * 12 >= data.items.length} onClick={() => setPage((old) => old + 1)}>下一页</button></nav>}
    </>}
    {!loading && data && !complete && !detail && <p className="mv7-muted" role="status">当前为部分结果；来源、可读性或本批读取范围尚不足以证明全部结果。</p>}
    {!loading && data?.next && !detail && <button type="button" onClick={() => setScan({ filter: scanFilter, token: data.next! })}>继续读取下一批</button>}
    {settingsFailed && <div className="mv7-error" role="alert">设置尚未确认保存，当前设置保持已确认值。<button type="button" disabled={saving} onClick={() => void saveSwitch()}>重试保存</button></div>}
    {error && <div className="mv7-error" role="alert">{error} <button type="button" disabled={saving} onClick={() => setRevision((old) => old + 1)}>重新读取</button></div>}
  </section>
}

const MEMORY_V7_CSS = `
.mv7{container-type:inline-size;container-name:memory-v7;--mv-bg:#222323;--mv-panel:#2a2b2d;--mv-text:#f0f1f2;--mv-muted:#a2a6ae;--mv-line:#3c3e41;--mv-accent:#8b9ffd;--mv-cell:#303236;color:var(--mv-text);background:var(--mv-bg);height:clamp(360px,calc(100dvh - 180px),760px);width:100%;max-width:none;min-width:0;box-sizing:border-box;padding:20px 22px;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;line-height:1.55;font:inherit;color-scheme:dark;}
.mv7[data-tdai-theme="light"]{--mv-bg:#fff;--mv-panel:#f3f4f6;--mv-text:#20242a;--mv-muted:#626b78;--mv-line:#e1e4e8;--mv-accent:#5265d0;--mv-cell:#f3f4f5;color-scheme:light;}
@media(prefers-color-scheme:light){.mv7:not([data-tdai-theme]){--mv-bg:#fff;--mv-panel:#f3f4f6;--mv-text:#20242a;--mv-muted:#626b78;--mv-line:#e1e4e8;--mv-accent:#5265d0;--mv-cell:#f3f4f5;color-scheme:light;}}
.mv7 *{box-sizing:border-box;min-width:0}.mv7 h2{font-size:20px;font-weight:500;margin:0 0 10px;overflow-wrap:anywhere}.mv7 h3{font-size:14px;font-weight:500;margin:0}.mv7 button{font:inherit;color:inherit;background:transparent;border:0;border-radius:5px;cursor:pointer;padding:6px 8px}.mv7 button:disabled{cursor:default;opacity:.45}.mv7 :focus-visible{outline:2px solid var(--mv-accent);outline-offset:3px}.mv7-header,.mv7-status{display:flex;align-items:center;justify-content:space-between;gap:12px}.mv7-header{margin-bottom:16px}.mv7-header h2{margin:0}.mv7-muted,.mv7-status{color:var(--mv-muted);font-size:12px}.mv7-status{margin:24px 0 20px}.mv7-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:24px}.mv7-stats>button{text-align:left;border-radius:0;padding:0 14px;border-right:1px solid var(--mv-line)}.mv7-stats>button:first-child{padding-left:0}.mv7-stats>button:last-child{border:0}.mv7-stats span{font-size:11px;color:var(--mv-muted);display:block;white-space:nowrap}.mv7-stats strong{font-size:28px;font-weight:400;display:block;margin-top:8px;font-variant-numeric:tabular-nums}.mv7-stats small{font-size:10px;margin-left:3px}.mv7-activity{padding:20px 0;border-top:1px solid var(--mv-line)}.mv7-heatmap-stage{position:relative;margin-top:28px}.mv7-calendar{display:grid;grid-template-rows:repeat(7,minmax(0,1fr));grid-auto-flow:column;gap:3px;width:100%}.mv7-calendar button,.mv7-calendar>span{aspect-ratio:1;padding:0;border-radius:2px;min-height:0;min-width:0;width:100%;background:var(--dsw-alias-bg-skeleton,var(--mv-cell))}.mv7-calendar>span{background:var(--mv-cell);opacity:.65}
.mv7-calendar{--mv-particle:var(--dsw-alias-state-business-primary,#0f766e)}
.mv7-calendar button[data-level="1"]{background:color-mix(in srgb,var(--mv-particle) 20%,var(--mv-bg));background:oklch(from var(--mv-particle) .89 calc(c * .35) h)}
.mv7-calendar button[data-level="2"]{background:color-mix(in srgb,var(--mv-particle) 40%,var(--mv-bg));background:oklch(from var(--mv-particle) .78 calc(c * .55) h)}
.mv7-calendar button[data-level="3"]{background:color-mix(in srgb,var(--mv-particle) 60%,var(--mv-bg));background:oklch(from var(--mv-particle) .67 calc(c * .75) h)}
.mv7-calendar button[data-level="4"]{background:color-mix(in srgb,var(--mv-particle) 80%,var(--mv-bg));background:oklch(from var(--mv-particle) .56 calc(c * .9) h)}
.mv7-calendar button[data-level="5"]{background:var(--mv-particle);background:oklch(from var(--mv-particle) .45 c h)}
.mv7-calendar button[data-unknown="true"][data-level="0"]{background:repeating-linear-gradient(135deg,var(--mv-cell),var(--mv-cell) 2px,var(--mv-line) 2px,var(--mv-line) 3px);box-shadow:inset 0 0 0 1px var(--mv-line)}
.mv7-months{display:grid;gap:3px;color:var(--mv-muted);font-size:9px;line-height:14px;margin-top:7px}.mv7-months span{overflow:hidden;white-space:nowrap}
.mv7-tooltip{position:absolute;z-index:2;bottom:calc(100% + 6px);left:50%!important;width:calc(100% - 8px);max-width:480px;min-height:46px;transform:translateX(-50%);border-radius:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-3,var(--mv-panel));box-shadow:var(--dsw-shadow-lv1,0 2px 8px #0002);color:var(--mv-text);font-size:11px;line-height:18px;pointer-events:none;white-space:normal;overflow-wrap:anywhere}
.mv7-inline{padding:4px 12px 12px;background:var(--mv-panel);font-size:12px}.mv7-search-wrap{position:relative}.mv7-search-wrap input{padding-right:38px}.mv7-search-wrap>button{position:absolute;right:4px;top:2px}.mv7-recent,.mv7-sources{padding-top:18px;border-top:1px solid var(--mv-line)}.mv7 summary{cursor:pointer;font-size:13px;color:var(--mv-muted);padding:5px 0}.mv7-settings{border-block:1px solid var(--mv-line);padding:10px 0}.mv7-settings label{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;font-size:14px}.mv7 [role="switch"]{padding:3px;width:36px;height:21px;background:var(--mv-line);border-radius:15px;flex:none}.mv7 [role="switch"]>span{display:block;width:15px;height:15px;background:var(--mv-muted);border-radius:50%}.mv7 [role="switch"][aria-checked="true"]{background:var(--mv-text)}.mv7 [role="switch"][aria-checked="true"]>span{margin-left:15px;background:var(--mv-bg)}.mv7-back{font-size:12px!important;padding-left:0!important;margin-bottom:14px;color:var(--mv-muted)!important}.mv7-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;background:var(--mv-panel);padding:3px;border-radius:8px;margin-bottom:12px}.mv7-tabs button{font-size:12px;height:34px;padding:5px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mv7-tabs [aria-selected="true"]{background:var(--mv-line)}.mv7-search{display:block;width:100%;background:var(--mv-panel);border:1px solid transparent;border-radius:7px;padding:9px 12px;color:var(--mv-text);font:inherit;font-size:13px}.mv7-row{display:flex!important;align-items:center;gap:10px;width:100%;text-align:left;border-radius:0!important;border-top:1px solid var(--mv-line)!important;padding:13px 0!important}.mv7-row-icon{padding:4px 7px;background:var(--mv-panel);border-radius:7px;flex:none}.mv7-row-text{flex:1;overflow:hidden}.mv7-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;font-size:13px}.mv7-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--mv-muted);margin-top:3px}.mv7-row time{font-size:10px;color:var(--mv-muted);flex:none}.mv7-body{white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;background:var(--mv-panel);padding:20px;margin:24px 0;font-size:14px}.mv7-sources{margin:24px 0;font-size:12px;overflow-wrap:anywhere}.mv7-forget{color:#d98888!important}.mv7-confirm{background:var(--mv-panel);border-radius:8px;padding:12px;font-size:13px}.mv7-error{color:#db8585;font-size:13px;padding-top:16px}.mv7-pagination{display:flex;align-items:center;justify-content:center;gap:16px;font-size:12px;padding:12px 0}
.mv7-pause{font-size:12px;color:var(--mv-muted);padding:10px 12px;background:var(--mv-panel);border-radius:8px;margin:-8px 0 20px;overflow-wrap:anywhere}.mv7-pause button{font-size:12px;color:var(--mv-accent)}.mv7-loading{min-height:120px;border-radius:8px;background:var(--mv-panel);padding:20px;color:var(--mv-muted);font-size:13px}.mv7-calendar button:disabled[data-level="0"]{opacity:1;background:var(--mv-cell)}
@container memory-v7 (max-width:320px){.mv7-tabs button{font-size:10px}}
@media(max-width:480px){.mv7{padding:16px 10px}.mv7-stats>button{padding:0 7px}.mv7-stats span{font-size:9px}.mv7-stats strong{font-size:22px}.mv7-tabs button{font-size:10px}.mv7-calendar{gap:2px}.mv7-months{font-size:8px;gap:2px}.mv7-row time{display:none}.mv7-body{padding:14px}}
`
