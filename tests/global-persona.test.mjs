import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'

test('opt-in global persona is generated across projects and used when a project has none', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-global-'))
  let runtime
  try {
    const a = projectIdentity(path.join(process.cwd(), 'project-a'))
    const b = projectIdentity(path.join(process.cwd(), 'project-b'))
    const storeA = openProjectStore(root, a.key, a)
    const storeB = openProjectStore(root, b.key, b)
    for (const content of ['用户偏好 TypeScript。', '插件必须跨平台。', '记忆先审核。']) {
      storeA.addMemory({ content, kind: 'preference', confidence: 0.9, status: 'approved', scene: 'workflow' })
    }
    storeB.addMemory({ content: '后台任务必须有界队列。', kind: 'decision', confidence: 0.9, status: 'approved', scene: 'backend' })
    storeB.addMemory({ content: '项目使用 pnpm。', kind: 'project', confidence: 0.9, status: 'approved', scene: 'backend' })
    storeA.close()
    storeB.close()

    const personaText = '## 跨项目画像\n偏好 TypeScript、跨平台、先审核；后台任务使用有界队列。'
    const streaming = async function* () {
      yield { type: 'text-delta', index: 0, text: personaText }
      yield { type: 'usage', usage: { inputTokens: 450, outputTokens: 90 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    runtime = new MemoryRuntime(
      {
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        llm: { stream: () => streaming() },
        get() { return undefined },
      },
      resolveConfig({ persona: { global: true }, extraction: { provider: 'mock', model: 'mock' }, budget: { manualDailyTokens: 1_000_000, manualDailyTasks: 100 } }),
      root,
    )
    const generated = await runtime.refreshGlobalPersona()
    assert.equal(generated.sourceCount, 5)
    assert.match(generated.content, /TypeScript/)
    assert.match(runtime.globalPersona()?.content ?? '', /跨项目画像/)
    const snapshot = runtime.dashboard()
    assert.match(snapshot.globalPersona?.content ?? '', /有界队列/)
    assert.equal(snapshot.settings.globalPersona, true)

    const hits = runtime.recall(b.cwd, '队列', 'global-session')
    assert.ok(hits.length >= 1)
    const block = runtime.formatRecall(b.cwd, hits, 'global-session')
    assert.match(block, /persona-summary/)
    assert.match(block, /跨项目画像/)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
