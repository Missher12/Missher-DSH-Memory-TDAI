import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'

function mockContext() {
  const streaming = async function* () {
    yield { type: 'text-delta', index: 0, text: '{"memories":[' }
    yield {
      type: 'text-delta',
      index: 0,
      text: '{"content":"用户偏好使用 pnpm 管理前端项目。","kind":"preference","confidence":0.93,"source_message_ids":["u_1"]}]}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: { stream: () => streaming() },
    sessions: {
      get() {
        return { id: 's1', header: { cwd: process.cwd() }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
      },
    },
    get() {
      return undefined
    },
  }
}

test('runtime captures a turn, extracts L1, auto-approves in balanced mode, and recalls it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-runtime-'))
  try {
    const config = resolveConfig({
      mode: 'balanced',
      autoApproveConfidence: 0.5,
      extraction: { minTurnChars: 0, enabled: true },
      recall: { enabled: true, minScore: 0 },
    })
    const runtime = new MemoryRuntime(mockContext(), config, root)
    const session = { id: 's1', header: { cwd: process.cwd() } }
    runtime.onSessionEvent(session, {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '以后前端都用 pnpm。' }], source: { kind: 'user' } },
    })
    runtime.onSessionEvent(session, {
      type: 'assistant/message',
      seq: 2,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，记录一下。' }] } },
    })
    await runtime.runExtraction('s1')

    const hits = runtime.recall(process.cwd(), 'pnpm 前端')
    assert.equal(hits.length, 1)
    const block = runtime.formatRecall(process.cwd(), hits)
    assert.ok(block.includes('<memory-context'))
    assert.ok(block.includes('pnpm'))
    assert.ok(block.includes('mem_'))

    const status = runtime.status()
    assert.equal(status.projects.length, 1)
    assert.equal(status.projects[0].stats.approved, 1)
    runtime.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
