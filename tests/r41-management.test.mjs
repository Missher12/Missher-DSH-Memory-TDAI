import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { globalMemoryKey } from '../lib/global-memory.js'
import { projectIdentity } from '../lib/project.js'
import { OverviewResultSchema } from '../lib/remote-contract.js'
import { openProjectStore } from '../lib/store.js'
import { registerMemoryTools } from '../lib/tools.js'
import { estimateTokens } from '../lib/tokens.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

test('C1 management RPC preserves complete task and experience records locally', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-management-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const evidenceSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Synthetic evidence for the local experience case.' })
    const evidenceMemory = store.addMemory({
      content: 'Synthetic approved evidence for local experience.', status: 'approved', sourceMessageIds: [evidenceSource], sourceVerified: true,
    }).record
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)

    const task = await runtime.manageProjectOperation(project.key, 'task.save', {
      taskRef: 'task-42', goal: 'Finish the migration', constraints: ['preserve ids'], completed: ['inventory'], pending: ['reconcile counts'],
      knownUnknowns: ['old provider usage'], confirmedFacts: ['new path is isolated'], assumptions: ['no host install'], blockers: ['approval window'],
      artifactRefs: [{ ref: 'reports/migration.md', hash: 'sha256:abc', revision: 'rev-3' }], status: 'paused',
    })
    assert.deepEqual(task.artifactRefs, [{ ref: 'reports/migration.md', hash: 'sha256:abc', revision: 'rev-3' }])
    assert.deepEqual(task.constraints, ['preserve ids'])
    assert.deepEqual(task.knownUnknowns, ['old provider usage'])
    const listedTask = runtime.taskContexts(project.key)[0]
    assert.equal(listedTask.artifactRefsVerification, 'unavailable')
    assert.deepEqual(listedTask.blockers, ['approval window'])

    const knowledge = runtime.knowledgeView(project.key)
    const detail = await runtime.manageProjectOperation(project.key, 'knowledge.detail', { id: evidenceMemory.id })
    assert.equal(knowledge.flatMap((group) => group.entries).some((entry) => entry.id === evidenceMemory.id && !('content' in entry)), true)
    assert.equal(detail.memory.content, 'Synthetic approved evidence for local experience.')
    assert.equal(detail.revisions[0].revision, evidenceMemory.revision)
    assert.equal(detail.sources[0].content, 'Synthetic evidence for the local experience case.')

    await assert.rejects(runtime.manageProjectOperation(project.key, 'task.save', {
      taskRef: 'task-invalid', goal: 'Invalid reference', artifactRefs: [{ ref: '' }],
    }), /artifactRefs\[0\]\.ref/u)
    await assert.rejects(runtime.manageProjectOperation(project.key, 'experience.save', {
      title: 'Invalid environment', symptom: 'test', environment: { runtime: 22 }, steps: [], outcomes: [], evidenceMemoryIds: [],
    }), /keys must be/u)

    const experience = await runtime.manageProjectOperation(project.key, 'experience.save', {
      title: 'Cache recovery', symptom: 'stale cache after path change', environment: { os: 'linux', runtime: 'node-22' },
      prerequisites: ['path has moved'], steps: ['clear derived index'], outcomes: ['index rebuilt'],
      counterexamples: ['does not apply when source rows are missing'], evidenceMemoryIds: [evidenceMemory.id],
    })
    assert.deepEqual(experience.prerequisites, ['path has moved'])
    assert.deepEqual(experience.counterexamples, ['does not apply when source rows are missing'])
    assert.equal(runtime.experience(cwd, 'cache recovery', { os: 'linux', runtime: 'node-22' }, 10)[0]?.applicability, 'conditions_missing')
    assert.equal(runtime.experience(cwd, 'cache recovery does not apply when source rows are missing', {}, 10)[0]?.applicability, 'known_counterexample')

    const updated = await runtime.manageProjectOperation(project.key, 'experience.counterexample', {
      id: experience.id, counterexample: 'Windows path casing needs a separate check',
    })
    assert.equal(updated.status, 'candidate')
    assert.equal(updated.counterexamples.at(-1), 'Windows path casing needs a separate check')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('A recovery snapshot records raw schema and refuses a corrupt project database before staging', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    store.addMemory({ content: 'Synthetic recovery fixture.', status: 'approved' })
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)

    const snapshot = await runtime.createRecoverySnapshot()
    assert.equal(snapshot.manifest.version, 3)
    assert.equal(snapshot.manifest.rawSchemas.projects[0].projectKey, project.key)
    assert.equal(snapshot.verified, true)

    runtime.close()
    runtime = undefined
    const corruptRoot = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-corrupt-recovery-'))
    const corruptProject = projectIdentity(cwd)
    const projectDirectory = path.join(corruptRoot, 'projects', corruptProject.key)
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'memory.db'), 'not a sqlite database')
    const corruptRuntime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), corruptRoot)
    try {
      await assert.rejects(corruptRuntime.createRecoverySnapshot())
      assert.deepEqual(await corruptRuntime.recoverySnapshots(), [])
    } finally {
      corruptRuntime.close()
      rmSync(corruptRoot, { recursive: true, force: true })
    }
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R4.1 recovery apply stages raw data and reapplies live forget fences', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-apply-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const memory = store.addMemory({ content: 'Synthetic memory protected by the live forget fence.', status: 'approved' }).record
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)

    const snapshot = await runtime.createRecoverySnapshot()
    assert.equal(snapshot.verified, true)
    const ledgerBeforeForget = runtime.control.controlHighWater()
    runtime.review(project.key, memory.id, 'forget')
    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, true, plan.blockers.join('; '))

    const applied = await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    assert.ok(applied.preservedControlHighWater > ledgerBeforeForget)
    assert.match(applied.stateRoot, /generations/u)
    assert.equal(runtime.get(cwd, memory.id), undefined, 'the current ledger forget fence remains authoritative after restore')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('recovery reapplies forget and delete fences to dirty scene membership before staging', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-dirty-scene-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const actualNow = Date.now
  let logicalNow = actualNow() - 60_000
  let runtime
  try {
    Date.now = () => logicalNow
    const seed = openProjectStore(root, project.key, project)
    const retained = seed.addMemory({ content: 'Synthetic retained scene memory.', status: 'approved', scene: 'general' }).record
    logicalNow += 1
    const toForget = seed.addMemory({ content: 'Synthetic forgotten scene memory.', status: 'candidate', scene: 'general' }).record
    logicalNow += 1
    const toDelete = seed.addMemory({ content: 'Synthetic deleted scene memory.', status: 'candidate', scene: 'general' }).record
    seed.refreshScenes(logicalNow + 1)
    seed.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    logicalNow += 10
    assert.equal(runtime.review(project.key, toForget.id, 'approve')?.status, 'approved')
    logicalNow += 10
    assert.equal(runtime.review(project.key, toDelete.id, 'approve')?.status, 'approved')
    const liveStore = runtime.stores.get(project.key)
    const dirtyRow = liveStore.db.prepare(`SELECT source_ids, source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(dirtyRow.source_snapshot_dirty, 1)
    assert.deepEqual(JSON.parse(dirtyRow.source_ids), [retained.id], 'both approved IDs are absent from the dirty JSON snapshot')
    assert.deepEqual(liveStore.db.prepare(`SELECT memory_id FROM l2_scene_members WHERE scene_name = 'general' ORDER BY ordinal`)
      .all().map((row) => row.memory_id), [toDelete.id, toForget.id, retained.id])

    Date.now = actualNow
    const snapshot = await runtime.createRecoverySnapshot()
    assert.equal(snapshot.verified, true)
    const snapshotDb = new DatabaseSync(path.join(root, 'recovery', snapshot.manifest.snapshotId, 'projects', project.key, 'memory.db'), { readOnly: true })
    try {
      const snapshotScene = snapshotDb.prepare(`SELECT source_ids, source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get()
      assert.equal(snapshotScene.source_snapshot_dirty, 1, 'the staged source is a genuinely dirty scene snapshot')
      assert.deepEqual(JSON.parse(snapshotScene.source_ids), [retained.id])
      assert.deepEqual(snapshotDb.prepare(`SELECT memory_id FROM l2_scene_members WHERE scene_name = 'general' ORDER BY ordinal`)
        .all().map((row) => row.memory_id), [toDelete.id, toForget.id, retained.id])
    } finally { snapshotDb.close() }

    runtime.review(project.key, toForget.id, 'forget')
    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { memoryIds: [toDelete.id] })
    const deletion = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [toDelete.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(deletion.cleanupStatus, 'complete')

    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, true, plan.blockers.join('; '))
    await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    assert.equal(runtime.get(cwd, retained.id)?.id, retained.id)
    assert.equal(runtime.get(cwd, toForget.id), undefined)
    assert.equal(runtime.get(cwd, toDelete.id), undefined)
    const restoredStore = runtime.stores.get(project.key)
    const restoredScene = restoredStore.scenes().find((scene) => scene.name === 'general')
    assert.deepEqual(restoredScene?.sourceIds, [retained.id], 'current forget and content-delete fences remove both stale snapshot members')
    assert.equal(restoredStore.db.prepare(`SELECT COUNT(*) AS n FROM l2_scene_members WHERE memory_id IN (?, ?)`)
      .get(toForget.id, toDelete.id).n, 0, 'the final staged rebuild does not retain either fenced member')
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('recovery apply stays paused and retains capture spool when a project store close fails', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-close-failure-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  let store
  let originalDbClose
  try {
    const seed = openProjectStore(root, project.key, project)
    seed.addMemory({ content: 'Synthetic close-failure recovery fixture.', status: 'approved' })
    seed.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)

    const snapshot = await runtime.createRecoverySnapshot()
    assert.equal(snapshot.verified, true)
    runtime.status(cwd)
    store = runtime.stores.get(project.key)
    assert.ok(store)
    originalDbClose = store.db.close.bind(store.db)
    store.db.close = () => {
      runtime.onSessionEvent({ id: 'synthetic-maintenance-session', header: { cwd } }, {
        type: 'user/message', time: Date.now(), data: { id: 'spooled-close-failure-message', role: 'user', content: [{ type: 'text', text: 'Keep this event queued until writers stop.' }] },
      })
      throw new Error('synthetic SQLite db.close failure')
    }

    await assert.rejects(runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId), /synthetic SQLite db.close failure/u)
    assert.equal(runtime.maintenance, true)
    assert.equal(runtime.coverageWindowId, undefined)
    assert.equal(runtime.stores.get(project.key), store, 'the unconfirmed connection reference is retained for diagnosis')
    assert.equal(runtime.stateRoot, root, 'the staged generation must not become active')
    assert.equal(existsSync(path.join(root, 'state-current.json')), false)
    const spool = readFileSync(path.join(root, 'capture-spool', 'events.ndjson'), 'utf8')
    assert.match(spool, /spooled-close-failure-message/u, 'capture remains spooled instead of replaying into an unconfirmed writer')
    assert.match(runtime.lastError, /could not confirm project database stores stopped/u)
    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, false)
    assert.match(plan.blockers.join('; '), /maintenance remains paused/u)
  } finally {
    if (store !== undefined && originalDbClose !== undefined) store.db.close = originalDbClose
    if (runtime !== undefined) {
      runtime.maintenance = false
      runtime.maintenanceStopUnconfirmed = undefined
      runtime.close()
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('ordinary shutdown retains the writer lease when the control SQLite close fails and can retry', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-shutdown-close-failure-'))
  const runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
  const originalDbClose = runtime.control.db.close.bind(runtime.control.db)
  try {
    runtime.control.db.close = () => { throw new Error('synthetic control SQLite db.close failure') }
    assert.throws(() => runtime.close(), /synthetic control SQLite db.close failure/u)
    assert.equal(runtime.resourcesClosed, false)
    assert.equal(existsSync(path.join(root, 'runtime-writer.lock')), true, 'writer lease remains held while control DB is still open')
    runtime.control.db.close = originalDbClose
    runtime.close()
    assert.equal(runtime.resourcesClosed, true)
    assert.equal(existsSync(path.join(root, 'runtime-writer.lock')), false, 'lease is released only after a successful DB close')
  } finally {
    runtime.control.db.close = originalDbClose
    if (!runtime.resourcesClosed) { try { runtime.close() } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})

test('recovery apply is blocked when an old snapshot would make a consumed L0 source pending again', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-extraction-rollback-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    const sourceId = runtime.stores.get(project.key).recordL0({ sessionId: 'before-turn-end', role: 'user', content: 'Synthetic source captured before turn end.' })
    const snapshot = await runtime.createRecoverySnapshot()
    runtime.status(cwd)
    runtime.stores.get(project.key).markExtracted([sourceId])

    const before = runtime.control.listBillableCalls(project.key, 100)
    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, false)
    assert.match(plan.blockers.join('; '), /would unconsume 1 source row/u)
    await assert.rejects(runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId), /would unconsume 1 source row/u)
    assert.equal(runtime.control.listBillableCalls(project.key, 100).length, before.length, 'blocked rollback does not create a second provider charge')
    assert.equal(runtime.stores.get(project.key).unextracted('before-turn-end').length, 0, 'the live consumed state remains active')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('recovery blocks a paid source replay after retention removed L0 and the current project DB is missing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-durable-source-ledger-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    let store = runtime.storeByKey(project.key, false)
    const sourceId = store.recordL0({ sessionId: 'durable-source-session', role: 'user', content: 'Synthetic paid source removed by retention.',
      provider: 'mock-provider', model: 'mock-model' })
    const snapshot = await runtime.createRecoverySnapshot()
    store = runtime.storeByKey(project.key, false)
    const job = store.enqueueExtractionJob({ sessionId: 'durable-source-session', sourceId, policyRevision: 'source-policy', quietMs: 0, maxWaitMs: 1000 })
    const ready = store.freezeExtractionJob(job.id)
    const attemptId = 'attempt-durable-source'
    const callId = 'bill-durable-source'
    const requestHash = 'd'.repeat(64)
    const sourceDigest = createHash('sha256').update(ready.sourceIds.join('\0')).digest('hex')
    runtime.control.reserveBillableCall({ id: callId, projectKey: project.key, purpose: 'extraction', budgetClass: 'automatic', reservedTokens: 100,
      dailyTokenLimit: 1000, dailyTaskLimit: 5, jobId: job.id, attemptId, provider: 'mock-provider', model: 'mock-model', requestHash })
    runtime.control.beginAttempt({ id: attemptId, projectKey: project.key, jobId: job.id, provider: 'mock-provider', model: 'mock-model',
      inputHash: ready.inputHash, requestHash, sourceDigest, sourceIds: ready.sourceIds, billableCallId: callId })
    store.attachExtractionAttempt(job.id, attemptId)
    runtime.control.markBillableCallDispatched(callId)
    runtime.control.settleBillableCall(callId, 'complete', { inputTokens: 20, outputTokens: 5 })
    runtime.control.settleAttempt(attemptId, 'complete', { inputTokens: 20, outputTokens: 5 })
    store.saveExtractionResponse(job.id, attemptId, '{"memories":[]}', {
      inputTokens: 20, outputTokens: 5, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: null,
    })
    store.commitExtractionBatch(job.id, [])
    assert.equal(store.pruneOlderThan(1, Date.now() + 2 * 86_400_000), 1, 'retention removes the consumed raw source')
    const attemptsBefore = runtime.control.attemptsForJob(project.key, job.id).length
    const callsBefore = runtime.control.listBillableCalls(project.key, 100).length
    store.close()
    runtime.stores.delete(project.key)
    rmSync(store.file, { force: true })

    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, false)
    assert.match(plan.blockers.join('; '), /would unconsume 1 source row/u, 'durable attempt source IDs are compared when the current project DB is absent')
    await assert.rejects(runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId), /would unconsume 1 source row/u)
    assert.equal(runtime.control.attemptsForJob(project.key, job.id).length, attemptsBefore)
    assert.equal(runtime.control.listBillableCalls(project.key, 100).length, callsBefore, 'blocked recovery cannot add another provider charge')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('recovery apply keeps current restrictive extraction, budget, and global persona settings', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-recovery-policy-'))
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.updateSettings({ extractionEnabled: true, automaticDailyTokens: 1200, automaticDailyTasks: 4,
      manualDailyTokens: 900, manualDailyTasks: 3, globalPersona: true, includePersona: true })
    const snapshot = await runtime.createRecoverySnapshot()
    runtime.updateSettings({ extractionEnabled: false, automaticDailyTokens: 0, automaticDailyTasks: 0,
      manualDailyTokens: 0, manualDailyTasks: 0, globalPersona: false, includePersona: false })

    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, true)
    await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    const applied = runtime.dashboard()
    assert.equal(applied.settings.extractionEnabled, false)
    assert.equal(applied.settings.automaticDailyTokens, 0)
    assert.equal(applied.settings.automaticDailyTasks, 0)
    assert.equal(applied.settings.manualDailyTokens, 0)
    assert.equal(applied.settings.manualDailyTasks, 0)
    assert.equal(applied.settings.globalPersona, false)
    assert.equal(applied.settings.includePersona, false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('billable usage reconciliation is identity-bound, idempotent, and keeps conflicting receipts unknown across restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-billable-receipt-'))
  let runtime
  let restarted
  const projectKey = 'project-receipt-test'
  const requestHash = 'a'.repeat(64)
  const receipt = {
    callId: 'bill-receipt-test', receiptId: 'receipt-1', provider: 'mock-provider', model: 'mock-model', requestHash,
    inputTokens: 25, outputTokens: 15, evidenceRef: 'provider-ledger://receipt-1', reason: 'Synthetic provider receipt fixture',
  }
  try {
    openProjectStore(root, projectKey).close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.control.reserveBillableCall({ id: receipt.callId, projectKey, purpose: 'project_persona', budgetClass: 'manual', reservedTokens: 100,
      dailyTokenLimit: 1000, dailyTaskLimit: 5, provider: receipt.provider, model: receipt.model, requestHash })
    runtime.control.markBillableCallDispatched(receipt.callId)
    runtime.control.settleBillableCall(receipt.callId, 'uncertain', { inputTokens: 25 })
    const saved = runtime.billableResults.save({ version: 1, callId: receipt.callId, projectKey, purpose: 'project_persona',
      provider: receipt.provider, model: receipt.model, requestHash, responseText: 'Synthetic saved response.',
      usage: { inputTokens: 25, outputTokens: 15, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: null },
      operation: { kind: 'project_persona', projectKey, sourceIds: ['memory-a'], sourceRevisions: { 'memory-a': 1 }, policyRevision: 'fixture-policy', sourceCount: 1 }, savedAt: Date.now() })
    runtime.control.registerBillableResponse({ callId: receipt.callId, projectKey, purpose: 'project_persona', provider: receipt.provider,
      model: receipt.model, requestHash, sha256: saved.sha256 })

    const first = await runtime.manageProjectOperation(projectKey, 'billable.reconcileUsage', { ...receipt, authorized: true })
    assert.equal(first.call.state, 'complete')
    assert.equal(first.verification, 'recorded_not_independently_verified')
    assert.equal(first.usageAudit.receipts.length, 1)
    await runtime.manageProjectOperation(projectKey, 'billable.reconcileUsage', { ...receipt, authorized: true })
    assert.equal(runtime.control.billableUsageAudit(receipt.callId).receipts.length, 1, 'same receipt identity is counted once')
    await assert.rejects(runtime.manageProjectOperation('other-project', 'billable.reconcileUsage', receipt), /unavailable in this project/u)

    const conflicting = await runtime.manageProjectOperation(projectKey, 'billable.reconcileUsage', {
      ...receipt, receiptId: 'receipt-2', inputTokens: 27, evidenceRef: 'provider-ledger://receipt-2', authorized: true,
    })
    assert.equal(conflicting.call.state, 'uncertain')
    assert.equal(conflicting.reservationStillHeld, true)
    assert.equal(conflicting.usageAudit.conflicts.length, 1)
    assert.equal(conflicting.usageAudit.verification, 'recorded_not_independently_verified')
    runtime.close()
    runtime = undefined

    restarted = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    assert.equal(restarted.control.getBillableCall(receipt.callId).state, 'uncertain', 'an older local response cannot clear a newer usage conflict')
    assert.equal(restarted.control.hasBillableUsageConflict(receipt.callId), true)
  } finally {
    runtime?.close()
    restarted?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup blocks a saved response for a missing project and preserves its local sidecar and usage evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-missing-saved-project-'))
  let runtime
  let restarted
  const projectKey = 'project-missing-response'
  const callId = 'bill-missing-project-response'
  const requestHash = 'b'.repeat(64)
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.control.reserveBillableCall({ id: callId, projectKey, purpose: 'project_persona', budgetClass: 'manual', reservedTokens: 128,
      dailyTokenLimit: 1000, dailyTaskLimit: 5, provider: 'mock-provider', model: 'mock-model', requestHash })
    runtime.control.markBillableCallDispatched(callId)
    runtime.control.settleBillableCall(callId, 'uncertain', { inputTokens: 20 })
    const saved = runtime.billableResults.save({ version: 1, callId, projectKey, purpose: 'project_persona', provider: 'mock-provider',
      model: 'mock-model', requestHash, responseText: 'Synthetic paid response must remain local.',
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: null },
      operation: { kind: 'project_persona', projectKey, sourceIds: ['missing-memory'], sourceRevisions: { 'missing-memory': 1 },
        policyRevision: 'missing-project-fixture', sourceCount: 1 }, savedAt: Date.now() })
    runtime.control.registerBillableResponse({ callId, projectKey, purpose: 'project_persona', provider: 'mock-provider', model: 'mock-model',
      requestHash, sha256: saved.sha256 })
    runtime.close()
    runtime = undefined

    restarted = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const reconciledCall = restarted.control.getBillableCall(callId)
    assert.equal(reconciledCall?.responseStatus, 'blocked', 'an unavailable project prevents automatic response replay')
    assert.equal(reconciledCall?.state, 'complete', 'the complete sidecar usage receipt settles the local call')
    assert.equal(reconciledCall?.actualTokens, 28, 'the local call retains the complete 20 + 8 token total')
    const retainedUsage = restarted.billableResults.load(callId).result.usage
    assert.equal(retainedUsage.inputTokens, 20)
    assert.equal(retainedUsage.outputTokens, 8)
    assert.equal(retainedUsage.inputTokens + retainedUsage.outputTokens, reconciledCall?.actualTokens)
    assert.equal(restarted.billableResults.callIds().includes(callId), true, 'the saved response sidecar is retained for local review')
    assert.equal(existsSync(path.join(root, 'projects', projectKey, 'memory.db')), false, 'startup does not create an empty replacement database')
  } finally {
    runtime?.close()
    restarted?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup reconciles a saved extraction sidecar from a durable completed-job proof without repeating L1 commit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-extraction-commit-proof-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  let restarted
  const usage = { inputTokens: 25, outputTokens: 15, cachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costMicros: null }
  const responseText = '{"memories":[{"content":"Synthetic committed extraction memory.","kind":"fact","confidence":0.7,"sourceMessageIds":["source"]}]}'
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    const store = runtime.storeByKey(project.key, false)
    const sourceId = store.recordL0({ sessionId: 'commit-proof-session', role: 'user', content: 'Synthetic source for the completed extraction.', provider: 'mock-provider', model: 'mock-model' })
    const job = store.enqueueExtractionJob({ sessionId: 'commit-proof-session', sourceId, policyRevision: 'policy-proof', quietMs: 0, maxWaitMs: 1000 })
    const ready = store.freezeExtractionJob(job.id)
    const attemptId = 'attempt-commit-proof'
    const callId = 'bill-commit-proof'
    const requestHash = 'b'.repeat(64)
    runtime.control.reserveBillableCall({ id: callId, projectKey: project.key, purpose: 'extraction', budgetClass: 'automatic', reservedTokens: 100,
      dailyTokenLimit: 1000, dailyTaskLimit: 5, jobId: job.id, attemptId, provider: 'mock-provider', model: 'mock-model', requestHash })
    runtime.control.beginAttempt({ id: attemptId, projectKey: project.key, jobId: job.id, provider: 'mock-provider', model: 'mock-model',
      inputHash: ready.inputHash, requestHash, sourceDigest: 'c'.repeat(64), billableCallId: callId })
    store.attachExtractionAttempt(job.id, attemptId)
    runtime.control.markBillableCallDispatched(callId)
    runtime.control.settleBillableCall(callId, 'complete', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
    runtime.control.settleAttempt(attemptId, 'complete', usage)
    const saved = runtime.billableResults.save({ version: 1, callId, projectKey: project.key, purpose: 'extraction',
      provider: 'mock-provider', model: 'mock-model', requestHash, responseText, usage,
      operation: { kind: 'extraction', projectKey: project.key, jobId: job.id, attemptId }, savedAt: Date.now() })
    runtime.control.registerBillableResponse({ callId, projectKey: project.key, purpose: 'extraction', provider: 'mock-provider',
      model: 'mock-model', requestHash, sha256: saved.sha256 })
    store.saveExtractionResponse(job.id, attemptId, responseText, usage)
    store.commitExtractionBatch(job.id, [{ content: 'Synthetic committed extraction memory.', kind: 'fact', confidence: 0.7,
      source: 'extraction', sourceMessageIds: [sourceId], sourceVerified: true }])
    const committedCount = store.recordsPage({ limit: 100 }).records.length
    const beforeRecovery = { attempts: runtime.control.attemptsForJob(project.key, job.id).length,
      billableCalls: runtime.control.listBillableCalls(project.key, 100).length,
      actualTokens: runtime.control.getBillableCall(callId).actualTokens }
    runtime.close()
    runtime = undefined

    restarted = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    restarted.recoverSavedResponseFiles()
    const reopened = restarted.storeByKey(project.key, false)
    assert.equal(reopened.getExtractionJob(job.id).status, 'completed')
    assert.equal(reopened.recordsPage({ limit: 100 }).records.length, committedCount)
    assert.equal(restarted.control.getBillableCall(callId).responseStatus, 'committed')
    assert.equal(restarted.control.attemptsForJob(project.key, job.id).length, beforeRecovery.attempts, 'local commit proof adds no new provider attempt')
    assert.equal(restarted.control.listBillableCalls(project.key, 100).length, beforeRecovery.billableCalls, 'local commit proof adds no billable call')
    assert.equal(restarted.control.getBillableCall(callId).actualTokens, beforeRecovery.actualTokens, 'local commit proof does not change recorded usage')
    assert.equal(reopened.verifyCommittedExtraction({ jobId: job.id, attemptId, responseText, usage }), true)
  } finally {
    runtime?.close()
    restarted?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('C1 derived cards redact content when a source expires or its Agent is excluded', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-redaction-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const now = Date.now()
    const excludedSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'A restricted source fact.', createdAt: now, agentPreset: 'hidden-agent' })
    const expiredSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'An expired source fact.', createdAt: now })
    const excludedMemory = store.addMemory({ content: 'A restricted approved fact.', status: 'approved', sourceMessageIds: [excludedSource], sourceVerified: true }).record
    const expiredMemory = store.addMemory({ content: 'An approved fact with an expired validity window.', status: 'approved', validFrom: now - 5000, validTo: now - 1, sourceMessageIds: [expiredSource], sourceVerified: true }).record
    store.upsertTaskContext({
      taskRef: 'task-stale', goal: 'Sensitive continuity body', constraints: ['keep private'], completed: [], pending: ['continue'],
      knownUnknowns: [], confirmedFacts: [], assumptions: [], blockers: [], artifactRefs: [{ ref: 'private-output.txt' }],
      sourceMemoryIds: [excludedMemory.id, expiredMemory.id], status: 'active',
    })
    store.saveExperience({
      id: 'exp-stale', title: 'Sensitive experience', symptom: 'test symptom', environment: {}, prerequisites: [], steps: [], outcomes: [],
      counterexamples: [], evidenceMemoryIds: [excludedMemory.id, expiredMemory.id],
    })
    store.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({ capture: { excludeAgents: ['hidden-agent'] } }), root)
    const task = runtime.taskContexts(project.key)[0]
    assert.equal(task.redacted, true)
    assert.equal('goal' in task, false)
    assert.deepEqual(runtime.experienceCards(project.key), [])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('TC03 transitive derived memories are unreadable after a dependency revision', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-dependencies-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const sourceId = store.recordL0({ sessionId: 's1', role: 'user', content: 'Synthetic evidence for the dependency chain.' })
    const base = store.addMemory({ content: 'base dependency fact', status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true }).record
    const derived = store.addMemory({ content: 'derived dependency fact', status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true }).record
    const transitive = store.addMemory({ content: 'transitive dependency fact', status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true }).record
    store.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    for (const [fromId, toId] of [[derived.id, base.id], [transitive.id, derived.id]]) {
      const candidate = runtime.proposeRelation(project.key, { fromId, toId, type: 'derived_from', evidenceIds: [sourceId] })
      runtime.reviewRelation(project.key, candidate.id, true)
    }
    assert.equal(runtime.get(cwd, transitive.id)?.id, transitive.id)

    const revision = runtime.proposeRevision(project.key, {
      memoryId: base.id, expectedRevision: base.revision, content: 'revised base dependency fact', sourceMessageIds: [sourceId], reason: 'Synthetic dependency change.',
    })
    runtime.reviewRevision(project.key, revision.id, true)

    assert.equal(runtime.get(cwd, base.id)?.revision, base.revision + 1)
    assert.equal(runtime.get(cwd, derived.id), undefined)
    assert.equal(runtime.get(cwd, transitive.id), undefined)
    assert.equal(runtime.knowledgeDetail(project.key, transitive.id), undefined)
    assert.equal(runtime.library(project.key, { status: 'approved' }).records.some((record) => record.id === transitive.id), false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('TC03 relation evidence exclusion redacts task and experience dependencies even while endpoints remain readable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-relation-evidence-policy-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const fromSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Visible derived memory evidence.' })
    const toSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Visible dependency endpoint evidence.' })
    const relationSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Evidence used only to approve the relation.', agentPreset: 'hidden-agent' })
    const from = store.addMemory({ content: 'Synthetic derived task memory.', status: 'approved', sourceMessageIds: [fromSource], sourceVerified: true }).record
    const to = store.addMemory({ content: 'Synthetic dependency memory.', status: 'approved', sourceMessageIds: [toSource], sourceVerified: true }).record
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const relation = runtime.proposeRelation(project.key, { fromId: from.id, toId: to.id, type: 'depends_on', evidenceIds: [relationSource] })
    runtime.reviewRelation(project.key, relation.id, true)
    runtime.saveTaskContext(project.key, { taskRef: 'task-evidence', goal: 'Sensitive goal depends on relation evidence.', sourceMemoryIds: [from.id] })
    runtime.saveExperience(project.key, { id: 'exp-evidence', title: 'Sensitive derived experience', symptom: 'fixture', environment: {},
      steps: [], outcomes: [], evidenceMemoryIds: [from.id] })

    runtime.config.capture.excludeAgents.push('hidden-agent')
    const task = runtime.taskContexts(project.key).find((item) => item.taskRef === 'task-evidence')
    assert.equal(task.redacted, true)
    assert.equal('goal' in task, false)
    assert.deepEqual(runtime.experienceCards(project.key), [])
    assert.equal(runtime.get(cwd, to.id).id, to.id, 'the unrelated readable endpoint remains available')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('TC05 synthetic evaluation excludes facts recorded after knownAt and reports unknown source timing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-evaluation-known-at-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    runtime.saveEvaluationCase(project.key, { id: 'known-at-fixture', title: 'Historical evidence timing', query: 'known temporal fact',
      expectedIds: ['timely-fact'], forbiddenIds: ['late-fact'], source: 'synthetic', fixture: { effectiveAt: 900, knownAt: 1000, records: [
        { id: 'timely-fact', content: 'known temporal fact', recordedAt: 700, sourceVerified: true, status: 'approved' },
        { id: 'late-fact', content: 'known temporal fact', recordedAt: 1100, sourceVerified: true, status: 'approved' },
        { id: 'unknown-time-fact', content: 'known temporal fact', sourceVerified: true, status: 'approved' },
        { id: 'unverified-fact', content: 'known temporal fact', recordedAt: 700, status: 'approved' },
      ] } })
    const pair = runtime.evaluateCase(project.key, 'known-at-fixture')
    assert.deepEqual(pair.baseline.result.hits, ['timely-fact'])
    assert.ok(pair.baseline.result.sourceIssues.includes('late-fact:recorded_after_knownAt'))
    assert.ok(pair.baseline.result.sourceIssues.includes('unknown-time-fact:recordedAt_unknown'))
    assert.ok(pair.baseline.result.sourceIssues.includes('unverified-fact:source_unverified'))
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('TC05 approved evaluation replay checks relation evidence under the selected temporal view', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-approved-evaluation-policy-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const now = Date.now()
    const derivedSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Visible derived approved source.', createdAt: now })
    const dependencySource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Visible dependency approved source.', createdAt: now })
    const relationSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Restricted relation-only evidence.', createdAt: now, agentPreset: 'hidden-agent' })
    const derived = store.addMemory({ content: 'Approved derived memory for temporal replay.', status: 'approved', validFrom: now - 1,
      sourceMessageIds: [derivedSource], sourceVerified: true }).record
    const dependency = store.addMemory({ content: 'Approved dependency memory for temporal replay.', status: 'approved', validFrom: now - 1,
      sourceMessageIds: [dependencySource], sourceVerified: true }).record
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const relation = runtime.proposeRelation(project.key, { fromId: derived.id, toId: dependency.id, type: 'derived_from', evidenceIds: [relationSource] })
    runtime.reviewRelation(project.key, relation.id, true)
    runtime.saveEvaluationCase(project.key, { id: 'approved-policy-at-time', title: 'Approved source policy at time', query: 'derived temporal approved',
      expectedIds: [derived.id], forbiddenIds: [], source: 'approved', fixture: { effectiveAt: now + 1000, knownAt: now + 1000 } })
    runtime.config.capture.excludeAgents.push('hidden-agent')

    const pair = runtime.evaluateCase(project.key, 'approved-policy-at-time')
    assert.equal(pair.baseline.result.hits.includes(derived.id), false)
    assert.ok(pair.baseline.result.sourceIssues.includes(`${derived.id}:dependency_unreadable_at_temporal_view`))
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('UI03 duplicate capture excerpts hide mixed forgotten sources and preserve safe shared citations', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-overview-excerpt-policy-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const forgetOnlySource = store.recordL0({ sessionId: 'excerpt-session', role: 'user', content: 'Sensitive forgotten-only capture excerpt.' })
    const sharedSource = store.recordL0({ sessionId: 'excerpt-session', role: 'user', content: 'Shared source remains cited by a readable memory.' })
    const safeSharedSource = store.recordL0({ sessionId: 'excerpt-session', role: 'user', content: 'Safe shared source is cited only by readable memories.' })
    const unlinkedSource = store.recordL0({ sessionId: 'excerpt-session', role: 'user', content: 'Unlinked capture excerpt stays available on request.' })
    const forgottenOnly = store.addMemory({ content: 'Memory that will be forgotten.', status: 'approved', sourceMessageIds: [forgetOnlySource], sourceVerified: true }).record
    const sharedForgotten = store.addMemory({ content: 'Forgotten shared-source memory.', status: 'approved', sourceMessageIds: [sharedSource], sourceVerified: true }).record
    store.addMemory({ content: 'Readable shared-source memory.', status: 'approved', sourceMessageIds: [sharedSource], sourceVerified: true })
    store.addMemory({ content: 'First safe shared-source memory.', status: 'approved', sourceMessageIds: [safeSharedSource], sourceVerified: true })
    store.addMemory({ content: 'Second safe shared-source memory.', status: 'approved', sourceMessageIds: [safeSharedSource], sourceVerified: true })
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const date = new Date().toISOString().slice(0, 10)
    const base = await runtime.manageProjectOperation(project.key, 'overview.detail', { date, timeZone: 'UTC', activity: 'capture', limit: 100 })
    const readExcerpt = async (sourceId) => {
      const row = base.events.find((event) => event.sourceId === sourceId)
      assert.ok(row?.fingerprint)
      const detail = await runtime.manageProjectOperation(project.key, 'overview.detail', {
        date, timeZone: 'UTC', activity: 'capture', fingerprint: row.fingerprint, includeExcerpt: true,
      })
      return detail.events.find((event) => event.sourceId === sourceId)
    }
    assert.match((await readExcerpt(sharedSource)).excerpt, /Shared source remains cited/u)
    runtime.review(project.key, forgottenOnly.id, 'forget')
    runtime.review(project.key, sharedForgotten.id, 'forget')
    assert.equal((await readExcerpt(forgetOnlySource)).excerpt, undefined)
    assert.equal((await readExcerpt(sharedSource)).excerpt, undefined, 'a mixed excerpt is hidden while any referencing memory is unreadable')
    assert.match((await readExcerpt(safeSharedSource)).excerpt, /Safe shared source/u)
    assert.match((await readExcerpt(unlinkedSource)).excerpt, /Unlinked capture excerpt stays/u)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('UI03 forgotten shared-source text stays hidden in memory_get, memory_explain, and knowledge.detail', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-shared-excerpt-reads-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  let dispose
  try {
    const store = openProjectStore(root, project.key, project)
    const sharedSource = store.recordL0({ sessionId: 'shared-excerpt-session', role: 'user',
      content: 'Synthetic gate code 4729. The 2026 diary title is Blue.' })
    const forgotten = store.addMemory({ content: 'The synthetic gate code is 4729.', status: 'approved',
      sourceMessageIds: [sharedSource], sourceVerified: true }).record
    const visible = store.addMemory({ content: 'The 2026 diary title is Blue.', status: 'approved',
      sourceMessageIds: [sharedSource], sourceVerified: true }).record
    const safeSharedSource = store.recordL0({ sessionId: 'shared-excerpt-session', role: 'user',
      content: 'Synthetic safe shared source: project codename Teal.' })
    const safeVisible = store.addMemory({ content: 'The project codename is Teal.', status: 'approved',
      sourceMessageIds: [safeSharedSource], sourceVerified: true }).record
    store.addMemory({ content: 'The current project uses codename Teal.', status: 'approved',
      sourceMessageIds: [safeSharedSource], sourceVerified: true })
    store.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.review(project.key, forgotten.id, 'forget')
    const definitions = new Map()
    dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
    const execution = { agent: { session: { header: { cwd } } } }
    const memoryGet = definitions.get('memory_get')
    const memoryExplain = definitions.get('memory_explain')

    const fetched = await memoryGet.execute({ id: visible.id }, execution)
    assert.equal(fetched.memory.content, 'The 2026 diary title is Blue.')
    assert.equal(fetched.evidence.length, 0)
    assert.doesNotMatch(JSON.stringify(fetched), /4729/u)

    const explained = await memoryExplain.execute({ query: 'Blue' }, execution)
    assert.equal(explained.candidates.some((candidate) => candidate.id === visible.id && candidate.content === 'The 2026 diary title is Blue.'), true)
    assert.doesNotMatch(JSON.stringify(explained), /4729/u)

    const detail = await runtime.manageProjectOperation(project.key, 'knowledge.detail', { id: visible.id })
    assert.equal(detail.memory.content, 'The 2026 diary title is Blue.')
    assert.equal(detail.sources.length, 0)
    assert.doesNotMatch(JSON.stringify(detail), /4729/u)

    const safeFetched = await memoryGet.execute({ id: safeVisible.id }, execution)
    assert.match(safeFetched.evidence[0].excerpt, /Synthetic safe shared source/u)
    const safeExplained = await memoryExplain.execute({ query: 'codename Teal' }, execution)
    assert.equal(safeExplained.candidates.some((candidate) => candidate.id === safeVisible.id &&
      candidate.evidence.some((evidence) => /Synthetic safe shared source/u.test(evidence.excerpt))), true)
    const safeDetail = await runtime.manageProjectOperation(project.key, 'knowledge.detail', { id: safeVisible.id })
    assert.match(safeDetail.sources[0].content, /Synthetic safe shared source/u)
  } finally {
    dispose?.()
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R4.1 overview detail supports a date range and the aggregated other dimension', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-overview-detail-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const alphaAt = Date.parse('2026-01-02T12:00:00Z')
    const betaAt = Date.parse('2026-01-03T12:00:00Z')
    store.appendEvent({ eventId: 'range-event-alpha', type: 'capture', source: 'alpha', occurredAt: alphaAt }, alphaAt)
    store.appendEvent({ eventId: 'range-event-beta', type: 'capture', source: 'beta', occurredAt: betaAt }, betaAt)
    store.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const all = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      from: '2026-01-01', to: '2026-01-04', timeZone: 'UTC', activity: 'capture',
    })
    assert.deepEqual(all.events.map((event) => event.eventId).sort(), ['range-event-alpha', 'range-event-beta'])

    const other = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      from: '2026-01-01', to: '2026-01-04', timeZone: 'UTC', activity: 'capture',
      dimension: 'source', value: '__other__', otherValues: ['alpha'],
    })
    assert.deepEqual(other.events.map((event) => event.eventId), ['range-event-beta'])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('Agent preset overview uses normal capture identity and keeps instance IDs unknown', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-agent-preset-overview-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    const sessions = [
      { id: 'preset-session-a', header: { cwd, agentPreset: 'stable-preset-a', displayName: 'Shared display name' } },
      { id: 'preset-session-b', header: { cwd, agentPreset: 'stable-preset-b', displayName: 'Shared display name' } },
      { id: 'preset-session-unknown', header: { cwd, displayName: 'Shared display name' } },
    ]
    for (const [index, session] of sessions.entries()) {
      runtime.onSessionEvent(session, {
        type: 'user/message', seq: index + 1, time: Date.now(),
        data: { id: `preset-message-${index}`, role: 'user', content: [{ type: 'text', text: `Synthetic normal capture ${index}.` }] },
      })
    }

    const date = new Date().toISOString().slice(0, 10)
    const overview = runtime.overview({ projectKey: project.key, from: date, to: date, timeZone: 'UTC', activity: 'capture' })
    assert.equal(overview.period.unknownAgentEvents, 3, 'capture events do not supply Host Agent instance IDs')
    assert.equal(overview.period.unknownAgentPresetEvents, 1)
    assert.deepEqual(overview.period.agentPresets.filter((item) => !item.other).map((item) => item.agentPreset).sort(), ['stable-preset-a', 'stable-preset-b', 'unknown'])
    assert.equal(overview.period.agentPresets.find((item) => item.agentPreset === 'unknown')?.count, 1)
    assert.equal(overview.period.agentPresets.find((item) => item.agentPreset === 'stable-preset-a')?.count, 1)
    assert.equal(overview.period.agentPresets.find((item) => item.agentPreset === 'stable-preset-b')?.count, 1)

    const presetDetail = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      date, timeZone: 'UTC', activity: 'capture', dimension: 'agent_preset', value: 'stable-preset-a',
    })
    assert.equal(presetDetail.events.length, 1)
    assert.equal(presetDetail.events[0].agentPreset, 'stable-preset-a')
    assert.equal(presetDetail.events[0].agentId, undefined, 'no instance ID is inferred from a preset or display name')

    runtime.config.capture.excludeAgents.push('stable-preset-a')
    const excludedOverview = runtime.overview({ projectKey: project.key, from: date, to: date, timeZone: 'UTC', activity: 'capture' })
    assert.equal(excludedOverview.period.captures, 2)
    assert.deepEqual(excludedOverview.period.agentPresets.filter((item) => !item.other).map((item) => item.agentPreset).sort(), ['stable-preset-b', 'unknown'])
    assert.equal(excludedOverview.period.agentPresets.find((item) => item.agentPreset === 'unknown')?.count, 1)
    const excludedDetail = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      date, timeZone: 'UTC', activity: 'capture', dimension: 'agent_preset', value: 'stable-preset-a',
    })
    assert.deepEqual(excludedDetail.events, [], 'the overview and detail filters use the captured preset ID')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('overview current counts preserve time, TTL, source/event fences, dependency, and Agent permissions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-overview-current-permissions-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const actualNow = Date.now
  const now = Date.parse('2026-10-24T12:00:00.000Z')
  let runtime
  try {
    Date.now = () => now
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ capture: { excludeAgents: ['private-agent'] } }), root)
    runtime.status(cwd)
    const store = runtime.stores.get(project.key)
    assert.ok(store)
    const source = (sessionId, sourceEventId, agentPreset) => store.recordL0({ sessionId, role: 'user', content: `Synthetic source ${sessionId}.`,
      sourceEventId, ...(agentPreset === undefined ? {} : { agentPreset }) })
    const approved = (content, sourceIds = [], time = {}) => store.addMemory({ content, status: 'approved', validFrom: now - 10,
      sourceMessageIds: sourceIds, sourceVerified: sourceIds.length > 0, ...time }).record

    const baseSource = source('overview-base', 'overview-base-event')
    const base = approved('Synthetic currently valid overview base.', [baseSource])
    const ttlSource = source('overview-ttl', 'overview-ttl-event')
    const ttl = approved('Synthetic overview memory with current TTL.', [ttlSource])
    const ttlAt = now + 100
    store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(ttlAt, ttl.id)
    approved('Synthetic overview memory whose valid start is in the future.', [], { validFrom: now + 500 })
    approved('Synthetic overview memory whose valid end has passed.', [], { validTo: now - 1 })
    const privateSource = source('overview-private', 'overview-private-event', 'private-agent')
    approved('Synthetic Agent-excluded overview memory.', [privateSource])

    const fencedSource = source('overview-fenced', 'overview-direct-fence-event')
    const fenced = approved('Synthetic event-fenced overview memory.', [fencedSource])
    const derivedSource = source('overview-derived', 'overview-derived-event')
    const dependencySource = source('overview-dependency', 'overview-dependency-event')
    const relationSource = source('overview-relation', 'overview-relation-event')
    const derived = approved('Synthetic overview memory with a dependency.', [derivedSource])
    const dependency = approved('Synthetic overview dependency target.', [dependencySource])
    const relation = runtime.proposeRelation(project.key, { fromId: derived.id, toId: dependency.id, type: 'depends_on', evidenceIds: [relationSource] })
    runtime.reviewRelation(project.key, relation.id, true)

    const visibleCandidateSource = source('overview-candidate-visible', 'overview-candidate-visible-event')
    store.addMemory({ content: 'Synthetic visible overview candidate.', status: 'candidate', sourceMessageIds: [visibleCandidateSource], sourceVerified: true })
    const privateCandidateSource = source('overview-candidate-private', 'overview-candidate-private-event', 'private-agent')
    store.addMemory({ content: 'Synthetic Agent-excluded overview candidate.', status: 'candidate', sourceMessageIds: [privateCandidateSource], sourceVerified: true })

    const query = { projectKey: project.key, from: '2026-10-24', to: '2026-10-24', timeZone: 'UTC', activity: 'capture' }
    const beforeFences = runtime.overview(query)
    assert.equal(beforeFences.current.effectiveMemories, 5, 'future, expired-validity, and excluded-Agent rows are omitted')
    assert.equal(beforeFences.current.candidates, 1, 'candidate totals apply the same Agent source exclusion')

    runtime.control.revokeSourceEvent(project.key, 'overview-direct-fence-event', fencedSource, now + 1)
    assert.equal(runtime.overview(query).current.effectiveMemories, 4, 'a source ID plus Host event fence hides its approved memory')
    runtime.control.revokeSourceEvent(project.key, 'overview-relation-event', relationSource, now + 2)
    assert.equal(runtime.overview(query).current.effectiveMemories, 3, 'revoked relation evidence hides only the dependent memory')

    Date.now = () => ttlAt
    assert.equal(runtime.overview(query).current.effectiveMemories, 2, 'TTL is exclusive at its expiry boundary')
    Date.now = () => now + 600
    assert.equal(runtime.overview(query).current.effectiveMemories, 3, 'the future-valid revision becomes current while the expired TTL stays hidden')
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('overview preserves the nullable legacy longestSession contract while exposing linked L0 counts separately', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-overview-message-identity-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const actualNow = Date.now
  const at = Date.parse('2026-10-24T12:00:00.000Z')
  let runtime
  try {
    Date.now = () => at
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    const session = { id: 'same-host-message-session', header: { cwd } }
    for (const seq of [41, 42]) runtime.onSessionEvent(session, { type: 'user/message', seq, time: at + seq,
      data: { id: 'same-host-message-id', role: 'user', content: [{ type: 'text', text: 'Synthetic repeated Host message identity.' }] } })
    const store = runtime.stores.get(project.key)
    assert.ok(store)
    store.appendEvent({ eventId: 'capture-without-l0-link', type: 'capture', sessionId: 'unlinked-session', occurredAt: at + 50 }, at + 50)

    const overview = runtime.overview({ projectKey: project.key, from: '2026-10-24', to: '2026-10-24', timeZone: 'UTC', activity: 'capture' })
    const sameHostMessage = overview.period.topSessions.find((item) => item.sessionId === session.id)
    assert.equal(sameHostMessage.linkedL0Messages, 2, 'different sequence identities may create separate local L0 rows for one Host message ID')
    assert.equal(sameHostMessage.originalMessageCount, null, 'local row count cannot establish unique original Host message count')
    assert.equal(sameHostMessage.recordedOriginalMessageLowerBound, 1, 'the Host message ID is counted once across sequence numbers')
    assert.equal(sameHostMessage.unknownOriginalMessageEvents, 0)
    assert.equal(sameHostMessage.events, 2)
    assert.equal(overview.period.recordedOriginalMessageLowerBound, 1)
    assert.equal(overview.period.unknownOriginalMessageEvents, 1, 'the unlinked capture has no original Host identity')
    assert.equal(overview.period.longestSession, null, 'unknown raw-message uniqueness remains null in the original nullable DTO field')
    assert.equal(overview.period.mostLinkedL0Session.sessionId, session.id)
    assert.equal(overview.period.mostLinkedL0Session.linkedL0Messages, 2)
    assert.equal(overview.period.mostLinkedL0Session.originalMessageCount, null)
    assert.equal(overview.period.mostLinkedL0Session.recordedOriginalMessageLowerBound, 1)
    assert.equal(overview.period.mostLinkedL0Session.unknownOriginalMessageEvents, 0)
    assert.doesNotThrow(() => OverviewResultSchema.parse(overview), 'the extended DTO satisfies the current strict response contract')
    const legacyResponse = structuredClone(overview)
    legacyResponse.period.longestSession = { sessionId: 'legacy-session', messages: 2 }
    delete legacyResponse.period.mostLinkedL0Session
    legacyResponse.period.topSessions = [{ sessionId: 'legacy-session', messages: 2, events: 2 }]
    assert.doesNotThrow(() => OverviewResultSchema.parse(legacyResponse), 'the prior nullable and optional fields remain accepted')
    const unlinked = overview.period.topSessions.find((item) => item.sessionId === 'unlinked-session')
    assert.equal(unlinked.linkedL0Messages, 0)
    assert.equal(unlinked.originalMessageCount, null, 'a capture event without an L0 link has unknown original-message count')
    assert.equal(unlinked.recordedOriginalMessageLowerBound, 0)
    assert.equal(unlinked.unknownOriginalMessageEvents, 1)
    assert.equal(unlinked.events, 1)
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('overview timezone is shared by daily counts, detail pagination, and repeated-capture pages', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-overview-timezone-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const date = '2026-10-22'
  const shanghaiStart = Date.parse('2026-10-21T16:00:00.000Z')
  const firstRevisionAt = Date.parse('2026-10-21T16:30:00.000Z')
  const secondRevisionAt = Date.parse('2026-10-22T02:00:00.000Z')
  const utcOnlyRevisionAt = Date.parse('2026-10-22T16:30:00.000Z')
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    runtime.status(cwd)
    const store = runtime.stores.get(project.key)
    assert.ok(store)
    store.appendEvent({ eventId: 'revision-shanghai-first', type: 'revision', occurredAt: firstRevisionAt }, firstRevisionAt)
    store.appendEvent({ eventId: 'revision-shanghai-second', type: 'revision', occurredAt: secondRevisionAt }, secondRevisionAt)
    store.appendEvent({ eventId: 'revision-utc-only', type: 'revision', occurredAt: utcOnlyRevisionAt }, utcOnlyRevisionAt)

    const repeatedContent = 'Synthetic repeated capture for timezone pagination.'
    for (const [index, at] of [shanghaiStart + 30 * 60_000, shanghaiStart + 90 * 60_000].entries()) {
      store.captureMessage({ sessionId: `timezone-repeat-${index}`, role: 'user', content: repeatedContent,
        createdAt: at, recordedAt: at, sourceEventId: `timezone-repeat-event-${index}` })
    }

    const overviewFor = (timeZone) => runtime.overview({ projectKey: project.key, from: date, to: date, timeZone, activity: 'revision' })
    const utcOverview = overviewFor('UTC')
    const shanghaiOverview = overviewFor('Asia/Shanghai')
    assert.equal(utcOverview.timezone, 'UTC')
    assert.equal(shanghaiOverview.timezone, 'Asia/Shanghai')
    assert.deepEqual(utcOverview.period.activity.map((day) => [day.date, day.revisions]), [[date, 2]])
    assert.deepEqual(shanghaiOverview.period.activity.map((day) => [day.date, day.revisions]), [[date, 2]])

    const detailFor = (timeZone, extra = {}) => runtime.manageProjectOperation(project.key, 'overview.detail', {
      date, timeZone, activity: 'revision', limit: 1, ...extra,
    })
    const firstPage = await detailFor('Asia/Shanghai')
    assert.equal(firstPage.events[0].eventId, 'revision-shanghai-second')
    assert.ok(firstPage.next)
    const nextPage = await detailFor('Asia/Shanghai', { after: firstPage.next })
    assert.equal(nextPage.events[0].eventId, 'revision-shanghai-first')
    const utcPage = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      date, timeZone: 'UTC', activity: 'revision', limit: 10,
    })
    assert.deepEqual(utcPage.events.map((event) => event.eventId), ['revision-utc-only', 'revision-shanghai-second'])

    const repeatedPage = (timeZone) => runtime.manageProjectOperation(project.key, 'overview.repeated', {
      from: date, to: date, timeZone, limit: 10,
    })
    const shanghaiRepeated = await repeatedPage('Asia/Shanghai')
    const utcRepeated = await repeatedPage('UTC')
    assert.equal(shanghaiRepeated.items.length, 1)
    assert.equal(shanghaiRepeated.items[0].repeatCount, 1)
    assert.deepEqual(utcRepeated.items, [])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R4.1 repeated clue detail filters by fingerprint and returns excerpts only when explicitly requested', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-repeated-detail-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const start = Date.parse('2026-01-02T00:00:00Z')
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    store.recordL0({ sessionId: 's1', role: 'user', content: 'Synthetic repeated clue body.', createdAt: start + 1_000, recordedAt: start + 1_000, sourceEventId: 'repeat-one' })
    store.recordL0({ sessionId: 's2', role: 'user', content: 'Synthetic repeated clue body.', createdAt: start + 2_000, recordedAt: start + 2_000, sourceEventId: 'repeat-two' })
    const fingerprint = store.captureOverview(start, start + 86_400_000).repeated[0].fingerprint
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)

    const ordinary = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      from: '2026-01-02', to: '2026-01-02', timeZone: 'UTC', activity: 'capture', fingerprint,
    })
    assert.equal(ordinary.events.length, 2)
    assert.equal('excerpt' in ordinary.events[0], false)
    const requested = await runtime.manageProjectOperation(project.key, 'overview.detail', {
      from: '2026-01-02', to: '2026-01-02', timeZone: 'UTC', activity: 'capture', fingerprint, includeExcerpt: true,
    })
    assert.equal(requested.events.length, 2)
    assert.equal(requested.events[0].excerpt, 'Synthetic repeated clue body.')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R4.1 repeated, extraction-job, and coverage pages use stable bounded cursors', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-pages-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const start = Date.parse('2026-02-01T00:00:00Z')
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    for (let index = 0; index < 3; index += 1) {
      const content = `Synthetic repeated group ${index}.`
      for (let copy = 0; copy < 2; copy += 1) {
        const sessionId = `repeat-${index}-${copy}`
        const sourceId = store.recordL0({ sessionId, role: 'user', content, createdAt: start + index * 1000 + copy, recordedAt: start + index * 1000 + copy, sourceEventId: `repeat-event-${index}-${copy}` })
        store.enqueueExtractionJob({ sessionId, sourceId, policyRevision: `policy-${index}-${copy}`, quietMs: 0, maxWaitMs: 60_000, now: start + index * 1000 + copy })
      }
    }
    for (let index = 0; index < 21; index += 1) store.enqueueExtractionJob({
      sessionId: `page-job-${index}`, sourceId: store.recordL0({ sessionId: `page-job-${index}`, role: 'user', content: `Synthetic job source ${index}.`, createdAt: start + 5000 + index, recordedAt: start + 5000 + index }),
      policyRevision: `job-policy-${index}`, quietMs: 0, maxWaitMs: 60_000, now: start + 5000 + index,
    })
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const coverageStart = Date.now() + 1
    for (let index = 0; index < 21; index += 1) runtime.control.startCoverage(`coverage-policy-${index}`, coverageStart + index)

    const repeatedFirst = await runtime.manageProjectOperation(project.key, 'overview.repeated', { from: '2026-02-01', to: '2026-02-02', timeZone: 'UTC', limit: 2 })
    assert.equal(repeatedFirst.items.length, 2)
    assert.ok(repeatedFirst.next)
    const repeatedSecond = await runtime.manageProjectOperation(project.key, 'overview.repeated', { from: '2026-02-01', to: '2026-02-02', timeZone: 'UTC', after: repeatedFirst.next, limit: 2 })
    assert.equal(repeatedSecond.items.length, 1)
    assert.equal(repeatedFirst.items.some((item) => item.fingerprint === repeatedSecond.items[0].fingerprint), false)

    const jobsFirst = await runtime.manageProjectOperation(project.key, 'processing.jobs', { limit: 20 })
    assert.equal(jobsFirst.jobs.length, 20)
    assert.ok(jobsFirst.next)
    const jobsSecond = await runtime.manageProjectOperation(project.key, 'processing.jobs', { after: jobsFirst.next, limit: 20 })
    assert.equal(jobsSecond.jobs.length, 7)
    assert.equal(jobsFirst.jobs.some((job) => job.id === jobsSecond.jobs[0].id), false)
    assert.equal('sourceIds' in jobsFirst.jobs[0], false)

    const coverageFirst = await runtime.manageProjectOperation(project.key, 'processing.coverage', { limit: 20 })
    assert.equal(coverageFirst.windows.length, 20)
    assert.equal(typeof coverageFirst.nextBeforeId, 'number')
    const coverageSecond = await runtime.manageProjectOperation(project.key, 'processing.coverage', { beforeId: coverageFirst.nextBeforeId, limit: 20 })
    assert.ok(coverageSecond.windows.length >= 1 && coverageSecond.windows.length <= 2)
    assert.equal(coverageFirst.windows.some((window) => window.id === coverageSecond.windows[0].id), false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R4.1 memory search reports truthful exhaustion around policy limits', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-search-cap-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    for (let index = 0; index < 51; index += 1) {
      const terms = ['common', 'over']
      if (index < 50) terms.push('fifty')
      if (index < 10) terms.push('exact')
      if (index < 9) terms.push('under')
      const record = runtime.propose(cwd, `Synthetic ${terms.join(' ')} record ${index}.`, 'fact', 0.9)
      runtime.review(project.key, record.id, 'approve')
    }
    for (const [query, count, capped] of [['under', 9, false], ['exact', 10, false], ['fifty', 50, false], ['over', 50, true]]) {
      const result = runtime.searchCandidatesDetailed(cwd, query, 50)
      assert.equal(result.candidates.length, count)
      assert.equal(result.scanCapped, capped)
      assert.equal(result.scanLimit, 50)
    }
    const store = runtime.storeByKey(project.key, false)
    const strategy = store.createRetrievalStrategy({ title: 'synthetic ten-candidate cap', baseId: 'builtin-v1', config: { maxCandidates: 10, maxResults: 6 } })
    store.markRetrievalStrategyShadow(strategy.id)
    store.selectRetrievalStrategy(strategy.id)
    const capped = runtime.searchCandidatesDetailed(cwd, 'common', 50)
    assert.equal(capped.scanLimit, 10)
    assert.equal(capped.policyMaxCandidates, 10)
    assert.equal(capped.candidateCount, 10)
    assert.equal(capped.scanCapped, true)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('B1 history separates effective time from knowledge time after a later revision', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-history-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const now = Date.now()
    const sourceId = store.recordL0({
      sessionId: 's1', role: 'user', content: 'The service was retired after launch.', createdAt: now + 10, recordedAt: now + 10,
    })
    const memory = store.addMemory({
      content: 'The service was enabled during launch.', status: 'approved', validFrom: 1000, validTo: 2000,
    }).record
    const candidate = store.proposeRevision({
      memoryId: memory.id, expectedRevision: 1, content: 'The service was retired after launch.', sourceMessageIds: [sourceId],
      reason: 'A later event changed the service state.', validFrom: 4000,
    }, now + 60_000)
    store.approveRevision(candidate.id, now + 120_000)
    store.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, resolveConfig({}), root)
    const beforeRevisionKnown = runtime.history(cwd, memory.id, 1500, now + 90_000)
    assert.equal(beforeRevisionKnown?.totalRevisions, 1)
    assert.equal(beforeRevisionKnown?.selected?.content, 'The service was enabled during launch.')
    const originalBeforeRevisionKnown = beforeRevisionKnown?.revisions.find((revision) => revision.revision === 1)
    assert.ok(originalBeforeRevisionKnown)
    assert.equal('knownTo' in originalBeforeRevisionKnown, false, 'a future close time must not leak into an earlier knowledge view')
    assert.equal('supersededAt' in originalBeforeRevisionKnown, false, 'a future supersession time must not leak into an earlier knowledge view')

    const afterRevisionKnown = runtime.history(cwd, memory.id, 1500, now + 180_000)
    assert.equal(afterRevisionKnown?.totalRevisions, 2)
    assert.equal(afterRevisionKnown?.selected?.content, 'The service was enabled during launch.')
    assert.ok(afterRevisionKnown?.revisions.some((revision) => revision.revision === 2))
    assert.equal(runtime.history(cwd, memory.id, 4500, now + 180_000)?.selected?.content, 'The service was retired after launch.')
    runtime.forget(cwd, memory.id)
    assert.equal(runtime.history(cwd, memory.id, 1500, now + 180_000), undefined)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('B1 tools expose bounded relation and explicit-time candidates without a model call', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-tool-routes-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  const actualNow = Date.now
  const base = actualNow()
  let clock = base - 100_000
  Date.now = () => clock
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const seedSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Deploy failure E4021 on the gateway.', sourceEventId: 'tool-route-seed' })
    const relatedSource = store.recordL0({ sessionId: 's2', role: 'user', content: 'Gateway path mapping table uses the derived index.', sourceEventId: 'tool-route-related' })
    const distantSource = store.recordL0({ sessionId: 's4', role: 'user', content: 'A second hop describes the shard cache.', sourceEventId: 'tool-route-distant' })
    const evidence = store.recordL0({ sessionId: 's1', role: 'user', content: 'Relation evidence for E4021.', sourceEventId: 'tool-route-evidence' })
    const temporalSource = store.recordL0({ sessionId: 's3', role: 'user', content: 'Service state source one.', sourceEventId: 'tool-route-temporal-one' })
    const temporalSourceTwo = store.recordL0({ sessionId: 's4', role: 'user', content: 'Service retirement source two.', sourceEventId: 'tool-route-temporal-two' })
    clock = base - 90_000
    const seed = store.addMemory({ content: 'Deploy failure E4021 on the gateway.', status: 'approved', sourceMessageIds: [seedSource], sourceVerified: true }).record
    const related = store.addMemory({ content: 'Gateway path mapping table uses the derived index.', status: 'approved', sourceMessageIds: [relatedSource], sourceVerified: true }).record
    const distant = store.addMemory({ content: 'The shard cache is refreshed after remapping.', status: 'approved', sourceMessageIds: [distantSource], sourceVerified: true }).record
    const state = store.addMemory({ content: 'Service is ENABLED during launch.', status: 'approved', sourceMessageIds: [temporalSource],
      sourceVerified: true, validFrom: base - 95_000 }).record
    clock = base - 60_000
    const revision = store.proposeRevision({ memoryId: state.id, expectedRevision: 1, content: 'Service is RETIRED after launch.',
      sourceMessageIds: [temporalSourceTwo], reason: 'A later state change.', validFrom: base - 1_000 })
    clock = base - 50_000
    store.approveRevision(revision.id)
    const relation = store.proposeRelation({ fromId: seed.id, toId: related.id, type: 'derived_from', evidenceIds: [evidence] })
    store.reviewRelationCandidate(relation.id, true)
    const secondHop = store.proposeRelation({ fromId: related.id, toId: distant.id, type: 'supports', evidenceIds: [evidence] })
    store.reviewRelationCandidate(secondHop.id, true)
    store.close()
    Date.now = actualNow

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ extraction: { enabled: false } }), root)
    const definitions = new Map()
    const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
    try {
      const execution = { agent: { session: { header: { cwd } } } }
      const search = definitions.get('memory_search')
      const relatedSearch = await search.execute({ query: 'E4021', limit: 5, budget_tokens: 6000 }, execution)
      const relatedHit = relatedSearch.results.find((result) => result.id === globalMemoryKey(project.key, related.id))
      assert.ok(relatedHit, 'a relation-only candidate is returned by the real tool path')
      assert.equal(relatedHit.routes.includes('relation'), true)
      assert.equal(relatedSearch.routes.find((route) => route.name === 'relation').candidateCount >= 1, true)
      assert.equal(relatedSearch.temporal, false)
      assert.equal(relatedSearch.stopReason.length > 0, true)
      const depthZero = await search.execute({ query: 'E4021', relation_depth: 0, limit: 20, budget_tokens: 6000 }, execution)
      assert.ok(depthZero.results.some((item) => item.id === globalMemoryKey(project.key, seed.id)))
      assert.equal(depthZero.results.some((item) => item.id === globalMemoryKey(project.key, related.id)), false)
      const depthOne = await search.execute({ query: 'E4021', relation_depth: 1, limit: 20, budget_tokens: 6000 }, execution)
      assert.ok(depthOne.results.some((item) => item.id === globalMemoryKey(project.key, related.id)))
      assert.equal(depthOne.results.some((item) => item.id === globalMemoryKey(project.key, distant.id)), false)
      const depthTwo = await search.execute({ query: 'E4021', relation_depth: 2, limit: 20, budget_tokens: 6000 }, execution)
      assert.ok(depthTwo.results.some((item) => item.id === globalMemoryKey(project.key, distant.id)), 'two proven hops are reachable')
      assert.ok(depthTwo.candidateCount <= 50)
      assert.ok(depthTwo.routes.find((route) => route.name === 'relation').candidateCount <= 16)
      assert.equal(new Set(depthTwo.results.map((item) => item.id)).size, depthTwo.results.length)


      const temporalSearch = await search.execute({ query: 'service launch', effective_at: base - 80_000, known_at: base - 40_000, budget_tokens: 6000 }, execution)
      const temporalHit = temporalSearch.results.find((result) => result.id === state.id)
      assert.ok(temporalHit)
      assert.equal(temporalSearch.temporal, true)
      assert.equal(temporalHit.temporal_selected, true)
      assert.match(temporalHit.content, /ENABLED/u, 'explicit dual-time search returns the historical revision')
      const currentSearch = await search.execute({ query: 'service launch', effective_at: base, known_at: base, budget_tokens: 6000 }, execution)
      assert.match(currentSearch.results.find((result) => result.id === state.id).content, /RETIRED/u)
      await assert.rejects(search.execute({ query: 'service launch', known_at: base - 40_000 }, execution), /known_at requires effective_at/u)
      runtime.control.revokeSourceEvent(project.key, 'tool-route-evidence', evidence)
      const withdrawn = await search.execute({ query: 'E4021', relation_depth: 2, limit: 20, budget_tokens: 6000 }, execution)
      assert.equal(withdrawn.results.some((item) => item.id === globalMemoryKey(project.key, related.id)), false)
      assert.equal(withdrawn.results.some((item) => item.id === globalMemoryKey(project.key, distant.id)), false,
        'withdrawn relation evidence cannot contribute a later-hop target')

    } finally {
      dispose()
    }
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('C1 memory_experience tool matches explicit condition facts without upgrading status', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-experience-tool-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const sourceA = store.recordL0({ sessionId: 's1', role: 'user', content: 'Cache recovery requires a moved path.', sourceEventId: 'exp-tool-a' })
    const sourceB = store.recordL0({ sessionId: 's2', role: 'user', content: 'Independent cache recovery report.', sourceEventId: 'exp-tool-b' })
    const evidenceA = store.addMemory({ content: 'Cache recovery evidence one.', status: 'approved', sourceMessageIds: [sourceA], sourceVerified: true }).record
    const evidenceB = store.addMemory({ content: 'Cache recovery evidence two.', status: 'approved', sourceMessageIds: [sourceB], sourceVerified: true }).record
    store.close()
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ extraction: { enabled: false } }), root)
    runtime.saveExperience(project.key, { id: 'exp-tool', title: 'Cache recovery', symptom: 'stale cache after path change',
      environment: { os: 'linux', runtime: 'node-22' }, prerequisites: ['path has moved'], steps: ['clear derived index'],
      outcomes: ['index rebuilt'], counterexamples: ['source rows are missing'], evidenceMemoryIds: [evidenceA.id, evidenceB.id] })
    const overflowEnvironment = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`condition-${index}`, `value-${index}`]))
    const overflowPrerequisites = Array.from({ length: 33 }, (_, index) => `required condition ${index}`)
    runtime.saveExperience(project.key, { id: 'exp-tool-overflow', title: 'Bounded recovery', symptom: 'bounded condition facts',
      environment: overflowEnvironment, prerequisites: overflowPrerequisites, steps: [], outcomes: [], counterexamples: [],
      evidenceMemoryIds: [evidenceA.id, evidenceB.id] })
    const definitions = new Map()
    const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
    try {
      const execution = { agent: { session: { header: { cwd } } } }
      const experience = definitions.get('memory_experience')
      const toolSource = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
      assert.match(toolSource, /const DEFAULT_AGENT_TOOL_BUDGET = 1600/u)
      assert.match(toolSource, /const MAX_AGENT_TOOL_BUDGET = 6000/u)
      const satisfied = await experience.execute({ query: 'cache recovery', environment: { os: 'linux', runtime: 'node-22' },
        conditions: { runtime: 'node-22' }, satisfied_prerequisites: ['path has moved'], limit: 1, budget_tokens: 6000 }, execution)
      assert.equal(satisfied.results[0].applicability, 'applicable')
      assert.equal(satisfied.results[0].verified, false)
      assert.equal(satisfied.results[0].executionAuthorized, false)
      assert.deepEqual(satisfied.results[0].prerequisites.satisfied, ['path has moved'])

      const overflow = await experience.execute({ query: 'bounded recovery', environment: Object.fromEntries(Object.entries(overflowEnvironment).slice(0, 32)),
        satisfied_prerequisites: overflowPrerequisites.slice(0, 32), limit: 1, budget_tokens: 6000 }, execution)
      const overflowResult = overflow.results.find((result) => result.experience.id === 'exp-tool-overflow')
      assert.equal(overflowResult?.applicability, 'conditions_missing')
      assert.equal(overflowResult?.conditionState, 'unknown')
      assert.equal(overflowResult?.truncated, true, 'the tool result surfaces omitted stored conditions')
      assert.equal(overflowResult?.prerequisites.satisfied.length, 32)

      const legacy = await experience.execute({ query: 'cache recovery', environment: { os: 'linux', runtime: 'node-22' },
        limit: 1, budget_tokens: 6000 }, execution)
      assert.equal(legacy.results[0].applicability, 'conditions_missing', 'the legacy two-argument call stays conservative')
      assert.equal(legacy.results[0].verified, false)

      const versionChanged = await experience.execute({ query: 'cache recovery', environment: { os: 'linux', runtime: 'node-20' },
        satisfied_prerequisites: ['path has moved'], limit: 1, budget_tokens: 6000 }, execution)
      assert.equal(versionChanged.results[0].applicability, 'partially_applicable', 'a changed runtime version is an explicit mismatch')
      assert.deepEqual(versionChanged.results[0].different, [{ key: 'runtime', expected: 'node-22', actual: 'node-20' }])
      const allDifferent = await experience.execute({ query: 'cache recovery', environment: { os: 'windows', runtime: 'node-20' },
        satisfied_prerequisites: ['path has moved'], limit: 1, budget_tokens: 6000 }, execution)
      assert.equal(allDifferent.results[0].applicability, 'inapplicable')

      const counterexample = await experience.execute({ query: 'cache recovery source rows are missing', environment: {},
        satisfied_prerequisites: ['path has moved'], limit: 1, budget_tokens: 6000 }, execution)
      assert.equal(counterexample.results[0].applicability, 'known_counterexample')

      await assert.rejects(experience.execute({ query: 'cache recovery', environment: {},
        conditions: { runtime: 22 }, limit: 1, budget_tokens: 6000 }, execution), /condition values must be strings/u)
      await assert.rejects(experience.execute({ query: 'cache recovery', environment: {},
        satisfied_prerequisites: 'path has moved', limit: 1, budget_tokens: 6000 }, execution), /satisfied_prerequisites must be an array/u)

      const omitted = await experience.execute({ query: 'cache recovery', environment: { os: 'linux', runtime: 'node-22' },
        limit: 1, budget_tokens: 128 }, execution)
      assert.equal(omitted.status, 'budget_exceeded')
      assert.equal(omitted.omitted, true)
      assert.equal(omitted.retryable, true)
      assert.equal(omitted.budgetTokens, 128)
      assert.equal('results' in omitted, false, 'low-budget omission is asserted separately from semantic applicability')
      assert.equal(Number.isSafeInteger(omitted.estimatedTokens), true)
      assert.equal(omitted.estimatedTokens, estimateTokens(JSON.stringify(omitted, null, 2) ?? ''))
      assert.ok(omitted.estimatedTokens <= omitted.budgetTokens, 'the omission envelope reports its actual bounded estimate')

      runtime.control.revokeSourceEvent(project.key, 'exp-tool-a', sourceA)
      const afterRevocation = await experience.execute({ query: 'cache recovery', environment: { os: 'linux', runtime: 'node-22' },
        satisfied_prerequisites: ['path has moved'], limit: 1, budget_tokens: 6000 }, execution)
      assert.deepEqual(afterRevocation.results, [], 'revoked evidence removes the experience from the read path')
    } finally {
      dispose()
    }
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
