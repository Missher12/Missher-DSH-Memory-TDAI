import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { ControlLedger } from '../lib/control.js'
import { DashboardReadSessionManager } from '../lib/dashboard-read.js'
import { DashboardVisibilityReadSession, dashboardAggregateDirectOriginProof, dashboardSceneMemberDigest,
  readDashboardManagedPageForAggregate, readDashboardRecentManagedPageForAggregate,
  withDashboardOverviewFusion } from '../lib/dashboard-visibility.js'
import { MemoryRuntime } from '../lib/memory.js'
import { openProjectStore, openProjectStoreReadOnly } from '../lib/store.js'

const PROJECT_KEY = 'u11-visibility-project'
const POLICY_KEY = 'a'.repeat(64)
const FILTER_KEY = 'b'.repeat(64)
const DIRECT_ORIGIN_LOOKUP_COST = Object.freeze({ sqlStatements: 25, rowsVisited: 96, materializedBytes: 100 * 1024 })

function makeBinding(projectKeys = [PROJECT_KEY], asOf = Date.now() + 60_000) {
  return {
    generationId: 'u11-visibility-generation', policyKey: POLICY_KEY, filterKey: FILTER_KEY,
    asOf, viewKey: 'overview', projectKeys,
  }
}

function createFixture({ projectKey = PROJECT_KEY, managerOptions = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-visibility-'))
  const projectsRoot = path.join(root, 'projects')
  const controlRoot = path.join(root, 'control')
  mkdirSync(projectsRoot, { recursive: true })
  mkdirSync(controlRoot, { recursive: true })
  const store = openProjectStore(projectsRoot, projectKey)
  const control = new ControlLedger(controlRoot)
  const manager = new DashboardReadSessionManager(managerOptions)
  const fixture = { root, projectKey, projectsRoot, controlRoot, store, control, manager,
    binding: makeBinding([projectKey]), readers: [] }
  fixture.openReader = ({ wallNow, excludedAgentPatterns, binding = fixture.binding } = {}) => {
    const result = DashboardVisibilityReadSession.open({ manager, control, stores: new Map([[projectKey, store]]),
      binding, ...(wallNow === undefined ? {} : { wallNow }),
      ...(excludedAgentPatterns === undefined ? {} : { excludedAgentPatterns }) })
    if (result.status === 'ok') fixture.readers.push(result.value)
    return result
  }
  fixture.close = () => {
    for (const reader of [...fixture.readers].reverse()) reader.cancel()
    manager.close()
    control.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
  return fixture
}

function valueOf(result) {
  assert.equal(result.status, 'ok', `expected success, received ${result.status}: ${result.reason ?? ''}`)
  return result.value
}

function failure(status, reason) { return { status, reason } }

function addApproved(store, content, extra = {}) {
  return store.addMemory({ content, status: 'approved', ...extra }).record
}

function makeDirectOriginHarness(fixture, record) {
  const revision = {
    revision: record.revision, recordedAt: record.recordedAt, validFrom: record.validFrom ?? null,
    validFromState: record.validFromState, validFromPrecision: record.validFromPrecision,
    validFromBasis: record.validFromBasis, validFromUpper: null, validFromLabel: null,
    validTo: null, supersededAt: null, sourceVerified: 0,
    contentBytes: Buffer.byteLength(record.content, 'utf8'), sourceIdsBytes: 2,
    kind: record.kind, kindBytes: Buffer.byteLength(record.kind, 'utf8'), scene: null, sceneBytes: 0,
  }
  const meta = { status: record.status, statusInvalid: false, confidence: record.confidence,
    source: record.source, sourceBytes: Buffer.byteLength(record.source, 'utf8'),
    createdAt: record.createdAt, updatedAt: record.updatedAt, approvedAt: record.approvedAt,
    forgottenAt: record.forgottenAt, expiryAt: record.expiryAt }
  const node = { projectKey: fixture.projectKey, id: record.id, meta, revision, sourceIds: [] }
  const reader = valueOf(fixture.openReader())
  const progress = { key: `origin-progress:${record.id}`, itemReservation: 'test-item', bytes: 0, stageBytes: 0,
    steps: new Map(), resources: new Map(), stages: new Map() }
  reader.activeManagedPageItem = progress
  reader.aggregateIntermediateReadDepth = 1
  reader.proveRoot = () => ({ status: 'ok', value: { state: 'visible', node } })
  return { reader, progress }
}

function insertRelation(store, id, from, to, evidenceIds, type = 'depends_on') {
  store.db.prepare(`INSERT INTO memory_relations(id, from_id, to_id, relation_type, evidence_ids,
    from_revision, to_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, from.id, to.id, type, JSON.stringify(evidenceIds), from.revision, to.revision, Date.now())
}

function prepareMemoGrowthScenario() {
  const fixture = createFixture({ managerOptions: { monotonicNow: () => 0 } })
  let setupComplete = false
  try {
    let wallNow = Date.now()
    const expiryAt = wallNow + 600_000
    const evidence = fixture.store.recordL0({ sessionId: 'memo-growth-evidence', role: 'user',
      content: 'Synthetic evidence for a bounded memo-growth dependency.' })
    const root = addApproved(fixture.store, 'Synthetic pending page body with a transitive expiry.')
    const target = addApproved(fixture.store, 'Synthetic dependency that expires during final validation.')
    const nextRoot = addApproved(fixture.store, 'Synthetic second root that forces a memo block reservation.')
    const dummies = Array.from({ length: 30 }, (_unused, index) => addApproved(fixture.store, `Synthetic memo seed ${index}.`))
    insertRelation(fixture.store, 'relation-memo-growth-root-target', root, target, [evidence])
    fixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE id = ?').run(wallNow - 30, root.id)
    fixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE id = ?').run(wallNow - 20, nextRoot.id)
    fixture.store.db.prepare('UPDATE l1_memories SET created_at = ?, expiry_at = ? WHERE id = ?')
      .run(wallNow - 10, expiryAt, target.id)
    for (const [index, record] of dummies.entries()) {
      fixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE id = ?')
        .run(wallNow + 1_000 + index, record.id)
    }

    const binding = makeBinding([fixture.projectKey], expiryAt + 60_000)
    const reader = valueOf(fixture.openReader({ binding, wallNow: () => wallNow }))
    const proofRoots = [...dummies, root]
    for (let offset = 0; offset < proofRoots.length; offset += 4) {
      for (const record of proofRoots.slice(offset, offset + 4)) {
        assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, record.id)).state, 'visible')
      }
      if (offset + 4 < proofRoots.length) valueOf(reader.advance(true))
    }
    assert.equal(reader.memo.size, 32, '30 simple roots plus the root and its dependency occupy one 32-entry memo block')
    valueOf(reader.advance(true))
    setupComplete = true
    return { fixture, reader, root, nextRoot, target, expiryAt, setWallNow: (value) => { wallNow = value } }
  } finally {
    if (!setupComplete) fixture.close()
  }
}

function fillResidentBudgetForMemoCapacity({ fixture, reader }) {
  const manager = fixture.manager
  const measuredLease = valueOf(manager.reserveResident(reader.callToken, 'cache', 1_024))
  const charged = valueOf(manager.counters(reader.callToken))
  valueOf(manager.releaseResident(reader.callToken, measuredLease.reservationToken))
  const released = valueOf(manager.counters(reader.callToken))
  assert.equal(released.call.materializedBytes, charged.call.materializedBytes,
    'releasing a real resident lease does not refund cumulative work before session retirement')
  assert.equal(released.session.materializedBytes, charged.session.materializedBytes)
  assert.ok(released.sessionAccountedBytes < charged.sessionAccountedBytes,
    'the actual reservation lease lowers resident accounting when released')
  valueOf(reader.advance(true))

  const maxSessionAccountedBytes = 4 * 1024 * 1024
  const targetAccountedBytes = maxSessionAccountedBytes - 12 * 1024
  let fillerLeases = 0
  let fillerContinuations = 1
  while (true) {
    const counters = valueOf(manager.counters(reader.callToken))
    const residentNeeded = targetAccountedBytes - counters.sessionAccountedBytes
    assert.ok(residentNeeded > 64, 'the bounded filler leaves room for the requested lease overhead')
    const callWorkRemaining = manager.limits.perCall.materializedBytes - counters.call.materializedBytes
    const bytes = Math.min(900_000, residentNeeded - 64, callWorkRemaining)
    assert.ok(bytes > 0, 'each filler reservation stays within the active call materialization allowance')
    const reserved = manager.reserveResident(reader.callToken, 'cache', bytes)
    assert.equal(reserved.status, 'ok', `real filler reservation must fit: ${reserved.reason ?? ''}`)
    fillerLeases += 1
    if (bytes === residentNeeded - 64) break
    valueOf(reader.advance(true))
    fillerContinuations += 1
  }
  const finalCounters = valueOf(manager.counters(reader.callToken))
  assert.equal(finalCounters.sessionAccountedBytes, targetAccountedBytes,
    'real S1 reservations fill the unchanged 4 MiB per-session resident ceiling to the selected margin')
  assert.ok(finalCounters.session.continuations <= manager.limits.maxContinuations,
    'resident fill uses only the existing bounded continuation path')
  return { fillerContinuations, fillerLeases, finalCounters, targetAccountedBytes }
}

function sortedIds(records) {
  return records.map((record) => record.id).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

test('a synthetic visible root agrees with the trusted current point-read reference', () => {
  const fixture = createFixture()
  try {
    const record = addApproved(fixture.store, 'Synthetic approved reference memory.')
    const candidate = fixture.store.addMemory({ content: 'Synthetic candidate remains hidden.', status: 'candidate' }).record
    const expired = addApproved(fixture.store, 'Synthetic expired memory.')
    const unresolved = addApproved(fixture.store, 'Synthetic approved row with an unbounded source list.')
    fixture.store.db.prepare('UPDATE l1_revisions SET source_message_ids = ? WHERE memory_id = ? AND revision = ?')
      .run(JSON.stringify(Array.from({ length: 101 }, (_unused, index) => `unresolved-source-${index}`)), unresolved.id, unresolved.revision)
    fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(0, expired.id)
    const reader = valueOf(fixture.openReader())

    const trusted = fixture.store.getApprovedForRead(record.id, [], Date.now())
    const resolved = valueOf(reader.resolveRoot(fixture.projectKey, record.id))
    assert.equal(trusted?.content, resolved.record?.content)
    assert.equal(trusted?.revision, resolved.record?.revision)
    assert.equal(resolved.state, 'visible')
    assert.equal(fixture.store.getApprovedForRead(candidate.id, [], Date.now()), undefined)
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, candidate.id)).state, 'hidden')
    assert.ok(fixture.store.getApprovedForRead(unresolved.id, [], Date.now()), 'the point-read reference sees the approved row')
    const unresolvedResult = valueOf(reader.resolveRoot(fixture.projectKey, unresolved.id))
    assert.equal(unresolvedResult.state, 'unresolved', 'bounded visibility work does not guess when source fanout exceeds its cap')
    assert.equal(unresolvedResult.reason, 'revision-source-json-invalid')
    assert.equal(fixture.store.getApprovedForRead(expired.id, [], Date.now()), undefined)
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, expired.id)).state, 'hidden')
  } finally {
    fixture.close()
  }
})

test('equal-createdAt keyset pages neither skip nor duplicate rows and advance through hidden-only pages', () => {
  const fixture = createFixture()
  try {
    const now = Date.now()
    const records = Array.from({ length: 19 }, (_unused, index) => addApproved(fixture.store, `Synthetic expired page row ${index}.`))
    const update = fixture.store.db.prepare('UPDATE l1_memories SET created_at = ?, expiry_at = ? WHERE id = ?')
    for (const record of records) update.run(now, 0, record.id)
    const expected = sortedIds(records)
    const reader = valueOf(fixture.openReader())

    const first = valueOf(reader.readPage(fixture.projectKey))
    assert.equal(first.items.length, 15)
    assert.ok(first.items.every((item) => item.state === 'hidden'))
    assert.equal(first.hasMore, true)
    assert.ok(first.nextCursor)
    assert.equal(first.nextCursor.createdAt, now)

    valueOf(reader.advance(true))
    const second = valueOf(reader.readPage(fixture.projectKey, first.nextCursor))
    assert.equal(second.items.length, 4)
    assert.ok(second.items.every((item) => item.state === 'hidden'))
    assert.equal(second.hasMore, false)
    assert.equal(second.nextCursor, undefined)
    assert.deepEqual([...first.items, ...second.items].map((item) => item.id), expected)
    valueOf(reader.advance(false))
  } finally {
    fixture.close()
  }
})

test('helper work, multiple roots, and continuations consume the same session row budget', () => {
  const fixture = createFixture({ managerOptions: { limits: {
    perCall: { rowsVisited: 44 }, perSession: { rowsVisited: 48 },
  }, monotonicNow: () => 0 } })
  try {
    const records = Array.from({ length: 20 }, (_unused, index) => addApproved(fixture.store, `Synthetic budget row ${index}.`))
    for (const record of records) fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = 0 WHERE id = ?').run(record.id)
    const reader = valueOf(fixture.openReader())
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, records[0].id)).state, 'hidden')
    const first = valueOf(reader.readPage(fixture.projectKey))
    assert.equal(first.items.length, 15)
    assert.equal(first.hasMore, true)
    const pageCounters = valueOf(fixture.manager.counters(reader.callToken))
    assert.equal(pageCounters.call.rowsVisited, 44,
      'open probes, the earlier root proof, candidate sentinel, row helpers, and final probe share this call counter')
    assert.equal(pageCounters.session.rowsVisited, 44, 'root proof and candidate page share the cumulative session counter')
    valueOf(reader.advance(true))
    const continuationCounters = valueOf(fixture.manager.counters(reader.callToken))
    assert.equal(continuationCounters.call.rowsVisited, 4, 'continuation version probes use the next call budget')
    assert.equal(continuationCounters.session.rowsVisited, 48, 'continuation does not reset cumulative work')
    const second = reader.readPage(fixture.projectKey, first.nextCursor)
    assert.equal(second.status, 'budget-exhausted')
    assert.equal(fixture.manager.stats().sessions, 0, 'budget failure retires the shared session')
  } finally {
    fixture.close()
  }
})

test('oversized source fanout becomes unresolved before any memory body is read', () => {
  const fixture = createFixture()
  try {
    const record = addApproved(fixture.store, 'Synthetic body must stay unread for malformed source fanout.')
    fixture.store.db.prepare('UPDATE l1_revisions SET source_message_ids = ? WHERE memory_id = ? AND revision = ?')
      .run(JSON.stringify(Array.from({ length: 101 }, (_unused, index) => `source-${index}`)), record.id, record.revision)
    let bodyReads = 0
    const readBody = fixture.store.dashboardVisibilityRevisionBody.bind(fixture.store)
    fixture.store.dashboardVisibilityRevisionBody = (...args) => { bodyReads += 1; return readBody(...args) }
    const reader = valueOf(fixture.openReader())

    const result = valueOf(reader.resolveRoot(fixture.projectKey, record.id))
    assert.equal(result.state, 'unresolved')
    assert.equal(result.reason, 'revision-source-json-invalid')
    assert.equal(bodyReads, 0)
  } finally {
    fixture.close()
  }
})

test('an overlong first candidate key fails the page instead of reporting false exhaustion', () => {
  const fixture = createFixture()
  try {
    const now = Date.now()
    const first = addApproved(fixture.store, 'Synthetic row with an overlong key.')
    addApproved(fixture.store, 'Synthetic ordinary row after the overlong key.')
    fixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE status = \'approved\'').run(now)
    fixture.store.db.prepare('UPDATE l1_memories SET id = ? WHERE id = ?').run('!'.repeat(257), first.id)
    const reader = valueOf(fixture.openReader())

    const result = reader.readPage(fixture.projectKey)
    assert.equal(result.status, 'unavailable-probe')
    assert.equal(result.reason, 'candidate-key-overlong-range-incomplete')
    assert.equal(fixture.manager.stats().sessions, 0)
  } finally {
    fixture.close()
  }
})

test('control fences, excluded agents, effective revisions, asOf, and expiry all fail closed', () => {
  const fixture = createFixture()
  try {
    const forgotten = addApproved(fixture.store, 'Synthetic memory with a forget fence.')
    fixture.control.appendControl({ eventId: `forget:${forgotten.id}`, projectKey: fixture.projectKey,
      type: 'forget', memoryId: forgotten.id, now: Date.now() })
    let reader = valueOf(fixture.openReader())
    const forgottenResult = valueOf(reader.resolveRoot(fixture.projectKey, forgotten.id))
    assert.equal(forgottenResult.state, 'hidden')
    assert.equal(forgottenResult.reason, 'memory-control-fence')
    reader.cancel()

    const revokedSource = fixture.store.recordL0({ sessionId: 'revoked-source', role: 'user',
      content: 'Synthetic source event subject to revocation.', sourceEventId: 'u11-revoked-event' })
    const revoked = addApproved(fixture.store, 'Synthetic memory with a revoked event source.',
      { sourceMessageIds: [revokedSource], sourceVerified: true })
    fixture.control.revokeSourceEvent(fixture.projectKey, 'u11-revoked-event', Date.now())
    reader = valueOf(fixture.openReader())
    const revokedResult = valueOf(reader.resolveRoot(fixture.projectKey, revoked.id))
    assert.equal(revokedResult.state, 'hidden')
    assert.equal(revokedResult.reason, 'source-event-control-fence')
    reader.cancel()

    const excludedSource = fixture.store.recordL0({ sessionId: 'excluded-source', role: 'user',
      content: 'Synthetic excluded-agent source.', agentPreset: 'private-agent' })
    const excluded = addApproved(fixture.store, 'Synthetic memory from an excluded agent.',
      { sourceMessageIds: [excludedSource], sourceVerified: true })
    reader = valueOf(fixture.openReader({ excludedAgentPatterns: ['private-agent'] }))
    const excludedResult = valueOf(reader.resolveRoot(fixture.projectKey, excluded.id))
    assert.equal(excludedResult.state, 'hidden')
    assert.equal(excludedResult.reason, 'excluded-source-agent')
    reader.cancel()

    const asOf = Date.now() + 5_000
    const historical = addApproved(fixture.store, 'Synthetic historical revision remains effective at asOf.')
    fixture.store.db.prepare(`INSERT INTO l1_revisions(revision_id, memory_id, revision, content, kind, scene,
      status, recorded_at, valid_from, valid_from_state, valid_from_precision, valid_from_basis,
      source_message_ids, source_verified) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, 'known', 'instant', 'explicit', '[]', 0)`)
      .run(`revision-future-${historical.id}`, historical.id, historical.revision + 1,
        'Synthetic future revision is not effective at asOf.', historical.kind, historical.scene ?? null, asOf - 1, asOf + 1)
    const expired = addApproved(fixture.store, 'Synthetic TTL expired memory.')
    fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = 0 WHERE id = ?').run(expired.id)
    reader = valueOf(fixture.openReader({ binding: makeBinding([fixture.projectKey], asOf) }))
    const historicalResult = valueOf(reader.resolveRoot(fixture.projectKey, historical.id))
    assert.equal(historicalResult.state, 'visible')
    assert.equal(historicalResult.record?.revision, historical.revision)
    assert.equal(historicalResult.record?.content, historical.content)
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, expired.id)).state, 'hidden')
  } finally {
    fixture.close()
  }
})

test('content-deletion fences and dependency target revision mismatches never produce visible output', () => {
  const fixture = createFixture()
  try {
    const deleted = addApproved(fixture.store, 'Synthetic memory behind a content-deletion fence.')
    fixture.control.fenceContentDeletion({ projectKey: fixture.projectKey, requestDigest: 'd'.repeat(64),
      memoryIds: [deleted.id], sourceIds: [], selectedMemoryIds: [deleted.id], selectedSourceIds: [] })
    let reader = valueOf(fixture.openReader())
    const deletedResult = valueOf(reader.resolveRoot(fixture.projectKey, deleted.id))
    assert.equal(deletedResult.state, 'hidden')
    assert.equal(deletedResult.reason, 'memory-control-fence')
    reader.cancel()

    const evidence = fixture.store.recordL0({ sessionId: 'revision-mismatch-evidence', role: 'user',
      content: 'Synthetic evidence for a stale dependency revision.' })
    const root = addApproved(fixture.store, 'Synthetic root whose target revision reference is stale.')
    const target = addApproved(fixture.store, 'Synthetic dependency target with a newer revision number.')
    insertRelation(fixture.store, 'relation-target-revision-mismatch', root, target, [evidence])
    fixture.store.db.prepare('UPDATE memory_relations SET to_revision = ? WHERE id = ?')
      .run(target.revision + 1, 'relation-target-revision-mismatch')
    reader = valueOf(fixture.openReader())
    const mismatch = valueOf(reader.resolveRoot(fixture.projectKey, root.id))
    assert.equal(mismatch.state, 'hidden')
    assert.equal(mismatch.reason, 'dependency-target-revision-mismatch')
  } finally {
    fixture.close()
  }
})

test('the immutable asOf binding selects one revision while natural TTL expiry during body reading fails closed', () => {
  const fixture = createFixture()
  try {
    const start = Date.now()
    const expiryAt = start + 1_000
    const record = addApproved(fixture.store, 'Synthetic memory that expires during a bounded read.')
    fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiryAt, record.id)
    const binding = makeBinding([fixture.projectKey], start + 10_000)
    let wallNow = start
    const reader = valueOf(fixture.openReader({ binding, wallNow: () => wallNow }))
    assert.equal(reader.binding.asOf, binding.asOf, 'the request binding keeps the caller-selected point in time')
    const validate = reader.validateBeforeRelease.bind(reader)
    reader.validateBeforeRelease = (items) => {
      wallNow = expiryAt
      return validate(items)
    }
    const result = valueOf(reader.resolveRoot(fixture.projectKey, record.id))
    assert.equal(result.state, 'unresolved')
    assert.equal(result.reason, 'visibility-proof-expired-during-read')
    assert.equal(result.record, undefined)
  } finally {
    fixture.close()
  }
})

test('approved library summary and detail use the same effective revision after a future revision is approved', () => {
  const fixture = createFixture()
  try {
    const sourceId = fixture.store.recordL0({ sessionId: 'future-revision-summary', role: 'user',
      content: 'Synthetic source for the effective revision summary.' })
    const original = addApproved(fixture.store, 'Synthetic revision visible before the future correction.', {
      kind: 'fact', scene: 'effective-scene', sourceMessageIds: [sourceId], sourceVerified: true,
    })
    const approvedAt = Date.now()
    const asOf = approvedAt + 10_000
    const futureStart = asOf + 60_000
    const candidate = fixture.store.proposeRevision({ memoryId: original.id, expectedRevision: original.revision,
      content: 'Synthetic future correction must not replace the current historical view.', kind: 'preference',
      scene: 'future-scene', sourceMessageIds: [sourceId], reason: 'Synthetic future correction', validFrom: futureStart })
    const approved = fixture.store.approveRevision(candidate.id, approvedAt)
    assert.equal(approved.record?.revision, original.revision + 1, 'the normal approval API updates the current memory row')

    const reader = valueOf(fixture.openReader({ binding: makeBinding([fixture.projectKey], asOf) }))
    const page = valueOf(reader.readManagedPage(fixture.projectKey, 'approved', undefined, 15, null))
    const summary = page.items.find((item) => item.id === original.id)?.summary
    assert.ok(summary, 'the approved library page returns a proved metadata summary')
    const detail = valueOf(reader.resolveRoot(fixture.projectKey, original.id))
    assert.equal(detail.state, 'visible')
    assert.ok(detail.record)
    assert.equal(detail.record.revision, original.revision)
    assert.equal(summary.revision, detail.record.revision)
    assert.equal(summary.kind, detail.record.kind)
    assert.equal(summary.scene, detail.record.scene)
    assert.equal(summary.contentBytes, Buffer.byteLength(detail.record.content, 'utf8'))
    assert.equal(summary.validFrom, detail.record.validFrom)
    assert.equal(summary.validFromState, detail.record.validFromState)
    assert.equal(summary.recordedAt, detail.record.recordedAt)
    assert.deepEqual(summary.sourceMessageIds, detail.record.sourceMessageIds)

    // Compare two fresh real readers with the same revision binding and task
    // key. The aggregate route may defer probes, but must produce the same
    // summary without the extra current-row projection or its byte charge.
    const measureSummary = (aggregate) => {
      const measured = valueOf(fixture.openReader({ binding: makeBinding([fixture.projectKey], asOf) }))
      const descriptor = Object.getOwnPropertyDescriptor(fixture.store, 'dashboardManagedMemory')
      const originalProjection = fixture.store.dashboardManagedMemory
      let projections = 0
      fixture.store.dashboardManagedMemory = function (...args) {
        projections += 1
        return Reflect.apply(originalProjection, this, args)
      }
      try {
        const before = valueOf(fixture.manager.counters(measured.callToken))
        const args = [fixture.projectKey, 'approved', undefined, 15, null, 'summary-cost-comparison']
        const page = valueOf(aggregate ? readDashboardManagedPageForAggregate(measured, ...args)
          : measured.readManagedPage(...args))
        const after = valueOf(fixture.manager.counters(measured.callToken))
        valueOf(measured.suspendForRpc())
        return { summary: page.items.find((item) => item.id === original.id)?.summary, projections,
          materializedBytes: after.session.materializedBytes - before.session.materializedBytes,
          sqlStatements: after.session.sqlStatements - before.session.sqlStatements }
      } finally {
        if (descriptor === undefined) delete fixture.store.dashboardManagedMemory
        else Object.defineProperty(fixture.store, 'dashboardManagedMemory', descriptor)
        measured.cancel()
      }
    }
    const libraryCost = measureSummary(false)
    const aggregateCost = measureSummary(true)
    assert.deepEqual(aggregateCost.summary, summary, 'aggregate metadata retains the effective revision and proven sources')
    assert.deepEqual(aggregateCost.summary, libraryCost.summary)
    assert.equal(libraryCost.projections, 1)
    assert.equal(aggregateCost.projections, 0)
    assert.equal(libraryCost.materializedBytes - aggregateCost.materializedBytes, 65_536 + 512,
      'only the duplicate projection byte charge disappears; final N=0 probes have no materialized-byte charge')
    assert.ok(libraryCost.sqlStatements - aggregateCost.sqlStatements >= 1,
      'the duplicate SQL disappears in addition to deferred intermediate probes')

    for (const ending of ['cancel', 'schema', 'control-schema', 'revocation', 'expiry']) {
      const fusedFixture = createFixture({ managerOptions: { monotonicNow: () => 0 } })
      const otherKey = 'u11-fusion-other'
      const otherStore = openProjectStore(fusedFixture.projectsRoot, otherKey)
      let fusedReader
      try {
        let wallNow = Date.now()
        const sourceEventId = ending === 'revocation' ? 'fusion-event'.repeat(60) : 'fusion-event'
        const source = fusedFixture.store.recordL0({ sessionId: 'fusion-source', role: 'user', content: 'Synthetic shared source.',
          sourceEventId })
        const candidate = fusedFixture.store.addMemory({ content: '卡'.repeat(5000), status: 'candidate',
          sourceMessageIds: [source], sourceVerified: true }).record
        const approved = addApproved(fusedFixture.store, 'Synthetic approved card body.', { sourceMessageIds: [source], sourceVerified: true })
        const futureRecordedAt = Date.now()
        const future = fusedFixture.store.proposeRevision({ memoryId: approved.id, expectedRevision: approved.revision,
          content: 'Synthetic future body must not replace the effective fused card.', sourceMessageIds: [source],
          reason: 'Synthetic fused future revision.', validFrom: wallNow + 120_000 }, futureRecordedAt)
        assert.equal(fusedFixture.store.approveRevision(future.id, futureRecordedAt).record.revision, approved.revision + 1)
        fusedFixture.store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(wallNow + 1000, candidate.id)
        fusedReader = valueOf(DashboardVisibilityReadSession.open({ manager: fusedFixture.manager, control: fusedFixture.control,
          stores: new Map([[fusedFixture.projectKey, fusedFixture.store], [otherKey, otherStore]]),
          binding: makeBinding([fusedFixture.projectKey, otherKey], wallNow + 60_000), wallNow: () => wallNow }))
        const count = valueOf(withDashboardOverviewFusion(fusedReader, () => readDashboardManagedPageForAggregate(
          fusedReader, fusedFixture.projectKey, 'candidate', undefined, 3, null, 'fusion-count')))
        assert.equal(count.items[0].summary.id, candidate.id)
        assert.equal(count.items[0].record, undefined)
        const beforeCard = valueOf(fusedFixture.manager.counters(fusedReader.callToken))
        const card = valueOf(withDashboardOverviewFusion(fusedReader, () => readDashboardManagedPageForAggregate(
          fusedReader, fusedFixture.projectKey, 'candidate', undefined, 1, 16 * 1024, 'fusion-card')))
        const afterCard = valueOf(fusedFixture.manager.counters(fusedReader.callToken))
        assert.equal(card.items[0].record.content, candidate.content, 'the shared count projection really acquired the bounded card body')
        assert.equal(afterCard.session.sqlStatements, beforeCard.session.sqlStatements, 'equivalent paid queries are reused across tasks')
        assert.ok(afterCard.session.materializedBytes > beforeCard.session.materializedBytes, 'new page envelopes remain charged')
        const approvedCount = valueOf(withDashboardOverviewFusion(fusedReader, () => readDashboardManagedPageForAggregate(
          fusedReader, fusedFixture.projectKey, 'approved', undefined, 3, null, 'fusion-approved')))
        assert.equal(approvedCount.items[0].summary.revision, approved.revision)
        const beforeRecent = valueOf(fusedFixture.manager.counters(fusedReader.callToken))
        const recent = valueOf(withDashboardOverviewFusion(fusedReader, () => readDashboardRecentManagedPageForAggregate(
          fusedReader, fusedFixture.projectKey, undefined, 1, 16 * 1024)))
        assert.equal(recent.items[0].record.content, approved.content)
        assert.equal(recent.items[0].record.revision, approved.revision, 'the effective revision, not the newer current row, supplies the card')
        assert.equal(valueOf(fusedFixture.manager.counters(fusedReader.callToken)).session.sqlStatements - beforeRecent.session.sqlStatements, 1,
          'recent reuses matching proof data but pays for its distinct revision body')
        assert.ok(fusedReader.overviewFusion.entries.size > 0)
        assert.ok(fusedReader.overviewFusion.entries.size <= 128)
        assert.ok(fusedReader.overviewFusion.bytes <= 2 * 1024 * 1024)
        if (ending === 'cancel') {
          // Both readers share the exact Store and control connection. The
          // trusted reader's cached schema proof must not leak into ordinary reads.
          const statements = []
          const restores = []
          let ordinary
          try {
            for (const db of [fusedFixture.store.db, fusedFixture.control.db]) {
              const descriptor = Object.getOwnPropertyDescriptor(db, 'prepare')
              const prepare = db.prepare
              db.prepare = function (...args) {
                statements.push(String(args[0]))
                return Reflect.apply(prepare, this, args)
              }
              restores.push(() => {
                if (descriptor === undefined) delete db.prepare
                else Object.defineProperty(db, 'prepare', descriptor)
              })
            }
            ordinary = valueOf(fusedFixture.openReader({ binding: makeBinding([fusedFixture.projectKey], wallNow + 60_000) }))
            const ordinaryRoot = valueOf(ordinary.resolveRoot(fusedFixture.projectKey, approved.id))
            assert.equal(ordinaryRoot.state, 'visible')
            assert.equal(ordinaryRoot.record.revision, approved.revision)
            valueOf(ordinary.suspendForRpc())
            valueOf(ordinary.resumeForRpc())
            valueOf(ordinary.publishProof())
            assert.ok(statements.length > 0)
            assert.equal(statements.some((sql) => /\bschema_version\b/iu.test(sql)), false,
              'ordinary open, proof, final and resume use no schema SQL while the trusted reader is alive')
            assert.equal(ordinary.overviewFusion, undefined)
            assert.equal(ordinary.directOriginSchemaScopes, undefined)
            assert.ok(fusedReader.overviewFusion.entries.size > 0)
          } finally {
            ordinary?.cancel()
            for (const restore of restores.reverse()) restore()
          }
          fusedReader.cancel()
        }
        else if (ending === 'expiry') {
          wallNow += 2000
          const final = fusedReader.suspendForRpc()
          assert.equal(final.status, 'stale')
          assert.equal(final.value, undefined)
        } else {
          valueOf(fusedReader.suspendForRpc())
          if (ending === 'schema') fusedFixture.store.db.exec('CREATE INDEX synthetic_fusion_schema ON l0_messages(role)')
          else if (ending === 'control-schema') fusedFixture.control.db.exec('CREATE TABLE synthetic_fusion_control_schema (id INTEGER)')
          else fusedFixture.control.revokeSourceEvent(fusedFixture.projectKey, sourceEventId, wallNow)
          const resumed = fusedReader.resumeForRpc()
          assert.equal(resumed.status, 'stale', ending)
          if (ending === 'schema' || ending === 'control-schema') assert.equal(resumed.reason, 'overview-schema-changed')
          assert.equal(resumed.value, undefined)
        }
        assert.equal(fusedFixture.manager.stats().sessions, 0, ending)
        assert.equal(fusedReader.overviewFusion, undefined, 'manager teardown releases all shared scope/entry/key leases')
      } finally {
        fusedReader?.cancel()
        otherStore.close()
        fusedFixture.close()
      }
    }

    const originFixture = createFixture()
    try {
      const auditNonOriginRead = (reader) => {
        const manager = originFixture.manager
        const snapshot = () => valueOf(manager.counters(reader.callToken))
        const before = snapshot()
        assert.equal(reader.directOriginSchemaScopes, undefined, 'opening a normal reader allocates no origin Map')
        const statements = []
        const restores = []
        for (const db of [originFixture.store.db, originFixture.control.db]) {
          const descriptor = Object.getOwnPropertyDescriptor(db, 'prepare')
          const prepare = db.prepare
          db.prepare = function (sql, ...args) {
            statements.push(String(sql))
            return prepare.call(this, sql, ...args)
          }
          restores.push(() => {
            if (descriptor === undefined) delete db.prepare
            else Object.defineProperty(db, 'prepare', descriptor)
          })
        }
        const reserve = manager.reserveResident.bind(manager)
        const release = manager.releaseResident.bind(manager)
        const requests = []
        const liveLeases = new Map()
        manager.reserveResident = (...args) => {
          const result = reserve(...args)
          if (result.status === 'ok') {
            requests.push({ kind: args[1], bytes: args[2] })
            liveLeases.set(result.value.reservationToken, args[2] + 64)
          }
          return result
        }
        manager.releaseResident = (...args) => {
          const result = release(...args)
          if (result.status === 'ok') liveLeases.delete(args[1])
          return result
        }
        return (finalDepth) => {
          try {
            const after = snapshot()
            const keyBytes = Buffer.byteLength(originFixture.projectKey, 'utf8')
            assert.ok(after.call.sqlStatements > before.call.sqlStatements && statements.length > 0,
              'the normal read really executes SQL rather than only calling a test double')
            assert.equal(statements.some((sql) => /\bschema_version\b/iu.test(sql)), false,
              'normal library, point, and source-backed reads execute no origin schema SQL')
            assert.equal(reader.directOriginSchemaScopes, undefined)
            assert.equal(requests.some(({ kind, bytes }) => kind === 'cache' &&
              (bytes === 1024 + 2 * keyBytes || bytes === 100 * 1024)), false)
            assert.equal(requests.some(({ kind, bytes }) => kind === 'key' && bytes === keyBytes), false)
            assert.equal(after.sessionAccountedBytes - before.sessionAccountedBytes,
              [...liveLeases.values()].reduce((sum, bytes) => sum + bytes, 0),
              'all additional residency is explained by the ordinary read leases, including their 64-byte overhead')
            const assertBoundary = (prior, sqlOffset, leaseCount, expectedSql) => {
              const current = snapshot()
              assert.equal(current.call.sqlStatements - prior.call.sqlStatements, expectedSql)
              assert.equal(current.call.rowsVisited - prior.call.rowsVisited, expectedSql)
              assert.equal(current.call.materializedBytes, prior.call.materializedBytes)
              assert.equal(current.call.keyBytes, prior.call.keyBytes)
              assert.equal(current.sessionAccountedBytes, prior.sessionAccountedBytes)
              assert.equal(statements.length - sqlOffset, expectedSql, 'actual boundary SQL matches the original N=0 work')
              assert.equal(requests.length, leaseCount)
              assert.equal(reader.directOriginSchemaScopes, undefined)
            }
            // Use a fresh call for the independent final-boundary checks.
            valueOf(reader.advance(true))
            for (const depth of [0, 1]) {
              reader.aggregateIntermediateReadDepth = depth
              let prior = snapshot()
              let sqlOffset = statements.length
              let leaseCount = requests.length
              valueOf(reader.publishProof())
              assertBoundary(prior, sqlOffset, leaseCount, depth === 0 ? 4 : 0)
              prior = snapshot()
              sqlOffset = statements.length
              leaseCount = requests.length
              valueOf(reader.suspendForRpc(() => {
                assertBoundary(prior, sqlOffset, leaseCount, depth === 0 ? 4 : 0)
                return { status: 'ok', value: undefined }
              }))
              valueOf(reader.resumeForRpc())
              assert.equal(snapshot().call.sqlStatements, 4, 'N=0 resume retains only the original control/project probes')
              assert.equal(snapshot().call.materializedBytes, 0)
              assert.equal(requests.length, leaseCount)
              assert.equal(reader.directOriginSchemaScopes, undefined)
            }
            reader.aggregateIntermediateReadDepth = finalDepth
            const finalSqlOffset = statements.length
            const finalLeaseCount = requests.length
            valueOf(reader.advance(false))
            assert.equal(statements.length, finalSqlOffset, 'N=0 final advance adds no publication SQL at either depth')
            assert.equal(requests.length, finalLeaseCount)
            assert.equal(reader.directOriginSchemaScopes, undefined)
            assert.equal(manager.stats().sessions, 0)
          } finally {
            manager.reserveResident = reserve
            manager.releaseResident = release
            for (const restore of restores.reverse()) restore()
          }
        }
      }
      const now = Date.now()
      const creationAt = now - 10_000
      const originalDateNow = Date.now
      let direct
      Date.now = () => creationAt
      try {
        direct = addApproved(originFixture.store, 'Synthetic direct review-labelled memory with empty reason text.',
          { source: 'review', reason: '' })
      } finally { Date.now = originalDateNow }

      let originLookups = 0
      let readerSchemaFences = 0
      const readOrigin = originFixture.store.dashboardVisibilityDirectCreationOrigin.bind(originFixture.store)
      const readSchemaVersion = originFixture.store.dashboardVisibilitySchemaVersion.bind(originFixture.store)
      originFixture.store.dashboardVisibilityDirectCreationOrigin = (memoryId) => {
        originLookups += 1
        return readOrigin(memoryId)
      }
      originFixture.store.dashboardVisibilitySchemaVersion = () => {
        readerSchemaFences += 1
        return readSchemaVersion()
      }
      const asOfBeforeSource = now + 100
      const manualReader = valueOf(originFixture.openReader({
        binding: makeBinding([originFixture.projectKey], asOfBeforeSource),
      }))
      const finishManualAudit = auditNonOriginRead(manualReader)
      const manualPage = valueOf(manualReader.readManagedPage(originFixture.projectKey, 'approved', undefined, 15, null,
        'manual-empty-source-summary'))
      const manualSummary = manualPage.items.find((item) => item.id === direct.id)?.summary
      assert.ok(manualSummary, 'the manual library summary remains visible without origin classification')
      assert.equal(manualSummary[dashboardAggregateDirectOriginProof], undefined)
      assert.equal(originLookups, 0, 'ordinary library summaries do not pay for aggregate-only origin proof')
      finishManualAudit(0)
      assert.equal(readerSchemaFences, 0, 'ordinary library reads do not acquire an origin schema scope')

      const directReader = valueOf(originFixture.openReader({
        binding: makeBinding([originFixture.projectKey], asOfBeforeSource),
      }))
      const directPage = valueOf(readDashboardManagedPageForAggregate(directReader, originFixture.projectKey,
        'approved', undefined, 15, null, 'direct-origin-empty-source'))
      const directSummary = directPage.items.find((item) => item.id === direct.id)?.summary
      assert.ok(directSummary)
      assert.deepEqual(directSummary.sourceMessageIds, [])
      assert.equal(directSummary[dashboardAggregateDirectOriginProof], true,
        'an empty TEXT reason and a matching native event prove direct creation even when event source is review')
      assert.equal(JSON.stringify(directSummary).includes('direct-origin'), false,
        'the internal proof does not enter the public summary serialization')
      assert.equal(originLookups, 1)
      assert.ok(readerSchemaFences > 0, 'only aggregate empty-source proof acquires reader schema fences')
      const schemaFencesAfterDirectRead = readerSchemaFences
      directReader.cancel()

      const pointReader = valueOf(originFixture.openReader({
        binding: makeBinding([originFixture.projectKey], asOfBeforeSource),
      }))
      const finishPointAudit = auditNonOriginRead(pointReader)
      assert.equal(valueOf(pointReader.resolveRoot(originFixture.projectKey, direct.id)).state, 'visible')
      assert.equal(originLookups, 1, 'a point read does not acquire aggregate-only origin capability')
      assert.equal(readerSchemaFences, schemaFencesAfterDirectRead,
        'point reads do not acquire or recheck the aggregate-only origin scope')
      finishPointAudit(1)

      const sourceId = originFixture.store.recordL0({ sessionId: 'later-source-addition', role: 'user',
        content: 'Synthetic source added by a later valid revision.' })
      const laterRevisionAt = now + 500
      Date.now = () => laterRevisionAt
      try {
        originFixture.store.addMemory({ content: direct.content, status: 'approved',
          sourceMessageIds: [sourceId], sourceVerified: true })
      } finally { Date.now = originalDateNow }
      const laterReader = valueOf(originFixture.openReader({
        binding: makeBinding([originFixture.projectKey], now + 1_000),
      }))
      const finishSourceAudit = auditNonOriginRead(laterReader)
      const laterPage = valueOf(readDashboardManagedPageForAggregate(laterReader, originFixture.projectKey,
        'approved', undefined, 15, null, 'direct-origin-later-source'))
      const laterSummary = laterPage.items.find((item) => item.id === direct.id)?.summary
      assert.ok(laterSummary)
      assert.deepEqual(laterSummary.sourceMessageIds, [sourceId])
      assert.equal(originLookups, 1, 'the proven nonempty selected revision does not query creation origin')
      assert.equal(readerSchemaFences, schemaFencesAfterDirectRead,
        'source-backed aggregate summaries do not acquire the empty-source origin scope')
      finishSourceAudit(0)

      const migrated = addApproved(originFixture.store, 'Synthetic migration-created approved r1 with old event.',
        { reason: '' })
      originFixture.store.db.prepare('UPDATE l1_revisions SET reason = NULL WHERE memory_id = ? AND revision = 1')
        .run(migrated.id)
      const malformed = addApproved(originFixture.store, 'Synthetic malformed first-approval metadata.', { reason: '' })
      originFixture.store.db.prepare('UPDATE memory_events SET metadata = ? WHERE event_id = ?')
        .run('{', `initial-approval:${malformed.id}`)
      const backfilled = addApproved(originFixture.store, 'Synthetic backfilled first-approval marker.', { reason: '' })
      originFixture.store.db.prepare('UPDATE memory_events SET metadata = ? WHERE event_id = ?')
        .run('{"source":"manual","backfilled":true}', `initial-approval:${backfilled.id}`)
      const mismatch = addApproved(originFixture.store, 'Synthetic mismatched first-approval memory binding.', { reason: '' })
      originFixture.store.db.prepare('UPDATE memory_events SET source_id = ? WHERE event_id = ?')
        .run('different-memory-id', `initial-approval:${mismatch.id}`)
      const missing = addApproved(originFixture.store, 'Synthetic missing first-approval event.', { reason: '' })
      originFixture.store.db.prepare('DELETE FROM memory_events WHERE event_id = ?')
        .run(`initial-approval:${missing.id}`)

      const oversizedStatus = addApproved(originFixture.store, 'Synthetic r1 with oversized status and a later selected revision.',
        { reason: '' })
      const oversizedRevisionAt = now + 700
      const laterContent = 'Synthetic valid later selected revision.'
      originFixture.store.db.prepare(`INSERT INTO l1_revisions
        (revision_id, memory_id, revision, content, kind, scene, status, recorded_at, known_to, valid_from,
         valid_from_state, valid_from_precision, valid_from_upper, valid_from_basis, valid_from_label,
         valid_to, superseded_at, source_message_ids, source_verified, reason)
        SELECT ?, id, 2, ?, kind, scene, 'approved', ?, NULL, ?, 'known', valid_from_precision, NULL,
          valid_from_basis, NULL, NULL, NULL, '[]', 0, 'Synthetic later revision'
        FROM l1_memories WHERE id = ?`)
        .run(`${oversizedStatus.id}:r2`, laterContent, oversizedRevisionAt, oversizedRevisionAt, oversizedStatus.id)
      originFixture.store.db.prepare(`UPDATE l1_revisions SET known_to = ?, superseded_at = ?
        WHERE memory_id = ? AND revision = 1`).run(oversizedRevisionAt, oversizedRevisionAt, oversizedStatus.id)
      originFixture.store.db.prepare(`UPDATE l1_memories SET content = ?, content_norm = ?, revision = 2,
        updated_at = ?, recorded_at = ?, valid_from = ?, source_message_ids = '[]', source_verified = 0
        WHERE id = ?`).run(laterContent, 'synthetic-later-selected-revision', oversizedRevisionAt, oversizedRevisionAt,
          oversizedRevisionAt, oversizedStatus.id)
      originFixture.store.db.prepare('UPDATE l1_revisions SET status = ? WHERE memory_id = ? AND revision = 1')
        .run('legacy-status-'.repeat(20_000), oversizedStatus.id)

      const malformedNumericRows = [
        { count: 't'.repeat(256 * 1024), createdAt: Buffer.alloc(256 * 1024, 0x42),
          occurredAt: 'u'.repeat(256 * 1024) },
        { count: Buffer.alloc(256 * 1024, 0x43), createdAt: 'v'.repeat(256 * 1024),
          occurredAt: Buffer.alloc(256 * 1024, 0x44) },
      ].map((values, index) => {
        const record = addApproved(originFixture.store, `Synthetic malformed event numerics ${index + 1}.`, { reason: '' })
        originFixture.store.db.prepare(`UPDATE memory_events SET count = ?, created_at = ?, occurred_at = ?
          WHERE event_id = ?`).run(values.count, values.createdAt, values.occurredAt, `initial-approval:${record.id}`)
        return record
      })
      assert.equal(readOrigin(oversizedStatus.id).creationApproved, false,
        'the r1 status predicate returns a fixed false flag instead of the oversized status text')
      for (const record of malformedNumericRows) {
        const projection = readOrigin(record.id)
        assert.equal(projection.lookupCapabilitySupported, true)
        assert.equal(projection.approvalFound, true)
        assert.equal(projection.approvalCountIsOne, false)
        assert.equal(projection.approvalCreatedAtIsSafe, false)
        assert.equal(projection.approvalOccurredAtIsSafe, false,
          'TEXT/BLOB numeric values are rejected inside SQLite before driver materialization')
      }

      const sameTime = Date.now()
      let sameMillisecondCandidate
      Date.now = () => sameTime
      try {
        sameMillisecondCandidate = addApproved(originFixture.store, 'Synthetic same-millisecond reviewed empty-source memory.',
          { status: 'candidate', reason: '' })
        originFixture.store.approve(sameMillisecondCandidate.id)
      } finally { Date.now = originalDateNow }

      const edgeReader = valueOf(originFixture.openReader())
      const pageArgs = [originFixture.projectKey, 'approved', undefined, 15, null, 'direct-origin-unknown-cases']
      let edgePageResult = readDashboardManagedPageForAggregate(edgeReader, ...pageArgs)
      let originContinuations = 0
      while (edgePageResult.status === 'budget-exhausted' && edgePageResult.reason === 'persona-call-headroom') {
        valueOf(edgeReader.suspendForRpc())
        valueOf(edgeReader.resumeForRpc())
        originContinuations += 1
        edgePageResult = readDashboardManagedPageForAggregate(edgeReader, ...pageArgs)
      }
      const edgePage = valueOf(edgePageResult)
      assert.ok(originContinuations < 16, 'bounded capability work resumes within the existing continuation cap')
      const summaryFor = (id) => edgePage.items.find((item) => item.id === id)?.summary
      for (const id of [migrated.id, malformed.id, backfilled.id, mismatch.id, missing.id, sameMillisecondCandidate.id,
        oversizedStatus.id, ...malformedNumericRows.map((record) => record.id)]) {
        const summary = summaryFor(id)
        assert.ok(summary, `the manual summary remains visible for ${id}`)
        assert.equal(summary[dashboardAggregateDirectOriginProof], false,
          `uncertain origin ${id} remains unknown instead of becoming trusted`)
      }
      assert.equal(summaryFor(oversizedStatus.id).revision, 2,
        'a malformed historical r1 status cannot hide a valid later selected revision')
      assert.equal(originLookups, 10, 'only selected empty-source rows incurred the bounded origin lookup')
      edgeReader.cancel()
    } finally { originFixture.close() }

    const unsupportedCapabilityCases = [
      { name: 'missing canonical event index',
        mutate: (db) => db.exec('DROP INDEX memory_events_event_unique') },
      { name: 'same-name wrong-column unique event index',
        mutate: (db) => db.exec(`DROP INDEX memory_events_event_unique;
          CREATE UNIQUE INDEX memory_events_event_unique ON memory_events(source_id, event_id)
            WHERE event_id IS NOT NULL`) },
      { name: 'same-name nonunique event index',
        mutate: (db) => db.exec(`DROP INDEX memory_events_event_unique;
          CREATE INDEX memory_events_event_unique ON memory_events(event_id)
            WHERE event_id IS NOT NULL`) },
      { name: 'unsupported creation revision lookup shape',
        mutate: (db) => db.exec(`DROP TABLE l1_revisions;
          CREATE TABLE l1_revisions(memory_id TEXT, revision INTEGER, status TEXT, reason TEXT)`) },
    ]
    for (const scenario of unsupportedCapabilityCases) {
      const unsupportedFixture = createFixture()
      const db = unsupportedFixture.store.db
      const originalPrepareDescriptor = Object.getOwnPropertyDescriptor(db, 'prepare')
      const originalPrepare = db.prepare
      let originDataReads = 0
      try {
        const record = addApproved(unsupportedFixture.store, `Synthetic ${scenario.name}.`, { reason: '' })
        scenario.mutate(db)
        db.prepare = function (sql, ...prepareArgs) {
          const statement = originalPrepare.call(this, sql, ...prepareArgs)
          if (String(sql).startsWith('SELECT') && String(sql).includes('FROM l1_revisions AS r INDEXED BY')) {
            const originalGet = statement.get
            statement.get = function (...args) {
              originDataReads += 1
              return originalGet.apply(this, args)
            }
          }
          return statement
        }
        const origin = unsupportedFixture.store.dashboardVisibilityDirectCreationOrigin(record.id)
        assert.equal(origin.lookupCapabilitySupported, false, scenario.name)
        assert.equal(originDataReads, 0, `${scenario.name} refuses before origin data SQL`)
      } finally {
        if (originalPrepareDescriptor === undefined) delete db.prepare
        else Object.defineProperty(db, 'prepare', originalPrepareDescriptor)
        unsupportedFixture.close()
      }
    }

    const schemaRaceFixture = createFixture()
    const raceDb = schemaRaceFixture.store.db
    const concurrentDb = new DatabaseSync(schemaRaceFixture.store.file)
    const racePrepareDescriptor = Object.getOwnPropertyDescriptor(raceDb, 'prepare')
    const raceOriginalPrepare = raceDb.prepare
    let queryPlanStatement
    let queryPlanAllDescriptor
    let attemptedConcurrentDdl = false
    let concurrentDdl = 'not-attempted'
    let concurrentDdlError
    try {
      const record = addApproved(schemaRaceFixture.store, 'Synthetic schema change during direct-origin lookup.', { reason: '' })
      const { reader } = makeDirectOriginHarness(schemaRaceFixture, record)
      raceDb.prepare = function (sql, ...prepareArgs) {
        const statement = raceOriginalPrepare.call(this, sql, ...prepareArgs)
        if (String(sql).startsWith('EXPLAIN QUERY PLAN SELECT') &&
            String(sql).includes('FROM main.l1_revisions AS r INDEXED BY')) {
          queryPlanStatement = statement
          queryPlanAllDescriptor = Object.getOwnPropertyDescriptor(statement, 'all')
          const originalAll = statement.all
          statement.all = function (...args) {
            const rows = originalAll.apply(this, args)
            if (!attemptedConcurrentDdl) {
              attemptedConcurrentDdl = true
              try {
                concurrentDb.exec('BEGIN IMMEDIATE')
                concurrentDb.exec('DROP INDEX memory_events_event_unique')
                concurrentDb.exec(`CREATE INDEX memory_events_event_unique ON memory_events(event_id)
                  WHERE event_id IS NOT NULL`)
                concurrentDb.exec('COMMIT')
                concurrentDdl = 'committed'
              } catch (error) {
                try { concurrentDb.exec('ROLLBACK') } catch { /* a failed BEGIN or COMMIT may leave no transaction */ }
                concurrentDdl = 'blocked'
                concurrentDdlError = error
              }
            }
            return rows
          }
        }
        return statement
      }
      const result = reader.resolveApprovedSummary(schemaRaceFixture.projectKey, record.id)
      assert.equal(result.status, 'ok')
      assert.equal(result.value.summary?.[dashboardAggregateDirectOriginProof], true)
      assert.equal(attemptedConcurrentDdl, true, 'a second SQLite connection attempts DDL while the origin read transaction is open')
      if (concurrentDdl === 'committed') {
        const finalFence = reader.publishProof()
        assert.equal(finalFence.status, 'stale', 'a committed concurrent DDL invalidates the final reader boundary')
      } else {
        assert.equal(concurrentDdl, 'blocked')
        const errorCode = String(concurrentDdlError?.code ?? '')
        const errorNumber = Number(concurrentDdlError?.errcode)
        assert.ok(/SQLITE_(?:BUSY|LOCKED)/u.test(errorCode) || Number.isSafeInteger(errorNumber) &&
          [5, 6].includes(errorNumber & 0xff) ||
          /database (?:is )?(?:locked|busy)/iu.test(String(concurrentDdlError?.message ?? '')),
        'a blocked concurrent DDL reports SQLite BUSY or LOCKED')
      }
    } finally {
      if (queryPlanStatement !== undefined) {
        if (queryPlanAllDescriptor === undefined) delete queryPlanStatement.all
        else Object.defineProperty(queryPlanStatement, 'all', queryPlanAllDescriptor)
      }
      if (racePrepareDescriptor === undefined) delete raceDb.prepare
      else Object.defineProperty(raceDb, 'prepare', racePrepareDescriptor)
      concurrentDb.close()
      schemaRaceFixture.close()
    }
  } finally {
    fixture.close()
  }
})

test('a final database-version probe failure cancels the read before returning a visible body', () => {
  const fixture = createFixture()
  try {
    const record = addApproved(fixture.store, 'Synthetic body blocked by the final version probe.')
    const reader = valueOf(fixture.openReader())
    fixture.manager.probeControl = () => ({ status: 'unavailable-probe', reason: 'synthetic-final-version-probe-failed' })

    const result = reader.resolveRoot(fixture.projectKey, record.id)
    assert.equal(result.status, 'unavailable-probe')
    assert.equal(result.reason, 'synthetic-final-version-probe-failed')
    assert.equal(fixture.manager.stats().sessions, 0)
  } finally {
    fixture.close()
  }

  const summaryFixture = createFixture()
  try {
    addApproved(summaryFixture.store, 'Synthetic direct summary blocked by the final version probe.')
    let originReads = 0
    const readOrigin = summaryFixture.store.dashboardVisibilityDirectCreationOrigin.bind(summaryFixture.store)
    summaryFixture.store.dashboardVisibilityDirectCreationOrigin = (memoryId) => {
      originReads += 1
      return readOrigin(memoryId)
    }
    const reader = valueOf(summaryFixture.openReader())
    const page = readDashboardManagedPageForAggregate(reader, summaryFixture.projectKey, 'approved', undefined, 15, null,
      'direct-origin-final-fence')
    assert.equal(page.status, 'ok', 'an internal aggregate page defers publication probes to its caller')
    assert.equal(page.value.items[0].summary?.[dashboardAggregateDirectOriginProof], true)
    assert.equal(originReads, 1)
    summaryFixture.manager.probeControl = () => ({ status: 'unavailable-probe', reason: 'synthetic-summary-final-version-probe-failed' })
    const published = reader.suspendForRpc()
    assert.equal(published.status, 'unavailable-probe')
    assert.equal(published.reason, 'synthetic-summary-final-version-probe-failed')
    assert.equal(published.value, undefined, 'a direct-origin proof cannot bypass the final snapshot boundary')
    assert.equal(summaryFixture.manager.stats().sessions, 0)
  } finally {
    summaryFixture.close()
  }
})

test('persona body requires every source to have a live reader proof and exact revision', () => {
  const fixture = createFixture()
  try {
    const record = addApproved(fixture.store, 'Synthetic persona source body.')
    fixture.store.setPersona('Synthetic persona body.', 1, [record.id], Date.now(), { [record.id]: record.revision })
    const reader = valueOf(fixture.openReader())
    const plan = valueOf(reader.readManagedPersonaPlan(fixture.projectKey))
    assert.equal(plan.state, 'visible')
    assert.deepEqual(plan.sourceIds, [record.id])
    const expected = { sourceCount: 1, updatedAt: plan.updatedAt, contentBytes: plan.contentBytes,
      sourceIds: plan.sourceIds, sourceRevisions: plan.sourceRevisions }
    const unproved = valueOf(reader.readManagedPersonaBody(fixture.projectKey, expected))
    assert.equal(unproved.state, 'unresolved')
    assert.equal(unproved.reason, 'persona-sources-not-proven')
    assert.equal(unproved.content, undefined)

    assert.equal(valueOf(reader.proveManagedPersonaSource(fixture.projectKey, record.id, record.revision)), 'visible')
    const proved = valueOf(reader.readManagedPersonaBody(fixture.projectKey, expected))
    assert.equal(proved.state, 'visible')
    assert.equal(proved.content, 'Synthetic persona body.')
  } finally { fixture.close() }
})

test('event-memory batch verification defers the per-item probe but keeps the final proof', () => {
  const fixture = createFixture()
  try {
    const record = addApproved(fixture.store, 'Synthetic event-memory proof with a deferred per-item boundary.')
    const reader = valueOf(fixture.openReader())
    let controlProbes = 0
    let projectProbes = 0
    const originalControl = fixture.manager.probeControl.bind(fixture.manager)
    const originalProject = fixture.manager.probeProject.bind(fixture.manager)
    fixture.manager.probeControl = (...args) => {
      controlProbes += 1
      return originalControl(...args)
    }
    fixture.manager.probeProject = (...args) => {
      projectProbes += 1
      return originalProject(...args)
    }

    const proof = valueOf(reader.verifyEventMemory(fixture.projectKey, record.id, false))
    assert.equal(proof.state, 'visible')
    assert.equal(controlProbes, 0, 'the batch path does not spend a second per-item version probe')
    assert.equal(projectProbes, 0, 'the batch path leaves both scopes to the final proof')
    valueOf(reader.suspendForRpc())
    assert.equal(controlProbes, 1, 'the retained final proof still probes control')
    assert.equal(projectProbes, 1, 'the retained final proof still probes the project')
  } finally {
    fixture.close()
  }
})

test('retained L0 identity is unresolved without a capture mapping and visible from a later raw event page', () => {
  const fixture = createFixture()
  try {
    const missingSource = fixture.store.recordL0({ sessionId: 'missing-map', role: 'user',
      content: 'Synthetic L0 source without retained identity mapping.', sourceEventId: 'missing-map-event' })
    const missing = addApproved(fixture.store, 'Synthetic memory with no retained capture mapping.',
      { sourceMessageIds: [missingSource], sourceVerified: true })
    fixture.store.db.prepare('DELETE FROM l0_messages WHERE id = ?').run(missingSource)
    fixture.store.db.prepare('DELETE FROM memory_events WHERE event_id = ?').run('capture:missing-map-event')
    let reader = valueOf(fixture.openReader())
    const missingResult = valueOf(reader.resolveRoot(fixture.projectKey, missing.id))
    assert.equal(missingResult.state, 'unresolved')
    assert.equal(missingResult.reason, 'legacy-source-identity-not-proven')
    reader.cancel()

    for (let index = 0; index < 18; index += 1) fixture.store.appendEvent({
      eventId: `visibility-noise-${index}`, type: 'synthetic_noise', source: 'other-source', sourceId: `noise-${index}`,
      metadata: { sourceKind: 'synthetic' },
    })
    const retainedSource = fixture.store.recordL0({ sessionId: 'retained-map', role: 'user',
      content: 'Synthetic source whose event mapping survives L0 pruning.', sourceEventId: 'retained-map-event' })
    const retained = addApproved(fixture.store, 'Synthetic memory with retained capture identity.',
      { sourceMessageIds: [retainedSource], sourceVerified: true })
    fixture.store.db.prepare('DELETE FROM l0_messages WHERE id = ?').run(retainedSource)
    reader = valueOf(fixture.openReader())
    const retainedResult = valueOf(reader.resolveRoot(fixture.projectKey, retained.id))
    assert.equal(retainedResult.state, 'visible', 'the capture event appears after the first raw rowid page')
    assert.equal(retainedResult.record?.id, retained.id)
    reader.cancel()

    const excludedSource = fixture.store.recordL0({ sessionId: 'retained-excluded-map', role: 'user',
      content: 'Synthetic excluded agent identity retained in capture metadata.', sourceEventId: 'retained-excluded-event',
      agentPreset: 'private-agent' })
    const excluded = addApproved(fixture.store, 'Synthetic memory with excluded retained source.',
      { sourceMessageIds: [excludedSource], sourceVerified: true })
    fixture.store.db.prepare('DELETE FROM l0_messages WHERE id = ?').run(excludedSource)
    reader = valueOf(fixture.openReader({ excludedAgentPatterns: ['private-agent'] }))
    const excludedResult = valueOf(reader.resolveRoot(fixture.projectKey, excluded.id))
    assert.equal(excludedResult.state, 'hidden')
    assert.equal(excludedResult.reason, 'excluded-source-agent')
  } finally {
    fixture.close()
  }
})

test('self and multi-node cycles are unresolved while a diamond dependency graph remains visible', () => {
  const fixture = createFixture()
  try {
    const evidence = fixture.store.recordL0({ sessionId: 'graph-evidence', role: 'user', content: 'Synthetic dependency evidence.' })
    const self = addApproved(fixture.store, 'Synthetic self-cycle root.')
    insertRelation(fixture.store, 'relation-self', self, self, [evidence])

    const cycleA = addApproved(fixture.store, 'Synthetic two-node cycle A.')
    const cycleB = addApproved(fixture.store, 'Synthetic two-node cycle B.')
    insertRelation(fixture.store, 'relation-cycle-a-b', cycleA, cycleB, [evidence])
    insertRelation(fixture.store, 'relation-cycle-b-a', cycleB, cycleA, [evidence])

    const diamondRoot = addApproved(fixture.store, 'Synthetic diamond root.')
    const left = addApproved(fixture.store, 'Synthetic diamond left branch.')
    const right = addApproved(fixture.store, 'Synthetic diamond right branch.')
    const leaf = addApproved(fixture.store, 'Synthetic shared diamond leaf.')
    insertRelation(fixture.store, 'relation-diamond-root-left', diamondRoot, left, [evidence])
    insertRelation(fixture.store, 'relation-diamond-root-right', diamondRoot, right, [evidence])
    insertRelation(fixture.store, 'relation-diamond-left-leaf', left, leaf, [evidence])
    insertRelation(fixture.store, 'relation-diamond-right-leaf', right, leaf, [evidence])

    const reader = valueOf(fixture.openReader())
    const selfResult = valueOf(reader.resolveRoot(fixture.projectKey, self.id))
    assert.equal(selfResult.state, 'unresolved')
    assert.equal(selfResult.reason, 'dependency-cycle')
    const cycleResult = valueOf(reader.resolveRoot(fixture.projectKey, cycleA.id))
    assert.equal(cycleResult.state, 'unresolved')
    assert.equal(cycleResult.reason, 'dependency-cycle')
    const diamondResult = valueOf(reader.resolveRoot(fixture.projectKey, diamondRoot.id))
    assert.equal(diamondResult.state, 'visible')
    assert.equal(diamondResult.record?.id, diamondRoot.id)
  } finally {
    fixture.close()
  }
})

test('missing revisions, missing evidence, relation truncation, and a stale memo never yield visible output', () => {
  const fixture = createFixture({ managerOptions: { monotonicNow: () => 0 } })
  try {
    const missingRevision = addApproved(fixture.store, 'Synthetic memory whose approved revision is removed.')
    fixture.store.db.prepare('DELETE FROM l1_revisions WHERE memory_id = ?').run(missingRevision.id)

    const evidence = fixture.store.recordL0({ sessionId: 'missing-evidence-setup', role: 'user', content: 'Synthetic graph setup.' })
    const missingEvidenceRoot = addApproved(fixture.store, 'Synthetic root with absent relation evidence.')
    const missingEvidenceTarget = addApproved(fixture.store, 'Synthetic target with absent relation evidence.')
    insertRelation(fixture.store, 'relation-missing-evidence', missingEvidenceRoot, missingEvidenceTarget, ['absent-l0-evidence'])

    const truncated = addApproved(fixture.store, 'Synthetic root with too many raw relations.')
    const insertRaw = fixture.store.db.prepare(`INSERT INTO memory_relations(id, from_id, to_id, relation_type,
      evidence_ids, from_revision, to_revision, created_at) VALUES (?, ?, ?, 'related_to', '[]', ?, 1, ?)`)
    for (let index = 0; index < 201; index += 1) {
      insertRaw.run(`relation-truncated-${index}`, truncated.id, `unknown-target-${String(index).padStart(3, '0')}`,
        truncated.revision, Date.now())
    }

    const staleTarget = addApproved(fixture.store, 'Synthetic memory used to create a memo before a write.')
    const reader = valueOf(fixture.openReader())
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, missingRevision.id)).state, 'hidden')
    const evidenceResult = valueOf(reader.resolveRoot(fixture.projectKey, missingEvidenceRoot.id))
    assert.equal(evidenceResult.state, 'hidden')
    assert.equal(evidenceResult.reason, 'dependency-evidence-source-missing')
    const truncatedResult = valueOf(reader.resolveRoot(fixture.projectKey, truncated.id))
    assert.equal(truncatedResult.state, 'unresolved')
    assert.equal(truncatedResult.reason, 'relation-row-limit')
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, staleTarget.id)).state, 'visible')
    valueOf(reader.advance(true))
    fixture.store.addMemory({ content: 'Synthetic unrelated write invalidates the existing memo.', status: 'approved' })
    assert.equal(reader.resolveRoot(fixture.projectKey, staleTarget.id).status, 'stale')
    void evidence
  } finally {
    fixture.close()
  }
})

test('long source and evidence keys stay accounted while page bodies accumulate, then release on success or failure', () => {
  const fixture = createFixture({ managerOptions: { monotonicNow: () => 0 } })
  try {
    const seed = fixture.store.recordL0({ sessionId: 'long-source-seed', role: 'user', content: 'Synthetic long-key seed.' })
    const longSourceId = `source-${'s'.repeat(230)}`
    fixture.store.db.prepare('UPDATE l0_messages SET id = ? WHERE id = ?').run(longSourceId, seed)
    const contents = ['A'.repeat(2048), 'B'.repeat(2048), 'C'.repeat(2048)]
    const records = contents.map((content, index) => addApproved(fixture.store, content,
      { sourceMessageIds: [longSourceId], sourceVerified: true, scene: `resource-${index}` }))
    insertRelation(fixture.store, 'relation-long-evidence', records[0], records[1], [longSourceId])
    const reader = valueOf(fixture.openReader())
    const baselineResident = fixture.manager.stats().accountedBytes
    let residentAtValidation = 0
    const validate = reader.validateBeforeRelease.bind(reader)
    reader.validateBeforeRelease = (items) => {
      residentAtValidation = fixture.manager.stats().accountedBytes
      return validate(items)
    }

    const page = valueOf(reader.readPage(fixture.projectKey))
    assert.equal(page.items.length, 3)
    assert.ok(page.items.every((item) => item.state === 'visible'))
    assert.ok(residentAtValidation - baselineResident >= contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0),
      'all body leases remain resident until the whole page passes its final version and TTL checks')
    assert.ok(fixture.manager.stats().accountedBytes < residentAtValidation,
      'the returned page releases reader-owned body leases after validation')
    const counters = valueOf(fixture.manager.counters(reader.callToken))
    assert.ok(counters.call.keyBytes >= Buffer.byteLength(longSourceId, 'utf8') * 4,
      'memory-source and relation-evidence keys are charged at their full UTF-8 size')

    valueOf(reader.advance(false))
    assert.equal(fixture.manager.stats().sessions, 0)
    const failing = addApproved(fixture.store, 'Synthetic visible body used for failure cleanup.')
    const now = Date.now()
    let failClock = false
    const failureReader = valueOf(fixture.openReader({ wallNow: () => failClock ? Number.NaN : now }))
    const validateFailure = failureReader.validateBeforeRelease.bind(failureReader)
    failureReader.validateBeforeRelease = (items) => {
      failClock = true
      return validateFailure(items)
    }
    const failed = failureReader.resolveRoot(fixture.projectKey, failing.id)
    assert.equal(failed.status, 'unavailable-probe')
    assert.equal(failed.reason, 'visibility-wall-clock-invalid')
    assert.equal(fixture.manager.stats().sessions, 0, 'failure cancels the session and drops its memo reservations')
    assert.equal(failureReader.resolveRoot(fixture.projectKey, failing.id).status, 'stale')
    const followUp = valueOf(fixture.openReader({ wallNow: () => now }))
    assert.equal(valueOf(followUp.resolveRoot(fixture.projectKey, failing.id)).state, 'visible')
  } finally {
    fixture.close()
  }
})

test('three maximum source-event IDs and the full source-identity projection stay accounted while used', () => {
  const fixture = createFixture()
  try {
    const sourceIds = Array.from({ length: 3 }, (_unused, index) => fixture.store.recordL0({
      sessionId: `maximum-event-${index}`, role: 'user', content: `Synthetic maximum source event ${index}.`,
      sourceEventId: `e${index}-` + 'x'.repeat(1997),
    }))
    const record = addApproved(fixture.store, 'Synthetic memory with three maximum source-event identities.',
      { sourceMessageIds: sourceIds, sourceVerified: true })
    const reader = valueOf(fixture.openReader())
    const baselineResident = fixture.manager.stats().accountedBytes
    const baselineCounters = valueOf(fixture.manager.counters(reader.callToken))
    const originalReserve = fixture.manager.reserveResident.bind(fixture.manager)
    const identityProjectionCharges = []
    fixture.manager.reserveResident = (callToken, kind, bytes) => {
      const before = valueOf(fixture.manager.counters(callToken))
      const reserved = originalReserve(callToken, kind, bytes)
      if (kind === 'cache' && bytes === 20_608 && reserved.status === 'ok') {
        const after = valueOf(fixture.manager.counters(callToken))
        identityProjectionCharges.push({ token: reserved.value.reservationToken, before, after })
      }
      return reserved
    }
    const originalFences = fixture.control.dashboardVisibilityFences.bind(fixture.control)
    const originalResolveRoot = reader.resolveRoot.bind(reader)
    let publicRootCalls = 0
    reader.resolveRoot = (...args) => {
      publicRootCalls += 1
      return originalResolveRoot(...args)
    }
    let residentAtEventFence = 0
    let observedEventIds = []
    fixture.control.dashboardVisibilityFences = (input) => {
      if (input.sourceEventIds?.length === 3) {
        observedEventIds = [...input.sourceEventIds]
        residentAtEventFence = fixture.manager.stats().accountedBytes
      }
      return originalFences(input)
    }

    const result = valueOf(reader.resolveRoot(fixture.projectKey, record.id))
    assert.equal(result.state, 'visible')
    assert.equal(publicRootCalls, 1, 'a direct root proof does not recursively re-enter the public method')
    assert.equal(identityProjectionCharges.length, 3, 'each identity projection is reserved once at its real cache-charge point')
    for (const charge of identityProjectionCharges) {
      assert.equal(charge.after.call.materializedBytes - charge.before.call.materializedBytes, 20_608,
        'the call ledger records one full identity projection at reservation')
      assert.equal(charge.after.session.materializedBytes - charge.before.session.materializedBytes, 20_608,
        'the session ledger records one full identity projection at reservation')
      assert.equal(charge.after.sessionAccountedBytes - charge.before.sessionAccountedBytes, 20_672,
        'the resident ledger adds the 64-byte reservation metadata to the projection')
    }
    const completedCounters = valueOf(fixture.manager.counters(reader.callToken))
    assert.ok(completedCounters.session.materializedBytes - baselineCounters.session.materializedBytes >= 3 * 20_608,
      'the cumulative session ledger includes all three identity projections')
    assert.equal(observedEventIds.length, 3)
    assert.ok(observedEventIds.every((eventId) => Buffer.byteLength(eventId, 'utf8') === 2000))
    assert.ok(residentAtEventFence - baselineResident >= 3 * 20_672 + 3 * (2000 * 2 + 128 + 64),
      'all three identity projections and event-ID leases include metadata through the revocation fence query')
    assert.ok(residentAtEventFence - fixture.manager.stats().accountedBytes >=
      3 * 20_672 + 3 * (2000 * 2 + 128 + 64),
      'identity projection and source-event leases release after proof completion while the memo remains')
  } finally {
    fixture.close()
  }
})

test('a linked-capture proof reserves its complete budget before any fence or identity SQL', () => {
  const identityProjectionBytes = 5 * 4_096 + 128
  const cacheFloorDifference = (eventCount) => {
    const prior = 96 + identityProjectionBytes + eventCount * 96
    const actual = Math.max(256, 96) + Math.max(256, identityProjectionBytes) +
      (eventCount > 0 ? Math.max(256, eventCount * 96) : 0)
    return actual - prior
  }
  assert.deepEqual([0, 1, 2].map(cacheFloorDifference), [160, 320, 224],
    'complete admission includes the actual 256-byte cache floor for zero, one, and two event IDs')

  const eventIds = ['synthetic-preflight-source-event', 'capture:synthetic-preflight-direct-event']
  const denyWithoutMutation = (fixture, sessionId, prepareBudget) => {
    const sourceEventId = 'synthetic-preflight-source-event'
    const sourceId = fixture.store.recordL0({ sessionId, role: 'user',
      content: 'Synthetic source for complete linked-capture admission.', sourceEventId })
    const reader = valueOf(fixture.openReader())
    const releaseGuard = reader.beginPersonaProofGuard(1)
    try {
      prepareBudget(reader, sourceId)
      const beforeProof = valueOf(fixture.manager.counters(reader.callToken))
      const beforeResident = fixture.manager.stats().accountedBytes
      const beforeContinuations = reader.managedProofContinuations.size
      const originalFences = fixture.control.dashboardVisibilityFences.bind(fixture.control)
      const originalIdentity = fixture.store.dashboardVisibilitySourceIdentity.bind(fixture.store)
      const originalReserve = fixture.manager.reserveResident.bind(fixture.manager)
      const originalVerify = reader.verifyRepeatedCaptureEvent.bind(reader)
      let fenceCalls = 0
      let identityReads = 0
      let reserveCalls = 0
      let publicCalls = 0
      fixture.control.dashboardVisibilityFences = (input) => {
        fenceCalls += 1
        return originalFences(input)
      }
      fixture.store.dashboardVisibilitySourceIdentity = (...args) => {
        identityReads += 1
        return originalIdentity(...args)
      }
      fixture.manager.reserveResident = (...args) => {
        reserveCalls += 1
        return originalReserve(...args)
      }
      reader.verifyRepeatedCaptureEvent = (...args) => {
        publicCalls += 1
        return originalVerify(...args)
      }

      const denied = reader.verifyRepeatedCaptureEvent(fixture.projectKey, sourceId, eventIds)
      assert.equal(denied.status, 'budget-exhausted')
      assert.equal(denied.reason, 'persona-call-headroom')
      assert.equal(fenceCalls, 0, 'no source or event fence runs when the complete proof cannot fit')
      assert.equal(identityReads, 0, 'the source identity is not read on admission rejection')
      assert.equal(publicCalls, 1, 'the direct proof entry is invoked once without public-method recursion')
      assert.equal(reserveCalls, 0, 'rejection precedes context and temporary resident leases')
      const afterProof = valueOf(fixture.manager.counters(reader.callToken))
      assert.deepEqual(afterProof.call, beforeProof.call, 'denial leaves the call ledger unchanged')
      assert.deepEqual(afterProof.session, beforeProof.session, 'denial leaves the session ledger unchanged')
      assert.equal(fixture.manager.stats().accountedBytes, beforeResident, 'denial leaves resident accounting unchanged')
      assert.equal(reader.managedProofContinuations.size, beforeContinuations, 'denial creates no proof continuation')
    } finally { releaseGuard() }
  }

  const sqlFixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 64 } } } })
  try {
    denyWithoutMutation(sqlFixture, 'preflight-sql-session', (reader) => {
      const remaining = reader.remainingReadWorkBreakdown()
      assert.ok(remaining)
      const spend = remaining.call.sqlStatements - 6
      assert.ok(spend > 0)
      valueOf(reader.chargeRead({ sqlStatements: spend, rowsVisited: 0, materializedBytes: 0, keyBytes: 0 }, () => undefined))
    })
  } finally { sqlFixture.close() }

  const materializedFixture = createFixture()
  try {
    denyWithoutMutation(materializedFixture, 'preflight-materialized-session', (reader, sourceId) => {
      const ids = [...new Set(eventIds)]
      const temporaryBytes = ids.reduce((sum, id) => sum + Math.max(256, Buffer.byteLength(id, 'utf8') * 2 + 128), 0)
      const fullMaterializedBytes = Math.max(256, 96) + Math.max(256, identityProjectionBytes) +
        (ids.length > 0 ? Math.max(256, ids.length * 96) : 0) + temporaryBytes
      const contextKey = reader.managedProofContextKey('repeat-capture-event',
        materializedFixture.projectKey, sourceId, ids)
      const requiredBytes = fullMaterializedBytes + 512 + Buffer.byteLength(contextKey, 'utf8')
      const remaining = reader.remainingReadWorkBreakdown()
      assert.ok(remaining)
      assert.ok(remaining.session.materializedBytes >= requiredBytes,
        'the session budget leaves headroom so the call-local materialized limit is the rejecting dimension')
      const spend = remaining.call.materializedBytes - (requiredBytes - 1)
      assert.ok(spend > 0, 'the existing call ledger can be charged down to one byte short')
      valueOf(reader.chargeRead({ sqlStatements: 0, rowsVisited: 0, materializedBytes: spend, keyBytes: 0 }, () => undefined))
      assert.equal(reader.remainingReadWorkBreakdown().call.materializedBytes, requiredBytes - 1,
        'the full proof plus context is exactly one materialized byte over the remaining call budget')
    })
  } finally { materializedFixture.close() }

  for (const dimension of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes']) {
    const originFixture = createFixture()
    try {
      const record = addApproved(originFixture.store, `Synthetic direct-origin admission for ${dimension}.`, { reason: '' })
      const { reader } = makeDirectOriginHarness(originFixture, record)
      let originQueries = 0
      let schemaFenceQueries = 0
      const residentLeases = []
      const directOrigin = originFixture.store.dashboardVisibilityDirectCreationOrigin.bind(originFixture.store)
      originFixture.store.dashboardVisibilityDirectCreationOrigin = (memoryId) => {
        originQueries += 1
        return directOrigin(memoryId)
      }
      const schemaVersion = originFixture.store.dashboardVisibilitySchemaVersion.bind(originFixture.store)
      originFixture.store.dashboardVisibilitySchemaVersion = () => {
        schemaFenceQueries += 1
        return schemaVersion()
      }
      const reserveResident = originFixture.manager.reserveResident.bind(originFixture.manager)
      originFixture.manager.reserveResident = (callToken, kind, bytes) => {
        residentLeases.push({ kind, bytes })
        return reserveResident(callToken, kind, bytes)
      }
      const originAdmissionCosts = []
      const personaReserveStatus = reader.personaReserveStatus.bind(reader)
      let shortfallInjected = false
      const keyBytes = Buffer.byteLength(originFixture.projectKey, 'utf8')
      const expectedScopeLeaseBytes = 1024 + 2 * keyBytes
      const maximumOperationKey = JSON.stringify(['managed-direct-origin', originFixture.projectKey, record.id,
        `initial-approval:${record.id}`, 9_999_999_999])
      const expectedKeyBytes = 2 * keyBytes + 2 * Buffer.byteLength(record.id, 'utf8') +
        Buffer.byteLength(`initial-approval:${record.id}`, 'utf8') + Buffer.byteLength(maximumOperationKey, 'utf8') +
        8192
      const boundaryWork = 2 * (1 + reader.projectKeys.length) + 1
      const expectedAdmission = {
        sqlStatements: 1 + DIRECT_ORIGIN_LOOKUP_COST.sqlStatements,
        rowsVisited: 1 + DIRECT_ORIGIN_LOOKUP_COST.rowsVisited,
        materializedBytes: 256 + DIRECT_ORIGIN_LOOKUP_COST.materializedBytes + expectedScopeLeaseBytes,
        keyBytes: expectedKeyBytes,
      }
      const releaseOuterReserve = reader.beginPersonaProofGuard(2)
      const releaseNestedReserve = reader.beginPersonaProofGuard(1)
      const expectedPersonaReserve = {
        sqlStatements: 2 * boundaryWork,
        rowsVisited: 2 * boundaryWork,
        materializedBytes: 512,
        keyBytes: 0,
      }
      assert.deepEqual(reader.personaReserveCost(1), expectedPersonaReserve,
        'nested guards retain the maximum rounds and charge the dynamic B+N tail')
      releaseNestedReserve()
      assert.deepEqual(reader.personaReserveCost(1), expectedPersonaReserve,
        'releasing an inner guard preserves the enclosing maximum reserve')
      assert.equal(expectedAdmission.sqlStatements + expectedPersonaReserve.sqlStatements, 36,
        'the operation and R2 tail cost 26+10; real resumed startup is charged separately')
      reader.personaReserveStatus = (cost, scopeCount, minimumRounds) => {
        if (!shortfallInjected && cost.sqlStatements === expectedAdmission.sqlStatements &&
            cost.rowsVisited === expectedAdmission.rowsVisited && cost.materializedBytes === expectedAdmission.materializedBytes) {
          originAdmissionCosts.push({ ...cost })
          const remaining = reader.remainingReadWorkBreakdown()
          assert.ok(remaining)
          assert.equal(minimumRounds, 1, 'origin admission requires a tail even without an enclosing guard')
          const spend = remaining.call[dimension] - (cost[dimension] + expectedPersonaReserve[dimension] - 1)
          assert.ok(spend > 0)
          const shortfall = { sqlStatements: 0, rowsVisited: 0, materializedBytes: 0, keyBytes: 0 }
          shortfall[dimension] = spend
          valueOf(originFixture.manager.run(reader.callToken, shortfall, () => undefined))
          shortfallInjected = true
        }
        return personaReserveStatus(cost, scopeCount, minimumRounds)
      }

      const first = reader.resolveApprovedSummary(originFixture.projectKey, record.id)
      assert.equal(first.status, 'budget-exhausted', dimension)
      assert.equal(first.reason, 'persona-call-headroom', dimension)
      assert.equal(originQueries, 0, `${dimension} rejection occurs before origin SQL`)
      assert.equal(shortfallInjected, true, `${dimension} shortfall reaches the complete direct-origin preflight`)
      assert.equal(schemaFenceQueries, 0, `${dimension} denial happens before schema-fence SQL`)
      assert.equal(residentLeases.some(({ kind, bytes }) => kind === 'cache' && bytes === expectedScopeLeaseBytes), false,
        `${dimension} denial happens before the direct-origin scope cache lease`)
      assert.equal(residentLeases.some(({ kind, bytes }) => kind === 'key' && bytes === keyBytes), false,
        `${dimension} denial happens before the direct-origin project key lease`)
      assert.equal(residentLeases.some(({ kind, bytes }) => kind === 'cache' &&
        bytes === DIRECT_ORIGIN_LOOKUP_COST.materializedBytes), false,
        `${dimension} denial happens before the 100 KiB direct-origin step lease`)
      assert.equal(reader.directOriginSchemaScopes, undefined, 'denial does not allocate the origin-only Map')
      assert.deepEqual(originAdmissionCosts, [expectedAdmission],
        'preflight reports only the 1+25 operation, both leases, and maximum key length; the guard owns the tail')
      releaseOuterReserve()
    } finally { originFixture.close() }
  }

  for (const scenario of [
    { projects: 1, scopes: 1, rounds: 0, limit: 40, required: 36 },
    { projects: 1, scopes: 1, rounds: 0, limit: 40, required: 36, shortfall: 1 },
    { projects: 1, scopes: 1, rounds: 1, limit: 40, required: 36 },
    { projects: 1, scopes: 1, rounds: 2, limit: 40, required: 41 },
    { projects: 4, scopes: 4, rounds: 0, limit: 64, required: 54 },
    { projects: 4, scopes: 4, rounds: 1, limit: 64, required: 54 },
    { projects: 4, scopes: 4, rounds: 2, limit: 64, required: 68 },
    { projects: 4, scopes: 3, rounds: 1, limit: 64, required: 53 },
  ]) {
    const admissionFixture = createFixture({ managerOptions: { monotonicNow: () => 0,
      limits: { perCall: { sqlStatements: scenario.limit } } } })
    const extraStores = []
    try {
      const stores = new Map([[admissionFixture.projectKey, admissionFixture.store]])
      for (let index = 1; index < scenario.projects; index += 1) {
        const key = `origin-admission-project-${index}`
        const store = openProjectStore(admissionFixture.projectsRoot, key)
        extraStores.push(store)
        stores.set(key, store)
      }
      const entries = [...stores]
      const [targetKey, targetStore] = entries.at(-1)
      const record = addApproved(targetStore, `Synthetic real-counter origin admission ${JSON.stringify(scenario)}.`)
      const reader = valueOf(DashboardVisibilityReadSession.open({ manager: admissionFixture.manager,
        control: admissionFixture.control, stores, binding: makeBinding([...stores.keys()]) }))
      admissionFixture.readers.push(reader)
      assert.equal(reader.directOriginSchemaScopes, undefined)
      // Model prior registered scopes using real fences and resident leases.
      // The operation under test and all suspend/resume boundaries run normally;
      // setup does not spend the continuation cap redoing unrelated prior pages.
      reader.directOriginSchemaScopes = new Map()
      for (const [projectKey, store] of entries.slice(0, scenario.scopes)) {
        const projectKeyBytes = Buffer.byteLength(projectKey, 'utf8')
        const schemaVersion = valueOf(reader.chargeRead({ sqlStatements: 1, rowsVisited: 1,
          materializedBytes: 256, keyBytes: 0 }, () => store.dashboardVisibilitySchemaVersion()))
        const cacheReservation = valueOf(reader.reserveReadState(1024 + 2 * projectKeyBytes)).reservationToken
        const keyReservation = valueOf(reader.reserveReadKeys(projectKeyBytes)).reservationToken
        reader.directOriginSchemaScopes.set(projectKey, { projectKey, projectKeyBytes, store,
          binding: reader.binding, schemaVersion, cacheReservation, keyReservation })
      }
      reader.aggregateIntermediateReadDepth = 1
      valueOf(reader.suspendForRpc())
      valueOf(reader.resumeForRpc())
      const startup = valueOf(admissionFixture.manager.counters(reader.callToken))
      const base = 2 * (1 + scenario.projects)
      const futureScopes = scenario.projects
      const tail = base + futureScopes
      assert.equal(startup.call.sqlStatements, base + scenario.scopes, 'real resume pays B+previous N before admission')
      assert.equal(startup.call.rowsVisited, base + scenario.scopes)
      assert.equal(startup.call.materializedBytes, 256 * scenario.scopes)
      assert.equal(startup.call.sqlStatements + 26 + Math.max(1, scenario.rounds) * tail, scenario.required)
      const progress = { key: `origin-admission:${record.id}`, itemReservation: 'test-item', bytes: 0, stageBytes: 0,
        steps: new Map(), resources: new Map(), stages: new Map() }
      reader.activeManagedPageItem = progress
      let originQueries = 0
      let schemaQueries = 0
      let leases = 0
      const readOrigin = targetStore.dashboardVisibilityDirectCreationOrigin.bind(targetStore)
      const readSchema = targetStore.dashboardVisibilitySchemaVersion.bind(targetStore)
      const reserveResident = admissionFixture.manager.reserveResident.bind(admissionFixture.manager)
      targetStore.dashboardVisibilityDirectCreationOrigin = (...args) => { originQueries += 1; return readOrigin(...args) }
      targetStore.dashboardVisibilitySchemaVersion = () => { schemaQueries += 1; return readSchema() }
      admissionFixture.manager.reserveResident = (...args) => { leases += 1; return reserveResident(...args) }
      const releaseOuter = scenario.rounds === 0 ? () => undefined : reader.beginPersonaProofGuard(scenario.rounds)
      const releaseNested = scenario.rounds === 2 ? reader.beginPersonaProofGuard(1) : () => undefined
      if (scenario.shortfall !== undefined) {
        valueOf(admissionFixture.manager.run(reader.callToken, {
          sqlStatements: scenario.limit - scenario.required + scenario.shortfall,
          rowsVisited: 0, materializedBytes: 0, keyBytes: 0,
        }, () => undefined))
      }
      const beforeOperation = valueOf(admissionFixture.manager.counters(reader.callToken))
      const beforeResident = admissionFixture.manager.stats().accountedBytes
      const result = reader.readAggregateDirectOrigin(targetStore, targetKey, record.id)
      releaseNested()
      releaseOuter()
      if (scenario.required > scenario.limit || scenario.shortfall !== undefined) {
        assert.equal(result.status, 'budget-exhausted')
        assert.equal(result.reason, 'persona-call-headroom')
        assert.equal(originQueries, 0, 'an unaffordable required tail must reject before the owned lookup, including R0')
        assert.equal(schemaQueries, 0)
        assert.equal(leases, 0)
        assert.deepEqual(valueOf(admissionFixture.manager.counters(reader.callToken)), beforeOperation)
        assert.equal(admissionFixture.manager.stats().accountedBytes, beforeResident)
        continue
      }
      assert.equal(valueOf(result), true)
      assert.equal(originQueries, 1)
      assert.equal(schemaQueries, 1)
      assert.equal(reader.directOriginSchemaScopes.size, futureScopes)
      const operation = valueOf(admissionFixture.manager.counters(reader.callToken))
      assert.equal(operation.call.sqlStatements - startup.call.sqlStatements, 26)
      assert.equal(operation.call.rowsVisited - startup.call.rowsVisited, 97)
      const scopeBytes = scenario.scopes < futureScopes ? 1024 + 2 * Buffer.byteLength(targetKey, 'utf8') : 0
      assert.equal(operation.call.materializedBytes - startup.call.materializedBytes, 256 + 100 * 1024 + scopeBytes)
      assert.equal(leases, scopeBytes === 0 ? 1 : 3, 'only a new scope adds its cache/key leases')
      valueOf(reader.suspendForRpc(() => {
        const final = valueOf(admissionFixture.manager.counters(reader.callToken))
        assert.equal(final.call.sqlStatements, scenario.required, 'startup, operation, and one actual tail fit the unchanged cap')
        assert.equal(final.call.rowsVisited, startup.call.rowsVisited + 97 + tail)
        return { status: 'ok', value: undefined }
      }))
      valueOf(reader.resumeForRpc())
      const replayStartup = valueOf(admissionFixture.manager.counters(reader.callToken))
      assert.equal(replayStartup.call.sqlStatements, tail)
      // Leave exactly a fresh one-SQL replay fence and one tail, even at R0.
      const padding = scenario.limit - replayStartup.call.sqlStatements - 1 - tail
      valueOf(admissionFixture.manager.run(reader.callToken, {
        sqlStatements: padding, rowsVisited: 0, materializedBytes: 0, keyBytes: 0,
      }, () => undefined))
      const beforeReplay = valueOf(admissionFixture.manager.counters(reader.callToken))
      const replayLeases = leases
      const releaseReplay = scenario.rounds === 0 ? () => undefined : reader.beginPersonaProofGuard(1)
      assert.equal(valueOf(reader.readAggregateDirectOrigin(targetStore, targetKey, record.id)), true)
      releaseReplay()
      const afterReplay = valueOf(admissionFixture.manager.counters(reader.callToken))
      assert.equal(afterReplay.call.sqlStatements - beforeReplay.call.sqlStatements, 1)
      assert.equal(afterReplay.call.materializedBytes - beforeReplay.call.materializedBytes, 256)
      assert.equal(originQueries, 1, 'a paid cached proof is not executed again at the exact replay boundary')
      assert.equal(leases, replayLeases)
      valueOf(reader.suspendForRpc(() => {
        assert.equal(valueOf(admissionFixture.manager.counters(reader.callToken)).call.sqlStatements, scenario.limit)
        return { status: 'ok', value: undefined }
      }))
    } finally {
      for (const store of extraStores) store.close()
      admissionFixture.close()
    }
  }

  const resumeFixture = createFixture()
  try {
    const record = addApproved(resumeFixture.store, 'Synthetic direct-origin work retained across an RPC resume.', { reason: '' })
    const { reader, progress } = makeDirectOriginHarness(resumeFixture, record)
    let originQueries = 0
    let summaryQueries = 0
    let schemaFenceQueries = 0
    const directOrigin = resumeFixture.store.dashboardVisibilityDirectCreationOrigin.bind(resumeFixture.store)
    resumeFixture.store.dashboardVisibilityDirectCreationOrigin = (memoryId) => {
      originQueries += 1
      return directOrigin(memoryId)
    }
    const schemaVersion = resumeFixture.store.dashboardVisibilitySchemaVersion.bind(resumeFixture.store)
    resumeFixture.store.dashboardVisibilitySchemaVersion = () => {
      schemaFenceQueries += 1
      return schemaVersion()
    }
    const managedMemory = resumeFixture.store.dashboardManagedMemory.bind(resumeFixture.store)
    resumeFixture.store.dashboardManagedMemory = (...args) => {
      summaryQueries += 1
      return managedMemory(...args)
    }
    const validateBoundary = reader.validateSnapshotBoundary.bind(reader)
    let injectFinalHeadroom = true
    reader.validateSnapshotBoundary = (forceAllScopes) => {
      if (injectFinalHeadroom && !forceAllScopes) {
        injectFinalHeadroom = false
        return failure('budget-exhausted', 'persona-call-headroom')
      }
      return validateBoundary(forceAllScopes)
    }

    const first = reader.resolveApprovedSummary(resumeFixture.projectKey, record.id)
    assert.equal(first.status, 'budget-exhausted')
    assert.equal(first.reason, 'persona-call-headroom')
    assert.equal(originQueries, 1, 'the bounded origin operation completed before the injected final-boundary shortfall')
    assert.ok([...progress.steps.keys()].some((key) => key.includes('managed-direct-origin')),
      'the fully paid proof is retained in the managed page step cache')
    assert.equal(summaryQueries, 0, 'aggregate summaries reuse metadata already supplied by the root proof')

    reader.validateSnapshotBoundary = validateBoundary
    valueOf(reader.suspendForRpc())
    valueOf(reader.resumeForRpc())
    const beforeReplayCounters = valueOf(resumeFixture.manager.counters(reader.callToken))
    const replay = valueOf(reader.resolveApprovedSummary(resumeFixture.projectKey, record.id))
    assert.equal(replay.summary?.[dashboardAggregateDirectOriginProof], true)
    assert.equal(originQueries, 1, 'resume reuses paid origin work without rerunning the transaction helper')
    assert.equal(summaryQueries, 0, 'resume does not add a duplicate current-row summary projection')
    const afterReplayCounters = valueOf(resumeFixture.manager.counters(reader.callToken))
    assert.equal(afterReplayCounters.call.sqlStatements - beforeReplayCounters.call.sqlStatements, 1)
    assert.equal(afterReplayCounters.call.rowsVisited - beforeReplayCounters.call.rowsVisited, 1)
    assert.equal(afterReplayCounters.call.materializedBytes - beforeReplayCounters.call.materializedBytes, 256)
    assert.equal(afterReplayCounters.call.keyBytes - beforeReplayCounters.call.keyBytes, 0)
    assert.equal(afterReplayCounters.session.sqlStatements - beforeReplayCounters.session.sqlStatements, 1)
    assert.equal(afterReplayCounters.session.rowsVisited - beforeReplayCounters.session.rowsVisited, 1)
    assert.equal(afterReplayCounters.session.materializedBytes - beforeReplayCounters.session.materializedBytes, 256)
    assert.equal(afterReplayCounters.session.keyBytes - beforeReplayCounters.session.keyBytes, 0)
    assert.equal(schemaFenceQueries >= 4, true,
      'initial proof, suspend, resume, and cached replay each pay their schema fence')
  } finally { resumeFixture.close() }

  for (const boundary of ['cached-after-resume', 'resume-after-suspended-ddl', 'publish-proof', 'advance-final',
    'final-release', 'cancel']) {
    const scopeFixture = createFixture()
    try {
      const record = addApproved(scopeFixture.store, `Synthetic schema-scope boundary ${boundary}.`, { reason: '' })
      const { reader } = makeDirectOriginHarness(scopeFixture, record)
      let originQueries = 0
      const readOrigin = scopeFixture.store.dashboardVisibilityDirectCreationOrigin.bind(scopeFixture.store)
      scopeFixture.store.dashboardVisibilityDirectCreationOrigin = (memoryId) => {
        originQueries += 1
        return readOrigin(memoryId)
      }
      const reserveResident = scopeFixture.manager.reserveResident.bind(scopeFixture.manager)
      const leaseRequests = []
      scopeFixture.manager.reserveResident = (callToken, kind, bytes) => {
        leaseRequests.push({ kind, bytes })
        return reserveResident(callToken, kind, bytes)
      }
      const residentBeforeProof = scopeFixture.manager.stats().accountedBytes
      const summary = valueOf(reader.resolveApprovedSummary(scopeFixture.projectKey, record.id))
      assert.equal(summary.summary?.[dashboardAggregateDirectOriginProof], true)
      assert.equal(reader.directOriginSchemaScopes.size, 1)
      const accountedWithScopeLeases = scopeFixture.manager.stats().accountedBytes
      assert.ok(accountedWithScopeLeases > 128, 'scope cache, scope key, and managed-step leases are resident-accounted')
      const projectKeyBytes = Buffer.byteLength(scopeFixture.projectKey, 'utf8')
      assert.ok(leaseRequests.some(({ kind, bytes }) => kind === 'cache' && bytes === 1024 + 2 * projectKeyBytes),
        'one cache lease retains the reader schema scope')
      assert.ok(leaseRequests.some(({ kind, bytes }) => kind === 'key' && bytes === projectKeyBytes),
        'a separate key lease retains the project key')
      assert.ok(leaseRequests.some(({ kind, bytes }) => kind === 'cache' &&
        bytes === DIRECT_ORIGIN_LOOKUP_COST.materializedBytes), 'the managed direct-origin result has its own 100 KiB lease')
      assert.equal(accountedWithScopeLeases - residentBeforeProof,
        leaseRequests.reduce((sum, lease) => sum + lease.bytes + 64, 0),
        'the read manager adds its 64-byte accounting overhead to each distinct lease')
      const changeSchema = () => {
        const table = `reader_schema_${randomUUID().replaceAll('-', '_')}`
        scopeFixture.store.db.exec(`CREATE TABLE "${table}" (id INTEGER)`)
      }
      let boundaryResult
      if (boundary === 'cached-after-resume' || boundary === 'resume-after-suspended-ddl') {
        valueOf(reader.suspendForRpc())
        if (boundary === 'resume-after-suspended-ddl') {
          changeSchema()
          boundaryResult = reader.resumeForRpc()
        } else {
          valueOf(reader.resumeForRpc())
          changeSchema()
          boundaryResult = reader.resolveApprovedSummary(scopeFixture.projectKey, record.id)
        }
      } else if (boundary === 'publish-proof') {
        changeSchema()
        boundaryResult = reader.publishProof()
      } else if (boundary === 'advance-final') {
        changeSchema()
        boundaryResult = reader.advance(false)
      } else if (boundary === 'final-release') {
        boundaryResult = reader.advance(false)
        assert.equal(boundaryResult.status, 'ok')
      } else {
        boundaryResult = reader.cancel()
        assert.equal(boundaryResult.status, 'ok')
      }
      if (boundary !== 'final-release' && boundary !== 'cancel') {
        assert.equal(boundaryResult.status, 'stale', boundary)
        assert.equal(boundaryResult.reason, 'direct-origin-schema-changed', boundary)
      }
      assert.equal(originQueries, 1, 'schema fences reject stale scope state without repeating the origin helper')
      assert.equal(scopeFixture.manager.stats().sessions, 0, `${boundary} retires the reader and its leases`)
      assert.ok(scopeFixture.manager.stats().accountedBytes < accountedWithScopeLeases,
        `${boundary} releases the scope cache/key/step leases`)
      assert.equal(reader.directOriginSchemaScopes, undefined, 'retirement discards the origin-only Map')
    } finally { scopeFixture.close() }
  }

  const callerTransactionFixture = createFixture()
  try {
    const record = addApproved(callerTransactionFixture.store, 'Synthetic caller-owned transaction survives failed begin.',
      { reason: '' })
    const db = callerTransactionFixture.store.db
    const originalExecDescriptor = Object.getOwnPropertyDescriptor(db, 'exec')
    const originalExec = db.exec
    const executions = []
    originalExec.call(db, 'BEGIN DEFERRED')
    db.exec = function (sql, ...args) {
      executions.push(String(sql).trim())
      return originalExec.call(this, sql, ...args)
    }
    try {
      assert.throws(() => callerTransactionFixture.store.dashboardVisibilityDirectCreationOrigin(record.id),
        /transaction within a transaction|cannot start a transaction/iu)
      assert.deepEqual(executions, ['BEGIN DEFERRED'], 'failed BEGIN never rolls back a transaction the helper does not own')
      assert.equal(db.prepare('SELECT 1 AS caller_transaction_alive').get().caller_transaction_alive, 1)
      originalExec.call(db, 'ROLLBACK')
      assert.ok(Number.isSafeInteger(callerTransactionFixture.store.dashboardVisibilitySchemaVersion()),
        'the store connection remains open and reusable after begin ownership fails')
    } finally {
      if (originalExecDescriptor === undefined) delete db.exec
      else Object.defineProperty(db, 'exec', originalExecDescriptor)
      try { originalExec.call(db, 'ROLLBACK') } catch { /* the transaction may already be closed */ }
    }
  } finally { callerTransactionFixture.close() }

  const rollbackFixture = createFixture()
  const rollbackDb = rollbackFixture.store.db
  const rollbackExecDescriptor = Object.getOwnPropertyDescriptor(rollbackDb, 'exec')
  const rollbackCloseDescriptor = Object.getOwnPropertyDescriptor(rollbackDb, 'close')
  try {
    const record = addApproved(rollbackFixture.store, 'Synthetic owned rollback failure releases reader leases.', { reason: '' })
    const { reader } = makeDirectOriginHarness(rollbackFixture, record)
    const db = rollbackDb
    const originalExec = db.exec
    const originalClose = db.close
    const rollbackError = new Error('synthetic owned rollback failure')
    let closeCalls = 0
    let actualCloseError
    db.exec = function (sql, ...args) {
      if (String(sql).trim() === 'ROLLBACK') throw rollbackError
      return originalExec.call(this, sql, ...args)
    }
    db.close = function (...args) {
      closeCalls += 1
      try { return originalClose.apply(this, args) }
      catch (error) {
        actualCloseError = error
        throw error
      }
    }
    const residentBeforeOrigin = rollbackFixture.manager.stats().accountedBytes
    const failed = reader.resolveApprovedSummary(rollbackFixture.projectKey, record.id)
    assert.equal(failed.status, 'unavailable-probe')
    assert.equal(closeCalls, 1, 'rollback failure attempts to close only this Store connection')
    assert.equal(rollbackFixture.manager.stats().sessions, 0)
    assert.ok(rollbackFixture.manager.stats().accountedBytes < residentBeforeOrigin,
      'rollback failure cancels the reader and releases its direct-origin scope leases')
    if (rollbackFixture.store.closed) {
      assert.throws(() => rollbackFixture.store.dashboardVisibilitySchemaVersion(), (error) =>
        error.rollbackError === rollbackError && error.closeError === undefined && error.cleanupUnknown === false)
      assert.throws(() => originalExec.call(db, 'SELECT 1'))
    } else {
      assert.ok(actualCloseError, 'a failed close is preserved when the native connection cannot close')
      assert.throws(() => rollbackFixture.store.dashboardVisibilitySchemaVersion(), (error) =>
        error.rollbackError === rollbackError && error.closeError === actualCloseError && error.cleanupUnknown === true)
    }
  } finally {
    const db = rollbackDb
    if (rollbackExecDescriptor === undefined) delete db.exec
    else Object.defineProperty(db, 'exec', rollbackExecDescriptor)
    if (rollbackCloseDescriptor === undefined) delete db.close
    else Object.defineProperty(db, 'close', rollbackCloseDescriptor)
    try { db.exec('ROLLBACK') } catch { /* the connection may already be closed */ }
    rollbackFixture.close()
  }

  const closeFailureFixture = createFixture()
  const closeFailureDb = closeFailureFixture.store.db
  const closeFailureExecDescriptor = Object.getOwnPropertyDescriptor(closeFailureDb, 'exec')
  const closeFailureCloseDescriptor = Object.getOwnPropertyDescriptor(closeFailureDb, 'close')
  const closeFailureOriginalExec = closeFailureDb.exec
  try {
    const record = addApproved(closeFailureFixture.store, 'Synthetic close failure preserves rollback uncertainty.', { reason: '' })
    const db = closeFailureDb
    const originalExec = closeFailureOriginalExec
    const rollbackError = new Error('synthetic rollback failure before close')
    const closeError = new Error('synthetic owned connection close failure')
    db.exec = function (sql, ...args) {
      if (String(sql).trim() === 'ROLLBACK') throw rollbackError
      return originalExec.call(this, sql, ...args)
    }
    db.close = () => { throw closeError }
    assert.throws(() => closeFailureFixture.store.dashboardVisibilityDirectCreationOrigin(record.id), (error) =>
      error.rollbackError === rollbackError && error.closeError === closeError && error.cleanupUnknown === true)
    assert.equal(closeFailureFixture.store.closed, false)
    assert.throws(() => closeFailureFixture.store.dashboardVisibilitySchemaVersion(), (error) =>
      error.rollbackError === rollbackError && error.closeError === closeError && error.cleanupUnknown === true)
  } finally {
    const db = closeFailureDb
    if (closeFailureExecDescriptor === undefined) delete db.exec
    else Object.defineProperty(db, 'exec', closeFailureExecDescriptor)
    if (closeFailureCloseDescriptor === undefined) delete db.close
    else Object.defineProperty(db, 'close', closeFailureCloseDescriptor)
    try { closeFailureOriginalExec.call(db, 'ROLLBACK') } catch { /* cleanup only; the test preserves its first failure */ }
    closeFailureFixture.close()
  }
})

test('body, revision-source JSON, and dependency evidence above 64 KiB never become visible', () => {
  const fixture = createFixture()
  try {
    const oversizedBody = addApproved(fixture.store, 'b'.repeat(65_537))
    const oversizedJson = addApproved(fixture.store, 'Synthetic revision with oversized source JSON.')
    fixture.store.db.prepare('UPDATE l1_revisions SET source_message_ids = ? WHERE memory_id = ? AND revision = ?')
      .run(`[${' '.repeat(65_540)}]`, oversizedJson.id, oversizedJson.revision)

    const evidence = fixture.store.recordL0({ sessionId: 'oversized-evidence', role: 'user',
      content: 'Synthetic evidence for an oversized dependency JSON array.' })
    const evidenceRoot = addApproved(fixture.store, 'Synthetic root with oversized relation evidence JSON.')
    const evidenceTarget = addApproved(fixture.store, 'Synthetic visible target behind oversized evidence JSON.')
    fixture.store.db.prepare(`INSERT INTO memory_relations(id, from_id, to_id, relation_type, evidence_ids,
      from_revision, to_revision, created_at) VALUES (?, ?, ?, 'depends_on', ?, ?, ?, ?)`)
      .run('relation-oversized-evidence', evidenceRoot.id, evidenceTarget.id,
        `[${' '.repeat(65_540)}"${evidence}"]`, evidenceRoot.revision, evidenceTarget.revision, Date.now())

    const reader = valueOf(fixture.openReader())
    let oversizedBodyReads = 0
    const readRevisionBody = fixture.store.dashboardVisibilityRevisionBody.bind(fixture.store)
    fixture.store.dashboardVisibilityRevisionBody = (...args) => {
      oversizedBodyReads += 1
      return readRevisionBody(...args)
    }
    const bodyResult = valueOf(reader.resolveRoot(fixture.projectKey, oversizedBody.id))
    assert.equal(bodyResult.state, 'unresolved')
    assert.equal(bodyResult.reason, 'revision-metadata-invalid')
    assert.equal(bodyResult.record, undefined)
    assert.equal(oversizedBodyReads, 0, 'the revision byte cap rejects the row before a body helper can return oversized text')
    const jsonResult = valueOf(reader.resolveRoot(fixture.projectKey, oversizedJson.id))
    assert.equal(jsonResult.state, 'unresolved')
    assert.equal(jsonResult.reason, 'revision-metadata-invalid')
    const evidenceResult = valueOf(reader.resolveRoot(fixture.projectKey, evidenceRoot.id))
    assert.equal(evidenceResult.state, 'unresolved')
    assert.equal(evidenceResult.reason, 'dependency-metadata-invalid')
    assert.equal(evidenceResult.record, undefined)
  } finally {
    fixture.close()
  }
})

test('releasing a resident lease lowers residency but never refunds cumulative work', () => {
  const fixture = createFixture()
  try {
    const records = Array.from({ length: 17 }, (_unused, index) => addApproved(fixture.store, `Synthetic sentinel counter row ${index}.`))
    for (const record of records) fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = 0 WHERE id = ?').run(record.id)
    const reader = valueOf(fixture.openReader())
    const before = valueOf(fixture.manager.counters(reader.callToken))
    const lease = valueOf(fixture.manager.reserveResident(reader.callToken, 'cache', 1024))
    const charged = valueOf(fixture.manager.counters(reader.callToken))
    assert.equal(charged.call.materializedBytes, before.call.materializedBytes + 1024)
    valueOf(fixture.manager.releaseResident(reader.callToken, lease.reservationToken))
    const afterRelease = valueOf(fixture.manager.counters(reader.callToken))
    assert.equal(afterRelease.call.materializedBytes, charged.call.materializedBytes,
      'releasing memory does not erase cumulative materialization work')
    assert.ok(afterRelease.accountedBytes < charged.accountedBytes)

    const page = valueOf(reader.readPage(fixture.projectKey))
    assert.equal(page.items.length, 15)
    assert.equal(page.hasMore, true, 'the sixteenth raw row remains the page sentinel')
    const afterPage = valueOf(fixture.manager.counters(reader.callToken))
    assert.ok(afterPage.call.rowsVisited >= 16, 'the sentinel and visibility helper costs share the call counters')
    assert.ok(afterPage.session.rowsVisited >= afterPage.call.rowsVisited)
  } finally {
    fixture.close()
  }
})

test('invalid, throwing, and backwards wall clocks retire their active slot so a new read can open', () => {
  for (const mode of ['invalid-at-open', 'throw-during-read', 'backwards-during-read']) {
    const fixture = createFixture()
    try {
      const record = addApproved(fixture.store, `Synthetic clock recovery ${mode}.`)
      const now = Date.now()
      if (mode === 'invalid-at-open') {
        const invalid = fixture.openReader({ wallNow: () => Number.NaN })
        assert.equal(invalid.status, 'unavailable-probe')
        assert.equal(fixture.manager.stats().sessions, 0)
      } else {
        let calls = 0
        const wallNow = () => {
          calls += 1
          if (calls >= 4) {
            if (mode === 'throw-during-read') throw new Error('synthetic wall clock failure')
            return now - 1
          }
          return now
        }
        const reader = valueOf(fixture.openReader({ wallNow }))
        const failed = reader.resolveRoot(fixture.projectKey, record.id)
        assert.equal(failed.status, 'unavailable-probe')
        assert.equal(fixture.manager.stats().sessions, 0)
      }
      const next = valueOf(fixture.openReader({ wallNow: () => now }))
      assert.equal(valueOf(next.resolveRoot(fixture.projectKey, record.id)).state, 'visible')
    } finally {
      fixture.close()
    }
  }
})

test('root memo hits preserve inherited transitive expiry', () => {
  const fixture = createFixture()
  try {
    const start = Date.now()
    const expiryAt = start + 60_000
    const evidence = fixture.store.recordL0({ sessionId: 'memo-expiry-evidence', role: 'user',
      content: 'Synthetic evidence for a memoized dependency proof.' })
    const root = addApproved(fixture.store, 'Synthetic root whose dependency expires first.')
    const target = addApproved(fixture.store, 'Synthetic expiring dependency.')
    fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiryAt, target.id)
    insertRelation(fixture.store, 'relation-memo-expiry-root-target', root, target, [evidence])
    let wallNow = start
    let relationPageCalls = 0
    const relationPage = fixture.store.dashboardVisibilityRelationPage.bind(fixture.store)
    fixture.store.dashboardVisibilityRelationPage = (...args) => {
      relationPageCalls += 1
      return relationPage(...args)
    }
    const reader = valueOf(fixture.openReader({ binding: makeBinding([fixture.projectKey], expiryAt + 60_000),
      wallNow: () => wallNow }))
    const rootKey = `${fixture.projectKey}\0${root.id}`

    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, root.id)).state, 'visible')
    assert.equal(reader.memo.get(rootKey)?.expiryAt, expiryAt)
    const firstProofRelationCalls = relationPageCalls
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, root.id)).state, 'visible')
    assert.equal(relationPageCalls, firstProofRelationCalls, 'a valid root memo hit skips relation-page reads')
    assert.equal(reader.memo.get(rootKey)?.expiryAt, expiryAt, 'the root-only memo hit retains the dependency TTL')

    wallNow = expiryAt
    const expired = valueOf(reader.resolveRoot(fixture.projectKey, root.id))
    assert.equal(expired.state, 'hidden')
    assert.equal(expired.record, undefined)
    assert.ok(relationPageCalls > firstProofRelationCalls, 'an expired inherited TTL forces dependency re-evaluation')
  } finally {
    fixture.close()
  }
})

test('natural dependency expiry withdraws pending page bodies and retires the read session', () => {
  const fixture = createFixture({ managerOptions: { monotonicNow: () => 0 } })
  try {
    const start = Date.now()
    const expiryAt = start + 60_000
    const evidence = fixture.store.recordL0({ sessionId: 'natural-expiry-evidence', role: 'user',
      content: 'Synthetic evidence for a dependency that expires at final release.' })
    const root = addApproved(fixture.store, 'Synthetic root body pending final dependency expiry.')
    const target = addApproved(fixture.store, 'Synthetic dependency expiring at final validation.')
    fixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE id = ?').run(start - 20, root.id)
    fixture.store.db.prepare('UPDATE l1_memories SET created_at = ?, expiry_at = ? WHERE id = ?')
      .run(start - 10, expiryAt, target.id)
    insertRelation(fixture.store, 'relation-natural-expiry-root-target', root, target, [evidence])
    let wallNow = start
    const reader = valueOf(fixture.openReader({ binding: makeBinding([fixture.projectKey], expiryAt + 60_000),
      wallNow: () => wallNow }))
    const oldCallToken = reader.callToken
    const bodyReads = []
    const readBody = fixture.store.dashboardVisibilityRevisionBody.bind(fixture.store)
    fixture.store.dashboardVisibilityRevisionBody = (...args) => {
      bodyReads.push(args[0])
      return readBody(...args)
    }
    let accountedBeforeValidation
    let workBeforeValidation
    const validate = reader.validateBeforeRelease.bind(reader)
    reader.validateBeforeRelease = (items) => {
      wallNow = expiryAt
      accountedBeforeValidation = fixture.manager.stats().accountedBytes
      workBeforeValidation = valueOf(fixture.manager.counters(reader.callToken))
      return validate(items)
    }
    let countersBeforeCancel
    const cancel = fixture.manager.cancel.bind(fixture.manager)
    fixture.manager.cancel = (callToken) => {
      if (callToken === oldCallToken) countersBeforeCancel = valueOf(fixture.manager.counters(callToken))
      return cancel(callToken)
    }

    const result = reader.readPage(fixture.projectKey)
    assert.equal(result.status, 'ok', 'safe unresolved page semantics are preserved for natural expiry')
    assert.ok(bodyReads.includes(root.id), 'the root body was actually read before the dependency expired')
    const rootItem = result.value.items.find((item) => item.id === root.id)
    assert.equal(rootItem?.state, 'unresolved')
    assert.equal(rootItem?.reason, 'visibility-proof-expired-during-read')
    assert.ok(result.value.items.every((item) => item.record === undefined),
      'the page returns no body whose proof expired before release')
    assert.ok(workBeforeValidation.session.materializedBytes > 0)
    assert.equal(countersBeforeCancel.session.materializedBytes, workBeforeValidation.session.materializedBytes,
      'memo lease release before cancellation does not refund spent materialization work')
    assert.ok(countersBeforeCancel.sessionAccountedBytes < workBeforeValidation.sessionAccountedBytes,
      'the expired memo lease is released before the session is cancelled')
    assert.equal(fixture.manager.stats().sessions, 0, 'natural proof expiry terminates the reader session')
    assert.ok(fixture.manager.stats().accountedBytes < accountedBeforeValidation,
      'session cancellation releases pending output and memo leases')
    assert.equal(reader.advance(true).status, 'stale')
    assert.equal(reader.resolveRoot(fixture.projectKey, root.id).status, 'stale')
    assert.equal(reader.readPage(fixture.projectKey).status, 'stale')
    assert.equal(fixture.manager.counters(oldCallToken).status, 'stale', 'the pre-expiry call token cannot be reused')
    assert.equal(cancel(oldCallToken).status, 'stale', 'the pre-expiry token cannot cancel or revive the retired session')
  } finally {
    fixture.close()
  }
})

test('a page with a pending body fails closed when memo growth hits resident capacity', () => {
  const scenario = prepareMemoGrowthScenario()
  const { fixture, reader, root, expiryAt, setWallNow } = scenario
  try {
    const fill = fillResidentBudgetForMemoCapacity(scenario)
    const bodyReads = []
    const readBody = fixture.store.dashboardVisibilityRevisionBody.bind(fixture.store)
    fixture.store.dashboardVisibilityRevisionBody = (...args) => {
      bodyReads.push(args[0])
      return readBody(...args)
    }
    const originalReserve = fixture.manager.reserveResident.bind(fixture.manager)
    let memoBlockAttempt
    let attempted = false
    fixture.manager.reserveResident = (callToken, kind, bytes) => {
      if (!attempted && kind === 'cache' && bytes === 8_192 && reader.memo.size === 32) {
        attempted = true
        setWallNow(expiryAt)
        const counters = valueOf(fixture.manager.counters(callToken))
        const limits = fixture.manager.limits
        memoBlockAttempt = {
          counters,
          residentFreeBytes: 4 * 1024 * 1024 - counters.sessionAccountedBytes,
        }
        assert.ok(counters.call.sqlStatements + 4 <= limits.perCall.sqlStatements,
          'the active call can still run both final two-statement probes')
        assert.ok(counters.call.rowsVisited + 4 <= limits.perCall.rowsVisited,
          'the active call can still visit both final probe rows')
        assert.ok(counters.session.sqlStatements + 4 <= limits.perSession.sqlStatements,
          'the cumulative session can still run both final probes')
        assert.ok(counters.session.rowsVisited + 4 <= limits.perSession.rowsVisited,
          'the cumulative session can still visit both final probe rows')
        assert.ok(counters.call.materializedBytes + bytes <= limits.perCall.materializedBytes,
          'the active call has work budget for the requested memo block')
        assert.ok(counters.session.materializedBytes + bytes <= limits.perSession.materializedBytes,
          'the cumulative session has work budget for the requested memo block')
        memoBlockAttempt.result = originalReserve(callToken, kind, bytes)
        return memoBlockAttempt.result
      }
      return originalReserve(callToken, kind, bytes)
    }

    let finalControlProbe
    let finalProjectProbe
    const probeControl = fixture.manager.probeControl.bind(fixture.manager)
    const probeProject = fixture.manager.probeProject.bind(fixture.manager)
    fixture.manager.probeControl = (...args) => {
      const result = probeControl(...args)
      if (attempted) finalControlProbe = result.status
      return result
    }
    fixture.manager.probeProject = (...args) => {
      const result = probeProject(...args)
      if (attempted) finalProjectProbe = result.status
      return result
    }
    let countersBeforeCancel
    const cancel = fixture.manager.cancel.bind(fixture.manager)
    fixture.manager.cancel = (callToken) => {
      if (callToken === reader.callToken) countersBeforeCancel = valueOf(fixture.manager.counters(callToken))
      return cancel(callToken)
    }

    const result = reader.readPage(fixture.projectKey)
    assert.equal(attempted, true, 'the 33rd proof requests a second memo block')
    assert.ok(fill.fillerLeases >= 4, 'multiple real S1 cache leases fill resident capacity across bounded calls')
    assert.ok(fill.fillerContinuations > 1, 'resident filler remains accounted across actual reader continuations')
    assert.equal(fill.finalCounters.sessionAccountedBytes, fill.targetAccountedBytes)
    assert.equal(memoBlockAttempt.result.status, 'budget-exhausted')
    assert.equal(memoBlockAttempt.result.reason, 'resident-capacity-or-work')
    assert.ok(memoBlockAttempt.residentFreeBytes < 8_192 + 64,
      'the reservation is denied because resident capacity cannot fit its cache block')
    assert.ok(bodyReads.includes(root.id), 'the first visible body was read and remained pending inside the page')
    assert.equal(finalControlProbe, undefined, 'proof-cache exhaustion happens before the final publication boundary')
    assert.equal(finalProjectProbe, undefined, 'proof-cache exhaustion does not attempt later project probes')
    assert.equal(result.status, 'budget-exhausted')
    assert.equal(result.reason, 'visibility-proof-cache-lost')
    assert.equal(result.value, undefined, 'no partial page or pending body escapes after proof loss')
    assert.ok(countersBeforeCancel.call.materializedBytes > 0, 'cancellation captures the accumulated work')
    assert.ok(countersBeforeCancel.sessionAccountedBytes < memoBlockAttempt.counters.sessionAccountedBytes,
      'memo proof leases are released before the resident-filled session is cancelled')
    assert.equal(fixture.manager.stats().sessions, 0, 'proof loss retires the read and its resident leases')
    assert.ok(fixture.manager.stats().accountedBytes < countersBeforeCancel.accountedBytes,
      'cancellation releases the resident filler, memo, and page leases')
    assert.equal(fixture.manager.counters(reader.callToken).status, 'stale')
    assert.equal(reader.advance(true).status, 'stale')
    assert.equal(reader.resolveRoot(fixture.projectKey, root.id).status, 'stale')
    assert.equal(reader.readPage(fixture.projectKey).status, 'stale')
  } finally {
    fixture.close()
  }
})

test('a page with a pending body fails closed when memo growth hits materialized work', () => {
  const scenario = prepareMemoGrowthScenario()
  const { fixture, reader, root, expiryAt, setWallNow } = scenario
  try {
    const bodyReads = []
    const readBody = fixture.store.dashboardVisibilityRevisionBody.bind(fixture.store)
    fixture.store.dashboardVisibilityRevisionBody = (...args) => {
      bodyReads.push(args[0])
      return readBody(...args)
    }
    const originalReserve = fixture.manager.reserveResident.bind(fixture.manager)
    const originalRelease = fixture.manager.releaseResident.bind(fixture.manager)
    let memoBlockAttempt
    let attempted = false
    fixture.manager.reserveResident = (callToken, kind, bytes) => {
      if (!attempted && kind === 'cache' && bytes === 8_192 && reader.memo.size === 32) {
        attempted = true
        const before = valueOf(fixture.manager.counters(callToken))
        const remaining = 1024 * 1024 - before.call.materializedBytes
        assert.ok(remaining > bytes, 'the pending memo block follows the page work that triggers the cap')
        const lease = valueOf(originalReserve(callToken, 'cache', remaining))
        valueOf(originalRelease(callToken, lease.reservationToken))
        const charged = valueOf(fixture.manager.counters(callToken))
        assert.equal(charged.call.materializedBytes, 1024 * 1024,
          'releasing resident cache bytes does not refund cumulative call work')
        setWallNow(expiryAt)
        memoBlockAttempt = {
          residentFreeBytes: 4 * 1024 * 1024 - charged.sessionAccountedBytes,
          result: originalReserve(callToken, kind, bytes), charged,
        }
        return memoBlockAttempt.result
      }
      return originalReserve(callToken, kind, bytes)
    }

    let finalControlProbe
    let finalProjectProbe
    const probeControl = fixture.manager.probeControl.bind(fixture.manager)
    const probeProject = fixture.manager.probeProject.bind(fixture.manager)
    fixture.manager.probeControl = (...args) => {
      const result = probeControl(...args)
      if (attempted) finalControlProbe = result.status
      return result
    }
    fixture.manager.probeProject = (...args) => {
      const result = probeProject(...args)
      if (attempted) finalProjectProbe = result.status
      return result
    }
    let countersBeforeCancel
    const cancel = fixture.manager.cancel.bind(fixture.manager)
    fixture.manager.cancel = (callToken) => {
      if (callToken === reader.callToken) countersBeforeCancel = valueOf(fixture.manager.counters(callToken))
      return cancel(callToken)
    }

    const result = reader.readPage(fixture.projectKey)
    assert.equal(attempted, true, 'the 33rd proof requests a second memo block')
    assert.equal(memoBlockAttempt.result.status, 'budget-exhausted')
    assert.equal(memoBlockAttempt.result.reason, 'resident-capacity-or-work')
    assert.ok(memoBlockAttempt.residentFreeBytes > 8_192 + 64,
      'the materialized-work denial has sufficient actual resident capacity')
    assert.equal(memoBlockAttempt.charged.call.materializedBytes, 1024 * 1024)
    assert.ok(bodyReads.includes(root.id), 'the first visible body was read and remained pending inside the page')
    assert.equal(finalControlProbe, undefined, 'proof-cache exhaustion happens before the final publication boundary')
    assert.equal(finalProjectProbe, undefined, 'proof-cache exhaustion does not attempt later project probes')
    assert.equal(result.status, 'budget-exhausted')
    assert.equal(result.reason, 'visibility-proof-cache-lost')
    assert.equal(result.value, undefined, 'no partial page or pending body escapes after proof loss')
    assert.ok(countersBeforeCancel.call.materializedBytes >= 1024 * 1024,
      'cancellation captures the accumulated materialization work')
    assert.ok(countersBeforeCancel.sessionAccountedBytes < memoBlockAttempt.charged.sessionAccountedBytes,
      'memo proof leases are released before the work-filled session is cancelled')
    assert.equal(fixture.manager.stats().sessions, 0, 'proof loss retires the read and its resident leases')
    assert.ok(fixture.manager.stats().accountedBytes < countersBeforeCancel.accountedBytes,
      'cancellation releases the memo and page leases')
  } finally {
    fixture.close()
  }
})

test('the reader uses only bounded visibility helpers and leaves project and control stores read-only', () => {
  const fixture = createFixture()
  try {
    const record = addApproved(fixture.store, 'Synthetic read-only proof target.')
    const originalCollectors = ['approvedRecords', 'get', 'search', 'stats']
    const collectorCalls = []
    for (const name of originalCollectors) fixture.store[name] = () => {
      collectorCalls.push(name)
      throw new Error(`old collector ${name} must not run`)
    }
    const storeBefore = fixture.store.dashboardReadVersion()
    const controlBefore = fixture.control.dashboardReadVersion()
    const reader = valueOf(fixture.openReader())
    assert.equal(valueOf(reader.resolveRoot(fixture.projectKey, record.id)).state, 'visible')
    assert.deepEqual(collectorCalls, [])
    assert.deepEqual(fixture.store.dashboardReadVersion(), storeBefore)
    assert.deepEqual(fixture.control.dashboardReadVersion(), controlBefore)
  } finally {
    fixture.close()
  }
})

test('bounded SQL inventory, test-source query plans, and helper return counts match intended access paths', () => {
  const fixture = createFixture()
  try {
    const records = Array.from({ length: 18 }, (_unused, index) => addApproved(fixture.store, `Synthetic query plan row ${index}.`))
    for (const [index, record] of records.entries()) {
      fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = 0, created_at = ? WHERE id = ?')
        .run(Math.floor(index / 3), record.id)
    }
    fixture.store.db.prepare('UPDATE l1_memories SET status = \'candidate\' WHERE id = ?').run(records.at(-1).id)
    const revisionMemoryId = 'visibility-query-plan-revision-memory'
    const insertRevision = fixture.store.db.prepare(`INSERT INTO l1_revisions
      (revision_id, memory_id, revision, content, kind, status, recorded_at)
      VALUES (?, ?, ?, ?, 'fact', 'approved', ?)`)
    const relationFromId = 'visibility-query-plan-relation-source'
    for (let revision = 1; revision <= 17; revision += 1) {
      insertRevision.run(`visibility-query-plan-revision-${revision}`, revisionMemoryId, revision,
        `Synthetic revision ${revision}.`, 600 - Math.floor((revision - 1) / 5))
    }
    const insertRelation = fixture.store.db.prepare(`INSERT INTO memory_relations
      (id, from_id, to_id, relation_type, evidence_ids, from_revision, to_revision, created_at)
      VALUES (?, ?, ?, ?, '[]', 1, 1, ?)`)
    let relationNumber = 0
    for (let target = 1; target <= 7; target += 1) {
      for (const type of ['alpha', 'beta']) {
        relationNumber += 1
        insertRelation.run(`visibility-query-plan-relation-${relationNumber}`, relationFromId,
          `visibility-query-plan-target-${String(target).padStart(2, '0')}`, type, relationNumber)
      }
    }
    for (const type of ['alpha', 'beta', 'gamma']) {
      relationNumber += 1
      insertRelation.run(`visibility-query-plan-relation-${relationNumber}`, relationFromId,
        'visibility-query-plan-target-08', type, relationNumber)
    }
    const legacySourceId = 'visibility-query-plan-no-match'
    const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
    const controlSource = readFileSync(new URL('../src/control.ts', import.meta.url), 'utf8')
    const visibilitySource = readFileSync(new URL('../src/dashboard-visibility.ts', import.meta.url), 'utf8')
    for (const helper of ['dashboardVisibilityMemoryPage', 'dashboardVisibilityMemoryMeta',
      'dashboardVisibilityRevisionPage', 'dashboardVisibilityRevisionSources', 'dashboardVisibilityRevisionBody',
      'dashboardVisibilityRelationPage', 'dashboardVisibilityRelationEvidence', 'dashboardVisibilitySourceIdentity',
      'dashboardVisibilityLegacyEventPage', 'dashboardVisibilityLegacyEventMetadata',
      'dashboardVisibilityDirectCreationOrigin']) {
      assert.ok(storeSource.includes(helper), `store source contains ${helper}`)
    }
    assert.ok(controlSource.includes('dashboardVisibilityFences'))
    assert.ok(visibilitySource.includes('PAGE_ROWS = 16'))
    assert.ok(visibilitySource.includes('PAGE_ITEMS = 15'))
    const legacyHelper = storeSource.slice(storeSource.indexOf('dashboardVisibilityLegacyEventPage'),
      storeSource.indexOf('dashboardVisibilityLegacyEventMetadata'))
    assert.doesNotMatch(legacyHelper, /SELECT\s+\*/iu)
    assert.match(legacyHelper, /WHERE id > \? ORDER BY id ASC LIMIT \?/u)

    const plan = (sql, ...args) => fixture.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
      .map((row) => String(row.detail ?? '')).join('\n')
    assert.match(plan(`SELECT id FROM l1_memories WHERE project_key = ? AND status = 'approved'
      ORDER BY created_at ASC, id ASC LIMIT ?`, fixture.projectKey, 16), /l1_status_created_page|l1_status_idx/u)
    assert.match(plan(`SELECT revision FROM l1_revisions WHERE memory_id = ? AND status = 'approved'
      ORDER BY recorded_at DESC, revision DESC LIMIT ?`, revisionMemoryId, 16), /l1_revision_effective_lookup|l1_revisions/u)
    assert.match(plan(`SELECT id FROM memory_relations WHERE from_id = ? ORDER BY to_id ASC, relation_type ASC LIMIT ?`,
      relationFromId, 16), /memory_relations_from|sqlite_autoindex_memory_relations/u)
    assert.match(plan('SELECT id FROM memory_events WHERE id > ? ORDER BY id ASC LIMIT ?', 0, 16), /INTEGER PRIMARY KEY/u)
    const db = fixture.store.db
    const originalPrepareDescriptor = Object.getOwnPropertyDescriptor(db, 'prepare')
    const originalPrepare = db.prepare
    const originalExecDescriptor = Object.getOwnPropertyDescriptor(db, 'exec')
    const originalExec = db.exec
    const actualQueries = []
    const actualExecs = []
    const interceptedStatementMethods = []
    const legacyMatchArgs = Array.from({ length: 8 }, () => [fixture.projectKey, legacySourceId]).flat()
    const expectedMemoryRows = originalPrepare.call(db, `SELECT id, created_at FROM l1_memories
      WHERE project_key = ? AND status = 'approved' ORDER BY created_at ASC, id ASC`).all(fixture.projectKey)
      .map(({ id, created_at }) => ({ id, created_at }))
    const expectedRevisionRows = originalPrepare.call(db, `SELECT revision, recorded_at FROM l1_revisions
      WHERE memory_id = ? AND status = 'approved' ORDER BY recorded_at DESC, revision DESC`).all(revisionMemoryId)
      .map(({ revision, recorded_at }) => ({ revision, recorded_at }))
    const expectedRelationRows = originalPrepare.call(db, `SELECT to_id, relation_type FROM memory_relations
      WHERE from_id = ? ORDER BY to_id ASC, relation_type ASC`).all(relationFromId)
      .map(({ to_id, relation_type }) => ({ to_id, relation_type }))
    const expectedLegacyRows = originalPrepare.call(db, 'SELECT id FROM memory_events ORDER BY id ASC').all()
      .map(({ id }) => ({ id }))
    try {
      db.prepare = function (sql, ...prepareArgs) {
        const statement = originalPrepare.call(this, sql, ...prepareArgs)
        const originalAllDescriptor = Object.getOwnPropertyDescriptor(statement, 'all')
        const originalAll = statement.all
        const originalGetDescriptor = Object.getOwnPropertyDescriptor(statement, 'get')
        const originalGet = statement.get
        interceptedStatementMethods.push({ statement, originalAllDescriptor, originalGetDescriptor })
        statement.all = function (...boundArgs) {
          const rows = originalAll.apply(this, boundArgs)
          actualQueries.push({ sql: String(sql), args: boundArgs, rows: rows.length })
          return rows
        }
        statement.get = function (...boundArgs) {
          const row = originalGet.apply(this, boundArgs)
          actualQueries.push({ sql: String(sql), args: boundArgs, rows: row === undefined ? 0 : 1 })
          return row
        }
        return statement
      }
      db.exec = function (sql, ...execArgs) {
        const result = originalExec.call(this, sql, ...execArgs)
        actualExecs.push(String(sql).trim())
        return result
      }

      const memoryFirst = fixture.store.dashboardVisibilityMemoryPage(undefined, 16)
      const memoryNext = fixture.store.dashboardVisibilityMemoryPage({
        createdAt: memoryFirst.rows.at(-1).createdAt, id: memoryFirst.rows.at(-1).id,
      }, 16)
      const revisionFirst = fixture.store.dashboardVisibilityRevisionPage(revisionMemoryId, undefined, 16)
      const revisionNext = fixture.store.dashboardVisibilityRevisionPage(revisionMemoryId, {
        recordedAt: revisionFirst.rows.at(-1).recordedAt, revision: revisionFirst.rows.at(-1).revision,
      }, 16)
      const relationFirst = fixture.store.dashboardVisibilityRelationPage(relationFromId, undefined, 16)
      const relationNext = fixture.store.dashboardVisibilityRelationPage(relationFromId, {
        toId: relationFirst.rows.at(-1).toId, type: relationFirst.rows.at(-1).type,
      }, 16)
      const legacyFirst = fixture.store.dashboardVisibilityLegacyEventPage(legacySourceId, undefined, 16)
      const legacyNext = fixture.store.dashboardVisibilityLegacyEventPage(legacySourceId,
        legacyFirst.rows.at(-1).id, 16)
      const origin = fixture.store.dashboardVisibilityDirectCreationOrigin(records[0].id)

      for (const page of [memoryFirst, revisionFirst, relationFirst, legacyFirst]) {
        assert.equal(page.rows.length, 16)
        assert.equal(page.hasMore, true)
      }
      for (const page of [memoryNext, revisionNext, relationNext]) {
        assert.equal(page.rows.length, 1)
        assert.equal(page.hasMore, false)
      }
      assert.equal(legacyNext.rows.length, Math.min(16, expectedLegacyRows.length - 16))
      assert.equal(legacyNext.hasMore, expectedLegacyRows.length >= 32)
      assert.equal(origin.lookupCapabilitySupported, true)
      assert.equal(origin.creationApproved, true)
      assert.equal(origin.creationReasonIsText, true)
      assert.equal(origin.approvalFound, true)
      assert.equal(origin.approvalCountIsOne, true)
      assert.equal(origin.approvalCreatedAtIsSafe, true)
      assert.equal(origin.approvalOccurredAtIsSafe, true)
      assert.equal(origin.approvalMetadataIsText, true)
      assert.ok(Number.isSafeInteger(origin.schemaVersion) && origin.schemaVersion >= 0)
      assert.deepEqual([...memoryFirst.rows, ...memoryNext.rows].map(({ id, createdAt }) => ({ id, created_at: createdAt })), expectedMemoryRows)
      assert.deepEqual([...revisionFirst.rows, ...revisionNext.rows].map(({ revision, recordedAt }) => ({ revision, recorded_at: recordedAt })), expectedRevisionRows)
      assert.deepEqual([...relationFirst.rows, ...relationNext.rows].map(({ toId, type }) => ({ to_id: toId, relation_type: type })), expectedRelationRows)
      assert.deepEqual([...legacyFirst.rows, ...legacyNext.rows].map(({ id }) => ({ id })), expectedLegacyRows.slice(0, 32))

      const capabilityQueries = actualQueries.slice(8, -1)
      const originDataQuery = actualQueries.at(-1)
      assert.ok(capabilityQueries.length >= 7 && capabilityQueries.length <= 8,
        'the bounded capability probe visits one or two unique revision indexes')
      assert.ok(actualExecs.length + capabilityQueries.length + 1 <= DIRECT_ORIGIN_LOOKUP_COST.sqlStatements,
        'the owned transaction, bounded probe, and origin read fit the pre-admitted statement envelope')
      assert.ok(actualQueries.slice(8).reduce((sum, query) => sum + query.rows, 0) <= DIRECT_ORIGIN_LOOKUP_COST.rowsVisited,
      'the actual returned probe/origin rows fit the bounded visit envelope')
      assert.equal(actualQueries.length, 8 + capabilityQueries.length + 1,
        'capture preserves eight original page calls plus every capability probe and origin projection')
      assert.deepEqual(actualExecs, ['BEGIN DEFERRED', 'ROLLBACK'],
        'the helper owns exactly one deferred transaction and rolls it back after reading')
      assert.deepEqual(actualQueries.slice(0, 8).map(({ args }) => args), [
        [fixture.projectKey, 'approved', 16],
        [fixture.projectKey, 'approved', memoryFirst.rows.at(-1).createdAt, memoryFirst.rows.at(-1).id, 16],
        [revisionMemoryId, 16],
        [revisionMemoryId, revisionFirst.rows.at(-1).recordedAt, revisionFirst.rows.at(-1).revision, 16],
        [relationFromId, 16],
        [relationFromId, relationFirst.rows.at(-1).toId, relationFirst.rows.at(-1).type, 16],
        [...legacyMatchArgs, 16],
        [...legacyMatchArgs, legacyFirst.rows.at(-1).id, 16],
      ], 'captured bind arguments preserve each actual helper cursor order')
      assert.match(actualQueries[0].sql, /ORDER BY l1_memories\.created_at ASC, l1_memories\.id ASC LIMIT \?/u)
      assert.match(actualQueries[1].sql, /\(l1_memories\.created_at,\s*l1_memories\.id\) > \(\?,\s*\?\)/u)
      assert.match(actualQueries[1].sql, /ORDER BY l1_memories\.created_at ASC, l1_memories\.id ASC LIMIT \?/u)
      assert.match(actualQueries[2].sql, /ORDER BY l1_revisions\.recorded_at DESC, l1_revisions\.revision DESC LIMIT \?/u)
      assert.match(actualQueries[3].sql, /\(l1_revisions\.recorded_at,\s*l1_revisions\.revision\) < \(\?,\s*\?\)/u)
      assert.match(actualQueries[3].sql, /ORDER BY l1_revisions\.recorded_at DESC, l1_revisions\.revision DESC LIMIT \?/u)
      assert.match(actualQueries[4].sql, /ORDER BY memory_relations\.to_id ASC, memory_relations\.relation_type ASC LIMIT \?/u)
      assert.match(actualQueries[5].sql, /\(memory_relations\.to_id,\s*memory_relations\.relation_type\) > \(\?,\s*\?\)/u)
      assert.match(actualQueries[5].sql, /ORDER BY memory_relations\.to_id ASC, memory_relations\.relation_type ASC LIMIT \?/u)
      assert.match(actualQueries[6].sql, /FROM memory_events ORDER BY id ASC LIMIT \?/u)
      assert.match(actualQueries[7].sql, /FROM memory_events WHERE id > \? ORDER BY id ASC LIMIT \?/u)
      assert.match(capabilityQueries[0].sql, /^SELECT 1 AS snapshot_ready FROM main\.sqlite_schema LIMIT 1$/u)
      assert.deepEqual(capabilityQueries[0].args, [])
      assert.match(capabilityQueries[1].sql, /^PRAGMA main\.schema_version$/u)
      assert.deepEqual(capabilityQueries[1].args, [])
      assert.ok(capabilityQueries.slice(2, 4).every(({ sql }) => /FROM pragma_index_list\(\?, 'main'\) LIMIT \?/u.test(sql)))
      assert.deepEqual(capabilityQueries.slice(2, 4).map(({ args }) => args), [
        ['l1_revisions', 17], ['memory_events', 17],
      ])
      const revisionIndexInfoQueries = capabilityQueries.slice(4, -2)
      assert.ok(revisionIndexInfoQueries.length >= 1 && revisionIndexInfoQueries.length <= 2)
      assert.ok(revisionIndexInfoQueries.every(({ sql, args }) =>
        /FROM pragma_index_info\(\?, 'main'\) LIMIT \?/u.test(sql) &&
        /^sqlite_autoindex_l1_revisions_\d+$/u.test(args[0]) && args[1] === 3))
      assert.match(capabilityQueries.at(-2).sql, /FROM pragma_index_info\(\?, 'main'\) LIMIT \?/u)
      assert.deepEqual(capabilityQueries.at(-2).args, ['memory_events_event_unique', 2])
      assert.match(capabilityQueries.at(-1).sql, /^EXPLAIN QUERY PLAN SELECT/u)
      assert.match(capabilityQueries.at(-1).sql, /FROM main\.l1_revisions AS r INDEXED BY "sqlite_autoindex_l1_revisions_\d+"/u)
      assert.match(capabilityQueries.at(-1).sql, /LEFT JOIN main\.memory_events AS e INDEXED BY memory_events_event_unique/u)
      assert.deepEqual(capabilityQueries.at(-1).args, [
        `initial-approval:${records[0].id}`, fixture.projectKey, records[0].id, records[0].id,
      ])
      assert.match(originDataQuery.sql, /FROM main\.l1_revisions AS r INDEXED BY/u)
      assert.match(originDataQuery.sql, /LEFT JOIN main\.memory_events AS e INDEXED BY memory_events_event_unique/u)
      assert.match(originDataQuery.sql, /typeof\(r\.reason\) = 'text'/u)
      assert.match(originDataQuery.sql, /typeof\(r\.status\) = 'text' THEN\s+CASE WHEN r\.status = 'approved' THEN 1/u)
      assert.match(originDataQuery.sql, /typeof\(e\.count\) = 'integer' THEN\s+CASE WHEN e\.count = 1/u)
      assert.match(originDataQuery.sql, /typeof\(e\.created_at\) = 'integer' THEN\s+CASE WHEN e\.created_at BETWEEN 0 AND 9007199254740991/u)
      assert.match(originDataQuery.sql, /typeof\(e\.occurred_at\) = 'integer' THEN\s+CASE WHEN e\.occurred_at BETWEEN 0 AND 9007199254740991/u)
      assert.match(originDataQuery.sql, /LEFT JOIN main\.memory_events AS e INDEXED BY memory_events_event_unique/u)
      assert.match(originDataQuery.sql, /e\.event_id = \? AND e\.project_key = \? AND e\.source_id = \? AND e\.type = 'initial_approval'/u)
      assert.match(originDataQuery.sql, /length\(CAST\(e\.metadata AS BLOB\)\) <= 4096/u)
      assert.match(originDataQuery.sql, /CASE WHEN e\.metadata IS NULL THEN 0[\s\S]*ELSE 4097 END AS approval_metadata_bytes/u)
      assert.doesNotMatch(originDataQuery.sql,
        /\br\.status\s+AS|\br\.reason\s+AS|\be\.(?:count|created_at|occurred_at)\s+AS/iu,
        'raw affinity values never cross the SQLite boundary')
      assert.deepEqual(originDataQuery.args, [
        `initial-approval:${records[0].id}`, fixture.projectKey, records[0].id, records[0].id,
      ])

      const actualPlans = actualQueries.slice(0, 8).map(({ sql, args }) => originalPrepare.call(db, `EXPLAIN QUERY PLAN ${sql}`)
        .all(...args).map((row) => String(row.detail ?? '')).join('\n'))
      for (const actualPlan of actualPlans.slice(0, 6)) {
        assert.doesNotMatch(actualPlan, /USE TEMP B-TREE/iu)
      }
      assert.match(actualPlans[0], /l1_status_created_page|l1_status_idx/u)
      const assertCursorRange = (actualPlan, table, firstColumn, operator, secondColumn) => {
        const search = actualPlan.split('\n').find((line) => new RegExp(`\\bSEARCH\\s+${table}\\b`, 'iu').test(line))
        assert.ok(search, `actual ${table} continuation plan uses SEARCH`)
        const constraints = search.slice(search.indexOf('('))
        const singleColumnRange = new RegExp(`\\b${firstColumn}\\s*${operator}\\s*\\?`, 'iu').test(constraints)
        const tupleRange = new RegExp(`\\(\\s*${firstColumn}\\s*,\\s*${secondColumn}\\s*\\)\\s*${operator}\\s*\\(\\s*\\?\\s*,\\s*\\?\\s*\\)`, 'iu').test(constraints)
        assert.ok(singleColumnRange || tupleRange,
          `actual ${table} SEARCH constraints expose ${firstColumn} ${operator} cursor range: ${search}`)
      }
      assertCursorRange(actualPlans[1], 'l1_memories', 'created_at', '>', 'id')
      assert.match(actualPlans[3], /l1_revision_effective_lookup/u)
      assertCursorRange(actualPlans[3], 'l1_revisions', 'recorded_at', '<', 'revision')
      assert.match(actualPlans[5], /sqlite_autoindex_memory_relations_\d+/u)
      assertCursorRange(actualPlans[5], 'memory_relations', 'to_id', '>', 'relation_type')
      assert.match(actualPlans[6], /SCAN memory_events/iu,
        'legacy first page intentionally scans the bounded rowid prefix')
      assert.match(actualPlans[7], /SEARCH memory_events USING INTEGER PRIMARY KEY \(rowid>\?\)/iu)
    } finally {
      if (originalPrepareDescriptor === undefined) delete db.prepare
      else Object.defineProperty(db, 'prepare', originalPrepareDescriptor)
      if (originalExecDescriptor === undefined) delete db.exec
      else Object.defineProperty(db, 'exec', originalExecDescriptor)
      for (const { statement, originalAllDescriptor, originalGetDescriptor } of interceptedStatementMethods) {
        if (originalAllDescriptor === undefined) delete statement.all
        else Object.defineProperty(statement, 'all', originalAllDescriptor)
        if (originalGetDescriptor === undefined) delete statement.get
        else Object.defineProperty(statement, 'get', originalGetDescriptor)
      }
    }

    let syntheticRowsReturned = 0
    const readPage = fixture.store.dashboardVisibilityMemoryPage.bind(fixture.store)
    fixture.store.dashboardVisibilityMemoryPage = (...args) => {
      const result = readPage(...args)
      syntheticRowsReturned += result.rows.length
      return result
    }
    const reader = valueOf(fixture.openReader())
    const page = valueOf(reader.readPage(fixture.projectKey))
    assert.equal(page.items.length, 15)
    assert.equal(page.hasMore, true)
    assert.equal(syntheticRowsReturned, 16,
      'test instrumentation counts 15 returned candidates and one sentinel, not SQLite physical VM visits')
  } finally {
    fixture.close()
  }
})

test('status-aware memory keysets preserve candidate and forgotten management rows', () => {
  const fixture = createFixture()
  try {
    const candidate = fixture.store.addMemory({ content: 'Synthetic candidate remains manageable.', status: 'candidate' }).record
    const forgotten = addApproved(fixture.store, 'Synthetic forgotten memory remains manageable.')
    fixture.store.forget(forgotten.id)
    const candidatePage = fixture.store.dashboardVisibilityMemoryPage(undefined, 16, 'candidate')
    const forgottenPage = fixture.store.dashboardVisibilityMemoryPage(undefined, 16, 'forgotten')
    assert.deepEqual(candidatePage.rows.map(({ id }) => id), [candidate.id])
    assert.deepEqual(forgottenPage.rows.map(({ id }) => id), [forgotten.id])
    assert.equal(candidatePage.hasMore, false)
    assert.equal(forgottenPage.hasMore, false)
    assert.throws(() => fixture.store.dashboardVisibilityMemoryPage(undefined, 16, 'invalid'), /status is invalid/u)
  } finally {
    fixture.close()
  }
})

test('managed candidate projections preserve null and finite valid-from upper bounds', () => {
  const fixture = createFixture()
  try {
    const candidateSourceIds = [0, 1].map((index) => fixture.store.recordL0({
      sessionId: `managed-candidate-source-${index}`, role: 'user',
      content: `Synthetic source for managed candidate ${index}.`,
    }))
    const unknownStart = fixture.store.addMemory({ content: 'Synthetic candidate with an unknown effective start.',
      status: 'candidate', validFrom: null, sourceMessageIds: candidateSourceIds, sourceVerified: true }).record
    const boundedStart = fixture.store.addMemory({ content: 'Synthetic candidate with a month precision start.',
      status: 'candidate', validFrom: '2026-10', sourceMessageIds: candidateSourceIds, sourceVerified: true }).record
    const unknownProjection = fixture.store.dashboardManagedMemory(unknownStart.id)
    const boundedProjection = fixture.store.dashboardManagedMemory(boundedStart.id)
    assert.equal(unknownProjection.validFromUpper, null)
    assert.equal(boundedProjection.validFromUpper, Date.UTC(2026, 10, 1))

    const reader = valueOf(fixture.openReader())
    const page = valueOf(reader.readManagedPage(fixture.projectKey, 'candidate', undefined, 15, null))
    const summaries = new Map(page.items.flatMap((item) => item.summary === undefined ? [] : [[item.id, item.summary]]))
    assert.equal(summaries.get(unknownStart.id)?.validFromUpper, undefined)
    assert.equal(summaries.get(boundedStart.id)?.validFromUpper, Date.UTC(2026, 10, 1))

    const retryFixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 20 } } } })
    try {
      const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
      const retryCandidateSources = Array.from({ length: 26 }, (_unused, index) => retryFixture.store.recordL0({
        sessionId: `managed-retry-candidate-source-${index}`, role: 'user',
        content: `Synthetic retry source for candidate ${index}.`,
      }))
      const retryUnknownStart = retryFixture.store.addMemory({
        content: 'Synthetic candidate with an unknown effective start.', status: 'candidate', validFrom: null,
        sourceMessageIds: retryCandidateSources.slice(0, 13), sourceVerified: true,
      }).record
      const retryBoundedStart = retryFixture.store.addMemory({
        content: 'Synthetic candidate with a month precision start.', status: 'candidate', validFrom: '2026-10',
        sourceMessageIds: retryCandidateSources.slice(13), sourceVerified: true,
      }).record
      const managedPageReads = []
      const managedMetadataReads = new Map()
      const sourceIdentityReads = new Map()
      const visibilityFenceReads = []
      const originalManagedPage = retryFixture.store.dashboardVisibilityMemoryPage.bind(retryFixture.store)
      retryFixture.store.dashboardVisibilityMemoryPage = (...args) => {
        managedPageReads.push(args[2])
        return originalManagedPage(...args)
      }
      const originalManagedMemory = retryFixture.store.dashboardManagedMemory.bind(retryFixture.store)
      retryFixture.store.dashboardManagedMemory = (id, ...args) => {
        increment(managedMetadataReads, id)
        return originalManagedMemory(id, ...args)
      }
      const originalSourceIdentity = retryFixture.store.dashboardVisibilitySourceIdentity.bind(retryFixture.store)
      retryFixture.store.dashboardVisibilitySourceIdentity = (id) => {
        increment(sourceIdentityReads, id)
        return originalSourceIdentity(id)
      }
      const originalVisibilityFences = retryFixture.control.dashboardVisibilityFences.bind(retryFixture.control)
      retryFixture.control.dashboardVisibilityFences = (input) => {
        visibilityFenceReads.push({ memoryIds: [...(input.memoryIds ?? [])], sourceIds: [...(input.sourceIds ?? [])] })
        return originalVisibilityFences(input)
      }
      const resumeUntilPage = (reader, status, limit, contentLimit, taskKey, initial) => {
        let page = initial
        let handoffs = 0
        while (page.status === 'budget-exhausted' && page.reason === 'persona-call-headroom' && handoffs < 12) {
          valueOf(reader.suspendForRpc())
          valueOf(reader.resumeForRpc())
          handoffs += 1
          page = reader.readManagedPage(retryFixture.projectKey, status, undefined, limit, contentLimit, taskKey)
        }
        return { page, handoffs }
      }

      const retryReader = valueOf(retryFixture.openReader())
      const blocked = retryReader.readManagedPage(retryFixture.projectKey, 'candidate', undefined, 2, null, 'candidate-retry')
      assert.equal(blocked.status, 'budget-exhausted')
      assert.equal(blocked.reason, 'persona-call-headroom')
      assert.equal(blocked.value, undefined, 'a partially proved page cannot expose rows or a later cursor')
      assert.ok(retryReader.remainingReadWorkBreakdown(), 'call-local headroom leaves the same reader available to resume')
      assert.equal(managedMetadataReads.size, 1, 'the real budget stops after one candidate metadata read')
      const partialCandidateId = managedMetadataReads.keys().next().value
      assert.ok([retryUnknownStart.id, retryBoundedStart.id].includes(partialCandidateId))
      const candidateIdentityReadsAtBlock = [...sourceIdentityReads.values()].reduce((sum, count) => sum + count, 0)
      assert.ok(candidateIdentityReadsAtBlock > 0 && candidateIdentityReadsAtBlock < 13,
        'the real budget stops after some but not all paid source identities inside the candidate proof')
      const partialSourceId = sourceIdentityReads.keys().next().value
      const candidateCountersAtBlock = valueOf(retryFixture.manager.counters(retryReader.callToken))
      const candidateRetried = resumeUntilPage(retryReader, 'candidate', 2, null, 'candidate-retry', blocked)
      assert.equal(candidateRetried.page.status, 'ok')
      assert.ok(candidateRetried.handoffs > 0, 'candidate progress crosses a real suspend/resume boundary')
      const candidateRetriedPage = valueOf(candidateRetried.page)
      assert.equal(candidateRetriedPage.items.length, 2)
      assert.equal(candidateRetriedPage.items.every((item) => item.state === 'visible' && item.summary !== undefined), true)
      assert.equal(candidateRetriedPage.hasMore, false)
      assert.deepEqual(managedPageReads, ['candidate'], 'the charged raw page SELECT is not repeated across RPCs')
      assert.equal(managedMetadataReads.get(retryUnknownStart.id), 1, 'candidate metadata is not paid twice across the item retry')
      assert.equal(managedMetadataReads.get(retryBoundedStart.id), 1)
      for (const sourceId of retryCandidateSources) assert.equal(sourceIdentityReads.get(sourceId), 1,
        'each candidate source identity is read once across the real continuation')
      assert.equal(visibilityFenceReads.filter((entry) => entry.memoryIds.includes(partialCandidateId)).length, 1,
        'the partial candidate memory fence is not repeated after resume')
      assert.equal(visibilityFenceReads.filter((entry) => entry.sourceIds.includes(partialSourceId)).length, 1,
        'the partial candidate source fence is not repeated after resume')
      const candidateCountersAfterRetry = valueOf(retryFixture.manager.counters(retryReader.callToken))
      assert.ok(candidateCountersAfterRetry.session.sqlStatements > candidateCountersAtBlock.session.sqlStatements,
        'resuming the unfinished item adds only its remaining proof work and boundary probes')
      assert.equal(retryReader.cancel().status, 'ok', 'the completed candidate reader releases its retained session')

      const approvedSources = Array.from({ length: 26 }, (_unused, index) => retryFixture.store.recordL0({
        sessionId: `managed-retry-approved-source-${index}`, role: 'user',
        content: `Synthetic retry source for approved memory ${index}.`,
      }))
      const approvedFirst = addApproved(retryFixture.store, 'Synthetic approved page proof retained across call headroom.', {
        sourceMessageIds: approvedSources.slice(0, 13), sourceVerified: true,
      })
      const approvedSecond = addApproved(retryFixture.store, 'Synthetic approved page resumes without advancing its cursor.', {
        sourceMessageIds: approvedSources.slice(13), sourceVerified: true,
      })
      const approvedMetadataReads = new Map()
      const approvedRevisionReads = new Map()
      const approvedRevisionSourceReads = new Map()
      const approvedBodyReads = new Map()
      const originalMemoryMeta = retryFixture.store.dashboardVisibilityMemoryMeta.bind(retryFixture.store)
      retryFixture.store.dashboardVisibilityMemoryMeta = (id, ...args) => {
        increment(approvedMetadataReads, id)
        return originalMemoryMeta(id, ...args)
      }
      const originalRevisionPage = retryFixture.store.dashboardVisibilityRevisionPage.bind(retryFixture.store)
      retryFixture.store.dashboardVisibilityRevisionPage = (id, ...args) => {
        increment(approvedRevisionReads, id)
        return originalRevisionPage(id, ...args)
      }
      const originalRevisionSources = retryFixture.store.dashboardVisibilityRevisionSources.bind(retryFixture.store)
      retryFixture.store.dashboardVisibilityRevisionSources = (id, ...args) => {
        increment(approvedRevisionSourceReads, id)
        return originalRevisionSources(id, ...args)
      }
      const originalRevisionBody = retryFixture.store.dashboardVisibilityRevisionBody.bind(retryFixture.store)
      retryFixture.store.dashboardVisibilityRevisionBody = (id, ...args) => {
        increment(approvedBodyReads, id)
        return originalRevisionBody(id, ...args)
      }
      const approvedReader = valueOf(retryFixture.openReader())
      const approvedBlocked = approvedReader.readManagedPage(retryFixture.projectKey, 'approved', undefined, 2, 8192,
        'approved-retry')
      assert.equal(approvedBlocked.status, 'budget-exhausted')
      assert.equal(approvedBlocked.reason, 'persona-call-headroom')
      assert.equal(approvedBlocked.value, undefined, 'the delegated page cannot expose a partial result or later cursor')
      assert.ok(approvedReader.remainingReadWorkBreakdown(), 'call-local headroom preserves the page reader for retry')
      assert.equal(approvedMetadataReads.size, 1, 'the actual budget stops after one approved item metadata read')
      const partialApprovedId = approvedMetadataReads.keys().next().value
      assert.ok([approvedFirst.id, approvedSecond.id].includes(partialApprovedId))
      assert.equal(approvedRevisionReads.get(partialApprovedId), 1,
        'approved revision rows were read before the actual budget stop')
      const approvedCountersAtBlock = valueOf(retryFixture.manager.counters(approvedReader.callToken))
      const approvedRetried = resumeUntilPage(approvedReader, 'approved', 2, 8192, 'approved-retry', approvedBlocked)
      assert.equal(approvedRetried.page.status, 'ok')
      assert.ok(approvedRetried.handoffs > 0, 'approved proof progress crosses a real suspend/resume boundary')
      const approvedRetriedPage = valueOf(approvedRetried.page)
      assert.deepEqual(new Set(approvedRetriedPage.items.map((item) => item.id)), new Set([approvedFirst.id, approvedSecond.id]))
      assert.equal(approvedRetriedPage.items.every((item) => item.state === 'visible' && item.record !== undefined), true)
      assert.equal(approvedRetriedPage.hasMore, false)
      assert.deepEqual(managedPageReads, ['candidate', 'approved'], 'candidate and approved raw page SELECTs each run once')
      for (const approved of [approvedFirst, approvedSecond]) {
        assert.equal(approvedMetadataReads.get(approved.id), 1, 'approved metadata is never repeated')
        assert.equal(approvedRevisionReads.get(approved.id), 1, 'approved revision rows are never repeated')
        assert.equal(approvedRevisionSourceReads.get(approved.id), 1, 'approved revision source ids are never refetched')
        assert.equal(approvedBodyReads.get(approved.id), 1, 'approved revision bodies are never refetched')
        assert.equal(visibilityFenceReads.filter((entry) => entry.memoryIds.includes(approved.id)).length, 1,
          'the approved memory fence is not repeated after resume')
      }
      for (const sourceId of approvedSources) assert.equal(sourceIdentityReads.get(sourceId), 1,
        'each approved source identity is read once across the real continuation')
      const approvedCountersAfterRetry = valueOf(retryFixture.manager.counters(approvedReader.callToken))
      assert.ok(approvedCountersAfterRetry.session.sqlStatements > approvedCountersAtBlock.session.sqlStatements,
        'resuming the unfinished approved proof adds its remaining queries and boundary probes')
      assert.equal(approvedReader.cancel().status, 'ok', 'the completed approved reader releases its retained session')

      const makeHeadroomBlockedCandidateReader = () => {
        const blockedReader = valueOf(retryFixture.openReader())
        const page = blockedReader.readManagedPage(retryFixture.projectKey, 'candidate', undefined, 2, null,
          'scheduler-candidate')
        assert.equal(page.status, 'budget-exhausted')
        assert.equal(page.reason, 'persona-call-headroom')
        return blockedReader
      }

      const sessionsBeforeSwitch = retryFixture.manager.stats().sessions
      const switchReader = makeHeadroomBlockedCandidateReader()
      valueOf(switchReader.suspendForRpc())
      valueOf(switchReader.resumeForRpc())
      const forgottenPage = switchReader.readManagedPage(retryFixture.projectKey, 'forgotten', undefined, 2, null,
        'scheduler-forgotten')
      assert.equal(forgottenPage.status, 'ok', 'a different scheduled status can run on the same reader')
      assert.deepEqual(valueOf(forgottenPage).items, [])
      assert.equal(retryFixture.manager.stats().sessions, sessionsBeforeSwitch + 1,
        'a normal category switch retains the live read session and candidate progress')
      const candidateSwitchRetry = switchReader.readManagedPage(retryFixture.projectKey, 'candidate', undefined, 2, null,
        'scheduler-candidate')
      const candidateAfterSwitch = resumeUntilPage(switchReader, 'candidate', 2, null, 'scheduler-candidate', candidateSwitchRetry)
      assert.equal(candidateAfterSwitch.page.status, 'ok', 'the original task resumes after another category runs')
      assert.equal(valueOf(candidateAfterSwitch.page).items.length, 2)
      assert.equal(switchReader.cancel().status, 'ok', 'the completed switched reader releases its retained session')

      const sessionsBeforeCancel = retryFixture.manager.stats().sessions
      const cancelReader = makeHeadroomBlockedCandidateReader()
      assert.equal(retryFixture.manager.stats().sessions, sessionsBeforeCancel + 1)
      valueOf(cancelReader.suspendForRpc())
      assert.equal(cancelReader.cancel().status, 'ok')
      assert.equal(retryFixture.manager.stats().sessions, sessionsBeforeCancel,
        'cancelling a suspended page drops its retained rows, results, and resident leases')

      const sessionsBeforeVersionChange = retryFixture.manager.stats().sessions
      const versionReader = makeHeadroomBlockedCandidateReader()
      valueOf(versionReader.suspendForRpc())
      retryFixture.store.addMemory({ content: 'Synthetic candidate that changes the project version.', status: 'candidate' })
      const changedVersion = versionReader.resumeForRpc()
      assert.notEqual(changedVersion.status, 'ok', 'a project version change rejects the retained page continuation')
      assert.equal(retryFixture.manager.stats().sessions, sessionsBeforeVersionChange,
        'version rejection retires the session and releases its retained page cache')
    } finally { retryFixture.close() }

    // --- Real low-budget resume breakpoints --------------------------------
    const openWithManager = (target, manager) => valueOf(DashboardVisibilityReadSession.open({
      manager, control: target.control,
      stores: new Map([[target.projectKey, target.store]]),
      binding: makeBinding([target.projectKey]),
    }))
    const countersOf = (manager, reader) => valueOf(manager.counters(reader.callToken))
    const resumeManagedPage = (reader, target, status, limit, contentLimit, taskKey, initial) => {
      let page = initial
      let handoffs = 0
      while (page.status === 'budget-exhausted' && page.reason === 'persona-call-headroom' && handoffs < 12) {
        valueOf(reader.suspendForRpc())
        valueOf(reader.resumeForRpc())
        handoffs += 1
        page = reader.readManagedPage(target.projectKey, status, undefined, limit, contentLimit, taskKey)
      }
      return { page, handoffs }
    }

    // A real per-call SQL budget stops an approved capture-source proof in the
    // middle of one source batch. The resumed item must continue at the next
    // unproven identity (not replay the batch), then run that batch's event
    // fence exactly once over the collected event IDs.
    const captureFixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 20 } } } })
    const captureBaselineManager = new DashboardReadSessionManager({})
    try {
      const captureEventSourceIds = Array.from({ length: 17 }, (_unused, index) =>
        captureFixture.store.recordL0({ sessionId: `capture-resume-${index}`, role: 'user',
          content: `Synthetic capture resume source ${index}.`, sourceEventId: `capture-resume-event-${index}` }))
      const captureRootContent = 'Synthetic approved capture-source proof resumes across RPCs.'
      const captureRoot = addApproved(captureFixture.store, captureRootContent,
        { sourceMessageIds: captureEventSourceIds, sourceVerified: true })
      const captureIdentityReads = new Map()
      const captureRevisionSourceReads = new Map()
      const captureFenceReads = []
      const incrementCapture = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
      const originalCaptureIdentity = captureFixture.store.dashboardVisibilitySourceIdentity.bind(captureFixture.store)
      captureFixture.store.dashboardVisibilitySourceIdentity = (id) => {
        incrementCapture(captureIdentityReads, id)
        return originalCaptureIdentity(id)
      }
      const originalCaptureRevisionSources = captureFixture.store.dashboardVisibilityRevisionSources.bind(captureFixture.store)
      captureFixture.store.dashboardVisibilityRevisionSources = (id, ...args) => {
        incrementCapture(captureRevisionSourceReads, id)
        return originalCaptureRevisionSources(id, ...args)
      }
      const originalCaptureFences = captureFixture.control.dashboardVisibilityFences.bind(captureFixture.control)
      captureFixture.control.dashboardVisibilityFences = (input) => {
        captureFenceReads.push({ memoryIds: [...(input.memoryIds ?? [])], sourceIds: [...(input.sourceIds ?? [])],
          sourceEventIds: [...(input.sourceEventIds ?? [])] })
        return originalCaptureFences(input)
      }

      const captureReader = valueOf(captureFixture.openReader())
      const captureBlocked = captureReader.readManagedPage(captureFixture.projectKey, 'approved', undefined, 1, 8192,
        'capture-resume')
      assert.equal(captureBlocked.status, 'budget-exhausted')
      assert.equal(captureBlocked.reason, 'persona-call-headroom')
      assert.equal(captureBlocked.value, undefined)
      assert.equal(captureIdentityReads.size, 5,
        'the real SQL budget stops after the fifth capture identity of the first fifteen-source batch')
      assert.equal(captureFenceReads.filter((entry) => entry.sourceEventIds.length > 0).length, 0,
        'the event fence has not run before the source batch is complete')
      const captureResumed = resumeManagedPage(captureReader, captureFixture, 'approved', 1, 8192, 'capture-resume',
        captureBlocked)
      assert.equal(captureResumed.page.status, 'ok')
      assert.ok(captureResumed.handoffs > 0)
      const capturePage = valueOf(captureResumed.page)
      assert.equal(capturePage.items.length, 1)
      assert.equal(capturePage.items[0].state, 'visible')
      assert.equal(capturePage.items[0].record?.id, captureRoot.id)
      assert.equal(capturePage.items[0].record?.content, captureRootContent)
      assert.equal(capturePage.items[0].record?.sourceMessageIds.length, 17)
      for (const sourceId of captureEventSourceIds) assert.equal(captureIdentityReads.get(sourceId), 1,
        'each capture source identity is read exactly once across the resumed item')
      assert.equal(captureRevisionSourceReads.get(captureRoot.id), 1)
      const captureEventFences = captureFenceReads.filter((entry) => entry.sourceEventIds.length > 0)
      assert.equal(captureEventFences.length, 2, 'one event fence runs per completed source batch and none is repeated')
      assert.equal(captureEventFences[0].sourceEventIds.length, 15)
      assert.equal(captureEventFences[1].sourceEventIds.length, 2)
      assert.equal(new Set(captureEventFences.flatMap((entry) => entry.sourceEventIds)).size, 17)
      assert.equal(captureFenceReads.filter((entry) => entry.sourceIds.length > 0).length, 2,
        'each source batch fence is read once')
      assert.equal(captureFenceReads.filter((entry) => entry.memoryIds.length > 0).length, 1,
        'the memory fence batch is reused rather than repeated after resume')
      const captureCountersAfter = countersOf(captureFixture.manager, captureReader)
      assert.ok(captureCountersAfter.session.materializedBytes > 0)

      const captureBaselineReader = openWithManager(captureFixture, captureBaselineManager)
      const captureBaselinePage = valueOf(captureBaselineReader.readManagedPage(captureFixture.projectKey,
        'approved', undefined, 1, 8192, 'capture-resume'))
      assert.equal(captureBaselinePage.items[0].record?.content, captureRootContent)
      const captureBaselineCounters = countersOf(captureBaselineManager, captureBaselineReader)
      valueOf(captureBaselineReader.advance(false))
      assert.equal(captureCountersAfter.session.materializedBytes, captureBaselineCounters.session.materializedBytes,
        'the resumed capture proof costs exactly one uninterrupted proof: no SQL, JSON, or lease byte is charged twice')
      assert.equal(captureCountersAfter.session.sqlStatements - captureBaselineCounters.session.sqlStatements,
        8 * captureResumed.handoffs, 'only the per-RPC version proofs add SQL work across the real handoffs')
      valueOf(captureReader.advance(false))
      assert.equal(captureFixture.manager.stats().sessions, 0, 'finishing the capture reader drops its session')
      assert.ok(captureFixture.manager.stats().accountedBytes < captureCountersAfter.accountedBytes,
        'finishing the capture reader releases its item, JSON, event, and memo leases')
    } finally {
      captureBaselineManager.close()
      captureFixture.close()
    }

    // A real per-call SQL budget stops an approved diamond dependency proof
    // after some relation pages and evidence JSON arrays are already materialized.
    // The resumed item keeps that graph state and does not refetch either.
    const graphFixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 20 } } } })
    const graphBaselineManager = new DashboardReadSessionManager({})
    try {
      const graphEvidence = Array.from({ length: 2 }, (_unused, index) => graphFixture.store.recordL0({
        sessionId: `graph-resume-evidence-${index}`, role: 'user', content: `Synthetic graph resume evidence ${index}.` }))
      const graphRootContent = 'Synthetic diamond root resumes its JSON dependency graph.'
      const graphRoot = addApproved(graphFixture.store, graphRootContent)
      const graphLeft = addApproved(graphFixture.store, 'Synthetic diamond left resumes.')
      const graphRight = addApproved(graphFixture.store, 'Synthetic diamond right resumes.')
      const graphLeaf = addApproved(graphFixture.store, 'Synthetic diamond leaf resumes.')
      graphFixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE id = ?').run(Date.now() - 1_000, graphRoot.id)
      const graphRelationIds = [
        'relation-resume-root-left', 'relation-resume-root-right',
        'relation-resume-left-leaf', 'relation-resume-right-leaf',
      ]
      insertRelation(graphFixture.store, graphRelationIds[0], graphRoot, graphLeft, graphEvidence)
      insertRelation(graphFixture.store, graphRelationIds[1], graphRoot, graphRight, graphEvidence)
      insertRelation(graphFixture.store, graphRelationIds[2], graphLeft, graphLeaf, graphEvidence)
      insertRelation(graphFixture.store, graphRelationIds[3], graphRight, graphLeaf, graphEvidence)
      const graphRelationPageReads = new Map()
      const graphEvidenceReads = new Map()
      const graphRevisionSourceReads = new Map()
      const incrementGraph = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
      const originalRelationPage = graphFixture.store.dashboardVisibilityRelationPage.bind(graphFixture.store)
      graphFixture.store.dashboardVisibilityRelationPage = (id, ...args) => {
        incrementGraph(graphRelationPageReads, id)
        return originalRelationPage(id, ...args)
      }
      const originalRelationEvidence = graphFixture.store.dashboardVisibilityRelationEvidence.bind(graphFixture.store)
      graphFixture.store.dashboardVisibilityRelationEvidence = (id, ...args) => {
        incrementGraph(graphEvidenceReads, id)
        return originalRelationEvidence(id, ...args)
      }
      const originalGraphRevisionSources = graphFixture.store.dashboardVisibilityRevisionSources.bind(graphFixture.store)
      graphFixture.store.dashboardVisibilityRevisionSources = (id, ...args) => {
        incrementGraph(graphRevisionSourceReads, id)
        return originalGraphRevisionSources(id, ...args)
      }

      const graphReader = valueOf(graphFixture.openReader())
      const graphBlocked = graphReader.readManagedPage(graphFixture.projectKey, 'approved', undefined, 1, 8192,
        'graph-resume')
      assert.equal(graphBlocked.status, 'budget-exhausted')
      assert.equal(graphBlocked.reason, 'persona-call-headroom')
      assert.equal(graphBlocked.value, undefined)
      assert.equal(graphRelationPageReads.size, 2,
        'the real SQL budget stops two relation pages into the four-node diamond')
      assert.equal(graphEvidenceReads.size, 3, 'three dependency evidence JSON arrays were already materialized')
      const graphResumed = resumeManagedPage(graphReader, graphFixture, 'approved', 1, 8192, 'graph-resume', graphBlocked)
      assert.equal(graphResumed.page.status, 'ok')
      assert.ok(graphResumed.handoffs > 0)
      const graphPage = valueOf(graphResumed.page)
      assert.equal(graphPage.items.length, 1)
      assert.equal(graphPage.items[0].state, 'visible')
      assert.equal(graphPage.items[0].record?.id, graphRoot.id)
      assert.equal(graphPage.items[0].record?.content, graphRootContent)
      for (const node of [graphRoot, graphLeft, graphRight, graphLeaf]) {
        assert.equal(graphRelationPageReads.get(node.id), 1, 'each dependency relation page is materialized once')
        assert.equal(graphRevisionSourceReads.get(node.id), 1, 'each revision source JSON array is materialized once')
      }
      for (const relationId of graphRelationIds) assert.equal(graphEvidenceReads.get(relationId), 1,
        'each dependency evidence JSON array is materialized once')
      const graphCountersAfter = countersOf(graphFixture.manager, graphReader)

      const graphBaselineReader = openWithManager(graphFixture, graphBaselineManager)
      const graphBaselinePage = valueOf(graphBaselineReader.readManagedPage(graphFixture.projectKey,
        'approved', undefined, 1, 8192, 'graph-resume'))
      assert.equal(graphBaselinePage.items[0].record?.content, graphRootContent)
      const graphBaselineCounters = countersOf(graphBaselineManager, graphBaselineReader)
      valueOf(graphBaselineReader.advance(false))
      assert.equal(graphCountersAfter.session.materializedBytes, graphBaselineCounters.session.materializedBytes,
        'the resumed dependency graph costs exactly one uninterrupted proof')
      assert.equal(graphCountersAfter.session.sqlStatements - graphBaselineCounters.session.sqlStatements,
        8 * graphResumed.handoffs, 'only the per-RPC version proofs add SQL work across the diamond resume')
      valueOf(graphReader.advance(false))
      assert.equal(graphFixture.manager.stats().sessions, 0, 'finishing the graph reader drops its session')
      assert.ok(graphFixture.manager.stats().accountedBytes < graphCountersAfter.accountedBytes,
        'finishing the graph reader releases its relation, JSON, and memo leases')
    } finally {
      graphBaselineManager.close()
      graphFixture.close()
    }

    // A real per-call materialized budget is tuned from the exact cumulative
    // work before the memo block: the block commits, the root output lease is
    // denied, and the resumed item reuses the committed memo instead of
    // re-proving the graph or paying for a second memo block.
    const memoFixture = createFixture()
    const memoBaselineManager = new DashboardReadSessionManager({})
    let memoTunedManager
    try {
      const memoSourceIds = Array.from({ length: 3 }, (_unused, index) => memoFixture.store.recordL0({
        sessionId: `memo-output-source-${index}`, role: 'user', content: `Synthetic memo output source ${index}.` }))
      const memoEvidence = memoFixture.store.recordL0({ sessionId: 'memo-output-evidence', role: 'user',
        content: 'Synthetic memo output evidence.' })
      const memoRootContent = 'Synthetic memo-commit boundary resumes with its committed proof.'
      const memoRoot = addApproved(memoFixture.store, memoRootContent,
        { sourceMessageIds: memoSourceIds, sourceVerified: true })
      const memoDependency = addApproved(memoFixture.store, 'Synthetic memo-commit dependency.')
      memoFixture.store.db.prepare('UPDATE l1_memories SET created_at = ? WHERE id = ?').run(Date.now() - 1_000, memoRoot.id)
      insertRelation(memoFixture.store, 'relation-memo-output', memoRoot, memoDependency, [memoEvidence])
      const memoBinding = makeBinding([memoFixture.projectKey])
      let memoWorkBeforeBlock
      const memoBaselineReader = valueOf(DashboardVisibilityReadSession.open({ manager: memoBaselineManager,
        control: memoFixture.control, stores: new Map([[memoFixture.projectKey, memoFixture.store]]),
        binding: memoBinding }))
      const originalMemoReserve = memoBaselineManager.reserveResident.bind(memoBaselineManager)
      memoBaselineManager.reserveResident = (callToken, kind, bytes) => {
        if (memoWorkBeforeBlock === undefined && kind === 'cache' && bytes === 8_192 &&
            memoBaselineReader.memo.size === 0) {
          memoWorkBeforeBlock = countersOf(memoBaselineManager, memoBaselineReader).call.materializedBytes
        }
        return originalMemoReserve(callToken, kind, bytes)
      }
      const memoBaselinePage = valueOf(memoBaselineReader.readManagedPage(memoFixture.projectKey, 'approved',
        undefined, 1, 8192, 'memo-output'))
      assert.equal(memoBaselinePage.items[0].record?.content, memoRootContent)
      assert.ok(Number.isSafeInteger(memoWorkBeforeBlock), 'the baseline proof commits one real memo block')
      const memoBaselineCounters = countersOf(memoBaselineManager, memoBaselineReader)
      valueOf(memoBaselineReader.advance(false))
      assert.ok(memoWorkBeforeBlock + 8_192 <= 1024 * 1024,
        'the tuned per-call materialized limit stays inside the fixed server maximum')

      memoTunedManager = new DashboardReadSessionManager({
        limits: { perCall: { materializedBytes: memoWorkBeforeBlock + 8_192 } },
      })
      const memoTunedReader = valueOf(DashboardVisibilityReadSession.open({ manager: memoTunedManager,
        control: memoFixture.control, stores: new Map([[memoFixture.projectKey, memoFixture.store]]),
        binding: memoBinding }))
      const memoTunedBlocked = memoTunedReader.readManagedPage(memoFixture.projectKey, 'approved', undefined, 1, 8192,
        'memo-output')
      assert.equal(memoTunedBlocked.status, 'budget-exhausted')
      assert.equal(memoTunedBlocked.reason, 'persona-call-headroom')
      assert.equal(memoTunedBlocked.value, undefined, 'no partial page or later cursor escapes the memo boundary')
      assert.equal(memoTunedReader.memo.size, 2, 'the root and its dependency are committed before the output lease')
      assert.equal(memoTunedReader.memoReservations.length, 1, 'exactly one memo block was paid before the stop')
      const memoTunedBlockedCounters = countersOf(memoTunedManager, memoTunedReader)
      assert.equal(memoTunedBlockedCounters.call.materializedBytes, memoWorkBeforeBlock + 8_192,
        'the stop happens exactly after the real memo reservation and before the output reservation')
      valueOf(memoTunedReader.suspendForRpc())
      valueOf(memoTunedReader.resumeForRpc())
      const memoTunedPage = valueOf(memoTunedReader.readManagedPage(memoFixture.projectKey, 'approved', undefined, 1,
        8192, 'memo-output'))
      assert.equal(memoTunedPage.items.length, 1)
      assert.equal(memoTunedPage.items[0].state, 'visible')
      assert.equal(memoTunedPage.items[0].record?.content, memoRootContent)
      const memoTunedAfter = countersOf(memoTunedManager, memoTunedReader)
      const memoContentBytes = Buffer.byteLength(memoRootContent, 'utf8')
      const memoRootKeyBytes = memoSourceIds.reduce((sum, sourceId) => sum + Buffer.byteLength(sourceId, 'utf8') + 32, 0)
      const memoExpectedDelta = Math.max(1024, memoRootKeyBytes + 512) +
        Math.max(1024, memoContentBytes + 256) + Math.max(256, memoContentBytes + 32)
      assert.equal(memoTunedAfter.session.materializedBytes - memoTunedBlockedCounters.session.materializedBytes,
        memoExpectedDelta, 'the resumed memo proof charges only the still-missing output and body work')
      assert.equal(memoTunedAfter.session.materializedBytes, memoBaselineCounters.session.materializedBytes,
        'the interrupted memo proof costs exactly one uninterrupted proof')
      assert.equal(memoTunedAfter.session.sqlStatements - memoBaselineCounters.session.sqlStatements, 8,
        'one handoff adds only the two per-RPC version proofs')
      assert.equal(memoTunedReader.memoReservations.length, 1, 'the resumed proof does not reserve a second memo block')
      assert.equal(memoTunedReader.memo.size, 2)
      valueOf(memoTunedReader.advance(false))
    } finally {
      memoTunedManager?.close()
      memoBaselineManager.close()
      memoFixture.close()
    }

    // Another task on the same readId fills the shared memo while the first
    // task is stopped mid-source-batch. The first task resumes at its own next
    // source index, reads each remaining identity once, and reuses the memo
    // block the second task already paid for.
    const interleaveFixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 20 } } } })
    try {
      const interleaveSourceIds = Array.from({ length: 17 }, (_unused, index) => interleaveFixture.store.recordL0({
        sessionId: `interleave-source-${index}`, role: 'user', content: `Synthetic interleave source ${index}.` }))
      const interleaveContent = 'Synthetic interleaved task proof resumes after another task fills the memo.'
      const interleaveRoot = addApproved(interleaveFixture.store, interleaveContent,
        { sourceMessageIds: interleaveSourceIds, sourceVerified: true })
      const interleaveIdentityReads = new Map()
      const originalInterleaveIdentity = interleaveFixture.store.dashboardVisibilitySourceIdentity.bind(interleaveFixture.store)
      interleaveFixture.store.dashboardVisibilitySourceIdentity = (id) => {
        interleaveIdentityReads.set(id, (interleaveIdentityReads.get(id) ?? 0) + 1)
        return originalInterleaveIdentity(id)
      }
      const interleaveReader = valueOf(interleaveFixture.openReader())
      const interleaveBlocked = interleaveReader.readManagedPage(interleaveFixture.projectKey, 'approved', undefined, 1,
        8192, 'interleave-a')
      assert.equal(interleaveBlocked.status, 'budget-exhausted')
      assert.equal(interleaveBlocked.reason, 'persona-call-headroom')
      assert.equal(interleaveIdentityReads.size, 5, 'the first task stopped after five real source identities')
      const interleaveFirstTaskIds = [...interleaveIdentityReads.keys()]
      assert.equal(interleaveReader.memo.size, 0, 'the first task has not committed a memo proof yet')
      valueOf(interleaveReader.suspendForRpc())
      valueOf(interleaveReader.resumeForRpc())
      const interleaveSecondStart = interleaveReader.readManagedPage(interleaveFixture.projectKey, 'approved',
        undefined, 1, 8192, 'interleave-b')
      const interleaveSecond = resumeManagedPage(interleaveReader, interleaveFixture, 'approved', 1, 8192,
        'interleave-b', interleaveSecondStart)
      assert.equal(interleaveSecond.page.status, 'ok')
      assert.ok(interleaveSecond.handoffs > 0)
      assert.equal(valueOf(interleaveSecond.page).items[0].record?.content, interleaveContent)
      assert.equal(interleaveReader.memo.size, 1, 'the second task committed the shared root memo entry')
      assert.equal(interleaveReader.memoReservations.length, 1, 'the second task paid for exactly one memo block')
      const interleaveCountersAfterSecond = countersOf(interleaveFixture.manager, interleaveReader)
      for (const sourceId of interleaveSourceIds) {
        assert.equal(interleaveIdentityReads.get(sourceId), interleaveFirstTaskIds.includes(sourceId) ? 2 : 1,
          'the second task reads every source once; the five already read by the first task are not read again')
      }
      const interleaveFirstRetry = interleaveReader.readManagedPage(interleaveFixture.projectKey, 'approved',
        undefined, 1, 8192, 'interleave-a')
      const interleaveFirst = resumeManagedPage(interleaveReader, interleaveFixture, 'approved', 1, 8192,
        'interleave-a', interleaveFirstRetry)
      assert.equal(interleaveFirst.page.status, 'ok')
      const interleaveFirstPage = valueOf(interleaveFirst.page)
      assert.equal(interleaveFirstPage.items.length, 1)
      assert.equal(interleaveFirstPage.items[0].state, 'visible')
      assert.equal(interleaveFirstPage.items[0].record?.id, interleaveRoot.id)
      assert.equal(interleaveFirstPage.items[0].record?.content, interleaveContent)
      for (const sourceId of interleaveSourceIds) {
        assert.equal(interleaveIdentityReads.get(sourceId), 2,
          'each source is read once by each task and never repeated by the resumed task')
      }
      assert.equal(interleaveReader.memo.size, 1)
      assert.equal(interleaveReader.memoReservations.length, 1,
        'resuming the first task reuses the memo block the second task already paid for')
      const interleaveCountersAfterFirst = countersOf(interleaveFixture.manager, interleaveReader)
      const interleaveContentBytes = Buffer.byteLength(interleaveContent, 'utf8')
      const interleaveRootKeyBytes = interleaveSourceIds.reduce((sum, sourceId) =>
        sum + Buffer.byteLength(sourceId, 'utf8') + 32, 0)
      const interleaveMissingIdentities = interleaveSourceIds.length - interleaveFirstTaskIds.length
      const interleaveExpectedDelta = interleaveMissingIdentities * 20_608 + Math.max(256, 2 * 96) +
        Math.max(1024, interleaveRootKeyBytes + 512) + Math.max(1024, interleaveContentBytes + 256) +
        Math.max(256, interleaveContentBytes + 32)
      assert.equal(interleaveCountersAfterFirst.session.materializedBytes -
        interleaveCountersAfterSecond.session.materializedBytes, interleaveExpectedDelta,
        'the first task resumes with only its remaining identities, one source fence, and its own output')
    } finally {
      interleaveFixture.close()
    }

    const detailReader = valueOf(fixture.openReader())
    detailReader.proveRoot = () => failure('budget-exhausted', 'persona-call-headroom')
    const detailBlocked = detailReader.resolveRoot(fixture.projectKey, boundedStart.id)
    assert.equal(detailBlocked.status, 'budget-exhausted')
    assert.equal(detailBlocked.reason, 'persona-call-headroom')
    assert.equal(detailBlocked.value, undefined, 'a detail proof cannot turn missing work budget into an unresolved memory')
    assert.ok(detailReader.remainingReadWorkBreakdown(), 'call-local headroom keeps the detail reader live')

    const pageFirstFixture = createFixture()
    try {
      const reader = valueOf(pageFirstFixture.openReader())
      const accountedBefore = pageFirstFixture.manager.stats().accountedBytes
      for (let index = 0; index < 63; index += 1) {
        const key = `synthetic-page-continuation-${index}`
        reader.managedPageContinuations.set(key, { key, rows: [], hasMore: true, items: [],
          itemReservations: [], reservations: [] })
      }
      reader.proveRoot = () => failure('budget-exhausted', 'persona-call-headroom')
      const proof = reader.resolveRoot(pageFirstFixture.projectKey, 'synthetic-proof-after-pages')
      assert.equal(proof.reason, 'persona-call-headroom')
      assert.equal(reader.managedPageContinuations.size + reader.managedProofContinuations.size, 64,
        'a proof continuation fills the shared bound after page continuations')
      const page = reader.readManagedPage(pageFirstFixture.projectKey, 'candidate', undefined, 1, null,
        'synthetic-page-capacity')
      assert.equal(page.status, 'budget-exhausted')
      assert.equal(page.reason, 'managed-page-continuation-capacity',
        'page admission counts proof continuations already retained')
      const extraProof = reader.resolveRoot(pageFirstFixture.projectKey, 'synthetic-proof-over-capacity')
      assert.equal(extraProof.status, 'budget-exhausted')
      assert.equal(extraProof.reason, 'managed-page-continuation-capacity')
      valueOf(reader.advance(false))
      assert.equal(reader.managedPageContinuations.size, 0)
      assert.equal(reader.managedProofContinuations.size, 0)
      assert.ok(pageFirstFixture.manager.stats().accountedBytes <= accountedBefore,
        'advance(false) releases the retained proof-context lease')
    } finally { pageFirstFixture.close() }

    const proofFirstFixture = createFixture()
    try {
      const reader = valueOf(proofFirstFixture.openReader())
      const accountedBefore = proofFirstFixture.manager.stats().accountedBytes
      reader.proveRoot = () => failure('budget-exhausted', 'persona-call-headroom')
      for (let index = 0; index < 63; index += 1) {
        const proof = reader.resolveRoot(proofFirstFixture.projectKey, `synthetic-proof-continuation-${index}`)
        assert.equal(proof.status, 'budget-exhausted')
        assert.equal(proof.reason, 'persona-call-headroom')
      }
      const candidate = proofFirstFixture.store.addMemory({
        content: 'Synthetic candidate for combined continuation admission.', status: 'candidate',
      }).record
      reader.resolveManagedPageItem = (_projectKey, _status, memoryId) => memoryId === candidate.id
        ? failure('budget-exhausted', 'persona-call-headroom')
        : failure('unavailable-probe', 'unexpected-managed-page-item')
      const page = reader.readManagedPage(proofFirstFixture.projectKey, 'candidate', undefined, 1, null,
        'synthetic-page-capacity')
      assert.equal(page.status, 'budget-exhausted')
      assert.equal(page.reason, 'persona-call-headroom')
      assert.equal(reader.managedPageContinuations.size + reader.managedProofContinuations.size, 64,
        'a page continuation fills the shared bound after proof continuations')
      const extraProof = reader.resolveRoot(proofFirstFixture.projectKey, 'synthetic-proof-over-capacity')
      assert.equal(extraProof.status, 'budget-exhausted')
      assert.equal(extraProof.reason, 'managed-page-continuation-capacity',
        'direct proof admission counts a retained page continuation')
      valueOf(reader.advance(false))
      assert.equal(reader.managedPageContinuations.size, 0)
      assert.equal(reader.managedProofContinuations.size, 0)
      assert.ok(proofFirstFixture.manager.stats().accountedBytes <= accountedBefore,
        'advance(false) releases page and proof continuation leases')
    } finally { proofFirstFixture.close() }
  } finally {
    fixture.close()
  }
})

test('invalid temporal precision and basis stay unresolved in managed and revision projections', () => {
  const fixture = createFixture()
  try {
    const candidate = fixture.store.addMemory({
      content: 'Synthetic candidate with invalid temporal metadata.', status: 'candidate',
    }).record
    fixture.store.db.prepare('UPDATE l1_memories SET valid_from_precision = ?, valid_from_basis = ? WHERE id = ?')
      .run('invalid-precision', 'invalid-basis', candidate.id)

    const approved = addApproved(fixture.store, 'Synthetic approved memory with invalid revision temporal metadata.')
    fixture.store.db.prepare(`UPDATE l1_revisions SET valid_from_precision = ?, valid_from_basis = ?
      WHERE memory_id = ? AND revision = ?`)
      .run('invalid-precision', 'invalid-basis', approved.id, approved.revision)

    const reader = valueOf(fixture.openReader())
    const page = valueOf(reader.readManagedPage(fixture.projectKey, 'candidate', undefined, 15, null))
    const candidateItem = page.items.find((item) => item.id === candidate.id)
    assert.ok(candidateItem)
    assert.equal(candidateItem.state, 'unresolved')
    assert.equal(candidateItem.reason, 'managed-memory-metadata-invalid')
    assert.equal(candidateItem.summary, undefined)

    const root = valueOf(reader.resolveRoot(fixture.projectKey, approved.id))
    assert.equal(root.state, 'unresolved')
    assert.equal(root.reason, 'revision-metadata-invalid')
    assert.equal(root.record, undefined)
  } finally {
    fixture.close()
  }
})

test('runtime binding validation never opens an unopened project and expired wrappers are reaped across repeated opens', () => {
  const unopenedRoot = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-visibility-unopened-'))
  let unopenedStore
  let unopenedRuntime
  try {
    const project = { key: PROJECT_KEY, name: 'visibility project', cwd: process.cwd() }
    unopenedStore = openProjectStore(unopenedRoot, PROJECT_KEY, project)
    addApproved(unopenedStore, 'Synthetic persisted project not yet opened by the runtime.')
    unopenedStore.close()
    unopenedStore = undefined
    unopenedRuntime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ capture: { enabled: false }, extraction: { enabled: false } }), unopenedRoot)
    const unopened = unopenedRuntime.beginDashboardVisibilityRead(makeBinding([PROJECT_KEY, 'second-unopened-project']))
    assert.equal(unopened.status, 'unavailable-probe')
    assert.equal(unopenedRuntime.stores.size, 0, 'a persisted project is not opened as a side effect of a read binding')
    let getterCalls = 0
    const malformed = makeBinding([PROJECT_KEY])
    Object.defineProperty(malformed, 'policyKey', { enumerable: true, configurable: true,
      get() { getterCalls += 1; return POLICY_KEY } })
    assert.equal(unopenedRuntime.beginDashboardVisibilityRead(malformed).status, 'unavailable-probe')
    assert.equal(getterCalls, 0, 'binding data properties are validated without invoking accessors')
    assert.equal(unopenedRuntime.stores.size, 0)
  } finally {
    unopenedRuntime?.close()
    unopenedStore?.close()
    rmSync(unopenedRoot, { recursive: true, force: true })
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-visibility-reap-'))
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let monotonicNow = 0
  let store
  let runtime
  try {
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => monotonicNow })
    const project = { key: PROJECT_KEY, name: 'visibility project', cwd: process.cwd() }
    store = openProjectStore(root, PROJECT_KEY, project)
    const record = addApproved(store, 'Synthetic memory used for TTL wrapper cleanup.')
    store.close()
    store = undefined
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ capture: { enabled: false }, extraction: { enabled: false } }), root)
    runtime.dashboardStores()
    let prior
    for (let index = 0; index < 5; index += 1) {
      if (prior !== undefined) monotonicNow += 15_001
      const current = valueOf(runtime.beginDashboardVisibilityRead(makeBinding([PROJECT_KEY])))
      assert.equal(runtime.dashboardVisibilityReaders.size, 1, 'stale reader wrappers are removed before another open')
      assert.equal(runtime.dashboardReadSessions.stats().sessions, 1)
      if (prior !== undefined) assert.equal(prior.resolveRoot(PROJECT_KEY, record.id).status, 'stale')
      assert.equal(valueOf(current.resolveRoot(PROJECT_KEY, record.id)).state, 'visible')
      prior = current
    }
  } finally {
    runtime?.close()
    store?.close()
    if (ownNow === undefined) delete performance.now
    else Object.defineProperty(performance, 'now', ownNow)
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed scene page resumes after a hidden member and reaches the following scene', () => {
  const fixture = createFixture()
  try {
    const evidenceA = fixture.store.recordL0({ sessionId: 'scene-fence-a', role: 'user',
      content: 'Synthetic evidence for hidden scene A.' })
    const hidden = addApproved(fixture.store, 'Hidden scene A member.', { scene: 'a-hidden', sourceMessageIds: [evidenceA] })
    addApproved(fixture.store, 'Visible scene B member.', { scene: 'b-visible' })
    fixture.store.refreshScenes()
    fixture.control.appendControl({ eventId: `forget:${fixture.projectKey}:${hidden.id}`,
      projectKey: fixture.projectKey, type: 'forget', memoryId: hidden.id })
    const reader = valueOf(fixture.openReader())
    const page = valueOf(reader.readManagedScenePage(fixture.projectKey, undefined, 6))
    assert.deepEqual(page.items.map((item) => item.name), ['a-hidden', 'b-visible'])
    assert.equal(page.items[0].state, 'hidden')
    assert.equal(page.items[0].summary, undefined)
    assert.equal(page.items[0].summaryComplete, false)
    assert.equal(page.items[1].state, 'visible')
    assert.equal(page.items[1].summary, 'Visible scene B member.')
    assert.equal(page.items[1].memoryCount, 1)
    assert.equal(page.hasMore, false)

    const retryReader = valueOf(fixture.openReader())
    const proveManagedSceneMember = retryReader.proveManagedSceneMember.bind(retryReader)
    retryReader.proveManagedSceneMember = () => failure('budget-exhausted', 'persona-call-headroom')
    const blocked = retryReader.readManagedScenePage(fixture.projectKey, undefined, 6)
    assert.equal(blocked.status, 'budget-exhausted')
    assert.equal(blocked.reason, 'persona-call-headroom')
    assert.equal(blocked.value, undefined, 'scene proof headroom cannot expose a later keyset cursor')
    assert.ok(retryReader.remainingReadWorkBreakdown(), 'call-local scene headroom leaves the reader available to retry')
    retryReader.proveManagedSceneMember = proveManagedSceneMember
    const retried = valueOf(retryReader.readManagedScenePage(fixture.projectKey, undefined, 6))
    assert.deepEqual(retried.items.map((item) => item.name), ['a-hidden', 'b-visible'])
    assert.equal(retried.hasMore, false)
  } finally { fixture.close() }
})


test('scene final proof rejects a lost memo proof before releasing the summary', () => {
  const fixture = createFixture()
  try {
    addApproved(fixture.store, 'Scene memo loss member one.', { scene: 'memo-loss-scene' })
    addApproved(fixture.store, 'Scene memo loss member two.', { scene: 'memo-loss-scene' })
    fixture.store.refreshScenes()
    const reader = valueOf(fixture.openReader())
    const meta = valueOf(reader.readManagedSceneMetaPage(fixture.projectKey, undefined, 1))
    const row = meta.rows[0]
    assert.ok(row)
    assert.equal(row.name, 'memo-loss-scene')
    const page = valueOf(reader.readManagedSceneMembers(fixture.projectKey, row.name, undefined, 15))
    assert.ok(page.rows.length >= 2)
    for (const member of page.rows) {
      assert.equal(valueOf(reader.proveManagedSceneMember(fixture.projectKey, member.memoryId, member.revision)), 'visible')
    }
    const expected = { name: row.name, memoryCount: row.memoryCount, updatedAt: row.updatedAt,
      summaryBytes: row.summaryBytes, summaryComplete: row.summaryComplete, memberCount: page.rows.length,
      memberDigest: dashboardSceneMemberDigest(page.rows) }
    const visible = valueOf(reader.readManagedSceneFinal(fixture.projectKey, expected))
    assert.equal(visible.state, 'visible')
    assert.equal(typeof visible.summary, 'string')
    reader.memoProofStateLost = true
    const lost = valueOf(reader.readManagedSceneFinal(fixture.projectKey, expected))
    assert.equal(lost.state, 'unresolved')
    assert.equal(lost.reason, 'scene-proof-cache-lost')
    assert.equal(lost.summary, undefined)
  } finally { fixture.close() }
})

test('scene member reader carries a bounded overlong identity sentinel instead of dropping it', () => {
  const fixture = createFixture()
  try {
    const base = addApproved(fixture.store, 'Scene member reader base.', { scene: 'reader-long-member-scene' })
    fixture.store.refreshScenes()
    const normal = addApproved(fixture.store, 'Reader scene member after sentinel.', { scene: 'reader-long-member-scene' })
    fixture.store.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
      VALUES (?, ?, ?, ?, ?)`).run(fixture.projectKey, 'reader-long-member-scene', 'y'.repeat(300), base.revision, 1)
    fixture.store.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
      VALUES (?, ?, ?, ?, ?)`).run(fixture.projectKey, 'reader-long-member-scene', normal.id, normal.revision, 2)
    const reader = valueOf(fixture.openReader())
    const first = valueOf(reader.readManagedSceneMembers(fixture.projectKey, 'reader-long-member-scene', undefined, 1))
    assert.equal(first.rows.length, 1)
    assert.equal(first.rows[0].memoryId, base.id)
    assert.equal(first.hasMore, true)
    const page = valueOf(reader.readManagedSceneMembers(fixture.projectKey, 'reader-long-member-scene', first.rows[0].ordinal, 1))
    assert.equal(page.rows.length, 1)
    const malformed = page.rows[0]
    assert.equal(malformed.memoryId, undefined)
    assert.equal(malformed.memoryIdBytes, 300)
    assert.equal(malformed.ordinal, 1)
    assert.equal(page.hasMore, true)
    const after = valueOf(reader.readManagedSceneMembers(fixture.projectKey, 'reader-long-member-scene', malformed.ordinal, 1))
    assert.equal(after.rows.length, 1)
    assert.equal(after.rows[0].memoryId, normal.id)
    assert.equal(after.hasMore, false)
    assert.equal(page.rows.some((row) => row.memoryId === 'y'.repeat(300)), false)
  } finally { fixture.close() }
})

test('scene source revocation hides the current member without releasing its summary', () => {
  const fixture = createFixture()
  try {
    const source = fixture.store.recordL0({ sessionId: 'scene-revoke-source', role: 'user',
      content: 'Synthetic scene source that will be revoked.' })
    addApproved(fixture.store, 'Scene source revocation member.', { scene: 'revoked-scene', sourceMessageIds: [source] })
    fixture.store.refreshScenes()
    fixture.control.revokeSourceEvent(fixture.projectKey, 'scene-revoked-source-event', source)
    const reader = valueOf(fixture.openReader())
    const page = valueOf(reader.readManagedScenePage(fixture.projectKey, undefined, 6))
    const item = page.items.find((candidate) => candidate.name === 'revoked-scene')
    assert.ok(item)
    assert.equal(item.state, 'hidden')
    assert.equal(item.summary, undefined)
    assert.equal(item.summaryComplete, false)
  } finally { fixture.close() }
})

test('scene natural TTL retires the old reader and a fresh reader hides the member', () => {
  const fixture = createFixture()
  try {
    let now = Date.now()
    const record = addApproved(fixture.store, 'Scene natural TTL member.', { scene: 'ttl-scene' })
    fixture.store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(now + 1_000, record.id)
    fixture.store.refreshScenes()
    const oldReader = valueOf(fixture.openReader({ wallNow: () => now }))
    const first = valueOf(oldReader.readManagedScenePage(fixture.projectKey, undefined, 6))
    assert.equal(first.items.find((item) => item.name === 'ttl-scene')?.state, 'visible')
    now += 1_001
    const expired = oldReader.readManagedScenePage(fixture.projectKey, undefined, 6)
    assert.equal(expired.status, 'stale')
    assert.equal(expired.reason, 'visibility-proof-expired-at-rpc-boundary')
    assert.equal(expired.value, undefined)
    assert.equal(fixture.manager.stats().sessions, 0)
    assert.equal(fixture.manager.stats().activeCalls, 0)
    const fresh = valueOf(fixture.openReader({ wallNow: () => now }))
    const page = valueOf(fresh.readManagedScenePage(fixture.projectKey, undefined, 6))
    const item = page.items.find((candidate) => candidate.name === 'ttl-scene')
    assert.ok(item)
    assert.equal(item.state, 'hidden')
    assert.equal(item.summary, undefined)
    assert.equal(item.summaryComplete, false)
  } finally { fixture.close() }
})

test('scene revision mismatch is unresolved and never releases the old summary', () => {
  const fixture = createFixture()
  try {
    const first = addApproved(fixture.store, 'Scene revision mismatch first.', { scene: 'revision-scene' })
    addApproved(fixture.store, 'Scene revision mismatch second.', { scene: 'revision-scene' })
    fixture.store.refreshScenes()
    fixture.store.db.prepare(`UPDATE l2_scene_members SET revision = ? WHERE scene_name = 'revision-scene' AND memory_id = ?`)
      .run(first.revision + 999, first.id)
    fixture.store.db.prepare(`UPDATE l2_scenes SET summary_frontier_ready = 1 WHERE name = 'revision-scene'`).run()
    const reader = valueOf(fixture.openReader())
    const page = valueOf(reader.readManagedScenePage(fixture.projectKey, undefined, 6))
    const item = page.items.find((candidate) => candidate.name === 'revision-scene')
    assert.ok(item)
    assert.equal(item.state, 'unresolved')
    assert.equal(item.summary, undefined)
    assert.equal(item.summaryComplete, false)
  } finally { fixture.close() }
})

test('a full page of over-budget scene names still reaches the following normal scene', () => {
  const fixture = createFixture()
  try {
    for (let index = 0; index < 6; index += 1) {
      addApproved(fixture.store, `Long scene name member ${index}.`, { scene: `long-name-${index}-${'z'.repeat(510)}` })
    }
    addApproved(fixture.store, 'Following normal scene member.', { scene: 'normal-after-long-page' })
    fixture.store.refreshScenes()
    const reader = valueOf(fixture.openReader())
    const first = valueOf(reader.readManagedScenePage(fixture.projectKey, undefined, 6))
    assert.equal(first.items.length, 6)
    assert.equal(first.items.every((item) => item.state === 'unresolved' &&
      item.reason === 'scene-name-over-budget' && item.summary === undefined), true)
    assert.equal(first.hasMore, true)
    assert.ok(first.next)
    const second = valueOf(reader.readManagedScenePage(fixture.projectKey, first.next, 6))
    assert.deepEqual(second.items.map((item) => item.name), ['normal-after-long-page'])
    assert.equal(second.items[0].state, 'visible')
    assert.equal(typeof second.items[0].summary, 'string')
    assert.equal(second.hasMore, false)
  } finally { fixture.close() }
})

// ---------------------------------------------------------------------------
// S4-A enumerated directory member label capability
// ---------------------------------------------------------------------------

test('enumerated directory labels expose a fixed key/name only and never grant body reads', () => {
  const fixture = createFixture()
  let opened = 0
  let released = 0
  try {
    fixture.store.setProjectMeta({ key: PROJECT_KEY, name: '友好标签 项目', cwd: fixture.root })
    const labelDirectory = path.join(fixture.projectsRoot, 'projects')
    const reader = valueOf(DashboardVisibilityReadSession.open({
      manager: fixture.manager,
      control: fixture.control,
      stores: new Map(),
      binding: makeBinding([]),
      openDirectoryMember(projectKey) {
        const member = openProjectStoreReadOnly(fixture.projectsRoot, projectKey)
        opened += 1
        return { status: 'ok', value: { store: member, release() {
          released += 1
          try { member.close() } catch { /* synthetic teardown */ }
        } } }
      },
    }))
    const scopeReadId = randomUUID()
    const capability = valueOf(reader.createDirectoryLabelReader({
      readId: scopeReadId, directory: labelDirectory, marker: 'synthetic-marker',
    }))
    assert.equal(capability.readId, scopeReadId, 'the capability is bound to the directory readId')
    assert.equal(capability.directory, labelDirectory)
    assert.equal(capability.marker, 'synthetic-marker')
    const duplicate = reader.createDirectoryLabelReader({ readId: scopeReadId, directory: labelDirectory, marker: 'synthetic-marker' })
    assert.equal(duplicate.status, 'unavailable-probe')
    assert.equal(duplicate.reason, 'directory-label-reader-exists')
    valueOf(capability.enumerate([PROJECT_KEY]))
    const unenumerated = capability.readLabels(['not-enumerated-key'])
    assert.equal(unenumerated.status, 'unavailable-probe')
    assert.equal(unenumerated.reason, 'directory-label-key-unenumerated')
    const labels = valueOf(capability.readLabels([PROJECT_KEY]))
    assert.deepEqual(labels, [{
      key: PROJECT_KEY, name: '友好标签 项目',
      nameBytes: Buffer.byteLength('友好标签 项目', 'utf8'), proven: true,
    }])
    assert.equal(opened, 1)
    assert.equal(typeof capability.readProject, 'undefined', 'the capability exposes no body method')
    assert.equal(typeof capability.resolveRoot, 'undefined')
    assert.equal(typeof capability.readManagedPage, 'undefined')
    assert.equal(reader.readProject(PROJECT_KEY,
      { sqlStatements: 1, rowsVisited: 1, materializedBytes: 0, keyBytes: 0 }, () => 'body').status,
    'unavailable-probe', 'the immutable body binding still rejects the enumerated key')
    assert.equal(reader.resolveRoot(PROJECT_KEY, 'memory-1').status, 'unavailable-probe')
    assert.equal(reader.readManagedPage(PROJECT_KEY, 'approved').status, 'unavailable-probe')
    // The same live connection must still report the recorded name/version
    // immediately before publication.
    fixture.store.setProjectMeta({ key: PROJECT_KEY, name: 'changed after label read', cwd: fixture.root })
    const recheck = capability.verifyLabels([PROJECT_KEY])
    assert.equal(recheck.status, 'stale')
    assert.equal(recheck.reason, 'directory-member-changed')
    capability.release()
    assert.equal(released, 1, 'release closes the owned member connection exactly once')
    valueOf(reader.cancel())
  } finally {
    fixture.close()
  }
})

test('a directory label capability is refused on a body scope or without a trusted member opener', () => {
  const fixture = createFixture()
  try {
    const labelDirectory = path.join(fixture.projectsRoot, 'projects')
    const bodyReader = valueOf(fixture.openReader())
    const bodyScope = bodyReader.createDirectoryLabelReader({ readId: randomUUID(), directory: labelDirectory, marker: 'm' })
    assert.equal(bodyScope.status, 'unavailable-probe')
    assert.equal(bodyScope.reason, 'directory-label-scope-invalid')
    valueOf(bodyReader.cancel())

    const noOpener = valueOf(DashboardVisibilityReadSession.open({
      manager: fixture.manager, control: fixture.control, stores: new Map(), binding: makeBinding([]),
    }))
    const refused = noOpener.createDirectoryLabelReader({ readId: randomUUID(), directory: labelDirectory, marker: 'm' })
    assert.equal(refused.status, 'unavailable-probe')
    assert.equal(refused.reason, 'directory-member-opener-missing')
    valueOf(noOpener.cancel())
  } finally {
    fixture.close()
  }
})

// ---------------------------------------------------------------------------
// S4-A turn1 repair: real open accounting, pending ownership, identity proof
// ---------------------------------------------------------------------------

function openLabelSession(fixture, { wallNow, openDirectoryMember } = {}) {
  const labelDirectory = path.join(fixture.projectsRoot, 'projects')
  const reader = valueOf(DashboardVisibilityReadSession.open({
    manager: fixture.manager,
    control: fixture.control,
    stores: new Map(),
    binding: makeBinding([]),
    ...(wallNow === undefined ? {} : { wallNow }),
    openDirectoryMember: openDirectoryMember ?? ((projectKey) => {
      const member = openProjectStoreReadOnly(fixture.projectsRoot, projectKey)
      return { status: 'ok', value: { store: member, release() { try { member.close() } catch { /* synthetic teardown */ } } } }
    }),
  }))
  const capability = valueOf(reader.createDirectoryLabelReader({
    readId: randomUUID(), directory: labelDirectory, marker: 'synthetic-marker',
  }))
  valueOf(capability.enumerate([PROJECT_KEY]))
  return { reader, capability, labelDirectory }
}

test('a real read-only member label charges its five constructor statements and twelve rows before publication', () => {
  const fixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 13 } } } })
  try {
    fixture.store.setProjectMeta({ key: PROJECT_KEY, name: 'Charged label', cwd: fixture.root })
    const { reader, capability } = openLabelSession(fixture)
    const before = valueOf(fixture.manager.counters(reader.callToken))
    const labels = valueOf(capability.readLabels([PROJECT_KEY]))
    assert.equal(labels[0].name, 'Charged label')
    assert.equal(labels[0].proven, true)
    const opened = valueOf(fixture.manager.counters(reader.callToken))
    const keyBytes = Buffer.byteLength(PROJECT_KEY, 'utf8')
    assert.equal(opened.call.sqlStatements - before.call.sqlStatements, 8,
      'five read-only constructor statements plus one label and two version statements')
    assert.equal(opened.call.rowsVisited - before.call.rowsVisited, 15,
      'user_version 1 + table lookup 10 + schema_version 1 + label 1 + version 2 rows')
    assert.equal(opened.call.materializedBytes - before.call.materializedBytes, 3840,
      'open/label/version materialization plus the resident lease')
    assert.equal(opened.call.keyBytes - before.call.keyBytes, 512 + keyBytes,
      'conservative constructor key bound plus the project-key lookup')
    valueOf(capability.verifyLabels([PROJECT_KEY]))
    const verified = valueOf(fixture.manager.counters(reader.callToken))
    assert.equal(verified.call.sqlStatements - opened.call.sqlStatements, 3)
    assert.equal(verified.call.rowsVisited - opened.call.rowsVisited, 3)
    assert.equal(verified.call.materializedBytes - opened.call.materializedBytes, 768)
    assert.equal(verified.call.keyBytes - opened.call.keyBytes, keyBytes)
    valueOf(reader.cancel())
  } finally {
    fixture.close()
  }
})

test('a real member open that fits the call budget fails closed before publication when its verify does not', () => {
  const fixture = createFixture({ managerOptions: { limits: { perCall: { sqlStatements: 10 } } } })
  try {
    fixture.store.setProjectMeta({ key: PROJECT_KEY, name: 'Boundary label', cwd: fixture.root })
    const { reader, capability } = openLabelSession(fixture)
    const labels = valueOf(capability.readLabels([PROJECT_KEY]))
    assert.equal(labels[0].proven, true, 'the charged eight-statement open fits exactly')
    const verify = capability.verifyLabels([PROJECT_KEY])
    assert.equal(verify.status, 'budget-exhausted', 'the pre-publication recheck is not silently free')
    assert.equal(verify.reason, 'work-limit')
    const counters = valueOf(fixture.manager.counters(reader.callToken))
    assert.equal(counters.call.sqlStatements, 10, 'the label open itself is fully charged')
    valueOf(reader.cancel())
    assert.equal(fixture.manager.stats().sessions, 0)
  } finally {
    fixture.close()
  }
})

test('a member connection opened inside the label callback is released exactly once when the call TTL expires before registration', () => {
  let monotonic = 0
  const fixture = createFixture({ managerOptions: { monotonicNow: () => monotonic } })
  let openedCount = 0
  let releasedCount = 0
  try {
    fixture.store.setProjectMeta({ key: PROJECT_KEY, name: 'TTL pending handle', cwd: fixture.root })
    const { capability } = openLabelSession(fixture, {
      openDirectoryMember(projectKey) {
        const member = openProjectStoreReadOnly(fixture.projectsRoot, projectKey)
        openedCount += 1
        monotonic += 16_000
        return { status: 'ok', value: { store: member, release() {
          releasedCount += 1
          try { member.close() } catch { /* synthetic teardown */ }
        } } }
      },
    })
    const result = capability.readLabels([PROJECT_KEY])
    assert.equal(result.status, 'expired', 'the post-callback TTL expiry discards the unregistered result')
    assert.equal(openedCount, 1)
    assert.equal(releasedCount, 1, 'the newly opened connection is released although it was never registered')
    assert.equal(fixture.manager.stats().sessions, 0)
    assert.equal(fixture.manager.stats().activeCalls, 0)
    assert.ok(fixture.manager.stats().accountedBytes <= 128, 'the session resident bytes, including the member lease, are released')
  } finally {
    fixture.close()
  }
})

test('a member connection opened before an invalid wall clock is released exactly once and the session retires', () => {
  let wall = 1_000
  let invalid = false
  const fixture = createFixture()
  let openedCount = 0
  let releasedCount = 0
  try {
    fixture.store.setProjectMeta({ key: PROJECT_KEY, name: 'Clock pending handle', cwd: fixture.root })
    const { capability } = openLabelSession(fixture, {
      wallNow: () => {
        if (invalid) throw new Error('synthetic wall clock unavailable')
        wall += 1
        return wall
      },
      openDirectoryMember(projectKey) {
        const member = openProjectStoreReadOnly(fixture.projectsRoot, projectKey)
        openedCount += 1
        invalid = true
        return { status: 'ok', value: { store: member, release() {
          releasedCount += 1
          try { member.close() } catch { /* synthetic teardown */ }
        } } }
      },
    })
    const result = capability.readLabels([PROJECT_KEY])
    assert.equal(result.status, 'unavailable-probe')
    assert.equal(result.reason, 'visibility-wall-clock-invalid')
    assert.equal(openedCount, 1)
    assert.equal(releasedCount, 1)
    assert.equal(fixture.manager.stats().sessions, 0)
    assert.ok(fixture.manager.stats().accountedBytes <= 128, 'the session resident bytes, including the member lease, are released')
  } finally {
    fixture.close()
  }
})

test('the separate recent capability requires the exact additive index and never falls back', () => {
  const fixture = createFixture()
  try {
    const first = addApproved(fixture.store, 'Synthetic recent first.')
    const second = addApproved(fixture.store, 'Synthetic recent second.')
    // Pin a tied updated_at so the keyset is decided by id DESC, not insertion order.
    fixture.store.db.prepare('UPDATE l1_memories SET updated_at = ? WHERE project_key = ? AND id IN (?, ?)')
      .run(1_000, PROJECT_KEY, first.id, second.id)
    const reader = valueOf(fixture.openReader())
    let scopeProbes = 0
    const probeAllScopes = reader.probeAllScopes.bind(reader)
    reader.probeAllScopes = (...args) => {
      scopeProbes += 1
      return probeAllScopes(...args)
    }
    const page = valueOf(reader.readRecentManagedPage(PROJECT_KEY, undefined, 1, 1024))
    assert.equal(page.items.length, 1)
    assert.ok(page.nextCursor)
    assert.ok(scopeProbes > 0, 'public recent reads retain immediate scope validation')
    const directScopeProbes = scopeProbes
    const next = valueOf(readDashboardRecentManagedPageForAggregate(reader, PROJECT_KEY, page.nextCursor, 1, 1024))
    assert.equal(next.items.length, 1)
    assert.equal(scopeProbes, directScopeProbes,
      'only the private aggregate page defers repeated scope probes to the enclosing RPC boundary')
    const pageIds = [page.items[0].record?.id, next.items[0].record?.id]
    assert.equal(new Set(pageIds).size, 2, 'the recent keyset returns both tied rows without repetition')
    assert.deepEqual([...pageIds].sort(), [first.id, second.id].sort(), 'both ids are the real inserted rows')
    fixture.store.db.exec('DROP INDEX l1_status_updated_page')
    const missing = reader.readRecentManagedPage(PROJECT_KEY, undefined, 1, 1024)
    assert.equal(missing.status, 'unavailable-probe')
    assert.equal(missing.reason, 'recent-index-missing')
  } finally {
    fixture.close()
  }
})
