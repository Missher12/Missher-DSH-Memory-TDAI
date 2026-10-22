import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openProjectStore } from '../lib/store.js'

test('store keeps Chinese memories searchable and project-isolated', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-'))
  try {
    const a = openProjectStore(root, 'project-a')
    const b = openProjectStore(root, 'project-b')
    const approved = a.addMemory({
      content: '用户偏好使用 pnpm 管理前端项目，并且测试必须离线运行。',
      kind: 'preference',
      confidence: 0.9,
      status: 'approved',
    })
    const candidate = a.addMemory({
      content: '后台任务必须使用有界队列，避免无限堆积。',
      kind: 'decision',
      confidence: 0.6,
      status: 'candidate',
    })
    assert.equal(approved.created, true)
    assert.equal(candidate.created, true)

    const hits = a.search('pnpm 前端', 5)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, approved.record.id)
    assert.ok(hits[0].score > 0)

    assert.equal(a.search('有界队列', 5).length, 0, 'candidates must not be injected')
    assert.equal(b.search('pnpm 前端', 5).length, 0, 'projects must not share memories')

    const approvedCandidate = a.approve(candidate.record.id)
    assert.equal(approvedCandidate?.status, 'approved')
    assert.equal(a.search('有界队列', 5).length, 1)

    const forgotten = a.forget(approved.record.id)
    assert.equal(forgotten?.status, 'forgotten')
    assert.equal(a.search('pnpm 前端', 5).length, 0)

    const duplicate = a.addMemory({
      content: '用户偏好使用 pnpm 管理前端项目，并且测试必须离线运行。',
      status: 'approved',
    })
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.record.status, 'forgotten', 'forgotten memories stay forgotten')

    const stats = a.stats()
    assert.equal(stats.approved, 1)
    assert.equal(stats.forgotten, 1)
    assert.equal(stats.candidates, 0)

    a.recordL0({ sessionId: 's1', role: 'user', content: '记一下：测试必须离线运行。' })
    assert.equal(a.stats().l0Messages, 1)
    a.close()
    b.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
