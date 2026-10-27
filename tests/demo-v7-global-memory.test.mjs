import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseExtractionJson } from '../lib/extract.js'
import { DashboardReadSessionManager } from '../lib/dashboard-read.js'
import { withDashboardOverviewFusion } from '../lib/dashboard-visibility.js'
import { MemoryRuntime } from '../lib/memory.js'
import { resolveConfig } from '../lib/config.js'
import { openProjectStore } from '../lib/store.js'
import { globalMemoryKey, parseGlobalMemoryKey, profileSources } from '../lib/global-memory.js'
import { ReadDashboardRequestSchema, ReadDashboardResultSchema } from '../lib/remote-contract.js'
import { memoryYear, memoryMetric, readGlobalMemory } from '../src/client/memory-v7-model.js'
import { scriptedContext, sourceAwareStream, sourceAwareGatedStream, endTurnAfterQuietWindow } from './helpers.mjs'

const context = { logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }
const request = (layer = 'L1', query = '') => ({ version: 1, action: 'global', layer, query, year: new Date().getUTCFullYear(), timeZone: 'UTC' })
function seed(root, key, text, { fixedId, scene = 'preferences', persona = false, sourceEventId } = {}) {
  const store = openProjectStore(root, key, { key, name: key, cwd: `/synthetic/${key}` })
  try {
    const source = store.captureMessage({ sessionId: `session-${key}`, role: 'user', content: text, createdAt: Date.now(),
      sourceEventId: sourceEventId ?? `event-${key}`, origin: 'dsh-session', sourceKind: 'conversation', agentPreset: 'agent-mock' })
    let record = store.addMemory({ content: text, scene, kind: 'preference', status: 'approved', confidence: .95,
      sourceVerified: true, sourceMessageIds: [source.id] }).record
    if (fixedId) {
      // Synthetic collision across separate physical shards. Preserve all recorded provenance.
      store.db.prepare('UPDATE l1_memories SET id = ? WHERE id = ?').run(fixedId, record.id)
      store.db.prepare('UPDATE l1_revisions SET memory_id = ? WHERE memory_id = ?').run(fixedId, record.id)
      store.db.prepare('UPDATE memory_sources SET memory_id = ? WHERE memory_id = ?').run(fixedId, record.id)
      store.db.prepare('UPDATE memory_events SET source_id = ? WHERE source_id = ?').run(fixedId, record.id)
      record = store.get(fixedId)
    }
    store.refreshScenes()
    if (persona) store.setPersona('偏好稳定的 pnpm 工作流。', 1, [record.id], Date.now(), { [record.id]: record.revision })
    return record
  } finally { store.close() }
}
async function read(runtime, layer = 'L1', query = '') {
  return readGlobalMemory(async (input) => {
    const output = runtime.readDashboard(input)
    assert.equal(ReadDashboardResultSchema.safeParse(output).success, true, 'every wire page must satisfy the real strict codec')
    return output
  }, request(layer, query))
}
function fixture(prefix = 'v7-global-') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  let runtime
  return { root, open(config = {}) { runtime = new MemoryRuntime(context, resolveConfig(config), root); return runtime },
    close() { runtime?.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('Demo v7 origin IDs separate identical local IDs and reject malformed references', () => {
  assert.notEqual(globalMemoryKey('source-a', 'same'), globalMemoryKey('source-b', 'same'))
  assert.deepEqual(parseGlobalMemoryKey(globalMemoryKey('项目-a', 'id:@/%')), { projectKey: '项目-a', id: 'id:@/%' })
  for (const id of ['g:../outside:id', 'g:%ZZ:id', 'g:source-a:', 'g:source-a:id:extra']) assert.equal(parseGlobalMemoryKey(id), undefined)
})

test('Demo v7 A and B share profile memory while a different profile cannot read either', async () => {
  const a = fixture(), isolated = fixture()
  try {
    seed(a.root, 'source-a', 'pnpm alpha preference', { fixedId: 'same-local-id' })
    seed(a.root, 'source-b', 'pnpm beta preference', { fixedId: 'same-local-id' })
    const runtime = a.open(), first = runtime.readDashboard(request())
    assert.ok(first.status === 'ok' || first.status === 'partial')
    assert.equal(first.global.items.length, 1, 'the initial call admits a real visible row under the original shared budget')
    assert.ok(first.global.items[0].memory)
    assert.equal(runtime.readDashboard({ version: 1, action: 'close', readId: first.readId }).status, 'ok')
    const page = await read(runtime)
    assert.equal(page.global.items.length, 2)
    assert.equal(new Set(page.global.items.map((item) => item.key)).size, 2)
    assert.deepEqual(new Set(page.global.items.map((item) => item.sources[0].sessionId)), new Set(['session-source-a', 'session-source-b']))
    const packet = runtime.globalRecall('pnpm', { id: 'real-b', header: { cwd: '/synthetic/source-b', agentPreset: 'agent-mock' } })
    assert.match(packet, /alpha/); assert.match(packet, /beta/)
    const withoutCwd = runtime.globalRecall('pnpm', { id: 'real-no-cwd', header: { agentPreset: 'agent-mock' } })
    assert.match(withoutCwd, /alpha/)
    const other = isolated.open()
    const empty = other.readDashboard(request())
    assert.equal(empty.status, 'ok', 'an empty profile still completes its first native read')
    assert.equal(empty.complete, true)
    assert.equal(empty.global.items.length, 0)
    assert.equal(other.readDashboard({ version: 1, action: 'close', readId: empty.readId }).status, 'ok')
    assert.equal((await read(other)).global.items.length, 0)
    assert.equal(other.get('/synthetic/source-b', page.global.items[0].key), undefined)
  } finally { a.close(); isolated.close() }
})

test('Demo v7 generation and use switches persist independently in all four combinations', async () => {
  const f = fixture()
  try {
    seed(f.root, 'source-a', 'pnpm preference')
    let runtime = f.open()
    for (const generateMemory of [false, true]) for (const useMemory of [false, true]) {
      runtime.updateSettings({ generateMemory, useMemory })
      runtime.close(); runtime = f.open()
      assert.equal(runtime.config.generateMemory, generateMemory); assert.equal(runtime.config.useMemory, useMemory)
      const page = await read(runtime)
      assert.equal(page.global.items.length, 1, 'turning off use must not delete or hide browseable records')
      assert.equal(runtime.globalRecall('pnpm', { id: 's', header: { agentPreset: 'agent-mock' } }) !== undefined, useMemory)
    }
  } finally { f.close() }
})

test('Demo v7 failed settings persistence does not report or retain an unsaved switch', () => {
  const f = fixture()
  try {
    const runtime = f.open()
    mkdirSync(path.join(f.root, 'settings.json'))
    assert.throws(() => runtime.updateSettings({ useMemory: false }), /saved/)
    assert.equal(runtime.config.useMemory, true)
  } finally { f.close() }
})

test('Demo v7 no-cwd Host capture automatically produces a sourced high-confidence memory', async () => {
  const f = fixture()
  const session = { id: 's1', header: { agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
  const mock = scriptedContext({ session, script: [sourceAwareStream((ids) => ({ memories: [
    { content: 'pnpm 是首选包管理器。', kind: 'preference', confidence: .95, source_message_ids: ids },
    { content: '这个 pnpm 偏好仍然与另一条来源冲突。', kind: 'preference', confidence: .99, has_conflict: true, source_message_ids: ids },
    { content: '这条偏好只有很低的置信度。', kind: 'preference', confidence: .2, source_message_ids: ids },
  ] }))] })
  let runtime
  try {
    runtime = new MemoryRuntime(mock.ctx, resolveConfig({ mode: 'review', extraction: { minTurnChars: 0, everyNConversations: 1 }, budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
    runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '以后处理我的前端项目时，请始终使用 pnpm 作为包管理器。' }] } })
    endTurnAfterQuietWindow(runtime, session)
    await runtime.runExtraction(session.id)
    const page = await read(runtime)
    assert.equal(page.global.items.length, 1)
    assert.equal(page.global.items[0].sources[0].sessionId, session.id)
    assert.equal(page.global.items[0].memory.status, 'approved')
    assert.equal(runtime.dashboard().candidates.length, 2, 'conflicting and low-confidence outputs remain non-injectable')
    const persona = await read(runtime, 'L3')
    assert.equal(persona.global.items.length, 1, 'the actual extraction batch generates L3 without a manual seed')
    assert.match(persona.global.items[0].content, /pnpm/)
    assert.doesNotMatch(persona.global.items[0].content, /冲突|很低/)
    runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '以后处理我的前端项目时，请始终使用 pnpm 作为包管理器。' }] } })
    await runtime.runExtraction(session.id)
    assert.equal((await read(runtime, 'L3')).global.items[0].updatedAt, persona.global.items[0].updatedAt, 'duplicate input does not rewrite L3')
    const origin = page.global.items[0]
    runtime.review(origin.projectKey, origin.id, 'forget')
    assert.equal((await read(runtime, 'L3')).global.items.length, 0, 'forget invalidates the automatic persona sources')
    assert.equal(mock.calls.length, 1, 'L3, reads, duplicate capture and forget never call a model')
  } finally { runtime?.close(); f.close() }
})

test('Demo v7 disabling then reenabling generation rejects an already in-flight result', async () => {
  const f = fixture(), session = { id: 's1', header: { cwd: '/synthetic/a', agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
  const gate = sourceAwareGatedStream((ids) => ({ memories: [{ content: 'pnpm preference', kind: 'preference', confidence: .95, source_message_ids: ids }] }))
  const mock = scriptedContext({ session, script: [gate.stream] })
  let runtime
  try {
    runtime = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { minTurnChars: 0, everyNConversations: 1 }, budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
    runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Please remember to use pnpm for all my frontend work.' }] } })
    endTurnAfterQuietWindow(runtime, session)
    const pending = runtime.runExtraction(session.id)
    for (let n = 0; n < 20 && mock.calls.length === 0; n += 1) await Promise.resolve()
    assert.equal(mock.calls.length, 1)
    runtime.updateSettings({ generateMemory: false }); runtime.updateSettings({ generateMemory: true })
    gate.release(); await pending
    assert.equal((await read(runtime)).global.items.length, 0)
    assert.equal(mock.calls.length, 1, 'no automatic second provider call')
  } finally { gate.release(); runtime?.close(); f.close() }
})

test('Demo v7 L0 L1 L2 L3 pages and source-linked scene search use actual persisted records', async () => {
  const f = fixture()
  try {
    seed(f.root, 'source-a', 'pnpm stable preference', { persona: true })
    const runtime = f.open()
    for (const layer of ['L0', 'L1', 'L2', 'L3']) {
      const page = await read(runtime, layer)
      assert.equal(page.global.items.length, 1, layer)
      assert.equal(page.global.items[0].layer, layer)
    }
    assert.equal((await read(runtime, 'L1', 'stable')).global.items.length, 1)
    assert.equal((await read(runtime, 'L1', 'absent needle')).global.items.length, 0)
    assert.equal((await read(runtime, 'L0')).global.items[0].sources[0].sessionId, 'session-source-a')
  } finally { f.close() }
})

test('Demo v7 forget removes global recall and invalidates derived scene and persona output', async () => {
  const f = fixture()
  try {
    const record = seed(f.root, 'source-a', 'pnpm preference', { persona: true })
    const runtime = f.open()
    const ack = await runtime.manageProjectOperation('source-a', 'v7.forget', { layer: 'L1', id: record.id, updatedAt: record.updatedAt, confirmed: true })
    assert.equal(ack.applied, true)
    assert.equal(runtime.globalRecall('pnpm', { id: 'next', header: { agentPreset: 'agent-mock' } }), undefined)
    assert.equal((await read(runtime)).global.items.length, 0)
    assert.equal((await read(runtime, 'L3')).global.items.length, 0)
    assert.equal((await read(runtime, 'L2')).global.items.some((item) => item.content.includes('pnpm')), false)
  } finally { f.close() }
})

test('Demo v7 bounded profile enumeration rejects symlinks and reaches the fifth source', async () => {
  const f = fixture(), outside = fixture()
  try {
    for (let n = 0; n < 5; n += 1) seed(f.root, `source-${n}`, `pnpm preference ${n}`)
    mkdirSync(path.join(outside.root, 'foreign'))
    symlinkSync(path.join(outside.root, 'foreign'), path.join(f.root, 'projects', 'source-symlink'))
    const sources = profileSources(f.root)
    assert.equal(sources.keys.length, 5); assert.equal(sources.complete, true)
    const runtime = f.open()
    let cursor, found = false
    for (let window = 0; window < 8; window += 1) {
      const matches = runtime.searchGlobalDetailed('preference 4', 50, cursor)
      found ||= matches.candidates.some((item) => item.id.startsWith('g:source-4:'))
      cursor = matches.nextScan
      if (!cursor) break
    }
    assert.equal(found, true, 'ordinary global search reaches a fifth valid physical source')
    const all = new Set(); let next, windows = 0
    do {
      const collection = runtime.searchGlobalDetailed('pnpm', 50, next)
      const projects = new Set(collection.candidates.map((item) => parseGlobalMemoryKey(item.id).projectKey))
      assert.ok(projects.size <= 4, 'one publication window never includes a fifth unbound source')
      for (const item of collection.candidates) { assert.ok(!all.has(item.id), 'later windows must not rescan an emitted prefix'); all.add(item.id) }
      next = collection.nextScan; windows += 1
    } while (next !== undefined && windows < 8)
    assert.equal(next, undefined)
    assert.ok(windows > 1, 'the fifth source continues in an explicit new publication window')
    assert.equal(all.size, 5, 'bounded windows together reach every source exactly once')
    const boundDepth = runtime.searchGlobalDetailed('pnpm', 50, undefined, 0)
    assert.ok(boundDepth.nextScan, 'five physical sources require an explicit continuation window')
    const changedDepth = runtime.searchGlobalDetailed('pnpm', 50, boundDepth.nextScan, 2)
    assert.deepEqual(changedDepth.candidates, [], 'a saved window cannot be rebound to another relation depth')
    assert.equal(changedDepth.stopReason, 'global-read-unavailable')

    let recalled = false
    for (let window = 0; window < 8 && !recalled; window += 1) recalled = /preference 4/.test(runtime.globalRecall('preference 4', { id: `different-${window}`, header: { agentPreset: 'agent-mock' } }) ?? '')
    assert.equal(recalled, true, 'later real sessions can recall the fifth source')
    assert.ok(!sources.keys.includes('source-symlink'))
  } finally { f.close(); outside.close() }
})

test('Demo v7 RPC refuses requested filesystem roots and project scope controls', () => {
  for (const relationDepth of [-1, 3, 1.5]) assert.equal(ReadDashboardRequestSchema.safeParse({ ...request(), relationDepth }).success, false)
  for (const addition of [{ root: '/outside' }, { projectKeys: ['source-a'] }, { cwd: '/another' }]) assert.equal(ReadDashboardRequestSchema.safeParse({ ...request(), ...addition }).success, false)
})

test('Demo v7 annual activity keeps leap days DST labels future dates and unknown zero distinct', () => {
  const calendar = memoryYear(2024, 'America/New_York', [{ date: '2024-03-10', added: 2, updated: 1, records: ['g:a:b'] }], false, Date.parse('2024-03-11T03:00:00Z'))
  assert.equal(calendar.cells.length, 366)
  assert.equal(calendar.cells.filter((cell) => cell.date === '2024-02-29').length, 1)
  const today = calendar.cells.find((cell) => cell.date === '2024-03-10')
  assert.equal(today.count, 3); assert.equal(today.known, false)
  assert.equal(calendar.cells.find((cell) => cell.date === '2024-03-11').future, true)
  assert.equal(memoryMetric({ value: 0, relation: 'exact' }), '0')
  assert.equal(memoryMetric({ value: null, relation: 'unknown' }), '—')
  assert.match(memoryMetric({ value: 0, relation: 'lower_bound' }), /≥/)
})

test('Demo v7 calendar counts actual memory creation and ignores recall injection and L0 capture', async () => {
  const f = fixture()
  try {
    seed(f.root, 'source-a', 'pnpm preference')
    const runtime = f.open(), first = await read(runtime, 'home')
    runtime.recall('/synthetic/source-a', 'pnpm')
    const second = await read(runtime, 'home')
    assert.deepEqual(second.global.days, first.global.days)
    assert.equal(first.global.days.reduce((sum, day) => sum + day.added, 0), 1)
    assert.equal(first.global.days.reduce((sum, day) => sum + day.updated, 0), 0)
  } finally { f.close() }
})

test('Demo v7 late bootstrap is closed on its original transport before a queued reader starts', async () => {
  let resolve, cancelled = false
  const pending = new Promise((done) => { resolve = done }), calls = []
  const transport = async (input) => {
    calls.push(input.action)
    if (input.action === 'close') return { status: 'ok', complete: true }
    if (calls.filter((action) => action === 'global').length === 1) return pending
    return { status: 'ok', complete: true, readId: 'second', global: { layer: 'L1', items: [] } }
  }
  const first = readGlobalMemory(transport, request(), () => cancelled)
  await Promise.resolve(); cancelled = true
  const second = readGlobalMemory(transport, request())
  resolve({ status: 'partial', complete: false, readId: 'late', global: { layer: 'L1', items: [] } })
  assert.equal(await first, undefined); await second
  assert.deepEqual(calls, ['global', 'close', 'global', 'close'])
})

test('Demo v7 final-proof failures expose no global payload and unknown close outcomes block new allocation', async () => {
  let calls = 0
  const transport = async (input) => {
    calls += 1
    if (input.action === 'close') throw new Error('offline')
    return { status: 'stale', complete: false, readId: 'retired' }
  }
  await assert.rejects(() => readGlobalMemory(transport, request()), /资源尚未确认关闭/)
  const before = calls
  await assert.rejects(() => readGlobalMemory(transport, request()), /资源尚未确认关闭/)
  assert.equal(calls, before)
  const f = fixture()
  try {
    for (let n = 0; n < 12; n += 1) seed(f.root, 'source-a', `pnpm preference ${n}`, { sourceEventId: `final-proof-fixture-${n}` })
    const runtime = f.open(), first = runtime.readDashboard(request())
    assert.ok(first.cursor, 'the fixture must exercise a live continuation')
    {
      runtime.updateSettings({ useMemory: false })
      const stale = runtime.readDashboard({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
      assert.equal(stale.complete, false)
      assert.equal(stale.global, undefined)
    }
  } finally { f.close() }
})


test('Demo v7 extraction preserves conflict flags and refuses malformed confidence or flags', () => {
  const item = { content: '存在未解决的 pnpm 与 npm 偏好冲突', kind: 'preference', confidence: .99, has_conflict: true, source_message_ids: ['l0_a'] }
  const parsed = parseExtractionJson(JSON.stringify({ memories: [item] }))
  assert.equal(parsed.ok, true); assert.equal(parsed.memories[0].hasConflict, true)
  assert.equal(parseExtractionJson(JSON.stringify({ memories: [{ ...item, has_conflict: 'false' }] })).ok, false)
  assert.equal(parseExtractionJson('{"memories":[{"content":"invalid confidence must not approve","confidence":1e999}]}').ok, false)
})


test('Demo v7 global source switches retain one S1 ledger and enforce original project limits', () => {
  const manager = new DashboardReadSessionManager()
  const binding = { generationId: 'test', policyKey: 'a'.repeat(64), filterKey: 'b'.repeat(64), asOf: Date.now(), viewKey: 'memory.global.v7', projectKeys: [] }
  const begun = manager.begin(binding); assert.equal(begun.status, 'ok')
  const token = begun.value.callToken
  let before = 0
  const control = { dashboardReadVersion: () => ({ scope: 'control', connectionId: '00000000-0000-4000-8000-000000000009', dataVersion: 1, totalChanges: 0, writerEpoch: 1, observedWriterEpoch: 1 }) }
  assert.equal(manager.probeControl(token, control).status, 'ok')
  try {
    const discovery = ['source-3', 'source-1', 'source-2', 'source-0']
    for (const [i, key] of discovery.entries()) {
      assert.equal(manager.selectGlobalSource(token, key).status, 'ok')
      assert.equal(manager.probeProject(token, key, { dashboardReadVersion: () => ({ scope: 'project', connectionId: `00000000-0000-4000-8000-00000000000${i}`, dataVersion: 1, totalChanges: 0 }) }).status, 'ok')
      const counters = manager.counters(token).value
      assert.equal(counters.session.projects, i + 1)
      assert.ok(counters.session.keyBytes > before); before = counters.session.keyBytes
    }
    assert.equal(manager.selectGlobalSource(token, 'source-4').status, 'budget-exhausted')
    assert.equal(manager.counters(token).value.session.projects, 4)
    const suspended = manager.finish(token, true); assert.equal(suspended.status, 'ok')
    const resumed = manager.continue(suspended.value.continuationToken, { ...binding, projectKeys: discovery })
    assert.equal(resumed.status, 'ok', 'real S1 continuation accepts all contributors in arbitrary directory discovery order')
    assert.equal(manager.counters(resumed.value.callToken).value.session.projects, 4, 'continuation preserves the shared cumulative project charge')
  } finally { manager.close() }
})

test('Demo v7 non STRICT numeric projections suppress TEXT BLOB invalid dates and never invent zero', () => {
  const f = fixture(); const record = seed(f.root, 'source-a', 'numeric evidence', { persona: true })
  const store = openProjectStore(f.root, 'source-a')
  try {
    for (const invalid of ['x'.repeat(131072), Buffer.alloc(131072, 65), -1, 8640000000000001, Infinity]) {
      store.db.prepare('UPDATE l0_messages SET created_at = ?').run(invalid)
      store.db.prepare('UPDATE l1_revisions SET recorded_at = ?').run(invalid)
      store.db.prepare('UPDATE l3_persona SET updated_at = ?').run(invalid)
      assert.equal(store.globalSourceRow(0).createdAt, undefined)
      assert.equal(store.globalSourceLabel(record.sourceMessageIds[0]).createdAt, undefined)
      assert.equal(store.globalRevisionRow(0).at, undefined)
      assert.throws(() => store.globalDerivedSources('L3', 'persona'), /proof/)
    }
    store.db.prepare('UPDATE l1_revisions SET revision = ?').run(Buffer.alloc(131072))
    assert.equal(store.globalRevisionRow(0).revision, undefined)
    store.db.prepare('UPDATE l0_messages SET created_at = 0').run()
    assert.equal(store.globalSourceRow(0).createdAt, 0, 'a stored valid epoch zero remains distinct from NULL')
    store.db.prepare('UPDATE l0_messages SET created_at = ?').run('')
    assert.equal(store.globalSourceRow(0).createdAt, undefined)
  } finally { store.close(); f.close() }
})

test('Demo v7 revision projection bounds the actual SQLite driver column before JS conversion', () => {
  const f = fixture(); seed(f.root, 'source-a', 'bounded revision evidence')
  const store = openProjectStore(f.root, 'source-a'), db = store.db, prepare = db.prepare
  let returned = []
  // Observe the real driver's result. Do not substitute SQL, rows, or the Store conversion.
  db.prepare = function (sql, ...args) {
    const statement = Reflect.apply(prepare, this, [sql, ...args])
    if (/FROM\s+l1_revisions\s+WHERE\s+rowid/i.test(sql)) {
      const get = statement.get
      statement.get = function (...bound) {
        const row = Reflect.apply(get, this, bound)
        returned.push(row?.revision)
        return row
      }
    }
    return statement
  }
  try {
    for (const invalid of ['x'.repeat(131072), Buffer.alloc(131072, 65), '', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      db.prepare('UPDATE l1_revisions SET revision = ?').run(invalid)
      returned = []
      assert.equal(store.globalRevisionRow(0).revision, undefined)
      assert.deepEqual(returned, [null], 'SQLite must return NULL, never the oversized TEXT/BLOB or invalid numeric value')
    }
    for (const valid of [1, Number.MAX_SAFE_INTEGER]) {
      db.prepare('UPDATE l1_revisions SET revision = ?').run(valid)
      returned = []
      assert.equal(store.globalRevisionRow(0).revision, valid)
      assert.deepEqual(returned, [valid], 'safe positive integers survive both the driver and Store boundary')
      assert.equal(typeof returned[0], 'number')
    }
  } finally { db.prepare = prepare; store.close(); f.close() }
})

function assertGlobalPublicationFence(mode, surface) {
  const f = fixture(), roots = new Map(), dependencies = new Map()
  let runtime, externalWriter, originalOpen, originalRead
  const now = Date.now(), expiryAt = now + 600_000
  const trace = { first: undefined, second: undefined, pending: false, fired: false, priorPayload: false,
    hadPriorPayloadAtMutation: false, readers: 0, pages: [], wallNow: now }
  try {
    for (const key of ['source-a', 'source-b']) roots.set(key, seed(f.root, key, `pnpm publication root ${key}`))
    runtime = f.open()
    const writers = new Map([...roots.keys()].map((key) => [key, runtime.storeByKey(key, false)]))
    if (mode === 'dependency-expiry') {
      for (const [key, root] of roots) {
        const store = writers.get(key)
        const source = store.captureMessage({ sessionId: `dependency-${key}`, role: 'user', content: 'Synthetic prerequisite evidence.',
          sourceEventId: `dependency-${key}`, origin: 'dsh-session', sourceKind: 'conversation', agentPreset: 'agent-mock' })
        const dependency = store.addMemory({ content: `Synthetic prerequisite ${key}.`, kind: 'fact', status: 'approved',
          confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] }).record
        dependencies.set(key, dependency)
        store.db.prepare(`INSERT INTO memory_relations(id, from_id, to_id, relation_type, evidence_ids,
          from_revision, to_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`publication-dependency-${key}`, root.id, dependency.id, 'depends_on', JSON.stringify([source.id]), root.revision, dependency.revision, Date.now())
      }
    }
    originalOpen = runtime.beginDashboardAggregateRead
    runtime.beginDashboardAggregateRead = function (...args) {
      const opened = Reflect.apply(originalOpen, this, args)
      if (opened.status !== 'ok') return opened
      trace.readers += 1
      const reader = opened.value, select = reader.selectGlobalSource, page = reader.readManagedPage, publish = reader.publishProof
      trace.wallNow = Math.max(Date.now(), reader.lastWallNow ?? 0)
      reader.wallNow = () => trace.wallNow
      reader.selectGlobalSource = function (key) {
        if (trace.first === undefined) {
          trace.first = key
          // Set up only A, before its first real probe. B remains unexpired throughout.
          if (mode === 'root-expiry' || mode === 'dependency-expiry') {
            const target = mode === 'root-expiry' ? roots.get(key) : dependencies.get(key)
            writers.get(key).db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiryAt, target.id)
            if (mode === 'dependency-expiry') assert.equal(writers.get(key).db.prepare('SELECT expiry_at FROM l1_memories WHERE id = ?').get(roots.get(key).id).expiry_at, null)
          }
        }
        return Reflect.apply(select, this, [key])
      }
      reader.readManagedPage = function (key, ...rest) {
        const output = Reflect.apply(page, this, [key, ...rest])
        if (key !== trace.first && output.status === 'ok' && output.value.items.some((item) =>
          item.state === 'visible' && item.record?.id === roots.get(key)?.id)) {
          trace.second = key; trace.pending = true
        }
        return output
      }
      reader.publishProof = function (...proofArgs) {
        if (trace.pending && !trace.fired) {
          trace.hadPriorPayloadAtMutation = trace.priorPayload
          trace.fired = true
          if (mode === 'same-connection-version' || mode === 'other-connection-version') {
            const writer = mode === 'same-connection-version' ? writers.get(trace.first)
              : (externalWriter = openProjectStore(f.root, trace.first))
            writer.db.prepare('UPDATE l1_memories SET confidence = ? WHERE id = ?').run(.73, roots.get(trace.first).id)
          } else trace.wallNow = expiryAt
        }
        return Reflect.apply(publish, this, proofArgs)
      }
      return opened
    }
    originalRead = runtime.readDashboard
    runtime.readDashboard = function (...args) {
      const output = Reflect.apply(originalRead, this, args)
      assert.equal(ReadDashboardResultSchema.safeParse(output).success, true, 'real RPC output retains the strict codec')
      if (args[0].action !== 'close') trace.pages.push(output)
      if (!trace.fired && output.global?.items.some((item) => item.projectKey === trace.first && item.id === roots.get(trace.first)?.id)) trace.priorPayload = true
      return output
    }
    if (surface === 'search') {
      const collection = runtime.searchGlobalDetailed('pnpm', 50)
      assert.deepEqual(collection.candidates, [], 'a failed final proof discards candidates accumulated from earlier RPC pages')
      assert.equal(collection.candidateCount, 0)
      assert.equal(collection.stopReason, 'global-read-unavailable')
    } else {
      let output = runtime.readDashboard(request('L1', 'pnpm'))
      for (let round = 0; output.cursor !== undefined && round < 16; round += 1) {
        output = runtime.readDashboard({ version: 1, action: 'continue', readId: output.readId, cursor: output.cursor })
      }
    }
    assert.equal(trace.readers, 1, 'A and B must contribute to the same publication window and ledger')
    assert.equal(trace.fired, true, 'the fixture must reach B after A; a budget failure is not a successful fence test')
    assert.notEqual(trace.first, trace.second)
    assert.equal(trace.hadPriorPayloadAtMutation, true, 'A was already returned before B reached its final publication boundary')
    const failed = trace.pages.at(-1)
    assert.equal(failed.status, 'stale')
    assert.equal(failed.complete, false)
    assert.equal(failed.global, undefined, 'no items, counts, days, or continuation payload may survive the failed proof')
    assert.equal(failed.cursor, undefined)
  } finally {
    if (runtime && originalOpen) runtime.beginDashboardAggregateRead = originalOpen
    if (runtime && originalRead) runtime.readDashboard = originalRead
    externalWriter?.close(); f.close()
  }
}

test('Demo v7 final publication fences earlier source total_changes and clears accumulated recall', () => {
  for (const surface of ['rpc', 'search']) assertGlobalPublicationFence('same-connection-version', surface)
})

test('Demo v7 final publication fences earlier source data_version and clears accumulated recall', () => {
  for (const surface of ['rpc', 'search']) assertGlobalPublicationFence('other-connection-version', surface)
})

test('Demo v7 final publication rejects an earlier root expiry with a synthetic clock', () => {
  for (const surface of ['rpc', 'search']) assertGlobalPublicationFence('root-expiry', surface)
})

test('Demo v7 final publication retains the earliest dependency expiry of an earlier source', () => {
  for (const surface of ['rpc', 'search']) assertGlobalPublicationFence('dependency-expiry', surface)
})

test('Demo v7 automatic L3 respects disabled gates zero budgets and excluded agents', async () => {
  for (const patch of [{ generateMemory: false }, { capture: { enabled: false } }, { extraction: { enabled: false } },
    { budget: { automaticDailyTokens: 0 } }, { budget: { automaticDailyTasks: 0 } }, { capture: { excludeAgents: ['agent-mock'] } }]) {
    const f = fixture(), session = { id: 'guarded', header: { agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
    const mock = scriptedContext({ session, script: [] })
    const runtime = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { minTurnChars: 0, everyNConversations: 1, ...patch.extraction },
      budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100, ...patch.budget }, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'extraction' && key !== 'budget')) }), f.root)
    try {
      runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'guarded', role: 'user', content: [{ type: 'text', text: '请始终使用 pnpm 管理我的项目。' }] } })
      endTurnAfterQuietWindow(runtime, session); await runtime.runExtraction(session.id)
      assert.equal((await read(runtime, 'L3')).global.items.length, 0)
      assert.equal(mock.calls.length, 0)
    } finally { runtime.close(); f.close() }
  }
})

test('Demo v7 effective switches honor legacy disables and persist deliberate enable without raising zero budgets', async () => {
  const f = fixture(), config = { capture: { enabled: false }, extraction: { enabled: false }, recall: { enabled: false }, budget: { automaticDailyTokens: 0 } }
  try {
    let runtime = f.open(config)
    const initial = await read(runtime)
    assert.equal(initial.global.generateMemory, false); assert.equal(initial.global.useMemory, false)
    runtime.updateSettings({ generateMemory: true, useMemory: true }); runtime.close(); runtime = f.open(config)
    const enabled = await read(runtime)
    assert.equal(enabled.global.generateMemory, true); assert.equal(enabled.global.useMemory, true); assert.equal(enabled.global.paused, true)
    assert.equal(runtime.config.budget.automaticDailyTokens, 0)
  } finally { f.close() }
})

test('Demo v7 L0 L2 and L3 cannot use the new L1-only forget operation', async () => {
  const f = fixture(); const record = seed(f.root, 'source-a', 'protected preference', { persona: true })
  try {
    const runtime = f.open()
    for (const layer of ['L0', 'L2', 'L3']) await assert.rejects(runtime.manageProjectOperation('source-a', 'v7.forget', { layer, id: record.id, updatedAt: record.updatedAt, confirmed: true }), /L1/)
    assert.equal((await read(runtime)).global.items.length, 1)
  } finally { f.close() }
})


test('Demo v7 one large source reaches its tail across explicit windows without duplicate or lost rows', async () => {
  const f = fixture(), other = fixture(), expected = new Set()
  const store = openProjectStore(f.root, 'source-tail', { key: 'source-tail', name: 'tail', cwd: '/synthetic/tail' })
  try {
    for (let i = 0; i < 40; i += 1) {
      const content = `bounded-tail-record-${i} preference`
      const source = store.captureMessage({ sessionId: 'tail', role: 'user', content, createdAt: Date.now(), sourceEventId: `tail-${i}`, origin: 'dsh-session', sourceKind: 'conversation', agentPreset: 'agent-mock' })
      const record = store.addMemory({ content, kind: 'preference', status: 'approved', confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] }).record
      expected.add(globalMemoryKey('source-tail', record.id))
    }
  } finally { store.close() }
  try {
    const runtime = f.open(), isolated = other.open(), seen = new Set()
    let resume, windows = 0
    do {
      const input = { ...request(), ...(resume ? { resume } : {}) }
      const page = await readGlobalMemory(async (value) => runtime.readDashboard(value), input)
      if (resume) {
        const replay = await readGlobalMemory(async (value) => runtime.readDashboard(value), input)
        assert.deepEqual(replay.global.items.map((item) => item.key), page.global.items.map((item) => item.key), 'a fresh reproof of the same window supports offsets and budget retries')
        page.global.next = replay.global.next
      }
      for (const item of page.global.items) { assert.equal(seen.has(item.key), false, 'keyset progress must not repeat rows'); seen.add(item.key) }
      resume = page.global.next; windows += 1
      if (resume) {
        assert.equal(page.complete, false)
        assert.equal(isolated.readDashboard({ ...request(), resume }).status, 'stale', 'progress is local to the actual profile')
      }
    } while (resume && windows < 32)
    assert.equal(resume, undefined); assert.ok(windows > 1)
    assert.deepEqual(seen, expected)
  } finally { f.close(); other.close() }
})

test('Demo v7 progress bookmarks are accounted replayable expiring and invalidated with policy', () => {
  let now = 0, disposed = 0
  const manager = new DashboardReadSessionManager({ monotonicNow: () => now })
  const binding = { generationId: 'test', policyKey: 'a'.repeat(64), filterKey: 'b'.repeat(64), asOf: 1, viewKey: 'memory.global.v7', projectKeys: [] }
  const control = { dashboardReadVersion: () => ({ scope: 'control', connectionId: '00000000-0000-4000-8000-000000000009', dataVersion: 1, totalChanges: 0, writerEpoch: 1, observedWriterEpoch: 1 }) }
  const begin = () => { const opened = manager.begin(binding); assert.equal(opened.status, 'ok'); assert.equal(manager.probeControl(opened.value.callToken, control).status, 'ok'); return opened.value.callToken }
  try {
    let call = begin(), baseline = manager.stats().accountedBytes
    const first = manager.retainGlobalProgress(call, () => { disposed += 1 }); assert.equal(first.status, 'ok')
    assert.ok(manager.stats().accountedBytes >= baseline + 512 * 1024)
    manager.finish(call, false)
    assert.equal(manager.inspectGlobalProgress(first.value), true); assert.equal(manager.inspectGlobalProgress(first.value), true)
    manager.dropGlobalProgress(first.value); assert.equal(manager.inspectGlobalProgress(first.value), false); disposed = 0
    call = begin(); const expired = manager.retainGlobalProgress(call, () => { disposed += 1 }); manager.finish(call, false)
    now += manager.limits.absoluteMilliseconds
    assert.equal(manager.inspectGlobalProgress(expired.value), false); assert.equal(disposed, 1)
    call = begin(); const stale = manager.retainGlobalProgress(call, () => { disposed += 1 }); manager.finish(call, false)
    manager.invalidate('settings-policy-change')
    assert.equal(manager.inspectGlobalProgress(stale.value), false); assert.equal(disposed, 2)
  } finally { manager.close() }
})

test('Demo v7 source revisions invalidate an automatically produced persona', async () => {
  const f = fixture(), session = { id: 'revision', header: { agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
  const mock = scriptedContext({ session, script: [sourceAwareStream((ids) => ({ memories: [{ content: 'pnpm preference', kind: 'preference', confidence: .99, source_message_ids: ids }] }))] })
  const runtime = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { minTurnChars: 0, everyNConversations: 1 }, budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
  let observedDb, originalPrepare
  try {
    runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'revision', role: 'user', content: [{ type: 'text', text: '请记住我偏好使用 pnpm 管理依赖。' }] } })
    endTurnAfterQuietWindow(runtime, session); await runtime.runExtraction(session.id)
    assert.equal((await read(runtime, 'L3')).global.items.length, 1)
    const item = (await read(runtime)).global.items[0]
    const writer = runtime.storeByKey(item.projectKey, false)
    const localPersona = (await read(runtime, 'L3')).global.items[0]
    assert.equal(localPersona.id, 'persona', 'automatic extraction persists the local project persona')
    assert.equal(localPersona.projectKey, item.projectKey)
    assert.equal(localPersona.key, globalMemoryKey(item.projectKey, 'persona'))

    const peerKey = 'persona-head-peer'
    const peer = openProjectStore(f.root, peerKey, { key: peerKey, name: peerKey, cwd: '/synthetic/persona-head-peer' })
    peer.close()
    assert.ok(runtime.storeByKey(peerKey, false), 'fusion uses a real second bound store')
    const db = writer.db, prepare = db.prepare
    observedDb = db; originalPrepare = prepare
    let returned = { ordinary: [], fused: [] }
    // Observe the actual bounded driver columns without replacing SQL, rows, or proof results.
    db.prepare = function (sql, ...args) {
      const statement = Reflect.apply(prepare, this, [sql, ...args])
      const projection = sql.includes(' AS current_revision') ? 'ordinary' :
        sql.includes(' AS meta_current_revision') ? 'fused' : undefined
      if (projection !== undefined) {
        const method = projection === 'ordinary' ? 'get' : 'all', original = statement[method]
        statement[method] = function (...bound) {
          const result = Reflect.apply(original, this, bound)
          for (const row of projection === 'ordinary' ? [result] : result) {
            returned[projection].push(row?.[projection === 'ordinary' ? 'current_revision' : 'meta_current_revision'])
          }
          return result
        }
      }
      return statement
    }
    function assertDriverHead(projection, expected) {
      assert.ok(returned[projection].length > 0, `${projection} really queried its metadata projection`)
      for (const value of returned[projection]) {
        assert.equal(value, expected ?? null, 'SQLite returns a safe positive integer or NULL before JS mapping')
      }
    }
    function assertMetadata(expected) {
      returned = { ordinary: [], fused: [] }
      assert.equal(writer.dashboardVisibilityMemoryMeta(item.id).currentRevision, expected)
      const page = writer.dashboardVisibilityNodePage(item.id, 2, 1024)
      assert.equal(page.meta.currentRevision, expected)
      assert.equal(page.rows[0].revision, item.revision, 'the selected history remains independent of the current head')
      assertDriverHead('ordinary', expected); assertDriverHead('fused', expected)
    }
    function assertPersonaProofs(state, head) {
      for (const fused of [false, true]) {
        for (const entrypoint of ['readManagedPersona', 'proveManagedPersonaSource']) {
          const opened = runtime.beginDashboardVisibilityRead({ generationId: 'persona-head', policyKey: 'a'.repeat(64),
            filterKey: 'b'.repeat(64), asOf: Date.now() + 60_000, viewKey: 'overview',
            projectKeys: fused ? [item.projectKey, peerKey] : [item.projectKey] })
          assert.equal(opened.status, 'ok')
          const reader = opened.value
          returned = { ordinary: [], fused: [] }
          try {
            const operation = () => entrypoint === 'readManagedPersona' ? reader.readManagedPersona(item.projectKey) :
              reader.proveManagedPersonaSource(item.projectKey, item.id, item.revision)
            const result = fused ? withDashboardOverviewFusion(reader, operation) : operation()
            assert.equal(result.status, 'ok', `${entrypoint} uses the unchanged shared read budget`)
            if (entrypoint === 'readManagedPersona') {
              assert.equal(result.value.state, state)
              assert.equal(result.value.content, state === 'visible' ? localPersona.content : undefined)
              if (state === 'unresolved') assert.equal(result.value.reason, 'persona-source-not-current')
            } else assert.equal(result.value, state)
            assertDriverHead(fused ? 'fused' : 'ordinary', head)
            assert.equal(returned[fused ? 'ordinary' : 'fused'].length, 0, 'each entrypoint exercises the requested metadata path')
            assert.equal(reader.publishProof().status, 'ok', 'final scope/version/TTL proof remains required')
          } finally { reader.cancel() }
        }
      }
    }
    assertMetadata(item.revision)
    assertPersonaProofs('visible', item.revision)
    writer.db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(item.id)
    assert.equal((await read(runtime, 'L3')).global.items.length, 0)
    assertMetadata(item.revision + 1)
    assertPersonaProofs('unresolved', item.revision + 1)
    for (const invalid of ['x'.repeat(131072), Buffer.alloc(131072, 65), '', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      db.prepare('UPDATE l1_memories SET revision = ? WHERE id = ?').run(invalid, item.id)
      assertMetadata(undefined)
      assertPersonaProofs('unresolved', undefined)
    }
    db.prepare('UPDATE l1_memories SET revision = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, item.id)
    assertMetadata(Number.MAX_SAFE_INTEGER)
    assertPersonaProofs('unresolved', Number.MAX_SAFE_INTEGER)
    assert.equal(mock.calls.length, 1)
  } finally {
    if (observedDb !== undefined) observedDb.prepare = originalPrepare
    runtime.close(); f.close()
  }
})


function sceneProgressFixture(memberCount = 24, peers = true) {
  const f = fixture('v7-scene-progress-'), records = []
  const store = openProjectStore(f.root, 'scene-a', { key: 'scene-a', name: 'scene-a', cwd: '/synthetic/scene-a' })
  try {
    for (let index = 0; index < memberCount; index += 1) {
      const content = `Scene progress preference ${index}: use pnpm for reproducible project work.`
      const source = store.captureMessage({ sessionId: 'scene-progress', role: 'user', content, createdAt: Date.now(),
        sourceEventId: `scene-progress-${index}`, origin: 'dsh-session', sourceKind: 'conversation', agentPreset: 'agent-mock' })
      records.push(store.addMemory({ content, scene: 'large-scene', kind: 'preference', status: 'approved',
        confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] }).record)
    }
    store.refreshScenes()
  } finally { store.close() }
  const sceneKeys = new Set([globalMemoryKey('scene-a', 'scene/large-scene')])
  if (peers) for (const letter of ['b', 'c', 'd', 'e', 'f']) {
    const key = `scene-${letter}`, scene = `small-scene-${letter}`
    seed(f.root, key, `Synthetic ${letter} scene preference.`, { scene, sourceEventId: `scene-peer-${letter}` })
    sceneKeys.add(globalMemoryKey(key, `scene/${scene}`))
  }
  return { ...f, records, sceneKeys }
}

// Passive observers preserve native SQL/proofs/results. All assertions drive the public RPC.
function observeSceneProgress(runtime, records, hooks = {}) {
  const open = runtime.beginDashboardAggregateRead, readers = [], expected = new Set(records.map((record) => record.id))
  runtime.beginDashboardAggregateRead = function (...args) {
    const opened = Reflect.apply(open, this, args)
    if (opened.status !== 'ok') return opened
    const reader = opened.value, entry = { reader, successes: new Map(), finalVisible: 0 }
    readers.push(entry); hooks.open?.(reader, entry)
    const prove = reader.proveManagedSceneMember, final = reader.readManagedSceneFinal, publish = reader.publishProof
    let provingSceneMember = false, finalizingScene = false
    reader.proveManagedSceneMember = function (key, id, revision) {
      if (provingSceneMember) return Reflect.apply(prove, this, [key, id, revision])
      provingSceneMember = true
      try {
        const output = Reflect.apply(prove, this, [key, id, revision])
        if (key === 'scene-a' && expected.has(id) && output.status === 'ok' && output.value === 'visible') {
          assert.equal(revision, records.find((record) => record.id === id).revision)
          entry.successes.set(id, (entry.successes.get(id) ?? 0) + 1)
          assert.equal(entry.successes.get(id), 1, 'completed members do not restart at every RPC in the same reader')
        }
        return output
      } finally { provingSceneMember = false }
    }
    reader.readManagedSceneFinal = function (key, identity) {
      if (finalizingScene) return Reflect.apply(final, this, [key, identity])
      finalizingScene = true
      try {
        if (key === 'scene-a' && identity.name === 'large-scene') {
          assert.deepEqual(new Set(entry.successes.keys()), expected, 'this reader must prove every member before finalization')
          assert.equal(identity.memberCount, records.length)
          assert.equal(identity.memoryCount, records.length)
          hooks.beforeFinal?.(reader, entry)
        }
        const output = Reflect.apply(final, this, [key, identity])
        if (key === 'scene-a' && identity.name === 'large-scene' && output.status === 'ok' && output.value.state === 'visible') {
          entry.finalVisible += 1; hooks.afterFinal?.(reader, entry)
        }
        return output
      } finally { finalizingScene = false }
    }
    reader.publishProof = function (...proofArgs) {
      hooks.beforePublish?.(reader, entry)
      const output = Reflect.apply(publish, this, proofArgs)
      if (output.status === 'ok') {
        const counters = runtime.dashboardReadSessions.counters(reader.callToken)
        assert.equal(counters.status, 'ok')
        for (const [kind, limits] of [['call', runtime.dashboardReadSessions.limits.perCall], ['session', runtime.dashboardReadSessions.limits.perSession]]) {
          for (const field of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes', 'projects']) {
            assert.ok(counters.value[kind][field] <= limits[field], `${kind} ${field} remains inside its real ledger`)
          }
        }
      }
      return output
    }
    return opened
  }
  return { readers, restore() { runtime.beginDashboardAggregateRead = open } }
}

function driveSceneRpc(runtime, layer, onPage) {
  const pages = [], windows = []
  let resume
  for (let window = 0; window < 16; window += 1) {
    let page = runtime.readDashboard({ ...request(layer), ...(resume === undefined ? {} : { resume }) })
    let continuations = 0
    for (;;) {
      assert.equal(ReadDashboardResultSchema.safeParse(page).success, true)
      pages.push(page); onPage?.(page)
      const stats = runtime.dashboardReadSessions.stats()
      assert.ok(stats.sessions <= 2); assert.ok(stats.accountedBytes <= 8 * 1024 * 1024)
      if (page.global === undefined || page.cursor === undefined) break
      assert.ok(continuations < 16, 'a window never exceeds the existing continuation bound')
      continuations += 1
      page = runtime.readDashboard({ version: 1, action: 'continue', readId: page.readId, cursor: page.cursor })
    }
    if (page.readId !== undefined) runtime.readDashboard({ version: 1, action: 'close', readId: page.readId })
    windows.push(page)
    if (page.global === undefined) return { pages, windows, failed: page }
    resume = page.global.next
    if (resume === undefined) return { pages, windows }
  }
  assert.fail('scene progress must complete or fail within bounded bookmark windows')
}

function closeSceneFixture(f, runtime, trace) {
  trace?.restore()
  const manager = runtime?.dashboardReadSessions
  f.close()
  if (manager) assert.deepEqual(manager.stats(), { sessions: 0, activeCalls: 0, accountedBytes: 0, closed: true })
}

test('Demo v7 global L2 and home finish a 24-member scene through bounded public RPCs', () => {
  for (const layer of ['L2', 'home']) {
    const f = sceneProgressFixture(); let runtime, trace
    try {
      runtime = f.open(); trace = observeSceneProgress(runtime, f.records)
      const limits = runtime.dashboardReadSessions.limits
      assert.equal(limits.perCall.sqlStatements, 64); assert.equal(limits.perSession.sqlStatements, 512)
      assert.equal(limits.perCall.rowsVisited, 2048); assert.equal(limits.perCall.materializedBytes, 1024 * 1024)
      assert.equal(limits.maxContinuations, 16); assert.equal(limits.perCall.projects, 4)
      const result = driveSceneRpc(runtime, layer)
      assert.equal(result.failed, undefined, '24 members must finish with the unchanged native budgets')
      assert.equal(result.windows.at(-1).global.next, undefined)
      assert.equal(result.windows.reduce((sum, page) => sum + page.global.counts.L2.value, 0), 6)
      assert.ok(trace.readers.some((entry) => entry.finalVisible === 1 && entry.successes.size === 24))
      assert.ok(result.pages.some((page) => page.cursor !== undefined), 'the large scene exercises real RPC continuation')
      assert.ok(result.windows.length > 1, 'six sources retain the four-source publication window')
      if (layer === 'L2') {
        const items = result.pages.flatMap((page) => page.global.items)
        assert.equal(items.length, 6, 'a scene is emitted only after its complete proof')
        assert.deepEqual(new Set(items.map((item) => item.key)), f.sceneKeys)
      } else assert.ok(result.pages.every((page) => page.global.items.every((item) => item.layer === 'L1')))
    } finally { closeSceneFixture(f, runtime, trace) }
  }
})

test('Demo v7 large scene final fences reject mutations expiry and revocation without payload', () => {
  for (const layer of ['L2', 'home']) for (const mode of ['members', 'head', 'forget', 'revoke', 'root-expiry', 'dependency-expiry', 'publication-version']) {
    const f = sceneProgressFixture(); let runtime, trace, fired = false, pending = false
    try {
      runtime = f.open()
      const writer = runtime.storeByKey('scene-a', false), first = f.records[0], now = Date.now(), expiry = now + 60_000
      if (mode === 'root-expiry') writer.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiry, first.id)
      if (mode === 'dependency-expiry') {
        const source = writer.captureMessage({ sessionId: 'scene-dependency', role: 'user', content: 'Required scene dependency.',
          sourceEventId: 'scene-dependency', origin: 'dsh-session', sourceKind: 'conversation', agentPreset: 'agent-mock' })
        const dependency = writer.addMemory({ content: 'Required scene dependency.', scene: 'dependency-scene', kind: 'fact', status: 'approved',
          confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] }).record
        writer.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiry, dependency.id)
        writer.db.prepare(`INSERT INTO memory_relations(id, from_id, to_id, relation_type, evidence_ids,
          from_revision, to_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('scene-progress-dependency', first.id, dependency.id, 'depends_on', JSON.stringify([source.id]), first.revision, dependency.revision, now)
        writer.refreshScenes()
      }
      trace = observeSceneProgress(runtime, f.records, {
        open(reader) { const fixedNow = Math.max(now, Date.now(), reader.lastWallNow ?? 0); reader.wallNow = () => fixedNow },
        beforeFinal(reader) {
          if (fired || mode === 'publication-version') return
          fired = true
          if (mode === 'members') writer.db.prepare('DELETE FROM l2_scene_members WHERE memory_id = ?').run(first.id)
          else if (mode === 'head') writer.db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(first.id)
          else if (mode === 'forget') writer.forget(first.id)
          else if (mode === 'revoke') runtime.control.revokeSourceEvent('scene-a', 'scene-progress-0', first.sourceMessageIds[0])
          else reader.wallNow = () => expiry + 1
        },
        afterFinal() { if (mode === 'publication-version') pending = true },
        beforePublish() {
          if (!pending || fired) return
          fired = true
          writer.db.prepare('UPDATE l1_memories SET updated_at = updated_at + 1 WHERE id = ?').run(first.id)
        },
      })
      const result = driveSceneRpc(runtime, layer)
      assert.equal(fired, true, `${layer}/${mode} must reach the actual final boundary after all 24 proofs`)
      assert.ok(result.failed, 'an unrelated early budget stop is not a successful invalidation test')
      assert.equal(result.failed.status, 'stale')
      assert.equal(result.failed.global, undefined, 'failed final publication exposes no summary, counts, calendar, or bookmark payload')
      assert.equal(result.failed.cursor, undefined)
      assert.ok(result.pages.every((page) => !page.global?.items.some((item) => item.key === globalMemoryKey('scene-a', 'scene/large-scene'))))
    } finally { closeSceneFixture(f, runtime, trace) }
  }
})

test('Demo v7 scene continuation close and policy invalidation release reader state', () => {
  for (const layer of ['L2', 'home']) for (const mode of ['close', 'policy']) {
    const f = sceneProgressFixture(); let runtime, trace, fired = false
    try {
      runtime = f.open(); trace = observeSceneProgress(runtime, f.records)
      const result = driveSceneRpc(runtime, layer, (page) => {
        if (fired || page.cursor === undefined || !trace.readers.some((entry) => entry.successes.size > 0 && entry.successes.size < 24)) return
        fired = true
        if (mode === 'close') {
          const closed = runtime.readDashboard({ version: 1, action: 'close', readId: page.readId })
          assert.equal(closed.status, 'ok'); assert.equal(closed.global, undefined)
        } else runtime.updateSettings({ generateMemory: false })
        assert.equal(runtime.dashboardReadSessions.stats().sessions, 0)
      })
      assert.equal(fired, true, 'cancellation happens while the large scene has real saved proof progress')
      assert.equal(result.failed?.status, 'stale')
      assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
    } finally { closeSceneFixture(f, runtime, trace) }
  }
})

test('Demo v7 unfinished scene bookmarks reprove members and stop at unchanged session limits', () => {
  const f = sceneProgressFixture(100, false); let runtime, trace
  try {
    runtime = f.open(); trace = observeSceneProgress(runtime, f.records)
    const result = driveSceneRpc(runtime, 'L2')
    assert.equal(result.windows.length, 2, 'only one fresh reader may retry a scene that cannot fit a complete window')
    assert.equal(result.windows[0].reason, 'global-total-budget-limit')
    assert.ok(result.windows[0].global.next)
    assert.equal(result.failed?.status, 'budget_exhausted')
    assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
    assert.equal(trace.readers.length, 2)
    const [first, fresh] = trace.readers
    assert.ok(first.successes.size > 0 && first.successes.size < 100)
    assert.ok(fresh.successes.size > 0 && fresh.successes.size < 100)
    assert.ok([...fresh.successes.keys()].some((id) => first.successes.has(id)), 'new reader redoes proofs instead of inheriting trusted member offsets')
    assert.ok(trace.readers.every((entry) => entry.finalVisible === 0))
    assert.ok(result.pages.every((page) => (page.global?.items.length ?? 0) === 0))
  } finally { closeSceneFixture(f, runtime, trace) }
})


async function automaticEightSourcePersonaFixture(peers = true) {
  const f = fixture('v7-persona-progress-')
  const session = { id: 'persona-eight', header: { agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
  const preferences = ['使用 pnpm 管理依赖', '用简体中文写说明', '提交前检查类型', '保留来源信息',
    '把大改动拆成小提交', '先验证再发布', '界面使用深色主题', '优先离线测试']
  const mock = scriptedContext({ session, script: [sourceAwareStream((ids) => ({ memories: preferences.map((text) => ({
    content: `用户偏好${text}。`, kind: 'preference', confidence: .99, source_message_ids: ids,
  })) }))] })
  const generator = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { minTurnChars: 0, everyNConversations: 1, maxMemoriesPerPass: 8 },
    budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
  let projectKey, persona
  try {
    generator.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'persona-eight-input', role: 'user',
      content: [{ type: 'text', text: `请记住这些偏好：${preferences.join('；')}。` }] } })
    generator.onSessionEvent(session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 2 } })
    // Keep the real clock: allow the normal quiet window before awaiting extraction.
    await new Promise((resolve) => setTimeout(resolve, 1400))
    await generator.runExtraction(session.id)
    for (let poll = 0; generator.sessions.get(session.id)?.extracting && poll < 500; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.notEqual(generator.sessions.get(session.id)?.extracting, true, 'await an already scheduled extraction without another provider request')
    assert.equal(mock.calls.length, 1)
    const keys = profileSources(f.root).keys
    assert.equal(keys.length, 1); projectKey = keys[0]
    persona = generator.storeByKey(projectKey, false).persona()
    assert.equal(persona.sourceIds.length, 8, 'the actual extraction path automatically writes all eight L1 sources into L3')
    assert.equal(persona.sourceCount, 8); assert.equal(persona.stale, false)
    for (const text of preferences) assert.ok(persona.content.includes(text))
  } catch (error) {
    generator.close(); f.close(); throw error
  } finally { generator.close() }
  const expected = new Map([[projectKey, { ids: persona.sourceIds, revisions: persona.sourceRevisions }]])
  if (peers) for (const letter of ['b', 'c', 'd', 'e', 'f']) {
    const key = `persona-peer-${letter}`
    const record = seed(f.root, key, `Synthetic persona ${letter} preference.`, { persona: true, sourceEventId: `persona-peer-${letter}` })
    expected.set(key, { ids: [record.id], revisions: { [record.id]: record.revision } })
  }
  return { ...f, projectKey, persona, expected, mock }
}

function observePersonaProgress(runtime, expected, hooks = {}) {
  const open = runtime.beginDashboardAggregateRead, readers = []
  runtime.beginDashboardAggregateRead = function (...args) {
    const opened = Reflect.apply(open, this, args)
    if (opened.status !== 'ok') return opened
    const reader = opened.value, entry = { reader, proved: new Map(), bodies: new Set() }
    readers.push(entry)
    const source = reader.proveManagedPersonaSource, body = reader.readManagedPersonaBody, publish = reader.publishProof
    let proving = false, readingBody = false
    reader.proveManagedPersonaSource = function (key, id, revision) {
      if (proving) return Reflect.apply(source, this, [key, id, revision])
      proving = true
      try {
        const output = Reflect.apply(source, this, [key, id, revision])
        if (output.status === 'ok' && output.value === 'visible') {
          const plan = expected.get(key); assert.ok(plan); assert.ok(plan.ids.includes(id)); assert.equal(revision, plan.revisions[id])
          const ids = entry.proved.get(key) ?? new Set()
          assert.equal(ids.has(id), false, 'a completed source is not proved again at the next RPC in this reader')
          ids.add(id); entry.proved.set(key, ids)
        }
        return output
      } finally { proving = false }
    }
    reader.readManagedPersonaBody = function (key, plan) {
      if (readingBody) return Reflect.apply(body, this, [key, plan])
      readingBody = true
      try {
        assert.deepEqual(entry.proved.get(key), new Set(expected.get(key).ids), 'only this reader can supply all source proofs')
        hooks.beforeBody?.(reader, key, entry)
        const output = Reflect.apply(body, this, [key, plan])
        if (output.status === 'ok' && output.value.state === 'visible' && output.value.stale !== true) {
          entry.bodies.add(key); hooks.afterBody?.(reader, key, entry)
        }
        return output
      } finally { readingBody = false }
    }
    reader.publishProof = function (...args) {
      hooks.beforePublish?.(reader, entry)
      const output = Reflect.apply(publish, this, args)
      if (output.status === 'ok') {
        const counters = runtime.dashboardReadSessions.counters(reader.callToken)
        assert.equal(counters.status, 'ok')
        for (const [kind, limits] of [['call', runtime.dashboardReadSessions.limits.perCall], ['session', runtime.dashboardReadSessions.limits.perSession]]) {
          for (const field of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes', 'projects']) {
            assert.ok(counters.value[kind][field] <= limits[field])
          }
        }
      }
      return output
    }
    return opened
  }
  return { readers, restore() { runtime.beginDashboardAggregateRead = open } }
}

async function drivePersonaRpc(runtime, layer = 'L3', hooks = {}) {
  const pages = [], windows = []
  let resume
  for (let window = 0; window < 8; window += 1) {
    let page = runtime.readDashboard({ ...request(layer), ...(resume === undefined ? {} : { resume }) }), continuations = 0
    for (;;) {
      assert.equal(ReadDashboardResultSchema.safeParse(page).success, true)
      pages.push(page); await hooks.page?.(page)
      const stats = runtime.dashboardReadSessions.stats()
      assert.ok(stats.sessions <= 2); assert.ok(stats.accountedBytes <= 8 * 1024 * 1024)
      if (page.global === undefined || page.cursor === undefined) break
      assert.ok(continuations < 16, 'the original sixteen-continuation bound is unchanged')
      continuations += 1
      page = runtime.readDashboard({ version: 1, action: 'continue', readId: page.readId, cursor: page.cursor })
    }
    if (page.readId !== undefined) runtime.readDashboard({ version: 1, action: 'close', readId: page.readId })
    windows.push(page); await hooks.window?.(page)
    if (page.global === undefined) return { pages, windows, failed: page }
    resume = page.global.next
    if (resume === undefined) return { pages, windows }
  }
  assert.fail('the original eight-window bound must complete or fail closed, never grow')
}

test('Demo v7 automatically generated eight-source personas finish cold L3 and home across six projects', async () => {
  for (const layer of ['L3', 'home']) {
    const f = await automaticEightSourcePersonaFixture(); let runtime, trace
    try {
      runtime = f.open(); trace = observePersonaProgress(runtime, f.expected)
      const limits = runtime.dashboardReadSessions.limits
      assert.equal(limits.perCall.sqlStatements, 64); assert.equal(limits.perSession.sqlStatements, 512)
      assert.equal(limits.perCall.materializedBytes, 1024 * 1024); assert.equal(limits.perCall.keyBytes, 64 * 1024)
      assert.equal(limits.perCall.rowsVisited, 2048); assert.equal(limits.maxContinuations, 16)
      const result = await drivePersonaRpc(runtime, layer)
      assert.equal(result.failed, undefined)
      assert.equal(result.windows.at(-1).global.next, undefined)
      assert.equal(result.windows.reduce((sum, page) => sum + page.global.counts.L3.value, 0), 6)
      assert.ok(result.pages.some((page) => page.cursor !== undefined))
      assert.ok(result.windows.length > 1, 'six projects retain the four-project publication scope')
      assert.ok(trace.readers.some((entry) => entry.bodies.has(f.projectKey) && entry.proved.get(f.projectKey)?.size === 8))
      if (layer === 'L3') {
        const items = result.pages.flatMap((page) => page.global.items)
        assert.equal(items.length, 6)
        assert.deepEqual(new Set(items.map((item) => item.key)), new Set([...f.expected.keys()].map((key) => globalMemoryKey(key, 'persona'))))
        assert.equal(items.find((item) => item.projectKey === f.projectKey).content, f.persona.content)
      }
      assert.equal(f.mock.calls.length, 1, 'cold reads and persona proofs never invoke another provider')
    } finally { closeSceneFixture(f, runtime, trace) }
  }
})

test('Demo v7 persona source and body budget stalls reprove once then fail without payload', async () => {
  for (const mode of ['sources', 'body']) {
    const count = mode === 'sources' ? 100 : 1, f = sceneProgressFixture(count, false)
    const writer = openProjectStore(f.root, 'scene-a')
    const ids = f.records.map((record) => record.id), revisions = Object.fromEntries(f.records.map((record) => [record.id, record.revision]))
    try { writer.setPersona(mode === 'body' ? 'x'.repeat(65_536) : 'Bounded persona source proof.', count, ids, Date.now(), revisions) }
    finally { writer.close() }
    let runtime, trace
    try {
      runtime = f.open(); trace = observePersonaProgress(runtime, new Map([['scene-a', { ids, revisions }]]))
      const result = await drivePersonaRpc(runtime)
      assert.equal(result.windows.length, 2, 'one fresh window is the full retry allowance for the same persona')
      assert.equal(result.windows[0].reason, 'global-total-budget-limit'); assert.ok(result.windows[0].global.next)
      assert.equal(result.failed?.status, 'budget_exhausted')
      assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
      assert.equal(trace.readers.length, 2)
      const first = trace.readers[0].proved.get('scene-a'), fresh = trace.readers[1].proved.get('scene-a')
      assert.ok(first?.size > 0 && fresh?.size > 0)
      assert.ok([...fresh].some((id) => first.has(id)), 'fresh readers redo proofs rather than trusting saved source offsets')
      assert.ok(trace.readers.every((entry) => entry.bodies.size === 0))
      assert.ok(result.pages.every((page) => (page.global?.items.length ?? 0) === 0))
    } finally { closeSceneFixture(f, runtime, trace) }
  }
})

test('Demo v7 incremental persona revision forget and final publication failures expose no payload', async () => {
  for (const mode of ['revision', 'forget', 'publication']) {
    const f = await automaticEightSourcePersonaFixture(false); let runtime, trace, fired = false, pending = false
    try {
      runtime = f.open(); const writer = runtime.storeByKey(f.projectKey, false), id = f.persona.sourceIds[0]
      trace = observePersonaProgress(runtime, f.expected, {
        beforeBody() {
          if (fired || mode === 'publication') return
          fired = true
          if (mode === 'revision') writer.db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(id)
          else writer.forget(id)
        },
        afterBody() { if (mode === 'publication') pending = true },
        beforePublish() {
          if (!pending || fired) return
          fired = true; writer.db.prepare('UPDATE l1_memories SET updated_at = updated_at + 1 WHERE id = ?').run(id)
        },
      })
      const result = await drivePersonaRpc(runtime)
      assert.equal(fired, true, 'the test must reach the real body/publication boundary after eight successful source proofs')
      assert.equal(result.failed?.status, 'stale')
      assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
      assert.ok(result.pages.every((page) => (page.global?.items.length ?? 0) === 0))
      assert.equal(f.mock.calls.length, 1)
    } finally { closeSceneFixture(f, runtime, trace) }
  }
})

test('Demo v7 incremental persona TTL expires between real RPCs without clock replacement', async () => {
  const f = await automaticEightSourcePersonaFixture(false); let runtime, trace, waited = false
  try {
    runtime = f.open(); const writer = runtime.storeByKey(f.projectKey, false), id = f.persona.sourceIds[0], expiry = Date.now() + 3000
    writer.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiry, id)
    trace = observePersonaProgress(runtime, f.expected)
    const result = await drivePersonaRpc(runtime, 'L3', { async page(page) {
      if (waited || page.cursor === undefined || !trace.readers.some((entry) => entry.proved.get(f.projectKey)?.has(id))) return
      assert.ok(Date.now() < expiry, 'the source was proven while its actual TTL was still live')
      waited = true
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, expiry - Date.now() + 1)))
      assert.ok(Date.now() > expiry, 'the real wall clock reached the stored TTL')
    } })
    assert.equal(waited, true)
    assert.equal(result.failed?.status, 'stale')
    assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
    assert.ok(trace.readers.every((entry) => entry.bodies.size === 0))
    assert.equal(f.mock.calls.length, 1)
  } finally { closeSceneFixture(f, runtime, trace) }
})

test('Demo v7 persona continuation cancellation policy changes and bookmark eviction clean up progress', async () => {
  for (const mode of ['close', 'policy']) {
    const f = await automaticEightSourcePersonaFixture(false); let runtime, trace, fired = false
    try {
      runtime = f.open(); trace = observePersonaProgress(runtime, f.expected)
      const result = await drivePersonaRpc(runtime, 'L3', { page(page) {
        if (fired || page.cursor === undefined || !trace.readers.some((entry) => {
          const size = entry.proved.get(f.projectKey)?.size ?? 0; return size > 0 && size < 8
        })) return
        fired = true
        if (mode === 'close') assert.equal(runtime.readDashboard({ version: 1, action: 'close', readId: page.readId }).status, 'ok')
        else runtime.updateSettings({ generateMemory: false })
        assert.equal(runtime.dashboardReadSessions.stats().sessions, 0)
      } })
      assert.equal(fired, true); assert.equal(result.failed?.status, 'stale')
      assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
    } finally { closeSceneFixture(f, runtime, trace) }
  }
  const f = sceneProgressFixture(100, false), writer = openProjectStore(f.root, 'scene-a')
  const ids = f.records.map((record) => record.id), revisions = Object.fromEntries(f.records.map((record) => [record.id, record.revision]))
  try { writer.setPersona('Evicted persona progress.', 100, ids, Date.now(), revisions) } finally { writer.close() }
  let runtime, trace, evicted = false
  try {
    runtime = f.open(); trace = observePersonaProgress(runtime, new Map([['scene-a', { ids, revisions }]]))
    const result = await drivePersonaRpc(runtime, 'L3', { window(page) {
      if (evicted || page.global?.next === undefined) return
      const manager = runtime.dashboardReadSessions, before = manager.stats().accountedBytes
      manager.dropGlobalProgress(page.global.next); evicted = true
      assert.ok(manager.stats().accountedBytes < before, 'eviction releases the charged bookmark lease')
    } })
    assert.equal(evicted, true); assert.equal(result.failed?.status, 'stale')
    assert.equal(result.failed.global, undefined); assert.equal(trace.readers.length, 1)
  } finally { closeSceneFixture(f, runtime, trace) }
})
