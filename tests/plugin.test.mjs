import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { projectIdentity } from '../lib/project.js'
import { globalMemoryKey } from '../lib/global-memory.js'
import { openProjectStore } from '../lib/store.js'
import { estimateTokens } from '../lib/tokens.js'
import { sourceAwareStream } from './helpers.mjs'

function createHost(cwd) {
  const listeners = new Map()
  const tools = []
  const disposers = []
  const http = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    llm: { stream: sourceAwareStream((sourceIds) => ({ memories: [{ content: '用户偏好使用 pnpm 管理前端项目。', kind: 'preference', confidence: 0.93, source_message_ids: sourceIds }] })) },
    sessions: { get: () => ({ id: 's1', header: { cwd, agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }) },
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
    get() {
      return undefined
    },
    inject(names, callback) {
      callback(this)
    },
    emit(event, ...args) {
      return Promise.all((listeners.get(event) ?? []).map((listener) => listener(...args)))
    },
    listeners,
    toolsList: tools,
    disposers,
  }
  return http
}

test('plugin entry registers tools, captures L0, extracts, and injects at pre-step', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-plugin-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const cwd = process.cwd()
    const host = createHost(cwd)
    apply(host, {
      mode: 'balanced',
      autoApproveConfidence: 0.5,
      extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0 },
      budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
      recall: { enabled: true, minScore: 0 },
    })
    assert.deepEqual(host.toolsList.map((tool) => tool.name).sort(), [
      'memory_experience',
      'memory_explain',
      'memory_get',
      'memory_history',
      'memory_profile',
      'memory_propose',
      'memory_read_raw',
      'memory_relations',
      'memory_search',
      'memory_status',
      'memory_task_context',
    ])

    let committed
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' }, requestHeader: () => committed }
    host.sessions.get = (id) => id === session.id ? session : undefined
    await host.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    await host.emit('session/event', session, { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } })
    await host.emit('session/event', session, {
      type: 'user/message', seq: 3,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    assert.equal(session.requestHeader(), undefined, 'the actual Host order admits the first user message before the header')
    committed = { config: { provider: 'mock', model: 'mock' } }
    await host.emit('session/event', session, { type: 'request/header', seq: 4, data: { header: committed, reason: 'initial' } })
    await host.emit('session/event', session, {
      type: 'assistant/message', seq: 5,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }], source: { provider: 'mock', model: 'mock' } } },
    })
    await host.emit('session/event', session, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const proof = openProjectStore(path.join(root, 'memory-tdai'), projectIdentity(cwd).key, projectIdentity(cwd))
    try {
      const user = proof.db.prepare("SELECT id, provider, model, turn FROM l0_messages WHERE role = 'user'").get()
      assert.equal(user.provider, null); assert.equal(user.model, null); assert.equal(user.turn, null, 'capture provenance stays unchanged')
      const binding = proof.db.prepare('SELECT * FROM extraction_source_routes WHERE source_id = ?').get(user.id)
      assert.equal(binding.session_id, 's1'); assert.equal(binding.turn, 1); assert.equal(binding.step, 1)
      assert.equal(binding.capture_seq, 3); assert.equal(binding.request_seq, 4); assert.equal(binding.evidence_kind, 'request/header')
      assert.equal(proof.extractionJobs()[0].status, 'completed')
    } finally { proof.close() }

    // A distinct session's real pre-step hook reads the approved, source-backed result.
    const receivingSession = { id: 's2', header: { cwd, agentPreset: 'agent-mock' } }
    const payload = {
      agent: { session: receivingSession },
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '前端用什么包管理器？' }], source: { kind: 'user' } }],
      step: 1,
      turn: 2,
    }
    const decisions = await host.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages: payload.messages }))
    const decision = decisions[0]
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    const injected = decision.messages[1]
    assert.equal(injected.source.kind, 'memory')
    assert.match(injected.content[0].text, /memory-context/)
    assert.match(injected.content[0].text, /pnpm/)

    for (const dispose of host.disposers) dispose()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('pre-step rebuilds retained memory context from current readable revisions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-plugin-recall-context-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-plugin-recall-project-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  let seed
  let updated
  const hosts = []
  const closedHosts = new Set()
  const budget = 240
  const ownMemoryMessages = (messages) => messages.filter((message) => message.source?.kind === 'memory' && message.source?.plugin === 'memory-tdai')
  const userMessage = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const refsIn = (messages) => [...messages.flatMap((message) => [...message.content[0].text.matchAll(/\[([^\]@]+)@r(\d+)\]/gu)])]
    .map((match) => ({ id: match[1], revision: Number(match[2]) }))
  async function preStep(host, session, messages, step) {
    const payload = { agent: { session }, messages, step, turn: 2 }
    const [decision] = await host.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages: payload.messages }))
    return decision
  }
  function closeHost(host) {
    if (closedHosts.has(host)) return
    closedHosts.add(host)
    for (const dispose of host.disposers) dispose()
  }
  try {
    const project = projectIdentity(cwd)
    seed = openProjectStore(root, project.key, project)
    const alphaSource = seed.recordL0({ sessionId: 's1', role: 'user', content: 'Synthetic source for the alpha fact.', agentPreset: 'regular-agent' })
    const alpha = seed.addMemory({ content: 'integration recall marker alpha original fact.', kind: 'preference', confidence: 0.9,
      status: 'approved', sourceMessageIds: [alphaSource], sourceVerified: true }).record
    const beta = seed.addMemory({ content: 'integration recall marker beta fact.', kind: 'preference', confidence: 0.9, status: 'approved' }).record
    const gammaSource = seed.recordL0({ sessionId: 's1', role: 'user', content: 'Synthetic source for the gamma fact.', agentPreset: 'private-agent' })
    const gamma = seed.addMemory({ content: 'integration recall marker gamma private fact.', kind: 'preference', confidence: 0.9,
      status: 'approved', sourceMessageIds: [gammaSource], sourceVerified: true }).record
    seed.close()
    seed = undefined

    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }
    const firstHost = createHost(cwd)
    hosts.push(firstHost)
    apply(firstHost, { dataDir: root, mode: 'review', extraction: { enabled: false }, capture: { excludeAgents: [] },
      recall: { enabled: true, minScore: 0, maxResults: 5, maxTokens: budget, dedupeSession: true, includePersona: false } })

    const first = await preStep(firstHost, session, [userMessage('u1', 'integration recall marker')], 1)
    const firstBlocks = ownMemoryMessages(first.messages)
    assert.equal(firstBlocks.length, 1, 'the first pre-step adds one memory packet')
    const firstText = firstBlocks[0].content[0].text
    assert.match(firstText, /alpha original fact/u)
    assert.match(firstText, /beta fact/u)
    assert.match(firstText, /gamma private fact/u)
    assert.deepEqual(refsIn(firstBlocks).map((reference) => reference.id).sort(), [alpha.id, beta.id, gamma.id].map((id) => globalMemoryKey(project.key, id)).sort())
    assert.ok(estimateTokens(firstText) <= budget, 'the injected packet stays within the configured final budget')

    const retained = await preStep(firstHost, session, [userMessage('u2', 'integration recall marker'), ...firstBlocks], 2)
    const retainedBlocks = ownMemoryMessages(retained.messages)
    assert.equal(retainedBlocks.length, 1, 'a carried packet is replaced by one refreshed packet')
    const retainedText = retainedBlocks[0].content[0].text
    const retainedIds = refsIn(retainedBlocks).map((reference) => reference.id)
    assert.deepEqual(retainedIds.sort(), [alpha.id, beta.id, gamma.id].map((id) => globalMemoryKey(project.key, id)).sort(), 'the packet has one copy of each current memory reference')
    for (const fact of ['alpha original fact', 'beta fact', 'gamma private fact']) {
      assert.equal(retainedText.split(fact).length - 1, 1, `the refreshed packet contains one body for ${fact}`)
    }
    assert.ok(estimateTokens(retainedText) <= budget, 'replacement packet is budgeted as a whole')

    const withoutPriorBlock = await preStep(firstHost, session, [userMessage('u3', 'integration recall marker')], 3)
    const reinjected = ownMemoryMessages(withoutPriorBlock.messages)
    assert.equal(reinjected.length, 1, 'a previous formatter result does not suppress recall when its block is absent')
    assert.deepEqual(refsIn(reinjected).map((reference) => reference.id).sort(), [alpha.id, beta.id, gamma.id].map((id) => globalMemoryKey(project.key, id)).sort())

    closeHost(firstHost)
    updated = openProjectStore(root, project.key, project)
    const revision = updated.proposeRevision({ memoryId: alpha.id, expectedRevision: alpha.revision,
      content: 'integration recall marker alpha revised fact.', sourceMessageIds: [alphaSource], reason: 'Synthetic revision for pre-step revalidation.' })
    updated.approveRevision(revision.id)
    updated.forget(beta.id)
    updated.close()
    updated = undefined

    const currentHost = createHost(cwd)
    hosts.push(currentHost)
    apply(currentHost, { dataDir: root, mode: 'review', extraction: { enabled: false }, capture: { excludeAgents: ['private-*'] },
      recall: { enabled: true, minScore: 0, maxResults: 5, maxTokens: budget, dedupeSession: true, includePersona: false } })
    const refreshed = await preStep(currentHost, session, [userMessage('u4', 'integration recall marker'), ...firstBlocks], 4)
    const refreshedBlocks = ownMemoryMessages(refreshed.messages)
    assert.equal(refreshedBlocks.length, 1, 'current readable recall is emitted as one packet')
    const refreshedText = refreshedBlocks[0].content[0].text
    assert.match(refreshedText, /alpha revised fact/u)
    assert.doesNotMatch(refreshedText, /alpha original fact|beta fact|gamma private fact/u, 'stale, forgotten, and newly excluded bodies are not echoed')
    assert.deepEqual(refsIn(refreshedBlocks).map((reference) => reference.id), [globalMemoryKey(project.key, alpha.id)])
    assert.equal(refsIn(refreshedBlocks)[0].revision, alpha.revision + 1)
    assert.equal(refreshedText.split('alpha revised fact').length - 1, 1, 'the refreshed body appears once')
    assert.ok(estimateTokens(refreshedText) <= budget, 'revalidated context stays within the final budget')

    const noUser = await preStep(currentHost, session, firstBlocks, 5)
    assert.equal(ownMemoryMessages(noUser.messages).length, 0, 'a context-only step removes bodies that are no longer readable')
    assert.doesNotMatch(noUser.messages.map((message) => message.content?.[0]?.text ?? '').join('\n'),
      /alpha original fact|beta fact|gamma private fact/u)
  } finally {
    seed?.close()
    updated?.close()
    for (const host of hosts) closeHost(host)
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
