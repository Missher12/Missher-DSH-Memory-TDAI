import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { endTurnAfterQuietWindow, sourceAwareStream } from './helpers.mjs'

function mockContext(session) {
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: { stream: sourceAwareStream((sourceIds) => ({ memories: [{ content: '用户偏好使用 pnpm 管理前端项目。', kind: 'preference', confidence: 0.93, source_message_ids: sourceIds }] })) },
    sessions: { get: (id) => id === session.id ? session : undefined },
    get() {
      return undefined
    },
  }
}

test('runtime captures a turn, extracts L1, auto-approves in balanced mode, and recalls it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-'))
  try {
    const config = resolveConfig({
      mode: 'balanced',
      autoApproveConfidence: 0.5,
      extraction: { minTurnChars: 0, enabled: true, everyNConversations: 1, provider: 'mock', model: 'mock-model' },
      budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
      recall: { enabled: true, minScore: 0 },
    })
    const session = { id: 's1', header: { cwd: process.cwd(), agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
    const runtime = new MemoryRuntime(mockContext(session), config, root)
    runtime.onSessionEvent(session, {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    runtime.onSessionEvent(session, {
      type: 'assistant/message',
      seq: 2,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，记录一下。' }] } },
    })
    endTurnAfterQuietWindow(runtime, session, 3)
    await runtime.runExtraction('s1')

    const hits = runtime.recall(process.cwd(), 'pnpm 前端')
    assert.equal(hits.length, 1)
    const block = runtime.formatRecall(process.cwd(), hits)
    assert.ok(block.includes('<memory-context'))
    assert.ok(block.includes('pnpm'))
    assert.ok(block.includes('mem_'))

    const status = runtime.status()
    assert.equal(status.projects.length, 1)
    assert.equal(status.projects[0].stats.approved, 1)
    runtime.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('queued startup recovery skips a runtime that was closed before its microtask', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-close-before-recovery-'))
  let runtime
  let pendingDeletionReads = 0
  try {
    const session = { id: 's1', header: { cwd: process.cwd() } }
    runtime = new MemoryRuntime(mockContext(session), resolveConfig({}), root)
    const readPending = runtime.control.pendingContentDeletionIntents.bind(runtime.control)
    runtime.control.pendingContentDeletionIntents = (...args) => {
      pendingDeletionReads += 1
      return readPending(...args)
    }

    runtime.close()
    await Promise.resolve()

    assert.equal(pendingDeletionReads, 0, 'startup recovery does not read a closed control ledger')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('recall merges a bounded relation route without a model call and honours revocation, cycles and exclusion', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-route-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-route-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = openProjectStore(root, project.key, project)
    const seedSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Alpha-42 cache rebuild trigger source.', sourceEventId: 'route-seed-event' })
    const controlSource = store.recordL0({ sessionId: 's1-control', role: 'user', content: 'Independent lexical control source.', sourceEventId: 'route-control-event' })
    const relatedSource = store.recordL0({ sessionId: 's2', role: 'user', content: 'The derived index uses the path mapping table.', sourceEventId: 'route-related-event' })
    const cycleSource = store.recordL0({ sessionId: 's3', role: 'user', content: 'Cycle premise note for the rebuild.', sourceEventId: 'route-cycle-event' })
    const evidenceSource = store.recordL0({ sessionId: 's1', role: 'user', content: 'Relation evidence for alpha-42.', sourceEventId: 'route-evidence-event' })
    const cycleEvidence = store.recordL0({ sessionId: 's3', role: 'user', content: 'Cycle relation evidence.', sourceEventId: 'route-cycle-evidence' })
    const privateSource = store.recordL0({ sessionId: 'private', role: 'user', content: 'Private relation target source.', agentPreset: 'private-agent' })
    const chineseSource = store.recordL0({ sessionId: 's4', role: 'user', content: '项目代号「星河计划」已经确认。', sourceEventId: 'route-chinese-event' })
    const seed = store.addMemory({ content: 'Alpha-42 cache rebuild trigger appears in the log.', status: 'approved', sourceMessageIds: [seedSource], sourceVerified: true }).record
    const control = store.addMemory({ content: 'Alpha-42 independent lexical control remains readable.', status: 'approved',
      sourceMessageIds: [controlSource], sourceVerified: true }).record
    const related = store.addMemory({ content: 'The derived index uses the path mapping table.', status: 'approved', sourceMessageIds: [relatedSource], sourceVerified: true }).record
    const cycleNode = store.addMemory({ content: 'Cycle premise note for the rebuild.', status: 'approved', sourceMessageIds: [cycleSource], sourceVerified: true }).record
    const privateNode = store.addMemory({ content: 'Private relation target note.', status: 'approved', sourceMessageIds: [privateSource], sourceVerified: true }).record
    const chineseMemory = store.addMemory({ content: '项目代号「星河计划」已经确认。', status: 'approved', sourceMessageIds: [chineseSource], sourceVerified: true }).record
    const forward = store.proposeRelation({ fromId: seed.id, toId: related.id, type: 'derived_from', evidenceIds: [evidenceSource] })
    store.reviewRelationCandidate(forward.id, true)
    const cycle = store.proposeRelation({ fromId: seed.id, toId: cycleNode.id, type: 'depends_on', evidenceIds: [evidenceSource] })
    store.reviewRelationCandidate(cycle.id, true)
    const back = store.proposeRelation({ fromId: cycleNode.id, toId: seed.id, type: 'derived_from', evidenceIds: [evidenceSource] })
    store.reviewRelationCandidate(back.id, true)
    const privateRelation = store.proposeRelation({ fromId: seed.id, toId: privateNode.id, type: 'supports', evidenceIds: [cycleEvidence] })
    store.reviewRelationCandidate(privateRelation.id, true)
    store.close()

    let llmCalls = 0
    runtime = new MemoryRuntime(
      { logger: { info() {}, warn() {}, debug() {}, error() {} },
        llm: { stream() { llmCalls += 1; throw new Error('recall must not call the model') } },
        get() { return undefined } },
      resolveConfig({ capture: { excludeAgents: ['private-agent'] }, extraction: { enabled: false }, recall: { enabled: true, minScore: 0 } }),
      root,
    )
    const hits = runtime.recall(cwd, 'alpha-42', undefined, { relationDepth: 2 })
    const byId = new Map(hits.map((hit) => [hit.record.id, hit]))
    assert.equal(byId.has(seed.id), true)
    assert.equal(byId.has(control.id), true, 'an independent lexical control is retained')
    assert.equal(byId.has(related.id), true, 'a candidate reachable only through an approved relation is recalled')
    assert.equal(byId.has(cycleNode.id), true, 'the second hop stays bounded while the cycle terminates')
    assert.equal(byId.has(privateNode.id), false, 'a relation endpoint outside the current Agent scope is not recalled')
    assert.equal(byId.get(related.id).routes.includes('relation'), true)
    assert.equal(hits.filter((hit) => hit.record.id === related.id).length, 1, 'each memory appears once in the merged window')
    assert.equal(llmCalls, 0, 'the deterministic relation route performs no model call')
    const block = runtime.formatRecall(cwd, hits)
    assert.ok(block.includes('path mapping table'))
    const chineseHits = runtime.recall(cwd, '星河计划')
    assert.equal(chineseHits.some((hit) => hit.record.id === chineseMemory.id), true,
      'a Chinese proper noun found only by the literal routes is still recalled')
    assert.equal(llmCalls, 0)

    runtime.control.revokeSourceEvent(project.key, 'route-evidence-event', evidenceSource)
    const afterRevocation = runtime.recall(cwd, 'alpha-42', undefined, { relationDepth: 2 })
    assert.deepEqual(afterRevocation.map((hit) => hit.record.id), [control.id],
      'revoked dependency evidence removes the dependent lexical seed and both expanded nodes while keeping the independent control')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('explicit dual-time recall selects the historical revision and format never swaps in the current body', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-temporal-route-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-temporal-project-'))
  const actualNow = Date.now
  const base = actualNow()
  let runtime
  try {
    const project = projectIdentity(cwd)
    let clock = base - 100_000
    Date.now = () => clock
    const store = openProjectStore(root, project.key, project)
    const firstSource = store.recordL0({ sessionId: 't1', role: 'user', content: 'Launch state source one.', sourceEventId: 'temporal-event-one' })
    const dependentSource = store.recordL0({ sessionId: 't3', role: 'user', content: 'Temporal dependent source.', sourceEventId: 'temporal-dependent-event' })
    const premiseSource = store.recordL0({ sessionId: 't4', role: 'user', content: 'Temporal premise source.', sourceEventId: 'temporal-premise-event' })
    const relationEvidence = store.recordL0({ sessionId: 't5', role: 'user', content: 'Temporal relation evidence.', sourceEventId: 'temporal-relation-event' })
    const independentSource = store.recordL0({ sessionId: 't6', role: 'user', content: 'Independent temporal control source.', sourceEventId: 'temporal-control-event' })
    clock = base - 90_000
    const memory = store.addMemory({ content: 'Service is ENABLED during launch.', status: 'approved',
      sourceMessageIds: [firstSource], sourceVerified: true, validFrom: base - 100_000 }).record
    const temporalDependent = store.addMemory({ content: 'history-dependent-marker dependent body.', status: 'approved',
      sourceMessageIds: [dependentSource], sourceVerified: true, validFrom: base - 100_000 }).record
    const temporalPremise = store.addMemory({ content: 'Prerequisite condition remains satisfied.', status: 'approved',
      sourceMessageIds: [premiseSource], sourceVerified: true, validFrom: base - 100_000 }).record
    const independentControl = store.addMemory({ content: 'history-dependent-marker independent control.', status: 'approved',
      sourceMessageIds: [independentSource], sourceVerified: true, validFrom: base - 100_000 }).record
    clock = base - 85_000
    const dependencyRelation = store.proposeRelation({ fromId: temporalDependent.id, toId: temporalPremise.id,
      type: 'depends_on', evidenceIds: [relationEvidence] })
    store.reviewRelationCandidate(dependencyRelation.id, true)
    const secondSource = store.recordL0({ sessionId: 't2', role: 'user', content: 'Retirement state source two.', sourceEventId: 'temporal-event-two' })
    clock = base - 60_000
    const revision = store.proposeRevision({ memoryId: memory.id, expectedRevision: 1, content: 'Service is RETIRED after launch.',
      sourceMessageIds: [secondSource], reason: 'A later state change.', validFrom: base - 1_000 })
    clock = base - 50_000
    store.approveRevision(revision.id)
    store.close()
    Date.now = actualNow

    let llmCalls = 0
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} },
      llm: { stream() { llmCalls += 1; throw new Error('temporal recall must not call the model') } }, get() { return undefined } },
      resolveConfig({ extraction: { enabled: false }, recall: { enabled: true } }), root)
    const early = runtime.recall(cwd, 'service launch', undefined, { effectiveAt: base - 80_000, knownAt: base - 40_000 })
    assert.equal(early.length, 1)
    assert.equal(early[0].record.revision, 1)
    assert.match(early[0].record.content, /ENABLED/u)
    assert.equal(early[0].routes.includes('temporal'), true)
    const earlyBlock = runtime.formatRecall(cwd, early)
    assert.match(earlyBlock, /ENABLED/u)
    assert.doesNotMatch(earlyBlock, /RETIRED/u, 'the final format step keeps the explicitly selected historical revision')

    const dependentHits = runtime.recall(cwd, 'history-dependent-marker', undefined,
      { effectiveAt: base - 80_000, knownAt: base - 40_000, relationDepth: 0 })
    assert.deepEqual(new Set(dependentHits.map((hit) => hit.record.id)), new Set([temporalDependent.id, independentControl.id]))
    const selectedBlock = runtime.formatRecall(cwd, dependentHits)
    assert.match(selectedBlock, /dependent body/u)
    assert.match(selectedBlock, /independent control/u)
    runtime.control.revokeSourceEvent(project.key, 'temporal-relation-event', relationEvidence)
    const afterDependencyRevocation = runtime.formatRecall(cwd, dependentHits)
    assert.doesNotMatch(afterDependencyRevocation, /dependent body/u,
      'final temporal formatting rechecks the current historical dependency evidence fence')
    assert.match(afterDependencyRevocation, /independent control/u, 'an independent temporal control remains readable')
    assert.equal(llmCalls, 0, 'temporal selection and final formatting perform no model call')

    const current = runtime.recall(cwd, 'service launch', undefined, { effectiveAt: base, knownAt: base })
    assert.equal(current[0].record.revision, 2)
    assert.match(current[0].record.content, /RETIRED/u)

    runtime.review(project.key, memory.id, 'forget')
    assert.deepEqual(runtime.recall(cwd, 'service launch', undefined, { effectiveAt: base - 80_000, knownAt: base - 40_000 }), [],
      'a historical time never bypasses the latest forget fence')
    assert.equal(runtime.formatRecall(cwd, early), undefined, 'a historical hit is dropped when the current read policy denies it')
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('explicit knownAt filters relations by their creation boundary before historical expansion', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-relation-known-at-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-relation-known-at-project-'))
  const actualNow = Date.now
  const base = actualNow()
  let runtime
  try {
    const project = projectIdentity(cwd)
    let clock = base - 30_000
    Date.now = () => clock
    const store = openProjectStore(root, project.key, project)
    const seedSource = store.recordL0({ sessionId: 'known-at-seed', role: 'user', content: 'Seed source predates its relation.' })
    const targetSource = store.recordL0({ sessionId: 'known-at-target', role: 'user', content: 'Target source predates its relation.' })
    const evidence = store.recordL0({ sessionId: 'known-at-evidence', role: 'user', content: 'Relation evidence predates the relation.' })
    const seed = store.addMemory({ content: 'future-edge-marker lexical seed.', status: 'approved', sourceMessageIds: [seedSource],
      sourceVerified: true, validFrom: base - 30_000 }).record
    const target = store.addMemory({ content: 'historical relation target body.', status: 'approved', sourceMessageIds: [targetSource],
      sourceVerified: true, validFrom: base - 30_000 }).record
    const relationAt = base - 1_000
    clock = relationAt
    const relation = store.proposeRelation({ fromId: seed.id, toId: target.id, type: 'derived_from', evidenceIds: [evidence] })
    store.reviewRelationCandidate(relation.id, true)
    store.close()
    Date.now = actualNow

    let llmCalls = 0
    runtime = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} },
      llm: { stream() { llmCalls += 1; throw new Error('relation expansion must not call the model') } }, get() { return undefined } },
      resolveConfig({ extraction: { enabled: false }, recall: { enabled: true, minScore: 0 } }), root)
    const before = runtime.recall(cwd, 'future-edge-marker', undefined,
      { effectiveAt: base, knownAt: relationAt - 1, relationDepth: 1 })
    assert.deepEqual(before.map((hit) => hit.record.id), [seed.id], 'a relation created later is absent before knownAt')
    const atBoundary = runtime.recall(cwd, 'future-edge-marker', undefined,
      { effectiveAt: base, knownAt: relationAt, relationDepth: 1 })
    assert.equal(atBoundary.some((hit) => hit.record.id === target.id), true, 'the relation is visible at its creation timestamp')
    const after = runtime.recall(cwd, 'future-edge-marker', undefined,
      { effectiveAt: base, knownAt: relationAt + 1, relationDepth: 1 })
    assert.equal(after.some((hit) => hit.record.id === target.id), true, 'the relation remains visible after creation')
    const current = runtime.recall(cwd, 'future-edge-marker', undefined, { relationDepth: 1 })
    assert.equal(current.some((hit) => hit.record.id === target.id), true, 'current-time relation expansion keeps its existing behavior')
    assert.equal(llmCalls, 0)
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
