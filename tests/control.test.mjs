import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ControlLedger } from '../lib/control.js'
import { BillableResultStore } from '../lib/billable-results.js'

function input(id, jobId) {
  return { id, projectKey: 'project-a', jobId, provider: 'mock', model: 'mock-model', inputHash: 'hash', sourceDigest: 'sources', now: 1 }
}

test('late positive usage blocks redispatch after a confirmed no-charge disposition', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-late-'))
  let ledger
  try {
    ledger = new ControlLedger(root)
    ledger.beginAttempt(input('attempt-late', 'job-late'))
    ledger.settleAttempt('attempt-late', 'confirmed_not_charged', undefined, undefined, 2)
    assert.equal(ledger.getAttempt('attempt-late')?.state, 'confirmed_not_charged')

    const settled = ledger.settleAttempt('attempt-late', 'complete', { inputTokens: 120, costMicros: 40 }, undefined, 3)
    assert.equal(settled.state, 'blocked_charged')
    assert.equal(settled.usage.inputTokens, 120)
    assert.equal(settled.usage.costMicros, 40)
    assert.throws(() => ledger.beginAttempt(input('attempt-retry', 'job-late')), /redispatch is blocked/u)
    assert.equal(ledger.usageConflictsForAttempt('attempt-late').length, 0, 'new positive usage is not a contradiction of an existing receipt')
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-finite usage is not treated as evidence of a charge', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-nonfinite-'))
  let ledger
  try {
    ledger = new ControlLedger(root)
    ledger.beginAttempt(input('attempt-nonfinite', 'job-nonfinite'))
    const settled = ledger.settleAttempt('attempt-nonfinite', 'confirmed_not_charged', { inputTokens: Number.POSITIVE_INFINITY }, undefined, 2)
    assert.equal(settled.state, 'confirmed_not_charged')
    assert.equal(settled.usage.inputTokens, null)
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('contradictory usage receipts preserve the first values and leave an audit trail', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-conflict-'))
  let ledger
  try {
    ledger = new ControlLedger(root)
    ledger.beginAttempt(input('attempt-conflict', 'job-conflict'))
    ledger.settleAttempt('attempt-conflict', 'complete', { inputTokens: 100, costMicros: 25 }, undefined, 2)

    const settled = ledger.settleAttempt('attempt-conflict', 'complete', { inputTokens: 110, costMicros: 30 }, undefined, 3)
    assert.equal(settled.state, 'blocked_charged')
    assert.equal(settled.usage.inputTokens, 100, 'the first provider receipt remains authoritative')
    assert.equal(settled.usage.costMicros, 25)
    assert.deepEqual(ledger.usageConflictsForAttempt('attempt-conflict').map(({ field, preservedValue, conflictingValue }) => ({ field, preservedValue, conflictingValue })), [
      { field: 'inputTokens', preservedValue: 100, conflictingValue: 110 },
      { field: 'costMicros', preservedValue: 25, conflictingValue: 30 },
    ])
    assert.throws(() => ledger.beginAttempt(input('attempt-retry', 'job-conflict')), /redispatch is blocked/u)
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('billable calls require an explicit budget and settle only with actual usage evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-billable-'))
  let ledger
  try {
    ledger = new ControlLedger(root)
    assert.throws(() => ledger.reserveBillableCall({ id: 'bill-zero', projectKey: 'project-a', purpose: 'fixture', budgetClass: 'automatic',
      reservedTokens: 100, dailyTokenLimit: 0, dailyTaskLimit: 0, now: 1 }), /must be explicitly configured/u)

    const now = Date.UTC(2025, 0, 1, 12)
    ledger.reserveBillableCall({ id: 'bill-success', projectKey: 'project-a', purpose: 'fixture', budgetClass: 'automatic',
      reservedTokens: 100, dailyTokenLimit: 500, dailyTaskLimit: 3, now })
    ledger.markBillableCallDispatched('bill-success', now + 1)
    const settled = ledger.settleBillableCall('bill-success', 'complete', { inputTokens: 70, outputTokens: 20 }, now + 2)
    assert.equal(settled.state, 'complete')
    assert.equal(settled.actualTokens, 90)
    assert.deepEqual(ledger.billableCallSummary(now + 3).automatic, { tasks: 1, tokens: 90, unknown: 0 })
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('R10 observed provider usage keeps unknown fields and conflicting observations in the content-free ledger', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-observed-usage-'))
  const requestHash = 'd'.repeat(64)
  let ledger
  try {
    ledger = new ControlLedger(root)
    ledger.reserveBillableCall({ id: 'bill-observed', projectKey: 'project-a', purpose: 'project_persona', budgetClass: 'manual',
      reservedTokens: 100, dailyTokenLimit: 1000, dailyTaskLimit: 5, provider: 'mock', model: 'mock-model', requestHash, now: 10 })
    ledger.markBillableCallDispatched('bill-observed', 11)
    const first = { inputTokens: 20, outputTokens: 8, cachedInputTokens: null, cacheReadTokens: 3 }
    const conflicting = { inputTokens: 21, outputTokens: 8, cachedInputTokens: null, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: null, costMicros: 9 }
    const identity = { callId: 'bill-observed', projectKey: 'project-a', purpose: 'project_persona', provider: 'mock', model: 'mock-model', requestHash }
    assert.equal(ledger.recordBillableUsageObservation({ ...identity, usage: first, now: 12 }), 'recorded')
    assert.equal(ledger.recordBillableUsageObservation({ ...identity, usage: first, now: 13 }), 'duplicate')
    assert.equal(ledger.recordBillableUsageObservation({ ...identity, usage: conflicting, now: 14 }), 'conflict')
    const receipt = ledger.billableObservedUsageReceipt('bill-observed')
    assert.equal(receipt?.verification, 'recorded_not_independently_verified')
    assert.equal(receipt?.callId, identity.callId)
    assert.equal(receipt?.projectKey, identity.projectKey)
    assert.equal(receipt?.purpose, identity.purpose)
    assert.equal(receipt?.provider, identity.provider)
    assert.equal(receipt?.model, identity.model)
    assert.equal(receipt?.requestHash, identity.requestHash)
    assert.deepEqual(receipt?.usage, { inputTokens: 20, outputTokens: 8, cachedInputTokens: null, cacheReadTokens: 3,
      cacheWriteTokens: null, reasoningTokens: null, costMicros: null })
    assert.deepEqual(receipt?.conflicts.map((item) => item.conflictingUsage), [{ inputTokens: 21, outputTokens: 8, cachedInputTokens: null,
      cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: null, costMicros: 9 }])
    assert.equal(ledger.hasBillableUsageConflict('bill-observed'), true)
    const settled = ledger.settleBillableCall('bill-observed', 'complete', conflicting, 15)
    assert.equal(settled.state, 'uncertain')
    assert.equal(settled.actualTokens, null, 'a conflicting observed receipt does not become a billable total')
    ledger.close()
    ledger = new ControlLedger(root)
    assert.deepEqual(ledger.billableObservedUsageReceipt('bill-observed'), receipt, 'the full unknown/conflict audit survives restart')
    assert.equal(ledger.hasBillableUsageConflict('bill-observed'), true)
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a saved local response keeps the global billable gate until its local commit is recorded', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-response-gate-'))
  let ledger
  try {
    ledger = new ControlLedger(root)
    const results = new BillableResultStore(root)
    const call = { id: 'bill-response', projectKey: 'project-a', purpose: 'project_persona', budgetClass: 'manual', reservedTokens: 100,
      dailyTokenLimit: 1000, dailyTaskLimit: 5, provider: 'mock', model: 'mock-model', requestHash: 'a'.repeat(64), now: 10 }
    ledger.reserveBillableCall(call)
    ledger.markBillableCallDispatched(call.id, 11)
    const saved = results.save({ version: 1, callId: call.id, projectKey: call.projectKey, purpose: call.purpose, provider: call.provider,
      model: call.model, requestHash: call.requestHash, responseText: 'Synthetic saved result.',
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: null },
      operation: { kind: 'project_persona', projectKey: call.projectKey, sourceIds: ['memory-a'], sourceRevisions: { 'memory-a': 1 }, policyRevision: 'policy-a', sourceCount: 1 }, savedAt: 12 })
    ledger.registerBillableResponse({ callId: call.id, projectKey: call.projectKey, purpose: call.purpose, provider: call.provider, model: call.model,
      requestHash: call.requestHash, sha256: saved.sha256, now: 13 })
    ledger.settleBillableCall(call.id, 'complete', { inputTokens: 20, outputTokens: 8 }, 14)

    assert.equal(ledger.billableCallSummary(15).active?.responseStatus, 'saved')
    assert.throws(() => ledger.reserveBillableCall({ ...call, id: 'bill-next', requestHash: 'b'.repeat(64), now: 16 }), /global billable request gate is held/u)
    ledger.markBillableResponse(call.id, 'committed', undefined, 17)
    assert.equal(ledger.billableCallSummary(18).active, undefined)
    assert.equal(ledger.reserveBillableCall({ ...call, id: 'bill-next', requestHash: 'b'.repeat(64), now: 19 }).id, 'bill-next')
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('unknown billable usage remains a held reservation after the UTC day changes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-billable-unknown-'))
  let ledger
  try {
    ledger = new ControlLedger(root)
    const now = Date.UTC(2025, 0, 1, 23, 59)
    ledger.reserveBillableCall({ id: 'bill-unknown', projectKey: 'project-a', purpose: 'fixture', budgetClass: 'manual',
      reservedTokens: 250, dailyTokenLimit: 1000, dailyTaskLimit: 2, now })
    ledger.markBillableCallDispatched('bill-unknown', now + 1)
    const settled = ledger.settleBillableCall('bill-unknown', 'complete', { inputTokens: 20 }, now + 2)
    assert.equal(settled.state, 'uncertain')
    assert.equal(settled.actualTokens, null)
    const nextDay = Date.UTC(2025, 0, 2, 0, 1)
    assert.deepEqual(ledger.billableCallSummary(nextDay).manual, { tasks: 0, tokens: 0, unknown: 0 })
    assert.equal(ledger.billableCallSummary(nextDay).active?.id, 'bill-unknown')
    assert.throws(() => ledger.reserveBillableCall({ id: 'bill-retry', projectKey: 'project-a', purpose: 'fixture', budgetClass: 'manual',
      reservedTokens: 50, dailyTokenLimit: 1000, dailyTaskLimit: 2, now: nextDay }), /global billable request gate is held/u)
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('R6 CR02 accepts a matched authorized late receipt after the exclusive writer lease is reacquired', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-late-receipt-'))
  const requestHash = 'c'.repeat(64)
  let ledger
  try {
    ledger = new ControlLedger(root)
    ledger.reserveBillableCall({ id: 'bill-late-after-restart', projectKey: 'project-a', purpose: 'fixture', budgetClass: 'manual',
      reservedTokens: 100, dailyTokenLimit: 1000, dailyTaskLimit: 5, provider: 'mock', model: 'mock-model', requestHash, now: 10 })
    ledger.markBillableCallDispatched('bill-late-after-restart', 11)
    ledger.close()
    ledger = undefined

    ledger = new ControlLedger(root)
    const recovered = ledger.getBillableCall('bill-late-after-restart')
    assert.equal(recovered?.state, 'uncertain')
    assert.equal(recovered?.localEnded, true, 'exclusive startup handoff proves the previous local stream ended')
    const settled = ledger.reconcileBillableUsage({ callId: 'bill-late-after-restart', receiptId: 'receipt-after-restart',
      provider: 'mock', model: 'mock-model', requestHash, inputTokens: 31, outputTokens: 12,
      evidenceRef: 'provider-receipt://synthetic-31-12', reason: 'Synthetic verified receipt after restart', authorized: true, now: 12 })
    assert.equal(settled.state, 'complete')
    assert.equal(settled.actualTokens, 43)
    assert.equal(ledger.billableUsageAudit('bill-late-after-restart').receipts.length, 1)
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('overview usage aggregates in SQLite, keeps unknowns null, and bounds provider and purpose groups', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-overview-usage-'))
  let ledger
  const start = Date.UTC(2025, 0, 1)
  const day = 86_400_000
  try {
    ledger = new ControlLedger(root)
    for (let index = 0; index < 101; index += 1) {
      const attempt = { ...input(`overview-attempt-${index}`, `overview-job-${index}`), provider: 'provider-a',
        model: `model-${String(index).padStart(3, '0')}`, now: start + index }
      ledger.beginAttempt(attempt)
      ledger.settleAttempt(attempt.id, 'complete', { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, cacheReadTokens: null,
        cacheWriteTokens: 1, reasoningTokens: 0, costMicros: 2 }, undefined, start + day + index)
    }
    ledger.beginAttempt({ ...input('overview-attempt-unknown', 'overview-job-unknown'), provider: 'provider-z', model: 'unknown-model', now: start + day + 1 })

    const known = ledger.overviewAttemptUsage('project-a', start, start + day)
    assert.equal(known.inputTokens, 1010)
    assert.equal(known.cacheReadTokens, 303, 'the aggregate keeps the legacy cached-input fallback')
    assert.equal(known.knownAttempts, 101)
    assert.equal(known.unknownAttempts, 0)
    assert.equal(known.byModel.length, 100, '99 model rows plus one merged remainder bound the DTO')
    const otherModel = known.byModel.find((item) => item.other)
    assert.equal(otherModel?.calls, 2)
    assert.equal(otherModel?.inputTokens, 20, 'the merged model group sums input tokens from omitted models')
    assert.equal(otherModel?.outputTokens, 8, 'the merged model group sums output tokens from omitted models')

    const withUnknown = ledger.overviewAttemptUsage('project-a', start, start + day * 2)
    assert.equal(withUnknown.inputTokens, null, 'an unknown attempt keeps the aggregate unknown')
    assert.equal(withUnknown.knownAttempts, 101)
    assert.equal(withUnknown.unknownAttempts, 1)
    assert.equal(withUnknown.byModel.find((item) => item.other)?.unknownCalls, 1)

    const knownCall = { id: 'overview-billable-known', projectKey: 'project-a', purpose: 'known-stage', budgetClass: 'manual',
      reservedTokens: 100, dailyTokenLimit: 1000, dailyTaskLimit: 10, now: start + 10 }
    ledger.reserveBillableCall(knownCall)
    ledger.settleBillableCall(knownCall.id, 'complete', { inputTokens: 70, outputTokens: 20 }, start + 11)
    const cancelledCall = { ...knownCall, id: 'overview-billable-cancelled', purpose: 'cancelled-stage', now: start + 12 }
    ledger.reserveBillableCall(cancelledCall)
    ledger.cancelBillableReservation(cancelledCall.id, start + 13)
    const unknownCall = { ...knownCall, id: 'overview-billable-unknown', purpose: 'unknown-stage', now: start + 14 }
    ledger.reserveBillableCall(unknownCall)
    ledger.settleBillableCall(unknownCall.id, 'complete', { inputTokens: 7 }, start + 15)

    const purposes = ledger.overviewBillableUsage('project-a', start, start + day).byPurpose
    assert.deepEqual(purposes.map((item) => item.purpose), ['known-stage', 'unknown-stage'])
    assert.equal(purposes[0].tokens, 90)
    assert.equal(purposes[1].tokens, null)
    assert.equal(purposes[1].unknownCalls, 1)

    const purposeRoot = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-overview-purposes-'))
    let purposeLedger
    try {
      purposeLedger = new ControlLedger(purposeRoot)
      for (let index = 0; index < 101; index += 1) {
        const purpose = `bounded-purpose-${String(index).padStart(3, '0')}`
        const call = { id: `bounded-purpose-call-${index}`, projectKey: 'project-purpose', purpose, budgetClass: 'manual',
          reservedTokens: 500, dailyTokenLimit: 10_000, dailyTaskLimit: 200, now: start + 200 + index }
        purposeLedger.reserveBillableCall(call)
        purposeLedger.settleBillableCall(call.id, 'complete', { inputTokens: index + 1, outputTokens: 1 }, start + 400 + index)
      }
      const boundedPurposes = purposeLedger.overviewBillableUsage('project-purpose', start, start + day).byPurpose
      const otherPurpose = boundedPurposes.find((item) => item.other)
      assert.equal(boundedPurposes.length, 100, '101 purpose groups return 99 rows and one merged remainder')
      assert.equal(otherPurpose?.calls, 2)
      assert.equal(otherPurpose?.tokens, 203, 'the other group sums actual tokens from both omitted purposes')
      assert.equal(otherPurpose?.unknownCalls, 0)
    } finally {
      purposeLedger?.close()
      rmSync(purposeRoot, { recursive: true, force: true })
    }
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('overview usage queries use project-scoped half-open time ranges and return empty aggregates for empty ranges', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-overview-window-'))
  const start = Date.UTC(2025, 2, 1)
  const end = start + 100
  let ledger
  try {
    ledger = new ControlLedger(root)
    const addAttempt = (id, projectKey, model, now, inputTokens) => {
      const attempt = { ...input(id, `job-${id}`), projectKey, provider: 'window-provider', model, now }
      ledger.beginAttempt(attempt)
      ledger.settleAttempt(id, 'complete', { inputTokens, outputTokens: 2, cachedInputTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, reasoningTokens: 0, costMicros: 0 }, undefined, now + 1)
    }
    addAttempt('window-start-a', 'project-a', 'inside', start, 10)
    addAttempt('window-end-a', 'project-a', 'at-end', end, 50)
    addAttempt('window-start-b', 'project-b', 'other-project', start + 50, 90)

    const a = ledger.overviewAttemptUsage('project-a', start, end)
    assert.equal(a.knownAttempts, 1)
    assert.equal(a.inputTokens, 10)
    assert.deepEqual(a.byModel.map((item) => item.model), ['inside'], 'the upper bound is exclusive')
    const b = ledger.overviewAttemptUsage('project-b', start, end)
    assert.equal(b.knownAttempts, 1)
    assert.equal(b.inputTokens, 90, 'another project row is not included')
    const empty = ledger.overviewAttemptUsage('project-a', end + 100, end + 200)
    assert.equal(empty.knownAttempts, 0)
    assert.equal(empty.unknownAttempts, 0)
    assert.equal(empty.inputTokens, 0)
    assert.deepEqual(empty.byModel, [])

    const addCall = (id, projectKey, purpose, now, inputTokens, outputTokens) => {
      const call = { id, projectKey, purpose, budgetClass: 'manual', reservedTokens: 100, dailyTokenLimit: 1000,
        dailyTaskLimit: 20, now }
      ledger.reserveBillableCall(call)
      ledger.settleBillableCall(id, 'complete', { inputTokens, outputTokens }, now + 1)
    }
    addCall('window-call-start-a', 'project-a', 'inside-purpose', start, 8, 2)
    addCall('window-call-end-a', 'project-a', 'at-end-purpose', end, 40, 10)
    addCall('window-call-start-b', 'project-b', 'other-project-purpose', start + 50, 3, 4)
    const purposesA = ledger.overviewBillableUsage('project-a', start, end).byPurpose
    assert.deepEqual(purposesA.map((item) => [item.purpose, item.tokens]), [['inside-purpose', 10]],
      'billable purpose aggregation also uses project scope and an exclusive upper bound')
    assert.deepEqual(ledger.overviewBillableUsage('project-b', start, end).byPurpose.map((item) => [item.purpose, item.tokens]),
      [['other-project-purpose', 7]])
    assert.deepEqual(ledger.overviewBillableUsage('project-a', end + 100, end + 200).byPurpose, [], 'empty ranges return no purpose groups')
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('overview SQL retains legacy finite-number normalization and cache-read fallback', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-control-overview-legacy-values-'))
  let ledger
  const start = Date.UTC(2025, 1, 1)
  try {
    ledger = new ControlLedger(root)
    for (const [id, model] of [['legacy-text', 'model-text'], ['legacy-cache', 'model-cache']]) {
      const attempt = { ...input(`overview-${id}`, `job-${id}`), model, now: start + 1 }
      ledger.beginAttempt(attempt)
      ledger.settleAttempt(attempt.id, 'complete', { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, cacheReadTokens: 4,
        cacheWriteTokens: 1, reasoningTokens: 0, costMicros: 2 }, undefined, start + 2)
    }
    ledger.db.prepare("UPDATE attempts SET input_tokens = 'unknown' WHERE id = ?").run('overview-legacy-text')
    ledger.db.prepare("UPDATE attempts SET cache_read_tokens = 'unknown', cached_input_tokens = 7, cost_micros = ? WHERE id = ?")
      .run(Number.POSITIVE_INFINITY, 'overview-legacy-cache')

    const usage = ledger.overviewAttemptUsage('project-a', start, start + 86_400_000)
    assert.equal(usage.inputTokens, null, 'nonnumeric historical token values remain unknown')
    assert.equal(usage.cacheReadTokens, 11, 'an invalid primary cache-read value falls back to the finite legacy cache field')
    assert.equal(usage.costMicros, null, 'non-finite historical values remain unknown')
    assert.equal(usage.knownAttempts, 0)
    assert.equal(usage.unknownAttempts, 2)

    for (const [id, purpose, actualTokens] of [['legacy-billable-text', 'legacy-text', 'unknown'],
      ['legacy-billable-infinite', 'legacy-infinite', Number.POSITIVE_INFINITY]]) {
      const call = { id, projectKey: 'project-a', purpose, budgetClass: 'manual', reservedTokens: 20,
        dailyTokenLimit: 1000, dailyTaskLimit: 10, now: start + 10 }
      ledger.reserveBillableCall(call)
      ledger.settleBillableCall(id, 'complete', { inputTokens: 2, outputTokens: 3 }, start + 11)
      ledger.db.prepare('UPDATE billable_calls SET actual_tokens = ? WHERE id = ?').run(actualTokens, id)
    }
    const byPurpose = ledger.overviewBillableUsage('project-a', start, start + 86_400_000).byPurpose
    assert.equal(byPurpose.find((item) => item.purpose === 'legacy-text')?.tokens, null)
    assert.equal(byPurpose.find((item) => item.purpose === 'legacy-text')?.unknownCalls, 1)
    assert.equal(byPurpose.find((item) => item.purpose === 'legacy-infinite')?.tokens, null)
    assert.equal(byPurpose.find((item) => item.purpose === 'legacy-infinite')?.unknownCalls, 1)
  } finally {
    ledger?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
