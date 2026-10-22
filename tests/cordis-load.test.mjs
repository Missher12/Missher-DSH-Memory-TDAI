import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

test('plugin loads as a real Cordis plugin with injected Host services', async () => {
  const root = new Context()
  const temp = mkdtempSync(path.join(os.tmpdir(), 'tdai-cordis-'))
  const registeredTools = []
  const sections = []
  const stream = async function* () {
    yield {
      type: 'text-delta',
      index: 0,
      text: '{"memories":[{"content":"用户偏好使用 pnpm 管理项目。","kind":"preference","confidence":0.93}]}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  root.provide('tools', {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  })
  root.provide('llm', { stream: () => stream() })
  root.provide('sessions', {
    get() {
      return { id: 's1', header: { cwd: temp }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }
    },
  })
  root.provide('systemPrompt', {
    section(section) {
      sections.push(section)
      return () => {}
    },
  })
  root.provide('dshHomePath', (...segments) => path.join(temp, ...segments))

  let fiber
  try {
    fiber = await root.plugin(
      { name: plugin.name, inject: plugin.inject, apply: plugin.apply },
      { mode: 'balanced', autoApproveConfidence: 0.5, extraction: { everyNConversations: 1, minTurnChars: 0 } },
    )
    assert.ok(fiber)
    assert.equal(registeredTools.length, 6)
    assert.equal(sections.length, 1)

    const session = { id: 's1', header: { cwd: temp } }
    fiber.ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    fiber.ctx.emit('session/event', session, {
      type: 'assistant/message',
      seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
    })
    fiber.ctx.emit('session/event', session, { type: 'turn/end', seq: 3, data: { turn: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 2500))

    const payload = {
      agent: { session },
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '前端用 pnpm 吗？' }], source: { kind: 'user' } }],
    }
    const decision = await root.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: payload.messages }))
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    assert.match(decision.messages[1].content[0].text, /pnpm/)
  } finally {
    await fiber?.dispose()
    await root.fiber.dispose()
    rmSync(temp, { recursive: true, force: true })
  }
})
