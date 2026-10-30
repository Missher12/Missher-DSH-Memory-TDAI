import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryRuntime } from '../lib/memory.js'
import { resolveConfig } from '../lib/config.js'
import { openProjectStore } from '../lib/store.js'
import * as client from '../src/client/memory-v7-model.js'
import * as extraction from '../lib/extract.js'
import { scriptedContext, sourceAwareStream, userEvent, endTurnAfterQuietWindow } from './helpers.mjs'

const request = (layer = 'L1') => ({ version: 1, action: 'global', layer, query: '', year: 2026, timeZone: 'UTC' })
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tdai-complete-')))
  const store = openProjectStore(root, 'source-a', { key: 'source-a', name: 'a', cwd: '/synthetic/a' })
  return { root, store, open: () => new MemoryRuntime({ sessions: { get() {} } }, resolveConfig({ extraction: { enabled: false } }), root),
    close(runtime) { runtime?.close(); store.close(); rmSync(root, { recursive: true, force: true }) } }
}
function seed(store, count) {
  for (let i = 0; i < count; i++) {
    const source = store.captureMessage({ sessionId: 's', role: 'user', content: `durable preference ${i}`, sourceKind: 'user',
      sourceEventId: `source-${i}`, agentPreset: 'agent-mock' })
    store.addMemory({ content: `durable preference ${i}`, kind: 'preference', status: 'approved', confidence: .95,
      sourceVerified: true, sourceMessageIds: [source.id] })
  }
}

test('complete scan keeps cumulative counts and becomes exact at the end of all windows', async () => {
  const f = fixture(); let runtime
  try {
    seed(f.store, 40); runtime = f.open(); let resume, page, windows = 0, last = 0
    do {
      page = await client.readGlobalMemory(async value => runtime.readDashboard(value), { ...request(), ...(resume ? { resume } : {}) })
      assert.ok(page.global.counts.L1.value >= last, 'counts cannot reset at a new budget window')
      last = page.global.counts.L1.value; resume = page.global.next; windows++
    } while (resume && windows < 32)
    assert.ok(windows > 1); assert.equal(resume, undefined)
    assert.deepEqual(page.global.counts.L1, { value: 40, relation: 'exact' })
    assert.equal(page.complete, true)
  } finally { f.close(runtime) }
})

test('a changed project invalidates a saved cumulative scan instead of mixing snapshots', async () => {
  const f = fixture(); let runtime
  try {
    seed(f.store, 40); runtime = f.open()
    const first = await client.readGlobalMemory(async value => runtime.readDashboard(value), request())
    assert.ok(first.global.next)
    f.store.captureMessage({ sessionId: 'new', role: 'user', content: 'new source after snapshot', sourceEventId: 'new-event' })
    const next = runtime.readDashboard({ ...request(), resume: first.global.next })
    assert.equal(next.status, 'stale'); assert.equal(next.global, undefined)
  } finally { f.close(runtime) }
})

test('default capture-size Chinese L0 text is browseable without a silent count omission', async () => {
  const f = fixture(); let runtime
  try {
    const content = '长对话。'.repeat(1600)
    f.store.captureMessage({ sessionId: 'long', role: 'user', content, sourceKind: 'user', sourceEventId: 'long-event', agentPreset: 'agent-mock' })
    runtime = f.open()
    const page = await client.readGlobalMemory(async value => runtime.readDashboard(value), request('L0'))
    assert.equal(page.global.items[0]?.content, content)
    assert.deepEqual(page.global.counts.L0, { value: 1, relation: 'exact' })
  } finally { f.close(runtime) }
})

test('UI completes scan bookmarks automatically and merges rows before normal pagination', async () => {
  assert.equal(typeof client.readCompleteGlobalMemory, 'function')
  const calls = [], progress = [], item = key => ({ key, content: key })
  const transport = async input => {
    calls.push(input)
    if (input.action === 'close') return { status: 'ok', complete: true }
    return input.resume ? { status: 'ok', complete: true, readId: 'second', global: { layer: 'L1', items: [item('b')], counts: { L1: { value: 2, relation: 'exact' } } } }
      : { status: 'partial', complete: false, readId: 'first', global: { layer: 'L1', items: [item('a')], next: 'bookmark', counts: { L1: { value: 1, relation: 'lower_bound' } } } }
  }
  const result = await client.readCompleteGlobalMemory(transport, request(), () => false, value => progress.push(value))
  assert.deepEqual(result.global.items.map(item => item.key), ['a', 'b'])
  assert.equal(result.global.counts.L1.value, 2); assert.equal(result.complete, true)
  assert.ok(calls.some(call => call.resume === 'bookmark'))
  assert.ok(calls.some(call => call.action === 'close' && call.readId === 'bookmark'), 'consumed bookmark is released')
  assert.ok(progress.length > 0)
})

test('automatic native scanning releases every completed bookmark and read lease', async () => {
  const f = fixture(); let runtime
  try {
    seed(f.store, 40); runtime = f.open()
    const page = await client.readCompleteGlobalMemory(async value => runtime.readDashboard(value), request())
    assert.equal(page.global.items.length, 40); assert.equal(page.complete, true)
    assert.equal(runtime.dashboardReadSessions.stats().sessions, 0)
    assert.equal(runtime.dashboardReadSessions.stats().activeCalls, 0)
    assert.equal(runtime.globalReader.progress.size, 0)
    assert.ok(runtime.dashboardReadSessions.stats().accountedBytes < 64 * 1024, 'only bounded terminal token metadata remains')
  } finally { f.close(runtime) }
})

test('expiry from an earlier budget window invalidates a later cumulative result', async t => {
  const f = fixture(); let runtime, wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  try {
    seed(f.store, 40)
    f.store.db.prepare('UPDATE l1_memories SET expiry_at = ?').run(wall + 1000)
    runtime = f.open()
    const first = await client.readGlobalMemory(async value => runtime.readDashboard(value), request())
    assert.ok(first.global.next)
    wall += 1001
    const next = runtime.readDashboard({ ...request(), resume: first.global.next })
    assert.equal(next.status, 'stale'); assert.equal(next.global, undefined)
  } finally { f.close(runtime) }
})

test('background model effort is chosen from advertised capabilities and enters request identity', async () => {
  assert.equal(typeof extraction.prepareBackgroundRoute, 'function')
  const route = { provider: 'test-provider', model: 'test-model' }
  const llm = { async resolveModelInfo(provider, model) { assert.equal(provider, route.provider); assert.equal(model, route.model)
    return { reasoning: { efforts: [{ id: 'high' }, { id: 'off' }], defaultEffort: 'high' } } } }
  const prepared = await extraction.prepareBackgroundRoute(llm, route)
  assert.deepEqual(prepared, { ...route, reasoningEffort: 'off' })
  assert.notEqual(extraction.requestIdentityHash(prepared, [], 4096), extraction.requestIdentityHash(route, [], 4096))
  assert.deepEqual(await extraction.prepareBackgroundRoute({ async resolveModelInfo() { return {} } }, route), route, 'no invented unsupported controls')
  assert.deepEqual(await extraction.prepareBackgroundRoute({}, route), route, 'minimal hosts remain supported')
})

test('communication learning reaches a newer project beyond the former first eight projects', () => {
  const f = fixture(); let runtime
  try {
    for (let i = 0; i < 9; i++) openProjectStore(f.root, `a-${i}`, { key: `a-${i}`, name: `a-${i}`, cwd: `/a-${i}` }).close()
    const store = openProjectStore(f.root, 'zz-latest', { key: 'zz-latest', name: 'latest', cwd: '/latest' })
    const source = store.captureMessage({ sessionId: 's', role: 'user', sourceKind: 'user', sourceEventId: 'style-user', agentPreset: 'agent-mock', content: '以后请简洁回答，先给结论。' })
    store.addMemory({ content: '用户偏好简洁回答，先给结论。', kind: 'preference', scene: 'communication-style', status: 'approved', confidence: .95,
      sourceVerified: true, sourceMessageIds: [source.id] }); store.close()
    runtime = new MemoryRuntime({ sessions: { get() {} } }, resolveConfig({ character: { enabled: true } }), f.root)
    assert.match(runtime.characterGuidance({ id: 'receiving', header: { cwd: '/receiver', agentPreset: 'agent-mock' } }) ?? '', /简洁回答/)
  } finally { f.close(runtime) }
})

test('home exposes unfinished extraction jobs instead of making zero L1 appear healthy', async () => {
  const f = fixture(); let runtime
  try {
    const source = f.store.captureMessage({ sessionId: 's', role: 'user', content: 'long lasting project decision', sourceEventId: 'failed-source', agentPreset: 'agent-mock' })
    const job = f.store.enqueueExtractionJob({ sessionId: 's', sourceId: source.id, policyRevision: 'test', quietMs: 1, maxWaitMs: 1000 })
    f.store.updateExtractionJob(job.id, 'uncertain_remote', 'stream_max-tokens:stream ended with max-tokens')
    f.store.db.prepare('UPDATE extraction_jobs SET updated_at = ? WHERE id = ?').run(Date.UTC(2026, 9, 29, 15, 18), job.id)
    runtime = f.open()
    const page = await client.readCompleteGlobalMemory(async value => runtime.readDashboard(value), { ...request('home'), timeZone: 'Asia/Shanghai' })
    assert.equal(page.global.processing.uncertain, 1)
    assert.match(page.global.processing.latestIssue, /上限/)
    assert.match(page.global.processing.latestIssue, /^2026\/10\/29 23:18 · /, 'historical failures carry their occurrence time in the requested timezone')
  } finally { f.close(runtime) }
})

test('pending memories are browseable and can only be enabled from the confirmed current revision', async () => {
  const f = fixture(); let runtime
  try {
    const source = f.store.captureMessage({ sessionId: 's', role: 'user', content: 'project review evidence', sourceKind: 'user', sourceEventId: 'review-evidence', agentPreset: 'agent-mock' })
    const record = f.store.addMemory({ content: 'project review candidate', kind: 'project', status: 'candidate', confidence: .7,
      sourceVerified: true, sourceMessageIds: [source.id] }).record
    runtime = f.open()
    const ordinary = await client.readCompleteGlobalMemory(async value => runtime.readDashboard(value), request())
    assert.equal(ordinary.global.items.length, 0)
    const pending = await client.readCompleteGlobalMemory(async value => runtime.readDashboard(value), { ...request(), status: 'candidate' })
    assert.equal(pending.global.items[0]?.id, record.id)
    const home = await client.readCompleteGlobalMemory(async value => runtime.readDashboard(value), request('home'))
    assert.equal(home.global.processing.pendingApproval, 1)
    await assert.rejects(() => runtime.manageProjectOperation('source-a', 'v7.approve', { layer: 'L1', confirmed: true, id: record.id, revision: record.revision, updatedAt: record.updatedAt - 1 }), /changed/)
    await assert.rejects(() => runtime.manageProjectOperation('source-a', 'v7.approve', { layer: 'L1', confirmed: true, id: record.id, revision: record.revision + 1, updatedAt: record.updatedAt }), /changed/)
    const result = await runtime.manageProjectOperation('source-a', 'v7.approve', { layer: 'L1', confirmed: true, id: record.id, revision: record.revision, updatedAt: record.updatedAt })
    assert.equal(result.applied, true)
    const approved = await client.readCompleteGlobalMemory(async value => runtime.readDashboard(value), request())
    assert.equal(approved.global.items[0]?.id, record.id)
  } finally { f.close(runtime) }
})

test('cancelling a late automatic read releases its newly returned bookmark', async () => {
  let finish, cancelled = false
  const closed = [], pending = new Promise(resolve => { finish = resolve })
  const transport = async input => input.action === 'close' ? (closed.push(input.readId), { status: 'ok', complete: true }) : pending
  const read = client.readCompleteGlobalMemory(transport, request(), () => cancelled)
  await Promise.resolve(); cancelled = true
  finish({ status: 'partial', complete: false, readId: 'late-reader', global: { layer: 'L1', items: [], next: 'late-bookmark' } })
  assert.equal(await read, undefined)
  assert.ok(closed.includes('late-reader'))
  assert.ok(closed.includes('late-bookmark'))
})

test('an undispatched queued extraction adopts current policy after a settings change', async () => {
  const f = fixture(), session = { id: 'policy-session', header: { cwd: f.root, agentPreset: 'agent-mock' } }
  const scripted = scriptedContext({ session, script: [sourceAwareStream(() => ({ memories: [] }))] })
  let runtime
  try {
    runtime = new MemoryRuntime(scripted.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock', everyNConversations: 1, minTurnChars: 0 } }), f.root)
    runtime.onSessionEvent(session, userEvent(1, '以后这个项目采用长期有效的约定。'))
    endTurnAfterQuietWindow(runtime, session, 2)
    runtime.updateSettings({ mode: 'auto' })
    await runtime.runExtraction(session.id)
    assert.equal(scripted.calls.length, 1, 'an uncharged source is not stranded by a policy update')
  } finally { f.close(runtime) }
})

test('actual background dispatch pins supported effort and hashes the same request it streams', async () => {
  const f = fixture(), session = { id: 'effort-session', header: { cwd: f.root, agentPreset: 'agent-mock' } }
  const scripted = scriptedContext({ session, script: [sourceAwareStream(() => ({ memories: [] }))] })
  scripted.ctx.llm.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'off' }] } })
  let runtime
  try {
    runtime = new MemoryRuntime(scripted.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock', everyNConversations: 1, minTurnChars: 0 } }), f.root)
    runtime.onSessionEvent(session, userEvent(1, '请记住这个项目的长期约定。')); endTurnAfterQuietWindow(runtime, session, 2)
    await runtime.runExtraction(session.id)
    const call = scripted.calls[0]
    assert.equal(call.reasoningEffort, 'off'); assert.equal(call.maxTokens, 4096)
    const billable = runtime.control.listBillableCalls().find(value => value.purpose === 'extraction')
    assert.equal(billable.requestHash, extraction.requestIdentityHash({ provider: 'mock', model: 'mock', reasoningEffort: 'off' }, call.messages, call.maxTokens))
  } finally { f.close(runtime) }
})

test('switching generation off during capability lookup prevents any provider dispatch', async () => {
  const f = fixture(), session = { id: 'metadata-gate', header: { cwd: f.root, agentPreset: 'agent-mock' } }
  const scripted = scriptedContext({ session, script: [sourceAwareStream(() => ({ memories: [] }))] })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  scripted.ctx.llm.resolveModelInfo = () => { entered(); return new Promise(resolve => { release = resolve }) }
  let runtime
  try {
    runtime = new MemoryRuntime(scripted.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock', everyNConversations: 1, minTurnChars: 0 } }), f.root)
    runtime.onSessionEvent(session, userEvent(1, '以后按这个项目的长期规则处理。')); endTurnAfterQuietWindow(runtime, session, 2)
    const pending = runtime.runExtraction(session.id); await started
    runtime.updateSettings({ generateMemory: false }); release({ reasoning: { efforts: [{ id: 'off' }] } })
    await pending
    assert.equal(scripted.calls.length, 0); assert.equal(runtime.control.listBillableCalls().length, 0)
  } finally { f.close(runtime) }
})

test('automatic index verification follows more than 512 work windows and closes consumed leases', async () => {
  let windows = 0, closes = 0
  const transport = async input => {
    if (input.action === 'close') { closes++; return { status: 'ok', complete: true } }
    windows++
    const complete = windows === 600
    return { status: complete ? 'ok' : 'partial', complete, readId: `read-${windows}`,
      global: { layer: 'home', items: [], counts: { L2: { value: complete ? 1 : 0, relation: complete ? 'exact' : 'lower_bound' } },
        ...(complete ? {} : { next: `batch-${windows}` }) } }
  }
  const result = await client.readCompleteGlobalMemory(transport, request('home'))
  assert.equal(result.complete, true); assert.equal(windows, 600); assert.equal(closes, 1199)
})

test('automatic index verification rejects a repeated bookmark without publishing a false completion', async () => {
  const transport = async input => input.action === 'close' ? { status: 'ok', complete: true } :
    { status: 'partial', complete: false, readId: 'reader', global: { layer: 'home', items: [], next: 'same-batch' } }
  await assert.rejects(() => client.readCompleteGlobalMemory(transport, request('home')), /进度没有推进/)
})
