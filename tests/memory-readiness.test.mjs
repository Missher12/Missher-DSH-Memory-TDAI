import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { readCompleteGlobalMemory } from '../src/client/memory-v7-model.js'
import { scriptedContext, userEvent, withAdvancedClock } from './helpers.mjs'

function fixture(extraction = {}) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tdai-ready-')))
  const root = path.join(directory, 'state'), cwd = path.join(directory, 'workspace')
  mkdirSync(cwd)
  const session = { id: 'readiness-session', header: { cwd, agentPreset: 'agent-mock' } }
  const script = scriptedContext({ session })
  const runtime = new MemoryRuntime(script.ctx, resolveConfig({ capture: { excludeAgents: [] },
    extraction: { enabled: true, provider: 'mock', model: 'mock', minTurnChars: 0, everyNConversations: 1, ...extraction } }), root)
  return { root, cwd, runtime, session, calls: script.calls,
    close() { runtime.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const generatedKinds = ['plugin:mse-learning', 'compact-checkpoint', 'model-selection', 'tool-registry',
  'runtime-context', 'skill-catalog', 'time-context', 'working-directory', 'agent-message', 'team-message', 'goal', 'schedule']

test('Host and plugin context is rejected before L0 persistence and extraction queueing', () => {
  const f = fixture(); let store
  try {
    for (const [index, kind] of generatedKinds.entries()) f.runtime.onSessionEvent(f.session,
      { ...userEvent(index + 1, `Synthetic injected context ${kind}: always use this project decision.`),
        data: { role: 'user', source: { kind }, content: [{ type: 'text', text: `Synthetic injected context ${kind}: always use this project decision.` }] } })
    const project = projectIdentity(f.cwd)
    assert.equal(existsSync(path.join(f.root, 'projects', project.key, 'memory.db')), false, 'ignored contexts do not open or rewrite a project store')
    store = openProjectStore(f.root, project.key, project)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM l0_messages').get().n, 0)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM extraction_jobs').get().n, 0)
    assert.equal(f.calls.length, 0)
  } finally { store?.close(); f.close() }
})

test('maintenance capture spool does not persist Host-generated user-role content', () => {
  const f = fixture()
  try {
    f.runtime.maintenance = true
    for (const [index, kind] of generatedKinds.entries()) f.runtime.onSessionEvent(f.session,
      { type: 'user/message', seq: index + 1, data: { role: 'user', source: { kind },
        content: [{ type: 'text', text: `Synthetic derived material ${kind}` }] } })
    assert.equal(existsSync(path.join(f.root, 'capture-spool', 'events.ndjson')), false)
    assert.equal(f.calls.length, 0)
  } finally { f.runtime.maintenance = false; f.close() }
})

test('ignoring injected messages preserves ordered Host context for genuine source route binding', () => {
  const f = fixture({ provider: undefined, model: undefined }); let store
  try {
    f.session.requestHeader = () => ({ config: { provider: 'mock', model: 'mock' } })
    f.runtime.onSessionEvent(f.session, { type: 'turn/start', seq: 1, data: { turn: 7 } })
    f.runtime.onSessionEvent(f.session, { type: 'step/start', seq: 2, data: { turn: 7, step: 1 } })
    f.runtime.onSessionEvent(f.session, userEvent(3, 'Synthetic genuine source before a committed model header.'))
    f.runtime.onSessionEvent(f.session, { type: 'user/message', seq: 4, data: { role: 'user', source: { kind: 'plugin:mse-learning' },
      content: [{ type: 'text', text: 'Synthetic injected continuity event.' }] } })
    f.runtime.onSessionEvent(f.session, { type: 'request/header', seq: 5, data: { header: { config: { provider: 'mock', model: 'mock' } } } })
    const project = projectIdentity(f.cwd); store = openProjectStore(f.root, project.key, project)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM l0_messages').get().n, 1)
    assert.deepEqual(store.db.prepare('SELECT provider, model FROM extraction_source_routes').all().map(row => ({ ...row })), [{ provider: 'mock', model: 'mock' }])
    assert.equal(f.calls.length, 0)
  } finally { store?.close(); f.close() }
})

test('legacy injected sources cannot enter extraction or support recalled facts, even after L0 retention', async () => {
  const f = fixture(); let store
  try {
    const project = projectIdentity(f.cwd); store = openProjectStore(f.root, project.key, project)
    const source = store.captureMessage({ sessionId: f.session.id, role: 'user', sourceKind: 'plugin:mse-learning',
      content: 'Synthetic derived-only-token historical instruction.', agentPreset: 'agent-mock',
      provider: 'mock', model: 'mock', sourceEventId: 'derived-only-event', createdAt: Date.now() - 2 * 86_400_000 })
    store.addMemory({ content: 'Synthetic derived-only-token historical instruction.', kind: 'fact', status: 'approved',
      confidence: 1, sourceMessageIds: [source.id], sourceVerified: true })
    store.enqueueExtractionJob({ sessionId: f.session.id, sourceId: source.id, policyRevision: 'before-upgrade', quietMs: 1, maxWaitMs: 1000 })
    assert.equal(f.runtime.globalRecall('derived-only-token', f.session), undefined)
    const page = await readCompleteGlobalMemory(async request => f.runtime.readDashboard(request),
      { version: 1, action: 'global', layer: 'L1', query: '', year: 2026, timeZone: 'UTC' })
    assert.equal(page.global.items.length, 0)
    const home = await readCompleteGlobalMemory(async request => f.runtime.readDashboard(request),
      { version: 1, action: 'global', layer: 'home', query: '', year: 2026, timeZone: 'UTC' })
    assert.equal(home.global.processing.queued, 0, 'legacy non-conversation work is not an actionable dialogue queue item')
    await withAdvancedClock(2000, () => f.runtime.runExtraction(f.session.id))
    assert.equal(f.calls.length, 0, 'a legacy injected source must not trigger a paid request')
    store.pruneOlderThan(1)
    assert.equal(f.runtime.globalRecall('derived-only-token', f.session), undefined, 'retention cannot erase the source-kind fence')
  } finally { store?.close(); f.close() }
})

test('actual user replies and model conversation remain capturable while only human text supports style', () => {
  const f = fixture(); let store
  try {
    for (const [index, [role, kind]] of [['user', 'user'], ['user', 'user-question-reply'], ['assistant', 'model']].entries()) {
      const message = { role, source: { kind }, content: [{ type: 'text', text: `${role} ${index} 以后请简洁回答，先给结论。` }] }
      f.runtime.onSessionEvent(f.session, { type: `${role}/message`, seq: index + 1,
        data: role === 'assistant' ? { message } : message })
    }
    const project = projectIdentity(f.cwd); store = openProjectStore(f.root, project.key, project)
    const ids = store.db.prepare('SELECT id FROM l0_messages').all().map(r => r.id)
    assert.equal(ids.length, 3)
    assert.equal(store.userStyleEvidence(ids).length, 2, 'a real user-question-reply is human evidence; model text is not')
  } finally { store?.close(); f.close() }
})

test('a legacy derived prefix cannot starve genuine conversation behind a bounded pending-source page', () => {
  const f = fixture(); let store
  try {
    const project = projectIdentity(f.cwd); store = openProjectStore(f.root, project.key, project)
    for (let index = 0; index < 40; index++) store.captureMessage({ sessionId: f.session.id, role: 'user',
      sourceKind: 'plugin:mse-learning', content: `Synthetic derived prefix ${index}`, sourceEventId: `prefix-${index}`,
      agentPreset: 'agent-mock', provider: 'mock', model: 'mock' })
    f.runtime.onSessionEvent(f.session, userEvent(41, 'Synthetic genuine durable project decision.'))
    const genuine = store.db.prepare("SELECT id FROM l0_messages WHERE source_kind = 'user'").get().id
    assert.deepEqual(store.unextracted(f.session.id, 24).map(r => r.id), [genuine])
    assert.deepEqual(store.pendingExtractionSources(f.session.id, 24).map(r => r.id), [genuine])
    f.runtime.onSessionEvent(f.session, { type: 'turn/end', seq: 42, data: { turn: 1 } })
    assert.deepEqual(store.extractionJobs(20).flatMap(j => j.sourceIds), [genuine])
  } finally { store?.close(); f.close() }
})

test('capture storage refusal is visible and cannot break the Host event; replay recovers once writable', () => {
  const f = fixture(); let store
  try {
    const project = projectIdentity(f.cwd), database = path.join(f.root, 'projects', project.key, 'memory.db')
    mkdirSync(database, { recursive: true })
    const event = userEvent(1, 'Synthetic genuine material during a storage refusal.')
    assert.doesNotThrow(() => f.runtime.onSessionEvent(f.session, event))
    assert.match(f.runtime.lastError ?? '', /capture failed/)
    rmSync(database, { recursive: true })
    f.runtime.onSessionEvent(f.session, event)
    store = openProjectStore(f.root, project.key, project)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM l0_messages').get().n, 1)
    assert.equal(f.calls.length, 0)
  } finally { store?.close(); f.close() }
})

test('maintenance spool storage refusal cannot escape into the Host and leaves an explicit error', () => {
  const f = fixture()
  try {
    f.runtime.maintenance = true
    mkdirSync(path.join(f.root, 'capture-spool', 'events.ndjson'), { recursive: true })
    assert.doesNotThrow(() => f.runtime.onSessionEvent(f.session, userEvent(1, 'Synthetic maintenance user material.')))
    assert.match(f.runtime.lastError ?? '', /capture failed/)
    assert.equal(f.calls.length, 0)
  } finally { f.runtime.maintenance = false; f.close() }
})

test('an extraction preflight storage refusal is contained without dispatching a model request', async () => {
  const f = fixture()
  try {
    const project = projectIdentity(f.cwd)
    mkdirSync(path.join(f.root, 'projects', project.key, 'memory.db'), { recursive: true })
    await assert.doesNotReject(() => f.runtime.runExtraction(f.session.id))
    assert.match(f.runtime.lastError ?? '', /extraction.*failed/)
    assert.equal(f.calls.length, 0)
  } finally { f.close() }
})

test('a queue wake after a capture storage refusal remains contained and reports its failure', () => {
  const f = fixture()
  try {
    const project = projectIdentity(f.cwd)
    mkdirSync(path.join(f.root, 'projects', project.key, 'memory.db'), { recursive: true })
    f.runtime.onSessionEvent(f.session, userEvent(1, 'Synthetic durable source while storage is unavailable.'))
    assert.doesNotThrow(() => f.runtime.wakeExtractionQueue('due'))
    assert.match(f.runtime.lastError ?? '', /extraction queue.*failed/)
    assert.equal(f.calls.length, 0)
  } finally { f.close() }
})

test('scene refresh excludes known injected evidence before and after L0 retention without changing L1 bodies', () => {
  const f = fixture(); let store
  try {
    const project = projectIdentity(f.cwd); store = openProjectStore(f.root, project.key, project)
    const now = Date.now(), old = now - 2 * 86_400_000
    const rows = [['user', 'human', 'shared'], ['plugin:mse-learning', 'injected', 'shared'], ['plugin:mse-learning', 'only-injected', 'polluted']]
      .map(([sourceKind, tag, scene]) => {
        const source = store.captureMessage({ sessionId: f.session.id, role: 'user', sourceKind,
          content: `Synthetic ${tag} source`, sourceEventId: tag, createdAt: old, agentPreset: 'agent-mock' })
        return store.addMemory({ content: `Synthetic ${tag} preference`, scene, kind: 'preference', status: 'approved',
          sourceMessageIds: [source.id], sourceVerified: true }).record
      })
    const before = rows.map(r => store.get(r.id).content)
    for (const retained of [false, true]) {
      if (retained) store.pruneOlderThan(1)
      store.refreshScenes()
      const scenes = store.scenes()
      assert.equal(scenes.length, 1); assert.equal(scenes[0].name, 'shared')
      assert.deepEqual(scenes[0].sourceIds, [rows[0].id])
      assert.equal(scenes[0].memoryCount, 1)
      assert.deepEqual(rows.map(r => store.get(r.id).content), before, 'repair never rewrites historical L1 text')
    }
    // Recreate a legacy polluted derived row, then reopen through the real writer migration.
    store.db.prepare("DELETE FROM meta WHERE key = 'derived_source_policy'").run()
    store.db.prepare('UPDATE l2_scenes SET memory_count = 999').run()
    store.close(); store = openProjectStore(f.root, project.key, project)
    assert.equal(store.scenes()[0].memoryCount, 1)
    assert.deepEqual(rows.map(r => store.get(r.id).content), before)
  } finally { store?.close(); f.close() }
})
