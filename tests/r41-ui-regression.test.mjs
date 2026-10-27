import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const dashboardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'Dashboard.tsx')
const dashboard = readFileSync(dashboardPath, 'utf8')

test('R9 UI-R8-01 locates evaluation records only inside their run case and scopes focus by case', () => {
  assert.match(dashboard, /evaluationCases\.find\(\(item\) => String\(item\.id\) === String\(run\.caseId\)\)/u)
  assert.match(dashboard, /caseItem\?\.source === 'synthetic'/u)
  assert.match(dashboard, /\.some\(\(record\) => String\(record\.id \?\? ''\) === id\)/u)
  assert.match(dashboard, /setEvaluationCorpusFocus\(\{ caseId: syntheticCaseId, recordId: id \}\)/u)
  assert.match(dashboard, /evaluationCorpusFocus\?\.caseId === String\(item\.id\)/u)
  assert.match(dashboard, /caseItem\?\.source === 'approved'\s*\? <button[^\n]*openKnowledgeDetail\(id\)/u)
  assert.match(dashboard, /来源不可得：案例未知或合成语料已变更/u)
  assert.doesNotMatch(dashboard, /: <button type="button" key=\{id\} onClick=\{\(\) => openKnowledgeDetail\(id\)\}/u,
    'unknown cases and missing synthetic fixture records must never open knowledge.detail')
  assert.doesNotMatch(dashboard, /evaluationCorpusCaseById/u, 'a project-wide first-ID map can cross synthetic and approved cases')
})

test('R10 clears cached management results on view changes and scopes receipts to the selected project', () => {
  const navigation = dashboard.slice(dashboard.indexOf('const navigateView ='), dashboard.indexOf('const requestedLibraryStatus ='))
  const invalidation = dashboard.slice(dashboard.indexOf('const invalidateActionScope ='), dashboard.indexOf('const holdReadViews ='))
  assert.match(navigation, /const navigateView = \(view: typeof activeView, trigger\?: HTMLElement\): void => \{/u)
  assert.match(invalidation, /actionScopeGeneration\.current \+= 1[\s\S]*busyGeneration\.current \+= 1[\s\S]*setBusy\(false\)[\s\S]*setManageBusy\(false\)/u,
    'the shared invalidation helper cancels scoped operations and clears both busy states')
  assert.match(navigation, /if \(activeView === view\) return[\s\S]*invalidateActionScope\(\)[\s\S]*manageGeneration\.current \+= 1[\s\S]*knowledgeDetailGeneration\.current \+= 1[\s\S]*setManageData\(\{\}\)[\s\S]*setManageError\(undefined\)[\s\S]*setKnowledgeLoadingId\(''\)[\s\S]*setManageResult\(undefined\)[\s\S]*setManageResultProjectKey\(undefined\)[\s\S]*setActiveView\(view\)/u,
    'navigation still clears scoped management state and invalidates pending work')
  assert.match(dashboard, /setManageResultProjectKey\(projectKey\)/u)
  assert.match(dashboard, /const scopedManageResult = manageResultProjectKey === selectedProjectKey \? manageResult : undefined/u)
  assert.match(dashboard, /asRecord\(activeView === 'evaluation' \? scopedManageResult : undefined\)/u)
  assert.match(dashboard, /asRecord\(activeView === 'recovery' \? scopedManageResult : undefined\)/u)
  assert.match(dashboard, /onClick=\{\(event\) => navigateView\(view, event\.currentTarget\)\}/u,
    'navigation forwards its trigger so overview restoration can restore focus without losing the existing cleanup')
})

test('R11 invalidates cancelled knowledge detail work while allowing a post-navigation request', () => {
  const navigation = dashboard.slice(dashboard.indexOf('const navigateView ='), dashboard.indexOf('const requestedLibraryStatus ='))
  assert.match(navigation, /knowledgeDetailGeneration\.current \+= 1/u,
    'navigation invalidates a detail request that belongs to the page being left')
  assert.match(navigation, /setKnowledgeLoadingId\(''\)/u,
    'navigation releases the loading state of the cancelled detail request')
  const openKnowledgeDetail = dashboard.slice(dashboard.indexOf('const openKnowledgeDetail ='), dashboard.indexOf('const regenerate ='))
  assert.match(openKnowledgeDetail, /navigateView\('knowledge'\)[\s\S]*const scopeGeneration = actionScopeGeneration\.current[\s\S]*const requestGeneration = knowledgeDetailGeneration\.current \+ 1[\s\S]*knowledgeDetailGeneration\.current = requestGeneration[\s\S]*setKnowledgeLoadingId\(memoryId\)/u,
    'approved case navigation establishes a fresh detail request after the view change')
  assert.match(openKnowledgeDetail, /finally\(\(\) => \{\s*if \(knowledgeDetailGeneration\.current === requestGeneration && actionScopeGeneration\.current === scopeGeneration && selectedProjectKeyRef\.current === projectKey\) setKnowledgeLoadingId\(''\)/u,
    'an old finally cannot clear loading for a newer request or project')
})

test('R28 library failures are scoped retryable states and never masquerade as loading forever', () => {
  assert.match(dashboard, /libraryReadState\(\{ active: activeView === 'memories' \|\| activeView === 'review'[\s\S]*errorScope: libraryError\?\.scope \}\)/u)
  assert.match(dashboard, /catch\(\(error: unknown\) => \{ if \(libraryGeneration\.current === current\) setLibraryError\(\{ scope, message:/u)
  assert.match(dashboard, /visibleLibraryError !== undefined && <div className="tdai-danger-text" role="alert">[\s\S]*setLibraryRefresh\(\(value\) => value \+ 1\)/u)
  assert.match(dashboard, /\.then\(\(result\) => \{ if \(libraryGeneration\.current === current\)[\s\S]*setLibraryLoadedScope\(scope\)/u,
    'only the current request can populate its scope')
})

test('R28 overview restoration waits for matching loaded content and yields to navigation or input', () => {
  const restoration = dashboard.slice(dashboard.indexOf('const saved = pendingOverviewRestoreRef.current', dashboard.indexOf('useEffect(() => {', dashboard.indexOf('overviewScope'))),
    dashboard.indexOf('  useEffect(() => {\n    const months = monthKeys'))
  assert.match(restoration, /overviewRestoreDecision\([\s\S]*scopeMatches: saved\.scope === overviewScope[\s\S]*contentReady: overviewLoadedScope === overviewScope && \(overviewData !== undefined \|\| boundedOverviewData !== undefined\)[\s\S]*targetReady/u)
  assert.match(restoration, /document\.addEventListener\('pointerdown'[\s\S]*document\.addEventListener\('wheel'[\s\S]*document\.addEventListener\('keydown'/u)
  assert.match(restoration, /saved\.scope !== overviewScope \|\| overviewLoading \|\| overviewLoadedScope !== overviewScope \|\|\s*\(overviewData === undefined && boundedOverviewData === undefined\)/u)
  assert.match(restoration, /target\.focus\(\{ preventScroll: true \}\)/u)
})

test('UI3 holds page reads while a revocation or forget is in flight and clears old result scopes first', () => {
  assert.match(dashboard, /const holdReadViews = \(\): void => \{[\s\S]*setReadViewsSuspended\(true\)/u)
  assert.match(dashboard, /const releaseReadViews = \(\): void => \{[\s\S]*readMutationHolds\.current > 0/u)
  assert.match(dashboard, /if \(readViewsSuspended\) \{\s*setBoundedOverviewData\(undefined\)[\s\S]*return/u)
  assert.match(dashboard, /if \(readViewsSuspended \|\| activeView !== 'overview' \|\| props\.readDashboard === undefined \|\| selectedProjectKey === ''/u)
  assert.match(dashboard, /if \(suspendPageReads\) \{ holdReadViews\(\); invalidateReadViews\(\) \}/u)
  assert.match(dashboard, /if \(invalidateBeforeWrite\) \{ holdReadViews\(\); invalidateReadViews\(\) \}/u)
  assert.match(dashboard, /setBoundedPersonaArea\(\{ status: 'idle' \}\); return/u)
  assert.match(dashboard, /setBoundedSceneArea\(\{ status: 'idle' \}\); return/u)
})

test('UI6 keeps persona, global persona and scenes independently retryable and continuable', () => {
  for (const name of ['persona', 'global-persona', 'scene']) assert.match(dashboard, new RegExp(`get\\('${name}'\\)`, 'u'))
  for (const button of ['继续读取项目画像', '继续读取全局画像', '继续读取场景', '重试项目画像', '重试全局画像', '重试场景']) {
    assert.ok(dashboard.includes(button), `bounded ${button} control remains visible`)
  }
  assert.match(dashboard, /status: complete \? 'ready' : 'partial'/u)
  assert.match(dashboard, /persona\.state !== 'visible' \|\| persona\.content === undefined/u)
  assert.match(dashboard, /visibleOnly|hasHidden/u)
})

test('R9 UI-R8-02 shows the backend partial-cleanup reason and masks unavailable packet bodies', () => {
  assert.match(dashboard, /\[item\.stage, item\.reason\]/u)
  assert.match(dashboard, /baselineResult\.renderedPacketAvailable === true/u)
  assert.match(dashboard, /comparisonResult\.renderedPacketAvailable === true/u)
  assert.match(dashboard, /不可展示；历史包未保存完整来源，或当前来源权限已变化/u)
  assert.match(dashboard, /loadMoreEvaluationRuns/u, 'evaluation pagination remains connected')
  assert.match(dashboard, /定位策略详情/u, 'strategy navigation remains available')
})
