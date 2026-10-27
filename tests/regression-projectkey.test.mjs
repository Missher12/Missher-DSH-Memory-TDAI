import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { isValidProjectKey, projectDbPath, projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { MemoryRuntime } from '../lib/memory.js'
import { endTurnAfterQuietWindow, scriptedContext, sourceAwareStream, userEvent, assistantEvent } from './helpers.mjs'

function cfg() {
  return resolveConfig({
    mode: 'balanced',
    extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0, provider: 'mock', model: 'mock' },
    budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
  })
}

test('shared project key validator rejects traversal/absolute/separator-like keys', () => {
  const valid = ['project-a', '中文项目', 'a.b', '.hidden', 'a b', 'a-b_c.d', 'x'.repeat(160), 'a/b'.replace('/', '\u2215')]
  for (const key of valid) {
    assert.equal(isValidProjectKey(key), true, `expected valid: ${JSON.stringify(key)}`)
  }
  const invalid = ['', '   ', 'a b ', ' a', '.', '..', '../evil', 'a/b', 'a\\b', 'C:evil', 'a:b', 'a\u0000b', '\x01abc', 'x'.repeat(161)]
  for (const key of invalid) {
    assert.equal(isValidProjectKey(key), false, `expected invalid: ${JSON.stringify(key)}`)
  }
  assert.equal(isValidProjectKey(undefined), false)
  assert.equal(isValidProjectKey(42), false)
})

test('store path builder keeps the database inside <root>/projects', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-keys-'))
  try {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-keys-outside-'))
    mkdirSync(path.join(root, 'projects'), { recursive: true })
    // A pre-planted symlink pointing the "evil" project directory outside the store.
    const evil = path.join(root, 'projects', 'evil')
    symlinkSync(outside, evil, 'dir')
    assert.throws(() => projectDbPath(root, 'evil'), /escapes the store root/)
    assert.throws(() => openProjectStore(root, 'evil'), /escapes the store root/)
    assert.throws(() => openProjectStore(root, '../evil'), /invalid project key/)
    assert.throws(() => openProjectStore(root, 'C:\\evil'), /invalid project key/)
    // A broken symlink (target missing) is refused too: it cannot be verified.
    const dead = path.join(root, 'projects', 'dead')
    symlinkSync(path.join(outside, 'missing'), dead, 'dir')
    assert.throws(() => projectDbPath(root, 'dead'), /not readable/)
    // A pre-planted memory.db symlink whose target escapes the store is refused,
    // and no database is ever written to the outside target.
    const escapedDbDir = path.join(root, 'projects', 'escapedb')
    mkdirSync(escapedDbDir, { recursive: true })
    writeFileSync(path.join(outside, 'out.db'), '', 'utf8')
    symlinkSync(path.join(outside, 'out.db'), path.join(escapedDbDir, 'memory.db'), 'file')
    assert.throws(() => projectDbPath(root, 'escapedb'), /database escapes the store root/)
    assert.throws(() => openProjectStore(root, 'escapedb'), /database escapes the store root/)
    assert.equal(readFileSync(path.join(outside, 'out.db'), 'utf8'), '', 'the outside target is never opened as a database')
    // A dangling memory.db symlink is refused and never replaced by a fresh db.
    const danglingDbDir = path.join(root, 'projects', 'dangdb')
    mkdirSync(danglingDbDir, { recursive: true })
    symlinkSync(path.join(outside, 'missing.db'), path.join(danglingDbDir, 'memory.db'), 'file')
    assert.throws(() => projectDbPath(root, 'dangdb'), /dangling symlink/)
    assert.throws(() => openProjectStore(root, 'dangdb'), /dangling symlink/)
    assert.equal(existsSync(path.join(outside, 'missing.db')), false)
    // A legitimate project inside the store still works, including non-ASCII keys.
    const chineseKey = '中文项目'
    const dir = path.join(root, 'projects', chineseKey)
    mkdirSync(dir, { recursive: true })
    const file = projectDbPath(root, chineseKey)
    assert.ok(file.startsWith(path.join(root, 'projects')), 'Chinese keys resolve inside the store root')
    assert.equal(path.dirname(file), dir)
    assert.equal(path.basename(file), 'memory.db')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review/export/refreshPersona on an unknown project key fail clearly and create no database', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-unknown-'))
  let runtime
  try {
    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg() }).ctx, cfg(), root)
    assert.throws(() => runtime.review('missing-key', 'm_1', 'approve'), /unknown project: missing-key/)
    assert.throws(() => runtime.exportProject('missing-key'), /unknown project: missing-key/)
    await assert.rejects(runtime.refreshPersona('missing-key'), /unknown project: missing-key/)
    const stub = path.join(root, 'projects', 'missing-key')
    assert.equal(existsSync(path.join(stub, 'memory.db')), false)
    assert.equal(existsSync(stub), false, 'no directory is created for an unknown project')
    // Invalid keys are refused before any path resolution at all.
    assert.throws(() => runtime.review('../secret', 'm_1', 'approve'), /invalid project key/)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a Chinese project key works end-to-end for capture, extraction and recall', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-cn-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-cn-project-'))
  let runtime
  try {
    const chineseDir = path.join(os.tmpdir(), `项目目录-${path.basename(cwd)}`)
    mkdirSync(chineseDir, { recursive: true })
    const project = projectIdentity(chineseDir)
    assert.equal(isValidProjectKey(project.key), true, `key ${JSON.stringify(project.key)} must be legal`)
    const session = { id: 's1', header: { cwd: chineseDir, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({
      script: [sourceAwareStream((sourceIds) => ({ memories: [{ content: '团队使用中文项目目录。', kind: 'project', confidence: 0.9, source_message_ids: sourceIds }] }))],
      config: cfg(),
      session,
    })
    runtime = new MemoryRuntime(scripted.ctx, cfg(), root)
    runtime.onSessionEvent(session, userEvent(1, '记住：团队使用中文项目目录。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    await runtime.runExtraction('s1')
    const dbFile = projectDbPath(root, project.key)
    assert.equal(existsSync(dbFile), true)
    const store = openProjectStore(root, project.key, project)
    assert.equal(store.unextracted('s1').length, 0)
    assert.equal(store.list('approved', 20).length, 1)
    store.close()
    assert.equal(runtime.recall(chineseDir, '中文项目目录').length, 1, 'recall works for the Chinese-keyed project')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    rmSync(path.join(os.tmpdir(), `项目目录-${path.basename(cwd)}`), { recursive: true, force: true })
  }
})
