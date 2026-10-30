import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemoryRuntime } from '../lib/memory.js'
import { resolveConfig } from '../lib/config.js'
import { projectIdentity } from '../lib/project.js'
import { meteredStream, scriptedContext, sourceAwareStream, userEvent, withAdvancedClock } from './helpers.mjs'

function fixture(script = [], explicitRoute = true) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tdai-recovery-'))), cwd = path.join(dir, 'workspace')
  mkdirSync(cwd)
  const session = { id: 'recovery-session', header: { cwd, agentPreset: 'agent-mock' },
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }
  const host = scriptedContext({ session, script })
  const runtime = new MemoryRuntime(host.ctx, resolveConfig({ capture: { excludeAgents: [] },
    extraction: { enabled: true, ...(explicitRoute ? { provider: 'mock', model: 'mock' } : {}), minTurnChars: 0, everyNConversations: 1 } }), path.join(dir, 'state'))
  const project = projectIdentity(cwd), store = runtime.store(project)
  return { runtime, session, project, store, ctx: host.ctx, calls: host.calls,
    capture() { runtime.onSessionEvent(session, userEvent(1, 'Synthetic durable decision: use a copper test beacon.'))
      runtime.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1 } }) },
    recover(id, extra = {}) { return runtime.manageProjectOperation(project.key, 'processing.recover', { id, authorized: true, reason: 'explicit regression recovery', ...extra }) },
    close() { runtime.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const truncated = () => meteredStream('{"memories":[', { kind: 'max-tokens' })()
const valid = sourceAwareStream(ids => ({ memories: [{ content: 'Use a copper test beacon.', kind: 'fact', confidence: 0.95, source_message_ids: ids }] }))

test('a tool-only assistant response commits the same-step user route without a new request header', () => {
  const f = fixture([], false)
  try {
    f.runtime.onSessionEvent(f.session, { type: 'turn/start', seq: 1, data: { turn: 2 } })
    f.runtime.onSessionEvent(f.session, { type: 'step/start', seq: 2, data: { turn: 2, step: 1 } })
    f.runtime.onSessionEvent(f.session, userEvent(3, 'Synthetic durable decision before a tool-only response.'))
    f.runtime.onSessionEvent(f.session, { type: 'assistant/message', seq: 4, data: { turn: 2, step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }] } } })
    assert.equal(f.store.db.prepare('SELECT provider FROM extraction_source_routes').get().provider, 'mock')
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM l0_messages').get().n, 1)
  } finally { f.close() }
})

test('known truncation retains paid evidence, never auto-retries, and explicit recovery is idempotent', async () => {
  const f = fixture([truncated(), valid])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const old = f.store.extractionJobs(10)[0], attempt = f.runtime.control.getAttempt(old.attemptId)
    assert.equal(old.status, 'failed')
    assert.equal(attempt.state, 'failed_known')
    await withAdvancedClock(4000, () => f.runtime.runExtraction(f.session.id))
    assert.equal(f.calls.length, 1)
    const result = await f.recover(old.id)
    assert.equal(result.job.status, 'completed')
    assert.equal(result.job.retryOf, old.id)
    assert.equal(f.store.getExtractionJob(old.id).status, 'superseded')
    assert.equal(f.runtime.control.getAttempt(old.attemptId).usage.outputTokens, 24)
    assert.equal((await f.recover(old.id)).job.id, result.job.id)
    assert.equal(f.calls.length, 2)
  } finally { f.close() }
})

test('legacy max-token uncertainty reconciles only with a matching known provider ledger result', async () => {
  const f = fixture([truncated(), valid])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const old = f.store.extractionJobs(10)[0]
    f.store.updateExtractionJob(old.id, 'uncertain_remote', 'stream_max-tokens:stream ended with max-tokens')
    f.runtime.control.db.prepare("UPDATE attempts SET state = 'uncertain_remote' WHERE id = ?").run(old.attemptId)
    const result = await f.recover(old.id)
    assert.equal(result.job.status, 'completed')
    assert.equal(f.runtime.control.getAttempt(old.attemptId).state, 'failed_known')
  } finally { f.close() }
})

test('a transport outcome with no finish remains unknown and cannot be retried by recovery', async () => {
  const f = fixture([(async function* () { yield { type: 'text-delta', text: '{' } })()])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const old = f.store.extractionJobs(10)[0]
    assert.equal(old.status, 'uncertain_remote')
    await assert.rejects(f.recover(old.id), /unknown|unresolved/)
    assert.equal(f.calls.length, 1)
    assert.equal(f.runtime.control.billableCallSummary().active.state, 'uncertain')
  } finally { f.close() }
})

test('deleting failed input retires the job and preserves the original payment attempt', async () => {
  const f = fixture([truncated()])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const old = f.store.extractionJobs(10)[0]
    f.store.purgeManagedContent({ memoryIds: [], sourceIds: old.sourceIds })
    assert.equal(f.store.getExtractionJob(old.id).status, 'source_pruned')
    assert.equal(f.runtime.control.getAttempt(old.attemptId).usage.outputTokens, 24)
    await f.recover(old.id)
    assert.equal(f.calls.length, 1)
  } finally { f.close() }
})

test('a missing-route queued job needs an explicit route', async () => {
  const f = fixture([valid], false)
  try {
    f.capture()
    const old = f.store.extractionJobs(10)[0]
    await assert.rejects(f.recover(old.id), /route/)
    const result = await f.recover(old.id, { provider: 'mock', model: 'mock' })
    assert.equal(result.job.status, 'completed')
    assert.equal(f.store.getExtractionJob(old.id).attemptId, undefined)
    assert.equal(f.calls.length, 1)
  } finally { f.close() }
})

test('recovery requires explicit authorization and excludes injected sources in a legacy mixed batch', async () => {
  const f = fixture([valid])
  try {
    f.capture()
    const old = f.store.extractionJobs(10)[0]
    const injected = f.store.captureMessage({ sessionId: f.session.id, role: 'user', sourceKind: 'plugin:mse-learning',
      content: 'Synthetic plugin instruction: never learn this as a user preference.', agentPreset: 'agent-mock', provider: 'mock', model: 'mock' })
    f.store.enqueueExtractionJob({ sessionId: f.session.id, sourceId: injected.id, policyRevision: old.policyRevision, quietMs: 1200, maxWaitMs: 60000 })
    await assert.rejects(f.runtime.manageProjectOperation(f.project.key, 'processing.recover', { id: old.id }), /authorization/)
    assert.equal(f.calls.length, 0)
    const recovered = await f.recover(old.id)
    assert.equal(recovered.job.status, 'completed')
    assert.deepEqual(recovered.job.sourceIds, old.sourceIds)
    assert.equal(f.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /never learn this/)
  } finally { f.close() }
})

test('an explicit recovery route changes only the new job and keeps the original paid route', async () => {
  const f = fixture([truncated(), valid])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const old = f.store.extractionJobs(10)[0]
    await assert.rejects(f.recover(old.id, { provider: 'replacement' }), /supplied together/)
    const result = await f.recover(old.id, { provider: 'replacement', model: 'replacement-model' })
    assert.equal(result.job.status, 'completed')
    assert.equal(f.calls[1].provider, 'replacement')
    assert.equal(f.calls[1].model, 'replacement-model')
    assert.equal(f.store.getExtractionJob(old.id).provider, 'mock')
    assert.equal(f.runtime.control.getAttempt(old.attemptId).provider, 'mock')
    assert.match(old.error, /text_chars=/)
  } finally { f.close() }
})

test('short frozen-batch source labels persist the exact original L0 provenance', async () => {
  const f = fixture([valid])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const job = f.store.extractionJobs(10)[0]
    assert.equal(job.status, 'completed')
    const prompt = JSON.stringify(f.calls[0].messages)
    assert.match(prompt, /\[l0_1\]/)
    assert.equal(prompt.includes(job.sourceIds[0]), false, 'the model need not copy a long opaque ID')
    const row = f.store.db.prepare('SELECT source_message_ids FROM l1_memories').get()
    assert.deepEqual(JSON.parse(row.source_message_ids), job.sourceIds)
    assert.match(job.responseText, /l0_1/, 'retain the provider response as received')
  } finally { f.close() }
})

test('an invented short source label fails closed without consuming the input', async () => {
  const f = fixture([sourceAwareStream(() => ({ memories: [{ content: 'A fabricated source must never be accepted.',
    kind: 'fact', confidence: 0.95, source_message_ids: ['l0_2'] }] }))])
  try {
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    const job = f.store.extractionJobs(10)[0]
    assert.equal(job.status, 'failed')
    assert.equal(job.error, 'source_validation_failed')
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM l1_memories').get().n, 0)
    assert.equal(f.store.db.prepare('SELECT extracted_at FROM l0_messages').get().extracted_at, null)
  } finally { f.close() }
})

test('a persisted background route is independent of the interactive model and can be cleared', async () => {
  const f = fixture([valid], false); let reopened
  try {
    assert.throws(() => f.runtime.updateSettings({ extractionProvider: 'background' }), /together/)
    f.runtime.updateSettings({ extractionProvider: 'background', extractionModel: 'json-model' })
    f.capture(); await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    assert.equal(f.store.extractionJobs(10)[0].status, 'completed')
    assert.equal(f.calls[0].provider, 'background')
    assert.equal(f.calls[0].model, 'json-model')
    assert.equal(f.session.requestHeader().config.model, 'mock')
    f.runtime.close()
    reopened = new MemoryRuntime(f.ctx, resolveConfig({}), f.runtime.root)
    assert.equal(reopened.config.extraction.provider, 'background')
    assert.equal(reopened.config.extraction.model, 'json-model')
    const page = reopened.readDashboard({ version: 1, action: 'settings' })
    assert.equal(page.settings.extractionProvider, 'background')
    reopened.readDashboard({ version: 1, action: 'close', readId: page.readId })
    reopened.updateSettings({ extractionProvider: '', extractionModel: '' })
    assert.equal(reopened.config.extraction.provider, undefined)
    assert.equal(reopened.config.extraction.model, undefined)
  } finally { reopened?.close(); f.close() }
})
