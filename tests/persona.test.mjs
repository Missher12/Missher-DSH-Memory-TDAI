import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { DashboardSnapshotSchema } from '../lib/remote-contract.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'

test('L3 persona generation uses approved memories and appears in the dashboard', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-persona-'))
  let runtime
  try {
    const project = projectIdentity(process.cwd())
    const store = openProjectStore(root, project.key, project)
    for (const [index, content] of ['用户偏好 TypeScript。', '插件必须跨平台。', '记忆需要先审核再注入。'].entries()) {
      const sourceId = store.recordL0({ sessionId: 'persona-source', role: 'user', content: `Synthetic source ${index}: ${content}` })
      store.addMemory({ content, kind: 'preference', confidence: 0.9, status: 'approved', scene: 'workflow',
        sourceMessageIds: [sourceId], sourceVerified: true })
    }
    store.refreshScenes()
    store.close()
    const personaText = '## 核心特征\n一位偏好 TypeScript 和跨平台方案的插件作者。\n\n## 工作方式\n- 记忆先审核。'
    const streaming = async function* () {
      yield { type: 'text-delta', index: 0, text: personaText.slice(0, 20) }
      yield { type: 'text-delta', index: 0, text: personaText.slice(20) }
      yield { type: 'usage', usage: { inputTokens: 320, outputTokens: 75 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    runtime = new MemoryRuntime(
      {
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        llm: { stream: () => streaming() },
        get() { return undefined },
      },
      resolveConfig({ extraction: { provider: 'mock', model: 'mock' }, budget: { manualDailyTokens: 1_000_000, manualDailyTasks: 100 } }),
      root,
    )
    const persona = await runtime.refreshPersona(project.key)
    assert.match(persona.content, /TypeScript/)
    assert.equal(persona.sourceCount, 3)
    const snapshot = runtime.dashboard()
    assert.equal(snapshot.personas.length, 1)
    assert.equal(snapshot.personas[0].projectName, project.name)
    assert.equal(snapshot.scenes.length, 1)
    assert.equal(snapshot.scenes[0].name, 'workflow')
    assert.equal(snapshot.scenes[0].memoryCount, 3)
    assert.equal(DashboardSnapshotSchema.safeParse(snapshot).success, true, JSON.stringify(DashboardSnapshotSchema.safeParse(snapshot).error))
    const hits = runtime.recall(project.cwd, 'TypeScript', 'persona-session')
    assert.ok(hits.length >= 1)
    const block = runtime.formatRecall(project.cwd, hits, 'persona-session')
    assert.match(block, /persona-summary/)
    assert.match(block, /TypeScript/)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
