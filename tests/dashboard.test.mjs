import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { DashboardSnapshotSchema } from '../lib/remote-contract.js'
import { openProjectStore } from '../lib/store.js'

test('dashboard aggregates projects, activity, provenance, and token compression', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-dashboard-'))
  let runtime
  try {
    const project = { key: 'proj-a', name: 'project-a', cwd: process.cwd() }
    const store = openProjectStore(root, project.key, project)
    store.addMemory({ content: '用户偏好使用 pnpm。', kind: 'preference', confidence: 0.9, status: 'approved' })
    store.addMemory({ content: '待审核的项目约束。', kind: 'project', confidence: 0.5, status: 'candidate' })
    store.recordL0({ sessionId: 's1', role: 'user', content: '前端用什么包管理器？' })
    store.recordL0({ sessionId: 's1', role: 'user', content: '前端用什么包管理器？' })
    store.recordEvent('inject', 1, 12, 40)
    store.close()

    runtime = new MemoryRuntime(
      { logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({}),
      root,
    )
    const snapshot = runtime.dashboard()
    assert.equal(snapshot.totals.projects, 1)
    assert.equal(snapshot.totals.memories, 2)
    assert.equal(snapshot.totals.approved, 1)
    assert.equal(snapshot.totals.candidates, 1)
    assert.equal(snapshot.totals.sessions, 1)
    assert.equal(snapshot.totals.repeatedQuestions, 1)
    assert.equal(snapshot.totals.injectedTokens, 12)
    assert.equal(snapshot.totals.savedTokens, 28)
    assert.equal(snapshot.sources.find((source) => source.source === 'manual')?.count, 2)
    assert.equal(snapshot.candidates[0].projectName, 'project-a')
    assert.equal(snapshot.longestSession?.messages, 2)
    assert.equal(snapshot.activity.length, 1)
    assert.equal(DashboardSnapshotSchema.safeParse(snapshot).success, true, JSON.stringify(DashboardSnapshotSchema.safeParse(snapshot).error))

    assert.equal(runtime.review('proj-a', snapshot.candidates[0].id, 'approve')?.status, 'approved')
    assert.equal(runtime.dashboard().totals.approved, 2)
    const exported = runtime.exportProject('proj-a')
    assert.match(exported.content, /dsh-memory-tdai\/v1/)
    assert.match(exported.content, /pnpm/)

    runtime.updateSettings({ mode: 'review', recallMaxTokens: 300, dedupeSession: false, extractionEveryN: 5 })
    const after = runtime.dashboard()
    assert.equal(after.settings.mode, 'review')
    assert.equal(after.settings.recallMaxTokens, 300)
    assert.equal(after.settings.dedupeSession, false)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
