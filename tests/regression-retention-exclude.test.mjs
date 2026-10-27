import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig, matchesAgentGlob } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { neverStream, scriptedContext, userEvent } from './helpers.mjs'

test('matchesAgentGlob semantics: * any sequence, ? exactly one, literal otherwise', () => {
  assert.equal(matchesAgentGlob('reviewer', '*'), true)
  assert.equal(matchesAgentGlob('anything.at.all', '*'), true)
  assert.equal(matchesAgentGlob('reviewer', 'reviewer'), true)
  assert.equal(matchesAgentGlob('reviewer', 'review?r'), true)
  assert.equal(matchesAgentGlob('reviewer', 'review*r'), true)
  assert.equal(matchesAgentGlob('reviewerx', 'review?r'), false)
  assert.equal(matchesAgentGlob('reviewer', 'review'), false)
  assert.equal(matchesAgentGlob('Reviewer', 'reviewer'), false, 'matching is case-sensitive')
  assert.equal(matchesAgentGlob('reviewer', 'review*'), true)
  assert.equal(matchesAgentGlob('reviewer', 'rev*wer'), true)
  assert.equal(matchesAgentGlob('rviewer', 'rev*wer'), false)
  assert.equal(matchesAgentGlob('reviewer', '*er'), true)
  assert.equal(matchesAgentGlob('review', '*er'), false)
  assert.equal(matchesAgentGlob('a.b', 'a?b'), true, 'the literal dot stays a dot')
  assert.equal(matchesAgentGlob('aXb', 'a?b'), true)
  assert.equal(matchesAgentGlob('a/b', 'a?b'), true, 'preset names are not paths, so ? matches any single character')
  assert.equal(matchesAgentGlob('', '*'), true, 'the empty preset is matched by the catch-all')
  assert.equal(matchesAgentGlob('', '?'), false)
})

function cfg(excludeAgents = [], retentionDays = 0) {
  return resolveConfig({
    mode: 'balanced',
    extraction: { enabled: true, minTurnChars: 0, provider: 'mock', model: 'mock' },
    capture: { enabled: true, excludeAgents },
    retention: { days: retentionDays },
  })
}

test('excluded sessions are neither captured nor sent to the model', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-exclude-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-exclude-project-'))
  let runtime
  try {
    const config = cfg(['*agent-mock', 'reviewer?'])
    const scripted = scriptedContext({ script: [neverStream], config })
    runtime = new MemoryRuntime(scripted.ctx, config, root)
    const excluded = { id: 's-excluded', header: { cwd, agentPreset: 'agent-mock' } }
    runtime.onSessionEvent(excluded, userEvent(1, '这条不应被捕获。'))
    runtime.onSessionEvent(excluded, userEvent(2, '这条也不应被捕获。'))
    const excludedReviewer = { id: 's-reviewer', header: { cwd, agentPreset: 'reviewer1' } }
    runtime.onSessionEvent(excludedReviewer, userEvent(3, 'reviewer 会话也不捕获。'))
    await runtime.runExtraction('s-excluded')
    await runtime.runExtraction('s-reviewer')
    assert.equal(scripted.calls.length, 0, 'no model call is made for excluded sessions')
    assert.equal(runtime.dashboard().totals.l0Messages, 0, 'excluded sessions record nothing at L0')

    const included = { id: 's-main', header: { cwd, agentPreset: 'codex-cli' } }
    runtime.onSessionEvent(included, userEvent(4, '主会话内容需要捕获。'))
    runtime.onSessionEvent(included, userEvent(5, '主会话更多内容。'))
    assert.equal(runtime.dashboard().totals.l0Messages, 2, 'non-excluded sessions capture normally')
    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s-main').length, 2)
    store.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('capture disabled records no L0 messages and opens no coverage window', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-capture-disabled-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-capture-disabled-project-'))
  let runtime
  try {
    const config = resolveConfig({ capture: { enabled: false }, extraction: { enabled: false } })
    runtime = new MemoryRuntime(scriptedContext({ script: [], config }).ctx, config, root)
    runtime.onSessionEvent({ id: 's-disabled', header: { cwd, agentPreset: 'agent-mock' } }, userEvent(1, '不应记录的消息。'))
    assert.equal(runtime.dashboard().totals.l0Messages, 0)
    assert.deepEqual(runtime.control.coverageWindows(0, Date.now() + 1000), [])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('retention.days = 0 never deletes anything', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-ret0-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-ret0-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = openProjectStore(root, project.key, project)
    store.recordL0({ sessionId: 's1', role: 'user', content: '很久以前的原文。', turn: 1, step: 1, createdAt: Date.now() - 40 * 24 * 3600 * 1000 })
    store.recordL0({ sessionId: 's1', role: 'user', content: '今天的原文。', turn: 2, step: 1 })
    store.addMemory({ content: '一条已审核记忆。', kind: 'fact', scene: 'x', confidence: 0.9, status: 'approved', source: 'manual' })
    store.addMemory({ content: '一条待审记忆。', kind: 'fact', scene: 'x', confidence: 0.4, status: 'candidate', source: 'manual' })
    store.addMemory({ content: '一条遗忘记忆。', kind: 'fact', scene: 'x', confidence: 0.5, status: 'forgotten', source: 'manual' })
    store.setPersona('画像内容。', 1, [])
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg([], 0) }).ctx, cfg([], 0), root)
    assert.equal(runtime.prune(0), 0)
    const reopened = openProjectStore(root, project.key, project)
    assert.equal(reopened.unextracted('s1').length, 2, 'L0 rows are kept when days is 0')
    assert.equal(reopened.stats().approved + reopened.stats().candidates + reopened.stats().forgotten, 3)
    assert.ok(reopened.scenes().length >= 1)
    assert.notEqual(reopened.persona(), null)
    assert.equal(reopened.persona()?.stale, true, 'a persona without source provenance is conservatively stale')
    reopened.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a positive retention period prunes only old L0 rows, never L1/scenes/persona', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-ret1-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-ret1-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = openProjectStore(root, project.key, project)
    store.recordL0({ sessionId: 's1', role: 'user', content: '超过保留期的原文。', turn: 1, step: 1, createdAt: Date.now() - 40 * 24 * 3600 * 1000 })
    store.addMemory({ content: '保留记忆。', kind: 'fact', scene: 'x', confidence: 0.9, status: 'approved', source: 'manual' })
    store.addMemory({ content: '保留候选。', kind: 'fact', scene: 'x', confidence: 0.4, status: 'candidate', source: 'manual' })
    store.addMemory({ content: '保留遗忘。', kind: 'fact', scene: 'x', confidence: 0.5, status: 'forgotten', source: 'manual' })
    store.setPersona('保留画像。', 2, [])
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg([], 30) }).ctx, cfg([], 30), root)
    const removed = runtime.prune(30)
    assert.equal(removed, 1, 'only the single old L0 row is pruned')
    const reopened = openProjectStore(root, project.key, project)
    assert.equal(reopened.unextracted('s1').length, 0)
    const stats = reopened.stats()
    assert.equal(stats.approved + stats.candidates + stats.forgotten, 3, 'L1 records are untouched by L0 retention')
    assert.ok(reopened.scenes().length >= 1, 'L2 scenes are untouched')
    assert.notEqual(reopened.persona(), null, 'L3 persona is untouched')
    assert.equal(reopened.persona()?.stale, true, 'the persona kept no provenance, so it stays conservatively stale')
    reopened.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
