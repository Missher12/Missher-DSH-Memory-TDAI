import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { parseExtractionJson } from '../lib/extract.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { normalizeEffectiveStart } from '../lib/temporal.js'
import { openProjectStore } from '../lib/store.js'

function makeRuntime(root) {
  return new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
}

test('T1 keeps omitted, explicit unknown, and partial extraction times distinct through history', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-temporal-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const omitted = parseExtractionJson('{"memories":[{"content":"Synthetic omitted start","source_message_ids":["source-a"]}]}')
    const unknown = parseExtractionJson('{"memories":[{"content":"Synthetic unknown start","valid_from":null,"source_message_ids":["source-b"]}]}')
    const partial = parseExtractionJson('{"memories":[{"content":"Synthetic month start","valid_from":"2026-04","source_message_ids":["source-c"]}]}')
    assert.equal(omitted.ok && Object.hasOwn(omitted.memories[0], 'validFrom'), false)
    assert.equal(unknown.ok && unknown.memories[0].validFrom, null)
    assert.equal(partial.ok && partial.memories[0].validFrom, '2026-04')
    assert.deepEqual(normalizeEffectiveStart(undefined, 1234), { state: 'known', value: 1234, precision: 'instant', basis: 'default_record_time' })
    assert.deepEqual(normalizeEffectiveStart(null, 1234), { state: 'unknown', precision: 'unknown', basis: 'explicit_unknown' })

    const store = openProjectStore(root, project.key, project)
    const revisionSource = store.recordL0({ sessionId: 'temporal-session', role: 'user', content: 'Synthetic revision evidence.' })
    const defaultRecord = store.addMemory({ content: 'Synthetic default record time', status: 'approved', sourceMessageIds: [revisionSource], sourceVerified: true }).record
    const unknownRecord = store.addMemory({ content: 'Synthetic explicit unknown time', status: 'approved', validFrom: null }).record
    const partialRecord = store.addMemory({ content: 'Synthetic month precision time', status: 'approved', validFrom: '2026-04', sourceMessageIds: [revisionSource], sourceVerified: true }).record
    const currentMonthRecord = store.addMemory({ content: 'Synthetic current month start time', status: 'approved', validFrom: new Date().toISOString().slice(0, 7) }).record
    store.close()
    runtime = makeRuntime(root)

    const entries = runtime.knowledgeView(project.key).flatMap((group) => group.entries)
    assert.equal(entries.find((entry) => entry.id === defaultRecord.id)?.validFromBasis, 'default_record_time')
    assert.equal(entries.find((entry) => entry.id === unknownRecord.id)?.validFromState, 'unknown')
    assert.equal(entries.find((entry) => entry.id === partialRecord.id)?.validFromLabel, '2026-04')
    const inheritedRevision = runtime.proposeRevision(project.key, { memoryId: partialRecord.id, expectedRevision: partialRecord.revision,
      content: 'Synthetic non-temporal revision retains its month start.', sourceMessageIds: [revisionSource], reason: 'Synthetic text-only correction' })
    assert.equal(inheritedRevision.validFromLabel, '2026-04')
    runtime.reviewRevision(project.key, inheritedRevision.id, true)
    const explicitUnknownRevision = runtime.proposeRevision(project.key, { memoryId: defaultRecord.id, expectedRevision: defaultRecord.revision,
      content: 'Synthetic correction intentionally resets effective start.', sourceMessageIds: [revisionSource], reason: 'Synthetic explicit unknown start', validFrom: null })
    assert.equal(explicitUnknownRevision.validFromState, 'unknown')
    runtime.reviewRevision(project.key, explicitUnknownRevision.id, true)
    assert.equal(runtime.get(cwd, defaultRecord.id)?.validFromState, 'unknown')
    const history = await runtime.manageProjectOperation(project.key, 'knowledge.history', {
      id: partialRecord.id, effectiveAt: Date.UTC(2026, 3, 15), knownAt: Date.now(),
    })
    assert.equal(history.temporalConclusionUncertain, true)
    assert.equal(history.selected.validFromPrecision, 'month')
    const context = runtime.formatRecall(cwd, [{ record: unknownRecord, score: 1 }, { record: currentMonthRecord, score: 1 }])
    assert.match(context, /生效时间未知/u)
    assert.match(context, /当前时点仍在不确定区间/u)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('S1 revokes one stable Host event, preserves another event from the same Agent preset, and blocks replay', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-revoke-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const seed = openProjectStore(root, project.key, project)
    const sourceT = seed.recordL0({ sessionId: 'agent-session', role: 'user', content: 'Synthetic source T remains eligible.', agentPreset: 'agent-shared' })
    const memoryT = seed.addMemory({ content: 'Synthetic memory T remains visible.', status: 'approved', sourceMessageIds: [sourceT], sourceVerified: true }).record
    seed.close()
    runtime = makeRuntime(root)
    const session = { id: 'agent-session', header: { cwd, agentPreset: 'agent-shared' } }
    const original = { type: 'user/message', seq: 41, time: Date.now(), data: {
      role: 'user', content: [{ type: 'text', text: 'Synthetic source S must be revoked.' }], source: { kind: 'user' },
    } }
    runtime.onSessionEvent(session, original)
    const store = runtime.stores.get(project.key)
    const sourceS = store.unextracted(session.id).find((row) => row.content.includes('Synthetic source S'))
    assert.ok(sourceS?.sourceEventId)
    const memoryS = store.addMemory({ content: 'Synthetic memory S must disappear.', status: 'approved', sourceMessageIds: [sourceS.id], sourceVerified: true }).record

    const preview = await runtime.manageProjectOperation(project.key, 'source.revoke.preview', { sourceId: sourceS.id })
    assert.equal(preview.verifiable, true)
    await runtime.manageProjectOperation(project.key, 'source.revoke', { sourceId: sourceS.id })
    assert.equal(runtime.get(cwd, memoryS.id), undefined)
    assert.equal(runtime.get(cwd, memoryT.id)?.content, 'Synthetic memory T remains visible.')
    assert.equal(store.unextracted('agent-session').some((row) => row.id === sourceT), true)

    store.db.prepare('UPDATE l0_messages SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 86_400_000, sourceS.id)
    assert.equal(runtime.control.isSourceIdRevoked(project.key, sourceS.id), true)
    assert.equal(runtime.prune(1), 1)
    assert.equal(runtime.control.isSourceIdRevoked(project.key, sourceS.id), true)
    assert.equal(runtime.get(cwd, memoryS.id), undefined)
    runtime.onSessionEvent(session, original)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM l0_messages WHERE source_event_id = ?').get(sourceS.sourceEventId).n, 0)
    assert.equal(runtime.control.isSourceEventRevoked(project.key, sourceS.sourceEventId), true)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('S2 previews the source closure, fences before purge, removes selected offload, and preserves billable evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-delete-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const offloadId = 'off_0123456789abcdef01234567'
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const sourceId = store.recordL0({ sessionId: 'delete-session', role: 'user', content: 'Synthetic source selected for deletion.' })
    const selected = store.addMemory({ content: 'Synthetic directly selected memory.', status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true }).record
    const derived = store.addMemory({ content: 'Synthetic second memory sharing the source.', status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true }).record
    store.close()
    const offloadDirectory = path.join(root, 'offload', project.key)
    mkdirSync(offloadDirectory, { recursive: true })
    writeFileSync(path.join(offloadDirectory, `${offloadId}.txt`), 'Synthetic offload bytes.')
    runtime = makeRuntime(root)
    const now = Date.now()
    runtime.control.reserveBillableCall({ id: 'bill-delete-preserve', projectKey: project.key, purpose: 'synthetic', budgetClass: 'manual',
      reservedTokens: 100, dailyTokenLimit: 1000, dailyTaskLimit: 10, now })

    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', {
      memoryIds: [selected.id], offloadIds: [offloadId],
    })
    assert.equal(preview.selectedMemoryCount, 1)
    assert.equal(preview.derivedMemoryCount, 1)
    assert.ok(preview.sourceIds.includes(sourceId))
    await assert.rejects(runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [selected.id], offloadIds: [offloadId], previewToken: '0'.repeat(64), confirm: true,
    }), /impact changed/u)
    assert.ok(runtime.get(cwd, selected.id))

    await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [selected.id], offloadIds: [offloadId], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', selected.id), true)
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', derived.id), true)
    assert.equal(runtime.control.isContentDeleted(project.key, 'source', sourceId), true)
    assert.equal(runtime.get(cwd, selected.id), undefined)
    assert.equal(runtime.get(cwd, derived.id), undefined)
    assert.equal(runtime.control.getBillableCall('bill-delete-preserve')?.id, 'bill-delete-preserve')
    assert.equal(runtime.stores.get(project.key).sourceMessages([sourceId]).length, 0)
    assert.equal(pathExists(path.join(offloadDirectory, `${offloadId}.txt`)), false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R9 CR02 keeps a normally deleted Host event fenced after L0 retention and restore without revoking an identical sibling', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-replay-restore-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const seed = openProjectStore(root, project.key, project)
    seed.close()
    runtime = makeRuntime(root)
    const snapshot = await runtime.createRecoverySnapshot()
    const session = { id: 'replay-session', header: { cwd, agentPreset: 'fixture-agent' } }
    const oldTime = Date.now() - 2 * 86_400_000
    const event = { type: 'user/message', seq: 901, time: oldTime, data: {
      role: 'user', content: [{ type: 'text', text: 'Synthetic identical source event fenced across restore.' }], source: { kind: 'user' },
    } }
    const sibling = { type: 'user/message', seq: 902, time: oldTime, data: {
      role: 'user', content: [{ type: 'text', text: 'Synthetic identical source event fenced across restore.' }], source: { kind: 'user' },
    } }
    runtime.onSessionEvent(session, event)
    runtime.onSessionEvent(session, sibling)
    const store = runtime.stores.get(project.key)
    const source = store.unextracted(session.id).find((row) => row.createdAt === oldTime)
    const siblingSource = store.unextracted(session.id).find((row) => row.id !== source?.id)
    assert.ok(source?.sourceEventId)
    assert.ok(siblingSource?.sourceEventId)
    assert.notEqual(source.sourceEventId, siblingSource.sourceEventId)
    const memory = store.addMemory({ content: 'Synthetic memory derived from the retained event.', status: 'approved', sourceMessageIds: [source.id], sourceVerified: true }).record
    assert.equal(runtime.prune(1), 2, 'ordinary retention removes the two expired L0 bodies')
    assert.equal(store.sourceMessages([source.id]).length, 0)
    assert.equal(store.sourceIdentity(source.id)?.sourceEventId, source.sourceEventId, 'bodyless capture audit retains stable identity')
    assert.equal(runtime.dashboard().totals.approved, 1, 'dashboard keeps the retained Host event identity readable before a fence is written')

    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { memoryIds: [memory.id] })
    assert.ok(preview.sourceIds.includes(source.id))
    await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [memory.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', memory.id), true)
    assert.equal(runtime.control.isSourceEventDeleted(project.key, source.sourceEventId), true)
    assert.equal(runtime.control.isSourceEventRevoked(project.key, source.sourceEventId), false, 'content deletion remains distinct from revocation')

    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, true, plan.blockers.join('; '))
    await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    runtime.close()
    runtime = makeRuntime(root)
    runtime.onSessionEvent(session, event)
    runtime.onSessionEvent(session, sibling)
    const restoredStore = runtime.stores.get(project.key)
    assert.equal(restoredStore.db.prepare('SELECT COUNT(*) AS n FROM l0_messages WHERE source_event_id = ?').get(source.sourceEventId).n, 0)
    assert.equal(restoredStore.db.prepare('SELECT COUNT(*) AS n FROM l0_messages WHERE source_event_id = ?').get(siblingSource.sourceEventId).n, 1,
      'a different Host event with identical text remains eligible')
    assert.equal(runtime.control.isSourceEventDeleted(project.key, source.sourceEventId), true)
    assert.equal(runtime.control.isSourceEventRevoked(project.key, source.sourceEventId), false)
    assert.equal(runtime.dashboard().totals.approved, 0, 'dashboard reads the active recovery generation and preserved content fence')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R6 CR04 source deletion closes dependent memories but preserves descendants independent raw sources', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-delete-closure-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const sourceM = store.recordL0({ sessionId: 'source-m', role: 'user', content: 'Synthetic root memory source.' })
    const sourceD = store.recordL0({ sessionId: 'source-d', role: 'user', content: 'Synthetic independent descendant source.' })
    const relationEvidence = store.recordL0({ sessionId: 'relation-evidence', role: 'user', content: 'Synthetic dependency evidence.' })
    const unrelatedSource = store.recordL0({ sessionId: 'unrelated', role: 'user', content: 'Synthetic unrelated evaluation evidence.' })
    const rootMemory = store.addMemory({ content: 'Synthetic root memory.', status: 'approved', sourceMessageIds: [sourceM], sourceVerified: true }).record
    const descendant = store.addMemory({ content: 'Synthetic derived descendant.', status: 'approved', sourceMessageIds: [sourceD], sourceVerified: true }).record
    const unrelatedMemory = store.addMemory({ content: 'Synthetic unrelated memory.', status: 'approved', sourceMessageIds: [unrelatedSource], sourceVerified: true }).record
    const relation = store.proposeRelation({ fromId: descendant.id, toId: rootMemory.id, type: 'derived_from', evidenceIds: [relationEvidence] })
    store.reviewRelationCandidate(relation.id, true)
    const pairId = 'pair_content_delete_synthetic'
    store.saveEvaluationRun({ pairId, caseId: 'synthetic-delete-case', strategyId: 'builtin-v1', role: 'baseline',
      result: { hits: [rootMemory.id], missing: [], forbidden: [], hardGate: true, score: 1, stopReason: 'synthetic' } })
    store.saveEvaluationRun({ pairId, caseId: 'synthetic-delete-case', strategyId: 'builtin-v1', role: 'candidate',
      result: { hits: [], missing: [], forbidden: [], hardGate: true, score: 0, stopReason: 'synthetic' } })
    const unrelatedPairId = 'pair_unrelated_delete_control'
    store.saveEvaluationRun({ pairId: unrelatedPairId, caseId: 'unrelated-delete-case', strategyId: 'builtin-v1', role: 'baseline',
      result: { hits: [unrelatedMemory.id], missing: [], forbidden: [], hardGate: true, score: 1, stopReason: 'synthetic' } })
    store.close()
    runtime = makeRuntime(root)

    const relationEvidencePreview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { sourceIds: [relationEvidence] })
    assert.ok(relationEvidencePreview.memoryIds.includes(descendant.id), 'deleting dependency-only evidence includes the edge root')
    assert.ok(!relationEvidencePreview.memoryIds.includes(rootMemory.id), 'the independent dependency remains outside the selected impact')
    assert.ok(!relationEvidencePreview.sourceIds.includes(sourceD), 'the derived memory independent L0 source is preserved')
    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { sourceIds: [sourceM] })
    assert.ok(preview.memoryIds.includes(rootMemory.id))
    assert.ok(preview.memoryIds.includes(descendant.id))
    assert.equal(preview.evaluationRunCount, 2, 'the preview counts both rows of an affected saved pair')
    assert.ok(preview.sourceIds.includes(sourceM))
    assert.ok(!preview.sourceIds.includes(sourceD), 'descendant closure does not implicitly remove its independent L0 source')
    const result = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      sourceIds: [sourceM], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(result.cleanupStatus, 'complete')
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', rootMemory.id), true)
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', descendant.id), true)
    assert.equal(runtime.stores.get(project.key).sourceMessages([sourceD]).length, 1)
    assert.equal(runtime.stores.get(project.key).sourceMessages([sourceM]).length, 0)
    assert.equal(runtime.stores.get(project.key).evaluationRuns().some((run) => run.pairId === pairId), false,
      'deleting evidence referenced by one saved run removes its complete pair')
    assert.equal(runtime.stores.get(project.key).evaluationRuns().some((run) => run.pairId === unrelatedPairId), true,
      'a different project-local pair is not counted or removed')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R9 CR03A deletes generated descendant output while preserving its independent source, sibling fact, accounting, and attempt ownership', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-generated-output-delete-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const sourceS = store.recordL0({ sessionId: 'source-s', role: 'user', content: 'Synthetic selected raw source S.' })
    const sourceT = store.recordL0({ sessionId: 'source-t', role: 'user', content: 'Synthetic preserved raw source T confirms D was derived from M while N remains independent.' })
    const memoryM = store.addMemory({ content: 'Synthetic M derived from S.', status: 'approved', sourceMessageIds: [sourceS], sourceVerified: true }).record
    const memoryD = store.addMemory({ content: 'Synthetic D generated from T and derived from M.', status: 'approved', sourceMessageIds: [sourceT], sourceVerified: true }).record
    const memoryN = store.addMemory({ content: 'Synthetic independent N generated from T.', status: 'approved', sourceMessageIds: [sourceT], sourceVerified: true }).record
    const relation = store.proposeRelation({ fromId: memoryD.id, toId: memoryM.id, type: 'derived_from', evidenceIds: [sourceT] })
    store.reviewRelationCandidate(relation.id, true)
    const jobT = store.enqueueExtractionJob({ sessionId: 'source-t', sourceId: sourceT, policyRevision: 'fixture', quietMs: 0, maxWaitMs: 1000 })
    const attemptId = 'attempt-generated-descendant'
    const callId = 'bill-generated-descendant'
    const requestHash = 'e'.repeat(64)
    const inputHash = 'f'.repeat(64)
    const sourceDigest = createHash('sha256').update(sourceT).digest('hex')
    runtime = makeRuntime(root)
    runtime.control.reserveBillableCall({ id: callId, projectKey: project.key, purpose: 'extraction', budgetClass: 'automatic', reservedTokens: 100,
      dailyTokenLimit: 1000, dailyTaskLimit: 5, jobId: jobT.id, attemptId, provider: 'mock', model: 'mock-model', requestHash })
    runtime.control.beginAttempt({ id: attemptId, projectKey: project.key, jobId: jobT.id, provider: 'mock', model: 'mock-model', inputHash,
      requestHash, sourceDigest, sourceIds: [sourceT], billableCallId: callId })
    runtime.control.markBillableCallDispatched(callId)
    const usage = { inputTokens: 31, outputTokens: 17, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: 19 }
    runtime.control.settleBillableCall(callId, 'complete', usage)
    runtime.control.settleAttempt(attemptId, 'complete', usage)
    const responseText = 'Synthetic generated response contains D and N.'
    store.db.prepare(`UPDATE extraction_jobs SET status = 'completed', attempt_id = ?, input_snapshot = ?, input_hash = ?, response_text = ?, usage_json = ? WHERE id = ?`)
      .run(attemptId, JSON.stringify([{ id: sourceT, content: 'Synthetic preserved raw source T confirms D was derived from M while N remains independent.' }]), inputHash, responseText, JSON.stringify(usage), jobT.id)
    const saved = runtime.billableResults.save({ version: 1, callId, projectKey: project.key, purpose: 'extraction', provider: 'mock', model: 'mock-model',
      requestHash, responseText, usage, operation: { kind: 'extraction', projectKey: project.key, jobId: jobT.id, attemptId }, savedAt: Date.now() })
    runtime.control.registerBillableResponse({ callId, projectKey: project.key, purpose: 'extraction', provider: 'mock', model: 'mock-model', requestHash, sha256: saved.sha256 })
    store.close()

    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { memoryIds: [memoryM.id] })
    assert.ok(preview.memoryIds.includes(memoryD.id), 'derived D is included in the memory closure')
    assert.ok(!preview.memoryIds.includes(memoryN.id), 'independent N is outside the memory closure')
    assert.ok(!preview.sourceIds.includes(sourceT), 'T is not promoted into the raw-source deletion set')
    assert.ok(preview.relatedJobIds.includes(jobT.id), 'the job that generated D is captured in the durable cleanup scope')
    const result = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [memoryM.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(result.cleanupStatus, 'complete')
    const persisted = runtime.stores.get(project.key).getExtractionJob(jobT.id)
    assert.equal(persisted.status, 'completed')
    assert.equal(persisted.responseText, undefined)
    assert.deepEqual(persisted.inputSnapshot, [{ id: sourceT, content: 'Synthetic preserved raw source T confirms D was derived from M while N remains independent.' }])
    assert.equal(persisted.inputHash, inputHash)
    assert.equal(persisted.attemptId, attemptId)
    assert.deepEqual(persisted.usage, usage)
    assert.equal(runtime.stores.get(project.key).sourceMessages([sourceT]).length, 1)
    assert.equal(runtime.control.isContentDeleted(project.key, 'source', sourceT), false)
    assert.equal(runtime.get(cwd, memoryM.id), undefined)
    assert.equal(runtime.get(cwd, memoryD.id), undefined)
    assert.equal(runtime.get(cwd, memoryN.id)?.content, 'Synthetic independent N generated from T.')
    assert.equal(runtime.control.getBillableCall(callId)?.requestHash, requestHash)
    assert.equal(runtime.control.getBillableCall(callId)?.attemptId, attemptId)
    assert.equal(runtime.control.getBillableCall(callId)?.responseStatus, 'blocked')
    assert.deepEqual(runtime.control.getAttempt(attemptId)?.usage, usage, 'the attempt ledger preserves the complete extraction usage')
    assert.equal(runtime.control.getAttempt(attemptId)?.state, 'complete')
    assert.equal(runtime.billableResults.callIds().includes(callId), false, 'the response sidecar is removed while accounting evidence remains')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R9 CR04 reapplies a source deletion after recovery without deleting descendant-independent raw sources', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-delete-closure-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = makeRuntime(root)
    runtime.status(cwd)
    const store = runtime.stores.get(project.key)
    const sourceS = store.recordL0({ sessionId: 'recovery-source-s', role: 'user', content: 'Synthetic selected recovery source S.' })
    const sourceT = store.recordL0({ sessionId: 'recovery-source-t', role: 'user', content: 'Synthetic independent recovery source T supports D being derived from M while N remains independent.' })
    const memoryM = store.addMemory({ content: 'Synthetic recovery memory M from S.', status: 'approved', sourceMessageIds: [sourceS], sourceVerified: true }).record
    const memoryD = store.addMemory({ content: 'Synthetic recovery descendant D from T.', status: 'approved', sourceMessageIds: [sourceT], sourceVerified: true }).record
    const memoryN = store.addMemory({ content: 'Synthetic recovery independent fact N from T.', status: 'approved', sourceMessageIds: [sourceT], sourceVerified: true }).record
    const relation = runtime.proposeRelation(project.key, { fromId: memoryD.id, toId: memoryM.id, type: 'derived_from', evidenceIds: [sourceT] })
    runtime.reviewRelation(project.key, relation.id, true)
    const snapshot = await runtime.createRecoverySnapshot()

    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { sourceIds: [sourceS] })
    assert.ok(preview.memoryIds.includes(memoryM.id))
    assert.ok(preview.memoryIds.includes(memoryD.id))
    assert.ok(!preview.memoryIds.includes(memoryN.id))
    assert.ok(!preview.sourceIds.includes(sourceT))
    const deleted = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      sourceIds: [sourceS], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(deleted.cleanupStatus, 'complete')

    await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', memoryM.id), true)
    assert.equal(runtime.control.isContentDeleted(project.key, 'memory', memoryD.id), true)
    assert.equal(runtime.control.isContentDeleted(project.key, 'source', sourceS), true)
    assert.equal(runtime.control.isContentDeleted(project.key, 'source', sourceT), false)
    assert.equal(runtime.get(cwd, memoryM.id), undefined)
    assert.equal(runtime.get(cwd, memoryD.id), undefined)
    assert.equal(runtime.get(cwd, memoryN.id)?.content, 'Synthetic recovery independent fact N from T.')
    const restoredStore = runtime.stores.get(project.key)
    assert.equal(restoredStore.sourceMessages([sourceS]).length, 0)
    assert.equal(restoredStore.sourceMessages([sourceT]).length, 1)

    await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    assert.equal(runtime.get(cwd, memoryM.id), undefined)
    assert.equal(runtime.get(cwd, memoryD.id), undefined)
    assert.equal(runtime.get(cwd, memoryN.id)?.content, 'Synthetic recovery independent fact N from T.')
    const repeatedStore = runtime.stores.get(project.key)
    assert.equal(repeatedStore.sourceMessages([sourceS]).length, 0)
    assert.equal(repeatedStore.sourceMessages([sourceT]).length, 1)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R6 CR05 purges terminal extraction bodies and a global persona response that cites selected content', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-delete-bodies-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const completedSource = store.recordL0({ sessionId: 'completed-session', role: 'user', content: 'Synthetic completed job source.' })
    const failedSource = store.recordL0({ sessionId: 'failed-session', role: 'user', content: 'Synthetic failed job source.' })
    const memory = store.addMemory({ content: 'Synthetic selected memory tied to both job sources.', status: 'approved',
      sourceMessageIds: [completedSource, failedSource], sourceVerified: true }).record
    const completed = store.enqueueExtractionJob({ sessionId: 'completed-session', sourceId: completedSource, policyRevision: 'fixture', quietMs: 0, maxWaitMs: 1000 })
    const failed = store.enqueueExtractionJob({ sessionId: 'failed-session', sourceId: failedSource, policyRevision: 'fixture', quietMs: 0, maxWaitMs: 1000 })
    store.db.prepare("UPDATE extraction_jobs SET status = 'completed', input_snapshot = ?, response_text = ? WHERE id = ?")
      .run('[{"content":"Synthetic private request body."}]', 'Synthetic private completed response.', completed.id)
    store.db.prepare("UPDATE extraction_jobs SET status = 'failed', input_snapshot = ?, response_text = ? WHERE id = ?")
      .run('[{"content":"Synthetic private failed request body."}]', 'Synthetic private failed response.', failed.id)
    store.close()
    runtime = makeRuntime(root)
    runtime.billableResults.save({ version: 1, callId: 'bill-global-selected', projectKey: '*', purpose: 'global_persona', provider: 'mock', model: 'mock-model',
      requestHash: 'd'.repeat(64), responseText: 'Synthetic private global persona response.',
      usage: { inputTokens: 10, outputTokens: 8, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: null },
      operation: { kind: 'global_persona', projectKey: '*', projects: [project.key], sources: [{ projectKey: project.key, id: memory.id, revision: 1 }], sourceCount: 1 }, savedAt: Date.now() })

    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { memoryIds: [memory.id] })
    const result = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [memory.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(result.cleanupStatus, 'complete')
    const jobs = runtime.stores.get(project.key).db.prepare('SELECT id, status, input_snapshot, response_text FROM extraction_jobs WHERE id IN (?, ?)')
      .all(completed.id, failed.id)
    assert.deepEqual(jobs.map((job) => job.status).sort(), ['completed', 'failed'])
    assert.ok(jobs.every((job) => job.input_snapshot === '[]' && job.response_text === null))
    assert.ok(!runtime.billableResults.callIds().includes('bill-global-selected'))
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R6 CR06 revoking one source in a dispatched sibling job keeps the other source owned without requeueing paid work', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-revoke-paid-sibling-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = makeRuntime(root)
    const session = { id: 'paid-sibling-session', header: { cwd, agentPreset: 'fixture-agent' } }
    const eventS = { type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: 'Synthetic revoked sibling S.' }], source: { kind: 'user' } } }
    const eventT = { type: 'user/message', seq: 2, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: 'Synthetic preserved sibling T.' }], source: { kind: 'user' } } }
    runtime.onSessionEvent(session, eventS)
    runtime.onSessionEvent(session, eventT)
    const store = runtime.stores.get(project.key)
    const sourceS = store.unextracted(session.id).find((row) => row.content.includes('revoked sibling S'))
    const sourceT = store.unextracted(session.id).find((row) => row.content.includes('preserved sibling T'))
    assert.ok(sourceS?.sourceEventId)
    assert.ok(sourceT?.sourceEventId)
    const memoryS = store.addMemory({ content: 'Synthetic revoked memory.', status: 'approved', sourceMessageIds: [sourceS.id], sourceVerified: true }).record
    const memoryT = store.addMemory({ content: 'Synthetic preserved memory.', status: 'approved', sourceMessageIds: [sourceT.id], sourceVerified: true }).record
    const job = store.enqueueExtractionJob({ sessionId: session.id, sourceId: sourceS.id, policyRevision: 'fixture', quietMs: 0, maxWaitMs: 1000 })
    store.enqueueExtractionJob({ sessionId: session.id, sourceId: sourceT.id, policyRevision: 'fixture', quietMs: 0, maxWaitMs: 1000 })
    store.db.prepare("UPDATE extraction_jobs SET status = 'dispatching', attempt_id = 'attempt-synthetic-paid', input_snapshot = ? WHERE id = ?")
      .run(JSON.stringify([{ id: sourceS.id, content: 'Synthetic dispatched source S.' }, { id: sourceT.id, content: 'Synthetic dispatched source T.' }]), job.id)

    await runtime.manageProjectOperation(project.key, 'source.revoke', { sourceId: sourceS.id })
    const persisted = store.getExtractionJob(job.id)
    assert.equal(persisted.status, 'blocked_charged')
    assert.deepEqual(persisted.inputSnapshot, [])
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM extraction_job_sources WHERE job_id = ? AND source_id = ?').get(job.id, sourceS.id).n, 0)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM extraction_job_sources WHERE job_id = ? AND source_id = ?').get(job.id, sourceT.id).n, 1)
    assert.equal(store.queuedExtractionJob(session.id, Date.now(), true), undefined)
    assert.equal(runtime.get(cwd, memoryS.id), undefined)
    assert.equal(runtime.get(cwd, memoryT.id)?.content, 'Synthetic preserved memory.')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R6 CR07 resumes a persisted partial delete intent after R6 CR08 rejects a replaced symlink ancestor', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-delete-retry-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const offloadId = 'off_abcdef0123456789abcdef01'
  const offloadDirectory = path.join(root, 'offload', project.key)
  const heldDirectory = path.join(root, 'offload-held', project.key)
  const outsideDirectory = path.join(root, 'outside-project')
  let runtime
  try {
    mkdirSync(offloadDirectory, { recursive: true })
    mkdirSync(outsideDirectory, { recursive: true })
    writeFileSync(path.join(offloadDirectory, `${offloadId}.txt`), 'Synthetic selected offload.')
    writeFileSync(path.join(outsideDirectory, `${offloadId}.txt`), 'Synthetic protected outside file.')
    runtime = makeRuntime(root)
    runtime.status(cwd)
    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { offloadIds: [offloadId] })

    const removeOffloadContent = runtime.removeOffloadContent.bind(runtime)
    let replacedAtCleanup = false
    runtime.removeOffloadContent = (...args) => {
      if (!replacedAtCleanup) {
        renameSync(path.dirname(offloadDirectory), path.dirname(heldDirectory))
        mkdirSync(path.dirname(offloadDirectory), { recursive: true })
        symlinkSync(outsideDirectory, offloadDirectory, 'dir')
        replacedAtCleanup = true
      }
      return removeOffloadContent(...args)
    }
    const partial = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      offloadIds: [offloadId], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(replacedAtCleanup, true, 'the simulated filesystem race starts only after the deletion fence is written')
    assert.equal(partial.cleanupStatus, 'partial')
    assert.ok(partial.remaining.includes('offloads'))
    assert.equal(runtime.control.isContentDeleted(project.key, 'offload', offloadId), true, 'durable fence commits before filesystem cleanup')
    assert.equal(readFileSync(path.join(outsideDirectory, `${offloadId}.txt`), 'utf8'), 'Synthetic protected outside file.')

    rmSync(offloadDirectory)
    renameSync(path.dirname(heldDirectory), path.dirname(offloadDirectory))
    const resumed = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      offloadIds: [offloadId], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(resumed.cleanupStatus, 'complete')
    assert.equal(existsSync(path.join(offloadDirectory, `${offloadId}.txt`)), false)
    assert.equal(existsSync(path.join(outsideDirectory, `${offloadId}.txt`)), true)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R6 C1 invalidates approved evaluation hits, task continuity, and experience cards after source revocation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-c1-source-revoke-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = makeRuntime(root)
    const session = { id: 'c1-session', header: { cwd, agentPreset: 'fixture-agent' } }
    const event = { type: 'user/message', seq: 51, time: Date.now(), data: {
      role: 'user', content: [{ type: 'text', text: 'Synthetic approved fact subject to source revocation.' }], source: { kind: 'user' },
    } }
    runtime.onSessionEvent(session, event)
    const store = runtime.stores.get(project.key)
    const source = store.unextracted(session.id).find((row) => row.content.includes('subject to source revocation'))
    const memory = store.addMemory({ content: 'Synthetic approved fact subject to source revocation.', status: 'approved',
      sourceMessageIds: [source.id], sourceVerified: true }).record
    runtime.saveTaskContext(project.key, { taskRef: 'task-revoked-source', goal: 'Synthetic task based on revocable evidence.', sourceMemoryIds: [memory.id] })
    runtime.saveExperience(project.key, { id: 'exp-revoked-source', title: 'Synthetic experience based on revocable evidence.',
      symptom: 'synthetic', environment: {}, steps: ['verify evidence'], outcomes: ['stale after revoke'], evidenceMemoryIds: [memory.id] })
    runtime.saveEvaluationCase(project.key, { id: 'eval-revoked-source', title: 'Synthetic revoked source case', query: 'approved revocable evidence',
      expectedIds: [memory.id], forbiddenIds: [], source: 'approved', fixture: { effectiveAt: Date.now() + 1000, knownAt: Date.now() + 1000 } })
    const priorEvaluation = runtime.evaluateCase(project.key, 'eval-revoked-source')
    assert.match(priorEvaluation.baseline.result.renderedPacket, /Synthetic approved fact subject to source revocation/u)

    await runtime.manageProjectOperation(project.key, 'source.revoke', { sourceId: source.id })
    assert.equal(store.evaluationRuns().length, 0, 'the old pair packet is removed with the revoked memory evidence')
    const evaluation = runtime.evaluateCase(project.key, 'eval-revoked-source').baseline.result
    assert.ok(!evaluation.hits.includes(memory.id))
    assert.ok(evaluation.missing.includes(memory.id))
    assert.ok(evaluation.filterReasons.some((item) => item.id === memory.id))
    assert.equal(runtime.taskContexts(project.key).find((item) => item.taskRef === 'task-revoked-source').redacted, true)
    assert.deepEqual(runtime.experienceCards(project.key), [])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R9 C1-01 evaluation uses current source permission while retaining legal historical valid-to views', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-c1-current-eval-permission-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = makeRuntime(root)
    runtime.status(cwd)
    const store = runtime.stores.get(project.key)
    const recordedBefore = Date.now() - 20_000
    const sourceT = store.recordL0({ sessionId: 'history-source-t', role: 'user', content: 'Synthetic V1 evidence remains eligible.', createdAt: recordedBefore })
    const wallClock = Date.now
    Date.now = () => recordedBefore
    let memory
    try {
      memory = store.addMemory({ content: 'Synthetic V1 historical value is independently searchable.', status: 'approved', validFrom: recordedBefore,
        sourceMessageIds: [sourceT], sourceVerified: true }).record
    } finally { Date.now = wallClock }
    const session = { id: 'history-source-s', header: { cwd, agentPreset: 'fixture-agent' } }
    const revokedEvent = { type: 'user/message', seq: 701, time: Date.now(), data: {
      role: 'user', content: [{ type: 'text', text: 'Synthetic V2 adds revocable evidence.' }], source: { kind: 'user' },
    } }
    runtime.onSessionEvent(session, revokedEvent)
    const sourceS = store.unextracted(session.id).find((row) => row.content.includes('V2 adds revocable'))
    assert.ok(sourceS?.sourceEventId)
    const revision = runtime.proposeRevision(project.key, { memoryId: memory.id, expectedRevision: memory.revision,
      content: 'Synthetic V2 changes the current value and includes revocable evidence.', sourceMessageIds: [sourceT, sourceS.id],
      reason: 'Synthetic V2 adds a separately revocable source.' })
    runtime.reviewRevision(project.key, revision.id, true)
    const historicalAt = recordedBefore + 5_000
    const knownBeforeV2 = recordedBefore + 10_000
    runtime.saveEvaluationCase(project.key, { id: 'c1-current-source-permission', title: 'Synthetic historical current permission',
      query: 'V1 historical value independently searchable', expectedIds: [memory.id], forbiddenIds: [], source: 'approved',
      fixture: { effectiveAt: historicalAt, knownAt: knownBeforeV2 } })
    await runtime.manageProjectOperation(project.key, 'source.revoke', { sourceId: sourceS.id })

    const history = await runtime.manageProjectOperation(project.key, 'knowledge.history', { id: memory.id, effectiveAt: historicalAt, knownAt: knownBeforeV2 })
    assert.equal(history, undefined, 'current V2 source revocation closes historical access through normal history')
    const result = runtime.evaluateCase(project.key, 'c1-current-source-permission').baseline.result
    assert.equal(result.hits.includes(memory.id), false, 'evaluation does not fall back to readable V1 using the historic effectiveAt as current')
    assert.equal(result.missing.includes(memory.id), true)

    const setupClock = Date.now
    const savedAt = setupClock()
    const validTo = savedAt + 1_000
    const historicalEffectiveAt = savedAt - 500
    let validMemory
    try {
      Date.now = () => savedAt
      validMemory = store.addMemory({ content: 'Synthetic memory valid before its ended current valid-to.', status: 'approved',
        validFrom: recordedBefore, validTo }).record
      runtime.saveEvaluationCase(project.key, { id: 'c1-ended-valid-to-history', title: 'Synthetic ended valid-to history',
        query: 'valid before ended current valid-to', expectedIds: [validMemory.id], forbiddenIds: [], source: 'approved',
        fixture: { effectiveAt: historicalEffectiveAt, knownAt: savedAt } })
    } finally { Date.now = setupClock }

    try {
      Date.now = () => validTo + 500
      const validHistory = await runtime.manageProjectOperation(project.key, 'knowledge.history', {
        id: validMemory.id, effectiveAt: historicalEffectiveAt, knownAt: savedAt,
      })
      assert.equal(validHistory.selected.memoryId, validMemory.id, 'an ended current valid-to does not erase legal prior history')
      assert.equal(validHistory.selected.revision, validMemory.revision, 'history returns the expected legal revision')
      assert.equal(validHistory.selected.id, `${validMemory.id}:r${validMemory.revision}`, 'the selected revision keeps its revision identity')
      const validEvaluation = runtime.evaluateCase(project.key, 'c1-ended-valid-to-history').baseline.result
      assert.equal(validEvaluation.hits.includes(validMemory.id), true, 'evaluation selects the historically valid version while current approval remains intact')
    } finally { Date.now = setupClock }
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R9 C1-02 evaluation packet reads mask an entire pair after current dependency permission changes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-packet-read-permission-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = makeRuntime(root)
    runtime.status(cwd)
    const store = runtime.stores.get(project.key)
    const now = Date.now()
    const rootSource = store.recordL0({ sessionId: 'packet-root', role: 'user', content: 'Synthetic packet root evidence.' })
    const dependencySource = store.recordL0({ sessionId: 'packet-dependency', role: 'user', content: 'Synthetic packet dependency evidence.' })
    const relationSource = store.recordL0({ sessionId: 'packet-relation', role: 'user', content: 'Synthetic packet dependency relation evidence.' })
    const rootMemory = store.addMemory({ content: 'Synthetic approved packet root searchable fact.', status: 'approved', validFrom: now - 1000,
      sourceMessageIds: [rootSource], sourceVerified: true }).record
    const dependency = store.addMemory({ content: 'Synthetic approved packet dependency context.', status: 'approved', validFrom: now - 1000,
      sourceMessageIds: [dependencySource], sourceVerified: true }).record
    const relation = runtime.proposeRelation(project.key, { fromId: rootMemory.id, toId: dependency.id, type: 'depends_on', evidenceIds: [relationSource] })
    runtime.reviewRelation(project.key, relation.id, true)
    runtime.saveEvaluationCase(project.key, { id: 'packet-read-permission-case', title: 'Synthetic persistent packet permission',
      query: 'approved packet root searchable fact', expectedIds: [rootMemory.id], forbiddenIds: [], source: 'approved',
      fixture: { effectiveAt: now + 1000, knownAt: now + 1000 } })
    const pair = runtime.evaluateCase(project.key, 'packet-read-permission-case')
    assert.equal(pair.baseline.result.hits.includes(rootMemory.id), true)
    assert.ok(pair.baseline.result.renderedPacketSourceRefs.some((ref) => ref.projectKey === project.key && ref.id === rootMemory.id))
    assert.ok(pair.baseline.result.renderedPacketSourceRefs.some((ref) => ref.projectKey === project.key && ref.id === dependency.id),
      'transitive dependency identity is included in packet provenance')
    const firstPageBefore = await runtime.manageProjectOperation(project.key, 'evaluation.list', { limit: 1 })
    assert.equal(firstPageBefore.runs[0].result.renderedPacketAvailable, true)
    assert.ok(firstPageBefore.runs[0].result.renderedPacket.length > 0)

    runtime.control.fenceContentDeletion({ projectKey: project.key, requestDigest: 'c'.repeat(64), memoryIds: [dependency.id], sourceIds: [],
      selectedMemoryIds: [dependency.id], selectedSourceIds: [], sourceEventIds: [] })
    const firstPageAfter = await runtime.manageProjectOperation(project.key, 'evaluation.list', { limit: 1 })
    assert.equal(firstPageAfter.runs[0].result.renderedPacketAvailable, false)
    assert.equal(firstPageAfter.runs[0].result.renderedPacket, '')
    const secondPageAfter = await runtime.manageProjectOperation(project.key, 'evaluation.list', { after: firstPageAfter.next, limit: 1 })
    assert.equal(secondPageAfter.runs[0].result.renderedPacketAvailable, false,
      'the counterpart on a different page is masked with the affected side')
    assert.equal(secondPageAfter.runs[0].result.renderedPacket, '')
    const strategies = await runtime.manageProjectOperation(project.key, 'strategy.list')
    assert.ok(strategies.runs.filter((run) => run.pairId === pair.baseline.pairId).every((run) => run.result.renderedPacketAvailable === false))
    assert.ok(strategies.runs.filter((run) => run.pairId === pair.baseline.pairId).every((run) => run.result.renderedPacket === ''))

    runtime.saveEvaluationCase(project.key, { id: 'packet-synthetic-same-id', title: 'Synthetic fixture with colliding ID',
      query: 'synthetic fixture text remains independent', expectedIds: [rootMemory.id], forbiddenIds: [], source: 'synthetic',
      fixture: { effectiveAt: now + 1000, knownAt: now + 1000, records: [{ id: rootMemory.id, content: 'Synthetic fixture text remains independent',
        recordedAt: now, validFrom: now - 1000, sourceVerified: true }] } })
    const synthetic = runtime.evaluateCase(project.key, 'packet-synthetic-same-id').baseline.result
    assert.equal(synthetic.renderedPacketSourceKind, 'synthetic')
    assert.equal(synthetic.renderedPacketProvenance, 'complete')
    assert.equal(synthetic.renderedPacketAvailable, true, 'synthetic fixture content does not inherit permission from a colliding approved ID')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R8 source revocation of dependency-only relation evidence keeps derived memories unreadable', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-relation-evidence-revoke-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = makeRuntime(root)
    runtime.status(cwd)
    const store = runtime.stores.get(project.key)
    const now = Date.now()
    const derivedSource = store.recordL0({ sessionId: 'derived-source', role: 'user', content: 'Synthetic independent source for derived memory.' })
    const dependencySource = store.recordL0({ sessionId: 'dependency-source', role: 'user', content: 'Synthetic independent dependency source.' })
    const derived = store.addMemory({ content: 'Synthetic derived memory guarded by relation evidence.', status: 'approved', validFrom: now - 1000,
      sourceMessageIds: [derivedSource], sourceVerified: true }).record
    const dependency = store.addMemory({ content: 'Synthetic dependency memory remains independently readable.', status: 'approved', validFrom: now - 1000,
      sourceMessageIds: [dependencySource], sourceVerified: true }).record
    const session = { id: 'relation-evidence-session', header: { cwd, agentPreset: 'fixture-agent' } }
    runtime.onSessionEvent(session, { type: 'user/message', seq: 61, time: now, data: {
      role: 'user', content: [{ type: 'text', text: 'Synthetic dependency relation evidence to revoke.' }], source: { kind: 'user' },
    } })
    const relationSource = store.unextracted(session.id).find((row) => row.content.includes('relation evidence to revoke'))
    assert.ok(relationSource)
    const relation = runtime.proposeRelation(project.key, { fromId: derived.id, toId: dependency.id, type: 'depends_on', evidenceIds: [relationSource.id] })
    runtime.reviewRelation(project.key, relation.id, true)
    runtime.saveTaskContext(project.key, { taskRef: 'relation-evidence-task', goal: 'Synthetic task dependent on relation evidence.', sourceMemoryIds: [derived.id] })
    runtime.saveExperience(project.key, { id: 'relation-evidence-experience', title: 'Synthetic relation evidence experience', symptom: 'fixture', environment: {},
      steps: ['check relation'], outcomes: ['evidence revocation hides derived result'], evidenceMemoryIds: [derived.id] })
    runtime.saveEvaluationCase(project.key, { id: 'relation-evidence-case', title: 'Synthetic relation evidence evaluation', query: 'derived memory guarded by relation evidence',
      expectedIds: [derived.id], forbiddenIds: [], source: 'approved', fixture: { effectiveAt: now + 1000, knownAt: now + 1000 } })
    const prior = runtime.evaluateCase(project.key, 'relation-evidence-case')
    assert.ok(prior.baseline.result.hits.includes(derived.id))

    const preview = await runtime.manageProjectOperation(project.key, 'source.revoke.preview', { sourceId: relationSource.id })
    assert.ok(preview.affectedMemories >= 1, 'preview includes memories whose dependency relation uses this evidence')
    await runtime.manageProjectOperation(project.key, 'source.revoke', { sourceId: relationSource.id })

    assert.equal(store.get(derived.id)?.status, 'approved', 'the independent memory row is retained')
    assert.equal(runtime.get(cwd, derived.id), undefined, 'removing its relation evidence does not make the derived memory readable')
    assert.equal(runtime.get(cwd, dependency.id)?.id, dependency.id, 'the independent dependency remains readable')
    assert.equal(store.evaluationRuns().length, 0, 'the saved pair packet is removed because the derived memory became unreadable')
    assert.equal(runtime.taskContexts(project.key).find((item) => item.taskRef === 'relation-evidence-task').redacted, true)
    assert.deepEqual(runtime.experienceCards(project.key), [])
    const after = runtime.evaluateCase(project.key, 'relation-evidence-case').baseline.result
    assert.equal(after.hits.includes(derived.id), false)
    assert.ok(after.sourceIssues.includes(`${derived.id}:dependency_unreadable_at_temporal_view`))
    assert.equal(after.hardGate, false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R6 UI03 evaluation history uses a stable cursor and preserves pair identity across pages', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-evaluation-pages-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    store.saveEvaluationRun({ pairId: 'pair_synthetic_history', caseId: 'case-a', strategyId: 'builtin-v1', role: 'baseline',
      result: { hits: [], missing: [], forbidden: [], hardGate: true, score: 1, stopReason: 'synthetic' } }, 500)
    store.saveEvaluationRun({ pairId: 'pair_synthetic_history', caseId: 'case-a', strategyId: 'builtin-v1', role: 'candidate',
      result: { hits: [], missing: [], forbidden: [], hardGate: true, score: 1, stopReason: 'synthetic' } }, 500)
    store.close()
    runtime = makeRuntime(root)
    const first = await runtime.manageProjectOperation(project.key, 'evaluation.list', { limit: 1 })
    assert.equal(first.runs.length, 1)
    assert.ok(first.next)
    const second = await runtime.manageProjectOperation(project.key, 'evaluation.list', { after: first.next, limit: 1 })
    assert.equal(second.runs.length, 1)
    assert.equal(second.runs[0].pairId, first.runs[0].pairId)
    assert.notEqual(second.runs[0].id, first.runs[0].id)
    assert.equal(second.next, undefined)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R8 forget through the direct API removes saved paired evaluation packets', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-forget-evaluation-pair-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const personaSourceCwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-persona-source-project-'))
  const project = projectIdentity(cwd)
  const personaSourceProject = projectIdentity(personaSourceCwd)
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ persona: { global: true }, recall: { includePersona: true } }), root)
    runtime.status(cwd)
    runtime.status(personaSourceCwd)
    const store = runtime.stores.get(project.key)
    const personaSourceStore = runtime.stores.get(personaSourceProject.key)
    const now = Date.now()
    const sourceId = personaSourceStore.recordL0({ sessionId: 'persona-source-session', role: 'user', content: 'Synthetic cross-project persona source.' })
    const personaMemory = personaSourceStore.addMemory({ content: 'Synthetic cross-project persona source.', status: 'approved', validFrom: now - 1000,
      sourceMessageIds: [sourceId], sourceVerified: true }).record
    mkdirSync(path.join(root, 'global'), { recursive: true })
    writeFileSync(path.join(root, 'global', 'persona.json'), `${JSON.stringify({ content: 'Synthetic cross-project persona secret.', sourceCount: 1, updatedAt: now,
      stale: false, sources: [{ projectKey: personaSourceProject.key, id: personaMemory.id, revision: personaMemory.revision }] })}\n`)
    const memory = store.addMemory({ content: 'Synthetic approved local evaluation fact.', status: 'approved', validFrom: now - 1000 }).record
    runtime.saveEvaluationCase(project.key, { id: 'forget-packet-case', title: 'Synthetic forget packet case', query: 'approved local evaluation fact',
      expectedIds: [memory.id], forbiddenIds: [], source: 'approved', fixture: { effectiveAt: now + 1000, knownAt: now + 1000 } })
    const pair = runtime.evaluateCase(project.key, 'forget-packet-case')
    assert.equal(pair.baseline.result.hits.includes(memory.id), true)
    assert.match(pair.baseline.result.renderedPacket, /Synthetic cross-project persona secret/u)
    assert.ok(pair.baseline.result.renderedPacketSourceRefs.some((ref) => ref.projectKey === personaSourceProject.key && ref.id === personaMemory.id))
    assert.equal(store.evaluationRuns().length, 2)
    const deletionPreview = await runtime.manageProjectOperation(personaSourceProject.key, 'content.delete.preview', { memoryIds: [personaMemory.id] })
    assert.equal(deletionPreview.evaluationRunCount, 2, 'the source-project preview counts saved packets in other project stores')

    runtime.forget(personaSourceCwd, personaMemory.id)
    assert.equal(store.evaluationRuns().length, 0)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    rmSync(personaSourceCwd, { recursive: true, force: true })
  }
})

function pathExists(file) {
  return existsSync(file)
}
