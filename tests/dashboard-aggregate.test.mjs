import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, opendirSync, rmSync, writeFileSync, utimesSync, copyFileSync, renameSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ControlLedger } from '../lib/control.js'
import { DashboardAggregateService } from '../lib/dashboard-aggregate.js'
import { DashboardReadSessionManager } from '../lib/dashboard-read.js'
import { DashboardVisibilityReadSession } from '../lib/dashboard-visibility.js'
import { ReadDashboardRequestSchema } from '../lib/remote-contract.js'
import { openProjectStore, openProjectStoreReadOnly } from '../lib/store.js'

const DAY_MS = 86_400_000
const PROJECT_A = 'aggregate-project-a'
const PROJECT_B = 'aggregate-project-b'
const DATE = '2026-10-23'
const EVENT_TIME = Date.UTC(2026, 9, 23, 12)

function ok(value) { return { status: 'ok', value } }
function failure(status, reason) { return { status, reason } }
function uuid() { return randomUUID() }
function stringBytes(value) { return Buffer.byteLength(value, 'utf8') }
function originalMessageIdentity(digest) { return { schema: 'memory-tdai/original-message/v1', algorithm: 'sha256', digest } }

function captureEvent(id, { fingerprint, sessionId = 'session-a', originalMessageIdentity } = {}) {
  const sourceId = `source-${id}`
  return {
    id, projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), type: 'capture', typeBytes: 7,
    eventId: `capture-event-${id}`, eventIdBytes: stringBytes(`capture-event-${id}`), sourceId,
    sourceIdBytes: stringBytes(sourceId), l0Found: true, sourceEventId: `source-event-${id}`,
    sourceEventIdBytes: stringBytes(`source-event-${id}`), sessionId, sessionIdBytes: stringBytes(sessionId),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    fingerprintBytes: fingerprint === undefined ? 0 : stringBytes(fingerprint),
    fingerprintInvalid: false, memoryIdsInvalid: false, metadataInvalid: false, identityInvalid: false,
    createdAt: EVENT_TIME, occurredAt: null, count: 1, tokens: 2, rawTokens: 2,
    source: 'user', sourceBytes: 4, agentId: 'agent-a', agentIdBytes: 7,
    agentPreset: 'default', agentPresetBytes: 7, provider: 'mock', providerBytes: 4,
    model: 'mock-model', modelBytes: 10,
    originalMessageIdentity: originalMessageIdentity ?? String(id).padStart(64, '0'),
  }
}

function event(type, id, extra = {}) {
  const eventId = `${type}-${id}`
  return {
    id, projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), type, typeBytes: stringBytes(type),
    eventId, eventIdBytes: stringBytes(eventId), sourceId: `memory-${id}`, sourceIdBytes: stringBytes(`memory-${id}`), l0Found: true,
    sourceEventId: `source-event-${id}`, sourceEventIdBytes: stringBytes(`source-event-${id}`),
    sessionId: 'session-a', sessionIdBytes: 9, memoryIdsInvalid: false, metadataInvalid: false, identityInvalid: false,
    createdAt: EVENT_TIME, occurredAt: EVENT_TIME, count: 1, tokens: 3, rawTokens: 3,
    source: 'runtime', sourceBytes: 7, agentId: 'agent-a', agentIdBytes: 7,
    agentPreset: 'default', agentPresetBytes: 7, provider: 'mock', providerBytes: 4,
    model: 'mock-model', modelBytes: 10, fingerprintBytes: 0, fingerprintInvalid: false,
    ...extra,
  }
}

function approvedRows(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    state: 'visible', summary: { id: `memory-${index + 1}`, revision: 1, kind: 'fact',
      sourceMessageIds: [`source-${index + 1}`] },
  }))
}

function fakeReader(binding, onEnd, script, log) {
  let paused = false
  let ended = false
  let continuations = 0
  let suspensions = 0
  let callGeneration = 0
  let eventPagesThisCall = 0
  let usageGroupKeysThisCall = 0
  const paginationBudget = Symbol('pagination-call-headroom')
  let eventPageLimit = script.eventPageLimit ?? Number.POSITIVE_INFINITY
  const reservations = new Set()
  let memberCallUsed = 0
  const memberLabels = new Map()
  const memberCallCapacity = script.memberCallCapacity ?? 4
  const memberSessionCapacity = script.memberSessionCapacity ?? 16
  const records = script.approved ?? []
  const forgottenRows = script.forgotten ?? []
  const projectName = script.projectName ?? 'Synthetic project'
  const events = script.events ?? []
  const controlRows = {
    attempts: script.attempts ?? [], billable: script.billable ?? [], coverage: script.coverage ?? [],
  }
  return {
    get isPaused() { return paused },
    reserveReadState(bytes) {
      if (ended || !Number.isSafeInteger(bytes) || bytes < 1) return failure('budget-exhausted', 'resident-capacity')
      log.push(['reserve', bytes])
      const reservationToken = uuid()
      reservations.add(reservationToken)
      return ok({ reservationToken })
    },
    reserveReadKeys(bytes) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      if (usageGroupKeysThisCall >= (script.usageGroupLimitPerCall ?? Number.POSITIVE_INFINITY)) {
        log.push(['keyHeadroom', bytes])
        return failure('budget-exhausted', 'persona-call-headroom')
      }
      usageGroupKeysThisCall += 1
      log.push(['reserveKeys', bytes])
      const reservationToken = uuid()
      reservations.add(reservationToken)
      return ok({ reservationToken })
    },
    releaseReadState(token) {
      if (ended || paused || !reservations.has(token)) return failure('stale', 'reservation-missing')
      reservations.delete(token)
      log.push(['release', token])
      return ok(undefined)
    },
    suspendForRpc(beforeHandoff) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      log.push(['finalCheck'])
      suspensions += 1
      if (script.finalProofFailureOnSuspend === suspensions) {
        const proofFailure = script.finalProofFailure ?? failure('budget-exhausted', 'synthetic-final-proof-failure')
        ended = true
        paused = false
        reservations.clear()
        onEnd?.(proofFailure.status, proofFailure.reason)
        return proofFailure
      }
      if (beforeHandoff !== undefined) {
        script.beforeHandoff?.()
        const released = beforeHandoff()
        if (released.status !== 'ok') return released
      }
      if (script.handoffExhaustedOnSuspend === suspensions) {
        // The final proof and output release above already succeeded; only the
        // continuation handoff itself is capped. The aggregate may keep its
        // proven page, but the public status must still be budget_exhausted.
        ended = true
        paused = false
        reservations.clear()
        onEnd?.('budget-exhausted', 'continuation-limit')
        return { status: 'handoff-exhausted', proofComplete: true, reason: 'continuation-limit' }
      }
      continuations += 1
      if (continuations > 16) {
        ended = true
        onEnd?.('budget-exhausted', 'continuation-limit')
        return { status: 'handoff-exhausted', proofComplete: true, reason: 'continuation-limit' }
      }
      paused = true
      log.push(['handoff'])
      return ok({ continuationToken: uuid() })
    },
    resumeForRpc() {
      if (ended || !paused) return failure('stale', 'reader-not-suspended')
      paused = false
      callGeneration += 1
      eventPagesThisCall = 0
      usageGroupKeysThisCall = 0
      memberCallUsed = 0
      return ok(undefined)
    },
    cancel() {
      if (ended) return
      ended = true
      paused = false
      reservations.clear()
      onEnd?.('stale', 'synthetic-cancel')
    },
    remainingReadWorkBreakdown() {
      if (ended || paused) return undefined
      const remaining = script.remainingReadWork ?? { sqlStatements: 64, rowsVisited: 2_048,
        materializedBytes: 1024 * 1024, keyBytes: 64 * 1024 }
      return { call: remaining, session: remaining, combined: remaining }
    },
    remainingReadWork() {
      return this.remainingReadWorkBreakdown()?.combined
    },
    beginPersonaProofGuard() { return () => undefined },
    chargeRead(cost, operation) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      log.push(['charge', cost])
      if (script.chargeFailure !== undefined) return script.chargeFailure
      return ok(operation())
    },
    createDirectoryLabelReader(scope) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      log.push(['labelReader', scope.readId])
      const enumerated = new Set()
      return ok({
        readId: scope.readId,
        directory: scope.directory,
        marker: scope.marker,
        enumerate(keys) {
          if (ended) return failure('stale', 'reader-not-active')
          for (const key of keys) {
            if (enumerated.size >= 256 && !enumerated.has(key)) return failure('budget-exhausted', 'directory-label-key-limit')
            enumerated.add(key)
          }
          return ok(undefined)
        },
        remainingMemberCapacity() {
          if (ended || paused) return undefined
          const call = Math.max(0, memberCallCapacity - memberCallUsed)
          return { call, session: memberSessionCapacity, combined: Math.min(call, memberSessionCapacity) }
        },
        readLabels(keys) {
          if (ended || paused) return failure('stale', 'reader-not-active')
          if (script.memberLabelFailure !== undefined) return script.memberLabelFailure
          for (const key of keys) if (!enumerated.has(key)) return failure('unavailable-probe', 'directory-label-key-unenumerated')
          memberCallUsed += keys.length
          const labels = keys.map((key) => {
            const name = script.memberNames?.[key] ?? key
            return { key, name, nameBytes: name === key ? 0 : stringBytes(name), proven: true }
          })
          for (const label of labels) memberLabels.set(label.key, label)
          return ok(labels)
        },
        verifyLabels(keys) {
          if (ended || paused) return failure('stale', 'reader-not-active')
          if (script.memberVerifyFailure !== undefined) return script.memberVerifyFailure
          for (const key of keys) if (!memberLabels.has(key)) return failure('unavailable-probe', 'directory-label-missing')
          return ok(undefined)
        },
        release() { memberLabels.clear() },
      })
    },
    readProject(projectKey, _cost, operation) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      log.push(['readProject', projectKey])
      try { return ok(operation({
        dashboardProjectMeta() { return { name: projectName, nameBytes: stringBytes(projectName) } },
        dashboardProcessingSummaryPage() { return { rows: [], hasMore: false } },
        dashboardReadEventPage(afterId, limit) {
          if (script.eventPagesPerCall !== undefined) {
            if (eventPagesThisCall >= script.eventPagesPerCall) {
              script.paginationBlocks?.push({ kind: 'event', callGeneration, afterId })
              throw paginationBudget
            }
            eventPagesThisCall += 1
            script.eventPageReads?.push({ callGeneration, afterId })
          }
          const pending = events.filter((row) => row.id > afterId)
          const count = Math.min(limit, eventPageLimit)
          return { rows: pending.slice(0, count), hasMore: pending.length > count }
        },
      })) } catch (error) {
        if (error === paginationBudget) return failure('budget-exhausted', 'persona-call-headroom')
        throw error
      }
    },
    readControl(_cost, operation) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      const control = {
        dashboardReadAttemptPage(afterId, limit) {
          log.push(['usageQuery', 'attempt', afterId, limit])
          const pending = controlRows.attempts.filter((row) => row.id > afterId)
          return { rows: pending.slice(0, limit), hasMore: pending.length > limit }
        },
        dashboardReadBillablePage(afterId, limit) {
          log.push(['usageQuery', 'billable', afterId, limit])
          const pending = controlRows.billable.filter((row) => row.id > afterId)
          return { rows: pending.slice(0, limit), hasMore: pending.length > limit }
        },
        dashboardReadCoveragePage(afterId, limit) {
          if (script.blockCoveragePage?.({ callGeneration, afterId }) === true) {
            script.paginationBlocks?.push({ kind: 'coverage', callGeneration, afterId })
            throw paginationBudget
          }
          const pending = controlRows.coverage.filter((row) => row.id > afterId)
          const value = { rows: pending.slice(0, limit), hasMore: pending.length > limit }
          script.afterCoverageRead?.()
          return value
        },
      }
      try { return ok(operation(control)) } catch (error) {
        if (error === paginationBudget) return failure('budget-exhausted', 'persona-call-headroom')
        throw error
      }
    },
    readManagedPage(_projectKey, status, after, limit) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      if (script.managedPageFailure !== undefined) {
        const pageFailure = script.managedPageFailure
        if (script.endOnManagedPageFailure === true) {
          ended = true
          paused = false
          reservations.clear()
          onEnd?.(pageFailure.status, pageFailure.reason)
        }
        return pageFailure
      }
      const values = status === 'approved' ? records : status === 'forgotten' ? forgottenRows : []
      const offset = after === undefined ? 0 : Number(after.id.split(':')[1])
      const items = values.slice(offset, offset + limit)
      const hasMore = offset + items.length < values.length
      const next = offset + items.length
      return ok({ items, ...(hasMore ? { nextCursor: { createdAt: next, id: `page:${next}` } } : {}), hasMore })
    },
    readRecentManagedPage(_projectKey, _after, limit) {
      if (ended || paused) return failure('stale', 'reader-not-active')
      return ok({ items: records.slice(0, limit), hasMore: false })
    },
    resolveRoot(_projectKey, id) {
      return ok({ state: 'visible', id, record: { id, content: `detail-${id}`, revision: 1, kind: 'fact', sourceIds: ['source-a'] } })
    },
    resolveManagedMemory(_projectKey, id, status) { return ok({ state: 'visible', id, status, record: { id, content: `detail-${id}` } }) },
    verifyCaptureEvent() { return ok({ state: script.captureVisibility ?? 'visible' }) },
    verifyRepeatedCaptureEvent() { return ok({ state: script.captureVisibility ?? 'visible' }) },
    verifyRepeatedCaptureEvent() { return ok({ state: script.captureVisibility ?? 'visible' }) },
    verifyEventMemory() { return ok({ state: script.memoryVisibility ?? 'visible' }) },
    get binding() { return binding },
  }
}

function projectRoot(projectsDirectory, projectKey) {
  const folder = path.join(projectsDirectory, projectKey)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'memory.db'), '')
  return folder
}

function syntheticSettings(overrides = {}) {
  return {
    mode: 'review', recallMaxTokens: 256, extractionEveryN: 1, extractionEnabled: false,
    automaticDailyTokens: 0, automaticDailyTasks: 0, manualDailyTokens: 0, manualDailyTasks: 0,
    includePersona: false, globalPersona: false, ...overrides,
  }
}

function fixture(script = {}, projectKeys = [PROJECT_A]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-aggregate-'))
  const projectsDirectory = path.join(root, 'projects')
  mkdirSync(projectsDirectory, { recursive: true })
  for (const projectKey of projectKeys) projectRoot(projectsDirectory, projectKey)
  const log = []
  const bindings = []
  const service = new DashboardAggregateService({
    projectDirectory: () => projectsDirectory,
    stateRoot: () => root,
    generationId: () => 'synthetic-generation',
    policyRevision: () => 'synthetic-policy-v1',
    excludedAgentPatterns: () => [],
    settings: () => syntheticSettings(script.settings),
    activeProjectKey: () => script.activeProjectKey,
    lastError: () => script.lastError,
    openReader(binding, onEnd) { bindings.push(binding); return ok(fakeReader(binding, onEnd, script, log)) },
  })
  return { root, projectsDirectory, service, log, bindings, close() { service.close(); rmSync(root, { recursive: true, force: true }) } }
}

function spyDirectoryReads() {
  const probe = opendirSync(os.tmpdir())
  const prototype = Object.getPrototypeOf(probe)
  probe.closeSync()
  const original = prototype.readSync
  let reads = 0
  prototype.readSync = function (...args) {
    reads += 1
    return original.apply(this, args)
  }
  return {
    get reads() { return reads },
    restore() { prototype.readSync = original },
  }
}

function installDirectorySequence(entries) {
  const probe = opendirSync(os.tmpdir())
  const prototype = Object.getPrototypeOf(probe)
  probe.closeSync()
  const original = prototype.readSync
  let index = 0
  prototype.readSync = function () {
    if (index >= entries.length) return null
    const entry = entries[index]
    index += 1
    return { name: entry.name, isDirectory: () => entry.isDirectory !== false }
  }
  return { restore() { prototype.readSync = original } }
}

function realFixture(managerOptions = {}, excludedAgentPatterns = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-aggregate-s1-'))
  const projectsDirectory = path.join(root, 'projects')
  const controlDirectory = path.join(root, 'control')
  mkdirSync(projectsDirectory, { recursive: true })
  mkdirSync(controlDirectory, { recursive: true })
  const store = openProjectStore(root, PROJECT_A)
  const control = new ControlLedger(controlDirectory)
  const manager = new DashboardReadSessionManager(managerOptions)
  const readers = []
  const service = new DashboardAggregateService({
    projectDirectory: () => projectsDirectory,
    stateRoot: () => root,
    generationId: () => 'synthetic-generation',
    policyRevision: () => 'synthetic-policy-v1',
    excludedAgentPatterns: () => excludedAgentPatterns,
    settings: () => syntheticSettings(),
    activeProjectKey: () => undefined,
    lastError: () => undefined,
    openReader(binding, onEnd) {
      const opened = DashboardVisibilityReadSession.open({ manager, control, stores: new Map([[PROJECT_A, store]]), binding, onEnd,
        openDirectoryMember(projectKey) {
          try {
            const memberStore = openProjectStoreReadOnly(root, projectKey)
            let released = false
            return ok({ store: memberStore, release() { if (released) return; released = true; try { memberStore.close() } catch { /* test teardown */ } } })
          } catch { return failure('unavailable-probe', 'directory-member-not-readable') }
        } })
      if (opened.status === 'ok') readers.push(opened.value)
      return opened
    },
  })
  return { root, projectsDirectory, controlDirectory, store, control, manager, readers, service,
    close() {
      service.close()
      for (const reader of [...readers].reverse()) reader.cancel()
      manager.close()
      control.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    } }
}

/**
 * Real Store + real S1 visibility reader + real aggregate service fixture for
 * the enumerated directory-label path. Every project owns a valid schema-9
 * database with a friendly project_meta name; member opens are read-only and
 * tracked so release on close/TTL/failure/cancel is observable.
 */
function labelledFixture(projects, { managerOptions = {}, activeProjectKey } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-aggregate-labels-'))
  const projectsDirectory = path.join(root, 'projects')
  const controlDirectory = path.join(root, 'control')
  mkdirSync(projectsDirectory, { recursive: true })
  mkdirSync(controlDirectory, { recursive: true })
  const stores = new Map()
  for (const project of projects) {
    stores.set(project.key, openProjectStore(root, project.key, { key: project.key, name: project.name, cwd: project.cwd ?? root }))
  }
  const control = new ControlLedger(controlDirectory)
  const manager = new DashboardReadSessionManager(managerOptions)
  const readers = []
  const handles = []
  let active = activeProjectKey
  const service = new DashboardAggregateService({
    projectDirectory: () => projectsDirectory,
    stateRoot: () => root,
    generationId: () => 'synthetic-generation',
    policyRevision: () => 'synthetic-policy-v1',
    excludedAgentPatterns: () => [],
    settings: () => syntheticSettings(),
    activeProjectKey: () => active,
    lastError: () => undefined,
    openReader(binding, onEnd) {
      const opened = DashboardVisibilityReadSession.open({ manager, control, stores: new Map(stores), binding, onEnd,
        openDirectoryMember(projectKey) {
          try {
            const memberStore = openProjectStoreReadOnly(root, projectKey)
            const handle = { key: projectKey, store: memberStore, released: false,
              release() { if (this.released) return; this.released = true; try { memberStore.close() } catch { /* test teardown */ } } }
            handles.push(handle)
            return ok(handle)
          } catch { return failure('unavailable-probe', 'directory-member-not-readable') }
        } })
      if (opened.status === 'ok') readers.push(opened.value)
      return opened
    },
  })
  return { root, projectsDirectory, controlDirectory, stores, control, manager, readers, handles, service,
    setActive(projectKey) { active = projectKey },
    close() {
      service.close()
      for (const reader of [...readers].reverse()) reader.cancel()
      manager.close()
      control.close()
      for (const store of stores.values()) { try { store.close() } catch { /* test teardown */ } }
      rmSync(root, { recursive: true, force: true })
    } }
}

function bootstrap(f, projectKeys = [PROJECT_A], activity = 'capture', date = DATE) {
  return f.service.read({ version: 1, action: 'bootstrap', projectKeys, range: {
    from: date, to: date, timeZone: 'UTC', activity,
  } })
}

function finishOverview(f, readId) {
  let result = f.service.read({ version: 1, action: 'overview', readId })
  let continuations = 0
  while (result.cursor !== undefined && continuations < 16) {
    result = f.service.read({ version: 1, action: 'continue', readId, cursor: result.cursor })
    continuations += 1
  }
  return { result, continuations }
}

function processingSourcePageNeed(limit, projectKey, afterSourceId, pendingCount) {
  return { sqlStatements: 1 + limit, rowsVisited: 2 * limit + 1,
    materializedBytes: (limit + 1) * 1_024 + limit * 256 + pendingCount * 512,
    keyBytes: Buffer.byteLength(projectKey, 'utf8') + Buffer.byteLength(afterSourceId ?? '', 'utf8') + 1_024 }
}

function maxProcessingSourceBatch(remaining, projectKey, afterSourceId, pendingCount, projectCount) {
  const reserve = 2 * (1 + projectCount)
  for (let limit = 15; limit >= 1; limit -= 1) {
    const need = processingSourcePageNeed(limit, projectKey, afterSourceId, pendingCount)
    const fits = (available) => need.sqlStatements + reserve <= available.sqlStatements &&
      need.rowsVisited + reserve <= available.rowsVisited &&
      need.materializedBytes <= available.materializedBytes && need.keyBytes <= available.keyBytes
    if (fits(remaining.call) && fits(remaining.session)) return limit
  }
  return 0
}

function assertObservedReadCost(snapshot, label) {
  for (const scope of ['call', 'session']) {
    for (const dimension of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes']) {
      assert.equal(snapshot.before[scope][dimension] - snapshot.after[scope][dimension], snapshot.cost[dimension],
        `${label}: the real source-page callback observes its paired ${scope} ${dimension} charge`)
    }
  }
}

function observeProcessingSourcePages(f, state) {
  const reader = f.readers.at(-1)
  const sourcePageCalls = []
  const budgetSnapshots = []
  const projectReadCosts = []
  let rpcGeneration = 0
  let activeProjectRead
  const readWorkSnapshot = () => {
    const remaining = reader.remainingReadWorkBreakdown()
    return remaining === undefined ? undefined : { call: { ...remaining.call }, session: { ...remaining.session } }
  }
  const originalResume = reader.resumeForRpc.bind(reader)
  reader.resumeForRpc = () => {
    const result = originalResume()
    if (result.status === 'ok') rpcGeneration += 1
    return result
  }
  const originalReadProject = reader.readProject.bind(reader)
  reader.readProject = (projectKey, cost, operation) => {
    const previous = activeProjectRead
    const before = readWorkSnapshot()
    projectReadCosts.push({ projectKey, cost: { ...cost }, rpcGeneration, before })
    activeProjectRead = { projectKey, cost: { ...cost }, before }
    try { return originalReadProject(projectKey, cost, operation) }
    finally { activeProjectRead = previous }
  }
  const originalSourcePage = f.store.dashboardProcessingSourcePage.bind(f.store)
  f.store.dashboardProcessingSourcePage = (jobId, afterSourceId, limit) => {
    sourcePageCalls.push({ jobId, afterSourceId, limit, rpcGeneration })
    const after = activeProjectRead === undefined ? undefined : readWorkSnapshot()
    if (after !== undefined && activeProjectRead !== undefined) budgetSnapshots.push({
      before: activeProjectRead.before, after, cost: activeProjectRead.cost, projectKey: activeProjectRead.projectKey,
      afterSourceId, pendingCount: state.processingScan.pending.length })
    return originalSourcePage(jobId, afterSourceId, limit)
  }
  return { sourcePageCalls, budgetSnapshots, projectReadCosts }
}

test('bounded overview drains 30 capture rows and 7 approved memories within the continuation budget', () => {
  const captures = Array.from({ length: 30 }, (_unused, index) => captureEvent(index + 1))
  const f = fixture({ events: captures, approved: approvedRows(7) })
  try {
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result, continuations } = finishOverview(f, started.readId)
    assert.equal(result.status, 'ok')
    assert.equal(result.complete, true)
    assert.equal(result.metrics.captures.value, 30)
    assert.equal(result.metrics.captures.relation, 'exact')
    assert.equal(result.metrics.effectiveMemories.value, 7)
    assert.ok(continuations < 16, 'the 15-row page plus sentinel drains ordinary data within the session cap')
    const reserveIndex = f.log.findIndex(([kind, bytes]) => kind === 'reserve' && bytes === 256 * 1024)
    const firstProjectReadIndex = f.log.findIndex(([kind]) => kind === 'readProject')
    const finalCheckIndex = f.log.findIndex(([kind]) => kind === 'finalCheck')
    const outputReleaseIndex = f.log.findIndex(([kind]) => kind === 'release')
    assert.ok(reserveIndex >= 0 && reserveIndex < firstProjectReadIndex)
    assert.ok(finalCheckIndex >= 0 && finalCheckIndex < outputReleaseIndex,
      'the bounded output lease is released after the final proof check and before handoff')
  } finally { f.close() }

  const direct = realFixture()
  try {
    for (let index = 0; index < 7; index += 1) direct.store.addMemory({
      content: `Synthetic direct empty-source memory ${index + 1}.`, status: 'approved',
      ...(index === 0 ? { source: 'review', reason: '' } : {}),
    })
    const started = bootstrap(direct)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(direct, started.readId)
    assert.equal(result.complete, true, 'trusted direct empty-source approvals remain exact')
    assert.equal(result.metrics.effectiveMemories.value, 7)
    assert.equal(result.metrics.effectiveMemories.relation, 'exact')
  } finally { direct.close() }

  const unknown = fixture({ approved: [...approvedRows(2),
    { state: 'visible', summary: { id: 'empty-unknown', sourceMessageIds: [] } },
    { state: 'visible', summary: { id: 'missing-source-field' } },
    { state: 'visible', summary: { id: 'malformed-source-field', sourceMessageIds: '[]' } },
  ] })
  try {
    const started = bootstrap(unknown)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(unknown, started.readId)
    assert.equal(result.complete, false)
    assert.equal(result.metrics.effectiveMemories.value, 2,
      'unknown empty, missing, or malformed source summaries do not inflate the two proven known rows')
    assert.equal(result.metrics.effectiveMemories.relation, 'lower_bound')
  } finally { unknown.close() }
})

test('complete small-library metrics match the synthetic reference and keep their units', () => {
  const captures = [
    captureEvent(1, { fingerprint: 'question-a' }), captureEvent(2, { fingerprint: 'question-a' }),
    captureEvent(3, { fingerprint: 'question-a' }), captureEvent(4, { fingerprint: 'question-b' }),
  ]
  const f = fixture({ events: captures })
  try {
    const started = bootstrap(f)
    const { result } = finishOverview(f, started.readId)
    const referenceGroups = new Set(captures.filter((row) => row.fingerprint !== undefined)
      .map((row) => row.fingerprint).filter((value, _index, values) => values.filter((item) => item === value).length > 1))
    assert.equal(result.complete, true)
    assert.equal(result.metrics.captures.value, captures.length)
    assert.equal(result.metrics.repeatedTotal.value, referenceGroups.size, 'three repetitions form one repeated question group')
  } finally { f.close() }
})

test('recall activity counts successful results in the heatmap and keeps requests separate', () => {
  const events = [event('recall_returned', 1), event('recall_returned', 2), event('recall_no_result', 3),
    event('initial_approval', 4), event('approve', 5), event('forget', 6)]
  const f = fixture({ events })
  try {
    const started = bootstrap(f, [PROJECT_A], 'recall')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.complete, true, 'known approve and forget events do not make overview scans incomplete')
    assert.equal(result.metrics.recallRequests.value, 3)
    assert.equal(result.metrics.recallResults.value, 2)
    assert.equal(result.activity[0].count.value, 2)
    assert.equal(result.metrics.initialApprovals.value, 1)
  } finally { f.close() }

  const approval = fixture({ events })
  try {
    const started = bootstrap(approval, [PROJECT_A], 'initial_approval')
    const { result } = finishOverview(approval, started.readId)
    assert.equal(result.complete, true, 'review mutation events remain non-activity in the approval view')
    assert.equal(result.metrics.initialApprovals.value, 1)
    assert.equal(result.activity[0].count.value, 1,
      'approve and forget do not duplicate genuine initial_approval activity')
  } finally { approval.close() }

  for (const { name, row } of [
    { name: 'unknown event type', row: event('future_review', 1) },
    { name: 'malformed event key', row: event('approve', 1, { typeBytes: 0 }) },
  ]) {
    const uncertain = fixture({ events: [row] })
    try {
      const started = bootstrap(uncertain)
      const { result } = finishOverview(uncertain, started.readId)
      assert.equal(result.complete, false, `${name} still makes the overview incomplete`)
      assert.equal(result.reason, 'bounded-scan-incomplete', `${name} remains explicitly fail-closed`)
    } finally { uncertain.close() }
  }
})

test('unresolved injection evidence leaves an explicit lower bound instead of exact zero', () => {
  const row = event('inject_prepared', 1, { memoryIds: ['a', 'b', 'c', 'd', 'e'], tokens: 15, count: 5 })
  const f = fixture({ events: [row] })
  try {
    const started = bootstrap(f, [PROJECT_A], 'injection')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.complete, false)
    assert.equal(result.metrics.preparedInjectionEvents.value, 0)
    assert.equal(result.metrics.preparedInjectionEvents.relation, 'lower_bound')
  } finally { f.close() }
})

test('final boundary proof failures suppress aggregate and drilldown payloads', () => {
  const cases = [
    { name: 'overview probe budget', script: { events: [captureEvent(1)], finalProofFailureOnSuspend: 2,
      finalProofFailure: failure('budget-exhausted', 'final-probe-budget') },
      run: (f, readId) => f.service.read({ version: 1, action: 'overview', readId }) },
    { name: 'library proof cache loss', script: { approved: approvedRows(1), finalProofFailureOnSuspend: 2,
      finalProofFailure: failure('budget-exhausted', 'visibility-proof-cache-lost') },
      run: (f, readId) => f.service.read({ version: 1, action: 'library', readId,
        projectKey: PROJECT_A, status: 'approved', limit: 3 }) },
    { name: 'detail proof cache loss', script: { finalProofFailureOnSuspend: 2,
      finalProofFailure: failure('budget-exhausted', 'visibility-proof-cache-lost') },
      run: (f, readId) => f.service.read({ version: 1, action: 'detail', readId, projectKey: PROJECT_A,
        target: { kind: 'memory', status: 'approved', id: 'memory-a' } }) },
    { name: 'overview page proof cache loss', script: {
      managedPageFailure: failure('budget-exhausted', 'visibility-proof-cache-lost'), endOnManagedPageFailure: true,
    }, run: (f, readId) => finishOverview(f, readId).result },
  ]
  for (const item of cases) {
    const f = fixture(item.script)
    try {
      const started = bootstrap(f)
      const result = item.run(f, started.readId)
      assert.equal(result.status, 'budget_exhausted', item.name)
      assert.equal(result.complete, false, item.name)
      assert.equal(result.metrics, undefined, item.name)
      assert.equal(result.records, undefined, item.name)
      assert.equal(result.record, undefined, item.name)
      assert.equal(result.events, undefined, item.name)
      if (item.name === 'overview page proof cache loss') {
        assert.equal(result.reason, 'visibility-proof-cache-lost', item.name)
      }
      assert.equal(f.service.states.has(started.readId), false, item.name)
    } finally { f.close() }
  }
})

test('directory budget rejection performs no raw scan before charge', () => {
  const spy = spyDirectoryReads()
  let f
  try {
    f = fixture({ remainingReadWork: { sqlStatements: 64, rowsVisited: 0, materializedBytes: 0, keyBytes: 0 } })
    const result = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.reason, 'project-directory-budget')
    assert.equal(spy.reads, 0, 'capacity rejection must happen before the directory cursor advances')
    assert.equal(f.log.some(([kind]) => kind === 'charge'), false)
    assert.equal(f.service.directoryStates.size, 0)
  } finally {
    spy.restore()
    f?.close()
  }
})

test('directory charge rejection before the callback performs no raw scan', () => {
  const spy = spyDirectoryReads()
  let f
  try {
    f = fixture({ chargeFailure: failure('budget-exhausted', 'synthetic-charge-reject') })
    const result = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.reason, 'synthetic-charge-reject')
    assert.equal(spy.reads, 0, 'charge admission must run before Dir.readSync')
    assert.equal(f.log.some(([kind]) => kind === 'charge'), true)
    assert.equal(f.service.directoryStates.size, 0)
  } finally {
    spy.restore()
    f?.close()
  }
})

test('a call-capacity boundary keeps a consumed directory page resumable instead of dropping the session', () => {
  const f = realFixture()
  let sequence
  try {
    const validKey = 'directory-resume-project'
    projectRoot(f.projectsDirectory, validKey)
    sequence = installDirectorySequence([
      ...Array.from({ length: 254 }, (_unused, index) => ({ name: `invalid-entry-${index}`, isDirectory: true })),
      { name: validKey, isDirectory: true },
    ])
    const first = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial')
    assert.equal(first.complete, false)
    assert.ok(first.readId)
    assert.ok(first.cursor, 'a call-capacity boundary must expose a resumable cursor')
    let page = first
    let steps = 0
    while (page.status === 'partial' && page.cursor !== undefined && steps < 4) {
      page = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: page.cursor })
      steps += 1
    }
    assert.equal(page.status, 'selection_required')
    assert.equal(page.complete, true)
    assert.ok(page.projects.some((project) => project.key === validKey))
  } finally {
    sequence?.restore()
    f.close()
  }
})

test('project selection suppresses its page when the final S1 proof is incomplete', () => {
  const f = fixture({ finalProofFailureOnSuspend: 1,
    finalProofFailure: failure('budget-exhausted', 'final-probe-budget') })
  try {
    const result = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.complete, false)
    assert.equal(result.projects, undefined)
    assert.equal(f.service.directoryStates.size, 0)
  } finally { f.close() }
})

test('project selection keeps its proven page but publishes budget_exhausted when only handoff is capped', () => {
  const f = fixture({ handoffExhaustedOnSuspend: 1 })
  try {
    const result = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(result.status, 'budget_exhausted', 'the public result uses the underscore status')
    assert.equal(result.complete, false)
    assert.deepEqual(result.projects, [{ key: PROJECT_A, name: PROJECT_A }],
      'a pure handoff-cap continuation may keep the page that already passed the final proof')
    assert.equal(result.cursor, undefined)
    assert.equal(result.reason, 'continuation-limit')
    assert.ok(f.log.some(([kind]) => kind === 'release'),
      'the output reservation is released before the capped handoff is reported')
    assert.equal(f.service.directoryStates.size, 0, 'the directory state is cleaned once')
  } finally { f.close() }
})

test('project selection rechecks the directory boundary immediately before handoff', () => {
  let f
  f = fixture({ beforeHandoff() { projectRoot(f.projectsDirectory, 'project-added-at-boundary') } })
  try {
    const result = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(result.status, 'stale')
    assert.equal(result.reason, 'project-directory-changed')
    assert.equal(result.projects, undefined)
  } finally { f.close() }
})

test('real aggregate and S1 boundary discard payloads on final probe budget failure or lost memo proof', () => {
  for (const failureKind of ['final-probe-budget', 'visibility-proof-cache-lost', 'direct-origin-final-probe']) {
    const directOriginCase = failureKind === 'direct-origin-final-probe'
    const f = realFixture(directOriginCase ? { monotonicNow: () => 0 } : {})
    const restorers = []
    const innerErrors = []
    let originReads = 0
    let injections = 0
    const wrap = (target, method, invoke) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, method)
      const original = target[method]
      Object.defineProperty(target, method, { configurable: true, writable: true,
        enumerable: descriptor?.enumerable ?? false, value: function (...args) {
          try { return invoke.call(this, original, args) }
          catch (error) {
            if (innerErrors.length < 4) innerErrors.push({ method, message: String(error).slice(0, 512) })
            throw error
          }
        } })
      restorers.push(() => {
        if (descriptor === undefined) delete target[method]
        else Object.defineProperty(target, method, descriptor)
      })
    }
    try {
      if (directOriginCase) {
        f.store.addMemory({ content: 'Synthetic direct-origin summary must not escape a failed final probe.',
          kind: 'fact', confidence: 0.8, status: 'approved', reason: '' })
        wrap(f.store, 'dashboardVisibilityDirectCreationOrigin', function (original, args) {
          originReads += 1
          return Reflect.apply(original, this, args)
        })
      }
      const started = bootstrap(f)
      assert.equal(started.status, 'ok')
      assert.ok(started.readId)
      assert.equal(f.readers.length, 1)
      const reader = f.readers[0]
      assert.ok(reader)
      wrap(reader, 'suspendForRpc', function (original, args) {
        // Early genuine yields remain genuine yields. The fault is armed only
        // once the real nonempty origin proof has reached a publication call.
        if (directOriginCase && (originReads === 0 || injections > 0)) return Reflect.apply(original, this, args)
        injections += 1
        if (failureKind === 'visibility-proof-cache-lost') {
          this.memoProofStateLost = true
          return Reflect.apply(original, this, args)
        }
        const descriptor = Object.getOwnPropertyDescriptor(f.manager, 'probeControl')
        Object.defineProperty(f.manager, 'probeControl', { configurable: true, writable: true,
          value: () => failure(directOriginCase ? 'unavailable-probe' : 'budget-exhausted', failureKind) })
        try { return Reflect.apply(original, this, args) }
        finally {
          if (descriptor === undefined) delete f.manager.probeControl
          else Object.defineProperty(f.manager, 'probeControl', descriptor)
        }
      })

      let result = f.service.read({ version: 1, action: 'overview', readId: started.readId })
      let continuations = 0
      while (directOriginCase && injections === 0 && result.cursor !== undefined && continuations < 16) {
        result = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
        continuations += 1
      }
      const observed = JSON.stringify({ originReads, injections, continuations, innerErrors })
      assert.deepEqual(innerErrors, [], observed)
      assert.equal(injections, 1, observed)
      assert.equal(result.status, directOriginCase ? 'unavailable' : 'budget_exhausted', observed)
      assert.equal(result.reason, failureKind, 'the actual final boundary supplies the failure: ' + observed)
      if (directOriginCase) assert.equal(originReads, 1, 'the nonempty direct-origin branch reached final publication: ' + observed)
      assert.equal(result.complete, false, failureKind)
      for (const field of ['metrics', 'dimensions', 'scopedDimensions', 'identity', 'usage', 'coverage', 'activity', 'records',
        'events', 'record', 'itemState', 'processing', 'page', 'cursor']) {
        assert.equal(result[field], undefined, `${failureKind}: no ${field} may escape the failed publication`)
      }
      assert.equal(f.service.states.has(started.readId), false, failureKind)
      assert.equal(f.manager.stats().sessions, 0, failureKind)
    } finally {
      try { for (const restore of restorers.reverse()) restore() }
      finally { f.close() }
    }
  }
})

test('real S1 final proof success may return a partial lower bound when continuation handoff is capped', () => {
  const f = realFixture({ limits: { maxContinuations: 1 } })
  try {
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    assert.ok(started.readId)
    assert.equal(f.readers.length, 1)
    const result = f.service.read({ version: 1, action: 'overview', readId: started.readId })
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.complete, false)
    assert.equal(result.metrics.captures.value, 0)
    assert.equal(result.metrics.captures.relation, 'lower_bound')
    assert.equal(result.cursor, undefined)
    assert.equal(f.manager.stats().sessions, 0)
  } finally { f.close() }
})

test('coverage combines adjacent closed intervals and treats interrupted windows as partial at the bound asOf', () => {
  const day = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)
  const start = Date.parse(`${day}T00:00:00.000Z`)
  const middle = start + 12 * 60 * 60 * 1000
  const end = start + DAY_MS
  const covered = fixture({ coverage: [
    { id: 1, startedAt: start, endedAt: middle, status: 'closed', statusBytes: 6, policyRevision: 'p1', policyRevisionBytes: 2 },
    { id: 2, startedAt: middle, endedAt: end, status: 'closed', statusBytes: 6, policyRevision: 'p1', policyRevisionBytes: 2 },
  ] })
  const interrupted = fixture({ coverage: [
    { id: 1, startedAt: start, endedAt: end, status: 'closed', statusBytes: 6, policyRevision: 'p1', policyRevisionBytes: 2 },
    { id: 2, startedAt: middle, endedAt: null, status: 'interrupted', statusBytes: 11, policyRevision: 'p1', policyRevisionBytes: 2 },
  ] })
  let futureNow
  const currentDay = new Date(Date.now()).toISOString().slice(0, 10)
  const currentStart = Date.parse(`${currentDay}T00:00:00.000Z`)
  const fixedAsOf = fixture({ coverage: [
    { id: 1, startedAt: currentStart, endedAt: null, status: 'active', statusBytes: 6, policyRevision: 'p1', policyRevisionBytes: 2 },
  ], afterCoverageRead() { if (futureNow !== undefined) Date.now = () => futureNow } })
  const originalNow = Date.now
  try {
    const coveredStart = bootstrap(covered, [PROJECT_A], 'capture', day)
    const coveredState = covered.service.states.get(coveredStart.readId)
    coveredState.projects.forEach((project) => { project.eventDone = true; project.approved.done = true; project.candidate.done = true; project.forgotten.done = true })
    coveredState.overview.attemptsDone = true
    coveredState.overview.billableDone = true
    coveredState.processingScan.done = true
    coveredState.page.done = true
    const coveredResult = covered.service.read({ version: 1, action: 'overview', readId: coveredStart.readId })
    assert.equal(coveredResult.activity[0].coverage, 'covered')

    const interruptedStart = bootstrap(interrupted, [PROJECT_A], 'capture', day)
    const interruptedState = interrupted.service.states.get(interruptedStart.readId)
    interruptedState.projects.forEach((project) => { project.eventDone = true; project.approved.done = true; project.candidate.done = true; project.forgotten.done = true })
    interruptedState.overview.attemptsDone = true
    interruptedState.overview.billableDone = true
    interruptedState.processingScan.done = true
    interruptedState.page.done = true
    const interruptedResult = interrupted.service.read({ version: 1, action: 'overview', readId: interruptedStart.readId })
    assert.equal(interruptedResult.activity[0].coverage, 'partial', 'an interrupted interval prevents a covered result')

    const fixedStart = bootstrap(fixedAsOf, [PROJECT_A], 'capture', currentDay)
    const fixedState = fixedAsOf.service.states.get(fixedStart.readId)
    fixedState.projects.forEach((project) => { project.eventDone = true; project.approved.done = true; project.candidate.done = true; project.forgotten.done = true })
    fixedState.overview.attemptsDone = true
    fixedState.overview.billableDone = true
    fixedState.processingScan.done = true
    fixedState.page.done = true
    futureNow = fixedState.binding.asOf + DAY_MS
    Date.now = originalNow
    let fixedResult
    try { fixedResult = fixedAsOf.service.read({ version: 1, action: 'overview', readId: fixedStart.readId }) }
    finally { Date.now = originalNow }
    assert.equal(fixedResult.activity[0].coverage, 'partial', 'coverage is evaluated against the read binding asOf, not a later wall clock')
  } finally { Date.now = originalNow; covered.close(); interrupted.close(); fixedAsOf.close() }
})

test('coverage does not confirm a covered day until every coverage page has been scanned', () => {
  const start = Date.parse(`${DATE}T00:00:00.000Z`)
  const middle = start + DAY_MS / 2
  const end = start + DAY_MS
  const coverage = Array.from({ length: 15 }, (_unused, index) => ({ id: index + 1, startedAt: start, endedAt: end,
    status: 'closed', statusBytes: 6, policyRevision: 'p1', policyRevisionBytes: 2 }))
  coverage.push({ id: 16, startedAt: middle, endedAt: null, status: 'interrupted', statusBytes: 11,
    policyRevision: 'p1', policyRevisionBytes: 2 })
  const paginationBlocks = []
  let blockedCoverageGeneration
  const f = fixture({ coverage, paginationBlocks,
    blockCoveragePage: ({ callGeneration, afterId }) => {
      if (afterId !== 15) return false
      if (blockedCoverageGeneration === undefined) blockedCoverageGeneration = callGeneration
      return callGeneration === blockedCoverageGeneration
    } })
  try {
    const started = bootstrap(f)
    const state = f.service.states.get(started.readId)
    state.projects.forEach((project) => { project.eventDone = true; project.approved.done = true; project.candidate.done = true; project.forgotten.done = true })
    state.overview.attemptsDone = true
    state.overview.billableDone = true
    state.processingScan.done = true
    state.page.done = true

    const firstPage = f.service.read({ version: 1, action: 'overview', readId: started.readId })
    assert.equal(firstPage.activity[0].coverage, 'unknown')
    assert.equal(firstPage.coverage.status, 'unknown')
    assert.equal(firstPage.coverage.coveredDays.relation, 'unknown')
    assert.ok(firstPage.cursor)
    assert.equal(paginationBlocks.length, 1)
    assert.equal(paginationBlocks[0].kind, 'coverage')
    assert.equal(paginationBlocks[0].callGeneration, blockedCoverageGeneration)
    assert.equal(paginationBlocks[0].afterId, 15,
      'the second coverage page is explicitly blocked until the same reader resumes')

    // The fixture explicitly blocks only the second coverage page during this
    // call. Keep the same reader and one-shot cursor until that page resumes,
    // within the original continuation cap and without widening the budget.
    let finalPage = firstPage
    let continuations = 0
    while (finalPage.coverage.status === 'unknown' && continuations < 16) {
      assert.ok(finalPage.cursor)
      finalPage = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor: finalPage.cursor })
      continuations += 1
    }
    assert.ok(continuations < 16, 'coverage completes within the original continuation cap')
    assert.equal(continuations, 1, 'the retained coverage cursor resumes on the next RPC')
    assert.equal(finalPage.activity[0].coverage, 'partial')
    assert.equal(finalPage.coverage.status, 'partial')
    assert.equal(finalPage.coverage.coveredDays.relation, 'exact')
    assert.equal(finalPage.coverage.coveredDays.value, 0)
  } finally { f.close() }
})

test('unknown attempt state and missing usage stay unknown while known fields remain a lower bound; other projects are skipped', () => {
  const attempts = [
    { id: 'a-selected', idBytes: stringBytes('a-selected'), projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), createdAt: EVENT_TIME,
      state: 'uncertain_remote', stateBytes: stringBytes('uncertain_remote'), provider: 'mock', providerBytes: 4, model: 'mock-model', modelBytes: 10,
      inputTokens: 100, outputTokens: null, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      reasoningTokens: null, costMicros: null },
    { id: 'z-other-project', idBytes: stringBytes('z-other-project'), projectKey: PROJECT_B, projectKeyBytes: stringBytes(PROJECT_B), createdAt: EVENT_TIME,
      state: 'complete', stateBytes: 8, provider: 'mock', providerBytes: 4, model: 'mock-model', modelBytes: 10,
      inputTokens: 500, outputTokens: 500, cachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, costMicros: 0 },
  ]
  const billable = [{ id: 'other-billable', idBytes: stringBytes('other-billable'), projectKey: PROJECT_B, projectKeyBytes: stringBytes(PROJECT_B),
    createdAt: EVENT_TIME, state: 'complete', stateBytes: 8, label: 'capture', labelBytes: 7, actualTokens: 999 }]
  const f = fixture({ attempts, billable }, [PROJECT_A, PROJECT_B])
  try {
    const started = bootstrap(f)
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.usage.attempts.calls.value, 1)
    assert.equal(result.usage.attempts.knownCalls.value, 0)
    assert.equal(result.usage.attempts.unknownCalls.value, 1)
    assert.equal(result.usage.attempts.inputTokens.value, 100)
    assert.equal(result.usage.attempts.inputTokens.relation, 'lower_bound')
    assert.equal(result.usage.billable.calls.value, 0)
    assert.equal(result.usage.billable.calls.relation, 'exact')
    assert.equal(result.complete, true)
  } finally { f.close() }
})

test('uncertain attempt values stay a lower bound even when all usage fields are present', () => {
  const attempts = [{
    id: 'a-uncertain-all-fields', idBytes: stringBytes('a-uncertain-all-fields'),
    projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), createdAt: EVENT_TIME,
    state: 'uncertain_remote', stateBytes: stringBytes('uncertain_remote'),
    provider: 'mock', providerBytes: 4, model: 'mock-model', modelBytes: 10,
    inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costMicros: 0,
  }]
  const f = fixture({ attempts })
  try {
    const started = bootstrap(f)
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.usage.attempts.calls.relation, 'exact')
    assert.equal(result.usage.attempts.knownCalls.value, 0)
    assert.equal(result.usage.attempts.unknownCalls.value, 1)
    assert.equal(result.usage.attempts.inputTokens.value, 100)
    assert.equal(result.usage.attempts.inputTokens.relation, 'lower_bound')
    assert.equal(result.usage.attempts.inputTokens.reason, 'usage-uncertain-lower-bound')
    assert.equal(result.usage.billable.calls.value, 0)
    assert.equal(result.usage.billable.calls.relation, 'exact')
    assert.equal(result.complete, true)
  } finally { f.close() }
})

test('a completed independent billable scan stays exact when the attempt scan is incomplete', () => {
  const attempts = [{
    id: 'a-invalid-cursor', idBytes: stringBytes('a-invalid-cursor') + 1,
    projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), createdAt: EVENT_TIME,
    state: 'complete', stateBytes: 8, provider: 'mock', providerBytes: 4, model: 'mock-model', modelBytes: 10,
    inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costMicros: 0,
  }]
  const f = fixture({ attempts })
  try {
    const started = bootstrap(f)
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.complete, false)
    assert.equal(result.usage.attempts.calls.relation, 'lower_bound')
    assert.equal(result.usage.billable.calls.value, 0)
    assert.equal(result.usage.billable.calls.relation, 'exact',
      'a complete empty billable scan is independent of an incomplete attempt scan')
  } finally { f.close() }
})

test('overview focus is validated before mutation and cannot widen the bound project scope', () => {
  const f = fixture()
  try {
    const unknown = f.service.read({ version: 1, action: 'overview', readId: randomUUID(), focusProjectKey: PROJECT_A })
    assert.equal(unknown.status, 'stale')
    assert.equal(unknown.reason, 'unknown-or-finished-read')

    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const crossScope = f.service.read({ version: 1, action: 'overview', readId: started.readId,
      focusProjectKey: 'aggregate-not-selected' })
    assert.equal(crossScope.status, 'scope_limit')
    assert.equal(crossScope.reason, 'project-not-selected')

    const valid = f.service.read({ version: 1, action: 'overview', readId: started.readId, focusProjectKey: PROJECT_A })
    assert.notEqual(valid.status, 'scope_limit')
    assert.equal(valid.readId, started.readId)
  } finally { f.close() }
})

test('normal project paging reaches project 16, reuses only the old listing scope, and rejects directory mutation', () => {
  // The enumerated label path meters four proved members per call, so reaching
  // project 16 takes four labeled pages instead of one unlabeled 15-row page.
  const projectKeys = Array.from({ length: 16 }, (_unused, index) => `project-${String(index + 1).padStart(2, '0')}`)
  const f = fixture({}, [])
  try {
    for (const projectKey of projectKeys) projectRoot(f.projectsDirectory, projectKey)
    const first = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial')
    assert.equal(first.complete, false)
    assert.ok(first.readId)
    assert.ok(first.cursor)
    const listed = []
    let page = first
    let pages = 0
    while (page.cursor !== undefined && pages < 16) {
      assert.ok(page.projects.length <= 4, 'the per-call project budget caps a labeled page at four members')
      assert.equal(page.readId, first.readId, 'directory paging keeps the same readId')
      listed.push(...page.projects.map((project) => project.key))
      page = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: page.cursor })
      pages += 1
    }
    assert.equal(page.status, 'selection_required')
    assert.equal(page.complete, true)
    assert.ok(page.projects.length <= 4)
    listed.push(...page.projects.map((project) => project.key))
    assert.deepEqual([...listed].sort(), [...projectKeys].sort())
    assert.deepEqual(f.bindings[0].projectKeys, [], 'directory selection owns a control-only S1 scope')
    const selectedKey = listed[0]
    const selected = f.service.read({ version: 1, action: 'bootstrap', readId: first.readId,
      projectKeys: [selectedKey], range: { from: DATE, to: DATE, timeZone: 'UTC', activity: 'capture' } })
    assert.equal(selected.status, 'ok')
    assert.notEqual(selected.readId, first.readId, 'changing from list scope to project scope starts a fresh bounded read')
    assert.deepEqual(f.bindings[1].projectKeys, [selectedKey])
    assert.equal(f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor }).status, 'stale')

    const changed = f.service.read({ version: 1, action: 'bootstrap' })
    const newKey = 'project-added-after-listing'
    projectRoot(f.projectsDirectory, newKey)
    const forcedNow = new Date(Date.now() + 1_000)
    utimesSync(f.projectsDirectory, forcedNow, forcedNow)
    const invalidated = f.service.read({ version: 1, action: 'continue', readId: changed.readId, cursor: changed.cursor })
    assert.equal(invalidated.status, 'stale')
    assert.equal(invalidated.reason, 'project-directory-changed')
  } finally { f.close() }
})

test('library and event detail pages keep their own view across single-use continuations', () => {
  const library = fixture({ approved: approvedRows(8) })
  const events = [captureEvent(1), captureEvent(2)]
  const detail = fixture({ events, eventPageLimit: 1 })
  const partialLibrary = realFixture({ limits: { perCall: { sqlStatements: 20 } } })
  try {
    const libraryStart = bootstrap(library)
    const firstLibrary = library.service.read({ version: 1, action: 'library', readId: libraryStart.readId,
      projectKey: PROJECT_A, status: 'approved', limit: 3 })
    assert.equal(firstLibrary.view, 'library')
    assert.equal(firstLibrary.records.length, 3)
    const secondLibrary = library.service.read({ version: 1, action: 'continue', readId: libraryStart.readId, cursor: firstLibrary.cursor })
    assert.equal(secondLibrary.view, 'library')
    assert.equal(secondLibrary.records.length, 3)

    const retrySources = Array.from({ length: 26 }, (_unused, index) => partialLibrary.store.recordL0({
      sessionId: `library-limit-source-${index}`, role: 'user', content: `Synthetic library limit source ${index}.`,
    }))
    const candidateA = partialLibrary.store.addMemory({
      content: 'Synthetic first candidate for a changing library limit.', kind: 'fact', confidence: 0.9,
      status: 'candidate', sourceMessageIds: retrySources.slice(0, 13), sourceVerified: true,
    }).record
    const candidateB = partialLibrary.store.addMemory({
      content: 'Synthetic second candidate for a changing library limit.', kind: 'fact', confidence: 0.9,
      status: 'candidate', sourceMessageIds: retrySources.slice(13), sourceVerified: true,
    }).record
    const rawPageReads = []
    const metadataReads = new Map()
    const sourceIdentityReads = new Map()
    const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
    const originalRawPage = partialLibrary.store.dashboardVisibilityMemoryPage.bind(partialLibrary.store)
    partialLibrary.store.dashboardVisibilityMemoryPage = (...args) => {
      rawPageReads.push(args[2])
      return originalRawPage(...args)
    }
    const originalManagedMemory = partialLibrary.store.dashboardManagedMemory.bind(partialLibrary.store)
    partialLibrary.store.dashboardManagedMemory = (id, ...args) => {
      increment(metadataReads, id)
      return originalManagedMemory(id, ...args)
    }
    const originalIdentity = partialLibrary.store.dashboardVisibilitySourceIdentity.bind(partialLibrary.store)
    partialLibrary.store.dashboardVisibilitySourceIdentity = (id) => {
      increment(sourceIdentityReads, id)
      return originalIdentity(id)
    }
    const partialStart = bootstrap(partialLibrary)
    assert.equal(partialStart.status, 'ok')
    const firstBudgetStop = partialLibrary.service.read({ version: 1, action: 'library', readId: partialStart.readId,
      projectKey: PROJECT_A, status: 'candidate', limit: 3 })
    assert.equal(firstBudgetStop.status, 'budget_exhausted')
    assert.ok(firstBudgetStop.cursor)
    assert.ok(sourceIdentityReads.size > 0 && sourceIdentityReads.size < 13,
      'the library response pauses after paying only part of the first candidate proof')
    assert.equal(metadataReads.size, 1)
    let smallerLimit = firstBudgetStop
    let resumedLimitCalls = 0
    while (smallerLimit.status === 'budget_exhausted' && resumedLimitCalls < 8) {
      smallerLimit = partialLibrary.service.read({ version: 1, action: 'library', readId: partialStart.readId,
        projectKey: PROJECT_A, status: 'candidate', limit: 1 })
      resumedLimitCalls += 1
    }
    assert.equal(smallerLimit.status, 'ok')
    assert.equal(smallerLimit.complete, false)
    assert.equal(smallerLimit.records.length, 1, 'the changed limit returns a shorter partial page from retained work')
    assert.ok(smallerLimit.cursor)
    assert.ok(resumedLimitCalls > 0)
    const changedLimitFirstId = smallerLimit.records[0].id
    assert.ok([candidateA.id, candidateB.id].includes(changedLimitFirstId))
    let remainingLibraryPage = partialLibrary.service.read({ version: 1, action: 'continue', readId: partialStart.readId,
      cursor: smallerLimit.cursor })
    let libraryContinuations = 0
    while (remainingLibraryPage.status === 'budget_exhausted' && remainingLibraryPage.cursor !== undefined &&
        libraryContinuations < 8) {
      remainingLibraryPage = partialLibrary.service.read({ version: 1, action: 'continue', readId: partialStart.readId,
        cursor: remainingLibraryPage.cursor })
      libraryContinuations += 1
    }
    assert.equal(remainingLibraryPage.status, 'ok')
    assert.equal(remainingLibraryPage.complete, true)
    assert.equal(remainingLibraryPage.records.length, 1)
    assert.notEqual(remainingLibraryPage.records[0].id, changedLimitFirstId)
    assert.deepEqual(new Set([changedLimitFirstId, remainingLibraryPage.records[0].id]), new Set([candidateA.id, candidateB.id]))
    assert.deepEqual(rawPageReads, ['candidate'], 'the original raw page query is not repeated after its limit changes')
    for (const candidate of [candidateA, candidateB]) assert.equal(metadataReads.get(candidate.id), 1,
      'candidate metadata is not fetched twice across the limit change')
    for (const sourceId of retrySources) assert.equal(sourceIdentityReads.get(sourceId), 1,
      'each source identity is paid once across the partial library result and continuation')
    assert.equal(partialLibrary.readers.length, 1, 'the library limit change keeps the same readId and reader')

    const detailStart = bootstrap(detail)
    const firstDetail = detail.service.read({ version: 1, action: 'detail', readId: detailStart.readId, projectKey: PROJECT_A,
      target: { kind: 'events', dimension: 'date', value: DATE } })
    assert.equal(firstDetail.view, 'detail')
    assert.equal(firstDetail.events.length, 1)
    const secondDetail = detail.service.read({ version: 1, action: 'continue', readId: detailStart.readId, cursor: firstDetail.cursor })
    assert.equal(secondDetail.view, 'detail')
    assert.equal(secondDetail.events.length, 1)
    assert.equal(secondDetail.complete, true)
  } finally { library.close(); detail.close(); partialLibrary.close() }
})

test('more than four selected projects reaches the handler scope limit through a bounded request schema', () => {
  const f = fixture({}, [PROJECT_A, PROJECT_B, 'project-c', 'project-d', 'project-e'])
  try {
    const keys = [PROJECT_A, PROJECT_B, 'project-c', 'project-d', 'project-e']
    assert.equal(ReadDashboardRequestSchema.parse({ version: 1, action: 'bootstrap', projectKeys: keys }).projectKeys.length, 5)
    const result = bootstrap(f, keys)
    assert.equal(result.status, 'scope_limit')
    assert.equal(result.reason, 'project-selection-limit')
  } finally { f.close() }
})

test('large event libraries remain explicitly partial at the fixed continuation cap', () => {
  const eventPageReads = []
  const paginationBlocks = []
  const f = fixture({ events: Array.from({ length: 300 }, (_unused, index) => captureEvent(index + 1)),
    eventPagesPerCall: 1, eventPageReads, paginationBlocks })
  try {
    const started = bootstrap(f)
    const state = f.service.states.get(started.readId)
    assert.ok(state)
    state.projects.forEach((project) => {
      project.approved.done = true
      project.candidate.done = true
      project.forgotten.done = true
    })
    state.overview.attemptsDone = true
    state.overview.billableDone = true
    state.overview.coverageDone = true
    state.processingScan.done = true
    state.page.done = true
    const { result, continuations } = finishOverview(f, started.readId)
    assert.equal(result.status, 'budget_exhausted', 'only a proven response with a failed handoff may retain its lower bound')
    assert.equal(result.complete, false)
    assert.equal(result.metrics.captures.relation, 'lower_bound')
    assert.ok(result.metrics.captures.value > 0)
    assert.equal(result.cursor, undefined)
    assert.equal(continuations, 15, 'the bootstrap suspension consumes one of the fixed sixteen handoffs')
    assert.equal(eventPageReads.length, 16, 'one real overview event page advances in each of sixteen RPCs')
    assert.equal(new Set(eventPageReads.map((page) => page.callGeneration)).size, 16,
      'the explicit per-call pagination block requires a new RPC for each event page')
    assert.equal(paginationBlocks.length, 16, 'each overview RPC blocks its second event page without advancing the cursor')
    assert.ok(result.metrics.captures.value < 300, 'the fixed handoff cap preserves an honest lower bound')
  } finally { f.close() }
})

// ---------------------------------------------------------------------------
// S4-A enumerated directory labels and proven active-project membership
// ---------------------------------------------------------------------------

test('real directory pages expose project_meta names and only a proven active-project hint', () => {
  const projects = [
    { key: 'label-alpha', name: 'Alpha 项目' },
    { key: 'label-beta', name: 'Beta Project' },
  ]
  const f = labelledFixture(projects, { activeProjectKey: 'label-beta' })
  const sequence = installDirectorySequence([{ name: 'label-alpha' }, { name: 'label-beta' }])
  try {
    const page = f.service.read({ version: 1, action: 'bootstrap', focusProjectKey: 'label-alpha' })
    assert.equal(page.status, 'selection_required')
    assert.equal(page.complete, true)
    assert.deepEqual(page.projects.map((project) => project.key), ['label-alpha', 'label-beta'])
    assert.equal(page.projects[0].name, 'Alpha 项目')
    assert.equal(page.projects[1].name, 'Beta Project')
    assert.equal(page.activeProjectKey, 'label-beta', 'the trusted active key wins over the request focus hint')
    assert.equal(f.handles.length, 2, 'each enumerated member opened exactly one read-only connection')
    assert.ok(f.handles.every((handle) => !handle.released), 'proven members stay resident until the directory scope ends')
  } finally {
    sequence.restore()
    f.close()
  }
})

test('an active project on the second directory page is never exposed early and is reported after its member proof', () => {
  const keys = ['page-two-1', 'page-two-2', 'page-two-3', 'page-two-4', 'page-two-5', 'page-two-6']
  const projects = keys.map((key) => ({ key, name: `项目 ${key}` }))
  const f = labelledFixture(projects, { activeProjectKey: keys[5] })
  const sequence = installDirectorySequence(keys.map((name) => ({ name })))
  try {
    const first = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial')
    assert.equal(first.complete, false)
    assert.equal(first.projects.length, 4)
    assert.equal(first.activeProjectKey, undefined, 'page one must not expose a member it has not enumerated and proved')
    assert.ok(first.cursor)
    const second = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    assert.equal(second.status, 'selection_required')
    assert.equal(second.complete, true)
    assert.deepEqual(second.projects.map((project) => project.key), [keys[4], keys[5]])
    assert.equal(second.activeProjectKey, keys[5])
    assert.equal(f.handles.length, 6)
  } finally {
    sequence.restore()
    f.close()
  }
})

test('four members per call and sixteen per session are metered across pages without reopening a reader', () => {
  const projects = Array.from({ length: 17 }, (_unused, index) => ({
    key: `member-budget-${String(index + 1).padStart(2, '0')}`,
    name: `Member budget ${index + 1}`,
  }))
  const f = labelledFixture(projects)
  try {
    let page = f.service.read({ version: 1, action: 'bootstrap' })
    const firstReadId = page.readId
    const listed = []
    let pages = 0
    while (page.cursor !== undefined && pages < 16) {
      assert.equal(page.status, 'partial')
      assert.equal(page.readId, firstReadId)
      assert.ok(page.projects.length <= 4, 'the existing four-projects-per-call budget is not raised')
      listed.push(...page.projects.map((project) => project.key))
      page = f.service.read({ version: 1, action: 'continue', readId: firstReadId, cursor: page.cursor })
      pages += 1
    }
    assert.equal(page.status, 'budget_exhausted', 'cumulative project budget exhaustion is reported, not faked as EOF')
    assert.equal(page.complete, false)
    assert.equal(page.cursor, undefined)
    assert.equal(page.projects, undefined)
    assert.equal(listed.length, 16, 'the existing sixteen-projects-per-session budget is not raised')
    assert.equal(new Set(listed).size, 16)
    assert.equal(f.handles.length, 16, 'member connections are counted across pages, never reset by a fresh reader')
    assert.ok(f.handles.every((handle) => handle.released), 'the exhausted directory session releases every member connection')
    assert.equal(f.readers.length, 1, 'cumulative exhaustion never opens a replacement reader')
    assert.equal(f.manager.stats().sessions, 0)
    assert.equal(f.service.directoryStates.size, 0)
  } finally {
    f.close()
  }
})

test('a scanned but unconsumed project key stays with the same cursor and is labeled on the next call', () => {
  const keys = ['cursor-member-1', 'cursor-member-2', 'cursor-member-3', 'cursor-member-4', 'cursor-member-5']
  const f = labelledFixture(keys.map((key) => ({ key, name: `Cursor ${key}` })))
  const sequence = installDirectorySequence(keys.map((name) => ({ name })))
  try {
    const first = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial')
    assert.deepEqual(first.projects.map((project) => project.key), keys.slice(0, 4))
    assert.ok(first.cursor)
    const second = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    assert.equal(second.readId, first.readId, 'the unconsumed key continues on the same readId')
    assert.equal(second.status, 'selection_required')
    assert.equal(second.complete, true)
    assert.deepEqual(second.projects.map((project) => project.key), [keys[4]])
    assert.equal(f.handles.length, 5)
  } finally {
    sequence.restore()
    f.close()
  }
})

test('pre-publication rechecks revoke a page when the name, database, connection version, or path identity changes', () => {
  const variants = [
    {
      name: 'project_meta name',
      mutate(f, key) { f.stores.get(key).setProjectMeta({ key, name: 'Changed after label read', cwd: f.root }) },
      expected: 'stale',
      expectedReason: 'directory-member-changed',
    },
    {
      name: 'same-connection database version',
      mutate(f, key) { f.stores.get(key).recordEvent('synthetic-write', 1, 0, 0) },
      expected: 'stale',
      expectedReason: 'directory-member-changed',
    },
    {
      name: 'database inode',
      mutate(f, key) {
        const file = path.join(f.projectsDirectory, key, 'memory.db')
        const replacement = path.join(f.root, 'replacement-memory.db')
        copyFileSync(file, replacement)
        renameSync(replacement, file)
      },
      expected: 'stale',
      expectedReason: 'directory-member-changed',
    },
    {
      name: 'symlinked member folder',
      mutate(f, key) {
        const folder = path.join(f.projectsDirectory, key)
        const moved = path.join(f.root, `moved-${key}`)
        renameSync(folder, moved)
        symlinkSync(moved, folder, 'dir')
      },
      expected: 'stale',
      expectedReason: 'project-directory-changed',
    },
    {
      name: 'symlinked parent path',
      mutate(f) {
        const moved = path.join(f.root, 'projects-moved')
        renameSync(f.projectsDirectory, moved)
        symlinkSync(moved, f.projectsDirectory, 'dir')
      },
      // The directory marker sees the parent symlink and withdraws the page as
      // a changed directory; it is not an unavailable-probe failure.
      expected: 'stale',
      expectedReason: 'project-directory-changed',
    },
  ]
  const key = 'revoked-member'
  for (const variant of variants) {
    const f = labelledFixture([{ key, name: 'Revocable member' }], { activeProjectKey: key })
    const originalSuspend = DashboardVisibilityReadSession.prototype.suspendForRpc
    let mutated = false
    DashboardVisibilityReadSession.prototype.suspendForRpc = function (beforeHandoff) {
      if (!mutated) {
        mutated = true
        variant.mutate(f, key)
      }
      return originalSuspend.call(this, beforeHandoff)
    }
    try {
      const page = f.service.read({ version: 1, action: 'bootstrap' })
      assert.equal(page.status, variant.expected, variant.name)
      assert.equal(page.reason, variant.expectedReason, `${variant.name} reports its accurate withdrawal reason`)
      assert.equal(page.complete, false, variant.name)
      assert.equal(page.projects, undefined, `${variant.name} must not publish the pre-change page`)
      assert.equal(page.activeProjectKey, undefined, variant.name)
      assert.ok(f.handles.every((handle) => handle.released), `${variant.name} releases the member connection`)
      assert.equal(f.manager.stats().sessions, 0, `${variant.name} retires the read session`)
      assert.equal(f.service.directoryStates.size, 0, variant.name)
    } finally {
      DashboardVisibilityReadSession.prototype.suspendForRpc = originalSuspend
      f.close()
    }
  }
})

test('close, TTL, and directory mutation release label connections and residency', () => {
  const projects = [
    { key: 'release-1', name: 'Release one' },
    { key: 'release-2', name: 'Release two' },
    { key: 'release-3', name: 'Release three' },
    { key: 'release-4', name: 'Release four' },
    { key: 'release-5', name: 'Release five' },
  ]
  const closed = labelledFixture(projects)
  try {
    const page = closed.service.read({ version: 1, action: 'bootstrap' })
    assert.ok(page.readId)
    assert.equal(closed.handles.length, 4)
    const result = closed.service.read({ version: 1, action: 'close', readId: page.readId })
    assert.equal(result.status, 'ok')
    assert.ok(closed.handles.every((handle) => handle.released), 'close releases every member connection')
    assert.equal(closed.manager.stats().sessions, 0)
    assert.equal(closed.service.directoryStates.size, 0)
  } finally { closed.close() }

  const expiring = labelledFixture(projects)
  try {
    const first = expiring.service.read({ version: 1, action: 'bootstrap' })
    assert.ok(first.cursor)
    const originalNow = Date.now
    let expired
    try {
      Date.now = () => originalNow() + 16_000
      expired = expiring.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    } finally {
      Date.now = originalNow
    }
    assert.equal(expired.status, 'expired')
    assert.equal(expired.reason, 'project-directory-read-expired')
    assert.ok(expiring.handles.every((handle) => handle.released), 'TTL releases every member connection')
    assert.equal(expiring.manager.stats().sessions, 0)
    assert.equal(expiring.service.directoryStates.size, 0)
  } finally { expiring.close() }

  const changed = labelledFixture(projects)
  try {
    const first = changed.service.read({ version: 1, action: 'bootstrap' })
    assert.ok(first.cursor)
    projectRoot(changed.projectsDirectory, 'release-added-later')
    const forcedNow = new Date(Date.now() + 1_000)
    utimesSync(changed.projectsDirectory, forcedNow, forcedNow)
    const invalidated = changed.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    assert.equal(invalidated.status, 'stale')
    assert.equal(invalidated.reason, 'project-directory-changed')
    assert.ok(changed.handles.every((handle) => handle.released), 'cancellation releases every member connection')
    assert.equal(changed.manager.stats().sessions, 0)
  } finally { changed.close() }
})

test('label and final-proof headroom is reserved before any raw directory scan', () => {
  const spy = spyDirectoryReads()
  const f = fixture({ remainingReadWork: { sqlStatements: 12, rowsVisited: 12, materializedBytes: 4_096, keyBytes: 4_096 } })
  try {
    const result = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.reason, 'project-directory-budget')
    assert.equal(result.complete, false)
    assert.equal(result.projects, undefined)
    assert.equal(spy.reads, 0, 'no key may be consumed when its label and final-proof envelope does not fit')
    assert.equal(f.log.some(([kind]) => kind === 'charge'), false)
    assert.equal(f.service.directoryStates.size, 0)
  } finally {
    spy.restore()
    f.close()
  }
})

test('an empty project directory reports a truthful complete empty selection', () => {
  const f = labelledFixture([])
  try {
    const page = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(page.status, 'selection_required')
    assert.equal(page.complete, true)
    assert.deepEqual(page.projects, [])
    assert.equal(page.readId, undefined)
    assert.equal(page.activeProjectKey, undefined)
    assert.equal(f.service.directoryStates.size, 0)
    assert.equal(f.manager.stats().sessions, 0)
    assert.equal(f.handles.length, 0)
  } finally { f.close() }
})

test('request focus and unenumerated active keys never authorize the active-project hint', () => {
  const focused = fixture({ activeProjectKey: undefined }, [PROJECT_A])
  try {
    const page = focused.service.read({ version: 1, action: 'bootstrap', focusProjectKey: PROJECT_A })
    assert.equal(page.status, 'selection_required')
    assert.equal(page.activeProjectKey, undefined, 'a request focus hint is not member proof')
  } finally { focused.close() }

  const unenumerated = fixture({ activeProjectKey: 'not-in-directory' }, [PROJECT_A])
  try {
    const page = unenumerated.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(page.status, 'selection_required')
    assert.equal(page.activeProjectKey, undefined, 'an active key outside the enumerated page is not claimed')
  } finally { unenumerated.close() }

  const proven = fixture({ activeProjectKey: PROJECT_A }, [PROJECT_A])
  try {
    const page = proven.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(page.status, 'selection_required')
    assert.equal(page.activeProjectKey, PROJECT_A)
    assert.deepEqual(page.projects, [{ key: PROJECT_A, name: PROJECT_A }])
  } finally { proven.close() }
})

test('a tight per-call SQL and materialized envelope publishes every smaller proven page instead of dropping it', () => {
  const projects = Array.from({ length: 5 }, (_unused, index) => ({
    key: `tight-boundary-${index + 1}`, name: `Tight boundary ${index + 1}`,
  }))
  // The exported label envelope is 11 SQL / 18 rows / 4608 materialized bytes
  // per member (label open + pre-publication verify + resident lease). With the
  // 2-SQL control open, the 2-SQL final probe, the 1024-byte directory handle
  // lease and the 256 KiB output lease, these limits prove exactly two members
  // per call; a third would not fit. The page must still publish with its
  // accumulated verify work reserved, then continue on the same readId.
  const f = labelledFixture(projects, { managerOptions: { limits: { perCall: {
    sqlStatements: 26,
    materializedBytes: 274_000,
  } } } })
  try {
    const first = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial', 'a smaller proven page is published, not discarded as budget-exhausted')
    assert.equal(first.complete, false)
    assert.equal(first.projects.length, 2)
    assert.ok(first.cursor)
    const second = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    assert.equal(second.readId, first.readId)
    assert.equal(second.status, 'partial')
    assert.equal(second.projects.length, 2)
    assert.ok(second.cursor)
    const third = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: second.cursor })
    assert.equal(third.readId, first.readId, 'the cumulative budget is never reset by a fresh reader')
    assert.equal(third.status, 'selection_required')
    assert.equal(third.complete, true)
    assert.equal(third.projects.length, 1)
    assert.deepEqual([...first.projects, ...second.projects, ...third.projects].map((project) => project.key).sort(),
      projects.map((project) => project.key).sort())
    assert.equal(f.handles.length, 5)
    assert.equal(f.readers.length, 1)
    assert.equal(f.manager.stats().sessions, 1, 'one session carries the whole multi-page budget')
  } finally {
    f.close()
  }
})

test('a thirty-two-SQL call budget keeps outstanding label verify work across two/two/one pages', () => {
  const projects = Array.from({ length: 5 }, (_unused, index) => ({
    key: `verified-budget-${index + 1}`, name: `Verified budget ${index + 1}`,
  }))
  // Per call: 2 SQL for the control open + 11 SQL per member envelope (label
  // open 8 + final verify 3) + 2 SQL for the final proof. Two labels leave all
  // six accumulated verify statements payable inside 32; a third envelope plus
  // the outstanding verify would cross the call budget, so the smaller proven
  // page must publish instead of being discarded at final verify. The real
  // labelledFixture therefore publishes 2/2/1 pages on the same reader.
  const f = labelledFixture(projects, { managerOptions: { limits: { perCall: { sqlStatements: 32 } } } })
  try {
    const first = f.service.read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial')
    assert.equal(first.complete, false)
    assert.equal(first.projects.length, 2)
    assert.ok(first.cursor)
    const second = f.service.read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    assert.equal(second.readId, first.readId)
    assert.equal(second.status, 'partial')
    assert.equal(second.complete, false)
    assert.equal(second.projects.length, 2)
    assert.ok(second.cursor)
    const third = f.service.read({ version: 1, action: 'continue', readId: second.readId, cursor: second.cursor })
    assert.equal(third.readId, first.readId, 'the same readId continues the cumulative budget')
    assert.equal(third.status, 'selection_required')
    assert.equal(third.complete, true, 'the final proof still completes the last page')
    assert.equal(third.projects.length, 1)
    const published = [...first.projects, ...second.projects, ...third.projects]
    assert.equal(published.length, 5)
    assert.equal(new Set(published.map((project) => project.key)).size, 5)
    assert.deepEqual(published.map((project) => project.key).sort(),
      projects.map((project) => project.key).sort())
    assert.equal(f.handles.length, 5)
    assert.equal(f.readers.length, 1, 'the same reader carries the cumulative budget across all three pages')
    assert.equal(f.manager.stats().sessions, 1, 'the final proof stays inside the original session')
  } finally {
    f.close()
  }
})

test('library summary and record projections keep project context, query filtering, and numeric-only expiry', () => {
  const libraryRecord = (index, expiryAt) => ({
    state: 'visible',
    record: {
      id: `library-record-${index}`, content: `Record content ${index}.`, kind: 'fact', confidence: 0.9,
      status: 'approved', source: 'synthetic', sourceMessageIds: [`source-${index}`],
      createdAt: 1_700_000_000_000 + index, updatedAt: 1_700_000_000_000 + index, revision: 1,
      validFromState: 'known', validFromPrecision: 'instant', validFromBasis: 'explicit',
      recordedAt: 1_700_000_000_000 + index, sourceVerified: true,
      ...(expiryAt === undefined ? {} : { expiryAt }),
    },
  })
  const f = fixture({
    projectName: 'Query project',
    approved: [approvedRows(1)[0], libraryRecord(2, 1_700_000_100_000), libraryRecord(3)],
  })
  try {
    const expiringStart = bootstrap(f)
    const expiring = f.service.read({ version: 1, action: 'library', readId: expiringStart.readId,
      projectKey: PROJECT_A, status: 'approved', query: 'record content 2', limit: 6 })
    assert.equal(expiring.records.length, 1)
    assert.equal(expiring.records[0].id, 'library-record-2')
    assert.equal(expiring.records[0].expiryAt, 1_700_000_100_000)
    assert.equal(expiring.records[0].content, 'Record content 2.')
    assert.equal(expiring.records[0].projectKey, PROJECT_A)
    assert.equal(expiring.records[0].projectName, 'Query project')

    const allStart = bootstrap(f)
    const all = f.service.read({ version: 1, action: 'library', readId: allStart.readId,
      projectKey: PROJECT_A, status: 'approved', limit: 6, query: 'query project' })
    assert.equal(all.records.length, 3, 'the query matches the project name on the summary path too')
    const summary = all.records.find((record) => record.id === 'memory-1')
    assert.ok(summary)
    assert.equal(summary.projectKey, PROJECT_A)
    assert.equal(summary.projectName, 'Query project')
    const withoutExpiry = all.records.find((record) => record.id === 'library-record-3')
    assert.ok(withoutExpiry)
    assert.equal('expiryAt' in withoutExpiry, false)
    assert.equal(withoutExpiry.projectName, 'Query project')
  } finally {
    f.close()
  }
})

test('forgotten rows keep an independent cursor and never merge into approved or candidate counts', () => {
  const forgotten = Array.from({ length: 4 }, (_unused, index) => ({
    state: 'visible', summary: { id: `forgotten-${index + 1}`, revision: 1, kind: 'fact', sourceIds: [`source-f-${index + 1}`] },
  }))
  const f = fixture({ approved: approvedRows(2), forgotten })
  try {
    const started = bootstrap(f)
    const { result, continuations } = finishOverview(f, started.readId)
    assert.equal(result.status, 'ok')
    assert.equal(result.complete, true)
    assert.ok(continuations < 16)
    const project = result.page.projects[0]
    assert.equal(project.forgotten.value, 4, 'the separate forgotten cursor drains its own page')
    assert.equal(project.forgotten.relation, 'exact')
    assert.equal(project.approved.value, 2)
    assert.equal(project.candidates.value, 0)
    assert.equal(result.metrics.effectiveMemories.value, 2, 'forgotten rows never merge into current approved counts')
    assert.equal(result.metrics.candidates.value, 0)
  } finally {
    f.close()
  }
})

function repeatedSeedProjectKey(store) {
  const row = store.db.prepare('SELECT project_key FROM l0_messages LIMIT 1').get()
  if (row === undefined || typeof row.project_key !== 'string') throw new Error('repeated fixture project key unavailable')
  return row.project_key
}

function seedRepeatedGroups(store) {
  const base = EVENT_TIME
  const alpha = []
  for (const offset of [0, 1_000, 2_000]) {
    alpha.push(store.recordL0({ sessionId: 'repeat-alpha', role: 'user',
      content: 'Synthetic repeated alpha question.', createdAt: base + offset, recordedAt: base + offset,
      sourceEventId: `repeat-alpha-${offset}`, agentPreset: 'agent-repeat-a', origin: 'synthetic-a' }))
  }
  const beta = store.recordL0({ sessionId: 'repeat-beta', role: 'user',
    content: 'Synthetic repeated beta question.', createdAt: base + 3_000, recordedAt: base + 3_000,
    sourceEventId: 'repeat-beta-shared', agentPreset: 'agent-repeat-b', origin: 'synthetic-b' })
  store.appendEvent({ eventId: 'capture:repeat-beta-extra', type: 'capture', sourceId: beta,
    sessionId: 'repeat-beta', source: 'synthetic-b', agentPreset: 'agent-repeat-b',
    occurredAt: base + 3_000, count: 1 }, base + 3_000)
  const legacy = store.recordL0({ sessionId: 'repeat-legacy', role: 'user',
    content: 'Synthetic legacy collision question.', createdAt: base + 4_000, recordedAt: base + 4_000,
    sourceEventId: 'repeat-legacy-origin', agentPreset: 'agent-repeat-c', origin: 'synthetic-c' })
  const projectKey = repeatedSeedProjectKey(store)
  const inserted = store.db.prepare('INSERT INTO memory_events(project_key, type, count, created_at, source_id) VALUES (?, ?, ?, ?, ?)')
    .run(projectKey, 'capture', 1, base + 4_100, legacy)
  const legacyRowId = Number(inserted.lastInsertRowid)
  store.db.prepare('INSERT INTO memory_events(project_key, type, count, created_at, source_id, event_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectKey, 'capture', 1, base + 4_200, legacy, `legacy:${legacyRowId}`)
  store.recordL0({ sessionId: 'repeat-single', role: 'user', content: 'Synthetic single occurrence question.',
    createdAt: base + 5_000, recordedAt: base + 5_000, sourceEventId: 'repeat-single-1', agentPreset: 'agent-repeat-d', origin: 'synthetic-d' })
  store.recordL0({ sessionId: 'repeat-outside', role: 'user', content: 'Synthetic out of range question.',
    createdAt: base + DAY_MS * 3, recordedAt: base + DAY_MS * 3, sourceEventId: 'repeat-outside-1', agentPreset: 'agent-repeat-e', origin: 'synthetic-e' })
  store.recordL0({ sessionId: 'repeat-outside', role: 'user', content: 'Synthetic out of range question.',
    createdAt: base + DAY_MS * 3 + 1_000, recordedAt: base + DAY_MS * 3 + 1_000, sourceEventId: 'repeat-outside-2', agentPreset: 'agent-repeat-e', origin: 'synthetic-e' })
  const fingerprintOf = (id) => store.db.prepare('SELECT fingerprint FROM l0_messages WHERE id = ?').get(id).fingerprint
  return { alpha, beta, legacy, legacyRowId, alphaFingerprint: fingerprintOf(alpha[0]),
    betaFingerprint: fingerprintOf(beta), legacyFingerprint: fingerprintOf(legacy) }
}

function readRepeatedGroupsWithContinuations(service, readId, target = {}) {
  let result = service.read({ version: 1, action: 'repeated', readId, target: { kind: 'groups', ...target } })
  const groups = []
  let cursors = 0
  if (Array.isArray(result.repeated?.groups)) groups.push(...result.repeated.groups)
  let steps = 0
  while (result.cursor !== undefined && steps < 24) {
    cursors += 1
    result = service.read({ version: 1, action: 'continue', readId, cursor: result.cursor })
    if (Array.isArray(result.repeated?.groups)) groups.push(...result.repeated.groups)
    steps += 1
  }
  return { result, groups, steps, cursors }
}

function startRepeatedPage(service, readId, target = {}) {
  let result = service.read({ version: 1, action: 'repeated', readId,
    target: { kind: 'groups', ...target } })
  let steps = 0
  while (result.status === 'budget_exhausted' && result.cursor !== undefined && steps < 24) {
    result = service.read({ version: 1, action: 'continue', readId, cursor: result.cursor })
    steps += 1
  }
  return { result, steps }
}

function readRepeatedEventsWithContinuations(service, readId, target) {
  let result = service.read({ version: 1, action: 'repeated', readId, target: { kind: 'events', ...target } })
  const events = [...(result.repeated?.events ?? [])]
  let steps = 0
  while (result.cursor !== undefined && steps < 24) {
    result = service.read({ version: 1, action: 'continue', readId, cursor: result.cursor })
    events.push(...(result.repeated?.events ?? []))
    steps += 1
  }
  return { result, events, steps }
}

test('real Store and S1 publish a complete ranked repeated-capture page with n−1 and legacy dedup', () => {
  const f = realFixture()
  try {
    const data = seedRepeatedGroups(f.store)
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result, groups } = readRepeatedGroupsWithContinuations(f.service, started.readId)
    assert.equal(result.complete, true)
    assert.equal(result.repeated.target, 'groups')
    assert.equal(result.repeated.complete, true)
    assert.equal(result.repeated.hasMore, false)
    assert.equal(result.repeated.cursor, undefined)
    assert.equal(groups.length, 3)
    const alpha = groups.find((group) => group.fingerprint === data.alphaFingerprint)
    assert.ok(alpha)
    assert.equal(alpha.repeatCount, 2, 'capture n−1: three distinct capture events yield repeatCount 2')
    assert.equal(alpha.eventCount, 3)
    assert.equal(groups[0].repeatCount, 2, 'ranking is repeatCount DESC before fingerprint ASC')
    const beta = groups.find((group) => group.fingerprint === data.betaFingerprint)
    assert.ok(beta)
    assert.equal(beta.repeatCount, 1, 'the same L0 with two capture events contributes two logical events')
    const legacy = groups.find((group) => group.fingerprint === data.legacyFingerprint)
    assert.ok(legacy)
    assert.equal(legacy.repeatCount, 1, 'legacy row identity collides with the legacy:<rowid> event id exactly once')
    assert.equal(groups.some((group) => group.repeatCount === 0), false, 'single occurrences are never published as repeated groups')
    assert.equal(groups.every((group) => group.projectKey === PROJECT_A), true)
  } finally { f.close() }
})

test('real repeated ranking pages use a stable key and explicit excerpts are opt-in', () => {
  const f = realFixture()
  try {
    const data = seedRepeatedGroups(f.store)
    const started = bootstrap(f)
    const first = startRepeatedPage(f.service, started.readId, { projectKeys: [PROJECT_A], limit: 2 }).result
    assert.equal(first.status, 'ok')
    assert.equal(first.repeated.complete, true)
    assert.equal(first.repeated.groups.length, 2)
    assert.equal(first.repeated.hasMore, true)
    assert.ok(first.cursor)
    const second = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor: first.cursor })
    assert.equal(second.status, 'ok')
    assert.equal(second.repeated.groups.length, 1)
    assert.equal(second.repeated.hasMore, false)
    assert.equal(second.cursor, undefined)
    const seen = [...first.repeated.groups, ...second.repeated.groups]
    assert.equal(new Set(seen.map((group) => group.fingerprint)).size, 3, 'ranking pages never repeat a group')
    assert.equal(seen[0].repeatCount, 2)
    const bare = readRepeatedEventsWithContinuations(f.service, started.readId,
      { projectKey: PROJECT_A, fingerprint: data.alphaFingerprint, includeExcerpt: false })
    assert.equal(bare.events.length, 3)
    assert.equal(bare.events.every((event) => event.excerpt === undefined), true, 'no excerpt is materialized unless requested')
    assert.equal(bare.events.every((event) => event.type === 'capture' && event.sourceId !== undefined), true)
    const requested = readRepeatedEventsWithContinuations(f.service, started.readId,
      { projectKey: PROJECT_A, fingerprint: data.alphaFingerprint, includeExcerpt: true })
    assert.equal(requested.events.length, 3)
    assert.equal(requested.events.every((event) => event.excerpt === 'Synthetic repeated alpha question.'), true)
    assert.equal(requested.events.every((event) => event.excerptTruncated === false), true)
  } finally { f.close() }
})

test('real repeated scan combines date, agent, source and project filters on the same event', () => {
  const f = realFixture()
  try {
    const data = seedRepeatedGroups(f.store)
    const started = bootstrap(f)
    const filtered = readRepeatedGroupsWithContinuations(f.service, started.readId,
      { projectKeys: [PROJECT_A], filters: { agentPreset: 'agent-repeat-a', source: 'synthetic-a' } })
    assert.equal(filtered.result.complete, true)
    assert.equal(filtered.groups.length, 1)
    assert.equal(filtered.groups[0].fingerprint, data.alphaFingerprint)
    assert.equal(filtered.groups[0].repeatCount, 2)
    const mismatch = readRepeatedGroupsWithContinuations(f.service, started.readId,
      { projectKeys: [PROJECT_A], filters: { agentPreset: 'agent-repeat-a', source: 'synthetic-b' } })
    assert.equal(mismatch.result.complete, true)
    assert.equal(mismatch.groups.length, 0, 'filters intersect on one event instead of widening to any matching source')
    const otherProject = readRepeatedGroupsWithContinuations(f.service, started.readId,
      { projectKeys: ['unselected-project'], filters: {} })
    assert.equal(otherProject.result.status, 'scope_limit', 'a project outside the bootstrap binding is refused')
  } finally { f.close() }
})

test('source revocation before the read removes revoked capture events from group counts and event pages', () => {
  const f = realFixture()
  try {
    const base = EVENT_TIME
    const content = 'Synthetic revoked repeated question.'
    const first = f.store.recordL0({ sessionId: 'repeat-revoke', role: 'user', content,
      createdAt: base, recordedAt: base, sourceEventId: 'repeat-revoke-a', origin: 'synthetic-revoke' })
    const second = f.store.recordL0({ sessionId: 'repeat-revoke', role: 'user', content,
      createdAt: base + 1_000, recordedAt: base + 1_000, sourceEventId: 'repeat-revoke-b', origin: 'synthetic-revoke' })
    const fingerprint = f.store.db.prepare('SELECT fingerprint FROM l0_messages WHERE id = ?').get(first).fingerprint
    f.control.revokeSourceEvent(PROJECT_A, 'repeat-revoke-b')
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const groups = readRepeatedGroupsWithContinuations(f.service, started.readId)
    assert.equal(groups.result.complete, true)
    assert.equal(groups.groups.length, 0, 'one revoked event leaves a single visible occurrence, not a repeated group')
    const events = readRepeatedEventsWithContinuations(f.service, started.readId,
      { projectKey: PROJECT_A, fingerprint, includeExcerpt: true })
    assert.equal(events.events.length, 1)
    assert.equal(events.events[0].sourceEventId, 'repeat-revoke-a')
    assert.equal(events.events[0].sourceId, first)
  } finally { f.close() }
})

test('the second capture event on one L0 is revoked independently in groups and event details', () => {
  const f = realFixture()
  try {
    const base = EVENT_TIME
    const content = 'Synthetic same L0 revoked question.'
    const shared = f.store.recordL0({ sessionId: 'repeat-same-l0', role: 'user', content,
      createdAt: base, recordedAt: base, sourceEventId: 'repeat-same-l0-origin', origin: 'synthetic-same-l0' })
    f.store.appendEvent({ eventId: 'capture:repeat-same-l0-extra', type: 'capture', sourceId: shared,
      sessionId: 'repeat-same-l0', source: 'synthetic-same-l0', agentPreset: 'agent-same-l0',
      occurredAt: base + 1_000, count: 1 }, base + 1_000)
    f.store.recordL0({ sessionId: 'repeat-same-l0', role: 'user', content,
      createdAt: base + 2_000, recordedAt: base + 2_000, sourceEventId: 'repeat-same-l0-second',
      origin: 'synthetic-same-l0' })
    const fingerprint = f.store.db.prepare('SELECT fingerprint FROM l0_messages WHERE id = ?').get(shared).fingerprint
    // Only the second event on the shared L0 is revoked; the L0 identity and first event stay valid.
    f.control.revokeSourceEvent(PROJECT_A, 'repeat-same-l0-extra')
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const groups = readRepeatedGroupsWithContinuations(f.service, started.readId)
    assert.equal(groups.result.complete, true)
    assert.equal(groups.groups.length, 1)
    assert.equal(groups.groups[0].fingerprint, fingerprint)
    assert.equal(groups.groups[0].repeatCount, 1,
      'a revoked same-L0 event is not counted through the L0 source identity')
    assert.equal(groups.groups[0].eventCount, 2)
    const events = readRepeatedEventsWithContinuations(f.service, started.readId,
      { projectKey: PROJECT_A, fingerprint, includeExcerpt: false })
    assert.equal(events.events.length, 2)
    assert.equal(events.events.some((event) => event.eventId === 'capture:repeat-same-l0-extra'), false,
      'the revoked event never appears in the detail page')
    assert.equal(events.events.some((event) => event.eventId === 'capture:repeat-same-l0-origin'), true)
    assert.equal(events.events.some((event) => event.sourceId === shared), true,
      'the L0 member and its other capture event remain visible')
  } finally { f.close() }
})

test('long dual-identity proofs are derived, billed once, and resumed on the same cursor', () => {
  const f = realFixture({ limits: {
    maxContinuations: 8,
    perCall: { sqlStatements: 14, rowsVisited: 48, materializedBytes: 1024 * 1024, keyBytes: 32 * 1024, projects: 4 },
    perSession: { sqlStatements: 64, rowsVisited: 256, materializedBytes: 8 * 1024 * 1024, keyBytes: 256 * 1024,
      projects: 16, continuations: 8 },
  } })
  try {
    const base = EVENT_TIME
    const longL0 = 'a'.repeat(2_000)
    const longEvent = 'b'.repeat(2_000)
    const shared = f.store.recordL0({ sessionId: 'repeat-long', role: 'user',
      content: 'Synthetic long identity repeated question.', createdAt: base, recordedAt: base,
      sourceEventId: longL0, origin: 'synthetic-long' })
    f.store.appendEvent({ eventId: `capture:${longEvent}`, type: 'capture', sourceId: shared,
      sessionId: 'repeat-long', source: 'synthetic-long', occurredAt: base + 1_000, count: 1 }, base + 1_000)
    // Count real queries and reader work without replacing the controller.
    const prepare = f.store.db.prepare.bind(f.store.db)
    let metadataQueries = 0
    let eventQueries = 0
    f.store.db.prepare = (sql) => {
      if (sql.includes('sqlite_master')) metadataQueries += 1
      if (sql.includes('FROM memory_events e INDEXED BY memory_events_association')) eventQueries += 1
      return prepare(sql)
    }
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const reader = f.readers[0]
    assert.ok(reader)
    const proofs = []
    const originalProof = reader.verifyRepeatedCaptureEvent.bind(reader)
    reader.verifyRepeatedCaptureEvent = (projectKey, sourceId, ids) => {
      const before = f.manager.counters(reader.callToken)
      const result = originalProof(projectKey, sourceId, ids)
      const after = f.manager.counters(reader.callToken)
      if (before.status === 'ok' && after.status === 'ok') {
        proofs.push({
          sourceId, ids: [...ids],
          sql: after.value.call.sqlStatements - before.value.call.sqlStatements,
          rows: after.value.call.rowsVisited - before.value.call.rowsVisited,
          bytes: after.value.call.materializedBytes - before.value.call.materializedBytes,
        })
      }
      return result
    }
    const eventPageCosts = []
    const originalReadProject = reader.readProject.bind(reader)
    reader.readProject = (projectKey, cost, operation) => {
      if (cost.sqlStatements === 2 && cost.materializedBytes > 130_000) eventPageCosts.push({ ...cost })
      return originalReadProject(projectKey, cost, operation)
    }
    const outcome = readRepeatedGroupsWithContinuations(f.service, started.readId)
    assert.equal(outcome.result.complete, true)
    assert.ok(outcome.steps > 0, 'the small per-call budget must use the same-readId continuation')
    assert.equal(outcome.groups.length, 1)
    assert.equal(outcome.groups[0].repeatCount, 1)
    assert.deepEqual(proofs.map((proof) => proof.ids), [[longL0], [longL0, longEvent]],
      'each event is proved once with both independent identities where they differ')
    const expected = (proof) => {
      const identities = [...new Set(proof.ids)]
      const sourceIdentityProjectionBytes = 5 * 4_096 + 128
      const queryCacheBytes = Math.max(256, 96) + Math.max(256, sourceIdentityProjectionBytes) +
        (identities.length > 0 ? Math.max(256, identities.length * 96) : 0)
      const temporaryIdentityBytes = identities.reduce((sum, id) =>
        sum + Math.max(256, Buffer.byteLength(id, 'utf8') * 2 + 128), 0)
      const contextKey = JSON.stringify(['managed-proof-continuation', reader.binding,
        'repeat-capture-event', PROJECT_A, proof.sourceId, identities])
      return queryCacheBytes + temporaryIdentityBytes + 512 + Buffer.byteLength(contextKey, 'utf8')
    }
    assert.equal(proofs[0].sql, 3)
    assert.equal(proofs[0].rows, 3)
    assert.equal(proofs[0].bytes, expected(proofs[0]), 'the one-identity path includes cache floors and its exact context lease')
    assert.equal(proofs[1].sql, 3)
    assert.equal(proofs[1].rows, 4)
    assert.equal(proofs[1].bytes, expected(proofs[1]), 'the two-identity path derives its own context and temporary leases')
    assert.ok(proofs[1].bytes >= 25_024,
      'the two-identity 2000-byte path exceeds the previous hard-coded 25,024-byte counterexample')
    assert.equal(eventPageCosts.length > 0, true)
    assert.equal(eventPageCosts.every((cost) => cost.sqlStatements === 2 && cost.rowsVisited >= 16), true)
    assert.ok(metadataQueries > 0 && metadataQueries === eventQueries,
      'each event page verifies the association index once before its event SELECT')
  } finally { f.close() }
})

test('a missing association index is rejected by the aggregate before any ranked page is published', () => {
  const f = realFixture()
  try {
    const base = EVENT_TIME
    const content = 'Synthetic missing index repeated question.'
    f.store.recordL0({ sessionId: 'repeat-index', role: 'user', content, createdAt: base, recordedAt: base })
    f.store.recordL0({ sessionId: 'repeat-index', role: 'user', content, createdAt: base + 1_000, recordedAt: base + 1_000 })
    f.store.db.exec('DROP INDEX memory_events_association')
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const result = f.service.read({ version: 1, action: 'repeated', readId: started.readId,
      target: { kind: 'groups', projectKeys: [PROJECT_A] } })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.repeated, undefined)
    assert.equal(result.cursor, undefined)
    assert.equal(f.manager.stats().sessions, 0)
  } finally { f.close() }
})

test('a low per-call and session budget resumes the repeated scan or reports an explicit incomplete state', () => {
  const f = realFixture({ limits: {
    maxContinuations: 8,
    perCall: { sqlStatements: 12, rowsVisited: 96, materializedBytes: 1024 * 1024, keyBytes: 32 * 1024, projects: 4 },
    perSession: { sqlStatements: 64, rowsVisited: 4_096, materializedBytes: 2 * 1024 * 1024, keyBytes: 128 * 1024,
      projects: 16, continuations: 8 },
  } })
  try {
    for (let index = 0; index < 12; index += 1) {
      for (const offset of [0, 1_000]) {
        f.store.recordL0({ sessionId: `repeat-budget-${index}`, role: 'user',
          content: `Synthetic low budget repeated question ${index}.`, createdAt: EVENT_TIME + index * 10 + offset, recordedAt: EVENT_TIME + index * 10 + offset,
          sourceEventId: `repeat-budget-${index}-${offset}`, origin: 'synthetic-budget' })
      }
    }
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const outcome = readRepeatedGroupsWithContinuations(f.service, started.readId)
    assert.ok(outcome.steps > 0, 'the low budget must expose and consume at least one continuation')
    assert.equal(outcome.result.cursor, undefined)
    if (outcome.result.complete === true) {
      assert.equal(outcome.result.repeated.complete, true)
      assert.equal(outcome.groups.length, 12)
    } else {
      assert.equal(outcome.result.complete, false)
      assert.notEqual(outcome.result.repeated?.complete, true, 'an incomplete scan never claims a stable ranking')
      assert.equal(outcome.result.repeated?.groups, undefined, 'a budget-exhausted scan does not publish a partial top-N as ranked')
      assert.equal(f.manager.stats().sessions, 0, 'the exhausted read releases its session and resident vector')
    }
  } finally { f.close() }
})

/** Real synthetic overview sessions: 2 linked L0, 1 L0 with 3 events, missing L0, unknown identity and no session. */
function seedSessionOverview(store) {
  const identityA = originalMessageIdentity('a'.repeat(64))
  const identityB = originalMessageIdentity('b'.repeat(64))
  const identityC = originalMessageIdentity('c'.repeat(64))
  const s2a = store.recordL0({ sessionId: 'session-s2', role: 'user', content: 'Synthetic session two A.',
    createdAt: EVENT_TIME, recordedAt: EVENT_TIME, originalMessageIdentity: identityA })
  store.recordL0({ sessionId: 'session-s2', role: 'user', content: 'Synthetic session two B.',
    createdAt: EVENT_TIME + 1, recordedAt: EVENT_TIME + 1, originalMessageIdentity: identityB })
  const s1 = store.recordL0({ sessionId: 'session-s1', role: 'user', content: 'Synthetic session one origin.',
    createdAt: EVENT_TIME + 2, recordedAt: EVENT_TIME + 2, originalMessageIdentity: identityC })
  store.appendEvent({ eventId: 'capture:s1-extra-1', type: 'capture', sourceId: s1, sessionId: 'session-s1',
    source: 'synthetic-session', occurredAt: EVENT_TIME + 3, count: 1,
    metadata: { role: 'user', originalMessageIdentity: identityC } }, EVENT_TIME + 3)
  store.appendEvent({ eventId: 'capture:s1-extra-2', type: 'capture', sourceId: s1, sessionId: 'session-s1',
    source: 'synthetic-session', occurredAt: EVENT_TIME + 4, count: 1,
    metadata: { role: 'user', originalMessageIdentity: identityC } }, EVENT_TIME + 4)
  store.appendEvent({ eventId: 'capture:session-missing-1', type: 'capture', sourceId: 'l0_session_missing',
    sessionId: 'session-missing', source: 'dsh-session', occurredAt: EVENT_TIME + 5, count: 1,
    metadata: { sourceKind: 'conversation' } }, EVENT_TIME + 5)
  store.recordL0({ sessionId: 'session-unknown', role: 'user', content: 'Synthetic session unknown identity.',
    createdAt: EVENT_TIME + 6, recordedAt: EVENT_TIME + 6 })
  store.appendEvent({ eventId: 'capture:no-session-1', type: 'capture', sessionId: undefined,
    source: 'synthetic-session', occurredAt: EVENT_TIME + 7, count: 1 }, EVENT_TIME + 7)
  return { s2a, s1, identityA, identityB, identityC }
}

function seedProcessingJob(store, { sessionId = 'processing-session', count = 3, extracted = 0,
  missing = 0, wrongSession = 0 } = {}) {
  const sourceIds = []
  for (let index = 0; index < count; index += 1) {
    sourceIds.push(store.recordL0({ sessionId, role: 'user', content: `Synthetic processing source ${index}.`,
      createdAt: EVENT_TIME + index, recordedAt: EVENT_TIME + index }))
  }
  let job
  for (const [index, sourceId] of sourceIds.entries()) {
    job = store.enqueueExtractionJob({ sessionId, sourceId, policyRevision: 'processing-test-policy',
      quietMs: 0, maxWaitMs: 600_000, now: EVENT_TIME + 1_000 + index })
  }
  assert.ok(job)
  const ordered = [...sourceIds].sort()
  for (let index = 0; index < extracted; index += 1) {
    store.db.prepare('UPDATE l0_messages SET extracted_at = ? WHERE id = ?').run(EVENT_TIME + 2_000 + index, ordered[index])
  }
  for (let offset = 0; offset < missing; offset += 1) {
    const sourceId = ordered[ordered.length - 1 - offset]
    store.db.prepare('DELETE FROM l0_messages WHERE id = ?').run(sourceId)
  }
  for (let offset = 0; offset < wrongSession; offset += 1) {
    const sourceId = ordered[ordered.length - 1 - missing - offset]
    store.db.prepare('UPDATE extraction_job_sources SET session_id = ? WHERE source_id = ?').run('processing-other-session', sourceId)
  }
  return { job: store.getExtractionJob(job.id), sourceIds }
}

test('the bounded overview publishes project-scoped sessions ranked by real linked L0 rows, not event counts', () => {
  const f = realFixture()
  try {
    const seeded = seedSessionOverview(f.store)
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.status, 'ok')
    assert.equal(result.sessions.complete, true)
    assert.equal(result.sessions.scannedEvents, 8)
    assert.equal(result.sessions.scannedSessions, 4)
    assert.equal(result.sessions.unknownSessionEvents, 1)
    assert.equal(result.sessions.unknownIdentityEvents, 2)
    assert.deepEqual(result.sessions.items.map((item) => item.sessionId),
      ['session-s2', 'session-s1', 'session-unknown', 'session-missing'])
    const [two, one, unknown, missing] = result.sessions.items
    assert.equal(two.linkedL0Messages, 2)
    assert.equal(two.events, 2)
    assert.equal(one.linkedL0Messages, 1)
    assert.equal(one.events, 3, 'three capture events linked to one L0 rank below two linked L0 rows')
    assert.equal(unknown.linkedL0Messages, 1)
    assert.equal(unknown.unknownIdentityEvents, 1)
    assert.equal(missing.linkedL0Messages, 0, 'a source-only event never links a nonexistent L0')
    assert.equal(missing.unknownIdentityEvents, 1)
    assert.equal(result.sessions.items.every((item) => item.originalMessageCount === null), true,
      'complete Host message counts stay unknown')
    assert.equal(result.sessions.items.every((item) => item.linkedL0Complete === true), true)
    assert.equal(result.sessions.items.every((item) => item.projectKey === PROJECT_A), true)
    assert.equal(seeded.s1.startsWith('l0_'), true)
  } finally { f.close() }
})

test('the same session id in two projects never cross-links the other project L0 in bounded sessions', () => {
  const projectB = 'aggregate-project-b'
  const f = labelledFixture([{ key: PROJECT_A, name: 'Project A' }, { key: projectB, name: 'Project B' }])
  try {
    const storeA = f.stores.get(PROJECT_A)
    const storeB = f.stores.get(projectB)
    assert.ok(storeA && storeB)
    const sharedSource = 'l0_shared_cross_project'
    storeB.db.prepare(`INSERT INTO l0_messages(id, project_key, session_id, role, content, turn, step, created_at,
        source_event_id, origin, source_kind, derived_from, agent_id, agent_preset, provider, model, fingerprint)
      VALUES (?, ?, ?, 'user', ?, NULL, NULL, ?, NULL, 'dsh-session', 'conversation', '[]', NULL, NULL, NULL, NULL, ?)`)
      .run(sharedSource, projectB, 'cross-session', 'Synthetic cross project B.', EVENT_TIME, 'f'.repeat(64))
    storeA.appendEvent({ eventId: 'capture:cross-a', type: 'capture', sourceId: sharedSource,
      sessionId: 'cross-session', source: 'dsh-session', occurredAt: EVENT_TIME + 1, count: 1,
      metadata: { sourceKind: 'conversation' } }, EVENT_TIME + 1)
    storeB.appendEvent({ eventId: 'capture:cross-b', type: 'capture', sourceId: sharedSource,
      sessionId: 'cross-session', source: 'synthetic-cross', occurredAt: EVENT_TIME + 2, count: 1 }, EVENT_TIME + 2)
    const firstStarted = bootstrap(f)
    assert.equal(firstStarted.status, 'ok')
    const first = finishOverview(f, firstStarted.readId)
    assert.equal(first.result.sessions.items.length, 1)
    assert.equal(first.result.sessions.items[0].projectKey, PROJECT_A)
    assert.equal(first.result.sessions.items[0].linkedL0Messages, 0,
      'the B-project L0 with the same id is not joined into project A')
    const secondStarted = bootstrap(f, [projectB])
    assert.equal(secondStarted.status, 'ok')
    const second = finishOverview(f, secondStarted.readId)
    assert.equal(second.result.sessions.items.length, 1)
    assert.equal(second.result.sessions.items[0].projectKey, projectB)
    assert.equal(second.result.sessions.items[0].linkedL0Messages, 1)

    const overviewProjects = Array.from({ length: 4 }, (_unused, index) => ({
      key: `overview-resume-project-${index + 1}`, name: `Overview resume project ${index + 1}`,
    }))
    const overviewFixture = labelledFixture(overviewProjects, { managerOptions: { limits: { perCall: { sqlStatements: 40 } } } })
    try {
      const projectSources = new Map()
      for (const [index, project] of overviewProjects.entries()) {
        const store = overviewFixture.stores.get(project.key)
        assert.ok(store)
        const sourceCount = index === 0 ? 8 : 1
        const sources = Array.from({ length: sourceCount }, (_unused, sourceIndex) => store.recordL0({
          sessionId: `overview-resume-${index}-${sourceIndex}`, role: 'user',
          content: `Synthetic overview resume source ${index}-${sourceIndex}.`,
        }))
        projectSources.set(project.key, sources)
        store.addMemory({ content: `Synthetic overview candidate ${index}.`, kind: 'fact', confidence: 0.9,
          status: 'candidate', sourceMessageIds: sources, sourceVerified: true })
        store.addMemory({ content: `Synthetic overview approved ${index}.`, kind: 'fact', confidence: 0.9,
          status: 'approved', sourceMessageIds: sources, sourceVerified: true })
      }
      const projectKeys = overviewProjects.map((project) => project.key)
      const overviewStarted = bootstrap(overviewFixture, projectKeys)
      assert.equal(overviewStarted.status, 'ok')
      const overviewReader = overviewFixture.readers.at(-1)
      assert.ok(overviewReader)
      const visibilityPageCalls = []
      const pageDescriptor = Object.getOwnPropertyDescriptor(overviewReader, 'readManagedPageInternal')
      const readManagedPageInternal = overviewReader.readManagedPageInternal
      overviewReader.readManagedPageInternal = function (...args) {
        const outcome = Reflect.apply(readManagedPageInternal, this, args)
        visibilityPageCalls.push({ projectKey: args[0], status: args[1], taskKey: args[5],
          outcome: outcome.status, reason: outcome.reason })
        return outcome
      }
      const observeBudget = (reader) => {
        const diagnostics = { handoffs: [], finalBoundaries: [], resumes: [], leaseCount: 0,
          leasePayloadBytes: 0, leaseOverheadBytes: 0, peakSessionBytes: 0, peakGlobalBytes: 0, outputEnvelopes: 0 }
        const restorers = []
        const observe = (callback) => {
          try { callback() } catch (error) { diagnostics.observerFailure ??= String(error).slice(0, 512) }
        }
        for (const method of ['personaReserveStatus', 'suspendForRpc', 'resumeForRpc']) {
          const descriptor = Object.getOwnPropertyDescriptor(reader, method)
          const original = reader[method]
          Object.defineProperty(reader, method, { configurable: true, writable: true,
            enumerable: descriptor?.enumerable ?? false, value: function (...args) {
              if (method === 'suspendForRpc') observe(() => {
                const counters = this.manager.counters(this.callToken)
                if (diagnostics.handoffs.length < 4 && counters.status === 'ok') diagnostics.handoffs.push(counters.value)
              })
              const result = Reflect.apply(original, this, args)
              observe(() => {
                if (method === 'personaReserveStatus' && !result.ok) {
                  const name = result.reason === 'persona-session-headroom' ? 'firstSession' : 'firstCall'
                  if (diagnostics[name] === undefined) diagnostics[name] = { reason: result.reason,
                    phase: this.activeManagedPageItem?.key?.slice(0, 240), cost: { ...args[0] },
                    reserve: this.personaReserveCost(args[1], args[2]), remaining: this.remainingReadWorkBreakdown() }
                } else if (method === 'resumeForRpc' && result.status === 'ok') {
                  const counters = this.manager.counters(this.callToken)
                  if (diagnostics.resumes.length < 4 && counters.status === 'ok') diagnostics.resumes.push(counters.value)
                } else if (method === 'resumeForRpc' && result.status !== 'ok' && diagnostics.firstResume === undefined) {
                  diagnostics.firstResume = { status: result.status, reason: result.reason }
                }
              })
              return result
            } })
          restorers.push(() => {
            if (descriptor === undefined) delete reader[method]
            else Object.defineProperty(reader, method, descriptor)
          })
        }
        // Observe the real manager after the final probes and around every
        // resident allocation; forwarding preserves its arguments, result and errors.
        for (const method of ['finish', 'reserveResident']) {
          const manager = reader.manager
          const descriptor = Object.getOwnPropertyDescriptor(manager, method)
          const original = manager[method]
          Object.defineProperty(manager, method, { configurable: true, writable: true,
            enumerable: descriptor?.enumerable ?? false, value: function (...args) {
              let before
              if (args[0] === reader.callToken) observe(() => {
                const counters = this.counters(args[0])
                if (counters.status === 'ok') {
                  before = counters.value
                  if (method === 'finish' && diagnostics.finalBoundaries.length < 4) diagnostics.finalBoundaries.push(before)
                }
              })
              const result = Reflect.apply(original, this, args)
              if (method === 'reserveResident' && before !== undefined && result.status === 'ok') observe(() => {
                const current = this.counters(args[0])
                assert.equal(current.status, 'ok')
                const after = current.value
                assert.equal(after.sessionAccountedBytes - before.sessionAccountedBytes, args[2] + 64,
                  'each lease pays its own metadata, including replacement overlap')
                diagnostics.leaseCount += 1
                diagnostics.leasePayloadBytes += args[2]
                diagnostics.leaseOverheadBytes += 64
                diagnostics.peakSessionBytes = Math.max(diagnostics.peakSessionBytes, after.sessionAccountedBytes)
                diagnostics.peakGlobalBytes = Math.max(diagnostics.peakGlobalBytes, after.accountedBytes)
                if (args[1] === 'cache' && args[2] === 256 * 1024) diagnostics.outputEnvelopes += 1
              })
              return result
            } })
          restorers.push(() => {
            if (descriptor === undefined) delete manager[method]
            else Object.defineProperty(manager, method, descriptor)
          })
        }
        return { diagnostics, restore() { for (const restore of restorers.reverse()) restore() } }
      }
      const budgetObserver = observeBudget(overviewReader)
      let resumedOverview
      try { resumedOverview = finishOverview(overviewFixture, overviewStarted.readId) }
      finally {
        try { budgetObserver.restore() }
        finally {
          if (pageDescriptor === undefined) delete overviewReader.readManagedPageInternal
          else Object.defineProperty(overviewReader, 'readManagedPageInternal', pageDescriptor)
        }
      }
      assert.equal(budgetObserver.diagnostics.observerFailure, undefined)
      assert.equal(resumedOverview.result.status, 'ok', 'four-project low40: ' +
        JSON.stringify({ reason: resumedOverview.result.reason, continuations: resumedOverview.continuations,
          ...budgetObserver.diagnostics }))
      assert.equal(resumedOverview.result.complete, true,
        'the real four-project overview completes after item proofs pause and resume across RPCs')
      assert.equal(resumedOverview.result.readId, overviewStarted.readId)
      assert.ok(resumedOverview.continuations <= 2, 'bootstrap plus at most three full overview calls fit sixteen project visits')
      const ledger = budgetObserver.diagnostics
      assert.equal(ledger.finalBoundaries.length, resumedOverview.continuations + 1)
      assert.equal(ledger.outputEnvelopes, ledger.finalBoundaries.length, 'every published RPC pays its unchanged 256 KiB envelope')
      assert.equal(ledger.leaseOverheadBytes, ledger.leaseCount * 64)
      assert.ok(ledger.peakSessionBytes <= 4 * 1024 * 1024)
      assert.ok(ledger.peakGlobalBytes <= 8 * 1024 * 1024)
      assert.equal(ledger.resumes[0].session.projects, 8, 'the first resume includes four bootstrap and four current visits')
      for (const snapshot of ledger.finalBoundaries) {
        assert.equal(snapshot.call.projects, 4)
        assert.ok(snapshot.call.sqlStatements <= 40 && snapshot.session.sqlStatements <= 512)
        assert.ok(snapshot.call.materializedBytes <= 1024 * 1024 && snapshot.session.materializedBytes <= 8 * 1024 * 1024)
        assert.ok(snapshot.call.rowsVisited <= 2048 && snapshot.session.rowsVisited <= 32768)
        assert.ok(snapshot.call.keyBytes <= 64 * 1024 && snapshot.session.keyBytes <= 256 * 1024)
        assert.ok(snapshot.session.projects <= 16 && snapshot.session.continuations <= 16)
      }
      assert.ok(resumedOverview.continuations > 0 && resumedOverview.continuations < 16,
        'the existing continuation cap remains unchanged')
      assert.ok(visibilityPageCalls.some((call) => call.outcome === 'budget-exhausted' &&
        call.reason === 'persona-call-headroom'), 'real per-call budget exhaustion is handled by the overview scheduler')
      assert.equal(new Set(visibilityPageCalls.map((call) => call.projectKey)).size, 4,
        'one reader continues across all four selected projects')
      for (const status of ['approved', 'candidate', 'forgotten']) assert.ok(
        visibilityPageCalls.some((call) => call.status === status), `the ${status} category remains in the full scan`)
      assert.equal(overviewFixture.readers.length, 1, 'all category and project tasks use the same reader and readId')
      assert.equal(resumedOverview.result.metrics.effectiveMemories.value, 4)
      assert.equal(resumedOverview.result.metrics.candidates.value, 4)
      assert.equal(resumedOverview.result.page.projects.length, 4)
      assert.equal(resumedOverview.result.page.candidates.length, 4)
      for (const project of resumedOverview.result.page.projects) {
        assert.equal(project.approved.value, 1)
        assert.equal(project.candidates.value, 1)
        assert.equal(project.memories.value, 2)
      }
      assert.equal(projectSources.size, 4)
    } finally { overviewFixture.close() }
  } finally { f.close() }
})

test('source revocation removes a capture event from bounded session counts instead of counting it as a missing L0', () => {
  const f = realFixture()
  try {
    const source = f.store.recordL0({ sessionId: 'session-revoked', role: 'user', content: 'Synthetic revoked session source.',
      createdAt: EVENT_TIME, recordedAt: EVENT_TIME, sourceEventId: 'revoked-session-event' })
    f.control.revokeSourceEvent(PROJECT_A, 'revoked-session-event')
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.sessions.complete, true)
    assert.equal(result.sessions.scannedEvents, 0)
    assert.equal(result.sessions.items.length, 0)
    assert.equal(result.metrics.captures.value, 0)
    const pending = f.store.dashboardProcessingSourcePending(source)
    assert.equal(pending.exists, true, 'the revocation test keeps the L0 row; only the capture event is fenced')
  } finally { f.close() }
})

test('a capture event revoked after its page proof invalidates the same read before the next publish', () => {
  const f = realFixture()
  try {
    for (let index = 0; index < 16; index += 1) {
      f.store.recordL0({ sessionId: 'session-late-revoke', role: 'user', content: `Synthetic late-revoked source ${index}.`,
        createdAt: EVENT_TIME + index, recordedAt: EVENT_TIME + index, sourceEventId: `session-late-revoked-event-${index}` })
    }
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const first = f.service.read({ version: 1, action: 'overview', readId: started.readId })
    assert.ok(first.cursor, 'the bounded proof pauses with the current event page retained')
    assert.ok(first.sessions.scannedEvents > 0)
    assert.ok(first.sessions.scannedEvents < 16)
    f.control.revokeSourceEvent(PROJECT_A, 'session-late-revoked-event-0')
    const continued = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor: first.cursor })
    assert.equal(continued.status, 'stale', 'a proof from before the revocation cannot be reused after the ledger version changes')
    assert.equal(f.manager.stats().sessions, 0, 'version invalidation retires the retained page and its resident lease')
  } finally { f.close() }
})

test('an unparseable capture agent preset keeps known session rows as incomplete lower bounds', () => {
  const f = realFixture({}, ['excluded-session-agent'])
  const oversizedPreset = 'x'.repeat(513)
  try {
    f.store.recordL0({ sessionId: 'session-valid-preset', role: 'user', content: 'Synthetic valid session source.',
      createdAt: EVENT_TIME, recordedAt: EVENT_TIME })
    f.store.recordL0({ sessionId: 'session-unparseable-preset', role: 'user',
      content: 'Synthetic valid capture before the oversized preset.', createdAt: EVENT_TIME + 1, recordedAt: EVENT_TIME + 1 })
    f.store.recordL0({ sessionId: 'session-unparseable-preset', role: 'user',
      content: 'Synthetic capture with the original oversized preset.', agentPreset: oversizedPreset,
      createdAt: EVENT_TIME + 2, recordedAt: EVENT_TIME + 2 })
    const firstSource = f.store.recordL0({ sessionId: 'session-model-provider', role: 'user',
      content: 'Synthetic first capture with an invalid model projection.', createdAt: EVENT_TIME + 1, recordedAt: EVENT_TIME + 1 })
    f.store.db.prepare("UPDATE memory_events SET model = ? WHERE project_key = ? AND source_id = ? AND type = 'capture'")
      .run('x'.repeat(257), PROJECT_A, firstSource)
    const laterSource = f.store.recordL0({ sessionId: 'session-model-provider', role: 'user',
      content: 'Synthetic later capture with an invalid provider projection.', createdAt: EVENT_TIME + 2, recordedAt: EVENT_TIME + 2 })
    f.store.db.prepare("UPDATE memory_events SET provider = ? WHERE project_key = ? AND source_id = ? AND type = 'capture'")
      .run('x'.repeat(257), PROJECT_A, laterSource)
    f.store.recordL0({ sessionId: 'session-unknown-first', role: 'user',
      content: 'Synthetic first capture with the oversized preset.', agentPreset: oversizedPreset,
      createdAt: EVENT_TIME + 3, recordedAt: EVENT_TIME + 3 })
    f.store.recordL0({ sessionId: 'session-unknown-first', role: 'user',
      content: 'Synthetic valid capture after the oversized preset.', createdAt: EVENT_TIME + 4, recordedAt: EVENT_TIME + 4 })
    f.store.recordL0({ sessionId: 'session-excluded-only', role: 'user', content: 'Synthetic excluded session source.',
      agentPreset: 'excluded-session-agent', createdAt: EVENT_TIME + 5, recordedAt: EVENT_TIME + 5 })
    f.store.recordL0({ sessionId: 'session-hidden-only', role: 'user',
      content: 'Synthetic revoked session source.', createdAt: EVENT_TIME + 4, recordedAt: EVENT_TIME + 4,
      sourceEventId: 'session-hidden-event' })
    f.control.revokeSourceEvent(PROJECT_A, 'session-hidden-event')
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.sessions.complete, false, 'a skipped malformed capture cannot disappear at EOF')
    assert.equal(result.sessions.items.length, 4, 'only sessions with visible captures become rows')
    const rows = new Map(result.sessions.items.map((item) => [item.sessionId, item]))
    assert.deepEqual([...rows.keys()].sort(), [
      'session-model-provider', 'session-unknown-first', 'session-unparseable-preset', 'session-valid-preset',
    ])
    assert.equal(rows.get('session-valid-preset')?.events, 1)
    assert.equal(rows.get('session-valid-preset')?.linkedL0Complete, true)
    assert.equal(rows.get('session-valid-preset')?.identityComplete, true)
    assert.equal(rows.get('session-unparseable-preset')?.events, 1,
      'the original 513-character preset makes its known session incomplete without counting an unknown event')
    assert.equal(rows.get('session-unparseable-preset')?.linkedL0Complete, false)
    assert.equal(rows.get('session-unparseable-preset')?.identityComplete, false)
    assert.equal(rows.get('session-model-provider')?.events, 2,
      'the first and later visible malformed projections remain lower bounds for their own session')
    assert.equal(rows.get('session-model-provider')?.linkedL0Complete, false)
    assert.equal(rows.get('session-unknown-first')?.events, 1,
      'a later valid capture joins the bounded marker left by an unknown first capture')
    assert.equal(rows.get('session-unknown-first')?.linkedL0Complete, false)
    assert.equal(rows.has('session-excluded-only'), false, 'an excluded capture cannot manufacture a visible session')
    assert.equal(rows.has('session-hidden-only'), false, 'a revoked capture cannot manufacture a visible session')
    assert.equal(result.sessions.scannedEvents, 5, 'hidden, excluded, and unknown-preset captures do not enter the visible session scan')
    assert.equal(result.sessions.scannedSessions, 4, 'uncertainty markers do not count as visible sessions')
  } finally { f.close() }

  const mismatch = realFixture()
  try {
    mismatch.store.recordL0({ sessionId: 'session-mismatch-unknown', role: 'user',
      content: 'Synthetic unknown preset outside the requested detail filter.', agentPreset: oversizedPreset,
      provider: 'detail-unknown-provider', createdAt: EVENT_TIME, recordedAt: EVENT_TIME })
    mismatch.store.recordL0({ sessionId: 'session-mismatch-control', role: 'user',
      content: 'Synthetic detail mismatch control.', provider: 'detail-control-provider',
      createdAt: EVENT_TIME + 1, recordedAt: EVENT_TIME + 1 })
    const started = bootstrap(mismatch)
    assert.equal(started.status, 'ok')
    const detail = mismatch.service.read({ version: 1, action: 'detail', readId: started.readId, projectKey: PROJECT_A,
      target: { kind: 'events', dimension: 'provider', value: 'provider-not-present' } })
    assert.equal(detail.status, 'ok', 'a target-mismatched malformed row does not mark the shared read incomplete')
    assert.equal(detail.complete, true)
    assert.equal(detail.events.length, 0)
    const { result } = finishOverview(mismatch, started.readId)
    assert.equal(result.sessions.complete, false, 'the genuine unknown preset is still found by the later overview scan')
    assert.equal(result.sessions.items.length, 1, 'the unknown-only session stays absent from visible rows')
    assert.equal(result.sessions.items[0]?.sessionId, 'session-mismatch-control')
    assert.equal(result.sessions.items[0]?.linkedL0Complete, true,
      'the target-mismatched detail row does not poison independent session precision')
  } finally { mismatch.close() }

  const detailFirst = realFixture()
  try {
    detailFirst.store.recordL0({ sessionId: 'session-detail-unknown', role: 'user',
      content: 'Synthetic matching detail row with an unknown preset.', agentPreset: oversizedPreset,
      provider: 'detail-unknown-provider', createdAt: EVENT_TIME, recordedAt: EVENT_TIME })
    detailFirst.store.recordL0({ sessionId: 'session-detail-unknown', role: 'user',
      content: 'Synthetic visible capture after matching detail uncertainty.', provider: 'detail-valid-provider',
      createdAt: EVENT_TIME + 1, recordedAt: EVENT_TIME + 1 })
    detailFirst.store.recordL0({ sessionId: 'session-detail-control', role: 'user',
      content: 'Synthetic independent detail control.', provider: 'detail-control-provider',
      createdAt: EVENT_TIME + 2, recordedAt: EVENT_TIME + 2 })
    const started = bootstrap(detailFirst)
    assert.equal(started.status, 'ok')
    const detail = detailFirst.service.read({ version: 1, action: 'detail', readId: started.readId, projectKey: PROJECT_A,
      target: { kind: 'events', dimension: 'provider', value: 'detail-unknown-provider' } })
    assert.equal(detail.status, 'partial', 'a target-matched unknown projection remains visible as uncertainty')
    assert.equal(detail.complete, false)
    assert.equal(detail.events.length, 0, 'the unresolved preset is not published as an included event')
    const { result } = finishOverview(detailFirst, started.readId)
    assert.equal(result.sessions.complete, false, 'detail-first uncertainty survives into overview on the same readId')
    const rows = new Map(result.sessions.items.map((item) => [item.sessionId, item]))
    assert.equal(rows.get('session-detail-unknown')?.events, 1)
    assert.equal(rows.get('session-detail-unknown')?.linkedL0Complete, false)
    assert.equal(rows.get('session-detail-control')?.linkedL0Complete, true,
      'a localized detail-first marker does not make an independent session incomplete')
  } finally { detailFirst.close() }

  const hiddenDetail = realFixture()
  try {
    hiddenDetail.store.recordL0({ sessionId: 'session-detail-hidden-only', role: 'user',
      content: 'Synthetic hidden detail row with an invalid preset.', agentPreset: oversizedPreset,
      sourceEventId: 'detail-hidden-event', createdAt: EVENT_TIME, recordedAt: EVENT_TIME })
    hiddenDetail.control.revokeSourceEvent(PROJECT_A, 'detail-hidden-event')
    hiddenDetail.store.recordL0({ sessionId: 'session-detail-hidden-control', role: 'user',
      content: 'Synthetic independent hidden detail control.', createdAt: EVENT_TIME + 1, recordedAt: EVENT_TIME + 1 })
    const started = bootstrap(hiddenDetail)
    assert.equal(started.status, 'ok')
    const detail = hiddenDetail.service.read({ version: 1, action: 'detail', readId: started.readId, projectKey: PROJECT_A,
      target: { kind: 'events', dimension: 'date', value: DATE } })
    assert.equal(detail.status, 'ok', 'a visibility-hidden row does not mark the shared read incomplete')
    assert.equal(detail.complete, true)
    const { result } = finishOverview(hiddenDetail, started.readId)
    assert.equal(result.sessions.complete, true, 'hidden projection defects do not leak into the later sessions view')
    assert.deepEqual(result.sessions.items.map((item) => item.sessionId), ['session-detail-hidden-control'])
    assert.equal(result.sessions.items[0]?.linkedL0Complete, true)
  } finally { hiddenDetail.close() }
})

test('global persona releases its body lease on revocation and clears all leases after an exception', () => {
  const revoked = realFixture()
  try {
    const source = revoked.store.recordL0({ sessionId: 'global-persona-revoked', role: 'user',
      content: 'Synthetic source for a revoked global persona.', createdAt: EVENT_TIME, recordedAt: EVENT_TIME,
      sourceEventId: 'global-persona-revoked-event' })
    const memory = revoked.store.addMemory({ content: 'Synthetic approved global persona source.', status: 'approved',
      sourceMessageIds: [source], sourceVerified: true }).record
    mkdirSync(path.join(revoked.root, 'global'), { recursive: true })
    writeFileSync(path.join(revoked.root, 'global', 'persona.json'), JSON.stringify({ content: 'Synthetic persona.',
      sourceCount: 1, updatedAt: EVENT_TIME, sources: [{ projectKey: PROJECT_A, id: memory.id, revision: memory.revision }] }))
    revoked.control.revokeSourceEvent(PROJECT_A, 'global-persona-revoked-event')
    const started = bootstrap(revoked)
    assert.equal(started.status, 'ok')
    const reader = revoked.readers.at(-1)
    const reservations = []
    const releases = []
    const reserveReadState = reader.reserveReadState.bind(reader)
    const releaseReadState = reader.releaseReadState.bind(reader)
    reader.reserveReadState = (bytes) => {
      const result = reserveReadState(bytes)
      if (result.status === 'ok') reservations.push({ bytes, token: result.value.reservationToken })
      return result
    }
    reader.releaseReadState = (token) => {
      releases.push(token)
      return releaseReadState(token)
    }
    const result = revoked.service.read({ version: 1, action: 'globalPersona', readId: started.readId })
    assert.equal(result.status, 'partial')
    assert.equal(result.reason, 'global-persona-source-not-visible')
    const personaLease = reservations.at(-1)
    assert.equal(personaLease?.bytes, 256 * 1024)
    assert.ok(personaLease, 'the global persona body held a real resident lease while its source was proved')
    assert.ok(releases.includes(personaLease.token), 'revocation releases the body lease before publishing the partial result')
    assert.equal(revoked.service.read({ version: 1, action: 'close', readId: started.readId }).status, 'ok')
    assert.equal(revoked.manager.stats().sessions, 0, 'explicit close releases the read session')
    assert.equal(revoked.manager.stats().activeCalls, 0, 'explicit close leaves no active RPC calls')
    assert.ok(revoked.manager.stats().accountedBytes > 0, 'only finite anti-replay tombstones remain accounted after read leases are released')
    revoked.manager.close()
    assert.equal(revoked.manager.stats().accountedBytes, 0, 'manager shutdown clears its bounded tombstone ledger')
  } finally { revoked.close() }

  const closed = realFixture()
  try {
    const started = bootstrap(closed)
    assert.equal(started.status, 'ok')
    assert.equal(closed.manager.stats().accountedBytes > 0, true)
    assert.equal(closed.service.read({ version: 1, action: 'close', readId: started.readId }).status, 'ok')
    assert.equal(closed.manager.stats().sessions, 0, 'explicit close releases the read-state and output leases')
    assert.equal(closed.manager.stats().activeCalls, 0)
    assert.ok(closed.manager.stats().accountedBytes > 0, 'the bounded replay tombstone remains accounted after explicit close')
    closed.manager.close()
    assert.equal(closed.manager.stats().accountedBytes, 0)
  } finally { closed.close() }

  const broken = realFixture()
  try {
    mkdirSync(path.join(broken.root, 'global'), { recursive: true })
    writeFileSync(path.join(broken.root, 'global', 'persona.json'), '{invalid json')
    const started = bootstrap(broken)
    assert.equal(started.status, 'ok')
    const result = broken.service.read({ version: 1, action: 'globalPersona', readId: started.readId })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'global-persona-json-invalid')
    assert.equal(broken.manager.stats().sessions, 0, 'exception cleanup cancels the session and releases every resident lease')
    assert.equal(broken.manager.stats().activeCalls, 0)
    assert.ok(broken.manager.stats().accountedBytes > 0, 'exception cleanup retains only the finite replay tombstone')
    broken.manager.close()
    assert.equal(broken.manager.stats().accountedBytes, 0)
  } finally { broken.close() }
})

test('a bounded session scan pauses on materialized bytes and completes on the same readId continuation', () => {
  const f = realFixture({ limits: {
    maxContinuations: 16,
    perCall: { sqlStatements: 64, rowsVisited: 1_000, materializedBytes: 800 * 1024, keyBytes: 64 * 1024, projects: 4 },
    perSession: { sqlStatements: 256, rowsVisited: 4_096, materializedBytes: 4 * 1024 * 1024, keyBytes: 256 * 1024,
      projects: 16, continuations: 16 },
  } })
  try {
    for (let index = 0; index < 10; index += 1) {
      f.store.recordL0({ sessionId: 'session-low-budget', role: 'user', content: `Synthetic low budget session ${index}.`,
        createdAt: EVENT_TIME + index, recordedAt: EVENT_TIME + index, originalMessageIdentity: originalMessageIdentity(`${index}`.padStart(64, 'a')) })
    }
    const eventPageCalls = []
    const successfulProofs = []
    const rejectedProofs = []
    const sourceIdentityCalls = []
    const originalEventPage = f.store.dashboardReadEventPage.bind(f.store)
    f.store.dashboardReadEventPage = (...args) => {
      eventPageCalls.push(args[0])
      return originalEventPage(...args)
    }
    const originalIdentityRead = f.store.dashboardVisibilitySourceIdentity.bind(f.store)
    f.store.dashboardVisibilitySourceIdentity = (...args) => {
      sourceIdentityCalls.push(args[0])
      return originalIdentityRead(...args)
    }
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const state = f.service.states.get(started.readId)
    assert.ok(state)
    state.projects.forEach((project) => {
      project.approved.done = true
      project.candidate.done = true
      project.forgotten.done = true
    })
    state.overview.attemptsDone = true
    state.overview.billableDone = true
    state.overview.coverageDone = true
    state.processingScan.done = true
    state.page.done = true
    const reader = f.readers.at(-1)
    const verifyRepeated = reader.verifyRepeatedCaptureEvent.bind(reader)
    reader.verifyRepeatedCaptureEvent = (projectKey, sourceId, identities) => {
      const before = reader.remainingReadWork()
      const queryCount = sourceIdentityCalls.length
      const result = verifyRepeated(projectKey, sourceId, identities)
      const after = reader.remainingReadWork()
      const spent = before === undefined || after === undefined ? undefined : Object.fromEntries(
        Object.keys(before).map((key) => [key, before[key] - after[key]]))
      const proof = { projectKey, sourceId, identities: [...identities], spent,
        identityQueries: sourceIdentityCalls.length - queryCount, status: result.status }
      if (result.status === 'ok') successfulProofs.push(proof)
      else rejectedProofs.push(proof)
      return result
    }
    const first = f.service.read({ version: 1, action: 'overview', readId: started.readId })
    assert.equal(first.status, 'budget_exhausted')
    assert.equal(first.sessions.complete, false, 'a paused session scan is an explicit lower bound')
    assert.ok(first.sessions.scannedEvents < 10)
    assert.equal(eventPageCalls.length, 1, 'the bounded raw event page is read once before any buffered proof resumes')
    assert.equal(first.sessions.scannedEvents, successfulProofs.length,
      'every published event already has its complete linked-L0 proof; a denied next proof has no half-step effect')
    assert.ok(rejectedProofs.some((proof) => proof.status === 'budget-exhausted'), 'the budget-denied proof attempt is kept separate from completed proofs')
    assert.equal(rejectedProofs.every((proof) => proof.identityQueries === 0 && proof.spent !== undefined &&
      Object.values(proof.spent).every((value) => value === 0)), true,
    'a rejected proof runs no identity SQL and consumes no read-work ledger')
    let result = first
    let continuations = 0
    let replayChecked = false
    while (result.cursor !== undefined && continuations < 16) {
      const cursor = result.cursor
      result = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor })
      continuations += 1
      if (!replayChecked) {
        const replay = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor })
        assert.equal(replay.status, 'stale', 'the continuation cursor is single-use')
        assert.equal(replay.reason, 'cursor-invalid-or-consumed')
        replayChecked = true
      }
    }
    assert.equal(result.status, 'ok')
    assert.equal(result.sessions.complete, true)
    assert.equal(result.sessions.scannedEvents, 10)
    assert.equal(result.sessions.scannedSessions, 1)
    assert.equal(successfulProofs.length, 10, 'all ten rows are fully proved once across one cumulative reader session')
    assert.equal(new Set(successfulProofs.map((proof) => proof.sourceId)).size, 10, 'no buffered row is proven twice')
    assert.equal(sourceIdentityCalls.length, 10, 'only successful proofs reach the identity SQL path')
    assert.equal(eventPageCalls.length, 1, 'a continuation resumes the retained event page instead of repeating its SQL')
    assert.ok(continuations > 0)
    assert.equal(f.readers.length, 1, 'all page and proof work remains on the same reader session')
  } finally { f.close() }
})

test('processing pending is a real same-session unextracted L0, survives a page boundary, and is counted once', () => {
  const f = realFixture()
  try {
    const seeded = seedProcessingJob(f.store, { sessionId: 'processing-session', count: 17, extracted: 16 })
    const sourceQueries = []
    const processingPointIds = []
    const prepare = f.store.db.prepare.bind(f.store.db)
    f.store.db.prepare = (sql) => {
      if (sql.includes('FROM extraction_job_sources')) sourceQueries.push(sql)
      return prepare(sql)
    }
    const originalPendingPoint = f.store.dashboardProcessingSourcePending.bind(f.store)
    f.store.dashboardProcessingSourcePending = (sourceId) => {
      processingPointIds.push(sourceId)
      return originalPendingPoint(sourceId)
    }
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const state = f.service.states.get(started.readId)
    assert.ok(state)
    const { sourcePageCalls, budgetSnapshots } = observeProcessingSourcePages(f, state)
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.status, 'ok')
    assert.equal(result.processing.queued.value, 1)
    assert.equal(result.processing.queued.relation, 'exact')
    assert.equal(result.processing.oldestWaiting.state, 'exact')
    assert.equal(result.processing.oldestWaiting.value, seeded.job.createdAt)
    assert.equal(result.processing.failed.value, 0)
    assert.equal(sourceQueries.length, 2, 'the 17th pending source is reached on the second bounded page')
    assert.equal(processingPointIds.length, 17)
    assert.equal(new Set(processingPointIds).size, 17, 'each processing source is point-checked only once')
    assert.equal(sourcePageCalls.length, 2)
    assert.equal(budgetSnapshots.length, 2)
    budgetSnapshots.forEach((snapshot, index) => assertObservedReadCost(snapshot, `processing source page ${index + 1}`))
    const maximumFirstBatch = maxProcessingSourceBatch(budgetSnapshots[0].before, PROJECT_A,
      budgetSnapshots[0].afterSourceId, budgetSnapshots[0].pendingCount, state.projects.length)
    assert.ok(maximumFirstBatch > 0)
    assert.equal(sourcePageCalls[0].limit, maximumFirstBatch,
      'the first real source page uses the maximum batch admitted by its actual remaining call and session budgets')
    assert.equal(new Set(sourcePageCalls.map((call) => String(call.afterSourceId))).size, 2,
      'the paid page cursor advances; no continuation re-reads the same source page')
    const secondStarted = bootstrap(f, [PROJECT_A], 'capture', '2026-10-24')
    assert.equal(secondStarted.status, 'ok')
    const second = finishOverview(f, secondStarted.readId)
    assert.equal(second.result.processing.queued.value, result.processing.queued.value,
      'changing the selected capture date does not change current queued/oldest processing state')
    assert.equal(second.result.processing.oldestWaiting.value, result.processing.oldestWaiting.value)
  } finally { f.close() }
})

test('missing, extracted and wrong-session sources never count as pending processing work', () => {
  const f = realFixture()
  try {
    const seeded = seedProcessingJob(f.store, { sessionId: 'processing-none', count: 5, extracted: 3, missing: 1, wrongSession: 1 })
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const state = f.service.states.get(started.readId)
    assert.ok(state)
    state.projects.forEach((project) => {
      project.eventDone = true
      project.approved.done = true
      project.candidate.done = true
      project.forgotten.done = true
    })
    state.overview.attemptsDone = true
    state.overview.billableDone = true
    state.overview.coverageDone = true
    state.page.done = true
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.status, 'ok')
    assert.equal(result.processing.queued.value, 0)
    assert.equal(result.processing.queued.relation, 'exact')
    assert.equal(result.processing.failed.value, 0)
    assert.equal(result.processing.oldestWaiting.state, 'none')
    assert.equal(seeded.sourceIds.length, 5, 'the fixture returns all five generated source ids, including the deleted one')
  } finally { f.close() }
})

test('processing batch selection honors each low budget dimension and reserves the final proof', () => {
  const materializedSummaryCost = 16 * 2_560
  const materializedResumeBudget = 780 * 1_024 // Bootstrap's 768 KiB state/output leases fit, leaving a real overview budget.
  const dimensions = [
    { name: 'sql', perCall: { sqlStatements: 14, rowsVisited: 2_048, materializedBytes: 1024 * 1024, keyBytes: 32 * 1024, projects: 4 } },
    { name: 'rows', perCall: { sqlStatements: 64, rowsVisited: 32, materializedBytes: 1024 * 1024, keyBytes: 32 * 1024, projects: 4 } },
    { name: 'materialized', perCall: { sqlStatements: 64, rowsVisited: 2_048, materializedBytes: materializedResumeBudget,
      keyBytes: 32 * 1024, projects: 4 } },
  ]
  for (const dimension of dimensions) {
    const f = realFixture({ limits: { maxContinuations: 16,
      perCall: dimension.perCall,
      perSession: { sqlStatements: 256, rowsVisited: 4_096, materializedBytes: 4 * 1024 * 1024, keyBytes: 256 * 1024,
        projects: 16, continuations: 16 } } })
    try {
      seedProcessingJob(f.store, { sessionId: `processing-${dimension.name}`, count: 17, extracted: 16 })
      let materializedCandidateSources = []
      if (dimension.name === 'materialized') {
        const candidateSources = Array.from({ length: 11 }, (_unused, index) => f.store.recordL0({
          sessionId: 'materialized-candidate-proof', role: 'user',
          content: `Synthetic candidate proof source ${index}.`, createdAt: EVENT_TIME + 100 + index,
          recordedAt: EVENT_TIME + 100 + index,
        }))
        materializedCandidateSources = candidateSources
        f.store.addMemory({ content: 'Synthetic candidate with six verified sources for charged overview work.',
          status: 'candidate', sourceMessageIds: candidateSources.slice(0, 6), sourceVerified: true })
        f.store.addMemory({ content: 'Synthetic candidate with five verified sources for charged overview work.',
          status: 'candidate', sourceMessageIds: candidateSources.slice(6), sourceVerified: true })
      }
      const candidateIdentityReads = []
      const materializedReadOrder = []
      if (dimension.name === 'materialized') {
        const originalSourceIdentity = f.store.dashboardVisibilitySourceIdentity.bind(f.store)
        f.store.dashboardVisibilitySourceIdentity = (id) => {
          candidateIdentityReads.push(id)
          materializedReadOrder.push('candidate-source')
          return originalSourceIdentity(id)
        }
      }
      const sourceQueries = []
      const prepare = f.store.db.prepare.bind(f.store.db)
      f.store.db.prepare = (sql) => {
        if (sql.includes('FROM extraction_job_sources')) {
          sourceQueries.push(sql)
          if (dimension.name === 'materialized') materializedReadOrder.push('processing-source')
        }
        return prepare(sql)
      }
      const started = bootstrap(f, [PROJECT_A], 'capture', '2026-10-22')
      assert.equal(started.status, 'ok')
      const state = f.service.states.get(started.readId)
      assert.ok(state)
      const candidatePageCosts = []
      const reader = state.reader
      const remainingCandidateWork = () => {
        const remaining = reader.remainingReadWorkBreakdown()
        return remaining === undefined ? undefined : {
          call: { ...remaining.call }, session: { ...remaining.session },
        }
      }
      const readManagedPageInternal = reader.readManagedPageInternal.bind(reader)
      reader.readManagedPageInternal = (...args) => {
        const before = remainingCandidateWork()
        const outcome = readManagedPageInternal(...args)
        const after = remainingCandidateWork()
        if (args[0] === PROJECT_A && args[1] === 'candidate' && args[5] === `overview:${PROJECT_A}:candidate`) {
          candidatePageCosts.push({ outcome: outcome.status, reason: outcome.reason, before, after })
        }
        return outcome
      }
      state.projects.forEach((project) => {
        project.eventDone = true
        project.approved.done = true
        project.candidate.done = dimension.name !== 'materialized'
        project.forgotten.done = true
      })
      state.overview.attemptsDone = true
      state.overview.billableDone = true
      state.overview.coverageDone = true
      state.page.done = true
      const { sourcePageCalls, budgetSnapshots, projectReadCosts } = observeProcessingSourcePages(f, state)
      const { result, continuations } = finishOverview(f, started.readId)
      assert.equal(result.status, 'ok', `${dimension.name}: the final control/project proof still succeeds`)
      assert.equal(result.complete, true, `${dimension.name}: the full synthetic lifecycle fits its declared budget`)
      assert.equal(result.processing.queued.value, 1, `${dimension.name}: pending is found after incremental pages`)
      assert.ok(continuations > 0, `${dimension.name}: a low dimension forces at least one continuation`)
      assert.ok(sourceQueries.length >= 2, `${dimension.name}: source pages advance instead of rereading one page`)
      assert.ok(sourcePageCalls.length >= 2, `${dimension.name}: all source pages are observed on the real reader`)
      budgetSnapshots.forEach((snapshot, index) =>
        assertObservedReadCost(snapshot, `${dimension.name} processing source page ${index + 1}`))
      const maximumFirstBatch = maxProcessingSourceBatch(budgetSnapshots[0].before, PROJECT_A,
        budgetSnapshots[0].afterSourceId, budgetSnapshots[0].pendingCount, state.projects.length)
      assert.ok(maximumFirstBatch > 0, `${dimension.name}: the first source batch is budget-admissible`)
      assert.equal(sourcePageCalls[0].limit, maximumFirstBatch,
        `${dimension.name}: the first source batch is maximal for the actual remaining budgets`)
      if (dimension.name === 'materialized') {
        const firstSourceNeed = processingSourcePageNeed(sourcePageCalls[0].limit, PROJECT_A,
          budgetSnapshots[0].afterSourceId, budgetSnapshots[0].pendingCount)
        const taskKey = `overview:${PROJECT_A}:candidate`
        const continuationKeyBytes = Buffer.byteLength(JSON.stringify([
          reader.binding, PROJECT_A, 'candidate', null, null, null, taskKey,
        ]), 'utf8')
        const expectedPrefixBytes = 256 * 1_024 +
          4 * 512 + (4 * 512 + continuationKeyBytes + 512) +
          2 * 55_552 + 2 * 66_048 + 2 * 256 +
          materializedCandidateSources.length * 96 + materializedCandidateSources.length * (5 * 4_096 + 128) +
          32 * 256 + materializedSummaryCost
        const firstSourceRemaining = budgetSnapshots[0].before
        const pendingJobBytes = budgetSnapshots[0].pendingCount * 512
        const sourcePageFixedBytes = 1_024 + pendingJobBytes
        const sourcePagePerIdentityBytes = 1_024 + 256
        const materializedOnlyLimit = Math.min(15,
          Math.floor((firstSourceRemaining.call.materializedBytes - sourcePageFixedBytes) / sourcePagePerIdentityBytes),
          Math.floor((firstSourceRemaining.session.materializedBytes - sourcePageFixedBytes) / sourcePagePerIdentityBytes))
        assert.equal(state.projects[0].candidate.count, 2, 'the overview completed both charged candidate projections first')
        assert.equal(candidateIdentityReads.length, materializedCandidateSources.length,
          'the two real candidate memories carry six plus five verified L0 identities')
        assert.deepEqual([...candidateIdentityReads].sort(), [...materializedCandidateSources].sort(),
          'each of the eleven seeded L0 identities is queried exactly once')
        assert.equal(materializedResumeBudget - firstSourceRemaining.call.materializedBytes, expectedPrefixBytes,
          'the independent resident-cost formula includes the actual binding-derived raw continuation key')
        assert.equal(sourcePageCalls[0].limit, materializedOnlyLimit,
          'the observed source batch is the exact materialized-only maximum for call and session headroom')
        assert.equal(firstSourceNeed.materializedBytes,
          (sourcePageCalls[0].limit + 1) * 1_024 + sourcePageCalls[0].limit * 256 + pendingJobBytes,
          'the source-page byte charge is independently derived from row and pending-job bounds')
        assert.ok(materializedReadOrder.lastIndexOf('candidate-source') < materializedReadOrder.indexOf('processing-source'),
          'candidate source proofs finish before processing source pages use the remaining budget')
        assert.equal(candidatePageCosts.length, 1, 'the single charged candidate page fits on its real bounded read path')
        assert.equal(candidatePageCosts[0].outcome, 'ok')
        assert.ok(candidatePageCosts[0].before.call.materializedBytes - candidatePageCosts[0].after.call.materializedBytes >=
          candidateIdentityReads.length * (5 * 4_096 + 128),
        'the observed candidate page charges every bounded source identity projection before processing pages')
        assert.ok(candidatePageCosts[0].before.session.materializedBytes - candidatePageCosts[0].after.session.materializedBytes >=
          candidateIdentityReads.length * (5 * 4_096 + 128),
        'the same source identity projection work is present in cumulative session accounting')
        assert.ok(projectReadCosts.some((entry) => entry.cost.materializedBytes === materializedSummaryCost),
          'the processing summary page is also observed and charged before source paging')
        assert.ok(sourcePageCalls[0].limit < 15,
          'the observed materialized budget, rather than the fixed page-size ceiling, limits the first source batch')
        const nextNeed = processingSourcePageNeed(sourcePageCalls[0].limit + 1, PROJECT_A,
          budgetSnapshots[0].afterSourceId, budgetSnapshots[0].pendingCount)
        const remaining = budgetSnapshots[0].before
        const reserve = 2 * (1 + state.projects.length)
        for (const available of [remaining.call, remaining.session]) {
          assert.ok(nextNeed.sqlStatements + reserve <= available.sqlStatements,
            'the next source batch is not blocked by SQL headroom')
          assert.ok(nextNeed.rowsVisited + reserve <= available.rowsVisited,
            'the next source batch is not blocked by row headroom')
          assert.ok(nextNeed.keyBytes <= available.keyBytes,
            'the next source batch is not blocked by key headroom')
        }
        assert.ok(nextNeed.materializedBytes > remaining.call.materializedBytes ||
          nextNeed.materializedBytes > remaining.session.materializedBytes,
        'the next source batch is rejected by the measured materialized headroom')
        assert.ok(firstSourceNeed.materializedBytes <= remaining.call.materializedBytes &&
          firstSourceNeed.materializedBytes <= remaining.session.materializedBytes,
        'the admitted source batch fits both actual materialized budgets')
        assert.notEqual(sourcePageCalls[0].afterSourceId, sourcePageCalls[1].afterSourceId,
          'the original source scan advances its keyset across real pages')
        assert.notEqual(sourcePageCalls[0].rpcGeneration, sourcePageCalls[1].rpcGeneration,
          'materialized headroom resumes processing source paging on a later RPC')
      }
    } finally { f.close() }
  }
  const f = realFixture({ limits: { maxContinuations: 16,
    perCall: { sqlStatements: 64, rowsVisited: 2_048, materializedBytes: 1024 * 1024, keyBytes: 800, projects: 4 },
    perSession: { sqlStatements: 256, rowsVisited: 4_096, materializedBytes: 2 * 1024 * 1024, keyBytes: 4 * 1024,
      projects: 16, continuations: 16 } } })
  try {
    seedProcessingJob(f.store, { sessionId: 'processing-key', count: 3, extracted: 0 })
    const sourceQueries = []
    const prepare = f.store.db.prepare.bind(f.store.db)
    f.store.db.prepare = (sql) => {
      if (sql.includes('FROM extraction_job_sources')) sourceQueries.push(sql)
      return prepare(sql)
    }
    const started = bootstrap(f, [PROJECT_A], 'capture', '2026-10-22')
    assert.equal(started.status, 'ok')
    const state = f.service.states.get(started.readId)
    assert.ok(state)
    state.projects.forEach((project) => {
      project.eventDone = true
      project.approved.done = true
      project.candidate.done = true
      project.forgotten.done = true
    })
    state.overview.attemptsDone = true
    state.overview.billableDone = true
    state.overview.coverageDone = true
    state.page.done = true
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.status, 'budget_exhausted', 'an impossible key envelope rejects before reading a page')
    assert.equal(sourceQueries.length, 0, 'no source page is charged when the key dimension cannot admit it')
  } finally { f.close() }
})

test('a directly revoked second event sharing one L0 is absent from bounded sessions', () => {
  const f = realFixture()
  try {
    const source = f.store.recordL0({ sessionId: 'session-shared-revoke', role: 'user',
      content: 'Synthetic shared session origin.', createdAt: EVENT_TIME, recordedAt: EVENT_TIME,
      sourceEventId: 'session-shared-origin' })
    f.store.appendEvent({ eventId: 'capture:session-shared-extra', type: 'capture', sourceId: source,
      sessionId: 'session-shared-revoke', source: 'synthetic-shared', occurredAt: EVENT_TIME + 1, count: 1 }, EVENT_TIME + 1)
    f.control.revokeSourceEvent(PROJECT_A, 'session-shared-extra')
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.sessions.complete, true)
    assert.equal(result.sessions.scannedEvents, 1, 'the directly revoked second event is not counted')
    assert.equal(result.sessions.items.length, 1)
    assert.equal(result.sessions.items[0].events, 1)
    assert.equal(result.sessions.items[0].linkedL0Messages, 1)
    assert.equal(result.sessions.items[0].linkedL0Complete, true)
  } finally { f.close() }
})

test('a missing-source capture proof gap makes sessions an explicit lower bound but keeps known rows', () => {
  const f = realFixture()
  try {
    f.store.recordL0({ sessionId: 'session-known', role: 'user', content: 'Synthetic known session source.',
      createdAt: EVENT_TIME, recordedAt: EVENT_TIME })
    f.store.appendEvent({ eventId: 'capture:missing-source-session', type: 'capture',
      sourceId: 'l0_missing_unproven', sessionId: 'session-missing-source', source: 'synthetic-gap',
      occurredAt: EVENT_TIME + 1, count: 1 }, EVENT_TIME + 1)
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.sessions.complete, false, 'an unresolved capture proof cannot publish a complete session ranking')
    assert.equal(result.sessions.items.length, 1)
    assert.equal(result.sessions.items[0].sessionId, 'session-known')
    assert.equal(result.sessions.items[0].events, 1, 'the known lower bound is retained')
    assert.equal(result.sessions.items[0].linkedL0Complete, false)
    assert.equal(result.sessions.items[0].identityComplete, false)
  } finally { f.close() }
})

test('an invalid capture-row projection makes sessions incomplete without discarding known rows', () => {
  const f = realFixture()
  try {
    f.store.recordL0({ sessionId: 'session-valid', role: 'user', content: 'Synthetic valid session source.',
      createdAt: EVENT_TIME, recordedAt: EVENT_TIME })
    f.store.db.prepare(`INSERT INTO memory_events(project_key, type, count, created_at, source_id)
      VALUES (?, ?, 1, ?, NULL)`).run(PROJECT_A, 'x'.repeat(70), EVENT_TIME + 1)
    const started = bootstrap(f)
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.sessions.complete, false, 'an invalid type/key row leaves the capture scan uncertain')
    assert.equal(result.sessions.items.length, 1)
    assert.equal(result.sessions.items[0].events, 1)
    assert.equal(result.sessions.items[0].linkedL0Complete, false)
    assert.equal(result.sessions.items[0].identityComplete, false)
  } finally { f.close() }
})

test('non-text processing session owners including an empty BLOB stay incomplete instead of exact zero', () => {
  const f = realFixture()
  try {
    for (const [sessionId, blobValue] of [['processing-blob-session', 'processing-other-session'],
      ['processing-empty-blob-session', '']]) {
      seedProcessingJob(f.store, { sessionId, count: 1 })
      const sourceId = f.store.db.prepare(`SELECT source_id FROM extraction_job_sources
        WHERE job_id IN (SELECT id FROM extraction_jobs WHERE session_id = ?)`).get(sessionId).source_id
      f.store.db.prepare('UPDATE extraction_job_sources SET session_id = CAST(? AS BLOB) WHERE source_id = ?')
        .run(blobValue, sourceId)
    }
    const started = bootstrap(f, [PROJECT_A], 'capture', '2026-10-22')
    assert.equal(started.status, 'ok')
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.complete, false)
    assert.equal(result.processing.queued.relation, 'lower_bound',
      'an unparseable owner is not a verified different session')
    assert.equal(result.processing.oldestWaiting.state, 'unknown')
  } finally { f.close() }
})


function u09Attempt(index, overrides = {}) {
  const provider = overrides.provider === undefined ? 'provider-a' : overrides.provider
  const model = overrides.model === undefined ? 'shared-model' : overrides.model
  const id = `u09-attempt-${String(index).padStart(3, '0')}`
  const row = { id, idBytes: stringBytes(id), projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), createdAt: EVENT_TIME,
    state: 'complete', stateBytes: 8, provider, providerBytes: stringBytes(provider ?? ''), model, modelBytes: stringBytes(model ?? ''),
    inputTokens: index, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1, costMicros: 0,
    ...overrides }
  if (row.provider === null) { delete row.provider; row.providerBytes = 0 }
  if (row.model === null) { delete row.model; row.modelBytes = 0 }
  return row
}

function u09Billable(index, overrides = {}) {
  const id = `u09-billable-${String(index).padStart(3, '0')}`
  const label = `purpose-${index}`
  return { id, idBytes: stringBytes(id), projectKey: PROJECT_A, projectKeyBytes: stringBytes(PROJECT_A), createdAt: EVENT_TIME,
    state: 'complete', stateBytes: 8, label, labelBytes: stringBytes(label), actualTokens: index + 2, ...overrides }
}

test('U09 model usage keeps provider tuples, field evidence and unknown identities distinct', () => {
  const attempts = [
    u09Attempt(0, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costMicros: null }),
    u09Attempt(1, { inputTokens: 10, outputTokens: 5, costMicros: 7, state: 'uncertain_remote', stateBytes: 16 }),
    u09Attempt(2, { provider: 'provider-b', providerBytes: 10 }),
    u09Attempt(3, { provider: 'a/b', providerBytes: 3, model: 'c', modelBytes: 1 }),
    u09Attempt(4, { provider: 'a', providerBytes: 1, model: 'b/c', modelBytes: 3 }),
    u09Attempt(5, { provider: null, providerBytes: 0, model: null, modelBytes: 0 }),
    u09Attempt(6, { provider: 'unknown', providerBytes: 7, model: 'unknown', modelBytes: 7 }),
    u09Attempt(7, { provider: 'zero', providerBytes: 4, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costMicros: null }),
    u09Attempt(8, { provider: 'missing', providerBytes: 7, inputTokens: null, outputTokens: null }),
    u09Attempt(9, { projectKey: PROJECT_B, projectKeyBytes: stringBytes(PROJECT_B), inputTokens: 999 }),
    u09Attempt(10, { createdAt: EVENT_TIME - 2 * DAY_MS, inputTokens: 999 }),
  ]
  assert.deepEqual([Object.hasOwn(attempts[5], 'provider'), Object.hasOwn(attempts[5], 'model'),
    attempts[5].providerBytes, attempts[5].modelBytes], [false, false, 0, 0],
    'raw null identities follow the real Control projection: omitted fields with zero bytes')
  const f = fixture({ attempts, billable: [
    u09Billable(40, { projectKey: PROJECT_B, projectKeyBytes: stringBytes(PROJECT_B), actualTokens: 999 }),
    u09Billable(41, { createdAt: EVENT_TIME - 2 * DAY_MS, actualTokens: 999 }),
    u09Billable(42, { state: 'cancelled', stateBytes: 9, actualTokens: 999 }),
  ] })
  try {
    const started = bootstrap(f)
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.status, 'ok')
    const usage = result.usage.attempts
    assert.equal(usage.calls.value, 9)
    assert.equal(usage.byModel.length, 8)
    assert.equal(new Set(usage.byModel.map((group) => group.key)).size, 8)
    assert.equal(usage.grouping.selection, 'first_seen')
    assert.equal(usage.grouping.overflow, false)
    assert.equal(usage.grouping.unknownIdentityCalls.value, 1)
    const a = usage.byModel.find((group) => group.provider === 'provider-a')
    assert.equal(a.inputTokens.value, 10)
    assert.equal(a.inputTokens.relation, 'lower_bound')
    assert.deepEqual([a.inputTokens.seen, a.inputTokens.missing, a.inputTokens.uncertain], [2, 0, 1])
    assert.deepEqual([a.costMicros.seen, a.costMicros.missing, a.costMicros.uncertain], [1, 1, 1])
    const zero = usage.byModel.find((group) => group.provider === 'zero')
    assert.equal(zero.inputTokens.value, 0)
    assert.equal(zero.inputTokens.relation, 'exact', 'missing price does not erase a known zero Token receipt')
    assert.equal(zero.costMicros.value, null)
    assert.equal(zero.costMicros.relation, 'unknown')
    assert.equal(usage.byModel.find((group) => group.provider === 'missing').inputTokens.relation, 'unknown')
    assert.notEqual(usage.byModel.find((group) => group.provider === 'a/b').key, usage.byModel.find((group) => group.model === 'b/c').key)
    assert.notEqual(usage.byModel.find((group) => group.provider === null).key, usage.byModel.find((group) => group.provider === 'unknown').key)
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costMicros']) {
      assert.equal(usage.byModel.reduce((sum, group) => sum + (group[field].value ?? 0), 0), usage[field].value)
      for (const group of usage.byModel) assert.equal(group[field].seen + group[field].missing, group.count.value)
    }
    assert.equal(result.usage.billable.calls.value, 0, 'attempt totals never create a second billable total')
    assert.deepEqual(result.usage.billable.byPurpose, [], 'foreign, out-of-range and cancelled ledger rows create no purpose group')
  } finally { f.close() }
})

test('U09 overflow and paused usage pages reconcile without re-reading or double counting', () => {
  const attempts = Array.from({ length: 27 }, (_, index) => u09Attempt(index, { model: `model-${index}`, modelBytes: stringBytes(`model-${index}`) }))
  const billable = Array.from({ length: 25 }, (_, index) => u09Billable(index,
    index === 0 ? { actualTokens: 0 } : index === 1 ? { actualTokens: null }
      : index === 2 ? { state: 'uncertain', stateBytes: 9 } : index === 24 ? { label: undefined, labelBytes: 0 } : {}))
  const baseline = fixture({ attempts, billable })
  const paused = fixture({ attempts, billable, usageGroupLimitPerCall: 2 })
  try {
    const first = finishOverview(baseline, bootstrap(baseline).readId)
    const second = finishOverview(paused, bootstrap(paused).readId)
    assert.equal(first.result.status, 'ok')
    assert.equal(second.result.status, 'ok')
    assert.ok(second.continuations > 0 && second.continuations < 16)
    assert.deepEqual(second.result.usage, first.result.usage)
    for (const [section, groups, totalField, groupField] of [
      ['attempts', 'byModel', 'inputTokens', 'inputTokens'], ['billable', 'byPurpose', 'tokens', 'actualTokens'],
    ]) {
      const usage = second.result.usage[section]
      assert.equal(usage[groups].length, 10)
      assert.equal(usage.grouping.overflow, true)
      assert.equal(usage[groups][9].other, true)
      assert.equal(usage[groups].reduce((sum, group) => sum + group.count.value, 0), usage.calls.value)
      assert.equal(usage[groups].reduce((sum, group) => sum + (group[groupField].value ?? 0), 0), usage[totalField].value)
    }
    const purposes = second.result.usage.billable.byPurpose
    assert.deepEqual([purposes[0].actualTokens.value, purposes[0].actualTokens.relation, purposes[0].knownCalls.value], [0, 'exact', 1])
    assert.deepEqual([purposes[1].actualTokens.value, purposes[1].actualTokens.relation, purposes[1].actualTokens.missing,
      purposes[1].unknownCalls.value], [null, 'unknown', 1, 1])
    assert.deepEqual([purposes[2].actualTokens.relation, purposes[2].actualTokens.seen, purposes[2].actualTokens.uncertain,
      purposes[2].unknownCalls.value], ['lower_bound', 1, 1, 1])
    for (const group of purposes) assert.equal(group.actualTokens.seen + group.actualTokens.missing, group.count.value)
    assert.equal(second.result.usage.billable.grouping.unknownIdentityCalls.value, 1)
    assert.equal(second.result.usage.billable.byPurpose[9].unknownIdentityCalls.value, 1)
    assert.equal(second.result.usage.attempts.byModel[9].count.value, 18)
    assert.equal(second.result.usage.billable.byPurpose[9].count.value, 16)
    const queries = (log) => log.filter((entry) => entry[0] === 'usageQuery')
      .map((entry) => JSON.stringify(entry)).sort()
    assert.deepEqual(queries(paused.log), queries(baseline.log),
      'retained page/index progress never repeats a SELECT after a denied group lease')
    assert.equal(paused.log.filter((entry) => entry[0] === 'usageQuery').length, 4)
    assert.ok(paused.log.some((entry) => entry[0] === 'keyHeadroom'))
  } finally { baseline.close(); paused.close() }
})

test('U09 denied group keys retain the row before any total or identity is published', () => {
  const script = { attempts: [u09Attempt(1)], usageGroupLimitPerCall: 0 }
  const f = fixture(script)
  try {
    const started = bootstrap(f)
    let result = f.service.read({ version: 1, action: 'overview', readId: started.readId })
    assert.ok(result.cursor)
    assert.equal(result.usage.attempts.calls.value, 0)
    assert.equal(result.usage.attempts.calls.relation, 'lower_bound')
    assert.deepEqual(result.usage.attempts.byModel, [])
    const state = f.service.states.get(started.readId)
    assert.equal(state.overview.attemptPage.index, 0)
    assert.equal(state.overview.usage.modelGroups, undefined)
    script.usageGroupLimitPerCall = 2
    result = f.service.read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
    assert.equal(result.status, 'ok')
    assert.equal(result.complete, true)
    assert.equal(result.usage.attempts.calls.value, 1)
    assert.equal(result.usage.attempts.byModel[0].count.value, 1)
    assert.equal(f.log.filter((entry) => entry[0] === 'usageQuery' && entry[1] === 'attempt').length, 1)
    assert.ok(f.log.some((entry) => entry[0] === 'reserve' && entry[1] === 16 * 4096))
    assert.ok(f.log.some((entry) => entry[0] === 'reserveKeys' && entry[1] > 256))
  } finally { f.close() }
})

test('U09 scoped dimensions count captures and selected activity while preserving all-event groups', () => {
  const events = [captureEvent(1), captureEvent(2),
    { ...captureEvent(3), source: undefined, sourceBytes: 0 },
    event('initial_approval', 4, { source: undefined, sourceBytes: 0 }),
    event('revision', 5, { source: undefined, sourceBytes: 0 }),
    event('recall_returned', 6), event('recall_no_result', 7),
    event('inject_prepared', 8, { memoryIds: ['memory-visible'] })]
  for (const [activity, expectedTypes] of [
    ['capture', ['capture', 'capture', 'capture']], ['initial_approval', ['initial_approval']],
    ['revision', ['revision']], ['recall', ['recall_returned', 'recall_no_result']], ['injection', ['inject_prepared']],
  ]) {
    const reads = []
    const f = fixture({ events, eventPagesPerCall: 1, eventPageReads: reads })
    try {
      const started = bootstrap(f, [PROJECT_A], activity)
      const { result } = finishOverview(f, started.readId)
      assert.equal(result.complete, true)
      assert.equal(result.metrics.captures.value, 3)
      assert.equal(result.metrics.initialApprovals.value, 1)
      assert.equal(result.metrics.acceptedRevisions.value, 1)
      assert.equal(result.dimensions.sources.reduce((sum, row) => sum + row.count.value, 0), 8,
        'the additive projection does not discard or redefine all-event history')
      assert.deepEqual(result.scopedDimensions.captureSources, [
        { key: 'user', count: { value: 2, relation: 'exact' } },
        { key: 'unknown', count: { value: 1, relation: 'exact' } },
      ], 'a real missing-source capture is kept, approval/revision unknowns are not capture sources')
      assert.equal(result.scopedDimensions.activity, activity)
      assert.equal(reads.length, 1, 'both scopes are produced by the one existing event scan')
      for (const [group, dimension] of [['sources', 'source'], ['agents', 'agent'], ['agentPresets', 'agentPreset'],
        ['providers', 'provider'], ['models', 'model']]) {
        const rows = result.scopedDimensions.selected[group]
        assert.equal(rows.reduce((sum, row) => sum + row.count.value, 0), expectedTypes.length)
        const found = []
        for (const row of rows) {
          const detail = f.service.read({ version: 1, action: 'detail', readId: started.readId, projectKey: PROJECT_A,
            target: { kind: 'events', dimension, value: row.key } })
          assert.equal(detail.complete, true)
          assert.equal(detail.events.length, row.count.value, `${activity}/${dimension}/${row.key} count equals its detail`)
          found.push(...detail.events.map((entry) => entry.type))
        }
        assert.deepEqual(found.sort(), [...expectedTypes].sort())
      }
    } finally { f.close() }
  }
})

test('U09 scoped dimensions preserve incomplete bounds genuine unknown and capped overflow', () => {
  const events = Array.from({ length: 15 }, (_, index) => ({ ...captureEvent(index + 1),
    source: index === 0 ? undefined : index === 1 ? 'other' : `source-${index}`,
    sourceBytes: index === 0 ? 0 : stringBytes(index === 1 ? 'other' : `source-${index}`) }))
  events.push(event('future_unrecognized_event', 16))
  const f = fixture({ events })
  try {
    const started = bootstrap(f)
    const { result } = finishOverview(f, started.readId)
    assert.equal(result.complete, false)
    assert.equal(result.metrics.captures.value, 15)
    assert.equal(result.metrics.captures.relation, 'lower_bound')
    for (const rows of [result.scopedDimensions.captureSources, result.scopedDimensions.selected.sources]) {
      assert.equal(rows.length, 10)
      assert.equal(rows.reduce((sum, row) => sum + row.count.value, 0), 15)
      assert.ok(rows.every((row) => row.count.relation === 'lower_bound'))
      assert.deepEqual(rows[0], { key: 'unknown', count: { value: 1, relation: 'lower_bound', reason: 'checked_subset' } })
      assert.equal(rows[1].key, 'other', 'literal source named other is retained separately from overflow')
      assert.deepEqual(rows.at(-1), { key: 'other', count: { value: 6, relation: 'lower_bound', reason: 'dimension_limit' } })
    }
  } finally { f.close() }
  for (const visibility of ['hidden', 'unresolved']) {
    const guarded = fixture({ events: [{ ...captureEvent(1), source: undefined, sourceBytes: 0 }], captureVisibility: visibility })
    try {
      const started = bootstrap(guarded)
      const { result } = finishOverview(guarded, started.readId)
      assert.deepEqual(result.scopedDimensions.captureSources, [], 'unproven captures never gain a dimension row')
      assert.deepEqual(result.scopedDimensions.selected.sources, [])
      assert.equal(result.metrics.captures.value, 0)
      assert.equal(result.metrics.captures.relation, visibility === 'hidden' ? 'exact' : 'lower_bound')
      assert.equal(result.complete, visibility === 'hidden')
    } finally { guarded.close() }
  }
})
