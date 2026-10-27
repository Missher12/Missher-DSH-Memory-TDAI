import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { DashboardSnapshotSchema, invocationDescriptors } from '../lib/remote-contract.js'
import { openProjectStore } from '../lib/store.js'

test('dashboard aggregates projects, activity, provenance, and token compression', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-'))
  let runtime
  try {
    const project = { key: 'proj-a', name: 'project-a', cwd: process.cwd() }
    const store = openProjectStore(root, project.key, project)
    store.addMemory({ content: '用户偏好使用 pnpm。', kind: 'preference', confidence: 0.9, status: 'approved', scene: 'billing' })
    store.addMemory({ content: '待审核的项目约束。', kind: 'project', confidence: 0.5, status: 'candidate' })
    store.recordL0({ sessionId: 's1', role: 'user', content: '前端用什么包管理器？' })
    store.recordL0({ sessionId: 's1', role: 'user', content: '前端用什么包管理器？' })
    store.recordEvent('inject', 1, 12, 40)
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime(
      { logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({}),
      root,
    )
    const snapshot = runtime.dashboard()
    assert.equal(snapshot.totals.projects, 1)
    assert.equal(snapshot.totals.memories, 2)
    assert.equal(snapshot.totals.approved, 1)
    assert.equal(snapshot.totals.candidates, 1)
    assert.equal(snapshot.totals.sessions, 1)
    assert.equal(snapshot.totals.repeatedQuestions, 1)
    assert.equal(snapshot.totals.injectedTokens, 12)
    assert.equal(snapshot.totals.savedTokens, 28)
    assert.equal(snapshot.sources.find((source) => source.source === 'manual')?.count, 2)
    assert.equal(snapshot.candidates[0].projectName, 'project-a')
    assert.equal(snapshot.longestSession?.messages, 2)
    assert.equal(snapshot.activity.length, 1)
    assert.equal(DashboardSnapshotSchema.safeParse(snapshot).success, true, JSON.stringify(DashboardSnapshotSchema.safeParse(snapshot).error))
    assert.equal(snapshot.scenes.length, 1)
    assert.equal(snapshot.scenes[0].sourceRevisions[snapshot.scenes[0].sourceIds[0]], 1)
    assert.equal(snapshot.scenes[0].summaryComplete, true)
    const snapshotDescriptor = invocationDescriptors.find((descriptor) => descriptor.method === 'snapshot')
    assert.ok(snapshotDescriptor, 'snapshot RPC descriptor exists')
    const descriptorResult = snapshotDescriptor.result.create().safeParse(snapshot)
    assert.equal(descriptorResult.success, true, JSON.stringify(descriptorResult.error))

    const approvedCandidate = runtime.review('proj-a', snapshot.candidates[0].id, 'approve')
    assert.equal(approvedCandidate?.status, 'approved')
    const afterApproval = runtime.dashboard()
    assert.equal(afterApproval.totals.approved, 2)
    const recentApproval = afterApproval.recent.find((memory) => memory.id === approvedCandidate.id)
    assert.equal(recentApproval?.content, approvedCandidate.content, 'recent full records are hydrated after metadata-only permission checks')
    assert.equal(recentApproval?.revision, approvedCandidate.revision)
    const generalScene = afterApproval.scenes.find((scene) => scene.name === 'general')
    assert.deepEqual(generalScene?.sourceIds, [approvedCandidate.id], 'lazy scene materialization keeps the complete approved source list')
    assert.equal(generalScene?.sourceRevisions[approvedCandidate.id], approvedCandidate.revision)
    const exported = runtime.exportProject('proj-a')
    assert.match(exported.content, /dsh-memory-tdai\/v1/)
    assert.match(exported.content, /pnpm/)

    runtime.updateSettings({ mode: 'review', recallMaxTokens: 300, dedupeSession: false, extractionEveryN: 5 })
    const after = runtime.dashboard()
    assert.equal(after.settings.mode, 'review')
    assert.equal(after.settings.recallMaxTokens, 300)
    assert.equal(after.settings.dedupeSession, false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard shares one current expiry instant across approved references and recent hydration', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-shared-expiry-'))
  const actualNow = Date.now
  let runtime
  let store
  let dashboardStore
  let clock = actualNow()
  try {
    const base = clock
    Date.now = () => clock
    const project = { key: 'dashboard-shared-expiry', name: 'dashboard-shared-expiry', cwd: process.cwd() }
    store = openProjectStore(root, project.key, project)
    const memories = []
    for (let index = 0; index < 9; index += 1) {
      clock = base + index
      memories.push(store.addMemory({ content: `Unique approved expiry memory ${index}.`, status: 'approved', scene: 'general' }).record)
    }
    const expiryAt = base + 20
    store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiryAt, memories[8].id)
    store.refreshScenes(base + 15)
    store.close()
    store = undefined

    clock = expiryAt - 1
    runtime = new MemoryRuntime(
      { logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({}),
      root,
    )
    const dashboardEntry = runtime.dashboardStores()[0]
    assert.ok(dashboardEntry, 'the fixture project is available to the runtime dashboard')
    dashboardStore = dashboardEntry.store
    const originalApprovedRecords = dashboardStore.approvedRecords.bind(dashboardStore)
    let advancedDuringHydration = false
    dashboardStore.approvedRecords = (...args) => {
      if (!advancedDuringHydration) {
        clock = expiryAt + 1
        advancedDuringHydration = true
      }
      return originalApprovedRecords(...args)
    }

    const first = runtime.dashboard()
    assert.equal(advancedDuringHydration, true)
    assert.equal(first.totals.approved, 9, 'the initial references use the captured pre-expiry wall clock')
    assert.equal(first.recent.length, 8, 'recent hydration uses the same captured expiry instant')
    assert.equal(first.recent.some((record) => record.id === memories[8].id), true, 'the newest record is not lost between reads')

    const next = runtime.dashboard()
    assert.equal(next.totals.approved, 8, 'the next dashboard call observes the elapsed expiry')
    assert.equal(next.recent.length, 8, 'the next call fills recent from the still-effective records')
    assert.equal(next.recent.some((record) => record.id === memories[8].id), false)
  } finally {
    Date.now = actualNow
    runtime?.close()
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard rebuilds its bounded read context after time, revision, source, exclude, and forget changes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-read-context-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-read-project-'))
  const config = resolveConfig({ capture: { excludeAgents: ['private-agent'] } })
  let runtime
  try {
    const project = { key: 'dashboard-read-project', name: 'dashboard-read-project', cwd }
    const store = openProjectStore(root, project.key, project)
    const now = Date.now()
    const expiry = now + 60 * 60 * 1000
    const baseSource = store.recordL0({ sessionId: 'dashboard-base', role: 'user', content: 'Synthetic base evidence.', sourceEventId: 'dashboard-event-base' })
    const derivedSource = store.recordL0({ sessionId: 'dashboard-derived', role: 'user', content: 'Synthetic derived evidence.', sourceEventId: 'dashboard-event-derived' })
    const relationEvidence = store.recordL0({ sessionId: 'dashboard-relation', role: 'user', content: 'Synthetic relation evidence.', sourceEventId: 'dashboard-event-relation' })
    const excludedSource = store.recordL0({ sessionId: 'dashboard-excluded', role: 'user', content: 'Synthetic excluded evidence.', agentPreset: 'private-agent' })
    const temporalSource = store.recordL0({ sessionId: 'dashboard-temporal', role: 'user', content: 'Synthetic expiring evidence.' })
    const base = store.addMemory({ content: 'Synthetic dashboard base memory.', status: 'approved', scene: 'base', sourceMessageIds: [baseSource], sourceVerified: true }).record
    const derived = store.addMemory({ content: 'Synthetic dashboard derived memory.', status: 'approved', scene: 'derived', sourceMessageIds: [derivedSource], sourceVerified: true }).record
    store.addMemory({ content: 'Synthetic excluded dashboard memory.', status: 'approved', scene: 'private', sourceMessageIds: [excludedSource], sourceVerified: true })
    const temporal = store.addMemory({ content: 'Synthetic temporal dashboard memory.', status: 'approved', scene: 'temporal', validFrom: now - 1000,
      validTo: expiry, sourceMessageIds: [temporalSource], sourceVerified: true }).record
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, config, root)
    const relation = runtime.proposeRelation(project.key, { fromId: derived.id, toId: base.id, type: 'depends_on', evidenceIds: [relationEvidence] })
    runtime.reviewRelation(project.key, relation.id, true)
    assert.equal(runtime.dashboard().totals.approved, 3, 'excluded memory is omitted while current approved memories remain visible')
    runtime.config.capture.excludeAgents = []
    assert.equal(runtime.dashboard().totals.approved, 4, 'a new call observes a changed exclusion policy')
    runtime.config.capture.excludeAgents = ['private-agent']
    assert.equal(runtime.dashboard().totals.approved, 3)

    const revision = runtime.proposeRevision(project.key, { memoryId: temporal.id, expectedRevision: temporal.revision,
      content: 'Synthetic revised temporal dashboard memory.', sourceMessageIds: [temporalSource], reason: 'Synthetic scene revision.', scene: 'temporal-v2', validTo: expiry })
    runtime.reviewRevision(project.key, revision.id, true)
    const revised = runtime.dashboard()
    const revisedScene = revised.scenes.find((scene) => scene.name === 'temporal-v2')
    assert.equal(revisedScene?.sourceRevisions[temporal.id], temporal.revision + 1, 'scene output carries the current approved revision')

    const actualNow = Date.now
    Date.now = () => expiry + 1
    try {
      assert.equal(runtime.dashboard().totals.approved, 2, 'a later dashboard call observes the memory valid-time boundary')
      runtime.control.revokeSourceEvent(project.key, 'dashboard-event-relation', relationEvidence)
      assert.equal(runtime.dashboard().totals.approved, 1, 'a relation-only evidence revocation hides the dependent memory')
      runtime.review(project.key, base.id, 'forget')
      assert.equal(runtime.dashboard().totals.approved, 0, 'a later dashboard call observes the forget fence')
    } finally { Date.now = actualNow }
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('export applies current Agent and dependency policy while keeping management history', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-export-policy-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-export-project-'))
  const otherCwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-export-other-'))
  const project = { key: 'export-policy-project', name: 'export-policy-project', cwd }
  const otherProject = { key: 'export-policy-other', name: 'export-policy-other', cwd: otherCwd }
  let runtime
  try {
    const now = Date.now()
    const store = openProjectStore(root, project.key, project)
    const normalSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Normal export source.', sourceEventId: 'export-event-normal' })
    const premiseSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Premise export source.', sourceEventId: 'export-event-premise' })
    const candidateSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Candidate export source.', sourceEventId: 'export-event-candidate' })
    const forgottenDependentSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Forgotten dependent export source.', sourceEventId: 'export-event-forgotten-dependent' })
    const privateSource = store.recordL0({ sessionId: 'private', role: 'user', content: 'Private agent source.', agentPreset: 'private-agent' })
    const sharedSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Shared export source.', sourceEventId: 'export-event-shared' })
    const revokedSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Revoked export source.', sourceEventId: 'export-event-revoked' })
    const crossSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Cross project export source.', sourceEventId: 'export-event-cross' })
    const relationEvidence = store.recordL0({ sessionId: 's1', role: 'user', content: 'Relation export evidence.', sourceEventId: 'export-event-relation' })
    const current = store.addMemory({ content: 'EXPORT-CURRENT alpha.', status: 'approved', sourceMessageIds: [normalSource], sourceVerified: true }).record
    const premise = store.addMemory({ content: 'EXPORT-PREMISE delta.', status: 'approved', sourceMessageIds: [premiseSource], sourceVerified: true }).record
    const dependent = store.addMemory({ content: 'EXPORT-DEPENDENT gamma.', status: 'approved', sourceMessageIds: [premiseSource], sourceVerified: true }).record
    const privateMemory = store.addMemory({ content: 'EXPORT-PRIVATE beta.', status: 'approved', sourceMessageIds: [privateSource], sourceVerified: true }).record
    const candidate = store.addMemory({ content: 'EXPORT-CANDIDATE epsilon.', status: 'candidate',
      sourceMessageIds: [candidateSource], sourceVerified: true }).record
    const forgottenDependent = store.addMemory({ content: 'EXPORT-FORGOTTEN-DEPENDENT lambda.', status: 'approved',
      sourceMessageIds: [forgottenDependentSource], sourceVerified: true }).record
    const forgotten = store.addMemory({ content: 'EXPORT-FORGOTTEN zeta.', status: 'approved' }).record
    store.forget(forgotten.id)
    const expired = store.addMemory({ content: 'EXPORT-EXPIRED eta.', status: 'approved', validTo: now - 1000 }).record
    const sharedOne = store.addMemory({ content: 'EXPORT-SHARED-ONE theta.', status: 'approved', sourceMessageIds: [sharedSource], sourceVerified: true }).record
    const sharedTwo = store.addMemory({ content: 'EXPORT-SHARED-TWO iota.', status: 'approved', sourceMessageIds: [sharedSource], sourceVerified: true }).record
    const revoked = store.addMemory({ content: 'EXPORT-REVOKED kappa.', status: 'approved', sourceMessageIds: [revokedSource], sourceVerified: true }).record
    const deleted = store.addMemory({ content: 'EXPORT-DELETED mu.', status: 'approved' }).record
    const cross = store.addMemory({ content: 'EXPORT-CROSS nu.', status: 'approved', sourceMessageIds: [crossSource], sourceVerified: true }).record
    store.close()

    const otherStore = openProjectStore(root, otherProject.key, otherProject)
    const otherSource = otherStore.recordL0({ sessionId: 'other', role: 'user', content: 'Other project source.', sourceEventId: 'export-event-cross' })
    const otherMemory = otherStore.addMemory({ content: 'EXPORT-OTHER-PROJECT xi.', status: 'approved', sourceMessageIds: [otherSource], sourceVerified: true }).record
    otherStore.close()

    runtime = new MemoryRuntime(
      { logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ capture: { excludeAgents: ['private-agent'] } }), root,
    )
    const relation = runtime.proposeRelation(project.key, { fromId: dependent.id, toId: premise.id, type: 'depends_on', evidenceIds: [relationEvidence] })
    runtime.reviewRelation(project.key, relation.id, true)
    const forgottenRelation = runtime.proposeRelation(project.key, { fromId: forgottenDependent.id, toId: premise.id,
      type: 'derived_from', evidenceIds: [relationEvidence] })
    runtime.reviewRelation(project.key, forgottenRelation.id, true)

    const beforeRevocation = runtime.exportProject(project.key).content.trim().split('\n').slice(1).map((line) => JSON.parse(line))
    const beforeById = new Map(beforeRevocation.map((row) => [row.id, row]))
    assert.equal(beforeById.get(dependent.id).content, 'EXPORT-DEPENDENT gamma.')
    assert.equal(beforeById.get(forgottenDependent.id).content, 'EXPORT-FORGOTTEN-DEPENDENT lambda.')

    runtime.control.revokeSourceEvent(project.key, 'export-event-shared', sharedSource)
    runtime.control.revokeSourceEvent(project.key, 'export-event-revoked', revokedSource)
    runtime.control.revokeSourceEvent(project.key, 'export-event-relation', relationEvidence)
    runtime.control.revokeSourceEvent(project.key, 'export-event-cross', crossSource)
    runtime.control.fenceContentDeletion({ projectKey: project.key, requestDigest: 'c'.repeat(64), memoryIds: [deleted.id], sourceIds: [] })
    runtime.review(project.key, premise.id, 'forget')
    runtime.review(project.key, forgottenDependent.id, 'forget')

    const exported = runtime.exportProject(project.key)
    const lines = exported.content.trim().split('\n')
    const header = JSON.parse(lines[0])
    const rows = lines.slice(1).map((line) => JSON.parse(line))
    const byId = new Map(rows.map((row) => [row.id, row]))
    assert.equal(header.format, 'dsh-memory-tdai/v1')
    assert.equal(header.count, rows.length)
    assert.equal(header.withheldCount, 2)
    assert.equal(byId.get(current.id).content, 'EXPORT-CURRENT alpha.')
    assert.equal(byId.has(privateMemory.id), false, 'a currently excluded Agent is omitted from the ordinary export')
    assert.equal(exported.content.includes('EXPORT-PRIVATE beta.'), false)
    const withheld = byId.get(dependent.id)
    assert.ok(withheld, 'the dependency-invalid row stays as management history metadata')
    assert.equal(withheld.content, '')
    assert.equal(withheld.contentWithheld, true)
    assert.equal(withheld.withheldReason, 'dependency_unreadable')
    assert.equal(byId.get(candidate.id).content, 'EXPORT-CANDIDATE epsilon.')
    assert.equal(byId.get(candidate.id).status, 'candidate')
    assert.equal(byId.get(candidate.id).sourceMessageIds[0], candidateSource,
      'an independent candidate keeps its permitted body after unrelated relation evidence is revoked')
    assert.equal(byId.get(forgotten.id).content, 'EXPORT-FORGOTTEN zeta.')
    assert.equal(byId.get(forgotten.id).status, 'forgotten')
    assert.equal(byId.get(expired.id).content, 'EXPORT-EXPIRED eta.', 'expired management history keeps its body')
    assert.equal(byId.get(premise.id).status, 'forgotten', 'review records remain inspectable after their premise is forgotten')
    assert.equal(byId.get(premise.id).content, 'EXPORT-PREMISE delta.', 'legitimate forgotten management history keeps its body')
    const forgottenWithheld = byId.get(forgottenDependent.id)
    assert.equal(forgottenWithheld.status, 'forgotten')
    assert.equal(forgottenWithheld.content, '')
    assert.equal(forgottenWithheld.contentWithheld, true,
      'a forgotten dependent retains management metadata but loses its body when relation evidence is revoked')
    assert.equal(byId.has(sharedOne.id), false, 'source revocation masks every memory citing that source')
    assert.equal(byId.has(sharedTwo.id), false)
    assert.equal(byId.has(revoked.id), false)
    assert.equal(byId.has(deleted.id), false)
    assert.equal(byId.has(cross.id), false)
    for (const row of rows) {
      assert.equal(typeof row.id, 'string')
      assert.equal(typeof row.status, 'string')
      assert.equal(typeof row.revision, 'number')
      assert.equal(typeof row.content, 'string')
    }

    runtime.config.capture.excludeAgents = []
    const reopened = runtime.exportProject(project.key)
    const reopenedRows = reopened.content.trim().split('\n').slice(1).map((line) => JSON.parse(line))
    assert.equal(reopenedRows.some((row) => row.id === privateMemory.id && row.content === 'EXPORT-PRIVATE beta.'), true,
      'a changed exclusion rule is observed by the next ordinary export')
    assert.equal(reopenedRows.find((row) => row.id === dependent.id)?.contentWithheld, true)

    const otherExport = runtime.exportProject(otherProject.key)
    const otherRows = otherExport.content.trim().split('\n').slice(1).map((line) => JSON.parse(line))
    assert.equal(otherRows.some((row) => row.id === otherMemory.id && row.content === 'EXPORT-OTHER-PROJECT xi.'), true,
      'a source fence in one project never hides another project export')
    assert.equal(otherExport.content.includes('EXPORT-CURRENT alpha.'), false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    rmSync(otherCwd, { recursive: true, force: true })
  }
})
