import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, renameSync, opendirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
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
    runtime = new MemoryRuntime(mock.ctx, resolveConfig({ mode: 'review', extraction: { provider: 'mock', model: 'mock-model', minTurnChars: 0, everyNConversations: 1 }, budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
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
    runtime = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock-model', minTurnChars: 0, everyNConversations: 1 }, budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
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
    for (let window = 0; window < 128; window += 1) {
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

    const recalled = runtime.globalRecall('preference 4', { id: 'first-real-session', header: { agentPreset: 'agent-mock' } })
    assert.match(recalled, /preference 4/, 'the first pre-step must reach the fifth source without another session or repeated question')
    assert.ok(!sources.keys.includes('source-symlink'))
  } finally { f.close(); outside.close() }
})

// Observe real windows and proof ledgers; hooks only inject the boundary under test.
function observeRecall(runtime, hooks = {}) {
  const read = runtime.readDashboard, open = runtime.beginDashboardAggregateRead, prove = runtime.proveGlobalRecall
  const member = runtime.openDashboardDirectoryMember, manager = runtime.dashboardReadSessions
  const retain = manager.retainGlobalProgress, tokenMethods = new Map()
  const trace = { windows: 0, reads: [], outcomes: [], emitted: new Set(), proofs: [], counters: [], codecs: [],
    readers: [], tokens: new Set(), bookmarks: [], connections: new Map() }
  // These fixtures start before their first dashboard read, so every retired token is observable.
  assert.deepEqual(manager.stats(), { sessions: 0, activeCalls: 0, accountedBytes: 0, closed: false })
  for (const name of ['begin', 'continue', 'finish']) {
    const original = manager[name]; tokenMethods.set(name, original)
    manager[name] = function (...args) {
      const result = Reflect.apply(original, this, args)
      if (result.status === 'ok') for (const key of ['callToken', 'continuationToken']) {
        if (result.value[key] !== undefined) trace.tokens.add(result.value[key])
      }
      return result
    }
  }
  manager.retainGlobalProgress = function (callToken, dispose, keep) {
    const entry = { token: undefined, disposals: 0, completed: 0 }
    const result = Reflect.apply(retain, this, [callToken, () => {
      entry.disposals += 1
      const output = dispose()
      entry.completed += 1
      return output
    }, keep])
    if (result.status === 'ok') { entry.token = result.value; trace.bookmarks.push(entry) }
    return result
  }
  runtime.openDashboardDirectoryMember = function (...args) {
    const result = Reflect.apply(member, this, args)
    if (result.status === 'ok') {
      const store = result.value.store
      // Runtime-owned writer connections intentionally outlive a read. Track actual read-only closes.
      if (runtime.stores.get(args[0]) !== store && !trace.connections.has(store)) {
        const entry = { close: store.close, calls: 0, completed: 0 }
        trace.connections.set(store, entry)
        store.close = function (...closeArgs) {
          entry.calls += 1
          const output = Reflect.apply(entry.close, this, closeArgs)
          entry.completed += 1
          return output
        }
      }
    }
    return result
  }
  let proofDepth = 0
  runtime.proveGlobalRecall = function (...args) {
    proofDepth += 1
    try { return Reflect.apply(prove, this, args) } finally { proofDepth -= 1 }
  }
  runtime.readDashboard = function (input) {
    if (input.action === 'global') trace.windows += 1
    const output = Reflect.apply(read, this, [input])
    trace.outcomes.push(output.status)
    trace.reads.push(input.action)
    trace.codecs.push(ReadDashboardResultSchema.safeParse(output).success)
    for (const item of output.global?.items ?? []) trace.emitted.add(item.key)
    hooks.page?.(output, input, trace)
    return output
  }
  runtime.beginDashboardAggregateRead = function (...args) {
    const proof = proofDepth > 0
    if (proof) hooks.beforeProofOpen?.(trace)
    const opened = Reflect.apply(open, this, args)
    if (opened.status !== 'ok') return opened
    const reader = opened.value, publish = reader.publishProof
    trace.readers.push(reader)
    if (proof) {
      const entry = { reader, initialKeys: [...args[0].projectKeys], keys: [], resolved: [], heads: [] }
      const select = reader.selectGlobalSource, resolve = reader.resolveRoot, head = reader.proveManagedPersonaSource
      trace.proofs.push(entry)
      reader.selectGlobalSource = function (key) {
        const result = Reflect.apply(select, this, [key])
        entry.keys = [...this.globalPublicationSources()]
        return result
      }
      reader.proveManagedPersonaSource = function (key, id, revision) {
        const result = Reflect.apply(head, this, [key, id, revision])
        entry.heads.push({ key, id, status: result.status, state: result.value })
        return result
      }
      reader.resolveRoot = function (key, id, ...rest) {
        const result = Reflect.apply(resolve, this, [key, id, ...rest])
        entry.resolved.push({ key, id, status: result.status, state: result.value?.state })
        return result
      }
    }
    reader.publishProof = function (...proofArgs) {
      const result = Reflect.apply(publish, this, proofArgs)
      if (result.status === 'ok') trace.counters.push(manager.counters(reader.callToken))
      return result
    }
    return opened
  }
  return { trace, restore() {
    runtime.readDashboard = read; runtime.beginDashboardAggregateRead = open; runtime.proveGlobalRecall = prove
    runtime.openDashboardDirectoryMember = member; manager.retainGlobalProgress = retain
    for (const [name, original] of tokenMethods) manager[name] = original
    for (const [store, entry] of trace.connections) store.close = entry.close
  } }
}

function assertRecallReleased(runtime, trace) {
  assert.ok(trace.codecs.every(Boolean), 'all real RPC responses retain their strict codec')
  assert.ok(trace.windows + trace.proofs.length <= 8, 'scan and final-proof windows share a finite total')
  for (const proof of trace.proofs) {
    assert.deepEqual(proof.initialKeys, [], 'proof bootstrap completes its control probe before any source is admitted')
    assert.ok(proof.keys.length <= 4, 'actual selected sources preserve the physical binding limit')
    for (const item of [...proof.heads, ...proof.resolved]) assert.ok(proof.keys.includes(item.key), 'body/head reads only use admitted sources')
  }
  for (const counters of trace.counters) {
    assert.equal(counters.status, 'ok')
    for (const [kind, limit] of [['call', runtime.dashboardReadSessions.limits.perCall], ['session', runtime.dashboardReadSessions.limits.perSession]]) {
      for (const field of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes', 'projects']) {
        assert.ok(counters.value[kind][field] <= limit[field], `${kind}/${field} remains inside its original ledger`)
      }
    }
  }
  const manager = runtime.dashboardReadSessions
  for (const entry of trace.bookmarks) {
    assert.equal(entry.disposals, 1, 'each real progress lease invokes its disposal exactly once')
    assert.equal(entry.completed, 1, 'the real bookmark cleanup completed')
    assert.equal(manager.inspectGlobalProgress(entry.token), false, 'released bookmarks cannot be replayed')
  }
  for (const reader of trace.readers) {
    assert.equal(reader.ended, true)
    assert.equal(reader.globalHandles.size, 0, 'all selected source handles were released')
  }
  for (const entry of trace.connections.values()) {
    assert.equal(entry.calls, 1, 'each opened read-only connection was closed once')
    assert.equal(entry.completed, 1, 'the actual connection close completed')
  }
  assert.equal(runtime.globalReader.states.size, 0)
  assert.equal(runtime.globalReader.progress.size, 0, 'no directory progress survives outside the retired-token ledger')
  assert.equal(runtime.dashboardReadOnlyStores.size, 0)
  assert.equal(runtime.dashboardVisibilityReaders.size, 0)
  // All issued call/continuation tokens are now retired. The manager keeps at most 256
  // replay tombstones of 64 bytes each; progress leases and live work must contribute zero.
  const expected = { sessions: 0, activeCalls: 0, accountedBytes: Math.min(trace.tokens.size, 256) * 64, closed: false }
  assert.deepEqual(manager.stats(), expected, 'remaining accounting is exactly the observed bounded tombstones')
  for (const token of trace.tokens) assert.notEqual(manager.inspectContinuation(token).status, 'ok', 'retired tokens cannot resume a read')
  assert.deepEqual(manager.stats(), expected, 'replay checks do not allocate or erase accounting')
}

const recallSession = { id: 'first-pre-step', header: { agentPreset: 'agent-mock' } }

test('Demo v7 one pre-step traverses unmatched windows without retaining progress for another session', (t) => {
  const f = fixture(); let observed
  // Count/continuation behavior is independent of CI disk speed; the first-call regression above uses the real clock.
  t.mock.method(performance, 'now', () => 0)
  try {
    for (let n = 0; n < 5; n += 1) seed(f.root, `source-${n}`, n === 4 ? 'quartzneedle preferred workflow' : `unrelated archive ${n}`)
    const runtime = f.open(); observed = observeRecall(runtime)
    for (const header of [{ agentPreset: 'agent-mock' }, { cwd: '/synthetic/source-0', agentPreset: 'agent-mock' }]) {
      const start = observed.trace.windows
      assert.match(runtime.globalRecall('quartzneedle', { id: 'fresh-reader', header }), /quartzneedle/)
      assert.ok(observed.trace.windows - start > 1, 'empty matching windows still make physical scan progress')
      assert.equal(runtime.globalReader.progress.size, 0, 'no next-query cursor or directory lease is retained')
      // Each independent pre-step has its own eight-window limit.
      assertRecallReleased(runtime, { ...observed.trace, windows: observed.trace.windows - start, proofs: observed.trace.proofs.slice(-1) })
    }
  } finally { observed?.restore(); f.close() }
})

test('Demo v7 pre-step caps total windows and candidate work while retaining partial truth', (t) => {
  t.mock.method(performance, 'now', () => 0)
  for (const mode of ['many-sources', 'many-records']) {
    const f = fixture(); let observed
    try {
      for (let n = 0; n < (mode === 'many-sources' ? 32 : 80); n += 1) {
        seed(f.root, mode === 'many-sources' ? `source-${String(n).padStart(2, '0')}` : 'source-a', `pnpm preference ${n}`, { sourceEventId: `bounded-${n}` })
      }
      const runtime = f.open({ recall: { maxTokens: 2000, maxResults: 5 } }); observed = observeRecall(runtime)
      const packet = runtime.globalRecall('pnpm', recallSession)
      assert.match(packet, /全局记忆（已读取部分）/)
      assert.ok((packet.match(/^- \[/gm) ?? []).length <= 5, 'the existing output cap is unchanged')
      assert.ok(observed.trace.windows > 1)
      if (mode === 'many-records') {
        assert.ok(observed.trace.emitted.size >= 50, 'the real scan reaches candidate capacity')
        assert.ok(observed.trace.emitted.size < 80, 'capacity stops further scans before reading the full fixture')
      }
      assertRecallReleased(runtime, observed.trace)
    } finally { observed?.restore(); f.close() }
  }
})

test('Demo v7 recall beyond 250ms still proves current bodies and rejects revoked forgotten or revised sources', () => {
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  for (const mode of ['visible', 'revoked', 'forgotten', 'revised']) {
    const f = fixture(); let observed
    try {
      const record = seed(f.root, 'source-a', 'pnpm slow recall preference')
      const runtime = f.open(); observed = observeRecall(runtime)
      const prove = runtime.proveGlobalRecall
      let delayed = false
      runtime.proveGlobalRecall = function (...args) {
        delayed = true
        Atomics.wait(waiter, 0, 0, 300) // Real elapsed time, after scan readers close and before fresh proofs.
        if (mode === 'revoked') runtime.control.revokeSourceEvent('source-a', 'event-source-a', record.sourceMessageIds[0])
        else if (mode === 'forgotten') runtime.storeByKey('source-a', false).forget(record.id)
        else if (mode === 'revised') runtime.storeByKey('source-a', false).db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(record.id)
        return Reflect.apply(prove, this, args)
      }
      const started = performance.now(), packet = runtime.globalRecall('pnpm', recallSession)
      assert.equal(delayed, true); assert.ok(performance.now() - started >= 250)
      if (mode === 'visible') {
        assert.match(packet, /pnpm slow recall preference/)
        assert.ok(observed.trace.proofs.some((proof) => proof.heads.some((item) => item.state === 'visible')))
        assert.ok(observed.trace.proofs.some((proof) => proof.resolved.some((item) => item.state === 'visible')))
      } else assert.equal(packet, undefined, 'elapsed-time removal cannot bypass current source/head/body proof')
      assertRecallReleased(runtime, observed.trace)
    } finally { observed?.restore(); f.close() }
  }
})

test('Demo v7 pre-step stops repeated nonprogress and stale scan bookmarks', (t) => {
  t.mock.method(performance, 'now', () => 0)
  for (const mode of ['repeated', 'duplicate-only', 'stale', 'rpc-repeated']) {
    const f = fixture(); let observed
    try {
      for (let n = 0; n < 12; n += 1) seed(f.root, `source-${String(n).padStart(2, '0')}`, `pnpm cursor boundary ${n}`)
      const runtime = f.open({ recall: { maxTokens: 2000 } }); let rpcCursor
      observed = observeRecall(runtime, { page(output) {
        if (mode !== 'rpc-repeated' || output.cursor === undefined) return
        if (rpcCursor === undefined) rpcCursor = output.cursor
        else output.cursor = rpcCursor
      } })
      const search = runtime.searchGlobalWindow; let calls = 0, first
      runtime.searchGlobalWindow = function (...args) {
        calls += 1
        if (mode === 'repeated' && calls === 2) return first
        const result = Reflect.apply(search, this, args)
        if (calls === 1) {
          first = result
          if (mode !== 'rpc-repeated') assert.ok(result.nextScan, 'the fixture reaches a real scan bookmark')
          if (mode === 'stale') runtime.dashboardReadSessions.dropGlobalProgress(result.nextScan)
        } else if (mode === 'duplicate-only') return { ...result, candidates: first.candidates }
        return result
      }
      const packet = runtime.globalRecall('pnpm', recallSession)
      assert.equal(calls, mode === 'rpc-repeated' ? 1 : 2, 'one pre-step stops at the first stale or nonprogress result')
      if (mode === 'rpc-repeated') assert.equal(observed.trace.reads.filter((action) => action === 'continue').length, 1)
      if (mode === 'stale') assert.equal(packet, undefined)
      else assert.match(packet, /已读取部分/)
      assertRecallReleased(runtime, observed.trace)
    } finally { observed?.restore(); f.close() }
  }
})

test('Demo v7 pre-step rechecks earlier-window forget revocation revision and expiry', (t) => {
  t.mock.method(performance, 'now', () => 0)
  for (const mode of ['forget', 'revoke', 'revision', 'expiry']) {
    const f = fixture(), records = new Map(); let observed, target
    try {
      for (let n = 0; n < 5; n += 1) records.set(`source-${n}`, seed(f.root, `source-${n}`, `pnpm earlier-window ${n}`))
      const runtime = f.open({ recall: { maxTokens: 2000, maxResults: 5 } })
      observed = observeRecall(runtime, { page(output, input, trace) {
        if (target || !output.global?.next) return
        target = parseGlobalMemoryKey([...trace.emitted][0])
        const record = records.get(target.projectKey), writer = runtime.storeByKey(target.projectKey, false)
        if (mode === 'forget') writer.forget(target.id)
        else if (mode === 'revoke') runtime.control.revokeSourceEvent(target.projectKey, `event-${target.projectKey}`, record.sourceMessageIds[0])
        else if (mode === 'revision') writer.db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(target.id)
        else writer.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(Date.now() - 1, target.id)
      } })
      const packet = runtime.globalRecall('pnpm', recallSession)
      assert.ok(target, 'the mutation happens after a real earlier publication window')
      assert.ok(observed.trace.windows > 1, 'the same call continues after the mutation')
      assert.ok(observed.trace.outcomes.includes('stale') || observed.trace.proofs.some((entry) => [...entry.heads, ...entry.resolved].some((item) => item.key === target.projectKey && item.id === target.id && item.status === 'ok' && item.state !== 'visible')),
        'the old candidate is rejected by the snapshot fence or the fresh exact-ID proof')
      assert.ok(!(packet ?? '').includes(globalMemoryKey(target.projectKey, target.id)))
      if (packet !== undefined) assert.match(packet, /已读取部分/)
      assertRecallReleased(runtime, observed.trace)
    } finally { observed?.restore(); f.close() }
  }
})

test('Demo v7 pre-step final proof fences earlier proof windows after later selected reads', (t) => {
  t.mock.method(performance, 'now', () => 0)
  for (const mode of ['revoke', 'version', 'expiry', 'file-replacement', 'symlink']) {
    const f = fixture(); let observed, fired = false, earlierResolved = false
    try {
      const records = new Map()
      for (let n = 0; n < 5; n += 1) records.set(`source-${n}`, seed(f.root, `source-${n}`, `pnpm final-window ${n}`))
      const runtime = f.open({ recall: { maxTokens: 2000, maxResults: 5 } })
      const expiry = Date.now() + 600_000
      if (mode === 'expiry') for (const [key, record] of records) runtime.storeByKey(key, false).db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiry, record.id)
      observed = observeRecall(runtime, { beforeProofOpen(trace) {
        if (fired || trace.proofs.length !== 1) return
        const first = trace.proofs[0], item = first.resolved.find((candidate) => candidate.state === 'visible')
        earlierResolved = item !== undefined
        if (!item) return
        fired = true
        if (mode === 'expiry') first.reader.wallNow = () => expiry + 1
        else if (mode === 'revoke') runtime.control.revokeSourceEvent(item.key, `event-${item.key}`, records.get(item.key).sourceMessageIds[0])
        else if (mode === 'version') runtime.storeByKey(item.key, false).db.prepare('UPDATE l1_memories SET confidence = ? WHERE id = ?').run(.73, item.id)
        else {
          const file = path.join(f.root, 'projects', item.key, 'memory.db'), detached = file + '.detached'
          renameSync(file, detached)
          if (mode === 'symlink') symlinkSync(path.basename(detached), file)
          else writeFileSync(file, 'synthetic replacement database identity')
        }
      } })
      assert.equal(runtime.globalRecall('pnpm', recallSession), undefined, 'no previously packed body survives a failed final proof')
      assert.equal(fired, true); assert.equal(earlierResolved, true)
      assert.equal(observed.trace.proofs.length, 2, 'five selected physical sources exercise both final proof windows')
      assertRecallReleased(runtime, observed.trace)
    } finally { observed?.restore(); f.close() }
  }
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
    // Set A's TTL before the aggregate snapshot starts. Mutating it in the first
    // selectSource hook would now correctly trip the stronger file-version fence.
    if (mode === 'root-expiry' || mode === 'dependency-expiry') {
      const directory = opendirSync(path.join(f.root, 'projects'))
      const firstKey = directory.readSync().name; directory.closeSync()
      const target = mode === 'root-expiry' ? roots.get(firstKey) : dependencies.get(firstKey)
      writers.get(firstKey).db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(expiryAt, target.id)
    }
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

test('Demo v7 automatic L3 respects explicit disabled gates and excluded agents', async () => {
  for (const patch of [{ generateMemory: false }, { capture: { enabled: false } }, { extraction: { enabled: false } },
    { capture: { excludeAgents: ['agent-mock'] } }]) {
    const f = fixture(), session = { id: 'guarded', header: { agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
    const mock = scriptedContext({ session, script: [] })
    const runtime = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock-model', minTurnChars: 0, everyNConversations: 1, ...patch.extraction },
      budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100, ...patch.budget }, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'extraction' && key !== 'budget')) }), f.root)
    try {
      runtime.onSessionEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'guarded', role: 'user', content: [{ type: 'text', text: '请始终使用 pnpm 管理我的项目。' }] } })
      endTurnAfterQuietWindow(runtime, session); await runtime.runExtraction(session.id)
      assert.equal((await read(runtime, 'L3')).global.items.length, 0)
      assert.equal(mock.calls.length, 0)
    } finally { runtime.close(); f.close() }
  }
})

test('Demo v7 effective switches honor explicit disables and ignore legacy zero quotas after restart', async () => {
  const f = fixture(), config = { capture: { enabled: false }, extraction: { enabled: false }, recall: { enabled: false }, budget: { automaticDailyTokens: 0 } }
  try {
    let runtime = f.open(config)
    const initial = await read(runtime)
    assert.equal(initial.global.generateMemory, false); assert.equal(initial.global.useMemory, false)
    runtime.updateSettings({ generateMemory: true, useMemory: true }); runtime.close(); runtime = f.open(config)
    const enabled = await read(runtime)
    assert.equal(enabled.global.generateMemory, true); assert.equal(enabled.global.useMemory, true); assert.equal(enabled.global.paused, false)
    assert.equal('budget' in runtime.config, false)
    assert.equal('automaticBudget' in enabled.global, false)
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
  const runtime = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock-model', minTurnChars: 0, everyNConversations: 1 }, budget: { automaticDailyTokens: 1000000, automaticDailyTasks: 100 } }), f.root)
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
  for (let window = 0; window < 128; window += 1) {
    let page = runtime.readDashboard({ ...request(layer), ...(resume === undefined ? {} : { resume }) })
    if (resume) assert.equal(runtime.readDashboard({ version: 1, action: 'close', readId: resume }).status, 'ok')
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
      assert.equal(result.windows.at(-1).global.counts.L2.value, 6, 'final cumulative count covers every window')
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

test('Demo v7 a 100-member scene is completely verified alongside the home and smaller scenes', () => {
  const f = sceneProgressFixture(100, false); let runtime
  try {
    seed(f.root, 'scene-a', 'Small independently verified preference.', { scene: 'small-scene', sourceEventId: 'small-home-scene' })
    runtime = f.open()
    const result = driveSceneRpc(runtime, 'home')
    assert.equal(result.failed, undefined, 'an oversized derived proof must not discard the usable home')
    const last = result.windows.at(-1)
    assert.equal(last.status, 'ok')
    assert.equal(last.complete, true)
    assert.equal(last.global.next, undefined, 'the reader must finish without an endless retry bookmark')
    assert.equal(last.global.counts.L0.value, 101)
    assert.equal(last.global.counts.L1.value, 101)
    assert.equal(last.global.counts.L2.value, 2, 'both scenes are fully verified')
    assert.equal(last.global.counts.L2.relation, 'exact')
    assert.ok(last.global.items.length > 0, 'verified recent memories remain usable')
  } finally { f.close() }
})

test('Demo v7 unfinished scene bookmarks complete more than 100 members without redoing proofs', () => {
  const f = sceneProgressFixture(250, false); let runtime, trace
  try {
    runtime = f.open(); trace = observeSceneProgress(runtime, f.records)
    const result = driveSceneRpc(runtime, 'L2')
    assert.ok(result.windows.length > 1, 'the proof spans real bounded work windows')
    assert.equal(result.windows[0].reason, 'global-total-budget-limit')
    assert.ok(result.windows[0].global.next)
    assert.equal(result.failed, undefined)
    const last = result.windows.at(-1)
    assert.equal(last.status, 'ok'); assert.equal(last.complete, true)
    assert.deepEqual(last.global.counts.L2, { value: 1, relation: 'exact' })
    assert.equal(last.global.next, undefined)
    assert.equal(trace.readers.filter(entry => entry.successes.size > 0).length, 1, 'same native connections fence all proof batches')
    assert.equal(trace.readers[0].successes.size, 250)
    assert.equal(trace.readers[0].finalVisible, 1)
    assert.equal(result.pages.flatMap(page => page.global?.items ?? []).length, 1)
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
  const generator = new MemoryRuntime(mock.ctx, resolveConfig({ extraction: { provider: 'mock', model: 'mock-model', minTurnChars: 0, everyNConversations: 1, maxMemoriesPerPass: 8 },
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
  for (let window = 0; window < 128; window += 1) {
    let page = runtime.readDashboard({ ...request(layer), ...(resume === undefined ? {} : { resume }) }), continuations = 0
    if (resume) assert.equal(runtime.readDashboard({ version: 1, action: 'close', readId: resume }).status, 'ok')
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
  assert.fail('the bounded test driver must complete or fail closed')
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
      assert.equal(result.windows.at(-1).global.counts.L3.value, 6, 'final cumulative count covers every window')
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

test('Demo v7 large persona source indexes and bodies complete without skipping or repeated proofs', async () => {
  for (const mode of ['sources', 'body']) {
    const count = mode === 'sources' ? 250 : 1, f = sceneProgressFixture(count, false)
    const writer = openProjectStore(f.root, 'scene-a')
    const ids = f.records.map((record) => record.id), revisions = Object.fromEntries(f.records.map((record) => [record.id, record.revision]))
    try { writer.setPersona(mode === 'body' ? 'x'.repeat(65_536) : 'Bounded persona source proof.', count, ids, Date.now(), revisions) }
    finally { writer.close() }
    let runtime, trace
    try {
      runtime = f.open(); trace = observePersonaProgress(runtime, new Map([['scene-a', { ids, revisions }]]))
      const result = await drivePersonaRpc(runtime)
      assert.equal(result.failed, undefined)
      const last = result.windows.at(-1)
      assert.equal(last.status, 'ok'); assert.equal(last.complete, true)
      assert.deepEqual(last.global.counts.L3, { value: 1, relation: 'exact' })
      assert.equal(last.global.next, undefined)
      assert.equal(trace.readers.filter(entry => entry.proved.get('scene-a')?.size > 0).length, 1)
      assert.equal(trace.readers[0].proved.get('scene-a').size, count)
      assert.equal(trace.readers[0].bodies.size, 1)
      const items = result.pages.flatMap(page => page.global?.items ?? [])
      assert.equal(items.length, 1)
      assert.equal(items[0].content, mode === 'body' ? 'x'.repeat(65_536) : 'Bounded persona source proof.')
      if (mode === 'sources') assert.ok(result.windows.length > 1)
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
      // Timers may wake at the millisecond boundary; wait for the condition.
      while (Date.now() <= expiry) await new Promise((resolve) => setTimeout(resolve, Math.max(5, expiry - Date.now() + 2)))
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

// Exercise the public filtered L1 traversal, including all empty pages and explicit windows.
function filteredL1Fixture() {
  const f = fixture('v7-filtered-tail-'), records = [], tails = new Set()
  for (let project = 0; project < 6; project += 1) for (let row = 0; row < 12; row += 1) {
    const key = `filtered-${project}`, id = `row-${String(row).padStart(2, '0')}`
    const content = `${row === 11 ? 'quartzneedle' : 'unrelated archive'} source ${project} record ${row}`
    const record = seed(f.root, key, content, { fixedId: id, sourceEventId: `event-${project}-${row}` })
    records.push({ ...record, projectKey: key })
    if (row === 11) tails.add(globalMemoryKey(key, id))
  }
  return { ...f, records, tails }
}

function observeFilteredL1(runtime, beforePublish) {
  const observed = observeRecall(runtime), open = runtime.beginDashboardAggregateRead, visited = new Set()
  let handoffs = 0, pending
  runtime.beginDashboardAggregateRead = function (...args) {
    const opened = Reflect.apply(open, this, args)
    if (opened.status !== 'ok') return opened
    const reader = opened.value, managed = reader.readManagedPage, suspend = reader.suspendForRpc, publish = reader.publishProof
    reader.readManagedPage = function (key, ...rest) {
      const output = Reflect.apply(managed, this, [key, ...rest])
      if (output.status === 'ok') for (const item of output.value.items) {
        assert.ok(reader.globalPublicationSources().includes(key), 'every filtered row retains its admitted physical source')
        visited.add(globalMemoryKey(key, item.id))
        if (item.record?.content.includes('quartzneedle')) pending = { key, record: item.record }
      }
      return output
    }
    reader.publishProof = function (...proofArgs) {
      beforePublish?.(pending); pending = undefined
      return Reflect.apply(publish, this, proofArgs)
    }
    reader.suspendForRpc = function (...suspendArgs) {
      const work = reader.remainingWork(), tail = reader.finalBoundaryCost()
      const output = Reflect.apply(suspend, this, suspendArgs)
      if (output.status === 'ok') {
        handoffs += 1
        for (const field of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes']) {
          assert.ok(work.session[field] - tail[field] >= runtime.dashboardReadSessions.limits.perCall[field],
            `a real ${field} handoff leaves a complete next-call allowance, including resume probes`)
        }
      }
      return output
    }
    return opened
  }
  return { ...observed, visited, handoffs: () => handoffs, restore() {
    runtime.beginDashboardAggregateRead = open; observed.restore()
  } }
}

function driveFilteredL1(runtime, query) {
  const pages = [], windows = []
  let resume
  for (let window = 0; window < 128; window += 1) {
    let page = runtime.readDashboard({ ...request('L1', query), ...(resume === undefined ? {} : { resume }) })
    let continuations = 0
    try {
      for (;;) {
        assert.equal(ReadDashboardResultSchema.safeParse(page).success, true)
        pages.push(page)
        if (page.global === undefined || page.cursor === undefined) break
        assert.ok(continuations < 16, 'filtered pages retain the existing continuation bound')
        continuations += 1
        page = runtime.readDashboard({ version: 1, action: 'continue', readId: page.readId, cursor: page.cursor })
      }
    } finally {
      if (page.readId !== undefined) assert.equal(runtime.readDashboard({ version: 1, action: 'close', readId: page.readId }).status, 'ok')
    }
    windows.push(page)
    if (page.global === undefined) return { pages, windows, failed: page }
    resume = page.global.next
    if (resume === undefined) return { pages, windows }
  }
  assert.fail('filtered traversal must finish within the bounded fixture windows')
}

test('Demo v7 filtered L1 no-hit and late-hit queries traverse six sources without losing window progress', () => {
  for (const query of ['absentneedle', 'quartzneedle']) {
    const f = filteredL1Fixture(); let runtime, observed
    try {
      runtime = f.open({ generateMemory: false }); observed = observeFilteredL1(runtime)
      const limits = runtime.dashboardReadSessions.limits
      assert.equal(limits.perCall.sqlStatements, 64); assert.equal(limits.perSession.sqlStatements, 512)
      assert.equal(limits.perCall.materializedBytes, 1024 * 1024); assert.equal(limits.perSession.materializedBytes, 8 * 1024 * 1024)
      const result = driveFilteredL1(runtime, query)
      assert.equal(result.failed, undefined, 'empty filtered pages must not conceal a failed native read')
      assert.ok(result.windows.length > 1); assert.ok(observed.handoffs() > 0)
      assert.ok(result.windows.some((page) => page.reason === 'global-total-budget-limit'), 'the fixture reaches a real session-work boundary')
      assert.equal(result.windows.at(-1).global.next, undefined)
      assert.deepEqual(observed.visited, new Set(f.records.map((record) => globalMemoryKey(record.projectKey, record.id))), 'even a no-hit query proves the entire physical keyset')
      const items = result.pages.flatMap((page) => page.global.items), keys = items.map((item) => item.key)
      assert.equal(new Set(keys).size, keys.length, 'cross-window results have no duplicates')
      assert.deepEqual(new Set(keys), query === 'quartzneedle' ? f.tails : new Set())
      assert.ok(result.pages.every((page) => page.global.generateMemory === false), 'generation OFF does not truncate browsing')
      assert.equal(result.windows.at(-1).complete, true, 'an unchanged, fully traversed snapshot has an exact cumulative count')
      assert.equal(result.windows.at(-1).global.counts.L1.relation, 'exact')
      for (const entry of observed.trace.counters) for (const kind of ['call', 'session']) {
        assert.equal(entry.status, 'ok')
        const bound = kind === 'call' ? limits.perCall : limits.perSession
        for (const field of ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes', 'projects']) assert.ok(entry.value[kind][field] <= bound[field])
      }
      for (const reader of observed.trace.readers) { assert.equal(reader.ended, true); assert.equal(reader.globalHandles.size, 0) }
      for (const entry of observed.trace.connections.values()) { assert.equal(entry.calls, 1); assert.equal(entry.completed, 1) }
      assert.equal(runtime.globalReader.states.size, 0); assert.equal(runtime.dashboardReadOnlyStores.size, 0)
    } finally { closeSceneFixture(f, runtime, observed) }
  }
})

test('Demo v7 filtered L1 late-hit publication rejects a changed source without returning payload or progress', () => {
  const f = filteredL1Fixture(); let runtime, observed, fired = false
  try {
    runtime = f.open({ generateMemory: false })
    observed = observeFilteredL1(runtime, (pending) => {
      if (fired || pending === undefined) return
      fired = true
      const writer = openProjectStore(f.root, pending.key)
      try { writer.db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(pending.record.id) }
      finally { writer.close() }
    })
    const result = driveFilteredL1(runtime, 'quartzneedle')
    assert.equal(fired, true, 'the real late body must be reached before invalidating its publication')
    assert.equal(result.failed?.status, 'stale')
    assert.equal(result.failed.global, undefined); assert.equal(result.failed.cursor, undefined)
    assert.ok(result.pages.slice(0, -1).every((page) => page.global.items.length === 0), 'no earlier filtered page publishes the pending late body')
    for (const reader of observed.trace.readers) { assert.equal(reader.ended, true); assert.equal(reader.globalHandles.size, 0) }
  } finally { closeSceneFixture(f, runtime, observed) }
})

test('Demo v7 global L3 verifies every source across more than four projects and 100 sources', async () => {
  const f = fixture('v7-global-persona-batches-'), sources = []
  let runtime
  try {
    for (let project = 0; project < 6; project++) {
      const key = `global-persona-${project}`, store = openProjectStore(f.root, key)
      try {
        for (let i = 0; i < 25; i++) {
          const source = store.captureMessage({ sessionId: key, role: 'user', content: `Global persona input ${project}/${i}`,
            sourceKind: 'conversation', sourceEventId: `global-${project}-${i}`, agentPreset: 'agent-mock' })
          const record = store.addMemory({ content: `Global persona preference ${project}/${i}`, status: 'approved',
            kind: 'preference', sourceMessageIds: [source.id], sourceVerified: true }).record
          sources.push({ projectKey: key, id: record.id, revision: record.revision })
        }
      } finally { store.close() }
    }
    mkdirSync(path.join(f.root, 'global'), { recursive: true })
    writeFileSync(path.join(f.root, 'global/persona.json'), JSON.stringify({ content: 'Stable global persona backed by all 150 sources.',
      sourceCount: sources.length, sources, updatedAt: Date.now(), stale: false }))
    runtime = f.open()
    const result = await drivePersonaRpc(runtime)
    assert.equal(result.failed, undefined)
    const last = result.windows.at(-1)
    assert.equal(last.complete, true)
    assert.deepEqual(last.global.counts.L3, { value: 1, relation: 'exact' })
    const items = result.pages.flatMap(page => page.global?.items ?? [])
    assert.equal(items.length, 1); assert.equal(items[0].sources.length, 150)
    assert.equal(runtime.globalReader.progress.size, 0)
  } finally { f.close() }
})

test('Demo v7 retained derived batches reject source changes and release on cancel and expiry', async () => {
  for (const layer of ['L2', 'L3']) for (const mode of ['revision', 'revoke', 'expiry', 'cancel']) {
    const f = sceneProgressFixture(100, false)
    let runtime, fired = false
    try {
      runtime = f.open()
      const writer = runtime.storeByKey('scene-a', false), first = f.records[0]
      if (layer === 'L3') writer.setPersona('Batch persona.', 100, f.records.map(r => r.id), Date.now(),
        Object.fromEntries(f.records.map(r => [r.id, r.revision])))
      const expiry = Date.now() + 60_000
      if (mode === 'expiry') writer.db.prepare('UPDATE l1_memories SET expiry_at = ?').run(expiry)
      const open = runtime.beginDashboardAggregateRead
      runtime.beginDashboardAggregateRead = function (...args) {
        const opened = Reflect.apply(open, this, args)
        if (opened.status === 'ok' && mode === 'expiry') {
          const originalNow = opened.value.wallNow
          opened.value.wallNow = () => fired ? expiry + 1 : originalNow()
        }
        return opened
      }
      const result = await drivePersonaRpc(runtime, layer, { window(page) {
        if (fired || !page.global?.next) return
        const saved = runtime.globalReader.progress.get(page.global.next)
        if (!saved?.active) return
        fired = true
        if (mode === 'revision') writer.db.prepare('UPDATE l1_memories SET revision = revision + 1 WHERE id = ?').run(first.id)
        else if (mode === 'revoke') runtime.control.revokeSourceEvent('scene-a', 'scene-progress-0', first.sourceMessageIds[0])
        else if (mode === 'cancel') runtime.readDashboard({ version: 1, action: 'close', readId: page.global.next })
      } })
      assert.equal(fired, true, `${layer}/${mode} reached a real retained proof batch`)
      assert.equal(result.failed?.status, 'stale')
      assert.equal(result.failed.global, undefined)
      assert.equal(runtime.dashboardReadSessions.stats().sessions, 0)
      assert.equal(runtime.globalReader.progress.size, 0)
      assert.ok(result.pages.every(page => (page.global?.items.length ?? 0) === 0))
    } finally { f.close() }
  }
})

test('Demo v7 a thousand-member scene completes with bounded proof residency', () => {
  const f = sceneProgressFixture(1000, false)
  let runtime, peak = 0
  try {
    runtime = f.open()
    const result = driveSceneRpc(runtime, 'L2', () => {
      peak = Math.max(peak, runtime.dashboardReadSessions.stats().accountedBytes)
    })
    assert.equal(result.failed, undefined)
    assert.deepEqual(result.windows.at(-1).global.counts.L2, { value: 1, relation: 'exact' })
    assert.equal(result.windows.at(-1).complete, true)
    assert.ok(peak < 2 * 1024 * 1024, 'member count does not turn into retained per-member proof storage')
    assert.equal(runtime.globalReader.progress.size, 0)
  } finally { f.close() }
})

test('Demo v7 full-size scene and legacy persona bodies use materialization rather than key budget', () => {
  const f = sceneProgressFixture(1, false); let runtime
  try {
    runtime = f.open()
    const store = runtime.storeByKey('scene-a', false), content = 'x'.repeat(65_536), first = f.records[0]
    store.db.prepare('UPDATE l2_scenes SET summary = ?').run(content)
    store.setPersona(content, 1, [first.id], Date.now(), { [first.id]: first.revision })
    const result = driveSceneRpc(runtime, 'L2')
    assert.equal(result.failed, undefined); assert.equal(result.windows.at(-1).complete, true)
    assert.equal(result.pages.flatMap(page => page.global.items)[0].content, content)
    const opened = runtime.beginDashboardVisibilityRead({ generationId: 'full-body', policyKey: 'a'.repeat(64),
      filterKey: 'b'.repeat(64), asOf: Date.now(), viewKey: 'overview', projectKeys: ['scene-a'] })
    assert.equal(opened.status, 'ok')
    try {
      const persona = opened.value.readManagedPersona('scene-a')
      assert.equal(persona.status, 'ok'); assert.equal(persona.value.state, 'visible'); assert.equal(persona.value.content, content)
    } finally { opened.value.cancel() }
  } finally { f.close() }
})

test('Demo v7 scene drilldown normalizes absent blank and padded general scene names', async () => {
  const f = fixture('v7-general-scene-')
  try {
    for (const [i, scene] of ['', '  ', ' general ', 'general', 'other'].entries()) {
      seed(f.root, 'scene-a', `Scene normalization preference ${i}.`, { scene, sourceEventId: `normalize-${i}` })
    }
    const runtime = f.open()
    const result = await import('../src/client/memory-v7-model.js').then(({readCompleteGlobalMemory}) =>
      readCompleteGlobalMemory(async q => runtime.readDashboard(q), { ...request('L1'), scene: { projectKey: 'scene-a', name: 'general' } }))
    assert.equal(result.complete, true)
    assert.deepEqual(result.global.counts.L1, { value: 4, relation: 'exact' })
    assert.equal(result.global.items.length, 4)
    assert.ok(result.global.items.every(i => (i.scene?.trim() || 'general') === 'general'))
    assert.equal(runtime.globalReader.progress.size, 0)
  } finally { f.close() }
})
