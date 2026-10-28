import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { openProjectStore } from '../lib/store.js'

// Seeding is deliberately confined to the parent process. The child receives existing
// closed stores, a fresh module cache, and no dashboard/search/tokenize/recall warmup.
function existingSixSources(root, useMemory) {
  for (let n = 0; n < 6; n += 1) {
    const key = `source-${n}`
    const text = n === 5 ? 'A00 用户偏好使用 pnpm 管理前端项目。' : `unrelated archive ${n}`
    const store = openProjectStore(root, key, { key, name: key, cwd: `/synthetic/${key}` })
    try {
      const source = store.captureMessage({ sessionId: `session-${key}`, role: 'user', content: text,
        createdAt: Date.now(), sourceEventId: `event-${key}`, origin: 'dsh-session',
        sourceKind: 'conversation', agentPreset: 'agent-mock' })
      store.addMemory({ content: text, scene: 'preferences', kind: 'preference', status: 'approved',
        confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] })
      store.refreshScenes()
    } finally { store.close() }
  }
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ generateMemory: false, useMemory,
    recallEnabled: true, automaticDailyTokens: 0, automaticDailyTasks: 0, manualDailyTokens: 0, manualDailyTasks: 0 }))
}

// This function is serialized, then evaluated only by the test's fresh Node child.
async function coldProcess() {
  const { default: assert } = await import('node:assert/strict')
  const { default: Module } = await import('node:module')
  const [root, entryUrl, memoryUrl, configUrl, mode] = process.argv.slice(1)
  const fallback = mode === 'plugin-fallback', startsOff = mode === 'runtime-off'
  const load = Module._load, diagnostics = [], disposers = []
  let tokenizerLoads = 0, dictionaryLoads = 0, runtime, restoreRecall
  Module._load = function (id, ...args) {
    if (id === '@node-rs/jieba') {
      tokenizerLoads += 1
      if (fallback) throw Object.assign(new Error('synthetic optional tokenizer unavailable'), { code: 'MODULE_NOT_FOUND' })
    }
    if (id === '@node-rs/jieba/dict') dictionaryLoads += 1
    return Reflect.apply(load, this, [id, ...args])
  }
  try {
    const [{ apply }, { MemoryRuntime }, { resolveConfig }] = await Promise.all([
      import(entryUrl), import(memoryUrl), import(configUrl),
    ])
    assert.equal(tokenizerLoads, 0, 'module imports alone do not prewarm the tokenizer')
    const prefix = '[memory-tdai] global-recall '
    const listeners = new Map()
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug(message) {
        if (message.startsWith(prefix)) diagnostics.push(JSON.parse(message.slice(prefix.length)))
      } },
      tools: { register() { return () => {} } },
      llm: { stream() { throw new Error('read-only cold recall must not call a provider') } },
      get() { return undefined },
      inject(names, callback) { callback(this) },
      effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
      on(event, listener) {
        if (event === 'agent/pre-step') assert.equal(tokenizerLoads, 1, 'startup owns readiness before exposing the first pre-step')
        listeners.set(event, listener)
        return () => {}
      },
    }
    const budget = { automaticDailyTokens: 0, automaticDailyTasks: 0, manualDailyTokens: 0, manualDailyTasks: 0 }
    const raw = { dataDir: root, generateMemory: false, useMemory: !startsOff, budget }
    const session = { id: 'new-session', header: { cwd: '/synthetic/source-0', agentPreset: 'agent-mock' } }
    const user = { id: 'new-user', role: 'user', content: [{ type: 'text', text: 'A00 包管理器' }], source: { kind: 'user' } }
    const ownMemory = (messages) => messages.filter((message) => message.source?.kind === 'memory' && message.source?.plugin === 'memory-tdai')
    const requireTarget = (text) => { assert.match(text, /A00/); assert.match(text, /pnpm/) }
    const preStep = async (messages, step) => {
      const payload = { agent: { session }, messages, step, turn: 1 }
      const result = await listeners.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages }))
      assert.equal(result.kind, 'enter')
      return result.messages
    }
    if (startsOff) {
      runtime = new MemoryRuntime(ctx, resolveConfig(raw), root)
      disposers.push(() => runtime.close())
      assert.equal(runtime.config.useMemory, false)
      assert.equal(tokenizerLoads, 1, 'even a runtime starting OFF is ready before the constructor returns')
      runtime.updateSettings({ useMemory: true })
      // This is the first actual read in this process; changing settings performs no warmup.
      requireTarget(runtime.globalRecall(user.content[0].text, session))
      runtime.updateSettings({ useMemory: false })
      assert.equal(runtime.globalRecall(user.content[0].text, session), undefined)
      assert.equal(diagnostics.at(-1).reason, 'memory-use-disabled')
      runtime.updateSettings({ useMemory: true })
      requireTarget(runtime.globalRecall(user.content[0].text, session))
    } else {
      const recall = MemoryRuntime.prototype.globalRecall
      MemoryRuntime.prototype.globalRecall = function (...args) {
        runtime = this
        return Reflect.apply(recall, this, args)
      }
      restoreRecall = () => { MemoryRuntime.prototype.globalRecall = recall }
      apply(ctx, raw)
      assert.equal(tokenizerLoads, 1)
      assert.equal(runtime, undefined, 'startup has not invoked recall')
      const first = await preStep([user], 1)
      assert.equal(ownMemory(first).length, 1, 'the first pre-step must reach the sixth existing source')
      requireTarget(ownMemory(first)[0].content[0].text)
      assert.equal(diagnostics.length, 1, 'no earlier recall prewarmed the child')
      assert.equal(diagnostics[0].reason, 'injected')
      runtime.updateSettings({ useMemory: false })
      const off = await preStep(first, 2)
      assert.equal(ownMemory(off).length, 0, 'OFF removes the actual previously injected message')
      assert.equal(diagnostics.length, 1, 'the OFF hook bypasses recall')
      runtime.updateSettings({ useMemory: true })
      const on = await preStep(off, 3)
      assert.equal(ownMemory(on).length, 1, 'a real OFF to ON change recovers without entry reload or a second question')
      requireTarget(ownMemory(on)[0].content[0].text)
    }
    assert.equal(runtime.config.generateMemory, false)
    assert.equal(runtime.config.useMemory, true)
    assert.equal(runtime.config.recall.enabled, true)
    assert.equal(runtime.config.recall.maxTokens, 220)
    assert.equal(runtime.config.recall.maxResults, 5)
    assert.equal('budget' in runtime.config, false, 'legacy zero quotas are ignored by startup')
    assert.equal(tokenizerLoads, 1, 'queries and actual settings changes never retry initialization')
    if (fallback) assert.equal(dictionaryLoads, 0, 'the cached failed optional dependency uses the original fallback')
    else assert.ok(dictionaryLoads === 0 || dictionaryLoads === 1, 'optional native availability is not required, but initialization is attempted once')

    // A later fault checks the diagnostic boundary, after the unmodified cold read and
    // switches above. Preserve real read ownership/cleanup, but return a failed status.
    const read = runtime.readDashboard
    runtime.readDashboard = function (input) {
      const result = Reflect.apply(read, this, [input])
      return input.action === 'close' ? result : { ...result, status: 'unavailable-probe', reason: `${root} A00 pnpm source-5` }
    }
    try {
      assert.equal(runtime.globalRecall(user.content[0].text, session), undefined)
      assert.equal(diagnostics.at(-1).stage, 'scan-read')
      assert.equal(diagnostics.at(-1).reason, 'unavailable-probe')
    } finally { runtime.readDashboard = read }
    for (const diagnostic of diagnostics) {
      assert.deepEqual(Object.keys(diagnostic).sort(), ['candidateCount', 'elapsedMs', 'reason', 'scanWindows', 'selectedCount', 'stage'])
      assert.ok(Number.isInteger(diagnostic.scanWindows) && diagnostic.scanWindows >= 0 && diagnostic.scanWindows <= 6)
      assert.ok(Number.isInteger(diagnostic.candidateCount) && diagnostic.candidateCount >= 0 && diagnostic.candidateCount <= 50)
      assert.ok(Number.isInteger(diagnostic.selectedCount) && diagnostic.selectedCount >= 0 && diagnostic.selectedCount <= 5)
      assert.ok(diagnostic.elapsedMs === null || Number.isFinite(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0)
      const serialized = JSON.stringify(diagnostic)
      assert.equal(serialized.includes(root), false)
      assert.doesNotMatch(serialized, /A00|pnpm|source-[0-5]|new-session|agent-mock/)
    }
    return { mode, firstRecallPassed: true, offOnPassed: true, tokenizerLoads, dictionaryLoads, diagnostics }
  } finally {
    try { for (const dispose of disposers.reverse()) dispose() }
    finally { restoreRecall?.(); Module._load = load }
  }
}

function runCold(mode) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-tokenizer-cold-'))
  try {
    existingSixSources(root, mode !== 'runtime-off')
    const program = `(${coldProcess.toString()})().then((result) => process.stdout.write(JSON.stringify(result)), (error) => { console.error(error); process.exitCode = 1 })`
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program, root,
      new URL('../lib/index.js', import.meta.url).href, new URL('../lib/memory.js', import.meta.url).href,
      new URL('../lib/config.js', import.meta.url).href, mode], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', DSH_HOME: root },
    })
    assert.equal(child.error, undefined, child.error?.message)
    assert.equal(child.signal, null, child.stderr)
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    assert.equal(result.mode, mode)
    assert.equal(result.firstRecallPassed, true)
    assert.equal(result.offOnPassed, true)
    assert.equal(result.tokenizerLoads, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('tokenizer readiness precedes cold six-source first pre-step and actual OFF to ON recovery', () => {
  // Real monotonic clock throughout; neither child makes any earlier dashboard/search read.
  runCold('plugin')
  runCold('runtime-off')
})

test('unavailable optional tokenizer stays cached across cold first pre-step and OFF to ON', () => {
  runCold('plugin-fallback')
})
