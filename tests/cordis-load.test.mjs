import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { sourceAwareStream } from './helpers.mjs'
import { projectIdentity } from '../lib/project.js'
import { openProjectStoreReadOnly } from '../lib/store.js'

test('real restricted Cordis contexts use Host profile identity for default data isolation', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tdai-cordis-profiles-'))
  const cwd = path.join(home, 'workspace'), key = projectIdentity(cwd).key
  mkdirSync(cwd)
  const instances = []
  try {
    for (const name of ['a', 'b']) {
      const profile = path.join(home, 'profiles', name); mkdirSync(profile, { recursive: true })
      const root = new Context(), session = { id: `session-${name}`, header: { cwd, agentPreset: 'agent-mock' } }
      root.provide('tools', { register() { return () => {} } })
      root.provide('sessions', { get: () => session })
      root.provide('dshHomePath', (...segments) => path.join(home, ...segments))
      root.provide('profileContext', { dir: profile })
      const fiber = await root.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply },
        { extraction: { enabled: false }, capture: { excludeAgents: [] } })
      instances.push({ root, fiber })
      fiber.ctx.emit('session/event', session, { type: 'user/message', seq: 1,
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Synthetic profile-${name} source.` }] } })
      const expected = path.join(profile, 'memory-tdai')
      assert.equal(existsSync(path.join(expected, 'projects', key, 'memory.db')), true)
      const store = openProjectStoreReadOnly(expected, key)
      try {
        assert.equal(store.unextracted(session.id).length, 1)
        assert.equal(store.unextracted(`session-${name === 'a' ? 'b' : 'a'}`).length, 0)
      } finally { store.close() }
    }
  } finally {
    for (const { root, fiber } of instances.reverse()) { await fiber.dispose(); await root.fiber.dispose() }
    rmSync(home, { recursive: true, force: true })
  }
})

test('plugin loads as a real Cordis plugin with injected Host services', async () => {
  const root = new Context()
  const temp = mkdtempSync(path.join(os.tmpdir(), 'tdai-cordis-'))
  const registeredTools = []
  const sections = []
  root.provide('tools', {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  })
  root.provide('llm', { stream: sourceAwareStream((sourceIds) => ({ memories: [{ content: '用户偏好使用 pnpm 管理项目。', kind: 'preference', confidence: 0.93, source_message_ids: sourceIds }] })) })
  root.provide('sessions', {
    get() {
      return { id: 's1', header: { cwd: temp, agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }
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
      { mode: 'balanced', autoApproveConfidence: 0.5, extraction: { everyNConversations: 1, minTurnChars: 0, provider: 'mock', model: 'mock' },
        budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 } },
    )
    assert.ok(fiber)
    assert.equal(registeredTools.length, 11)
    assert.equal(sections.length, 1)

    const session = { id: 's1', header: { cwd: temp, agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }
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
