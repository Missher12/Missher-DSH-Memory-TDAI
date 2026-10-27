import * as memoryV7Model from '../src/client/memory-v7-model.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { boundedDimensionRows, boundedOverviewModel, boundedProjectSummaries, metricText } from '../src/client/dashboard-view-model.js'
import { classifyRepeatedResult, createDashboardReadController, createDashboardReaderPool, createRepeatedReadController,
  libraryReadState, overviewRestoreDecision, readDashboardScopedPage } from '../src/client/scoped-read-state.js'

const require = createRequire(import.meta.url)

test('bounded dashboard summaries preserve metric uncertainty and render actual dimension counts', () => {
  const result = {
    projects: [{ key: 'project-a', name: 'A' }],
    page: { projects: [{ key: 'project-a', name: 'A', memories: { value: 9, relation: 'exact' },
      approved: { value: 5, relation: 'exact' }, candidates: { value: 2, relation: 'exact' },
      forgotten: { value: 2, relation: 'lower_bound' } }] },
  }
  assert.deepEqual(boundedProjectSummaries(result), [{ kind: 'bounded', key: 'project-a', name: 'A', forgottenMetric: { value: 2, relation: 'lower_bound' } }])
  const bootstrap = boundedProjectSummaries({ projects: result.projects })
  assert.deepEqual(bootstrap, [{ kind: 'bounded', key: 'project-a', name: 'A' }], 'directory-only bootstrap data does not invent project counts')
  assert.equal(metricText(bootstrap[0]?.forgottenMetric), '未知')
  const exactZero = boundedProjectSummaries({ page: { projects: [{ key: 'project-zero', name: 'Zero',
    forgotten: { value: 0, relation: 'exact' } }] } })
  assert.deepEqual(exactZero, [{ kind: 'bounded', key: 'project-zero', name: 'Zero', forgottenMetric: { value: 0, relation: 'exact' } }])
  assert.equal(metricText(exactZero[0]?.forgottenMetric), '0', 'a real zero remains distinguishable from missing identity-only statistics')
  const dimensions = [
    { key: 'deepseek/model-x', count: { value: 3, relation: 'exact' } },
    { key: 'other', count: { value: 1, relation: 'exact' } },
    ...Array.from({ length: 7 }, (_, index) => ({ key: `model-${index}`, count: { value: 1, relation: 'exact' } })),
    { key: 'other', count: { value: 4, relation: 'lower_bound' } },
  ]
  const rows = boundedDimensionRows(dimensions, 'model')
  assert.equal(rows[0]?.label, 'deepseek/model-x')
  assert.equal(rows[1]?.label, 'other', 'a real dimension named other keeps its name')
  assert.equal(rows[9]?.label, '其他（合并）', 'the tenth capped row is the aggregate overflow bucket')
  assert.equal(rows[9]?.countText, '≥4')
  assert.equal(metricText({ value: null, relation: 'unknown' }), '未知')
})

function loadDashboardModule() {
  const source = readFileSync(new URL('../src/client/Dashboard.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { fileName: 'Dashboard.tsx', compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (specifier === './memory-v7-model.js') return memoryV7Model
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === './dashboard-view-model.js') return { boundedDimensionRows, boundedOverviewModel, boundedProjectSummaries, metricText }
    if (specifier === './scoped-read-state.js' || specifier === './settings-read-state.js') return {}
    throw new Error(`unexpected Dashboard dependency: ${specifier}`)
  }
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports)
  return module.exports
}

function loadDashboardDimensionRows() {
  return loadDashboardModule().dashboardDimensionRows
}

test('bounded dimension row clicks retain category and scale bars within their own group', () => {
  const rowsFor = loadDashboardDimensionRows()
  let selection = { category: 'model', value: 'shared' }
  const select = (category, value) => { selection = { category, value } }
  const models = rowsFor([
    { key: 'shared', count: { value: 100, relation: 'exact' } },
    { key: 'model-small', count: { value: 50, relation: 'exact' } },
  ], 'model', selection.category, selection.value, select)
  const sourcesBeforeClick = rowsFor([
    { key: 'shared', count: { value: 10, relation: 'lower_bound' } },
    { key: 'source-small', count: { value: 2, relation: 'exact' } },
    { key: 'unknown', count: { value: null, relation: 'unknown' } },
  ], 'source', selection.category, selection.value, select)
  assert.equal(models[0].selected, true)
  assert.equal(sourcesBeforeClick[0].selected, false, 'the same key in another category is not selected')
  assert.equal(sourcesBeforeClick[0].width, 100, 'source width uses the source group maximum, not the selected model maximum')
  assert.equal(sourcesBeforeClick[1].width, 20)
  assert.equal(sourcesBeforeClick[2].label, '未知来源')
  assert.equal(sourcesBeforeClick[2].countText, '未知')
  assert.equal(sourcesBeforeClick[2].width, 0)

  sourcesBeforeClick[0].onSelect()
  assert.deepEqual(selection, { category: 'source', value: 'shared' }, 'clicking the source row replaces both category and value')
  const sourcesAfterClick = rowsFor([
    { key: 'shared', count: { value: 10, relation: 'lower_bound' } },
  ], 'source', selection.category, selection.value, select)
  const modelsAfterClick = rowsFor([
    { key: 'shared', count: { value: 100, relation: 'exact' } },
  ], 'model', selection.category, selection.value, select)
  assert.equal(sourcesAfterClick[0].selected, true)
  assert.equal(modelsAfterClick[0].selected, false)

  const overflow = rowsFor(Array.from({ length: 10 }, (_, index) => ({
    key: index === 9 ? 'other' : `source-${index}`, count: { value: index + 1, relation: 'exact' },
  })), 'source', 'source', '__other__', select)
  assert.equal(overflow[9].label, '其他（合并）')
  assert.equal(overflow[9].value, '__other__')
  assert.equal(overflow[9].selected, true)
})

test('bounded overview model preserves exact zero, unknown, lower bounds and real dimension key/count pairs', () => {
  const overviewResult = { status: 'partial', complete: false, reason: 'budget-exhausted', generatedAt: 42,
    metrics: { effectiveMemories: { value: null, relation: 'unknown' }, candidates: { value: 0, relation: 'exact' },
      captures: { value: 7, relation: 'lower_bound' }, sessions: { value: 0, relation: 'exact' } },
    dimensions: { sources: [{ key: 'desktop-a', count: { value: 6, relation: 'lower_bound' } }], agents: [], agentPresets: [],
      providers: [], models: [], sessions: [], fingerprints: [] },
    activity: [{ date: '2026-10-25', count: { value: 0, relation: 'exact' }, coverage: 'covered' }],
    usage: { attempts: { byModel: [{ key: 'provider/model-a', count: { value: 2, relation: 'exact' } }] },
      billable: { byPurpose: [{ key: 'embedding', count: { value: null, relation: 'unknown' } }] } },
  }
  const result = boundedOverviewModel(overviewResult)
  assert.equal(metricText(result.current.effectiveMemories), '未知')
  assert.equal(metricText(result.current.candidates), '0')
  assert.equal(metricText(result.period.captures), '≥7')
  assert.equal(result.activity[0].coverage, 'covered')
  assert.deepEqual(result.sources, [{ key: 'desktop-a', count: { value: 6, relation: 'lower_bound' } }])
  assert.deepEqual(result.attemptsByModel, [{ key: 'provider/model-a', count: { value: 2, relation: 'exact' } }])
  assert.deepEqual(result.billableByPurpose, [{ key: 'embedding', count: { value: null, relation: 'unknown' } }])
  assert.equal(result.complete, false)

  const loadedOverview = {
    ...overviewResult, status: 'ok', complete: true, reason: undefined,
    activity: [{ date: '2026-10-25', count: { value: 7, relation: 'lower_bound' }, coverage: 'partial' }],
  }
  const summary = loadDashboardModule().BoundedOverviewSummary
  const noop = () => {}
  const markup = renderToStaticMarkup(createElement(summary, {
    data: loadedOverview, loading: false, projectName: 'Project A', from: '2026-10-25', to: '2026-10-25',
    timeZone: 'UTC', timeZones: ['UTC'], activity: 'capture', heatmapMonth: '2026-10', heatmapMonths: ['2026-10'],
    repeatedItems: [], repeatedReady: true, repeatedState: 'ready', repeatedHasMore: false, repeatedLoading: false,
    repeatedShowMore: noop, overviewHasMore: false, detailDimension: 'source', detailValue: '',
    detailFingerprint: '', detailIncludeExcerpt: false, detailDate: '', detailRange: false, detailLoading: false,
    detailHasMore: false, onRefresh: noop, onContinue: noop, onRangeDate: noop, onQuickRange: noop,
    onActivity: noop, onTimeZone: noop, onMonth: noop, onDate: noop, onDimensionChange: noop,
    onDimensionSelect: noop, onRepeatedSelect: noop, onClearDetail: noop, onLoadMoreDetails: noop,
    onOpenMemories: noop, onOpenReview: noop,
  }))
  assert.match(markup, /aria-label="捕获事件每日热图"/u)
  assert.match(markup, /aria-label="热图月份"/u)
  assert.match(markup, /2026-10-25：≥7 捕获事件；部分覆盖；未记录不代表整日为零/u,
    'a loaded bounded overview renders its actual lower-bound activity and partial-coverage heatmap cell')
})

test('library reads have retryable error state without leaking another scope', () => {
  const base = { active: true, hasProject: true, hasReader: true, scope: 'project-a\u0000approved', loadedScope: '', errorScope: undefined }
  assert.equal(libraryReadState(base), 'loading')
  assert.equal(libraryReadState({ ...base, errorScope: base.scope }), 'error', 'a rejected current request ends in an error state')
  assert.equal(libraryReadState({ ...base, errorScope: base.scope, scope: 'project-b\u0000approved' }), 'loading',
    'an error from another project does not mask the new request')
  assert.equal(libraryReadState({ ...base, loadedScope: base.scope }), 'ready')
  assert.equal(libraryReadState({ ...base, loadedScope: base.scope, errorScope: base.scope }), 'error',
    'a current-scope error takes precedence and can trigger a retry')
  assert.equal(libraryReadState({ ...base, active: false }), 'idle')
})

test('overview return waits for current data and cancels after scope change or user navigation', () => {
  const base = { pending: true, active: true, scopeMatches: true, canRead: true, loading: true,
    contentReady: false, targetReady: false, failed: false, interacted: false }
  assert.equal(overviewRestoreDecision(base), 'wait')
  assert.equal(overviewRestoreDecision({ ...base, loading: false, contentReady: true, targetReady: false }), 'wait')
  assert.equal(overviewRestoreDecision({ ...base, loading: false, contentReady: true, targetReady: true }), 'restore')
  assert.equal(overviewRestoreDecision({ ...base, loading: false, contentReady: true, targetReady: true, scopeMatches: false }), 'cancel')
  assert.equal(overviewRestoreDecision({ ...base, loading: false, contentReady: true, targetReady: true, interacted: true }), 'cancel')
  assert.equal(overviewRestoreDecision({ ...base, loading: false, targetReady: true, failed: true }), 'cancel')
})

test('bounded overview source keeps metrics, four-state waiting and fd-bound global persona', () => {
  const contract = readFileSync(new URL('../src/remote-contract.ts', import.meta.url), 'utf8')
  const aggregate = readFileSync(new URL('../src/dashboard-aggregate.ts', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../src/client/Dashboard.tsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(contract, /overview:\s*OverviewResultSchema\.optional/u,
    'the new read result must not embed the old naked-number OverviewResult DTO')
  assert.match(contract, /oldestWaiting:[\s\S]*state: z\.enum\(\['unknown', 'none', 'partial', 'exact'\]\)[\s\S]*value: z\.number\(\)\.nullable\(\)/u)
  assert.match(dashboard, /BoundedOverviewSummary/u)
  assert.match(dashboard, /if \(props\.readDashboard !== undefined\) \{ await refreshBounded\(\); return \}/u)
  assert.match(dashboard, /if \(props\.readDashboard !== undefined\) return\n    const current = overviewGeneration/u)
  assert.match(dashboard, /metricText\(model\.current\.effectiveMemories\)/u)
  assert.match(dashboard, /boundedHeatmapDays\(props\.from, props\.to, model\.activity\)/u)
  assert.match(dashboard, /<BoundedOverviewSummary[\s\S]*data=\{boundedOverviewData\}/u,
    'the rendered heatmap receives the result loaded through the bounded dashboard reader')
  assert.match(dashboard, /overviewHasMore=\{boundedOverviewCursor !== undefined\}/u)
  assert.match(dashboard, /onRepeatedSelect=\{\(fingerprint\) =>/u)
  assert.match(dashboard, /projects: boundedProjectSummaries\(result\)/u)
  assert.match(dashboard, /selectedBoundedProject\.forgottenMetric[\s\S]*metricText\(selectedBoundedProject\.forgottenMetric\)/u)
  assert.match(dashboard.slice(dashboard.indexOf('export function BoundedOverviewSummary')),
    /<BoundedUsagePanel data=\{props\.data\} \/>/u, 'the active bounded overview mounts the usage panel with its current result')
  assert.match(dashboard.slice(dashboard.indexOf('export function BoundedUsagePanel'), dashboard.indexOf('export function BoundedOverviewSummary')),
    /const model = boundedOverviewModel\(data\)[\s\S]*const renderGroups =[\s\S]*row\.fields\.map\([\s\S]*\{field\.valueText\}[\s\S]*\{field\.evidenceText\}[\s\S]*renderGroups\(model\.modelUsageRows, model\.modelUsageEmptyText\)[\s\S]*renderGroups\(model\.purposeUsageRows, model\.purposeUsageEmptyText, true\)/u,
    'the mounted panel renders both model and purpose groups through actual field values and evidence')
  assert.match(dashboard, /oldest\.state === 'partial' \? '部分已读集合中的最早'/u)
  assert.match(dashboard, /action: 'globalPersona'/u)
  assert.doesNotMatch(dashboard, /result\.overview/u, 'normal client does not consume the old overview DTO')
  assert.match(aggregate, /openSync\(file, constants\.O_RDONLY \| constants\.O_NOFOLLOW\)/u)
  assert.match(aggregate, /Buffer\.alloc\(maxBytes \+ 1\)/u)
  assert.match(aggregate, /publishProof\(\)/u)
  assert.match(store, /CREATE INDEX IF NOT EXISTS l1_status_updated_page/u)
  assert.match(store, /INDEXED BY l1_status_updated_page/u)
  assert.match(store, /dashboardRecentIndexReady/u)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function flush() { return new Promise((resolve) => setImmediate(resolve)) }

test('repeated controller ignores a superseded reader and never publishes a late page', async () => {
  const first = deferred()
  const requests = []
  const controller = createRepeatedReadController({
    readDashboard: (request) => { requests.push(request); return first.promise },
  })
  const token = controller.start()
  const loading = controller.load(token, { version: 1, action: 'repeated', readId: 'read-a', target: { kind: 'groups' } })
  assert.equal(controller.isCurrent(token), true)
  const nextToken = controller.start()
  assert.notEqual(nextToken, token)
  assert.equal(controller.isCurrent(token), false)
  first.resolve({ status: 'ok', repeated: { target: 'groups', groups: [{ fingerprint: 'late' }], complete: true, hasMore: false } })
  assert.deepEqual(await loading, { stale: true })
  assert.equal(requests.length, 1)
  controller.dispose()
  assert.equal(controller.start(), undefined)
})

test('repeated controller drains budget pauses, accumulates explicit event chunks, and stops at a page cursor', async () => {
  const steps = [deferred(), deferred(), deferred()]
  const requests = []
  let index = 0
  const controller = createRepeatedReadController({
    readDashboard: (request) => { requests.push(request); const item = steps[index]; index += 1; return item.promise },
  })
  const token = controller.start()
  const loading = controller.load(token, { version: 1, action: 'repeated', readId: 'read-b', target: { kind: 'events' } },
    { collectEvents: true })
  steps[0].resolve({ status: 'budget_exhausted', cursor: 'scan-1', complete: false,
    repeated: { target: 'events', events: [{ id: 1 }], complete: false, hasMore: true } })
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].action, 'continue')
  assert.equal(requests[1].readId, 'read-b')
  assert.equal(requests[1].cursor, 'scan-1')
  steps[1].resolve({ status: 'budget_exhausted', cursor: 'scan-2', complete: false,
    repeated: { target: 'events', events: [{ id: 2 }], complete: false, hasMore: true } })
  await flush()
  assert.equal(requests.length, 3)
  steps[2].resolve({ status: 'ok', cursor: 'page-2', complete: false,
    repeated: { target: 'events', events: [{ id: 3 }], complete: false, hasMore: true } })
  const outcome = await loading
  assert.equal('stale' in outcome, false)
  assert.deepEqual(outcome.events.map((event) => event.id), [1, 2, 3])
  assert.equal(outcome.result.status, 'ok')
  assert.equal(outcome.result.cursor, 'page-2', 'a page cursor is returned for an explicit load-more, not auto-followed')
  assert.equal(controller.isCurrent(token), true)
  controller.dispose()
})

test('repeated controller reports a rejected RPC and rejects continuation after dispose', async () => {
  const failed = deferred()
  const controller = createRepeatedReadController({ readDashboard: () => failed.promise })
  const token = controller.start()
  const loading = controller.load(token, { version: 1, action: 'repeated', readId: 'read-c' })
  const failure = new Error('synthetic transport failure')
  failed.reject(failure)
  const outcome = await loading
  assert.equal(outcome.error, failure)
  const tokenTwo = controller.start()
  const pending = controller.load(tokenTwo, { version: 1, action: 'repeated', readId: 'read-c' })
  controller.dispose()
  assert.deepEqual(await pending, { stale: true })
  assert.deepEqual(await controller.next(tokenTwo, { readId: 'read-c', cursor: 'opaque' }), { stale: true })
})

test('Dashboard repeated entry uses the bounded chain instead of the legacy overview route in reader mode', () => {
  const dashboard = readFileSync(new URL('../src/client/Dashboard.tsx', import.meta.url), 'utf8')
  assert.match(dashboard, /createRepeatedReadController\(/u)
  assert.match(dashboard, /action: 'repeated'/u)
  assert.match(dashboard, /target: \{ kind: 'groups'/u)
  assert.match(dashboard, /target: \{ kind: 'events'/u)
  assert.match(dashboard, /if \(props\.readDashboard !== undefined\) \{\n      if \(repeatedScanCursor !== undefined\) \{ continueRepeatedScan\(\); return \}/u)
  assert.match(dashboard, /after: \{ repeatCount: last\.repeatCount, fingerprint: last\.fingerprint, projectKey: last\.projectKey \}/u)
  assert.match(dashboard, /boundedSessions/u)
  assert.match(dashboard, /createDashboardReadController/u)
  assert.match(dashboard, /dashboardReaderPoolRef/u)
  assert.match(dashboard, /createDashboardReaderPool\(/u)
  assert.match(dashboard, /boundedViewFromResult/u)
  assert.doesNotMatch(dashboard, /boundedSnapshot/u)
  assert.doesNotMatch(dashboard, /if \(snapshot === undefined\) \{/u)
  assert.doesNotMatch(dashboard, /setSnapshot\(/u)
  assert.match(dashboard, /linkedL0Complete/u)
  assert.match(dashboard, /originalMessageCount === null/u)
})

test('repeated result classification never turns a failure or incomplete scan into empty success', () => {
  const failed = classifyRepeatedResult({ version: 1, status: 'stale', complete: false, generatedAt: 1, reason: 'cursor-invalid' }, 'groups')
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.clear, true)
  assert.equal(failed.reason, 'cursor-invalid')
  assert.equal(classifyRepeatedResult(undefined, 'groups').kind, 'failed')
  assert.equal(classifyRepeatedResult({ version: 1, status: 'ok', complete: true, generatedAt: 1 }, 'groups').kind, 'failed',
    'a result without the repeated DTO is never an empty success')
  const wrongTarget = classifyRepeatedResult({ version: 1, status: 'ok', complete: true, generatedAt: 1,
    repeated: { target: 'events', complete: true, hasMore: false } }, 'groups')
  assert.equal(wrongTarget.kind, 'failed')
  const incomplete = classifyRepeatedResult({ version: 1, status: 'budget_exhausted', complete: false, generatedAt: 1,
    cursor: 'scan-cursor',
    repeated: { target: 'groups', complete: false, hasMore: false, reason: 'repeat-scan-in-progress' } }, 'groups')
  assert.equal(incomplete.kind, 'incomplete')
  assert.equal(incomplete.reason, 'repeat-scan-in-progress')
  const complete = classifyRepeatedResult({ version: 1, status: 'ok', complete: true, generatedAt: 1,
    repeated: { target: 'groups', complete: true, hasMore: false, groups: [] } }, 'groups')
  assert.equal(complete.kind, 'complete')
})

test('repeated controller resumes the same readId after the automatic continuation limit', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  const requests = []
  let index = 0
  const controller = createRepeatedReadController({
    readDashboard: (request) => { requests.push(request); const item = [first, second, third][index]; index += 1; return item.promise },
  })
  const token = controller.start()
  const loading = controller.load(token, { version: 1, action: 'repeated', readId: 'read-resume', target: { kind: 'groups' } },
    { maxContinuations: 1 })
  first.resolve({ status: 'budget_exhausted', complete: false, generatedAt: 1, cursor: 'scan-1',
    repeated: { target: 'groups', complete: false, hasMore: false } })
  await flush()
  second.resolve({ status: 'budget_exhausted', complete: false, generatedAt: 2, cursor: 'scan-2',
    repeated: { target: 'groups', complete: false, hasMore: false } })
  const limited = await loading
  assert.equal(limited.result.cursor, 'scan-2', 'the auto limit leaves the scan cursor for manual continuation')
  assert.equal(requests.length, 2)
  const resuming = controller.resume(token, { readId: 'read-resume', cursor: 'scan-2' })
  await flush()
  assert.equal(requests.length, 3)
  assert.equal(requests[2].action, 'continue')
  assert.equal(requests[2].readId, 'read-resume')
  assert.equal(requests[2].cursor, 'scan-2')
  third.resolve({ status: 'ok', complete: true, generatedAt: 3,
    repeated: { target: 'groups', complete: true, hasMore: false, groups: [{ fingerprint: 'f', repeatCount: 1 }] } })
  const resumed = await resuming
  assert.equal('stale' in resumed, false)
  assert.equal(resumed.result.repeated.complete, true)
  controller.dispose()
})

test('a superseded manual resume cannot publish a late page and a later generation recovers', async () => {
  const first = deferred()
  const second = deferred()
  const requests = []
  let index = 0
  const controller = createRepeatedReadController({
    readDashboard: (request) => { requests.push(request); const item = [first, second][index]; index += 1; return item.promise },
  })
  const token = controller.start()
  const loading = controller.load(token, { version: 1, action: 'repeated', readId: 'read-late', target: { kind: 'groups' } },
    { maxContinuations: 0 })
  first.resolve({ status: 'budget_exhausted', complete: false, generatedAt: 1, cursor: 'scan-late',
    repeated: { target: 'groups', complete: false, hasMore: false } })
  const limited = await loading
  assert.equal(limited.result.cursor, 'scan-late')
  const resuming = controller.resume(token, { readId: 'read-late', cursor: 'scan-late' })
  controller.start()
  second.resolve({ status: 'ok', complete: true, generatedAt: 2,
    repeated: { target: 'groups', complete: true, hasMore: false, groups: [{ fingerprint: 'late', repeatCount: 1 }] } })
  assert.deepEqual(await resuming, { stale: true })
  const failedRead = deferred()
  const recovered = deferred()
  let recoveredIndex = 0
  const controllerTwo = createRepeatedReadController({
    readDashboard: () => { const item = [failedRead, recovered][recoveredIndex]; recoveredIndex += 1; return item.promise },
  })
  const tokenTwo = controllerTwo.start()
  const failing = controllerTwo.load(tokenTwo, { version: 1, action: 'repeated', readId: 'read-recover', target: { kind: 'groups' } })
  failedRead.resolve({ status: 'expired', complete: false, generatedAt: 1, reason: 'repeat-read-expired' })
  const failed = await failing
  assert.equal(classifyRepeatedResult(failed.result, 'groups').kind, 'failed')
  const tokenThree = controllerTwo.start()
  const recovering = controllerTwo.load(tokenThree, { version: 1, action: 'repeated', readId: 'read-recover', target: { kind: 'groups' } })
  recovered.resolve({ status: 'ok', complete: true, generatedAt: 2,
    repeated: { target: 'groups', complete: true, hasMore: false, groups: [{ fingerprint: 'recovered', repeatCount: 2 }] } })
  const success = await recovering
  assert.equal(classifyRepeatedResult(success.result, 'groups').kind, 'complete')
  controllerTwo.dispose()
})

test('shared Dashboard controller closes the old readId on its origin transport and follows budget cursors', async () => {
  const requests = []
  const closeRequests = []
  const first = deferred()
  const second = deferred()
  const oldTransport = (request) => {
    requests.push({ transport: 'old', request })
    if (request.action === 'close') { closeRequests.push(request); return Promise.resolve({ status: 'ok' }) }
    return first.promise
  }
  const newTransport = (request) => {
    requests.push({ transport: 'new', request })
    if (request.action === 'close') { closeRequests.push(request); return Promise.resolve({ status: 'ok' }) }
    if (request.action === 'continue') return second.promise
    return Promise.resolve({ status: 'ok', generatedAt: 1, complete: true, readId: 'new-read' })
  }
  const controller = createDashboardReadController({ readDashboard: oldTransport })
  const oldToken = controller.start()
  const oldLoad = controller.load(oldToken, { version: 1, action: 'bootstrap' })
  first.resolve({ status: 'ok', generatedAt: 1, complete: true, readId: 'old-read' })
  await oldLoad
  assert.equal(controller.readId, 'old-read')
  const newToken = controller.rebind(newTransport)
  await controller.closeCurrent()
  assert.deepEqual(closeRequests.map((request) => request.readId), ['old-read'],
    'rebind closes the old readId through the original transport')
  assert.equal(controller.isCurrent(oldToken), false)
  const loaded = await controller.load(newToken, { version: 1, action: 'overview', readId: 'new-read' })
  assert.equal('stale' in loaded, false)
  assert.equal(loaded.result.complete, true)
  controller.dispose()
})

test('shared Dashboard controller never publishes a late result after a generation rebind', async () => {
  const first = deferred()
  let calls = 0
  const transport = (request) => {
    if (request.action === 'close') return Promise.resolve({ status: 'ok' })
    calls += 1
    return calls === 1 ? first.promise : Promise.resolve({ status: 'ok', generatedAt: 2, complete: true })
  }
  const controller = createDashboardReadController({ readDashboard: transport })
  const oldToken = controller.start()
  const pending = controller.load(oldToken, { version: 1, action: 'bootstrap' })
  controller.start(transport)
  first.resolve({ status: 'ok', generatedAt: 1, complete: true, readId: 'late-read' })
  assert.deepEqual(await pending, { stale: true })
  controller.dispose()
})

test('a late bootstrap is closed exactly once through its origin transport after rebind or dispose', async () => {
  for (const endMode of ['rebind', 'dispose']) {
    const pending = deferred()
    const oldCalls = []
    const newCalls = []
    const oldTransport = (request) => {
      oldCalls.push(request)
      return request.action === 'close' ? Promise.resolve({ status: 'stale', complete: false, generatedAt: 1 }) : pending.promise
    }
    const newTransport = (request) => { newCalls.push(request); return Promise.resolve({ status: 'ok', complete: true, generatedAt: 2 }) }
    const controller = createDashboardReadController({ readDashboard: oldTransport })
    const token = controller.start()
    const loading = controller.load(token, { version: 1, action: 'bootstrap' })
    if (endMode === 'rebind') controller.start(newTransport)
    else controller.dispose()
    pending.resolve({ status: 'ok', complete: true, generatedAt: 1, readId: `late-${endMode}` })
    assert.deepEqual(await loading, { stale: true })
    await flush()
    const closes = oldCalls.filter((request) => request.action === 'close')
    assert.deepEqual(closes.map((request) => request.readId), [`late-${endMode}`])
    assert.equal(newCalls.filter((request) => request.action === 'close').length, 0,
      'the replacement transport must never close a read allocated by the old transport')
    await controller.closeCurrent()
  }
})

test('reader pool keeps page scopes independent and retains scene/detail rows across bounded cursors', async () => {
  const requests = []
  const transport = async (request) => {
    requests.push(request)
    if (request.action === 'bootstrap') return { status: 'ok', complete: true, generatedAt: 1, readId: request.projectKeys[0] }
    if (request.action === 'scene') return { status: 'partial', complete: false, generatedAt: 2, readId: request.readId,
      cursor: 'scene-cursor', scene: { projectKey: request.projectKey, projectName: 'A', hasMore: true,
        items: [{ projectKey: request.projectKey, projectName: 'A', name: 'scene-a', state: 'visible', summary: 'A', memoryCount: 1, updatedAt: 1, summaryComplete: true }] } }
    if (request.action === 'detail') return { status: 'partial', complete: false, generatedAt: 2, readId: request.readId,
      cursor: 'detail-cursor', events: [{ id: 1, type: 'capture', createdAt: 1 }] }
    if (request.action === 'continue' && request.readId === 'project-a') return { status: 'ok', complete: true, generatedAt: 3,
      scene: { projectKey: 'project-a', projectName: 'A', hasMore: false,
        items: [{ projectKey: 'project-a', projectName: 'A', name: 'scene-b', state: 'visible', summary: 'B', memoryCount: 2, updatedAt: 2, summaryComplete: true }] } }
    if (request.action === 'continue' && request.readId === 'project-b') return { status: 'ok', complete: true, generatedAt: 3,
      events: [{ id: 2, type: 'capture', createdAt: 2 }] }
    if (request.action === 'close') return { status: 'ok', complete: true, generatedAt: 4 }
    throw new Error(`unexpected request: ${request.action}`)
  }
  const pool = createDashboardReaderPool({ readDashboard: transport })
  const sceneReader = pool.get('scene')
  const detailReader = pool.get('detail')
  const sceneToken = sceneReader.start()
  const detailToken = detailReader.start()
  const [scenes, details] = await Promise.all([
    readDashboardScopedPage(sceneReader, sceneToken, { projectKey: 'project-a', range: { from: '2026-10-01', to: '2026-10-31', timeZone: 'UTC', activity: 'capture' },
      request: { version: 1, action: 'scene', projectKey: 'project-a' }, maxContinuations: 4 }),
    readDashboardScopedPage(detailReader, detailToken, { projectKey: 'project-b', range: { from: '2026-10-01', to: '2026-10-31', timeZone: 'UTC', activity: 'capture' },
      request: { version: 1, action: 'detail', projectKey: 'project-b', target: { kind: 'events', dimension: 'source', value: 'desktop-a' } }, maxContinuations: 4 }),
  ])
  assert.equal(scenes.complete, true)
  assert.deepEqual(scenes.result.scene.items.map((item) => item.name), ['scene-a', 'scene-b'])
  assert.equal(details.complete, true)
  assert.deepEqual(details.result.events.map((item) => item.id), [1, 2])
  const newSceneToken = sceneReader.start()
  assert.equal(detailReader.isCurrent(detailToken), true, 'refreshing the scene view does not invalidate the event detail reader')
  assert.equal(sceneReader.isCurrent(newSceneToken), true)
  assert.ok(requests.some((request) => request.action === 'continue' && request.readId === 'project-a'))
  assert.ok(requests.some((request) => request.action === 'continue' && request.readId === 'project-b'))
  pool.dispose()
})


function u09UiUsage() {
  const metric = (value, relation = value === null ? 'unknown' : 'exact') => ({ value, relation })
  const field = (value, seen, missing, uncertain, relation = value === null ? 'unknown' : 'exact') =>
    ({ ...metric(value, relation), seen, missing, uncertain })
  const knownZero = field(0, 1, 0, 0)
  const missing = field(null, 0, 1, 0)
  const mixed = field(7, 1, 1, 0, 'lower_bound')
  const uncertain = field(5, 1, 0, 1, 'lower_bound')
  return { version: 1, view: 'overview', status: 'partial', complete: false, generatedAt: 42,
    usage: { attempts: { calls: metric(2), knownCalls: metric(0), unknownCalls: metric(2),
      inputTokens: knownZero, outputTokens: mixed, cacheReadTokens: knownZero, cacheWriteTokens: missing,
      reasoningTokens: uncertain, costMicros: missing, byProvider: [],
      grouping: { selection: 'first_seen', overflow: true, unknownIdentityCalls: metric(1) },
      byModel: [{ key: 'model:exact-zero', provider: '提供方甲', model: '同名模型', other: false,
        count: metric(1), knownCalls: metric(0), unknownCalls: metric(1), unknownIdentityCalls: metric(0),
        inputTokens: knownZero, outputTokens: mixed, cacheReadTokens: knownZero, cacheWriteTokens: missing,
        reasoningTokens: uncertain, costMicros: missing },
      { key: 'model:other', provider: null, model: null, other: true, count: metric(1, 'lower_bound'),
        knownCalls: metric(0), unknownCalls: metric(1), unknownIdentityCalls: metric(1),
        inputTokens: mixed, outputTokens: missing, cacheReadTokens: missing, cacheWriteTokens: missing,
        reasoningTokens: missing, costMicros: missing }] },
      billable: { calls: metric(1), tokens: metric(3), grouping: { selection: 'first_seen', overflow: false, unknownIdentityCalls: metric(0) },
        byPurpose: [{ key: 'purpose:embedding', purpose: 'embedding', other: false, count: metric(1), knownCalls: metric(1),
          unknownCalls: metric(0), unknownIdentityCalls: metric(0), actualTokens: field(3, 1, 0, 0) }] },
      preparedInjectionTokensEstimate: metric(12), preparedInjectionEstimateMethod: 'sum-prepared-event-tokens',
      mainModelCoverage: 'unavailable', actualInjectionReceipt: 'unavailable', comparableNetSavings: 'unavailable' } }
}

test('U09 view model preserves zero missing uncertain mixed fields and explicit overflow identities', () => {
  const data = u09UiUsage()
  const model = boundedOverviewModel(data)
  const fields = Object.fromEntries(model.modelUsageRows[0].fields.map((row) => [row.key, row]))
  assert.equal(fields.inputTokens.valueText, '0')
  assert.equal(fields.costMicros.valueText, '未知')
  assert.equal(fields.outputTokens.valueText, '≥7')
  assert.equal(fields.reasoningTokens.valueText, '≥5')
  assert.match(fields.outputTokens.evidenceText, /1 条有值 · 1 条缺失 · 0 条待核实/u)
  assert.match(fields.reasoningTokens.evidenceText, /1 条待核实/u)
  assert.equal(model.modelUsageRows[1].label, '其他模型（合并）')
  assert.equal(model.modelUsageRows[1].unknownIdentityText, '1')
  assert.equal(model.purposeUsageRows[0].fields[0].valueText, '3')
  assert.deepEqual(model.attemptsByModel, data.usage.attempts.byModel)
  assert.deepEqual(boundedDimensionRows([{ key: 'source-only', count: { value: 2, relation: 'exact' } }], 'source')[0].countText, '2',
    'ordinary count-only dimensions remain compatible')
})

test('U09 active usage panel renders observed groups estimates and unavailable comparison separately', () => {
  const component = loadDashboardModule().BoundedUsagePanel
  const data = u09UiUsage()
  const markup = renderToStaticMarkup(createElement(component, { data }))
  for (const text of ['提供方甲', '同名模型', '其他模型（合并）', '按模型 · 实际辅助用量', '按用途 · 账本实际用量',
    '缓存读取 Token', '缓存写入 Token', '推理 Token', '记录费用（微单位）', '1 条有值 · 1 条缺失',
    '按本地准备事件的 Token 估算值求和', '主模型用量覆盖：不可用', '可比净节省：不可计算', '不代表全局用量排名']) {
    assert.ok(markup.includes(text), text)
  }
  assert.doesNotMatch(markup, /wire|RPC|每模型 Token 与未知用量不可得/u)
  const empty = structuredClone(data)
  empty.usage.attempts.byModel = []
  empty.usage.billable.byPurpose = []
  empty.usage.attempts.calls = { value: 0, relation: 'exact' }
  empty.usage.billable.calls = { value: 0, relation: 'lower_bound' }
  const emptyMarkup = renderToStaticMarkup(createElement(component, { data: empty }))
  assert.match(emptyMarkup, /已完整确认此范围没有调用记录/u)
  assert.match(emptyMarkup, /未记录不代表零用量/u)
})

test('U09 queued scope cancellation never allocates and close settlement gates the replacement project', async () => {
  const closing = deferred()
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    if (request.action === 'bootstrap') return { status: 'ok', complete: true, readId: request.projectKeys[0] }
    if (request.action === 'close') {
      if (request.readId === 'old-project') await closing.promise
      return { status: 'ok' }
    }
    return { status: 'partial', complete: false, readId: request.readId, cursor: 'retained' }
  }
  const pool = createDashboardReaderPool({ readDashboard: transport })
  const first = pool.get('overview'), retained = pool.get('scene'), queued = pool.get('persona')
  const firstToken = first.start(), retainedToken = retained.start(), queuedToken = queued.start()
  const open = (reader, token, projectKey) => reader.load(token, { version: 1, action: 'bootstrap', projectKeys: [projectKey] })
  try {
    await Promise.all([open(first, firstToken, 'old-project'), open(retained, retainedToken, 'retained-project')])
    await retained.load(retainedToken, { version: 1, action: 'scene', readId: retained.readId }, { maxContinuations: 0 })
    const cancelled = open(queued, queuedToken, 'cancelled-project')
    queued.start()
    assert.deepEqual(await cancelled, { stale: true })
    const replacementToken = first.start()
    const replacement = open(first, replacementToken, 'new-project')
    await flush()
    assert.deepEqual(calls.filter((call) => call.action === 'bootstrap').map((call) => call.projectKeys[0]), ['old-project', 'retained-project'])
    assert.equal(retained.readId, 'retained-project')
    assert.equal(retained.isCurrent(retainedToken), true)
    closing.resolve()
    assert.equal((await replacement).result.readId, 'new-project')
    assert.equal(first.isCurrent(firstToken), false)
    assert.equal(calls.filter((call) => call.action === 'close' && call.readId === 'old-project').length, 1)
  } finally { closing.resolve(); await pool.dispose() }
})

test('U09 transport rebind retains admission until a late bootstrap closes on its origin', async () => {
  const late = deferred(), closing = deferred()
  const oldCalls = [], newCalls = []
  const oldTransport = async (request) => {
    oldCalls.push(request)
    if (request.action === 'bootstrap' && request.projectKeys[0] === 'late') return late.promise
    if (request.action === 'close' && request.readId === 'late-read') { await closing.promise; return { status: 'ok' } }
    return { status: 'ok', complete: true, readId: request.action === 'bootstrap' ? 'occupied' : request.readId }
  }
  const newTransport = async (request) => {
    newCalls.push(request)
    return { status: 'ok', complete: true, readId: request.action === 'bootstrap' ? 'replacement' : request.readId }
  }
  const pool = createDashboardReaderPool({ readDashboard: oldTransport })
  const first = pool.get('overview'), second = pool.get('scene')
  try {
    const oldToken = first.start()
    const loading = first.load(oldToken, { version: 1, action: 'bootstrap', projectKeys: ['late'] })
    await second.load(second.start(), { version: 1, action: 'bootstrap', projectKeys: ['occupied'] })
    const token = first.rebind(newTransport)
    const replacement = first.load(token, { version: 1, action: 'bootstrap', projectKeys: ['replacement'] })
    await flush()
    assert.equal(newCalls.length, 0)
    late.resolve({ status: 'ok', complete: true, readId: 'late-read' })
    await flush()
    assert.equal(newCalls.length, 0, 'a close in flight still owns its session slot')
    closing.resolve()
    assert.deepEqual(await loading, { stale: true })
    assert.equal((await replacement).result.readId, 'replacement')
    assert.equal(oldCalls.filter((call) => call.action === 'close' && call.readId === 'late-read').length, 1)
    assert.equal(newCalls.some((call) => call.action === 'close' && call.readId === 'late-read'), false)
  } finally { late.resolve({ status: 'ok', readId: 'late-read' }); closing.resolve(); await pool.dispose() }
})

test('U09 disposal cancels queued work and waits for in-flight continuation before closing once', async () => {
  const continuing = deferred(), started = deferred(), closing = deferred()
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    if (request.action === 'continue') { started.resolve(); return continuing.promise }
    if (request.action === 'close') { if (request.readId === 'first') await closing.promise; return { status: 'ok' } }
    return { status: 'ok', complete: true, readId: request.projectKeys[0] }
  }
  const pool = createDashboardReaderPool({ readDashboard: transport })
  const first = pool.get('overview'), second = pool.get('scene'), third = pool.get('persona')
  const token = first.start()
  try {
    await first.load(token, { version: 1, action: 'bootstrap', projectKeys: ['first'] })
    await second.load(second.start(), { version: 1, action: 'bootstrap', projectKeys: ['second'] })
    const pending = first.load(token, { version: 1, action: 'continue', readId: 'first', cursor: 'cursor' })
    await started.promise
    const queued = third.load(third.start(), { version: 1, action: 'bootstrap', projectKeys: ['third'] })
    let disposed = false
    const disposing = pool.dispose().then(() => { disposed = true })
    assert.deepEqual(await queued, { stale: true })
    await flush()
    assert.equal(calls.some((call) => call.action === 'close' && call.readId === 'first'), false)
    continuing.resolve({ status: 'ok', complete: true, readId: 'first' })
    await flush()
    assert.equal(disposed, false)
    closing.resolve()
    assert.deepEqual(await pending, { stale: true })
    await disposing
    assert.equal(calls.filter((call) => call.action === 'bootstrap').length, 2)
    assert.equal(calls.filter((call) => call.action === 'close' && call.readId === 'first').length, 1)
    assert.equal(pool.get('overview'), undefined)
  } finally { continuing.resolve({ status: 'ok', readId: 'first' }); closing.resolve(); await pool.dispose() }
})

test('U09 an unconfirmed close fails queued admission without retry or capacity reuse', async () => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    if (request.action === 'close') throw new Error('close acknowledgement lost')
    return { status: 'ok', complete: true, readId: request.projectKeys[0] }
  }
  const pool = createDashboardReaderPool({ readDashboard: transport })
  const first = pool.get('overview'), second = pool.get('scene'), third = pool.get('persona')
  try {
    await first.load(first.start(), { version: 1, action: 'bootstrap', projectKeys: ['first'] })
    await second.load(second.start(), { version: 1, action: 'bootstrap', projectKeys: ['second'] })
    const queued = third.load(third.start(), { version: 1, action: 'bootstrap', projectKeys: ['third'] })
    await first.closeCurrent()
    assert.match((await queued).error.message, /close acknowledgement lost/u)
    const another = await first.load(first.start(), { version: 1, action: 'bootstrap', projectKeys: ['fourth'] })
    assert.match(another.error.message, /close acknowledgement lost/u)
    assert.equal(calls.filter((call) => call.action === 'bootstrap').length, 2)
    assert.equal(calls.filter((call) => call.action === 'close' && call.readId === 'first').length, 1)
  } finally { await pool.dispose() }
})

test('U09 directory identities survive A to B selection while summaries remain scoped', async () => {
  const { createDashboardProjectDirectory } = await import('../src/client/scoped-read-state.js')
  const directory = createDashboardProjectDirectory()
  const source = async () => { throw new Error('state-only transport identity') }
  const token = directory.begin(source)
  const request = { version: 1, action: 'bootstrap', projectKeys: [] }
  const identities = [{ key: 'project-a', name: 'A' }, { key: 'project-b', name: 'B' }]
  assert.equal(directory.commit(token, source, request, {
    version: 1, view: 'bootstrap', status: 'selection_required', complete: true, generatedAt: 1,
    projects: identities, activeProjectKey: 'project-a',
  }), true)
  for (const selected of identities) {
    const scopedRequest = { version: 1, action: 'bootstrap', projectKeys: [selected.key] }
    const scoped = { version: 1, view: 'bootstrap', status: 'ok', complete: true, generatedAt: 2,
      projects: [selected], page: { projects: [{ ...selected, memories: { value: 3, relation: 'exact' } }] } }
    assert.equal(directory.commit(token, source, scopedRequest, scoped), false,
      'a scoped bootstrap cannot replace directory identities')
    assert.deepEqual(directory.snapshot().projects, identities)
    assert.ok(directory.snapshot().projects.some((project) => project.key === selected.key))
    assert.deepEqual(boundedProjectSummaries(scoped).map((project) => project.key), [selected.key],
      'the existing production summary projection contains only the selected project')
  }
  assert.equal(directory.snapshot().activeProjectKey, 'project-a')
})

test('U09 directory generations reject late transport and invalidated permission responses', async () => {
  const { createDashboardProjectDirectory } = await import('../src/client/scoped-read-state.js')
  const directory = createDashboardProjectDirectory()
  const oldSource = () => {}, newSource = () => {}
  const request = { version: 1, action: 'bootstrap', projectKeys: [] }
  const response = (key) => ({ version: 1, view: 'bootstrap', status: 'selection_required', complete: true,
    generatedAt: 1, projects: [{ key, name: key }], activeProjectKey: key })
  const oldToken = directory.begin(oldSource)
  const late = deferred()
  const oldCommit = late.promise.then((result) => directory.commit(oldToken, oldSource, request, result))
  directory.invalidate(newSource)
  assert.deepEqual(directory.snapshot().projects, [])
  assert.equal(directory.snapshot().activeProjectKey, undefined)
  const currentToken = directory.begin(newSource)
  assert.equal(directory.commit(currentToken, newSource, request, response('new-project')), true)
  late.resolve(response('old-project'))
  assert.equal(await oldCommit, false)
  assert.equal(directory.fail(oldToken, oldSource), false)
  assert.deepEqual(directory.snapshot().projects.map((project) => project.key), ['new-project'])

  const revokedToken = directory.begin(newSource)
  const revoked = deferred()
  const revokedCommit = revoked.promise.then((result) => directory.commit(revokedToken, newSource, request, result))
  directory.invalidate(newSource)
  assert.deepEqual(directory.snapshot().projects, [])
  const refreshedToken = directory.begin(newSource)
  assert.equal(directory.commit(refreshedToken, newSource, request, response('authorized-now')), true)
  revoked.resolve(response('revoked-project'))
  assert.equal(await revokedCommit, false)
  assert.deepEqual(directory.snapshot().projects.map((project) => project.key), ['authorized-now'])
})

test('U09 empty failed and partial directory refreshes never reuse previous identities', async () => {
  const { createDashboardProjectDirectory } = await import('../src/client/scoped-read-state.js')
  const directory = createDashboardProjectDirectory()
  const source = () => {}
  const request = { version: 1, action: 'bootstrap', projectKeys: [] }
  const response = (projects) => ({ version: 1, view: 'bootstrap', status: 'selection_required', complete: true,
    generatedAt: 1, projects })
  let token = directory.begin(source)
  directory.commit(token, source, request, response([{ key: 'old', name: 'Old' }]))
  token = directory.begin(source)
  assert.deepEqual(directory.snapshot().projects, [], 'refresh withdraws the old authorization immediately')
  assert.equal(directory.fail(token, source), true)
  assert.equal(directory.snapshot().status, 'error')
  assert.deepEqual(directory.snapshot().projects, [])

  token = directory.begin(source)
  assert.equal(directory.commit(token, source, request, response([])), true)
  assert.equal(directory.snapshot().status, 'ready')
  assert.deepEqual(directory.snapshot().projects, [])
  token = directory.begin(source)
  directory.commit(token, source, request, { ...response([{ key: 'prefix', name: 'Prefix' }]),
    status: 'partial', complete: false, cursor: 'remaining-directory' })
  assert.equal(directory.snapshot().status, 'partial')
  assert.deepEqual(directory.snapshot().projects, [{ key: 'prefix', name: 'Prefix' }])
  token = directory.begin(source)
  directory.commit(token, source, request, { ...response([]), status: 'unavailable', complete: false })
  assert.equal(directory.snapshot().status, 'error')
  assert.deepEqual(directory.snapshot().projects, [])
  assert.equal(directory.snapshot().activeProjectKey, undefined)
})

// These regressions use the production entry callbacks and return/theme decisions.
test('U09 overview detail entries capture the actual source day and repeated trigger before selection', () => {
  const summary = loadDashboardModule().BoundedOverviewSummary
  const calls = []
  const noop = () => {}
  const tree = summary({
    data: { status: 'ok', complete: true, generatedAt: 42,
      dimensions: { sources: [{ key: 'desktop-a', count: { value: 2, relation: 'exact' } }] },
      scopedDimensions: { activity: 'capture', captureSources: [{ key: 'desktop-a', count: { value: 2, relation: 'exact' } }],
        selected: { sources: [{ key: 'desktop-a', count: { value: 2, relation: 'exact' } }], agents: [], agentPresets: [], providers: [], models: [] } },
      activity: [{ date: '2026-10-25', count: { value: 2, relation: 'exact' }, coverage: 'covered' }] },
    loading: false, projectName: 'A', from: '2026-10-25', to: '2026-10-25', timeZone: 'UTC', timeZones: ['UTC'],
    activity: 'capture', heatmapMonth: '2026-10', heatmapMonths: ['2026-10'],
    repeatedItems: [{ fingerprint: 'repeat-a', repeatCount: 2 }], repeatedReady: true, repeatedState: 'ready',
    repeatedHasMore: false, repeatedLoading: false, repeatedShowMore: noop, overviewHasMore: false,
    detailDimension: 'source', detailValue: 'desktop-a', detailFingerprint: '', detailIncludeExcerpt: false,
    detailDate: '', detailRange: true, detailLoading: false, detailHasMore: false,
    onRefresh: noop, onContinue: noop, onRangeDate: noop, onQuickRange: noop, onActivity: noop, onTimeZone: noop,
    onMonth: noop, onDimensionChange: noop, onLoadMoreDetails: noop, onOpenMemories: noop, onOpenReview: noop,
    onDetailOpen: (trigger) => calls.push(['capture', trigger]),
    onDimensionSelect: (category, value) => calls.push(['dimension', category, value]),
    onDate: (date) => calls.push(['day', date]), onRepeatedSelect: (fingerprint) => calls.push(['repeat', fingerprint]),
    onClearDetail: () => calls.push(['close']),
  })
  const buttons = []
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node === null || typeof node !== 'object' || node.props === undefined) return
    if (node.type === 'button') buttons.push(node)
    visit(node.props.children)
  }
  visit(tree)
  const sources = buttons.filter((button) => button.key === 'source:0:desktop-a')
  const days = buttons.filter((button) => button.props['aria-label']?.startsWith('2026-10-25：'))
  const repeats = buttons.filter((button) => button.key === 'repeat-a')
  assert.equal(sources.length, 2, 'provenance and dimension rows both preserve the real initiating control')
  assert.equal(days.length, 2, 'annual and monthly heatmaps both capture their own control')
  assert.equal(repeats.length, 1)
  for (const [nodes, selection] of [[sources, ['dimension', 'source', 'desktop-a']], [days, ['day', '2026-10-25']], [repeats, ['repeat', 'repeat-a']]]) {
    for (const button of nodes) {
      calls.length = 0
      const trigger = { role: 'actual-button', key: button.key }
      button.props.onClick({ currentTarget: trigger, target: { role: 'nested-label' } })
      assert.deepEqual(calls, [['capture', trigger], selection], 'capture currentTarget before the selection can replace DOM')
    }
  }
  calls.length = 0
  buttons.find((button) => button.props.children === '关闭明细').props.onClick()
  assert.deepEqual(calls, [['close']], 'closing must not recapture the disappearing close button')
})

test('U09 detail return waits for committed close and consumes the exact origin once', async () => {
  const { createOverviewDetailReturnController } = await import('../src/client/scoped-read-state.js')
  const controller = createOverviewDetailReturnController()
  const context = { scope: 'A/query/range', transport: () => {}, active: true }
  const origin = { trigger: {}, root: {}, scrollTarget: {}, scrollTop: 481, scrollLeft: 17 }
  const ready = { detailOpen: false, rootReady: true, targetReady: true, scrollReady: true }
  controller.capture(context, origin)
  controller.interact() // Scrolling/reading the open detail must not lose its originating position.
  const token = controller.close(context)
  assert.equal(typeof token, 'number')
  assert.equal(controller.take(context, token, { ...ready, detailOpen: true }), undefined)
  assert.equal(controller.peek(token), origin, 'an uncommitted close is still pending')
  const result = controller.take(context, token, ready)
  assert.deepEqual(result, { origin, target: 'origin', restoreScroll: true })
  assert.equal(result.origin.trigger, origin.trigger)
  assert.equal(result.origin.scrollTarget, origin.scrollTarget)
  assert.equal(result.origin.scrollTop, 481)
  assert.equal(result.origin.scrollLeft, 17)
  assert.equal(controller.take(context, token, ready), undefined, 'focus events cannot replay a consumed return')
})

test('U09 detail return rejects changed project query range transport and navigation generations', async () => {
  const { createOverviewDetailReturnController } = await import('../src/client/scoped-read-state.js')
  const source = () => {}
  const context = { scope: JSON.stringify(['A', 'query', 'from', 'to', 'UTC', 'capture']), transport: source, active: true }
  const changes = [
    ...['B', 'new query', 'new from', 'new to', 'Asia/Shanghai', 'recall'].map((value, index) => {
      const scope = JSON.parse(context.scope); scope[index] = value
      return { ...context, scope: JSON.stringify(scope) }
    }),
    { ...context, transport: () => {} }, { ...context, active: false },
  ]
  const ready = { detailOpen: false, rootReady: true, targetReady: true, scrollReady: true }
  for (const changed of changes) {
    const controller = createOverviewDetailReturnController()
    controller.capture(context, { trigger: 'old' })
    controller.sync(changed)
    controller.sync(context)
    assert.equal(controller.close(context), undefined, 'returning to identical values does not revive an older generation')
    controller.capture(context, { trigger: 'fresh' })
    const token = controller.close(context)
    assert.equal(controller.take(changed, token, ready), undefined, 'a queued frame cannot restore into the next context')
    assert.equal(controller.take(context, token, ready), undefined)
  }
})

test('U09 detail return cancels later interaction invalidation and superseded close frames', async () => {
  const { createOverviewDetailReturnController } = await import('../src/client/scoped-read-state.js')
  const controller = createOverviewDetailReturnController()
  const context = { scope: 'A', transport: () => {}, active: true }
  const ready = { detailOpen: false, rootReady: true, targetReady: true, scrollReady: true }
  controller.capture(context, { trigger: 'first' })
  const oldToken = controller.close(context)
  controller.interact()
  assert.equal(controller.take(context, oldToken, ready), undefined, 'later user interaction wins over async restore')
  controller.capture(context, { trigger: 'second' })
  const secondToken = controller.close(context)
  controller.capture(context, { trigger: 'third' })
  const thirdToken = controller.close(context)
  assert.notEqual(secondToken, thirdToken)
  assert.equal(controller.take(context, secondToken, ready), undefined)
  assert.equal(controller.peek(thirdToken).trigger, 'third', 'an old frame cannot consume the new return')
  controller.cancel()
  assert.equal(controller.take(context, thirdToken, ready), undefined, 'read invalidation/unmount cannot restore focus')
  assert.equal(controller.close(context), undefined)
})

test('U09 detail return uses plugin fallback for unavailable triggers and never scrolls a stale container', async () => {
  const { createOverviewDetailReturnController } = await import('../src/client/scoped-read-state.js')
  const context = { scope: 'A', transport: () => {}, active: true }
  for (const readiness of [
    { rootReady: true, targetReady: false, scrollReady: true },
    { rootReady: true, targetReady: true, scrollReady: false },
    { rootReady: false, targetReady: false, scrollReady: false },
  ]) {
    const controller = createOverviewDetailReturnController()
    const origin = { trigger: 'removed disabled or hidden control', scrollTarget: 'original container' }
    controller.capture(context, origin)
    const token = controller.close(context)
    const result = controller.take(context, token, { detailOpen: false, ...readiness })
    assert.deepEqual(result, readiness.rootReady ? { origin, target: 'fallback', restoreScroll: false } : undefined)
    assert.equal(controller.peek(token), undefined, 'no retry into another plugin or BODY after the root disappears')
  }
})

test('U09 inherited Host light and dark take precedence over opposite system preferences', async () => {
  const { resolveDashboardTheme } = await import('../src/client/scoped-read-state.js')
  assert.equal(resolveDashboardTheme('dark', false), 'dark', 'Host dark with OS light reproduces the observed mismatch')
  assert.equal(resolveDashboardTheme('light', true), 'light', 'explicit Host light must also win over OS dark')
  assert.equal(resolveDashboardTheme('only dark', false), 'dark')
  assert.equal(resolveDashboardTheme('light only', true), 'light')
  for (const scheme of [undefined, '', 'normal', 'light dark', 'dark light']) {
    assert.equal(resolveDashboardTheme(scheme, false), 'light')
    assert.equal(resolveDashboardTheme(scheme, true), 'dark')
  }
})

test('U09 theme subscription follows Host and system changes without observing its own palette and cleans up', async () => {
  const { observeDashboardTheme } = await import('../src/client/scoped-read-state.js')
  let scheme = 'dark'
  let mutation
  let disconnected = false
  let nextFrame = 0
  const frames = new Map()
  const listeners = new Set()
  const observed = []
  const html = { parentElement: null }
  const body = { parentElement: html }
  const head = {}
  const media = { matches: false,
    addEventListener: (event, listener) => { assert.equal(event, 'change'); listeners.add(listener) },
    removeEventListener: (event, listener) => { assert.equal(event, 'change'); listeners.delete(listener) } }
  const view = {
    matchMedia: (query) => { assert.equal(query, '(prefers-color-scheme: dark)'); return media },
    getComputedStyle: (element) => { assert.equal(element, body, 'read inherited Host scheme above plugin overrides'); return { colorScheme: scheme } },
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id) => frames.delete(id),
    MutationObserver: class {
      constructor(callback) { mutation = callback }
      observe(element, options) { observed.push({ element, options }) }
      disconnect() { disconnected = true }
    },
  }
  const root = Object.freeze({ parentElement: body, ownerDocument: { defaultView: view, documentElement: html, head } })
  const themes = []
  const dispose = observeDashboardTheme(root, (theme) => themes.push(theme))
  const flushFrame = () => {
    const callbacks = [...frames.values()]; frames.clear()
    for (const callback of callbacks) callback()
  }
  const systemChange = (dark) => { media.matches = dark; for (const listener of listeners) listener() }
  assert.deepEqual(themes, ['dark'])
  assert.deepEqual(observed.map(({ element }) => element), [body, html, head])
  assert.ok(observed.slice(0, 2).every(({ options }) => options.attributes === true && options.subtree === undefined))
  assert.equal(observed[2].options.characterData, true, 'Host stylesheet replacement is observed as well as attributes')
  scheme = 'light'; mutation(); mutation()
  assert.equal(frames.size, 1, 'coalesce a Host theme batch')
  systemChange(true); flushFrame()
  assert.deepEqual(themes, ['dark', 'light'], 'explicit light survives opposite OS preference')
  scheme = 'light dark'; mutation(); flushFrame()
  assert.deepEqual(themes, ['dark', 'light', 'dark'], 'standalone/system mode adopts the current OS setting')
  systemChange(false); flushFrame()
  assert.deepEqual(themes, ['dark', 'light', 'dark', 'light'])
  scheme = 'dark'; mutation(); flushFrame()
  assert.deepEqual(themes, ['dark', 'light', 'dark', 'light', 'dark'], 'Host can switch back to explicit dark at runtime')
  mutation(); dispose()
  assert.equal(disconnected, true)
  assert.equal(listeners.size, 0)
  assert.equal(frames.size, 0)
  mutation(); systemChange(true); flushFrame()
  assert.equal(themes.length, 5, 'disposed Shell cannot publish a late theme')
})

test('U09 overview projection keeps capture selected and legacy groups distinct with honest compatibility bounds', () => {
  const captures = [{ key: 'dsh-session', count: { value: 2, relation: 'lower_bound' } },
    { key: 'unknown', count: { value: 1, relation: 'lower_bound' } }]
  const revisions = [{ key: 'unknown', count: { value: 1, relation: 'lower_bound' } }]
  const all = [{ key: 'dsh-session', count: { value: 2, relation: 'lower_bound' } },
    { key: 'unknown', count: { value: 3, relation: 'lower_bound' } }]
  const result = { status: 'partial', complete: false, reason: 'bounded-scan-incomplete', dimensions: { sources: all },
    metrics: { captures: { value: 3, relation: 'lower_bound' } },
    scopedDimensions: { activity: 'revision', captureSources: captures,
      selected: { sources: revisions, agents: [], agentPresets: [], providers: [], models: [] } } }
  const model = boundedOverviewModel(result, 'revision')
  assert.deepEqual(model.sources, all, 'legacy all-event grouping keeps its original meaning')
  assert.deepEqual(model.captureSources, captures)
  assert.deepEqual(model.selectedDimensions.sources, revisions)
  assert.equal(metricText(model.period.captures), '≥3')
  assert.equal(metricText(model.captureSources[1].count), '≥1')
  assert.equal(model.complete, false)
  assert.equal(model.reason, 'bounded-scan-incomplete')
  const switched = boundedOverviewModel(result, 'capture')
  assert.equal(switched.selectedDimensions, undefined, 'a late revision projection cannot be labelled capture')
  assert.deepEqual(switched.captureSources, captures, 'capture provenance remains independent of the selected activity')
  const legacy = boundedOverviewModel({ dimensions: { sources: all } }, 'capture')
  assert.equal(legacy.captureSources, undefined)
  assert.equal(legacy.selectedDimensions, undefined, 'missing new fields are unavailable, not a legacy alias or exact zero')
  const empty = boundedOverviewModel({ status: 'ok', complete: true,
    metrics: { captures: { value: 0, relation: 'exact' } },
    scopedDimensions: { activity: 'capture', captureSources: [], selected: { sources: [], agents: [], agentPresets: [], providers: [], models: [] } } }, 'capture')
  assert.deepEqual(empty.captureSources, [])
  assert.deepEqual(empty.selectedDimensions.sources, [])
  assert.equal(metricText(empty.period.captures), '0')
})

test('U09 rendered capture and selected-activity source buttons carry different detail scopes', () => {
  const summary = loadDashboardModule().BoundedOverviewSummary
  const noop = () => {}
  const selections = []
  const captures = [{ key: 'dsh-session', count: { value: 2, relation: 'exact' } }, { key: 'unknown', count: { value: 1, relation: 'exact' } }]
  const props = {
    data: { status: 'ok', complete: true, generatedAt: 42, metrics: { captures: { value: 3, relation: 'exact' } },
      dimensions: { sources: [{ key: 'unknown', count: { value: 99, relation: 'exact' } }] },
      scopedDimensions: { activity: 'revision', captureSources: captures,
        selected: { sources: [{ key: 'unknown', count: { value: 1, relation: 'exact' } }], agents: [], agentPresets: [], providers: [], models: [] } } },
    loading: false, projectName: 'A', from: '2026-10-25', to: '2026-10-25', timeZone: 'UTC', timeZones: ['UTC'],
    activity: 'revision', heatmapMonth: '2026-10', heatmapMonths: ['2026-10'],
    repeatedItems: [], repeatedReady: true, repeatedState: 'ready', repeatedHasMore: false, repeatedLoading: false,
    repeatedShowMore: noop, overviewHasMore: false, detailDimension: 'source', detailValue: 'unknown', detailActivity: 'capture',
    detailFingerprint: '', detailIncludeExcerpt: false, detailDate: '', detailRange: true, detailLoading: false, detailHasMore: false,
    onRefresh: noop, onContinue: noop, onRangeDate: noop, onQuickRange: noop, onActivity: noop, onTimeZone: noop, onMonth: noop,
    onDate: noop, onDimensionChange: noop, onDetailOpen: (trigger) => selections.push(['origin', trigger]),
    onDimensionSelect: (...args) => selections.push(args), onRepeatedSelect: noop, onClearDetail: noop,
    onLoadMoreDetails: noop, onOpenMemories: noop, onOpenReview: noop,
  }
  const buttonsOf = (tree) => {
    const buttons = []
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (node === null || typeof node !== 'object' || node.props === undefined) return
      if (node.type === 'button' && node.key?.startsWith('source:')) buttons.push(node)
      visit(node.props.children)
    }
    visit(tree)
    return buttons
  }
  const buttons = buttonsOf(summary(props))
  assert.equal(buttons.length, 3, 'two capture rows and one revision row; legacy unknown99 is not rendered')
  assert.deepEqual(buttons.map((button) => button.props['aria-pressed']), [false, true, false],
    'capture selection must not mark the unrelated revision row selected')
  const captureTrigger = {}, revisionTrigger = {}
  buttons[1].props.onClick({ currentTarget: captureTrigger })
  buttons[2].props.onClick({ currentTarget: revisionTrigger })
  assert.deepEqual(selections, [['origin', captureTrigger], ['source', 'unknown', 'capture'],
    ['origin', revisionTrigger], ['source', 'unknown', 'revision']])
  const markup = renderToStaticMarkup(createElement(summary, props))
  assert.match(markup, /3 条捕获事件/u)
  assert.doesNotMatch(markup, /99 次/u)
  assert.equal(buttonsOf(summary({ ...props, activity: 'capture' })).length, 2,
    'switching activity suppresses stale selected rows while retaining the dedicated capture panel')
})

test('U09 actual bounded detail request binds the panel activity and keeps date and dimension identities', async () => {
  const { boundedEventDetailRequest } = await import('../src/client/dashboard-view-model.js')
  const range = { from: '2026-10-01', to: '2026-10-25', timeZone: 'Asia/Shanghai', activity: 'revision' }
  const origin = { projectKey: 'project-a', range, dimension: 'source', value: 'unknown', date: '' }
  const capture = boundedEventDetailRequest({ ...origin, activity: 'capture' })
  assert.deepEqual(capture, { range: { ...range, activity: 'capture' }, request: { version: 1, action: 'detail', projectKey: 'project-a',
    target: { kind: 'events', dimension: 'source', value: 'unknown' } } })
  assert.equal(range.activity, 'revision', 'opening capture provenance does not change the overview range or focus generation')
  assert.equal(boundedEventDetailRequest(origin).range.activity, 'revision')
  assert.deepEqual(boundedEventDetailRequest({ ...origin, dimension: 'agent_preset', value: 'agent-a' }).request.target,
    { kind: 'events', dimension: 'agentPreset', value: 'agent-a' })
  assert.deepEqual(boundedEventDetailRequest({ ...origin, date: '2026-10-20' }).request.target,
    { kind: 'events', dimension: 'date', value: '2026-10-20' })
})

test('U09 root sizing includes padding and border in the natural Host width', () => {
  const source = readFileSync(new URL('../src/client/Dashboard.tsx', import.meta.url), 'utf8')
  const css = source.slice(source.indexOf('const CSS = `') + 'const CSS = `'.length)
  const rootRules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/gu)]
    .filter((match) => match[1].split(',').some((selector) => selector.trim() === '.tdai-root'))
    .map((match) => match[2]).join('\n')
  assert.match(rootRules, /(?:^|;)\s*box-sizing\s*:\s*border-box\s*;/u,
    'the root itself, not only its descendants, must include its padding and borders in width100%')
  assert.match(rootRules, /(?:^|;)\s*width\s*:\s*100%\s*;/u)
  assert.doesNotMatch(rootRules, /(?:^|;)\s*overflow(?:-x)?\s*:\s*(?:hidden|clip)\s*;/u,
    'clipping is not an acceptable substitute for sizing the root to its Host container')
})
