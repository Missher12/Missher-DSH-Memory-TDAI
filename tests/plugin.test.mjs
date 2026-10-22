import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

function createHost(cwd) {
  const listeners = new Map()
  const tools = []
  const disposers = []
  const streaming = async function* () {
    yield {
      type: 'text-delta',
      index: 0,
      text: '{"memories":[{"content":"用户偏好使用 pnpm 管理前端项目。","kind":"preference","confidence":0.93}]}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const http = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    llm: { stream: () => streaming() },
    sessions: { get: () => ({ id: 's1', header: { cwd }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }) },
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
      recall: { enabled: true, minScore: 0 },
    })
    assert.deepEqual(host.toolsList.map((tool) => tool.name).sort(), [
      'memory_get',
      'memory_profile',
      'memory_propose',
      'memory_read_raw',
      'memory_search',
      'memory_status',
    ])

    const session = { id: 's1', header: { cwd } }
    await host.emit('session/event', session, {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    await host.emit('session/event', session, {
      type: 'assistant/message',
      seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
    })
    await host.emit('session/event', session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 1600))

    const payload = {
      agent: { session },
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
