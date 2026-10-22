/**
 * Manual smoke test under the exact DSH Electron Node runtime.
 *
 * Run:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "D:\Deepseek-Harness\DeepSeek Harness.exe" scripts/electron-smoke.mjs
 *
 * It uses a temporary directory and synthetic data only.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { openProjectStore } from '../lib/store.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-electron-'))
try {
  const cwd = process.cwd()
  const store = openProjectStore(root, 'electron-project')
  store.addMemory({ content: '用户偏好使用 pnpm 管理前端项目。', kind: 'preference', confidence: 0.9, status: 'approved' })
  const hits = store.search('pnpm 前端', 5)
  assert.equal(hits.length, 1)
  store.close()

  const streaming = async function* () {
    yield {
      type: 'text-delta',
      index: 0,
      text: '{"memories":[{"content":"用户偏好使用 pnpm 管理前端项目。","kind":"preference","confidence":0.93}]}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: { stream: () => streaming() },
    sessions: { get: () => ({ id: 's1', header: { cwd }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) }) },
    get: () => undefined,
  }
  const runtime = new MemoryRuntime(
    ctx,
    resolveConfig({ mode: 'balanced', autoApproveConfidence: 0.5, extraction: { minTurnChars: 0 } }),
    root,
  )
  const session = { id: 's1', header: { cwd } }
  runtime.onSessionEvent(session, {
    type: 'user/message',
    seq: 1,
    data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
  })
  runtime.onSessionEvent(session, {
    type: 'assistant/message',
    seq: 2,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
  })
  await runtime.runExtraction('s1')
  const recalled = runtime.recall(cwd, 'pnpm')
  assert.ok(recalled.length >= 1)
  runtime.close()
  console.log(JSON.stringify({
    ok: true,
    node: process.versions.node,
    electron: process.versions.electron,
    modules: process.versions.modules,
    napi: process.versions.napi,
    fts: true,
    recalled: recalled.length,
  }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
