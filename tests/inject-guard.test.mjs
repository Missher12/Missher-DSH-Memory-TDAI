import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { sourceAwareStream } from './helpers.mjs'

/**
 * Mimic the Cordis fiber guard: optional services are available through
 * `ctx.get(name)`, but reading `ctx.<name>` throws unless the plugin injected
 * that service. The Host loader enforces this even though the in-repo Cordis
 * test harness currently exposes root properties directly.
 */
function guardedContext(services) {
  const listeners = new Map()
  const tools = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(names, callback) {
      callback(ctx)
    },
    get(name) {
      return services[name]
    },
  }
  for (const name of ['systemPrompt', 'llm', 'sessions']) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() {
        throw new Error(`cannot get property "${name}" without inject`)
      },
    })
  }
  return { ctx, listeners, tools, disposers }
}

test('optional Host services are read through ctx.get, not direct properties', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-inject-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-inject-project-'))
  let disposers = []
  try {
    const session = {
      id: 's1',
      header: { cwd, agentPreset: 'agent-mock' },
      requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
    }
    const services = {
      dshHomePath: (...segments) => path.join(root, ...segments),
      systemPrompt: {
        section() {
          return () => {}
        },
        getSectionOrder() {
          return 0
        },
      },
      sessions: { get: () => session },
      llm: { stream: sourceAwareStream((sourceIds) => ({ memories: [{ content: '用户偏好使用 pnpm 管理前端项目。', kind: 'preference', confidence: 0.93, source_message_ids: sourceIds }] })) },
    }
    const guarded = guardedContext(services)
    disposers = guarded.disposers
    apply(guarded.ctx, {
      dataDir: root,
      mode: 'balanced',
      autoApproveConfidence: 0.5,
      extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0 },
      budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
      recall: { enabled: true, minScore: 0 },
    })
    assert.equal(guarded.tools.length, 11)

    const emit = (event) => Promise.all((guarded.listeners.get('session/event') ?? []).map((listener) => listener(session, event)))
    await emit({
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    await emit({
      type: 'assistant/message',
      seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
    })
    await emit({ type: 'turn/end', seq: 3, data: { turn: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 1600))

    const payload = {
      agent: { session },
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '前端用什么包管理器？' }], source: { kind: 'user' } }],
    }
    const preStep = guarded.listeners.get('agent/pre-step') ?? []
    assert.equal(preStep.length, 1)
    const decision = await preStep[0](payload, async () => ({ kind: 'enter', messages: payload.messages }))
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    assert.match(decision.messages[1].content[0].text, /pnpm/)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
