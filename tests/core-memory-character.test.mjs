/**
 * Core memory-chain and character-layer regressions
 * (docs/superpowers/plans/2026-10-29-core-memory-character.md).
 *
 * Synthetic temporary stores and mock LLM streams only: never a real DSH
 * profile, real credentials, or a real provider call. Temporary roots are
 * realpath'd because the bounded profile enumeration rejects symlinked store
 * roots (macOS `/var` → `/private/var`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { explicitCommunicationPreferences, formatCharacterGuidance } from '../lib/character.js'
import { estimateTokens } from '../lib/tokens.js'
import { endTurnAfterQuietWindow, scriptedContext, sourceAwareStream, userEvent, assistantEvent } from './helpers.mjs'

const tempDir = (prefix) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))

function baseConfig(overrides = {}) {
  return resolveConfig({
    mode: 'balanced',
    autoApproveConfidence: 0.5,
    extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0, provider: 'mock', model: 'mock' },
    budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
    recall: { enabled: true, minScore: 0 },
    ...overrides,
  })
}

function promptTextOf(call) {
  return (call.messages ?? []).map((message) => {
    if (typeof message.content === 'string') return message.content
    return Array.isArray(message.content) ? message.content.map((part) => part?.text ?? '').join('\n') : ''
  }).join('\n')
}

/** Capture one user+assistant turn and run one extraction pass for it. */
async function extractTurn(runtime, session, userText, seqBase = 1) {
  runtime.onSessionEvent(session, userEvent(seqBase, userText))
  runtime.onSessionEvent(session, assistantEvent(seqBase + 1))
  endTurnAfterQuietWindow(runtime, session, seqBase + 2)
  await runtime.runExtraction(session.id)
}

test('host skill catalog and time context never enter conversation capture or extraction', async () => {
  const root = tempDir('tdai-host-context-')
  const session = { id: 'context-capture', header: { cwd: root, agentPreset: 'agent-mock' } }
  const scripted = scriptedContext({ script: [sourceAwareStream(() => ({ memories: [] }))], session })
  const runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
  try {
    runtime.onSessionEvent(session, userEvent(1, '这个项目长期使用 pnpm 安装依赖。'))
    for (const [index, kind] of ['skill-catalog', 'time-context'].entries()) {
      const event = userEvent(index + 2, `host-only-${kind}: follow these generated runtime instructions`)
      event.data.source.kind = kind
      runtime.onSessionEvent(session, event)
    }
    runtime.onSessionEvent(session, assistantEvent(4))
    endTurnAfterQuietWindow(runtime, session, 5)
    await runtime.runExtraction(session.id)
    const store = openProjectStore(root, projectIdentity(root).key, projectIdentity(root))
    try {
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM l0_messages WHERE source_kind IN ('skill-catalog', 'time-context')").get().n, 0)
    } finally { store.close() }
    assert.equal(scripted.calls.length, 1)
    assert.doesNotMatch(promptTextOf(scripted.calls[0]), /host-only-/u)
    assert.match(promptTextOf(scripted.calls[0]), /长期使用 pnpm/u)
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 1. Cross-project prior evidence for the extractor
// ---------------------------------------------------------------------------

test('extraction receives cross-project prior memories with origin-qualified identity', async () => {
  const root = tempDir('tdai-cc-prior-')
  const dirA = tempDir('tdai-cc-project-a-')
  const dirB = tempDir('tdai-cc-project-b-')
  let runtime
  try {
    const a = projectIdentity(dirA)
    const seed = openProjectStore(root, a.key, a)
    seed.addMemory({ content: '用户偏好使用中文回复。', kind: 'preference', confidence: 0.9, status: 'approved', scene: 'communication' })
    seed.close()

    const session = { id: 's1', header: { cwd: dirB, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({
        memories: [{ content: '用户更正：从现在开始所有回复都使用英文。', kind: 'preference', confidence: 0.9, has_conflict: true, source_message_ids: sourceIds }],
      }))],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    await extractTurn(runtime, session, '从现在开始所有回复都使用英文。', 1)

    assert.equal(scripted.calls.length, 1, 'conflict handling must not add a second model call')
    const prompt = promptTextOf(scripted.calls[0])
    assert.match(prompt, /用户偏好使用中文回复/, 'the prior approved global preference must reach the extraction prompt')
    assert.match(prompt, /g:[^:\s]+:[^:\s]+@r\d+/, 'prior entries must carry origin-qualified project:id@revision identity')

    const storeB = openProjectStore(root, projectIdentity(dirB).key, projectIdentity(dirB))
    try {
      assert.equal(storeB.list('approved', 50).some((m) => m.content.includes('英文')), false,
        'the conflicting correction must not become approved')
      assert.ok(storeB.list('candidate', 50).some((m) => m.content.includes('英文')),
        'has_conflict output stays a reviewable candidate')
    } finally { storeB.close() }
    const storeA = openProjectStore(root, a.key, a)
    try {
      assert.ok(storeA.list('approved', 50).some((m) => m.content.includes('中文')),
        'the old global preference must not be destructively overwritten')
    } finally { storeA.close() }
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('extraction prior scan tells the model honestly when the profile scan is partial', async () => {
  const root = tempDir('tdai-cc-partial-')
  const dirs = []
  let runtime
  try {
    // More other projects than the bounded prior scan may admit: the prompt must
    // say the read set is partial instead of implying no conflicts exist.
    for (let index = 0; index < 12; index += 1) {
      const dir = tempDir(`tdai-cc-part-${index}-`)
      dirs.push(dir)
      const identity = projectIdentity(dir)
      const store = openProjectStore(root, identity.key, identity)
      store.addMemory({ content: `项目 ${index} 使用约定 ${index}。`, kind: 'project', confidence: 0.9, status: 'approved' })
      store.close()
    }
    const home = tempDir('tdai-cc-home-')
    dirs.push(home)
    const session = { id: 's1', header: { cwd: home, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({
        memories: [{ content: '项目新增一条约定。', kind: 'project', confidence: 0.9, source_message_ids: sourceIds }],
      }))],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    await extractTurn(runtime, session, '新增一条项目约定。', 1)
    const prompt = promptTextOf(scripted.calls[0])
    assert.match(prompt, /prior_scan_partial=true/, 'an over-cap profile scan must be disclosed as partial')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

test('forgotten prior memories never reach the extraction prompt', async () => {
  const root = tempDir('tdai-cc-forget-')
  const dirA = tempDir('tdai-cc-forget-a-')
  const dirB = tempDir('tdai-cc-forget-b-')
  let runtime
  try {
    const a = projectIdentity(dirA)
    const seed = openProjectStore(root, a.key, a)
    seed.addMemory({ content: '用户偏好保留的记忆。', kind: 'preference', confidence: 0.9, status: 'approved' })
    const doomed = seed.addMemory({ content: '用户偏好被遗忘的记忆。', kind: 'preference', confidence: 0.9, status: 'approved' }).record
    seed.close()

    const session = { id: 's1', header: { cwd: dirB, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({
        memories: [{ content: '用户重申了一条新偏好。', kind: 'preference', confidence: 0.9, source_message_ids: sourceIds }],
      }))],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    runtime.review(a.key, doomed.id, 'forget')
    await extractTurn(runtime, session, '我重申一个新的表达偏好。', 1)
    const prompt = promptTextOf(scripted.calls[0])
    assert.doesNotMatch(prompt, /被遗忘的记忆/, 'a forgotten record must never be sent as prior evidence')
    assert.match(prompt, /保留的记忆/, 'a still-approved record must remain available as prior evidence')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('prior extraction context never crosses into another profile root', async () => {
  const rootA = tempDir('tdai-cc-root-a-')
  const rootB = tempDir('tdai-cc-root-b-')
  const dirA = tempDir('tdai-cc-cross-a-')
  let runtime
  try {
    const a = projectIdentity(dirA)
    const seed = openProjectStore(rootA, a.key, a)
    seed.addMemory({ content: '另一个 profile 的私密偏好。', kind: 'preference', confidence: 0.9, status: 'approved' })
    seed.close()

    const session = { id: 's1', header: { cwd: dirA, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({
        memories: [{ content: '本 profile 新增一条记忆。', kind: 'fact', confidence: 0.9, source_message_ids: sourceIds }],
      }))],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), rootB)
    await extractTurn(runtime, session, '新增一条本 profile 的记忆。', 1)
    const prompt = promptTextOf(scripted.calls[0])
    assert.doesNotMatch(prompt, /另一个 profile 的私密偏好/, 'profile roots stay isolated')
  } finally {
    runtime?.close()
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Persona reaches the ACTIVE pre-step route
// ---------------------------------------------------------------------------

function createHost(llm, liveSession) {
  const listeners = new Map()
  const tools = []
  const disposers = []
  const host = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    llm,
    sessions: { get: () => (liveSession === undefined ? undefined : { ...liveSession, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }) },
    systemPrompt: undefined,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(disposer) {
      const cleanup = disposer()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    },
    get() { return undefined },
    inject(names, callback) { callback(this) },
    emit(event, ...args) { return Promise.all((listeners.get(event) ?? []).map((listener) => listener(...args))) },
    listeners,
    toolsList: tools,
    disposers,
  }
  return host
}

/** The real Host event order that produces one committed, source-backed L1 memory. */
async function captureAndExtract(host, session, userText, committed) {
  await host.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  await host.emit('session/event', session, { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } })
  await host.emit('session/event', session, {
    type: 'user/message', seq: 3,
    data: { role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } },
  })
  await host.emit('session/event', session, { type: 'request/header', seq: 4, data: { header: committed, reason: 'initial' } })
  await host.emit('session/event', session, {
    type: 'assistant/message', seq: 5,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }], source: { provider: 'mock', model: 'mock' } } },
  })
  await host.emit('session/event', session, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 1600))
}

async function preStepMessages(host, session, userText, step = 1) {
  const payload = {
    agent: { session },
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } }],
    step,
    turn: 2,
  }
  const decisions = await host.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages: payload.messages }))
  const decision = Array.isArray(decisions) ? decisions[0] : decisions
  assert.equal(decision.kind, 'enter')
  return decision.messages ?? []
}

const injectedMemoryText = (messages) =>
  messages.filter((message) => message.source?.kind === 'memory' && message.source?.plugin === 'memory-tdai')
    .map((message) => message.content.map((part) => part.text ?? '').join('\n')).join('\n')

test('active pre-step keeps a sourced persona without a lexical fact match and drops it after forget', async () => {
  const root = tempDir('tdai-review-persona-')
  const project = projectIdentity(path.join(root, 'project'))
  const host = createHost()
  try {
    const store = openProjectStore(root, project.key, project)
    const source = store.captureMessage({ sessionId: 'old', role: 'user', content: '我喜欢简洁直接的回答。',
      sourceKind: 'user', agentPreset: 'agent-mock' })
    const record = store.addMemory({ content: '用户偏好简洁直接的回答。', kind: 'preference', status: 'approved',
      confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] }).record
    store.setPersona('沟通偏好：简洁直接。', 1, [record.id], Date.now(), { [record.id]: record.revision })
    store.close()
    apply(host, { dataDir: root, extraction: { enabled: false }, recall: { includePersona: true } })
    const session = { id: 'fresh', header: { cwd: project.cwd, agentPreset: 'agent-mock' } }
    assert.match(injectedMemoryText(await preStepMessages(host, session, 'xyzzy-unrelated-topic')), /persona-summary>[\s\S]*简洁直接/)
    const writer = openProjectStore(root, project.key)
    writer.forget(record.id)
    writer.close()
    assert.doesNotMatch(injectedMemoryText(await preStepMessages(host, session, 'xyzzy-unrelated-topic')), /简洁直接/)
  } finally {
    for (const dispose of host.disposers) dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('active pre-step keeps facts and the combined character packet within the configured token budget', async () => {
  const root = tempDir('tdai-review-budget-')
  const project = projectIdentity(path.join(root, 'project'))
  const host = createHost()
  try {
    const store = openProjectStore(root, project.key, project)
    const source = store.captureMessage({ sessionId: 'old', role: 'user', content: 'Quokka 项目采用 pnpm。',
      sourceKind: 'user', agentPreset: 'agent-mock' })
    store.addMemory({ content: 'Quokka 项目采用 pnpm。', kind: 'fact', status: 'approved', confidence: .95,
      sourceVerified: true, sourceMessageIds: [source.id] })
    store.close()
    apply(host, { dataDir: root, extraction: { enabled: false }, character: { enabled: true, description: '表达自然，耐心坦率。'.repeat(30) },
      recall: { includePersona: false, maxTokens: 180, maxChars: 1000 } })
    const session = { id: 'fresh', header: { cwd: project.cwd, agentPreset: 'agent-mock' } }
    const text = injectedMemoryText(await preStepMessages(host, session, 'Quokka'))
    assert.match(text, /pnpm/, 'optional character guidance must not displace the useful fact')
    assert.ok(estimateTokens(text) <= 180, `combined packet used ${estimateTokens(text)} tokens`)
    assert.ok(text.length <= 1000)
  } finally {
    for (const dispose of host.disposers) dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('learned preferences share one source reference and fit alongside the stable character', () => {
  const labels = ['简洁回答', '直接表达', '自然口语', '避免玩笑', '使用中文沟通', '先给结论']
  const id = 'g:learn-fcfa7377a877:mem_30b669920246495c83f9'
  const block = formatCharacterGuidance({ description: '坦率、耐心、有判断，表达自然，适度幽默', maxTokens: 110,
    learned: labels.map((content) => ({ projectKey: 'learn-fcfa7377a877', projectName: 'learn', id, revision: 1, content, updatedAt: 1 })) })
  for (const label of labels) assert.ok(block?.text.includes(label), `missing learned preference: ${label}`)
  assert.equal(block.text.split(id).length - 1, 1)
  assert.ok(block.usedTokens <= 110)
})

test('active pre-step reserves learned expression preferences without losing a matching fact', async () => {
  const root = tempDir('tdai-style-reserve-'), project = projectIdentity(path.join(root, 'project')), host = createHost()
  try {
    const store = openProjectStore(root, project.key, project)
    const source = store.captureMessage({ sessionId: 'old', role: 'user', sourceKind: 'user', agentPreset: 'agent-mock',
      content: '请记住我的长期沟通偏好：以后回复先给结论，简洁回答，用自然随和的中文。发现我有事实错误时请直接指出，不要迎合，尽量不要开玩笑。' })
    const style = store.addMemory({ content: '用户要求以后的回复先给结论、简洁作答，并使用自然随和的中文，事实有错要直接指出且少开玩笑。',
      kind: 'preference', scene: 'communication-style', status: 'approved', confidence: .95, sourceVerified: true, sourceMessageIds: [source.id] }).record
    const factSource = store.captureMessage({ sessionId: 'old', role: 'user', sourceKind: 'user', agentPreset: 'agent-mock', content: 'Quokka 项目采用 pnpm。' })
    store.addMemory({ content: 'Quokka 项目采用 pnpm。', kind: 'fact', status: 'approved', confidence: .95,
      sourceVerified: true, sourceMessageIds: [factSource.id] })
    store.setPersona('用户要求先给结论、简洁回答、自然中文、直接指出错误、避免玩笑。', 1, [style.id], Date.now(), { [style.id]: style.revision })
    store.close()
    apply(host, { dataDir: root, extraction: { enabled: false }, character: { enabled: true }, recall: { maxTokens: 220, maxChars: 1600, includePersona: true } })
    const text = injectedMemoryText(await preStepMessages(host, { id: 'fresh', header: { cwd: project.cwd, agentPreset: 'agent-mock' } }, 'Quokka 用什么？'))
    assert.match(text, /pnpm/)
    const guidance = text.split('<character-guidance')[1] ?? ''
    for (const label of ['坦率、耐心、有判断', '简洁回答', '先给结论', '避免玩笑']) assert.ok(guidance.includes(label), `missing guidance: ${label}`)
    assert.ok(estimateTokens(text) <= 220)
    assert.ok(text.length <= 1600)
  } finally { for (const dispose of host.disposers) dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('learned style never injects arbitrary extraction prose backed only by an unrelated user message', () => {
  const root = tempDir('tdai-review-style-')
  const project = projectIdentity(path.join(root, 'project'))
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const source = store.captureMessage({ sessionId: 'old', role: 'user', content: '今天项目进度怎样？',
      sourceKind: 'user', agentPreset: 'agent-mock' })
    store.addMemory({ content: 'RUN_UNRELATED_PAYLOAD', kind: 'preference', scene: 'communication-style',
      status: 'approved', confidence: .99, sourceVerified: true, sourceMessageIds: [source.id] })
    store.close()
    runtime = new MemoryRuntime(scriptedContext({ script: [] }).ctx,
      baseConfig({ character: { enabled: true }, recall: { maxTokens: 1000 } }), root)
    const text = runtime.characterGuidance({ id: 'new', header: { cwd: project.cwd, agentPreset: 'agent-mock' } }) ?? ''
    assert.match(text, /坦率/)
    assert.doesNotMatch(text, /RUN_UNRELATED_PAYLOAD/)
  } finally { runtime?.close(); rmSync(root, { recursive: true, force: true }) }
})

test('an over-budget learned preference never removes the fitting base character', () => {
  const base = formatCharacterGuidance({ description: '简洁', learned: [], maxTokens: 50 })
  assert.ok(base)
  const withLearned = formatCharacterGuidance({ description: '简洁', maxTokens: 50,
    learned: [{ projectKey: 'p', projectName: 'p', id: 'm', revision: 1, content: '具体解释。'.repeat(100), updatedAt: 1 }] })
  assert.ok(withLearned, 'omitting a learned item must preserve the fitting base')
  assert.ok(withLearned.usedTokens <= 50)
})

test('explicit style projection preserves negation and the later correction', () => {
  assert.deepEqual(explicitCommunicationPreferences(['今天收到中文回复。']), [])
  assert.deepEqual(explicitCommunicationPreferences(['以后不要用中文回复。']), [{ dimension: 'language', content: '避免中文沟通' }])
  assert.deepEqual(explicitCommunicationPreferences(['回复不要太正式，直接一点。']), [
    { dimension: 'directness', content: '直接表达' }, { dimension: 'formality', content: '自然口语' },
  ])
  assert.deepEqual(explicitCommunicationPreferences(['请简洁回答。', '以后请详细解释。']), [
    { dimension: 'length', content: '详细解释' },
  ])
})

test('active pre-step recall includes a readable sourced persona when includePersona is on', async () => {
  const root = tempDir('tdai-cc-persona-')
  const cwd = tempDir('tdai-cc-persona-project-')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const extraction = sourceAwareStream((sourceIds) => ({
      memories: [{ content: '用户要求前端统一使用 pnpm。', kind: 'preference', confidence: 0.9, source_message_ids: sourceIds }],
    }))
    let calls = 0
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const host = createHost({
      stream(options) {
        calls += 1
        if (calls > 1) throw new Error('recall and pre-step must never call the model')
        return extraction(options)
      },
    }, session)
    apply(host, baseConfig())
    await captureAndExtract(host, session, '以后前端都用 pnpm，不要用 npm。', { provider: 'mock', model: 'mock' })

    const identity = projectIdentity(cwd)
    const store = openProjectStore(path.join(root, 'memory-tdai'), identity.key, identity)
    const source = store.list('approved', 50).find((record) => record.content.includes('pnpm'))
    assert.ok(source, 'sanity: the pipeline must auto-approve a source-backed record')
    store.setPersona('沟通偏好：简洁直接的中文回复；先给结论再给理由。', 1, [source.id], Date.now(), { [source.id]: source.revision })
    store.close()

    const receiving = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const messages = await preStepMessages(host, receiving, '前端用什么包管理器？')
    const block = injectedMemoryText(messages)
    assert.match(block, /memory-context/, 'the fact packet must still be injected')
    assert.match(block, /pnpm/, 'the underlying fact must still be recalled')
    assert.match(block, /persona-summary/, 'the active route must include the sourced persona (includePersona=true)')
    assert.match(block, /简洁直接/, 'the persona body must be readable to the conversation')
    assert.equal(calls, 1, 'recall must not make any extra model calls')
    for (const dispose of host.disposers) dispose()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('includePersona=false suppresses only the persona block on the active route', async () => {
  const root = tempDir('tdai-cc-persona-off-')
  const cwd = tempDir('tdai-cc-persona-off-project-')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const extraction = sourceAwareStream((sourceIds) => ({
      memories: [{ content: '用户要求前端统一使用 pnpm。', kind: 'preference', confidence: 0.9, source_message_ids: sourceIds }],
    }))
    let calls = 0
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const host = createHost({
      stream(options) {
        calls += 1
        if (calls > 1) throw new Error('recall and pre-step must never call the model')
        return extraction(options)
      },
    }, session)
    apply(host, baseConfig({ recall: { enabled: true, minScore: 0, includePersona: false } }))
    await captureAndExtract(host, session, '以后前端都用 pnpm，不要用 npm。', { provider: 'mock', model: 'mock' })

    const identity = projectIdentity(cwd)
    const store = openProjectStore(path.join(root, 'memory-tdai'), identity.key, identity)
    const source = store.list('approved', 50).find((record) => record.content.includes('pnpm'))
    assert.ok(source, 'sanity: the pipeline must auto-approve a source-backed record')
    store.setPersona('沟通偏好：简洁直接的中文回复。', 1, [source.id], Date.now(), { [source.id]: source.revision })
    store.close()

    const receiving = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const messages = await preStepMessages(host, receiving, '前端用什么包管理器？')
    const block = injectedMemoryText(messages)
    assert.match(block, /pnpm/, 'facts must still be recalled with the persona off')
    assert.doesNotMatch(block, /persona-summary/, 'includePersona=false must not attach a persona')
    for (const dispose of host.disposers) dispose()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Stable character base + learned communication preferences
// ---------------------------------------------------------------------------

test('enabled base character is injected even when no fact matches the new words', async () => {
  const root = tempDir('tdai-cc-character-')
  const cwd = tempDir('tdai-cc-character-project-')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const host = createHost()
    apply(host, baseConfig({ character: { enabled: true, description: '坦率、耐心、有判断，表达自然，适度幽默' } }))
    const session = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const messages = await preStepMessages(host, session, '帮我重构这个模块的内部结构。')
    const block = injectedMemoryText(messages)
    assert.match(block, /character-guidance/, 'the enabled stable character must reach the active pre-step route')
    assert.match(block, /坦率、耐心、有判断/, 'the configured base description must be used verbatim')
    for (const dispose of host.disposers) dispose()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('character settings persist through updateSettings and survive a runtime restart', async () => {
  const root = tempDir('tdai-cc-character-persist-')
  const cwd = tempDir('tdai-cc-character-persist-project-')
  let runtime
  try {
    runtime = new MemoryRuntime(scriptedContext({ script: [] }).ctx, baseConfig(), root)
    runtime.updateSettings({ characterEnabled: true, characterDescription: '谨慎、克制，中文优先。' })
    const settings = JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8'))
    assert.equal(settings.characterEnabled, true)
    assert.equal(settings.characterDescription, '谨慎、克制，中文优先。')
    runtime.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [] }).ctx, baseConfig(), root)
    const session = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const block = runtime.characterGuidance(session) ?? ''
    assert.match(block, /谨慎、克制/, 'the restart runtime must read the persisted character back')
    assert.match(block, /character-guidance/)
    runtime.close()
    runtime = undefined
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('explicit user communication preferences are learned and injected without extra model calls', async () => {
  const root = tempDir('tdai-cc-learn-')
  const cwd = tempDir('tdai-cc-learn-project-')
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({
        memories: [{ content: '用户偏好简洁的回复，先给结论。', kind: 'preference', confidence: 0.9, scene: 'communication-style', source_message_ids: [sourceIds[0]] }],
      }))],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig({ character: { enabled: true } }), root)
    runtime.onSessionEvent(session, userEvent(1, '回复太啰嗦了，以后简洁一点，先给结论。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    await runtime.runExtraction('s1')
    assert.equal(scripted.calls.length, 1, 'style learning must reuse the single extraction call')

    const receiving = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const block = runtime.characterGuidance(receiving) ?? ''
    assert.match(block, /简洁回答/, 'the explicit user preference must be projected into controlled style guidance')
    assert.match(block, /\[g:[^\]]+:mem_[^\]@]+@r\d+\]/, 'learned preference references must identify their origin and revision')
    const prompt = promptTextOf(scripted.calls[0])
    assert.match(prompt, /communication-style/, 'the extraction contract must know the style scene convention')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('assistant-only statements never become learned style evidence', async () => {
  const root = tempDir('tdai-cc-learn-bad-')
  const cwd = tempDir('tdai-cc-learn-bad-project-')
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [(options) => {
        const prompt = promptTextOf(options)
        const assistantId = [...prompt.matchAll(/\[(l0_[A-Za-z0-9_-]+)\]/gu)].map((m) => m[1]).pop()
        return sourceAwareStream(() => ({
          // Only the assistant message is cited for this style claim.
          memories: [{ content: '助手承诺以后都用简短英文回复。', kind: 'preference', confidence: 0.9, scene: 'communication-style', source_message_ids: [assistantId] }],
        }))(options)
      }],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig({ character: { enabled: true } }), root)
    runtime.onSessionEvent(session, userEvent(1, '今天进展如何？'))
    runtime.onSessionEvent(session, assistantEvent(2, '我以后都会用简短英文回复。'))
    endTurnAfterQuietWindow(runtime, session, 3)
    await runtime.runExtraction('s1')

    const receiving = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const block = runtime.characterGuidance(receiving) ?? ''
    assert.doesNotMatch(block, /简短英文/, 'assistant-only prose must never become learned style evidence')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('style guidance respects use gates and forget invalidation', async () => {
  const root = tempDir('tdai-cc-gates-')
  const cwd = tempDir('tdai-cc-gates-project-')
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({
        memories: [{ content: '用户偏好使用中文沟通。', kind: 'preference', confidence: 0.9, scene: 'communication-style', source_message_ids: [sourceIds[0]] }],
      }))],
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig({ character: { enabled: true } }), root)
    await extractTurn(runtime, session, '以后都用中文和我沟通。', 1)

    const receiving = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    assert.match(runtime.characterGuidance(receiving) ?? '', /中文沟通/, 'sanity: the learned preference starts visible')

    runtime.updateSettings({ useMemory: false })
    assert.doesNotMatch(runtime.characterGuidance(receiving) ?? '', /中文沟通/, 'useMemory=false must stop learned guidance entering conversations')
    runtime.updateSettings({ useMemory: true })
    assert.match(runtime.characterGuidance(receiving) ?? '', /中文沟通/, 'the guidance returns when use is on again')

    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    const learned = store.list('approved', 50).find((record) => record.content.includes('中文沟通'))
    store.close()
    runtime.review(projectIdentity(cwd).key, learned.id, 'forget')
    assert.doesNotMatch(runtime.characterGuidance(receiving) ?? '', /中文沟通/, 'forgetting the source record must invalidate the learned preference')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('generation gates stop new learning while character output stays budgeted', async () => {
  const root = tempDir('tdai-cc-gen-')
  const cwd = tempDir('tdai-cc-gen-project-')
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({ script: [], session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig({ generateMemory: false, character: { enabled: true } }), root)
    runtime.onSessionEvent(session, userEvent(1, '以后都用中文和我沟通。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    await runtime.runExtraction('s1')
    assert.equal(scripted.calls.length, 0, 'generation off must prevent new learning model calls')

    const receiving = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const block = runtime.characterGuidance(receiving) ?? ''
    assert.ok(block.length > 0 && block.length <= 900, 'the base character block must exist and stay bounded')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('character guidance never crosses profile roots and dashboard settings round-trip it', async () => {
  const rootA = tempDir('tdai-cc-char-a-')
  const rootB = tempDir('tdai-cc-char-b-')
  const cwd = tempDir('tdai-cc-char-cwd-')
  let a
  let b
  try {
    a = new MemoryRuntime(scriptedContext({ script: [] }).ctx, baseConfig({ character: { enabled: true, description: '只属于这个 profile 的底色。' } }), rootA)
    b = new MemoryRuntime(scriptedContext({ script: [] }).ctx, baseConfig(), rootB)
    const session = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    assert.match(a.characterGuidance(session) ?? '', /只属于这个 profile/)
    assert.doesNotMatch(b.characterGuidance(session) ?? '', /只属于这个 profile/, 'profiles stay isolated')
    const settings = a.dashboard().settings
    assert.equal(settings.characterEnabled, true)
    assert.equal(settings.characterDescription, '只属于这个 profile 的底色。')
    assert.equal(b.dashboard().settings.characterEnabled, false, 'existing profiles stay opted-out')
    a.close(); a = undefined
    b.close(); b = undefined
  } finally {
    a?.close()
    b?.close()
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('extraction validates the thirteenth source and never consumes a batch with an outside tail reference', async () => {
  for (const mode of ['valid', 'outside']) {
    const root = tempDir('tdai-complete-source-tail-'), session = { id: 'source-tail', header: { cwd: root, agentPreset: 'agent-mock' } }
    const mock = scriptedContext({ session, script: [sourceAwareStream(ids => {
      assert.equal(ids.length, 13)
      return { memories: [{ content: 'The project uses pnpm consistently.', kind: 'preference', confidence: .99,
        source_message_ids: mode === 'valid' ? ids : [...ids.slice(0, 12), 'outside-frozen-source'] }] }
    })] })
    const runtime = new MemoryRuntime(mock.ctx, baseConfig(), root)
    try {
      for (let i = 0; i < 13; i++) runtime.onSessionEvent(session, userEvent(i + 1, `Source ${i}: preserve this durable project preference.`))
      endTurnAfterQuietWindow(runtime, session, 14)
      await runtime.runExtraction(session.id)
      const store = runtime.storeByKey(projectIdentity(root).key, false)
      assert.equal(mock.calls.length, 1)
      const records = store.list('approved', 50)
      assert.equal(records.length, mode === 'valid' ? 1 : 0)
      assert.equal(store.unextracted(session.id, 24).length, mode === 'valid' ? 0 : 13)
      if (mode === 'valid') {
        assert.equal(records[0].sourceMessageIds.length, 13)
        assert.equal(store.scenes()[0].memoryCount, 1)
      } else assert.ok(store.extractionJobs(20).some(job => job.status === 'failed' && job.error === 'source_validation_failed'))
    } finally { runtime.close(); rmSync(root, { recursive: true, force: true }) }
  }
})
