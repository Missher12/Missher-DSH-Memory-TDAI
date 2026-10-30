import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createSettingsReadController, isAcceptedSettingsAck, isSuccessfulSettingsRead, parseSettingsNumberDraft,
  settingsAckMessage, settingsCloseRequest, settingsLastErrorNotice, settingsReadFailure, settingsReadId,
  settingsReadIsCurrent,
} from '../src/client/settings-read-state.js'

const dashboard = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'Dashboard.tsx'), 'utf8')

test('settings read accepts only a real ok settings result and keeps failure/cleanup states distinct', () => {
  const ready = { version: 1, status: 'ok', complete: true, generatedAt: 1,
    readId: '00000000-0000-4000-8000-000000000001',
    settings: { mode: 'review', recallMaxTokens: 777, extractionEveryN: 3, extractionEnabled: false,
      includePersona: true, globalPersona: false } }
  assert.equal(isSuccessfulSettingsRead(ready), true)
  assert.equal(settingsReadId(ready), ready.readId)
  assert.equal(isSuccessfulSettingsRead({ ...ready, status: 'partial' }), false)
  assert.equal(isSuccessfulSettingsRead({ ...ready, complete: false }), false)
  assert.equal(isSuccessfulSettingsRead({ ...ready, settings: undefined }), false)
  assert.match(settingsReadFailure({ version: 1, status: 'stale', complete: false, generatedAt: 1,
    reason: 'visibility-proof-expired-at-rpc-boundary' }), /stale.*visibility-proof-expired/u)
  assert.equal(settingsReadId({ version: 1, status: 'stale', complete: false, generatedAt: 1 }), undefined)
  assert.deepEqual(settingsCloseRequest('00000000-0000-4000-8000-000000000001'),
    { version: 1, action: 'close', readId: '00000000-0000-4000-8000-000000000001' })
  assert.equal(settingsReadIsCurrent(4, 4, true), true)
  assert.equal(settingsReadIsCurrent(4, 5, true), false, 'a save/new read generation invalidates the late response')
  assert.equal(settingsReadIsCurrent(4, 4, false), false, 'an unmounted component cannot apply the late response')
})

test('settings ACK requires global settings.update and distinguishes applied, confirmed, noop and rejection', () => {
  assert.equal(isAcceptedSettingsAck({ ok: true, scope: 'global', operation: 'settings.update', result: 'applied' }), true)
  assert.equal(settingsAckMessage({ ok: true, scope: 'global', operation: 'settings.update', result: 'applied' }), '配置已保存')
  assert.equal(settingsAckMessage({ ok: true, scope: 'global', operation: 'settings.update', result: 'confirmed' }), '配置已是目标值')
  assert.equal(settingsAckMessage({ ok: true, scope: 'global', operation: 'settings.update', result: 'noop' }), '配置无需改变')
  assert.equal(isAcceptedSettingsAck({ ok: true, scope: 'project', operation: 'settings.update', result: 'applied' }), false)
  assert.equal(isAcceptedSettingsAck({ ok: true, scope: 'global', operation: 'other', result: 'applied' }), false)
  assert.equal(isAcceptedSettingsAck({ ok: false, scope: 'global', operation: 'settings.update', result: 'rejected', reason: 'nope' }), false)
  assert.match(settingsAckMessage({ ok: false, scope: 'global', operation: 'settings.update', result: 'rejected', reason: 'nope' }), /rejected.*nope/u)
})

test('lastErrorState present and omitted stay visible without treating settings as failed', () => {
  assert.equal(settingsLastErrorNotice({ lastErrorState: 'present', lastError: 'runtime warning' }), 'runtime warning')
  assert.equal(settingsLastErrorNotice({ lastErrorState: 'omitted' }), '运行时错误详情已省略')
  assert.equal(settingsLastErrorNotice({ lastErrorState: 'absent' }), undefined)
})

// Original name retained. Human Demo v7 replaces the two old settings entrances with one inline gear.
test('Dashboard uses the same read/ACK/close helper and both settings entry points', () => {
  const start = dashboard.indexOf('export function Dashboard(')
  const entry = dashboard.slice(start, dashboard.indexOf('function MemoryV7', start))
  assert.match(entry, /return <MemoryV7/u)
  assert.doesNotMatch(entry, /return <Loaded/u)
  const v7 = dashboard.slice(dashboard.indexOf('function MemoryV7('))
  assert.match(v7, /readCompleteGlobalMemory\(props\.readDashboard/u)
  // Exact retry/ACK/readback and calendar semantics are covered behaviorally in client-slot.test.mjs.
  assert.match(v7, /generateMemory.*useMemory/u)
  assert.match(v7, /token === mutation\.current/u)
  assert.match(v7, /aria-label="记忆设置"/u)
  assert.match(v7, /detail\.layer === 'L1' &&/u)
  assert.match(v7, /aria-label="清除搜索"/u)
  assert.match(v7, /event\.key !== 'Escape'/u)
  assert.match(v7, /mv7-inline/u)
  assert.doesNotMatch(v7, /day\.records\.map|遗忘其所有|生成它的关联记忆/u)
  assert.doesNotMatch(v7, /settingsValue\.(mode|recallMaxTokens)|renderSettingsPanel|props\.load\(/u)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function settingsResult(readId, overrides = {}) {
  return { version: 1, status: 'ok', complete: true, generatedAt: 1, readId,
    settings: { mode: 'review', recallMaxTokens: 777, extractionEveryN: 3, extractionEnabled: false,
      includePersona: true, globalPersona: false, ...(overrides.settings ?? {}) },
    ...(overrides.lastErrorState === undefined ? {} : { lastErrorState: overrides.lastErrorState }),
    ...(overrides.lastError === undefined ? {} : { lastError: overrides.lastError }),
  }
}

function readTransport() {
  const pending = []
  const closeCalls = []
  let settingsCalls = 0
  const readDashboard = (request) => {
    if (request.action === 'close') {
      closeCalls.push(request.readId)
      return Promise.resolve({ version: 1, status: 'stale', complete: false, generatedAt: 1,
        reason: 'close-already-stale', readId: request.readId })
    }
    settingsCalls += 1
    const item = deferred()
    pending.push(item)
    return item.promise
  }
  return { readDashboard, pending, closeCalls, settingsCalls: () => settingsCalls }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function acceptedAck(result = 'applied') {
  return { ok: true, scope: 'global', operation: 'settings.update', result }
}

test('read A, save B and ACK-triggered read C keep ownership and close each reader once', async () => {
  const reads = readTransport()
  const pendingAcks = []
  let ackCalls = 0
  const controller = createSettingsReadController({
    readDashboard: reads.readDashboard,
    updateSettingsAck: (patch) => {
      ackCalls += 1
      const item = deferred()
      pendingAcks.push({ patch, item })
      return item.promise
    },
  })
  const a = controller.startRead()
  assert.ok(a.token)
  const b = controller.startSave({ mode: 'balanced' })
  assert.equal(b.started, true)
  const duplicate = controller.startSave({ mode: 'auto' })
  assert.equal(duplicate.started, false)
  assert.equal(duplicate.reason, 'in-flight')
  assert.equal(ackCalls, 1)

  pendingAcks[0].item.resolve(acceptedAck('applied'))
  await flush()
  assert.equal(reads.settingsCalls(), 2, 'accepted ACK starts exactly one new read')
  reads.pending[1].resolve(settingsResult('read-c', { settings: { recallMaxTokens: 888 },
    lastErrorState: 'present', lastError: 'runtime warning' }))
  const saved = await b.promise
  assert.equal(saved.kind, 'saved')
  assert.equal(saved.acknowledgement, '配置已保存')
  assert.equal(saved.settings.recallMaxTokens, 888)
  assert.equal(saved.lastError, 'runtime warning')

  reads.pending[0].resolve(settingsResult('read-a', { settings: { recallMaxTokens: 777 } }))
  const ignored = await a.promise
  assert.deepEqual(ignored, { kind: 'ignored' })
  await flush()
  assert.equal(controller.isLatestRead(a.token), false)
  assert.equal(controller.isLatestSave(b.token), true)
  assert.deepEqual([...reads.closeCalls].sort(), ['read-a', 'read-c'])
  assert.equal(reads.closeCalls.filter((id) => id === 'read-a').length, 1)
  assert.equal(reads.closeCalls.filter((id) => id === 'read-c').length, 1)
  assert.equal(ackCalls, 1)
})

test('public reads cannot preempt a save ACK or its owned normalized reread', async () => {
  const reads = readTransport()
  const ack = deferred()
  let ackCalls = 0
  const controller = createSettingsReadController({
    readDashboard: reads.readDashboard,
    updateSettingsAck: () => {
      ackCalls += 1
      return ack.promise
    },
  })
  const oldRead = controller.startRead()
  assert.ok(oldRead.token)
  const save = controller.startSave({ mode: 'balanced' })
  assert.equal(save.started, true)

  const blockedDuringAck = controller.startRead()
  assert.equal(blockedDuringAck.token, undefined)
  assert.equal(blockedDuringAck.reason, 'save-in-progress')
  assert.equal(reads.settingsCalls(), 1, 'no external request is issued while save waits for ACK')
  assert.equal(reads.pending.length, 1)

  ack.resolve(acceptedAck('applied'))
  await flush()
  assert.equal(reads.settingsCalls(), 2, 'the save owns exactly one normalized reread')
  assert.equal(reads.pending.length, 2)
  const blockedDuringInternal = controller.startRead()
  assert.equal(blockedDuringInternal.token, undefined)
  assert.equal(blockedDuringInternal.reason, 'save-in-progress')
  assert.equal(reads.settingsCalls(), 2, 'no external request preempts the internal reread')

  reads.pending[1].resolve(settingsResult('save-read', { settings: { recallMaxTokens: 888 } }))
  const saved = await save.promise
  assert.equal(saved.kind, 'saved')
  assert.equal(saved.settings.recallMaxTokens, 888)

  reads.pending[0].resolve(settingsResult('old-a', { settings: { recallMaxTokens: 777 } }))
  assert.deepEqual(await oldRead.promise, { kind: 'ignored' })
  await flush()
  assert.equal(ackCalls, 1)
  assert.equal(reads.closeCalls.filter((id) => id === 'save-read').length, 1)
  assert.equal(reads.closeCalls.filter((id) => id === 'old-a').length, 1)

  const afterSave = controller.startRead()
  assert.ok(afterSave.token, 'external reads resume after the save completes')
  reads.pending[2].resolve(settingsResult('after-save', { settings: { recallMaxTokens: 901 } }))
  const afterResult = await afterSave.promise
  assert.equal(afterResult.kind, 'applied')
  assert.equal(afterResult.settings.recallMaxTokens, 901)
  await flush()
  assert.equal(reads.closeCalls.filter((id) => id === 'after-save').length, 1)
})

test('transport replacement disposes old save/read ownership while the new lifecycle stays active', async () => {
  const readsOne = readTransport()
  const acksOne = []
  const controllerOne = createSettingsReadController({
    readDashboard: readsOne.readDashboard,
    updateSettingsAck: () => {
      const item = deferred()
      acksOne.push(item)
      return item.promise
    },
  })
  const oldRead = controllerOne.startRead()
  const oldSave = controllerOne.startSave({ includePersona: false })
  assert.equal(oldSave.started, true)
  const duplicate = controllerOne.startSave({ includePersona: true })
  assert.equal(duplicate.started, false)

  const readsTwo = readTransport()
  const controllerTwo = createSettingsReadController({ readDashboard: readsTwo.readDashboard,
    updateSettingsAck: async () => acceptedAck('confirmed') })
  const newRead = controllerTwo.startRead()
  readsTwo.pending[0].resolve(settingsResult('new-read', { settings: { recallMaxTokens: 900 } }))
  assert.equal((await newRead.promise).kind, 'applied')
  assert.equal(controllerTwo.isLatestRead(newRead.token), true)

  controllerOne.dispose()
  acksOne[0].resolve(acceptedAck('applied'))
  assert.deepEqual(await oldSave.promise, { kind: 'ignored' })
  readsOne.pending[0].resolve(settingsResult('old-read'))
  assert.deepEqual(await oldRead.promise, { kind: 'ignored' })
  await flush()
  assert.equal(readsOne.settingsCalls(), 1, 'the disposed ACK did not start an old reread')
  assert.equal(controllerOne.isLatestSave(oldSave.token), false)
  assert.deepEqual(readsOne.closeCalls, ['old-read'])
  assert.deepEqual(readsTwo.closeCalls, ['new-read'])
})

test('rejected, transport-failed, stale and non-retry settings results stay explicit', async () => {
  const rejectedReads = readTransport()
  const rejected = createSettingsReadController({ readDashboard: rejectedReads.readDashboard,
    updateSettingsAck: async () => ({ ok: false, scope: 'global', operation: 'settings.update',
      result: 'rejected', reason: 'synthetic-rejected' }) })
  const rejectedSave = rejected.startSave({ mode: 'review' })
  const rejectedResult = await rejectedSave.promise
  assert.equal(rejectedResult.kind, 'rejected')
  assert.match(rejectedResult.message, /rejected.*synthetic-rejected/u)
  assert.equal(rejectedReads.settingsCalls(), 0)

  const failedReads = readTransport()
  const failed = createSettingsReadController({ readDashboard: failedReads.readDashboard,
    updateSettingsAck: async () => { throw new Error('synthetic-transport') } })
  const failedSave = failed.startSave({ mode: 'review' })
  const failedResult = await failedSave.promise
  assert.equal(failedResult.kind, 'failed')
  assert.equal(failedResult.message, 'synthetic-transport')
  assert.equal(failedReads.settingsCalls(), 0)

  const staleReads = readTransport()
  const stale = createSettingsReadController({ readDashboard: staleReads.readDashboard })
  const staleRead = stale.startRead()
  staleReads.pending[0].resolve({ version: 1, status: 'stale', complete: false, generatedAt: 1,
    reason: 'visibility-proof-expired-at-rpc-boundary' })
  const staleResult = await staleRead.promise
  assert.equal(staleResult.kind, 'failure')
  assert.match(staleResult.message, /stale.*visibility-proof-expired/u)
  await flush()
  assert.equal(staleReads.settingsCalls(), 1, 'a failed read never retries by itself')
  const retry = stale.startRead()
  staleReads.pending[1].resolve(settingsResult('stale-retry'))
  assert.equal((await retry.promise).kind, 'applied')

  const normalizedReads = readTransport()
  const normalized = createSettingsReadController({ readDashboard: normalizedReads.readDashboard,
    updateSettingsAck: async () => acceptedAck('noop') })
  const normalizedSave = normalized.startSave({ recallMaxTokens: 777 })
  await flush()
  assert.equal(normalizedReads.settingsCalls(), 1, 'the async ACK has started exactly one owned reread')
  assert.equal(normalizedReads.pending.length, 1, 'the reread queue exists before it is resolved')
  normalizedReads.pending[0].resolve(settingsResult('same-value', { settings: { recallMaxTokens: 777 } }))
  const normalizedResult = await normalizedSave.promise
  assert.equal(normalizedResult.kind, 'saved')
  assert.equal(normalizedResult.acknowledgement, '配置无需改变')
  assert.equal(normalizedResult.settings.recallMaxTokens, 777)
  await flush()
  assert.deepEqual(normalizedReads.closeCalls, ['same-value'], 'a stale close result is still only cleanup')
})

test('numeric drafts reject blank, fractional, and out-of-range values while preserving real zero', () => {
  assert.deepEqual(parseSettingsNumberDraft('40', 40, 4000), { valid: true, value: 40 })
  assert.deepEqual(parseSettingsNumberDraft('0', 0, 100), { valid: true, value: 0 })
  assert.deepEqual(parseSettingsNumberDraft('', 0, 100), { valid: false, reason: 'empty' })
  assert.deepEqual(parseSettingsNumberDraft('   ', 0, 100), { valid: false, reason: 'empty' })
  assert.deepEqual(parseSettingsNumberDraft('40.4', 40, 4000), { valid: false, reason: 'out-of-range' })
  assert.deepEqual(parseSettingsNumberDraft('39', 40, 4000), { valid: false, reason: 'out-of-range' })
  assert.deepEqual(parseSettingsNumberDraft('4001', 40, 4000), { valid: false, reason: 'out-of-range' })
})

test('an old save finally cannot clear a newer lifecycle save busy flag', async () => {
  const readsOne = readTransport()
  const ackOne = deferred()
  const controllerOne = createSettingsReadController({ readDashboard: readsOne.readDashboard,
    updateSettingsAck: () => ackOne.promise })
  const oldSave = controllerOne.startSave({ mode: 'review' })
  assert.equal(oldSave.started, true)

  const readsTwo = readTransport()
  const ackTwo = deferred()
  const controllerTwo = createSettingsReadController({ readDashboard: readsTwo.readDashboard,
    updateSettingsAck: () => ackTwo.promise })
  const newSave = controllerTwo.startSave({ mode: 'balanced' })
  assert.equal(newSave.started, true)
  controllerOne.dispose()
  ackOne.resolve(acceptedAck('applied'))
  assert.deepEqual(await oldSave.promise, { kind: 'ignored' })
  const duplicateNew = controllerTwo.startSave({ mode: 'auto' })
  assert.equal(duplicateNew.started, false)
  assert.equal(duplicateNew.reason, 'in-flight')
})


test('Memory settings expose switches and context controls without daily quota forms', () => {
  assert.doesNotMatch(dashboard, /automaticDailyTokens|automaticDailyTasks|manualDailyTokens|manualDailyTasks|保存预算|mv7-budget/u)
  assert.match(dashboard, /在对话中使用记忆/u)
  assert.match(dashboard, /重试保存/u)
})
