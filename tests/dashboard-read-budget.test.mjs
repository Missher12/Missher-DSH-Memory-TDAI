import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { ControlLedger } from '../lib/control.js'
import { DashboardReadSessionManager } from '../lib/dashboard-read.js'
import { MemoryRuntime } from '../lib/memory.js'
import { MemoryStore, openProjectStoreReadOnly } from '../lib/store.js'

function limits(overrides = {}) {
  return {
    idleMilliseconds: overrides.idleMilliseconds ?? 15_000,
    absoluteMilliseconds: overrides.absoluteMilliseconds ?? 60_000,
    maxContinuations: overrides.maxContinuations ?? 16,
    perCall: { sqlStatements: 64, rowsVisited: 2048, materializedBytes: 1024 * 1024, keyBytes: 64 * 1024, projects: 4,
      ...overrides.perCall },
    perSession: { sqlStatements: 512, rowsVisited: 32_768, materializedBytes: 8 * 1024 * 1024, keyBytes: 256 * 1024,
      projects: 16, continuations: 16, ...overrides.perSession },
  }
}

function binding(overrides = {}) {
  return {
    generationId: 'gen-1-0123456789ab',
    policyKey: 'a'.repeat(64),
    filterKey: 'b'.repeat(64),
    asOf: Date.UTC(2026, 9, 24, 12),
    viewKey: 'overview',
    projectKeys: [],
    ...overrides,
  }
}

function zeroCost(overrides = {}) {
  return { sqlStatements: 0, rowsVisited: 0, materializedBytes: 0, keyBytes: 0, ...overrides }
}

function controlledClock(start = 0) {
  let current = start
  return {
    now: () => current,
    set(value) { current = value },
    advance(value) { current += value },
  }
}

function managerFor(clock = controlledClock(), configuredLimits = limits()) {
  const manager = new DashboardReadSessionManager({ monotonicNow: clock.now, limits: configuredLimits })
  return { manager, clock }
}

function valueOf(outcome) {
  assert.equal(outcome.status, 'ok', `expected success, received ${outcome.status}: ${outcome.reason ?? ''}`)
  return outcome.value
}

function controlSource() {
  const connectionId = randomUUID()
  return {
    dashboardReadVersion() {
      return { scope: 'control', connectionId, dataVersion: 1, totalChanges: 0, writerEpoch: 1, observedWriterEpoch: 1 }
    },
  }
}

function projectSource() {
  const connectionId = randomUUID()
  return { dashboardReadVersion() { return { scope: 'project', connectionId, dataVersion: 1, totalChanges: 0 } } }
}

function startRead(manager, readBinding, sources = {}) {
  const callToken = valueOf(manager.begin(readBinding)).callToken
  const control = manager.probeControl(callToken, sources.control ?? controlSource())
  assert.equal(control.status, 'ok', `control probe failed: ${control.reason ?? ''}`)
  const projectStamps = new Map()
  for (const projectKey of readBinding.projectKeys) {
    const result = manager.probeProject(callToken, projectKey, sources.projects?.get(projectKey) ?? projectSource())
    assert.equal(result.status, 'ok', `project probe failed: ${result.reason ?? ''}`)
    projectStamps.set(projectKey, result.value)
  }
  return { callToken, controlStamp: control.value, projectStamps }
}

function reserveSessionToResidentCap(manager, readBinding, control) {
  const mib = 1024 * 1024
  const cap = 4 * mib
  let callToken = startRead(manager, readBinding, { control }).callToken
  for (let page = 0; page < 3; page += 1) {
    assert.equal(manager.reserveResident(callToken, 'cache', mib).status, 'ok')
    const continuation = valueOf(manager.finish(callToken, true)).continuationToken
    callToken = valueOf(manager.continue(continuation, readBinding)).callToken
    assert.equal(manager.probeControl(callToken, control).status, 'ok')
  }
  const current = valueOf(manager.counters(callToken)).sessionAccountedBytes
  const finalBytes = cap - current - 64
  assert.ok(finalBytes > 0 && finalBytes < mib, 'the final accounting-only reservation fits one per-call byte allowance')
  const finalReservation = valueOf(manager.reserveResident(callToken, 'cache', finalBytes)).reservationToken
  assert.equal(valueOf(manager.counters(callToken)).sessionAccountedBytes, cap)
  return { callToken, finalReservation }
}

function rawSqliteProbe(file, repeatNumericPair = false) {
  const db = new DatabaseSync(file)
  const connectionId = randomUUID()
  let lastStamp
  return {
    get lastStamp() { return lastStamp },
    dashboardReadVersion() {
      const dataVersion = db.prepare('PRAGMA data_version').get().data_version
      const totalChanges = db.prepare('SELECT total_changes() AS total_changes').get().total_changes
      lastStamp = Object.freeze({ scope: 'project', connectionId,
        dataVersion: repeatNumericPair ? 7 : dataVersion,
        totalChanges: repeatNumericPair ? 0 : totalChanges })
      return lastStamp
    },
    close() { db.close() },
  }
}

test('one read call shares SQL and project budgets across helpers', () => {
  const oneProjectLimit = managerFor(controlledClock(), limits({ perCall: { projects: 1 } })).manager
  assert.equal(oneProjectLimit.begin(binding({ projectKeys: ['alpha', 'beta'] })).status, 'budget-exhausted',
    'a session cannot bind more project scopes than one call can version-check')
  assert.equal(oneProjectLimit.stats().sessions, 0)
  oneProjectLimit.close()

  const { manager } = managerFor(controlledClock(), limits({
    perCall: { sqlStatements: 10, projects: 2 },
    perSession: { sqlStatements: 12, projects: 4 },
  }))
  const readBinding = binding({ projectKeys: ['alpha', 'beta'] })
  const { callToken } = startRead(manager, readBinding)
  assert.equal(manager.run(callToken, zeroCost({ sqlStatements: 2, rowsVisited: 1 }), () => 'helper-a').status, 'ok')
  assert.equal(manager.run(callToken, zeroCost({ sqlStatements: 2, rowsVisited: 1 }), () => 'helper-b').status, 'ok')
  let thirdHelperRan = false
  const denied = manager.run(callToken, zeroCost({ sqlStatements: 1 }), () => { thirdHelperRan = true })
  assert.equal(denied.status, 'budget-exhausted')
  assert.equal(thirdHelperRan, false, 'preflight denies work before its callback executes')
  const counters = valueOf(manager.counters(callToken))
  assert.equal(counters.call.sqlStatements, 10, 'both project probes and helper work share the call allowance')
  assert.equal(counters.session.sqlStatements, 10)
  manager.finish(callToken, false)
  manager.close()
})

test('failed work stays charged and a one-use continuation cannot reset cumulative budget', () => {
  const { manager } = managerFor(controlledClock(), limits({
    perCall: { sqlStatements: 4 }, perSession: { sqlStatements: 6 },
  }))
  const readBinding = binding()
  const source = controlSource()
  const { callToken } = startRead(manager, readBinding, { control: source })
  assert.throws(() => manager.run(callToken, zeroCost({ sqlStatements: 2 }), () => { throw new Error('synthetic failure') }), /synthetic failure/u)
  assert.equal(valueOf(manager.counters(callToken)).session.sqlStatements, 4, 'the failed operation does not refund its reserved SQL cost')

  const continuationToken = valueOf(manager.finish(callToken, true)).continuationToken
  const nextCall = valueOf(manager.continue(continuationToken, readBinding)).callToken
  assert.equal(manager.continue(continuationToken, readBinding).status, 'stale', 'the continuation token is consumed once')
  assert.equal(manager.probeControl(nextCall, source).status, 'ok', 'the next page consumes its own probe budget')
  let retryRan = false
  const denied = manager.run(nextCall, zeroCost({ sqlStatements: 1 }), () => { retryRan = true })
  assert.equal(denied.status, 'budget-exhausted', 'the session counter survives the continuation')
  assert.equal(retryRan, false)
  assert.equal(valueOf(manager.counters(nextCall)).session.sqlStatements, 6)
  manager.finish(nextCall, false)
  const freshCall = startRead(manager, readBinding, { control: source }).callToken
  assert.equal(manager.run(freshCall, zeroCost({ sqlStatements: 1 }), () => 'fresh-read').status, 'ok',
    'a new bounded read starts with its own cumulative allowance after the prior read is retired')
  assert.equal(valueOf(manager.counters(freshCall)).session.sqlStatements, 3)
  manager.finish(freshCall, false)
  manager.close()
})

test('costs and immutable limits reject unsafe values; resident leases release on exceptions', () => {
  const configuredLimits = limits({
    perCall: { sqlStatements: 4, materializedBytes: 128, keyBytes: 1024 },
    perSession: { sqlStatements: 8, materializedBytes: 256, keyBytes: 4096 },
  })
  const { manager } = managerFor(controlledClock(), configuredLimits)
  configuredLimits.perCall.sqlStatements = 0
  assert.equal(manager.limits.perCall.sqlStatements, 4, 'the manager copied and froze its server limits')
  assert.throws(() => { manager.limits.perCall.sqlStatements = 0 }, TypeError)

  const { callToken } = startRead(manager, binding())
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => manager.run(callToken, zeroCost({ sqlStatements: invalid }), () => 'must not run'), RangeError)
  }

  const before = manager.stats().accountedBytes
  assert.throws(() => manager.withResident(callToken, 'cache', 64, () => { throw new Error('cache failure') }), /cache failure/u)
  assert.equal(manager.stats().accountedBytes, before, 'resident cache accounting is released in finally')
  assert.equal(valueOf(manager.counters(callToken)).session.materializedBytes, 64,
    'failed cache work remains in the cumulative budget after resident bytes are released')
  assert.equal(manager.withResident(callToken, 'key', 32, () => 'key').status, 'ok')
  assert.equal(manager.reserveResident(callToken, 'cache', 8 * 1024 * 1024).status, 'budget-exhausted')
  const snapshot = valueOf(manager.counters(callToken))
  assert.throws(() => { snapshot.session.sqlStatements = 999 }, TypeError)
  manager.finish(callToken, false)
  manager.close()
})

test('defaults use reviewed row and lifetime ceilings; stricter overrides work and looser ones fail', () => {
  const defaults = new DashboardReadSessionManager()
  assert.equal(defaults.limits.perCall.rowsVisited, 2048)
  assert.equal(defaults.limits.perSession.rowsVisited, 32_768)
  assert.equal(defaults.limits.idleMilliseconds, 15_000)
  assert.equal(defaults.limits.absoluteMilliseconds, 60_000)
  assert.equal(defaults.limits.perCall.sqlStatements, 64)
  assert.equal(defaults.limits.perCall.materializedBytes, 1024 * 1024)
  defaults.close()

  const strict = new DashboardReadSessionManager({ limits: limits({
    idleMilliseconds: 5000,
    absoluteMilliseconds: 20_000,
    perCall: { rowsVisited: 128 },
    perSession: { rowsVisited: 256 },
  }) })
  assert.equal(strict.limits.perCall.rowsVisited, 128)
  assert.equal(strict.limits.perSession.rowsVisited, 256)
  assert.equal(strict.limits.idleMilliseconds, 5000)
  assert.equal(strict.limits.absoluteMilliseconds, 20_000)
  strict.close()

  assert.throws(() => new DashboardReadSessionManager({ limits: limits({ perCall: { rowsVisited: 2049 } }) }), RangeError)
  assert.throws(() => new DashboardReadSessionManager({ limits: limits({ perSession: { rowsVisited: 32_769 } }) }), RangeError)
  assert.throws(() => new DashboardReadSessionManager({ limits: limits({ idleMilliseconds: 15_001 }) }), RangeError)
  assert.throws(() => new DashboardReadSessionManager({ limits: limits({ absoluteMilliseconds: 60_001 }) }), RangeError)
})

test('opaque continuation binding rejects another runtime and every changed read scope', () => {
  const first = managerFor().manager
  const readBinding = binding()
  const { callToken } = startRead(first, readBinding)
  const continuationToken = valueOf(first.finish(callToken, true)).continuationToken
  const otherRuntime = managerFor().manager
  assert.equal(otherRuntime.continue(continuationToken, readBinding).status, 'stale')
  const nextCall = valueOf(first.continue(continuationToken, readBinding)).callToken
  first.finish(nextCall, false)
  first.close()
  otherRuntime.close()

  const changedBindings = [
    { filterKey: 'c'.repeat(64) },
    { policyKey: 'd'.repeat(64) },
    { asOf: readBinding.asOf + 1 },
    { viewKey: 'library' },
    { generationId: 'gen-2-0123456789ab' },
    { projectKeys: ['different-project'] },
  ]
  for (const change of changedBindings) {
    const { manager } = managerFor()
    const current = binding({ projectKeys: change.projectKeys === undefined ? [] : ['project-a'] })
    const active = startRead(manager, current).callToken
    const token = valueOf(manager.finish(active, true)).continuationToken
    assert.equal(manager.continue(token, { ...current, ...change }).status, 'stale', `binding change ${Object.keys(change)[0]} invalidates the session`)
    assert.equal(manager.stats().sessions, 0)
    manager.close()
  }
})

test('version probes are budgeted, read-only, scope-separated, and stale on same- or other-connection writes', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-read-probe-'))
  const projectRoot = path.join(fixture, 'project')
  const controlRoot = path.join(fixture, 'control')
  mkdirSync(projectRoot, { recursive: true })
  let store
  let control
  try {
    store = new MemoryStore(path.join(projectRoot, 'memory.db'))
    control = new ControlLedger(controlRoot)
    const { manager } = managerFor()
    const readBinding = binding({ projectKeys: ['control'] })
    const sources = { control, projects: new Map([['control', store]]) }
    const first = startRead(manager, readBinding, sources)
    const repeatedControl = manager.probeControl(first.callToken, control)
    const repeatedProject = manager.probeProject(first.callToken, 'control', store)
    assert.equal(repeatedControl.status, 'ok', 'the project key "control" does not collide with the control-ledger scope')
    assert.equal(repeatedProject.status, 'ok')
    assert.equal(repeatedControl.value.connectionId, first.controlStamp.connectionId)
    assert.equal(repeatedProject.value.connectionId, first.projectStamps.get('control').connectionId)
    assert.equal(repeatedControl.value.totalChanges, first.controlStamp.totalChanges, 'the control probe performs no writes')
    assert.equal(repeatedProject.value.totalChanges, first.projectStamps.get('control').totalChanges, 'the project probe performs no writes')
    const probeCounters = valueOf(manager.counters(first.callToken))
    assert.equal(probeCounters.call.sqlStatements, 8, 'every two-statement probe is charged before execution')
    assert.equal(probeCounters.call.projects, 1)
    manager.finish(first.callToken, false)
    manager.close()

    const { manager: ownWriteManager } = managerFor()
    const ownRead = startRead(ownWriteManager, readBinding, sources)
    store.db.prepare("INSERT INTO meta(key, value) VALUES('u11-own-probe-write', '1')").run()
    assert.equal(ownWriteManager.probeProject(ownRead.callToken, 'control', store).status, 'stale',
      'total_changes detects writes from the observed project connection')
    ownWriteManager.close()

    const externalStore = new MemoryStore(path.join(projectRoot, 'external.db'))
    const { manager: externalManager } = managerFor()
    const externalBinding = binding({ projectKeys: ['external'] })
    const externalRead = startRead(externalManager, externalBinding, {
      control, projects: new Map([['external', externalStore]]),
    })
    const external = new DatabaseSync(externalStore.file)
    try { external.exec('CREATE TABLE s1_external_commit (id INTEGER)') }
    finally { external.close() }
    assert.equal(externalManager.probeProject(externalRead.callToken, 'external', externalStore).status, 'stale',
      'same-connection data_version detects a separately committed SQLite writer')
    externalManager.close()
    externalStore.close()

    const reopenFile = path.join(fixture, 'reopen.db')
    const seed = new DatabaseSync(reopenFile)
    seed.exec('CREATE TABLE s1_reopen_fixture (id INTEGER)')
    seed.close()
    const { manager: reopenManager } = managerFor()
    const reopenBinding = binding({ projectKeys: ['reopen'] })
    const oldHandle = rawSqliteProbe(reopenFile, true)
    const reopenRead = startRead(reopenManager, reopenBinding, {
      control, projects: new Map([['reopen', oldHandle]]),
    })
    const oldStamp = reopenRead.projectStamps.get('reopen')
    assert.ok(oldStamp)
    oldHandle.close()
    const reopenedHandle = rawSqliteProbe(reopenFile, true)
    const reopened = reopenManager.probeProject(reopenRead.callToken, 'reopen', reopenedHandle)
    assert.equal(reopenedHandle.lastStamp.dataVersion, oldStamp.dataVersion)
    assert.equal(reopenedHandle.lastStamp.totalChanges, oldStamp.totalChanges)
    assert.notEqual(reopenedHandle.lastStamp.connectionId, oldStamp.connectionId)
    assert.equal(reopened.status, 'stale', 'reopen identity fails closed even when numeric counters repeat')
    reopenedHandle.close()
    reopenManager.close()

    const { manager: writerManager } = managerFor()
    const writerRead = startRead(writerManager, binding(), { control }).callToken
    const externalControl = new DatabaseSync(control.file)
    try {
      externalControl.prepare("UPDATE meta SET value = ? WHERE key = 'writer_epoch'").run(String(control.writerEpoch + 1))
    } finally { externalControl.close() }
    assert.equal(writerManager.probeControl(writerRead, control).status, 'stale', 'a new control writer epoch invalidates the old ledger handle')
    writerManager.close()
  } finally {
    store?.close()
    control?.close()
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('probe stamps stay resident across finish and continuation without double charging', () => {
  const readBinding = binding({ projectKeys: ['alpha'] })
  const probed = managerFor().manager
  const sources = { control: controlSource(), projects: new Map([['alpha', projectSource()]]) }
  const firstCall = startRead(probed, readBinding, sources).callToken
  const firstToken = valueOf(probed.finish(firstCall, true)).continuationToken
  const accountedWithStamps = probed.stats().accountedBytes

  const unprobed = managerFor().manager
  const unprobedCall = valueOf(unprobed.begin(readBinding)).callToken
  const unprobedToken = valueOf(unprobed.finish(unprobedCall, true)).continuationToken
  const accountedWithoutStamps = unprobed.stats().accountedBytes
  const stampMetadataBytes = accountedWithStamps - accountedWithoutStamps
  assert.ok(stampMetadataBytes > 0, 'session-owned stamp and key metadata remain charged after finish(true)')

  const nextCall = valueOf(probed.continue(firstToken, readBinding)).callToken
  const nextUnprobedCall = valueOf(unprobed.continue(unprobedToken, readBinding)).callToken
  assert.equal(probed.stats().accountedBytes - unprobed.stats().accountedBytes, stampMetadataBytes,
    'continuation preserves the same session-owned stamp accounting')
  assert.equal(probed.probeControl(nextCall, sources.control).status, 'ok')
  assert.equal(probed.probeProject(nextCall, 'alpha', sources.projects.get('alpha')).status, 'ok')

  const secondToken = valueOf(probed.finish(nextCall, true)).continuationToken
  const secondUnprobedToken = valueOf(unprobed.finish(nextUnprobedCall, true)).continuationToken
  assert.equal(probed.stats().accountedBytes - unprobed.stats().accountedBytes, stampMetadataBytes,
    're-probing an existing scope does not add a second copy of its session metadata')
  probed.continue(secondToken, readBinding)
  unprobed.continue(secondUnprobedToken, readBinding)
  probed.close()
  unprobed.close()
})

test('failed first probes release only their provisional metadata, while failed re-probes retire the session', () => {
  const readBinding = binding({ projectKeys: ['alpha', 'beta'] })
  const { manager } = managerFor()
  const callToken = valueOf(manager.begin(readBinding)).callToken
  assert.equal(manager.probeControl(callToken, controlSource()).status, 'ok')
  assert.equal(manager.probeProject(callToken, 'alpha', projectSource()).status, 'ok')
  const residentWithExistingStamp = manager.stats().accountedBytes

  const throwsBeforeFirstStamp = { dashboardReadVersion() { throw new Error('probe unavailable') } }
  const thrown = manager.probeProject(callToken, 'beta', throwsBeforeFirstStamp)
  assert.equal(thrown.status, 'unavailable-probe')
  assert.equal(manager.stats().sessions, 1, 'an unprobed new scope remains unavailable and cannot be treated as unchanged')
  assert.equal(manager.stats().accountedBytes, residentWithExistingStamp,
    'throw cleanup does not subtract resident bytes belonging to alpha/control stamps')

  const invalidBeforeFirstStamp = { dashboardReadVersion() {
    return { scope: 'project', connectionId: 'not-a-uuid', dataVersion: 1, totalChanges: 0 }
  } }
  assert.equal(manager.probeProject(callToken, 'beta', invalidBeforeFirstStamp).status, 'unavailable-probe')
  assert.equal(manager.stats().accountedBytes, residentWithExistingStamp,
    'invalid-stamp cleanup releases only beta provisional metadata')

  const continuation = valueOf(manager.finish(callToken, true)).continuationToken
  const accountedAfterFailureFinish = manager.stats().accountedBytes
  const withoutStamps = managerFor().manager
  const baselineCall = valueOf(withoutStamps.begin(readBinding)).callToken
  const baselineToken = valueOf(withoutStamps.finish(baselineCall, true)).continuationToken
  const retainedStampBytes = accountedAfterFailureFinish - withoutStamps.stats().accountedBytes
  assert.ok(retainedStampBytes > 0, 'failed beta probes do not make finish release alpha/control session stamps')
  valueOf(manager.continue(continuation, readBinding))
  valueOf(withoutStamps.continue(baselineToken, readBinding))
  assert.equal(manager.stats().accountedBytes - withoutStamps.stats().accountedBytes, retainedStampBytes,
    'existing session stamps remain accounted after the failed call is continued')
  manager.close()
  withoutStamps.close()

  const repeatedFailures = [
    ['missing source', (source) => { source.dashboardReadVersion = undefined }, 'probe-source-missing'],
    ['throw', (source) => { source.dashboardReadVersion = () => { throw new Error('probe unavailable') } }, 'sqlite-probe-failed'],
    ['invalid stamp', (source) => { source.dashboardReadVersion = () => ({
      scope: 'control', connectionId: randomUUID(), dataVersion: 1, totalChanges: 0, writerEpoch: 0, observedWriterEpoch: 1,
    }) }, 'invalid-version-stamp'],
    ['async function', (source, stamp) => { source.dashboardReadVersion = async () => stamp }, 'async-probe-not-supported'],
    ['thenable', (source, stamp) => { source.dashboardReadVersion = () => Promise.resolve(stamp) }, 'async-probe-not-supported'],
  ]
  for (const [label, installFailure, reason] of repeatedFailures) {
    const failingManager = managerFor().manager
    const stamp = { scope: 'control', connectionId: randomUUID(), dataVersion: 1, totalChanges: 0,
      writerEpoch: 1, observedWriterEpoch: 1 }
    const source = { dashboardReadVersion() { return stamp } }
    const failingBinding = binding()
    const first = valueOf(failingManager.begin(failingBinding)).callToken
    assert.equal(failingManager.probeControl(first, source).status, 'ok')
    const continuation = valueOf(failingManager.finish(first, true)).continuationToken
    const next = valueOf(failingManager.continue(continuation, failingBinding)).callToken
    installFailure(source, stamp)
    const failedProbe = failingManager.probeControl(next, source)
    assert.equal(failedProbe.status, 'unavailable-probe', `${label} is not an unchanged stamp`)
    assert.equal(failedProbe.reason, reason)
    assert.equal(failingManager.stats().sessions, 0, `${label} after a successful probe retires the session`)
    let callbackRan = false
    assert.equal(failingManager.run(next, zeroCost(), () => { callbackRan = true }).status, 'unavailable-probe')
    assert.equal(callbackRan, false)
    assert.equal(failingManager.finish(next, true).status, 'unavailable-probe', 'failure cannot mint a continuation')
    assert.equal(failingManager.continue(continuation, failingBinding).status, 'stale', 'the prior one-use continuation cannot be replayed')
    failingManager.close()
  }
})

test('any denied re-probe of an accepted scope blocks cheap work and continuation', () => {
  const budgetLimits = limits({ perCall: { sqlStatements: 5 }, perSession: { sqlStatements: 5 } })
  const makeSource = () => {
    const connectionId = randomUUID()
    let reads = 0
    return {
      get reads() { return reads },
      dashboardReadVersion() {
        reads += 1
        return { scope: 'control', connectionId, dataVersion: 1, totalChanges: 0, writerEpoch: 1, observedWriterEpoch: 1 }
      },
    }
  }

  const perCall = managerFor(controlledClock(), budgetLimits).manager
  const perCallBinding = binding()
  const perCallSource = makeSource()
  const perCallToken = valueOf(perCall.begin(perCallBinding)).callToken
  assert.equal(perCall.probeControl(perCallToken, perCallSource).status, 'ok')
  assert.equal(perCall.run(perCallToken, zeroCost({ sqlStatements: 2 }), () => 'charged').status, 'ok')
  const deniedPerCall = perCall.probeControl(perCallToken, perCallSource)
  assert.equal(deniedPerCall.status, 'budget-exhausted')
  assert.equal(deniedPerCall.reason, 'work-limit')
  assert.equal(perCallSource.reads, 1, 'the denied re-probe never calls its version source')
  let cheapCallRan = false
  assert.equal(perCall.run(perCallToken, zeroCost({ sqlStatements: 1 }), () => { cheapCallRan = true }).status, 'budget-exhausted')
  assert.equal(cheapCallRan, false)
  assert.equal(perCall.finish(perCallToken, true).status, 'budget-exhausted', 'a failed re-probe cannot mint a continuation')
  assert.equal(perCall.stats().sessions, 0)
  perCall.close()

  const projectBudget = managerFor(controlledClock(), limits({ perCall: { sqlStatements: 7 } })).manager
  const projectBinding = binding({ projectKeys: ['alpha'] })
  const projectSource = (() => {
    const connectionId = randomUUID()
    let reads = 0
    return {
      get reads() { return reads },
      dashboardReadVersion() {
        reads += 1
        return { scope: 'project', connectionId, dataVersion: 1, totalChanges: 0 }
      },
    }
  })()
  const projectCall = startRead(projectBudget, projectBinding, {
    control: makeSource(),
    projects: new Map([['alpha', projectSource]]),
  }).callToken
  assert.equal(projectBudget.run(projectCall, zeroCost({ sqlStatements: 2 }), () => 'charged').status, 'ok',
    'the control and project probes charge four statements before the read')
  const deniedProjectProbe = projectBudget.probeProject(projectCall, 'alpha', projectSource)
  assert.equal(deniedProjectProbe.status, 'budget-exhausted')
  assert.equal(deniedProjectProbe.reason, 'work-limit')
  assert.equal(projectSource.reads, 1, 'the project re-probe exceeds the seven-statement call cap before source access')
  let projectCheapCallRan = false
  assert.equal(projectBudget.run(projectCall, zeroCost({ sqlStatements: 1 }), () => { projectCheapCallRan = true }).status,
    'budget-exhausted')
  assert.equal(projectCheapCallRan, false)
  assert.equal(projectBudget.finish(projectCall, true).status, 'budget-exhausted')
  assert.equal(projectBudget.stats().sessions, 0)
  projectBudget.close()

  const cumulative = managerFor(controlledClock(), budgetLimits).manager
  const cumulativeBinding = binding()
  const cumulativeSource = makeSource()
  const firstCall = valueOf(cumulative.begin(cumulativeBinding)).callToken
  assert.equal(cumulative.probeControl(firstCall, cumulativeSource).status, 'ok')
  assert.equal(cumulative.run(firstCall, zeroCost({ sqlStatements: 2 }), () => 'charged').status, 'ok')
  const priorContinuation = valueOf(cumulative.finish(firstCall, true)).continuationToken
  const nextCall = valueOf(cumulative.continue(priorContinuation, cumulativeBinding)).callToken
  const deniedCumulative = cumulative.probeControl(nextCall, cumulativeSource)
  assert.equal(deniedCumulative.status, 'budget-exhausted')
  assert.equal(deniedCumulative.reason, 'work-limit')
  cheapCallRan = false
  assert.equal(cumulative.run(nextCall, zeroCost({ sqlStatements: 1 }), () => { cheapCallRan = true }).status, 'budget-exhausted')
  assert.equal(cheapCallRan, false)
  assert.equal(cumulative.finish(nextCall, true).status, 'budget-exhausted')
  assert.equal(cumulative.continue(priorContinuation, cumulativeBinding).status, 'stale', 'the consumed continuation cannot be reused')
  cumulative.close()

  const softClock = controlledClock()
  const soft = managerFor(softClock).manager
  const softBinding = binding()
  const softSource = makeSource()
  const softCall = valueOf(soft.begin(softBinding)).callToken
  assert.equal(soft.probeControl(softCall, softSource).status, 'ok')
  softClock.set(100)
  const deniedSoft = soft.probeControl(softCall, softSource)
  assert.equal(deniedSoft.status, 'budget-exhausted')
  assert.equal(deniedSoft.reason, 'cooperative-soft-window')
  assert.equal(soft.run(softCall, zeroCost(), () => 'cheap').status, 'budget-exhausted')
  assert.equal(soft.finish(softCall, true).status, 'budget-exhausted')
  soft.close()
})

test('resident accounting enforces four MiB per session across continuations and keeps work spent on release', () => {
  const mib = 1024 * 1024
  const manager = managerFor(controlledClock(), limits({ perSession: { materializedBytes: 4 * mib } })).manager
  const readBinding = binding()
  const control = controlSource()
  const { callToken, finalReservation } = reserveSessionToResidentCap(manager, readBinding, control)
  const fullSnapshot = valueOf(manager.counters(callToken))
  assert.equal(fullSnapshot.sessionAccountedBytes, 4 * mib)
  const sessionWorkBeforeRelease = fullSnapshot.session.materializedBytes
  assert.equal(manager.reserveResident(callToken, 'cache', 1).status, 'budget-exhausted',
    'reservation overhead and existing call/probe/token metadata are included in the session cap')

  const secondCall = valueOf(manager.begin(binding({ viewKey: 'library' }))).callToken
  assert.equal(manager.stats().sessions, 2, 'a second bounded session remains admissible under the manager-wide cap')
  assert.ok(manager.stats().accountedBytes <= 8 * mib)

  assert.equal(manager.releaseResident(callToken, finalReservation).status, 'ok')
  const released = valueOf(manager.counters(callToken))
  assert.ok(released.sessionAccountedBytes < 4 * mib)
  assert.equal(released.session.materializedBytes, sessionWorkBeforeRelease,
    'releasing resident bytes does not refund cumulative materialization work')
  const continuation = valueOf(manager.finish(callToken, true)).continuationToken
  const nextCall = valueOf(manager.continue(continuation, readBinding)).callToken
  assert.equal(manager.probeControl(nextCall, control).status, 'ok')
  const workOverage = 4 * mib - sessionWorkBeforeRelease + 1
  assert.equal(manager.reserveResident(nextCall, 'cache', workOverage).status, 'budget-exhausted',
    'released resident capacity cannot replenish the exhausted cumulative work allowance')
  assert.equal(valueOf(manager.counters(nextCall)).session.materializedBytes, sessionWorkBeforeRelease)
  assert.ok(valueOf(manager.counters(secondCall)).sessionAccountedBytes < 4 * mib)
  const cancelled = manager.cancel(nextCall)
  assert.equal(cancelled.status, 'ok')
  let cancelledCallbackRan = false
  const cancelledCall = manager.run(nextCall, zeroCost(), () => { cancelledCallbackRan = true })
  assert.equal(cancelledCall.status, 'stale')
  assert.equal(cancelledCall.reason, 'call-cancelled')
  assert.equal(cancelledCallbackRan, false)
  assert.equal(manager.finish(nextCall, true).status, 'stale', 'cancellation cannot mint another continuation')
  assert.equal(manager.continue(continuation, readBinding).status, 'stale', 'the prior continuation stays consumed after cancellation')
  assert.equal(manager.stats().sessions, 1, 'cancellation retires the old session and its spent allowance')
  manager.close()
})

test('aggregate resident exhaustion retires an accepted scope when its continuation re-probe cannot fit', () => {
  const mib = 1024 * 1024
  const cap = 8 * mib
  const manager = managerFor().manager
  const bindingA = binding()
  const sourceA = controlSource()
  const filledA = reserveSessionToResidentCap(manager, bindingA, sourceA)
  const consumedContinuation = valueOf(manager.finish(filledA.callToken, true)).continuationToken
  const callA = valueOf(manager.continue(consumedContinuation, bindingA)).callToken
  assert.equal(valueOf(manager.counters(callA)).sessionAccountedBytes, 4 * mib - 55,
    'the next call needs only its call-local control probe metadata')

  const bindingB = binding({ viewKey: 'library' })
  const sourceB = controlSource()
  let callB = startRead(manager, bindingB, { control: sourceB }).callToken
  for (let page = 0; page < 3; page += 1) {
    assert.equal(manager.reserveResident(callB, 'cache', mib).status, 'ok')
    const continuation = valueOf(manager.finish(callB, true)).continuationToken
    callB = valueOf(manager.continue(continuation, bindingB)).callToken
    assert.equal(manager.probeControl(callB, sourceB).status, 'ok')
  }
  const available = cap - manager.stats().accountedBytes
  const finalBytes = available - 64
  assert.ok(finalBytes > 0 && finalBytes < mib, 'the second session can use the remaining aggregate allowance')
  assert.equal(manager.reserveResident(callB, 'cache', finalBytes).status, 'ok')
  assert.equal(manager.stats().accountedBytes, cap)
  assert.ok(valueOf(manager.counters(callB)).sessionAccountedBytes <= 4 * mib)

  const denied = manager.probeControl(callA, sourceA)
  assert.equal(denied.status, 'budget-exhausted')
  assert.equal(denied.reason, 'accounted-capacity')
  let cheapCallRan = false
  assert.equal(manager.run(callA, zeroCost(), () => { cheapCallRan = true }).status, 'budget-exhausted')
  assert.equal(cheapCallRan, false)
  assert.equal(manager.finish(callA, true).status, 'budget-exhausted')
  assert.equal(manager.continue(consumedContinuation, bindingA).status, 'stale')
  assert.equal(manager.stats().sessions, 1, 'only the exhausted read session is retired')
  manager.close()
})

test('idle, absolute, eviction, rollback, and cooperative soft deadlines stay distinct', () => {
  const idleClock = controlledClock()
  const idleManager = managerFor(idleClock, limits({ idleMilliseconds: 10, absoluteMilliseconds: 20 })).manager
  const idleBinding = binding()
  const idleCall = startRead(idleManager, idleBinding).callToken
  const idleToken = valueOf(idleManager.finish(idleCall, true)).continuationToken
  idleClock.advance(10)
  assert.equal(idleManager.continue(idleToken, idleBinding).status, 'expired')
  idleManager.close()

  const absoluteClock = controlledClock()
  const absoluteManager = managerFor(absoluteClock, limits({ idleMilliseconds: 10, absoluteMilliseconds: 20 })).manager
  const absoluteBinding = binding()
  const absoluteCall = startRead(absoluteManager, absoluteBinding).callToken
  absoluteClock.set(9)
  assert.equal(absoluteManager.run(absoluteCall, zeroCost(), () => 'touch').status, 'ok')
  const firstToken = valueOf(absoluteManager.finish(absoluteCall, true)).continuationToken
  absoluteClock.set(18)
  const nextCall = valueOf(absoluteManager.continue(firstToken, absoluteBinding)).callToken
  const secondToken = valueOf(absoluteManager.finish(nextCall, true)).continuationToken
  absoluteClock.set(20)
  assert.equal(absoluteManager.continue(secondToken, absoluteBinding).status, 'expired', 'absolute age is not extended by activity')
  absoluteManager.close()

  const eviction = managerFor().manager
  const firstBinding = binding()
  const first = startRead(eviction, firstBinding).callToken
  const evictedToken = valueOf(eviction.finish(first, true)).continuationToken
  startRead(eviction, binding({ viewKey: 'library' }))
  const third = eviction.begin(binding({ viewKey: 'detail' }))
  assert.equal(third.status, 'ok', 'an idle session is evicted to keep the runtime session count at two')
  assert.equal(eviction.continue(evictedToken, firstBinding).status, 'evicted')
  eviction.close()

  const softClock = controlledClock()
  const softManager = managerFor(softClock).manager
  const softCall = startRead(softManager, binding()).callToken
  softClock.set(99)
  assert.equal(softManager.run(softCall, zeroCost(), () => {
    softClock.set(500)
    return 'under-window'
  }).status, 'ok', 'the cooperative gate cannot interrupt a synchronous operation already in progress')
  let afterWindowRan = false
  assert.equal(softManager.run(softCall, zeroCost(), () => { afterWindowRan = true }).status, 'budget-exhausted')
  assert.equal(afterWindowRan, false, 'the 100ms gate is checked between synchronous operations')
  softManager.close()

  const residentClock = controlledClock()
  const residentManager = managerFor(residentClock).manager
  const residentCall = startRead(residentManager, binding()).callToken
  residentClock.set(100)
  const residentBefore = residentManager.stats().accountedBytes
  let residentCallbackRan = false
  const gatedResident = residentManager.withResident(residentCall, 'cache', 16, () => { residentCallbackRan = true })
  assert.equal(gatedResident.status, 'budget-exhausted')
  assert.equal(gatedResident.reason, 'cooperative-soft-window')
  assert.equal(residentCallbackRan, false, 'withResident uses the same preflight gate before its callback')
  assert.equal(residentManager.stats().accountedBytes, residentBefore, 'the rejected callback releases its resident lease')
  assert.equal(valueOf(residentManager.counters(residentCall)).call.materializedBytes, 16,
    'work reserved before the gate remains charged even when the callback is skipped')
  residentManager.finish(residentCall, false)
  residentManager.close()

  const rollbackClock = controlledClock(5)
  const rollbackManager = managerFor(rollbackClock).manager
  const rollbackCall = startRead(rollbackManager, binding()).callToken
  rollbackClock.set(4)
  assert.equal(rollbackManager.run(rollbackCall, zeroCost(), () => 'unsafe').status, 'unavailable-probe')
  assert.equal(rollbackManager.stats().sessions, 0, 'monotonic rollback invalidates the complete token state')
  rollbackManager.close()
})

test('run, resident, and probe callbacks revalidate expiry and monotonic clock before releasing values', () => {
  const scenarios = [
    { name: 'idle expiry', before: 0, after: 25, status: 'expired', reason: 'session-lifetime' },
    { name: 'absolute expiry', before: 10, after: 30, status: 'expired', reason: 'session-lifetime' },
    { name: 'clock rollback', before: 10, after: 9, status: 'unavailable-probe', reason: 'monotonic-clock' },
    { name: 'invalid clock', before: 0, after: Number.NaN, status: 'unavailable-probe', reason: 'monotonic-clock' },
  ]

  for (const callbackKind of ['run', 'withResident', 'probe']) {
    for (const scenario of scenarios) {
      const clock = controlledClock()
      const manager = managerFor(clock, limits({ idleMilliseconds: 25, absoluteMilliseconds: 30 })).manager
      const readBinding = binding()
      const stableSource = controlSource()
      let callToken
      let acceptedStamp
      if (callbackKind === 'probe') {
        callToken = valueOf(manager.begin(readBinding)).callToken
        acceptedStamp = valueOf(manager.probeControl(callToken, stableSource))
      } else {
        const started = startRead(manager, readBinding, { control: stableSource })
        callToken = started.callToken
        acceptedStamp = started.controlStamp
      }
      const continuation = valueOf(manager.finish(callToken, true)).continuationToken
      callToken = valueOf(manager.continue(continuation, readBinding)).callToken
      if (callbackKind !== 'probe') assert.equal(manager.probeControl(callToken, stableSource).status, 'ok')
      clock.set(scenario.before)

      let callbackRan = false
      const callback = () => {
        callbackRan = true
        clock.set(scenario.after)
        return 'computed-but-must-be-discarded'
      }
      const accountedBefore = manager.stats().accountedBytes
      let outcome
      if (callbackKind === 'run') {
        outcome = manager.run(callToken, zeroCost(), callback)
      } else if (callbackKind === 'withResident') {
        outcome = manager.withResident(callToken, 'cache', 32, callback)
      } else {
        outcome = manager.probeControl(callToken, {
          dashboardReadVersion() {
            callbackRan = true
            clock.set(scenario.after)
            return acceptedStamp
          },
        })
      }
      assert.equal(callbackRan, true, `${callbackKind} ran its synchronous callback for ${scenario.name}`)
      assert.equal(outcome.status, scenario.status, `${callbackKind} discards the result for ${scenario.name}`)
      assert.equal(outcome.reason, scenario.reason)
      assert.equal(manager.stats().sessions, 0, `${scenario.name} retires the whole token session`)
      if (callbackKind === 'withResident') {
        assert.ok(manager.stats().accountedBytes < accountedBefore, 'expiry/clock failure cleans the resident lease and session')
      }
      let lateCallbackRan = false
      assert.notEqual(manager.run(callToken, zeroCost(), () => { lateCallbackRan = true }).status, 'ok')
      assert.equal(lateCallbackRan, false)
      assert.notEqual(manager.finish(callToken, true).status, 'ok', 'a failed callback cannot mint a continuation')
      assert.notEqual(manager.continue(continuation, readBinding).status, 'ok', 'the consumed continuation cannot be reused')
      manager.close()
    }
  }
})

test('reentrant, invalidated, closed, and thenable callbacks fail closed with cleanup', () => {
  const nestedManager = managerFor().manager
  const nestedCall = startRead(nestedManager, binding()).callToken
  const nested = nestedManager.run(nestedCall, zeroCost(), () => {
    assert.equal(nestedManager.run(nestedCall, zeroCost(), () => 'inner').status, 'stale')
    return 'outer'
  })
  assert.equal(nested.status, 'stale', 'a callback cannot hide an attempted nested operation')
  assert.equal(nestedManager.stats().sessions, 0)
  nestedManager.close()

  const invalidatedManager = managerFor().manager
  const invalidatedCall = startRead(invalidatedManager, binding()).callToken
  assert.equal(invalidatedManager.run(invalidatedCall, zeroCost(), () => {
    invalidatedManager.invalidate('callback-invalidated')
    return 'late-result'
  }).status, 'stale')
  assert.equal(invalidatedManager.stats().sessions, 0)
  invalidatedManager.close()

  const closedManager = managerFor().manager
  const closedCall = startRead(closedManager, binding()).callToken
  assert.equal(closedManager.run(closedCall, zeroCost(), () => {
    closedManager.close()
    return 'late-result'
  }).status, 'stale')
  assert.equal(closedManager.stats().closed, true)

  const thenableManager = managerFor().manager
  const thenableCall = startRead(thenableManager, binding()).callToken
  let thenInvoked = false
  const thenable = thenableManager.run(thenableCall, zeroCost({ sqlStatements: 1 }), () => ({ then() { thenInvoked = true } }))
  assert.equal(thenable.status, 'unavailable-probe')
  assert.equal(thenInvoked, false, 'the manager rejects a thenable without assimilating it')
  assert.equal(thenableManager.stats().sessions, 0)
  thenableManager.close()

  const asyncManager = managerFor().manager
  const asyncCall = startRead(asyncManager, binding()).callToken
  let asyncBodyRan = false
  const asyncOutcome = asyncManager.withResident(asyncCall, 'cache', 16, async () => {
    asyncBodyRan = true
  })
  assert.equal(asyncOutcome.status, 'unavailable-probe')
  assert.equal(asyncBodyRan, false, 'an async callback is rejected before invocation')
  assert.equal(asyncManager.stats().accountedBytes, valueOf(asyncManager.counters(asyncCall)).accountedBytes)
  asyncManager.close()
})

test('dormant construction and invalidation do not start timers or probes; runtime hooks clear state', () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  let timerCalls = 0
  let clockCalls = 0
  globalThis.setTimeout = () => { timerCalls += 1; return 0 }
  globalThis.setInterval = () => { timerCalls += 1; return 0 }
  let dormant
  try {
    dormant = new DashboardReadSessionManager({ monotonicNow: () => { clockCalls += 1; return 0 } })
    assert.equal(clockCalls, 0, 'constructor does not sample a clock or start work')
    assert.equal(timerCalls, 0)
    dormant.invalidate()
    assert.equal(clockCalls, 0, 'invalidating an unused manager is a map-only no-op')
    assert.equal(timerCalls, 0)
    const callToken = valueOf(dormant.begin(binding())).callToken
    const callsBeforeInvalidation = clockCalls
    dormant.invalidate()
    assert.equal(clockCalls, callsBeforeInvalidation)
    assert.equal(dormant.run(callToken, zeroCost(), () => 'stale').status, 'stale')
    assert.equal(timerCalls, 0)
  } finally {
    dormant?.close()
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-runtime-lifecycle-'))
  let runtime
  let providerCalls = 0
  try {
    runtime = new MemoryRuntime({
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      llm: { stream() { providerCalls += 1; throw new Error('S1 lifecycle must not call providers') } },
      sessions: { get() { return undefined } },
      get() { return undefined },
    }, resolveConfig({ capture: { enabled: false }, extraction: { enabled: false } }), root)
    const manager = runtime.dashboardReadSessions
    const settingsCall = valueOf(manager.begin(binding())).callToken
    runtime.updateSettings({ mode: 'review' })
    assert.equal(manager.run(settingsCall, zeroCost(), () => 'stale').status, 'stale')

    const maintenanceCall = valueOf(manager.begin(binding())).callToken
    runtime.closeProjectStoresForMaintenance('snapshot')
    assert.equal(manager.run(maintenanceCall, zeroCost(), () => 'stale').status, 'stale')

    const closeCall = valueOf(manager.begin(binding())).callToken
    runtime.close()
    assert.equal(manager.stats().closed, true)
    assert.equal(manager.run(closeCall, zeroCost(), () => 'stale').status, 'stale')
    assert.equal(providerCalls, 0)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('nested close during invalidate leaves no post-close token tombstones', () => {
  const manager = managerFor().manager
  let endedA = 0
  let endedB = 0
  assert.equal(manager.begin(binding({ viewKey: 'a' }), () => {
    endedA += 1
    manager.close()
  }).status, 'ok')
  assert.equal(manager.begin(binding({ viewKey: 'b' }), () => { endedB += 1 }).status, 'ok')

  manager.invalidate('outer-invalidation')
  assert.deepEqual(manager.stats(), { sessions: 0, activeCalls: 0, accountedBytes: 0, closed: true })
  assert.equal(endedA, 1)
  assert.equal(endedB, 1)
  manager.close()
  assert.equal(manager.stats().accountedBytes, 0)
})

test('current project databases reopen through a read-only dashboard connection', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-readonly-project-'))
  const projectKey = 'readonly-project-0123456789ab'
  const directory = path.join(root, 'projects', projectKey)
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'memory.db')
  let writer
  let reader
  try {
    writer = new MemoryStore(file)
    writer.setProjectMeta({ key: projectKey, name: 'Read only project', cwd: '/tmp/read-only-project' })
    writer.close()
    writer = undefined

    reader = openProjectStoreReadOnly(root, projectKey)
    assert.equal(reader.readOnly, true)
    assert.deepEqual(reader.dashboardProjectMeta(), { name: 'Read only project', nameBytes: Buffer.byteLength('Read only project') })
    assert.throws(() => reader.setProjectMeta({ key: projectKey, name: 'mutated', cwd: '/tmp' }))
  } finally {
    reader?.close()
    writer?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('read-only schema preflight stays bounded with unrelated tables and refuses an oversized version value', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-u11-readonly-schema-bound-'))
  const projectKey = 'readonly-schema-bound-0123456789ab'
  const directory = path.join(root, 'projects', projectKey)
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'memory.db')
  let writer
  let reader
  let db
  try {
    writer = new MemoryStore(file)
    writer.close()
    writer = undefined

    db = new DatabaseSync(file)
    db.exec('BEGIN')
    for (let index = 0; index < 128; index += 1) db.exec(`CREATE TABLE unrelated_schema_${index}(id TEXT)`)
    db.exec('COMMIT')
    db.close()
    db = undefined

    reader = openProjectStoreReadOnly(root, projectKey)
    assert.equal(reader.readOnly, true, 'fixed required-table lookup accepts a current schema with unrelated tables')
    reader.close()
    reader = undefined

    db = new DatabaseSync(file)
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run('9'.repeat(10_000))
    db.close()
    db = undefined
    assert.throws(() => openProjectStoreReadOnly(root, projectKey), /missing, unsupported, or awaiting schema migration/u,
      'oversized version text is refused before it is materialized as a JavaScript string')
  } finally {
    reader?.close()
    db?.close()
    writer?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('enumerated directory members share the four-per-call and sixteen-per-session project budget without widening the body binding', () => {
  const clock = controlledClock()
  const { manager } = managerFor(clock)
  const readBinding = binding()
  // One control connection for the whole read session: a fresh connectionId
  // on every probe would correctly invalidate the continuation as stale.
  const control = controlSource()
  const openCall = () => {
    const callToken = valueOf(manager.begin(readBinding)).callToken
    valueOf(manager.probeControl(callToken, control))
    return callToken
  }
  const meterFour = (callToken, prefix) => {
    for (let index = 0; index < 4; index += 1) {
      assert.equal(valueOf(manager.runMember(callToken, `${prefix}-${index}`,
        zeroCost({ sqlStatements: 1, rowsVisited: 1 }), () => index)), index)
    }
    assert.equal(manager.runMember(callToken, `${prefix}-overflow`, zeroCost(), () => 'overflow').status,
      'budget-exhausted', 'a fifth member in one call is refused by the existing project budget')
  }

  const firstCall = openCall()
  assert.equal(manager.runMember(firstCall, '', zeroCost(), () => 0).status, 'unavailable-probe',
    'an empty member key is not a directory capability input')
  meterFour(firstCall, 'member-a')
  // Rechecking the same member in the same call is deduplicated for projects.
  assert.equal(valueOf(manager.runMember(firstCall, 'member-a-0', zeroCost(), () => 'recheck')), 'recheck')
  let counters = valueOf(manager.counters(firstCall))
  assert.equal(counters.call.projects, 4)
  assert.equal(counters.session.projects, 4)

  let token = valueOf(manager.finish(firstCall, true)).continuationToken
  const secondCall = valueOf(manager.continue(token, readBinding)).callToken
  valueOf(manager.probeControl(secondCall, control))
  meterFour(secondCall, 'member-b')

  token = valueOf(manager.finish(secondCall, true)).continuationToken
  const thirdCall = valueOf(manager.continue(token, readBinding)).callToken
  valueOf(manager.probeControl(thirdCall, control))
  meterFour(thirdCall, 'member-c')

  token = valueOf(manager.finish(thirdCall, true)).continuationToken
  const fourthCall = valueOf(manager.continue(token, readBinding)).callToken
  valueOf(manager.probeControl(fourthCall, control))
  meterFour(fourthCall, 'member-d')
  counters = valueOf(manager.counters(fourthCall))
  assert.equal(counters.session.projects, 16, 'the cumulative session project budget is unchanged')

  token = valueOf(manager.finish(fourthCall, true)).continuationToken
  const fifthCall = valueOf(manager.continue(token, readBinding)).callToken
  valueOf(manager.probeControl(fifthCall, control))
  const exhausted = manager.runMember(fifthCall, 'member-e-0', zeroCost(), () => 'never')
  assert.equal(exhausted.status, 'budget-exhausted')
  assert.equal(exhausted.reason, 'work-limit')
  counters = valueOf(manager.counters(fifthCall))
  assert.equal(counters.session.projects, 16)
  assert.equal(counters.call.projects, 0, 'a refused member access is not debited or registered')

  // Member access never satisfies or widens the immutable body binding: the
  // same session still rejects a body probe for an enumerated member key.
  assert.equal(manager.probeProject(fifthCall, 'member-a-0', projectSource()).status, 'stale')
  assert.equal(manager.stats().sessions, 0)
})
