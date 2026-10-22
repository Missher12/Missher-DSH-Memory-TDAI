import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'

const require = createRequire(import.meta.url)

function mockContext(cwd, memoryText = '用户偏好使用 pnpm 管理前端项目。', confidence = 0.93) {
  const streaming = async function* () {
    yield { type: 'text-delta', index: 0, text: '{"memories":[' }
    yield { type: 'text-delta', index: 0, text: `${JSON.stringify({ content: memoryText, kind: 'preference', confidence })}]}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: { stream: () => streaming() },
    sessions: {
      get: () => ({
        id: 's1',
        header: { cwd },
        requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
      }),
    },
    get() {
      return undefined
    },
  }
}

function captureTurn(runtime, cwd, userText = '以后前端都用 pnpm。') {
  const session = { id: 's1', header: { cwd } }
  runtime.onSessionEvent(session, {
    type: 'user/message',
    seq: 1,
    data: { role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } },
  })
  runtime.onSessionEvent(session, {
    type: 'assistant/message',
    seq: 2,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
  })
  return session
}

test('restart reloads unextracted L0 and extracts it once', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-restart-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-restart-project-'))
  let first
  let second
  try {
    const config = resolveConfig({
      mode: 'balanced',
      autoApproveConfidence: 0.5,
      extraction: { enabled: true, minTurnChars: 0 },
      recall: { enabled: true, minScore: 0 },
    })
    const session = { id: 's1', header: { cwd } }

    first = new MemoryRuntime(mockContext(cwd), config, root)
    first.onSessionEvent(session, {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    first.close()
    first = undefined

    second = new MemoryRuntime(mockContext(cwd), config, root)
    second.onSessionEvent(session, {
      type: 'assistant/message',
      seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
    })
    await second.runExtraction('s1')

    const hits = second.recall(cwd, 'pnpm')
    assert.equal(hits.length, 1, 'the pre-restart L0 message must be extracted after reload')
    assert.equal(second.recall(cwd, 'pnpm').length, 1, 'extraction is idempotent')
  } finally {
    first?.close()
    second?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('review mode requires approval before recall', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-review-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-review-project-'))
  let runtime
  try {
    const config = resolveConfig({
      mode: 'review',
      extraction: { enabled: true, minTurnChars: 0 },
      recall: { enabled: true, minScore: 0 },
    })
    runtime = new MemoryRuntime(mockContext(cwd, '用户偏好使用 pnpm 管理前端项目。', 0.99), config, root)
    captureTurn(runtime, cwd)
    await runtime.runExtraction('s1')

    assert.equal(runtime.recall(cwd, 'pnpm').length, 0, 'candidates must not be recalled')
    const snapshot = runtime.dashboard()
    assert.equal(snapshot.candidates.length, 1)
    const candidate = snapshot.candidates[0]
    const approved = runtime.review(candidate.projectKey, candidate.id, 'approve')
    assert.equal(approved?.status, 'approved')
    assert.equal(runtime.recall(cwd, 'pnpm').length, 1)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('recall dedupes within a session and caps results', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dedupe-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-dedupe-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = openProjectStore(root, project.key, project)
    for (const content of [
      '用户偏好使用 pnpm 管理前端项目。',
      '用户偏好使用 pnpm 管理后端脚本。',
      '用户偏好使用 pnpm 管理文档站点。',
    ]) {
      store.addMemory({ content, kind: 'preference', confidence: 0.9, status: 'approved' })
    }
    store.close()

    runtime = new MemoryRuntime(
      mockContext(cwd),
      resolveConfig({ recall: { enabled: true, minScore: 0, maxResults: 2, dedupeSession: true } }),
      root,
    )
    const first = runtime.recall(cwd, 'pnpm', 's1')
    assert.equal(first.length, 2, 'maxResults caps the query')
    const block = runtime.formatRecall(cwd, first, 's1')
    assert.ok(block?.includes('pnpm'))
    assert.equal(runtime.recall(cwd, 'pnpm', 's1').length, 0, 'already injected ids are skipped')
    assert.equal(runtime.recall(cwd, 'pnpm', 's2').length, 2, 'dedupe is per session')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('store upgrades a v1 database and keeps unextracted L0 rows', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-upgrade-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-upgrade-project-'))
  let store
  try {
    const project = { key: 'legacy', name: 'legacy', cwd }
    const file = path.join(root, 'projects', 'legacy', 'memory.db')
    mkdirSync(path.dirname(file), { recursive: true })
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE l0_messages (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        turn INTEGER,
        step INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');
      INSERT INTO l0_messages(id, project_key, session_id, role, content, created_at)
      VALUES ('l0_legacy', 'legacy', 's1', 'user', '旧库中的未抽取消息。', ${Date.now()});
    `)
    db.close()

    store = openProjectStore(root, 'legacy', project)
    assert.equal(store.stats().schemaVersion, 2)
    const rows = store.unextracted('s1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].content, '旧库中的未抽取消息。')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
