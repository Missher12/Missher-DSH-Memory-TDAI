import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { openProjectStore } from '../lib/store.js'
import { projectIdentity } from '../lib/project.js'

const dayStart = Date.UTC(2026, 9, 24)
const dayEnd = dayStart + 86_400_000

function hostContext() {
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: { stream() { throw new Error('identity overview must not call the model') } },
    sessions: { get() { return undefined } },
    get() { return undefined },
  }
}

function config(excludeAgents = []) {
  return resolveConfig({ extraction: { enabled: false }, capture: { excludeAgents } })
}

function overview(runtime, projectKey, from = '2026-10-24', to = '2026-10-24') {
  return runtime.overview({ projectKey, from, to, timeZone: 'UTC', activity: 'capture' })
}

function identity(digest) {
  return { schema: 'memory-tdai/original-message/v1', algorithm: 'sha256', digest: digest.repeat(64) }
}

function identityDigest(store, sessionId, role) {
  const rows = store.db.prepare(`SELECT metadata FROM memory_events WHERE type = 'capture' AND session_id = ? ORDER BY id`)
    .all(sessionId)
  return rows.map((row) => JSON.parse(String(row.metadata)))
    .find((metadata) => metadata.role === role && metadata.originalMessageIdentity !== undefined)?.originalMessageIdentity?.digest
}

test('official user/message and assistant/message wrappers produce scoped, deduplicated identity lower bounds', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-scope-'))
  const cwdA = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-project-a-'))
  const cwdB = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-project-b-'))
  const projectA = projectIdentity(cwdA)
  const projectB = projectIdentity(cwdB)
  const originalNow = Date.now
  let runtime
  try {
    Date.now = () => dayStart + 100
    runtime = new MemoryRuntime(hostContext(), config(), root)
    const session = { id: 'same-session', header: { cwd: cwdA, agentPreset: 'agent-main' } }
    const first = { type: 'user/message', seq: 1, time: dayStart + 1,
      data: { id: 'same-original-id', role: 'user', content: [{ type: 'text', text: 'same text' }] } }
    runtime.onSessionEvent(session, first)
    runtime.onSessionEvent(session, first)
    runtime.onSessionEvent(session, { ...first, seq: 2, time: dayStart + 2 })
    runtime.onSessionEvent(session, { ...first, seq: 3, time: dayStart + 3,
      data: { ...first.data, id: 'different-original-id' } })
    runtime.onSessionEvent(session, { type: 'assistant/message', seq: 4, time: dayStart + 4,
      data: { message: { id: 'same-original-id', role: 'assistant', content: [{ type: 'text', text: 'assistant text' }] } } })
    runtime.onSessionEvent(session, { type: 'assistant/message', seq: 5, time: dayStart + 5,
      data: { id: 'outer-id-is-not-the-message-id', message: { role: 'assistant', content: [{ type: 'text', text: 'missing id' }] } } })
    runtime.onSessionEvent(session, { type: 'assistant/message', seq: 6, time: dayStart + 6,
      data: { message: { id: 'wrong-role-id', role: 'user', content: [{ type: 'text', text: 'role mismatch' }] } } })
    runtime.onSessionEvent(session, { type: 'assistant/message', seq: 7, time: dayStart + 7,
      data: { message: { id: '', role: 'assistant', content: [{ type: 'text', text: 'empty id' }] } } })
    runtime.onSessionEvent(session, { type: 'user/message', seq: 8, time: dayStart + 8,
      data: { id: 123, role: 'user', content: [{ type: 'text', text: 'non-string id' }] } })
    runtime.onSessionEvent({ id: 'other-session', header: { cwd: cwdA, agentPreset: 'agent-main' } }, {
      type: 'user/message', seq: 1, time: dayStart + 7,
      data: { id: 'same-original-id', role: 'user', content: [{ type: 'text', text: 'same text in another session' }] },
    })

    const resultA = overview(runtime, projectA.key)
    assert.equal(resultA.period.captures, 9, 'an exact wrapped-event replay remains one capture event')
    assert.equal(resultA.period.recordedOriginalMessageLowerBound, 4,
      'same ID across seq is one; a different ID, role, and session are distinct')
    assert.equal(resultA.period.unknownOriginalMessageEvents, 4,
      'outer payload IDs, empty/non-string IDs, and role-mismatched message IDs remain unknown')
    assert.equal(resultA.period.topSessions[0].recordedOriginalMessageLowerBound, 3)
    assert.equal(resultA.period.topSessions[0].unknownOriginalMessageEvents, 4)

    runtime.close()
    runtime = undefined
    const secondRuntime = new MemoryRuntime(hostContext(), config(), root)
    try {
      const otherProjectSession = { id: 'same-session', header: { cwd: cwdB, agentPreset: 'agent-main' } }
      secondRuntime.onSessionEvent(otherProjectSession, {
        type: 'user/message', seq: 1, time: dayStart + 1,
        data: { id: 'same-original-id', role: 'user', content: [{ type: 'text', text: 'same text' }] },
      })
      const resultB = overview(secondRuntime, projectB.key)
      assert.equal(resultB.period.recordedOriginalMessageLowerBound, 1)
      assert.equal(resultB.period.unknownOriginalMessageEvents, 0)
    } finally {
      secondRuntime.close()
    }

    const storeA = openProjectStore(root, projectA.key, projectA)
    const storeB = openProjectStore(root, projectB.key, projectB)
    try {
      const userDigest = identityDigest(storeA, 'same-session', 'user')
      const assistantDigest = identityDigest(storeA, 'same-session', 'assistant')
      const otherSessionDigest = identityDigest(storeA, 'other-session', 'user')
      const projectBDigest = identityDigest(storeB, 'same-session', 'user')
      assert.match(userDigest ?? '', /^[a-f0-9]{64}$/u)
      assert.notEqual(userDigest, assistantDigest, 'role and event type are part of the identity scope')
      assert.notEqual(userDigest, otherSessionDigest, 'session is part of the identity scope')
      assert.notEqual(userDigest, projectBDigest, 'project is part of the identity scope')
      const reopened = storeA.captureOriginalMessageMetrics(dayStart, dayEnd, [], (items) => items.map(() => true))
      assert.equal(reopened.recordedOriginalMessageLowerBound, 4, 'identity metadata survives a store restart')
    } finally {
      storeA.close()
      storeB.close()
    }
  } finally {
    Date.now = originalNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwdA, { recursive: true, force: true })
    rmSync(cwdB, { recursive: true, force: true })
  }
})

test('identity capture replay preserves accepted evidence and leaves legacy identity unknown', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-replay-'))
  let store
  try {
    store = openProjectStore(root, 'identity-replay')
    const base = { sessionId: 'session-replay', role: 'user', content: 'same text',
      createdAt: dayStart + 10, recordedAt: dayStart + 10, sourceEventId: 'replay-source-event' }
    const first = store.captureMessage({ ...base, originalMessageIdentity: identity('a') })
    const exact = store.captureMessage({ ...base, originalMessageIdentity: identity('a') })
    assert.equal(exact.created, false)
    assert.equal(exact.id, first.id)
    assert.equal(store.captureMessage(base).created, false, 'a later missing identity does not erase the known hash')
    assert.throws(() => store.captureMessage({ ...base, originalMessageIdentity: identity('b') }), /idempotency key conflicts/u,
      'a conflicting identity for an identified source event is rejected')
    const accepted = JSON.parse(String(store.db.prepare("SELECT metadata FROM memory_events WHERE event_id = 'capture:replay-source-event'").get().metadata))
    assert.equal(accepted.originalMessageIdentity.digest, 'a'.repeat(64))
    assert.equal(store.db.prepare('SELECT source_event_id FROM l0_messages WHERE id = ?').get(first.id).source_event_id, 'replay-source-event',
      'the independent identity does not replace the L0 source event ID')

    store.captureMessage({ ...base, sessionId: 'session-replay', sourceEventId: 'same-id-next-seq', createdAt: dayStart + 11,
      recordedAt: dayStart + 11, originalMessageIdentity: identity('a') })
    store.captureMessage({ ...base, sessionId: 'session-replay', sourceEventId: 'same-text-new-id', createdAt: dayStart + 12,
      recordedAt: dayStart + 12, originalMessageIdentity: identity('c') })

    const legacyBase = { ...base, sessionId: 'session-legacy', sourceEventId: 'legacy-source-event', createdAt: dayStart + 13, recordedAt: dayStart + 13 }
    store.captureMessage(legacyBase)
    store.db.prepare("UPDATE memory_events SET metadata = '{\"role\":\"user\",\"sourceKind\":\"conversation\"}' WHERE event_id = 'capture:legacy-source-event'").run()
    store.captureMessage({ ...legacyBase, originalMessageIdentity: identity('d') })
    const legacy = JSON.parse(String(store.db.prepare("SELECT metadata FROM memory_events WHERE event_id = 'capture:legacy-source-event'").get().metadata))
    assert.equal(legacy.originalMessageIdentity, undefined, 'legacy replay does not backfill an identity')

    const malformedJson = { ...base, sessionId: 'session-malformed-json', sourceEventId: 'malformed-json-event',
      createdAt: dayStart + 14, recordedAt: dayStart + 14, originalMessageIdentity: identity('f') }
    store.captureMessage(malformedJson)
    store.db.prepare("UPDATE memory_events SET metadata = '{' WHERE event_id = 'capture:malformed-json-event'").run()
    const malformedIdentity = { ...base, sessionId: 'session-malformed-identity', sourceEventId: 'malformed-identity-event',
      createdAt: dayStart + 15, recordedAt: dayStart + 15, originalMessageIdentity: identity('e') }
    store.captureMessage(malformedIdentity)
    store.db.prepare('UPDATE memory_events SET metadata = ? WHERE event_id = ?').run(JSON.stringify({
      role: 'user', sourceKind: 'conversation', originalMessageIdentity: {
        schema: 'memory-tdai/original-message/v1', algorithm: 'sha256', digest: 'not-a-full-hash',
      },
    }), 'capture:malformed-identity-event')

    let metrics = store.captureOriginalMessageMetrics(dayStart, dayEnd, [], (items) => items.map(() => true))
    assert.equal(metrics.recordedOriginalMessageLowerBound, 2, 'same ID across seq counts once; same text with a different ID counts separately')
    assert.equal(metrics.unknownOriginalMessageEvents, 3, 'legacy, malformed JSON and malformed identity remain unknown')
    assert.equal(metrics.topSessions.find((item) => item.sessionId === 'session-replay').events, 3)
    assert.equal(metrics.topSessions.find((item) => item.sessionId === 'session-replay').recordedOriginalMessageLowerBound, 2)

    store.close()
    store = openProjectStore(root, 'identity-replay')
    metrics = store.captureOriginalMessageMetrics(dayStart, dayEnd, [], (items) => items.map(() => true))
    assert.equal(metrics.recordedOriginalMessageLowerBound, 2, 'identity metrics survive a store restart')
    assert.equal(metrics.unknownOriginalMessageEvents, 3)

    const retainedIdentity = { ...base, sessionId: 'session-retention', sourceEventId: 'retention-replay-event',
      createdAt: dayStart + 20, recordedAt: dayStart + 20, originalMessageIdentity: identity('e') }
    store.captureMessage(retainedIdentity)
    assert.equal(store.pruneOlderThan(1, dayEnd + 2 * 86_400_000), 7)
    assert.throws(() => store.captureMessage({ ...retainedIdentity, originalMessageIdentity: undefined }), /idempotency key conflicts/u,
      'a replay after L0 retention cannot recreate a deleted source row')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM l0_messages').get().n, 0)
    const retainedEvent = JSON.parse(String(store.db.prepare("SELECT metadata FROM memory_events WHERE event_id = 'capture:retention-replay-event'").get().metadata))
    assert.equal(retainedEvent.originalMessageIdentity.digest, 'e'.repeat(64), 'the retained event keeps its accepted identity hash')
    metrics = store.captureOriginalMessageMetrics(dayStart, dayEnd, [], (items) => items.map(() => true))
    assert.equal(metrics.recordedOriginalMessageLowerBound, 3)
    assert.equal(metrics.unknownOriginalMessageEvents, 3)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('source and event fences still filter identity metrics after L0 retention; current Agent exclusions apply', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-fences-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-fences-project-'))
  const project = projectIdentity(cwd)
  const recordedAt = Date.UTC(2025, 4, 20, 12)
  const retentionNow = Date.UTC(2026, 10, 1)
  let runtime
  let store
  try {
    runtime = new MemoryRuntime(hostContext(), config(), root)
    store = openProjectStore(root, project.key, project)
    const sourceOnly = store.captureMessage({ sessionId: 'fence-session', role: 'user', content: 'source fenced',
      createdAt: recordedAt, recordedAt, sourceEventId: 'host-source-id-only', originalMessageIdentity: identity('a') })
    store.captureMessage({ sessionId: 'fence-session', role: 'user', content: 'event fenced', createdAt: recordedAt + 1, recordedAt: recordedAt + 1,
      sourceEventId: 'host-event-id-only', originalMessageIdentity: identity('b') })
    store.captureMessage({ sessionId: 'fence-session', role: 'user', content: 'legacy event fenced', createdAt: recordedAt + 2, recordedAt: recordedAt + 2,
      sourceEventId: 'legacy-custom-event-id' })
    store.db.prepare("UPDATE memory_events SET metadata = '{\"role\":\"user\",\"sourceKind\":\"conversation\"}' WHERE event_id = 'capture:legacy-custom-event-id'").run()
    const deletedSource = store.captureMessage({ sessionId: 'fence-session', role: 'user', content: 'content deletion fenced', createdAt: recordedAt + 3, recordedAt: recordedAt + 3,
      sourceEventId: 'host-content-deleted', originalMessageIdentity: identity('d') })
    store.captureMessage({ sessionId: 'fence-session', role: 'user', content: 'agent excluded', createdAt: recordedAt + 4, recordedAt: recordedAt + 4,
      sourceEventId: 'host-private-agent', agentPreset: 'private-agent', originalMessageIdentity: identity('c') })
    assert.equal(store.pruneOlderThan(1, retentionNow), 5, 'the synthetic retention pass removes only L0 rows')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM l0_messages').get().n, 0)
    store.close()
    store = undefined

    runtime.control.revokeSourceEvent(project.key, 'unrelated-source-revocation', sourceOnly.id, retentionNow + 1)
    runtime.control.revokeSourceEvent(project.key, 'host-event-id-only', undefined, retentionNow + 2)
    runtime.control.revokeSourceEvent(project.key, 'legacy-custom-event-id', undefined, retentionNow + 3)
    runtime.control.fenceContentDeletion({ projectKey: project.key, requestDigest: 'f'.repeat(64), memoryIds: [],
      sourceIds: [deletedSource.id], offloadIds: [], now: retentionNow + 4 })
    const visible = overview(runtime, project.key, '2025-05-20', '2025-05-20')
    assert.equal(visible.period.recordedOriginalMessageLowerBound, 1,
      'the source-ID and source-event fences hide their rows even after the L0 rows are gone')
    assert.equal(visible.period.unknownOriginalMessageEvents, 0)
    assert.equal(visible.period.topSessions[0].linkedL0Messages, 0, 'retention leaves the event hash but not the deleted L0 row')
    runtime.close()
    runtime = undefined

    runtime = new MemoryRuntime(hostContext(), config(['private-*']), root)
    const afterAgentPolicyChange = overview(runtime, project.key, '2025-05-20', '2025-05-20')
    assert.equal(afterAgentPolicyChange.period.recordedOriginalMessageLowerBound, 0,
      'the current Agent exclusion is reapplied to previously recorded identity metadata')
    assert.equal(afterAgentPolicyChange.period.unknownOriginalMessageEvents, 0)
    assert.deepEqual(afterAgentPolicyChange.period.topSessions, [])
  } finally {
    store?.close()
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('recovery snapshot restore retains identity metadata after L0 retention removes raw message text', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-restore-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-original-identity-restore-project-'))
  const project = projectIdentity(cwd)
  const originalNow = Date.now
  let runtime
  let store
  try {
    Date.now = () => dayStart + 50
    runtime = new MemoryRuntime(hostContext(), config(), root)
    const session = { id: 'restore-session', header: { cwd, agentPreset: 'agent-main' } }
    runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: dayStart + 1,
      data: { id: 'restore-host-message-id', role: 'user', content: [{ type: 'text', text: 'synthetic restore content' }] } })
    store = openProjectStore(root, project.key, project)
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM l0_messages WHERE content = 'synthetic restore content'").get().n, 1)
    assert.equal(store.pruneOlderThan(1, dayEnd + 2 * 86_400_000), 1)
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM l0_messages WHERE content = 'synthetic restore content'").get().n, 0)
    store.close()
    store = undefined

    const snapshot = await runtime.createRecoverySnapshot()
    assert.equal(snapshot.verified, true)
    const plan = await runtime.recoveryPlan(snapshot.manifest.snapshotId)
    assert.equal(plan.restoreApplyReady, true, plan.blockers.join('; '))
    const applied = await runtime.applyRecoverySnapshot(snapshot.manifest.snapshotId)
    store = openProjectStore(applied.stateRoot, project.key, project)
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM l0_messages WHERE content = 'synthetic restore content'").get().n, 0,
      'restore does not recreate the retained-away message text')
    const restoredEvent = JSON.parse(String(store.db.prepare("SELECT metadata FROM memory_events WHERE type = 'capture'").get().metadata))
    assert.match(restoredEvent.originalMessageIdentity.digest, /^[a-f0-9]{64}$/u)
    store.close()
    store = undefined

    const restored = overview(runtime, project.key)
    assert.equal(restored.period.recordedOriginalMessageLowerBound, 1)
    assert.equal(restored.period.unknownOriginalMessageEvents, 0)
    assert.equal(restored.period.topSessions[0].linkedL0Messages, 0)
  } finally {
    Date.now = originalNow
    store?.close()
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
