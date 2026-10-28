import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openProjectStore, openProjectStoreReadOnly } from '../lib/store.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

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

test('dashboard event pages use a bounded sentinel and do not report another page for an exact multiple', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-event-page-sentinel-'))
  let store
  try {
    store = openProjectStore(root, 'event-page-sentinel')
    for (let index = 0; index < 15; index += 1) store.recordEvent('capture', 1, 0, 0, Date.UTC(2026, 9, 23, 12) + index)

    const page = store.dashboardReadEventPage(0, 15)
    assert.equal(page.rows.length, 15)
    assert.equal(page.hasMore, false, 'the 16th raw row is the sentinel, so exactly 15 rows finish in one page')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard event projections expose duplicate fingerprints only for user messages', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-user-fingerprint-projection-'))
  let store
  try {
    store = openProjectStore(root, 'user-fingerprint-projection')
    store.recordL0({ sessionId: 'fingerprint-session', role: 'user', content: 'same synthetic question' })
    store.recordL0({ sessionId: 'fingerprint-session', role: 'assistant', content: 'same synthetic question' })

    const page = store.dashboardReadEventPage(0, 15)
    assert.equal(page.rows.length, 2)
    assert.equal(page.rows[0].fingerprintBytes, 64)
    assert.equal(page.rows[1].fingerprintBytes, 0, 'assistant text cannot enter duplicate-question metrics')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('overview metadata and hidden-source predicates bind every row to the store project', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-approved-reference-project-'))
  let store
  try {
    store = openProjectStore(root, 'reference-project-a')
    const local = store.addMemory({ content: 'Synthetic in-project approved reference.', status: 'approved' }).record
    const foreign = store.addMemory({ content: 'Synthetic foreign-project approved reference.', status: 'approved' }).record
    store.db.prepare('UPDATE l1_memories SET project_key = ? WHERE id = ?').run('reference-project-b', foreign.id)

    assert.deepEqual(store.approvedRecordReferences().map((record) => record.id), [local.id],
      'a mixed-project database row cannot enter the current project metadata projection')

    const sourceId = store.recordL0({ sessionId: 'candidate-source', role: 'user', content: 'Synthetic source whose owner is changed.' })
    store.addMemory({ content: 'Synthetic local candidate with foreign source ownership.', status: 'candidate', sourceMessageIds: [sourceId] })
    store.db.prepare('UPDATE l0_messages SET project_key = ?, agent_preset = ? WHERE id = ?').run('reference-project-b', 'private-agent', sourceId)
    assert.equal(store.visibleStatusCount('candidate', ['private-agent']), 1,
      'a foreign project source row cannot hide a current-project candidate')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('scene refresh can rebuild one normalized scene without changing other scenes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-scene-scope-'))
  try {
    const store = openProjectStore(root, 'scene-scope-project')
    const billing = store.addMemory({ content: 'Synthetic billing scene memory.', status: 'approved', scene: 'billing' }).record
    const tooling = store.addMemory({ content: 'Synthetic tooling scene memory.', status: 'approved', scene: 'tooling' }).record
    const general = store.addMemory({ content: 'Synthetic default scene memory.', status: 'approved', scene: '\u3000' }).record
    store.refreshScenes()
    assert.deepEqual(store.approvedRecords([], Date.now(), Date.now(), 'general').map((record) => record.id), [general.id])

    store.forget(billing.id)
    store.refreshScenes(Date.now(), 'billing')
    const scenes = new Map(store.scenes().map((scene) => [scene.name, scene]))
    assert.equal(scenes.has('billing'), false)
    assert.deepEqual(scenes.get('tooling')?.sourceIds, [tooling.id])
    assert.deepEqual(scenes.get('general')?.sourceIds, [general.id])
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scene metadata keyset orders and advances on the real name identity beyond the display projection', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-scene-name-keyset-'))
  const store = openProjectStore(root, 'scene-name-keyset-project')
  try {
    const longName = `a${'x'.repeat(519)}`
    const shortName = 'b-normal-scene'
    store.addMemory({ content: 'Synthetic long-name scene fact.', status: 'approved', scene: longName })
    store.addMemory({ content: 'Synthetic following scene fact.', status: 'approved', scene: shortName })
    store.refreshScenes()
    const first = store.dashboardSceneMetaPage(undefined, 1)
    assert.equal(first.rows.length, 1)
    assert.equal(first.rows[0].name, longName, 'the real name is retained for a verifiable keyset')
    assert.equal(first.rows[0].nameBytes, 520)
    assert.equal(first.hasMore, true)
    const second = store.dashboardSceneMetaPage({ memoryCount: first.rows[0].memoryCount, name: first.rows[0].name }, 1)
    assert.equal(second.rows.length, 1)
    assert.equal(second.rows[0].name, shortName, 'the next page is not skipped by a NULL display projection')
    assert.equal(second.rows[0].nameBytes, Buffer.byteLength(shortName, 'utf8'))
    assert.equal(second.hasMore, false)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-scene approval advances full provenance and defers summary materialization', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-scene-incremental-'))
  const actualNow = Date.now
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, 'scene-incremental-project')
    const first = store.addMemory({ content: 'First existing scene fact.', status: 'approved', scene: 'general' }).record
    Date.now = () => now + 1
    const second = store.addMemory({ content: 'Second existing scene fact.', status: 'approved', scene: 'general' }).record
    Date.now = () => now + 2
    const otherScene = store.addMemory({ content: 'Independent clean scene fact.', status: 'approved', scene: 'tooling' }).record
    Date.now = () => now + 3
    const candidate = store.addMemory({ content: 'New approved scene fact.', status: 'candidate', scene: 'general' }).record
    store.refreshScenes(now + 3)
    const approvedRecords = store.approvedRecords()
    const approvedReferences = store.approvedRecordReferences()
    assert.deepEqual(approvedReferences.map(({ id, revision, sourceMessageIds }) => ({ id, revision, sourceMessageIds })),
      approvedRecords.map(({ id, revision, sourceMessageIds }) => ({ id, revision, sourceMessageIds })),
      'dashboard references preserve the current approved revision and source projection')
    assert.equal('content' in approvedReferences[0], false, 'dashboard permission indexing does not hydrate approved bodies')

    Date.now = () => now + 10
    assert.equal(store.approve(candidate.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(candidate.id, now + 10), true)
    Date.now = () => now + 11
    const newerCandidate = store.addMemory({ content: 'Another newly approved scene fact.', status: 'candidate', scene: 'general' }).record
    Date.now = () => now + 12
    assert.equal(store.approve(newerCandidate.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(newerCandidate.id, now + 12), true)
    const pendingSnapshot = store.db.prepare(`SELECT source_ids, source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(pendingSnapshot.source_snapshot_dirty, 1)
    assert.deepEqual(JSON.parse(pendingSnapshot.source_ids), [second.id, first.id], 'the normalized member table carries the new ID before JSON cache refresh')
    assert.deepEqual(store.db.prepare(`SELECT memory_id FROM l2_scene_members WHERE scene_name = 'general' ORDER BY ordinal`)
      .all().map((row) => row.memory_id), [newerCandidate.id, candidate.id, second.id, first.id])
    assert.equal(store.db.prepare(`SELECT summary_member_count FROM l2_scenes WHERE name = 'general'`).get().summary_member_count, 4,
      'the member trigger keeps the persisted count aligned with the normalized index')
    assert.deepEqual(store.sceneNamesContainingMemory(candidate.id), ['general'], 'internal scene lookup sees committed members before JSON materialization')
    assert.deepEqual(store.sceneNamesContainingMemory(newerCandidate.id), ['general'])
    const firstMemberPage = store.dashboardSceneMemberPage('general', undefined, 2)
    assert.deepEqual(firstMemberPage.rows.map((row) => row.memoryId), [newerCandidate.id, candidate.id],
      'the first managed member page must include negative incremental ordinals instead of clamping the cursor to -1')
    assert.ok(firstMemberPage.rows.every((row) => row.ordinal < 0), 'real incremental approvals retain negative ordinals before scene repair')
    const secondMemberPage = store.dashboardSceneMemberPage('general', firstMemberPage.rows.at(-1).ordinal, 2)
    assert.deepEqual(secondMemberPage.rows.map((row) => row.memoryId), [second.id, first.id])
    assert.equal(firstMemberPage.hasMore, true)
    assert.equal(secondMemberPage.hasMore, false)
    store.db.prepare(`DELETE FROM l2_scene_members WHERE scene_name = 'tooling'`).run()
    store.close()
    store = openProjectStore(root, 'scene-incremental-project')
    const scene = store.scenes().find((item) => item.name === 'general')
    assert.ok(scene)
    assert.deepEqual(scene.sourceIds, [newerCandidate.id, candidate.id, second.id, first.id])
    assert.deepEqual(scene.sourceRevisions, { [newerCandidate.id]: newerCandidate.revision + 1,
      [candidate.id]: candidate.revision + 1, [second.id]: second.revision, [first.id]: first.revision })
    assert.equal(scene.memoryCount, 4)
    assert.equal(scene.summary, 'Another newly approved scene fact. / New approved scene fact. / Second existing scene fact. / First existing scene fact.')
    assert.equal(scene.summaryComplete, true)
    const stillDeferred = store.db.prepare(`SELECT source_ids, source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(stillDeferred.source_snapshot_dirty, 1, 'scene reads return members without rewriting the full JSON cache')
    assert.deepEqual(JSON.parse(stillDeferred.source_ids), [second.id, first.id])
    assert.deepEqual(store.sceneNamesContainingMemory(otherScene.id), ['tooling'], 'clean legacy JSON backfills missing member rows on open')
    assert.equal(store.db.prepare(`SELECT summary_member_count FROM l2_scenes WHERE name = 'tooling'`).get().summary_member_count, 1,
      'reopening repairs the deleted member and its persisted count')
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('scene approval falls back when prepending would change updated-at order', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-scene-order-'))
  const actualNow = Date.now
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, 'scene-order-project')
    const existing = store.addMemory({ content: 'Existing ordered scene fact.', status: 'approved', scene: 'general' }).record
    Date.now = () => now + 1
    const candidate = store.addMemory({ content: 'Newly approved scene fact.', status: 'candidate', scene: 'general' }).record
    store.refreshScenes(now + 1)

    // Model a source-row update after the last scene snapshot while preserving its
    // approved revision; approvedRecords() still orders this row ahead of the candidate.
    store.db.prepare('UPDATE l1_memories SET updated_at = ? WHERE id = ?').run(now + 20, existing.id)
    Date.now = () => now + 10
    assert.equal(store.approve(candidate.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(candidate.id, now + 10), false)
    store.refreshScenes(now + 10, 'general', false)

    const scene = store.scenes().find((item) => item.name === 'general')
    assert.deepEqual(scene?.sourceIds, [existing.id, candidate.id])
    assert.equal(scene?.memoryCount, 2)
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('member deletion trigger invalidates the dirty scene frontier and read repairs its index', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-dirty-scene-missing-base-'))
  const actualNow = Date.now
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, 'dirty-scene-missing-base-project')
    const approved = store.addMemory({ content: 'Approved scene base fact.', status: 'approved', scene: 'general' }).record
    store.refreshScenes(now + 1)
    store.db.prepare(`UPDATE l2_scenes SET source_snapshot_dirty = 1 WHERE name = 'general'`).run()
    store.db.prepare(`DELETE FROM l2_scene_members WHERE scene_name = 'general' AND memory_id = ?`).run(approved.id)

    Date.now = () => now + 2
    const scene = store.scenes().find((item) => item.name === 'general')
    assert.deepEqual(scene?.sourceIds, [approved.id])
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM l2_scene_members WHERE scene_name = 'general'`).get().n, 1,
      'the member trigger invalidates the frontier so the scene read restores the complete normalized index')
    assert.equal(store.db.prepare(`SELECT source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get().source_snapshot_dirty, 0)
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dirty scene provenance always comes from normalized member order', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-dirty-scene-json-corruption-'))
  const actualNow = Date.now
  let store
  try {
    let clock = actualNow()
    Date.now = () => clock
    store = openProjectStore(root, 'dirty-scene-json-corruption-project')
    const seed = (scene, labels) => labels.map((label) => {
      const record = store.addMemory({ content: `Unique ${scene} ${label} fact.`, status: 'approved', scene }).record
      clock += 1
      return record
    })
    const revisionsNull = seed('revisions-null', ['old', 'middle', 'new'])
    const missingAnchor = seed('missing-anchor', ['old', 'middle', 'new'])
    const wrongTailId = seed('wrong-tail-id', ['b', 'a', 'd'])
    const wrongTailRevision = seed('wrong-tail-revision', ['b', 'a', 'd'])
    const wrongTailOrder = seed('wrong-tail-order', ['c', 'b', 'a', 'd'])
    store.refreshScenes(clock + 1)

    const updateDirtyProjection = store.db.prepare(`UPDATE l2_scenes SET source_ids = ?, source_revisions = ?,
      source_snapshot_dirty = 1, summary_frontier_ready = 1 WHERE name = ?`)
    const ordered = (records) => [...records].reverse()
    const revisionsFor = (records) => Object.fromEntries(ordered(records).map((record) => [record.id, record.revision]))
    updateDirtyProjection.run(JSON.stringify(ordered(revisionsNull).map((record) => record.id)), 'null', 'revisions-null')
    updateDirtyProjection.run(JSON.stringify(['missing-scene-member', missingAnchor[0].id]),
      JSON.stringify({ 'missing-scene-member': 1, [missingAnchor[0].id]: missingAnchor[0].revision }), 'missing-anchor')
    updateDirtyProjection.run(JSON.stringify([wrongTailId[1].id, 'missing-tail-member']),
      JSON.stringify({ [wrongTailId[1].id]: wrongTailId[1].revision, 'missing-tail-member': 1 }), 'wrong-tail-id')
    updateDirtyProjection.run(JSON.stringify([wrongTailRevision[1].id, wrongTailRevision[0].id]),
      JSON.stringify({ [wrongTailRevision[1].id]: wrongTailRevision[1].revision,
        [wrongTailRevision[0].id]: wrongTailRevision[0].revision + 100 }), 'wrong-tail-revision')
    updateDirtyProjection.run(JSON.stringify([wrongTailOrder[2].id, wrongTailOrder[0].id, wrongTailOrder[1].id]),
      JSON.stringify({ [wrongTailOrder[2].id]: wrongTailOrder[2].revision,
        [wrongTailOrder[0].id]: wrongTailOrder[0].revision, [wrongTailOrder[1].id]: wrongTailOrder[1].revision }), 'wrong-tail-order')

    Date.now = () => clock + 2
    const scenes = new Map(store.scenes().map((scene) => [scene.name, scene]))
    for (const [name, records] of [
      ['revisions-null', revisionsNull], ['missing-anchor', missingAnchor], ['wrong-tail-id', wrongTailId],
      ['wrong-tail-revision', wrongTailRevision], ['wrong-tail-order', wrongTailOrder],
    ]) {
      const scene = scenes.get(name)
      const expected = ordered(records)
      assert.deepEqual(scene?.sourceIds, expected.map((record) => record.id), `${name} returns normalized member IDs in order`)
      assert.deepEqual(scene?.sourceRevisions, revisionsFor(records), `${name} returns the member revisions, not damaged JSON`)
    }
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('historical valid-time reads still apply the current expiry wall clock', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-historical-expiry-'))
  const actualNow = Date.now
  let store
  try {
    const currentNow = actualNow()
    Date.now = () => currentNow
    store = openProjectStore(root, 'historical-expiry-project')
    const memory = store.addMemory({ content: 'Expired now but valid at the historical instant.', status: 'approved',
      validFrom: currentNow - 5_000 }).record
    store.db.prepare('UPDATE l1_memories SET expiry_at = ? WHERE id = ?').run(currentNow - 1_000, memory.id)

    const historicalValidAt = currentNow - 2_000
    assert.deepEqual(store.approvedRecordReferences([], historicalValidAt, currentNow), [],
      'historical references remain filtered by current TTL')
    assert.deepEqual(store.approvedRecords([], historicalValidAt, currentNow), [],
      'historical body reads do not revive content that has expired now')
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('approved revision lookup keeps bitemporal precedence and uses its memory-time index', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-approved-revision-index-'))
  const actualNow = Date.now
  let store
  try {
    Date.now = () => 1_000
    store = openProjectStore(root, 'approved-revision-index-project')
    const memory = store.addMemory({ content: 'Approved revision baseline.', status: 'approved', scene: 'billing' }).record
    store.db.prepare(`UPDATE l1_revisions SET recorded_at = 100, valid_from = 100, source_message_ids = ?
      WHERE memory_id = ? AND revision = ?`).run(JSON.stringify(['source-base']), memory.id, memory.revision)
    const insert = store.db.prepare(`INSERT INTO l1_revisions(revision_id, memory_id, revision, content, kind, scene,
      status, recorded_at, valid_from, valid_from_state, valid_to, source_message_ids, source_verified)
      VALUES (?, ?, ?, ?, 'preference', 'billing', 'approved', ?, ?, ?, ?, ?, 0)`)
    const addRevision = (revision, recordedAt, validFrom, validFromState = 'known', validTo = null) => {
      insert.run(`synthetic-approved-${revision}`, memory.id, revision, `Revision ${revision}.`, recordedAt, validFrom,
        validFromState, validTo, JSON.stringify([`source-${revision}`]))
    }
    addRevision(2, 200, 200, 'known', 500)
    addRevision(3, 250, 200)
    addRevision(4, 250, 200)
    addRevision(5, 260, 400)
    addRevision(6, 275, null, 'unknown', 350)
    addRevision(7, 350, 100)

    const projectRecords = (effectiveAt, knownAt) => store.approvedRecords([], effectiveAt, knownAt, 'billing', [memory.id], 1_000)
    const projectReferences = (effectiveAt, knownAt) => store.approvedRecordReferences([], effectiveAt, knownAt, 1_000)
    const assertCurrentProjection = (effectiveAt, knownAt, expectedRevision, expectedSource) => {
      const records = projectRecords(effectiveAt, knownAt)
      const references = projectReferences(effectiveAt, knownAt)
      assert.equal(records.length, 1)
      assert.deepEqual(references.map(({ id, revision, sourceMessageIds }) => ({ id, revision, sourceMessageIds })),
        records.map(({ id, revision, sourceMessageIds }) => ({ id, revision, sourceMessageIds })))
      assert.equal(records[0].revision, expectedRevision)
      assert.deepEqual(records[0].sourceMessageIds, [expectedSource])
    }

    assertCurrentProjection(300, 300, 6, 'source-6')
    assertCurrentProjection(300, 260, 4, 'source-4')
    assertCurrentProjection(180, 260, memory.revision, 'source-base')
    assert.deepEqual(store.approvedRecords([], 300, 300, [], [memory.id], 1_000), [], 'empty scene input stays empty')

    const plan = store.db.prepare(`EXPLAIN QUERY PLAN
      SELECT 1 FROM l1_revisions r
      WHERE r.memory_id = ? AND r.status = 'approved' AND r.recorded_at <= ?
        AND (r.valid_from_state = 'unknown' OR r.valid_from <= ?)
        AND (r.valid_to IS NULL OR r.valid_to > ?)
        AND NOT EXISTS (SELECT 1 FROM l1_revisions newer
          WHERE newer.memory_id = r.memory_id AND newer.status = 'approved' AND newer.recorded_at <= ?
            AND (newer.valid_from_state = 'unknown' OR newer.valid_from <= ?)
            AND (newer.valid_to IS NULL OR newer.valid_to > ?)
            AND (newer.recorded_at > r.recorded_at OR (newer.recorded_at = r.recorded_at AND newer.revision > r.revision)))`)
      .all(memory.id, 300, 300, 300, 300, 300, 300)
    assert.ok(plan.some((row) => String(row.detail).includes('newer') && String(row.detail).includes('l1_revision_effective_lookup')),
      `the current-revision anti-lookup should use its composite index: ${plan.map((row) => row.detail).join('; ')}`)
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('incremental scene summaries retain skipped entries and match full greedy refresh including omission clipping', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-summary-frontier-'))
  const actualNow = Date.now
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, 'scene-summary-frontier-project')
    const shortC = store.addMemory({ content: 'C'.repeat(20), status: 'approved', scene: 'general' }).record
    Date.now = () => now + 1
    const shortB = store.addMemory({ content: 'B'.repeat(10), status: 'approved', scene: 'general' }).record
    Date.now = () => now + 2
    const long = store.addMemory({ content: 'A'.repeat(300), status: 'approved', scene: 'general' }).record
    Date.now = () => now + 3
    const candidate = store.addMemory({ content: 'D'.repeat(20), status: 'candidate', scene: 'general' }).record
    store.refreshScenes(now + 4)

    const oldSnapshot = store.db.prepare(`SELECT summary, summary_parts FROM l2_scenes WHERE name = 'general'`).get()
    assert.deepEqual(JSON.parse(oldSnapshot.summary_parts), [long.content], 'placeholder clipping removes the previously selected short tail from summary_parts')
    assert.match(oldSnapshot.summary, /另有 2 条完整记忆未展开/u)

    Date.now = () => now + 10
    assert.equal(store.approve(candidate.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(candidate.id, now + 10), true)
    const afterShortApproval = store.db.prepare(`SELECT summary, summary_parts, summary_complete FROM l2_scenes WHERE name = 'general'`).get()
    assert.deepEqual(JSON.parse(afterShortApproval.summary_parts), [candidate.content, shortB.content, shortC.content])
    assert.match(afterShortApproval.summary, /另有 1 条完整记忆未展开/u)
    const shortIncremental = afterShortApproval.summary
    store.refreshScenes(now + 11, 'general', false)
    const shortFull = store.db.prepare(`SELECT summary, summary_parts, summary_complete FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(shortIncremental, shortFull.summary)
    assert.equal(afterShortApproval.summary_complete, shortFull.summary_complete)
    assert.deepEqual(JSON.parse(afterShortApproval.summary_parts), JSON.parse(shortFull.summary_parts))

    Date.now = () => now + 12
    const longCandidate = store.addMemory({ content: 'E'.repeat(300), status: 'candidate', scene: 'general' }).record
    Date.now = () => now + 20
    assert.equal(store.approve(longCandidate.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(longCandidate.id, now + 20), true)
    const afterLongApproval = store.db.prepare(`SELECT summary, summary_parts, summary_complete FROM l2_scenes WHERE name = 'general'`).get()
    assert.deepEqual(JSON.parse(afterLongApproval.summary_parts), [longCandidate.content], 'omission text clips the short tail without removing it from the persistent frontier')
    assert.match(afterLongApproval.summary, /另有 4 条完整记忆未展开/u)
    const longIncremental = afterLongApproval.summary
    store.refreshScenes(now + 21, 'general', false)
    const longFull = store.db.prepare(`SELECT summary, summary_parts, summary_complete FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(longIncremental, longFull.summary)
    assert.equal(afterLongApproval.summary_complete, longFull.summary_complete)
    assert.deepEqual(JSON.parse(afterLongApproval.summary_parts), JSON.parse(longFull.summary_parts))

    const readSummary = (scene) => store.db.prepare(`SELECT summary, summary_parts, summary_complete FROM l2_scenes WHERE name = ?`).get(scene)
    const prepend = (scene, content, at, expectedParts) => {
      Date.now = () => now + at
      const inserted = store.addMemory({ content, status: 'candidate', scene })
      assert.equal(inserted.created, true, 'prepend fixtures must not normalize to an existing project memory')
      assert.equal(inserted.record.scene, scene)
      assert.equal(inserted.record.status, 'candidate')
      const next = inserted.record
      Date.now = () => now + at + 1
      assert.equal(store.approve(next.id)?.status, 'approved')
      assert.equal(store.advanceSceneIndexForApproval(next.id, now + at + 1), true)
      const incremental = readSummary(scene)
      assert.deepEqual(JSON.parse(incremental.summary_parts), expectedParts)
      const frontierState = store.db.prepare(`SELECT summary_frontier, summary_frontier_ready FROM l2_scenes WHERE name = ?`).get(scene)
      assert.equal(frontierState.summary_frontier_ready, 1)
      assert.equal(JSON.parse(frontierState.summary_frontier).length, 321)
      return incremental
    }
    const assertMatchesFullRefresh = (scene, incremental, at) => {
      store.refreshScenes(now + at + 2, scene, false)
      const rebuilt = readSummary(scene)
      assert.equal(incremental.summary, rebuilt.summary)
      assert.equal(incremental.summary_complete, rebuilt.summary_complete)
      assert.deepEqual(JSON.parse(incremental.summary_parts), JSON.parse(rebuilt.summary_parts))
      return rebuilt
    }
    const prependAndCompare = (scene, content, at, expectedParts) =>
      assertMatchesFullRefresh(scene, prepend(scene, content, at, expectedParts), at)

    const chainA = 'R'.repeat(300)
    const chainB = 'Q'.repeat(20)
    const chainD = 'S'.repeat(20)
    const chainE = 'T'.repeat(280)
    const chainFBody = 'U'.repeat(38)
    const chainBodies = [chainA, chainB, chainD, chainE, chainFBody]
    assert.deepEqual(chainBodies.map((content) => content.length), [300, 20, 20, 280, 38])
    assert.equal(new Set(chainBodies.map((content) => content.replace(/\s+/g, ' ').trim())).size, chainBodies.length,
      'normalized chain bodies are pairwise unique')

    Date.now = () => now + 30
    const initialB = store.addMemory({ content: chainB, status: 'approved', scene: 'prepend-chain' })
    assert.equal(initialB.created, true)
    assert.equal(initialB.record.scene, 'prepend-chain')
    assert.equal(initialB.record.status, 'approved')
    Date.now = () => now + 31
    const initialA = store.addMemory({ content: chainA, status: 'approved', scene: 'prepend-chain' })
    assert.equal(initialA.created, true)
    assert.equal(initialA.record.scene, 'prepend-chain')
    assert.equal(initialA.record.status, 'approved')
    store.refreshScenes(now + 32)
    assert.deepEqual(JSON.parse(readSummary('prepend-chain').summary_parts), [chainA])
    prepend('prepend-chain', chainD, 33, [chainD, chainB])
    prepend('prepend-chain', chainE, 36, [chainE, chainD])
    const chainF = prepend('prepend-chain', chainFBody, 39, [chainFBody, chainD, chainB])
    store.refreshScenes(now + 42, 'prepend-chain', false)
    const chainFull = readSummary('prepend-chain')
    assert.equal(chainF.summary, chainFull.summary)
    assert.equal(chainF.summary_complete, chainFull.summary_complete)
    assert.deepEqual(JSON.parse(chainF.summary_parts), JSON.parse(chainFull.summary_parts))

    for (let index = 0; index < 9; index += 1) {
      Date.now = () => now + 50 + index
      store.addMemory({ content: String(index + 1).repeat(321), status: 'approved', scene: 'omission-boundary' })
    }
    Date.now = () => now + 59
    store.addMemory({ content: 'B'.repeat(4), status: 'approved', scene: 'omission-boundary' })
    Date.now = () => now + 60
    store.addMemory({ content: 'A'.repeat(297), status: 'approved', scene: 'omission-boundary' })
    store.refreshScenes(now + 61)
    const omissionBoundary = readSummary('omission-boundary')
    assert.deepEqual(JSON.parse(omissionBoundary.summary_parts), ['A'.repeat(297), 'B'.repeat(4)])
    assert.equal(omissionBoundary.summary.length, 320, '297 + separator 3 + 4 + one-character omission-count suffix fits exactly')
    assert.match(omissionBoundary.summary, /另有 9 条完整记忆未展开/u)
    const clippedBoundary = prependAndCompare('omission-boundary', 'X'.repeat(321), 62, ['A'.repeat(297)])
    assert.match(clippedBoundary.summary, /另有 11 条完整记忆未展开/u, 'the longer omission count clips B and is recomputed after clipping')

    Date.now = () => now + 70
    store.addMemory({ content: 'B'.repeat(316), status: 'approved', scene: 'separator-boundary' })
    Date.now = () => now + 71
    store.addMemory({ content: 'A', status: 'approved', scene: 'separator-boundary' })
    store.refreshScenes(now + 72)
    const separatorBoundary = readSummary('separator-boundary')
    assert.deepEqual(JSON.parse(separatorBoundary.summary_parts), ['A', 'B'.repeat(316)])
    assert.equal(separatorBoundary.summary.length, 320, 'one character + the three-character separator + 316 characters fits exactly')

    Date.now = () => now + 80
    store.addMemory({ content: 'B'.repeat(315), status: 'approved', scene: 'unicode-boundary' })
    store.refreshScenes(now + 81)
    prependAndCompare('unicode-boundary', '  😀  ', 82, ['😀', 'B'.repeat(315)])

    Date.now = () => now + 90
    const firstInScene = store.addMemory({ content: 'First memory in a new scene.', status: 'candidate', scene: 'new-scene' }).record
    Date.now = () => now + 91
    assert.equal(store.approve(firstInScene.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(firstInScene.id, now + 91), true)
    assert.deepEqual(JSON.parse(readSummary('new-scene').summary_parts), [firstInScene.content])
    const newSceneState = store.db.prepare(`SELECT summary_frontier, summary_frontier_ready, source_ids, source_revisions,
      source_snapshot_dirty FROM l2_scenes WHERE name = 'new-scene'`).get()
    assert.equal(newSceneState.summary_frontier_ready, 1)
    assert.equal(newSceneState.source_snapshot_dirty, 0, 'a one-record scene can establish its complete base snapshot without deferred materialization')
    assert.deepEqual(JSON.parse(newSceneState.source_ids), [firstInScene.id])
    assert.deepEqual(JSON.parse(newSceneState.source_revisions), { [firstInScene.id]: firstInScene.revision + 1 })
    assert.equal(JSON.parse(newSceneState.summary_frontier).length, 321)
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dirty scene deletion preview counts normalized members and purge survives reopen', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-dirty-scene-delete-'))
  const actualNow = Date.now
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, 'dirty-scene-delete-project')
    const retained = store.addMemory({ content: 'Retained scene memory.', status: 'approved', scene: 'general' }).record
    Date.now = () => now + 1
    const candidate = store.addMemory({ content: 'Newly approved dirty scene memory.', status: 'candidate', scene: 'general' }).record
    store.refreshScenes(now + 2)

    Date.now = () => now + 10
    store.approve(candidate.id)
    assert.equal(store.advanceSceneIndexForApproval(candidate.id, now + 10), true)
    store.db.prepare(`UPDATE l2_scenes SET summary_frontier = NULL, summary_frontier_ready = 0 WHERE name = 'general'`).run()
    store.close()

    store = openProjectStore(root, 'dirty-scene-delete-project')
    const staleDirty = store.db.prepare(`SELECT source_ids, source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(staleDirty.source_snapshot_dirty, 1)
    assert.equal(JSON.parse(staleDirty.source_ids).includes(candidate.id), false, 'the R20-style dirty JSON snapshot lacks the approved ID')
    assert.deepEqual(store.scenes().find((item) => item.name === 'general')?.sourceIds, [candidate.id, retained.id],
      'an unready dirty frontier rebuilds from approved records instead of trusting stale JSON')
    assert.equal(store.db.prepare(`SELECT summary_frontier_ready FROM l2_scenes WHERE name = 'general'`).get().summary_frontier_ready, 1)

    Date.now = () => now + 20
    const deletionCandidate = store.addMemory({ content: 'Second newly approved dirty scene memory.', status: 'candidate', scene: 'general' }).record
    Date.now = () => now + 21
    store.approve(deletionCandidate.id)
    assert.equal(store.advanceSceneIndexForApproval(deletionCandidate.id, now + 21), true)
    const dirty = store.db.prepare(`SELECT source_ids, source_snapshot_dirty FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(dirty.source_snapshot_dirty, 1)
    assert.equal(JSON.parse(dirty.source_ids).includes(deletionCandidate.id), false, 'the second approved ID is not yet in the JSON snapshot')

    const preview = store.managedDeletionPlan({ memoryIds: [deletionCandidate.id], sourceIds: [] })
    assert.equal(preview.sceneCount, 1, 'preview follows the normalized dirty membership')
    store.purgeManagedContent({ memoryIds: preview.memoryIds, sourceIds: preview.sourceIds })
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM l2_scene_members WHERE scene_name = 'general'`).get().n, 0,
      'purge removes the complete derived member list before any scene refresh')
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM l2_scenes WHERE name = 'general'`).get().n, 0,
      'purge removes the stale derived scene before any scene refresh')
    store.refreshScenes(now + 22)
    store.close()

    store = openProjectStore(root, 'dirty-scene-delete-project')
    const scene = store.scenes().find((item) => item.name === 'general')
    assert.deepEqual(scene?.sourceIds, [candidate.id, retained.id])
    assert.equal(scene?.sourceIds.includes(deletionCandidate.id), false)
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('older schema-v9 scene writes invalidate and rebuild the persisted summary frontier', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-frontier-old-writer-'))
  const actualNow = Date.now
  const projectKey = 'frontier-old-writer-project'
  const file = path.join(root, 'projects', projectKey, 'memory.db')
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, projectKey)
    const first = store.addMemory({ content: 'A memory.', status: 'approved', scene: 'general' }).record
    store.refreshScenes(now + 1)
    Date.now = () => now + 2
    const second = store.addMemory({ content: 'B memory.', status: 'approved', scene: 'general' }).record
    store.close()
    store = undefined

    // Remove the R22 guard to model an R21 database, then apply the R20
    // incremental member/count/snapshot write without changing its frontier.
    const r20 = new DatabaseSync(file)
    try {
      r20.exec(`
        DROP TRIGGER IF EXISTS l2_scene_members_frontier_invalidate_insert;
        DROP TRIGGER IF EXISTS l2_scene_members_frontier_invalidate_update;
        DROP TRIGGER IF EXISTS l2_scene_members_frontier_invalidate_delete;
        DELETE FROM meta WHERE key = 'scene_frontier_member_guard_v1';
      `)
      r20.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
        VALUES (?, 'general', ?, ?, -1)`).run(projectKey, second.id, second.revision)
      r20.prepare(`UPDATE l2_scenes SET memory_count = 2, updated_at = ?, summary = ?, summary_parts = ?,
        summary_complete = 1, source_snapshot_dirty = 1 WHERE project_key = ? AND name = 'general'`)
        .run(now + 3, `${second.content} / ${first.content}`, JSON.stringify([second.content, first.content]), projectKey)
      const stale = r20.prepare(`SELECT summary_frontier_ready FROM l2_scenes WHERE name = 'general'`).get()
      assert.equal(stale.summary_frontier_ready, 1, 'the legacy writer leaves its unknown frontier marked ready')
    } finally { r20.close() }

    Date.now = () => now + 4
    store = openProjectStore(root, projectKey)
    assert.equal(store.db.prepare(`SELECT summary_frontier_ready FROM l2_scenes WHERE name = 'general'`).get().summary_frontier_ready, 0,
      'first R22 open invalidates R21 frontiers that have no member binding')
    assert.equal(store.db.prepare(`SELECT summary_member_count FROM l2_scenes WHERE name = 'general'`).get().summary_member_count, 2,
      'the first R22 open seeds member counts from legacy membership rows')
    assert.deepEqual(store.scenes().find((scene) => scene.name === 'general')?.sourceIds, [second.id, first.id])

    Date.now = () => now + 5
    const third = store.addMemory({ content: 'C memory.', status: 'candidate', scene: 'general' }).record
    Date.now = () => now + 6
    assert.equal(store.approve(third.id)?.status, 'approved')
    assert.equal(store.advanceSceneIndexForApproval(third.id, now + 6), true)
    const afterThird = store.scenes().find((scene) => scene.name === 'general')
    assert.deepEqual(afterThird?.sourceIds, [third.id, second.id, first.id])
    assert.equal(afterThird?.summary, 'C memory. / B memory. / A memory.')

    Date.now = () => now + 7
    const fourth = store.addMemory({ content: 'D memory.', status: 'approved', scene: 'general' }).record
    store.close()
    store = undefined

    // Once R22 has installed the guard, the same R20-shaped write invalidates
    // readiness in the writer's own transaction, including after a version hop.
    const guardedR20 = new DatabaseSync(file)
    try {
      const scene = guardedR20.prepare(`SELECT memory_count, (SELECT MIN(ordinal) FROM l2_scene_members
        WHERE project_key = ? AND scene_name = 'general') AS first_ordinal FROM l2_scenes WHERE name = 'general'`)
        .get(projectKey)
      const ordinal = Number(scene.first_ordinal) - 1
      guardedR20.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
        VALUES (?, 'general', ?, ?, ?)`)
        .run(projectKey, fourth.id, fourth.revision, ordinal)
      guardedR20.prepare(`UPDATE l2_scenes SET memory_count = ?, updated_at = ?, summary = ?, summary_parts = ?,
        summary_complete = 1, source_snapshot_dirty = 1 WHERE project_key = ? AND name = 'general'`)
        .run(Number(scene.memory_count) + 1, now + 8, 'D memory. / C memory. / B memory. / A memory.',
          JSON.stringify([fourth.content, third.content, second.content, first.content]), projectKey)
      assert.equal(guardedR20.prepare(`SELECT summary_frontier_ready FROM l2_scenes WHERE name = 'general'`).get().summary_frontier_ready, 0)
      assert.equal(guardedR20.prepare(`SELECT summary_member_count FROM l2_scenes WHERE name = 'general'`).get().summary_member_count, 4,
        'the installed trigger counts legacy-writer membership mutations')
    } finally { guardedR20.close() }

    Date.now = () => now + 9
    store = openProjectStore(root, projectKey)
    const afterGuardedWrite = store.scenes().find((scene) => scene.name === 'general')
    assert.deepEqual(afterGuardedWrite?.sourceIds, [fourth.id, third.id, second.id, first.id])
    assert.equal(afterGuardedWrite?.summary, 'D memory. / C memory. / B memory. / A memory.')
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('schema-v9 migration rebuilds scene summary frontier from an R19 table without new columns or member table', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-r19-scene-migration-'))
  let store
  try {
    store = openProjectStore(root, 'r19-scene-migration-project')
    const memory = store.addMemory({ content: 'Synthetic R19 scene memory.', status: 'approved', scene: 'general' }).record
    store.refreshScenes()
    store.close()
    store = undefined

    const file = path.join(root, 'projects', 'r19-scene-migration-project', 'memory.db')
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      DROP TABLE l2_scene_members;
      ALTER TABLE l2_scenes RENAME TO l2_scenes_r21;
      CREATE TABLE l2_scenes (
        project_key TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        memory_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source_ids TEXT NOT NULL DEFAULT '[]',
        source_revisions TEXT NOT NULL DEFAULT '{}',
        summary_complete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_key, name)
      );
      INSERT INTO l2_scenes(project_key, name, summary, memory_count, updated_at, source_ids, source_revisions, summary_complete)
        SELECT project_key, name, summary, memory_count, updated_at, source_ids, source_revisions, summary_complete FROM l2_scenes_r21;
      DROP TABLE l2_scenes_r21;
      UPDATE meta SET value = '9' WHERE key = 'schema_version';
      PRAGMA user_version = 9;
    `)
    legacy.close()

    store = openProjectStore(root, 'r19-scene-migration-project')
    const scene = store.scenes().find((item) => item.name === 'general')
    assert.deepEqual(scene?.sourceIds, [memory.id])
    const sceneColumns = store.db.prepare('PRAGMA table_info(l2_scenes)').all().map((row) => row.name)
    const memberColumns = store.db.prepare('PRAGMA table_info(l2_scene_members)').all().map((row) => row.name)
    assert.ok(sceneColumns.includes('summary_frontier'))
    assert.ok(sceneColumns.includes('summary_frontier_ready'))
    assert.ok(sceneColumns.includes('summary_parts'))
    assert.ok(sceneColumns.includes('source_snapshot_dirty'))
    assert.ok(!memberColumns.includes('summary_candidate'))
    const migrated = store.db.prepare(`SELECT summary_frontier, summary_frontier_ready FROM l2_scenes WHERE name = 'general'`).get()
    assert.equal(migrated.summary_frontier_ready, 1, 'first scene read rebuilds and persists the missing greedy-selection frontier')
    assert.equal(JSON.parse(migrated.summary_frontier).length, 321)
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM l2_scene_members WHERE scene_name = 'general' AND memory_id = ?`).get(memory.id).n, 1)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('memory source pages preserve status-scoped keyset order without materializing record bodies', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-memory-source-page-'))
  const actualNow = Date.now
  let store
  try {
    const now = actualNow()
    Date.now = () => now
    store = openProjectStore(root, 'memory-source-page-project')
    const candidateSource = store.recordL0({ sessionId: 'source-page-candidate', role: 'user', content: 'Synthetic candidate source.' })
    const firstCandidate = store.addMemory({ content: 'Synthetic first candidate.', status: 'candidate', sourceMessageIds: [candidateSource], sourceVerified: true }).record
    const secondCandidate = store.addMemory({ content: 'Synthetic second candidate.', status: 'candidate', sourceMessageIds: [candidateSource], sourceVerified: true }).record
    const forgottenSource = store.recordL0({ sessionId: 'source-page-forgotten', role: 'user', content: 'Synthetic forgotten source.' })
    const forgotten = store.addMemory({ content: 'Synthetic forgotten memory.', status: 'approved', sourceMessageIds: [forgottenSource], sourceVerified: true }).record
    store.forget(forgotten.id)

    const collect = (status) => {
      const rows = []
      let after
      do {
        const page = store.memorySourceRowsPage({ status, after, limit: 1 })
        rows.push(...page.records)
        after = page.next
      } while (after !== undefined)
      return rows
    }
    const candidates = collect('candidate')
    assert.deepEqual(candidates.map((row) => row.id), [firstCandidate.id, secondCandidate.id].sort())
    assert.ok(candidates.every((row) => row.sourceMessageIds.includes(candidateSource)))
    const forgottenRows = collect('forgotten')
    assert.deepEqual(forgottenRows.map((row) => row.id), [forgotten.id])
    assert.deepEqual(forgottenRows[0].sourceMessageIds, [forgottenSource])

    const batch = store.dashboardVisibilitySourceIdentities([candidateSource, candidateSource, 'missing-source', forgottenSource])
    assert.deepEqual(batch.map((row) => row.id), [candidateSource, 'missing-source', forgottenSource])
    assert.deepEqual(batch[0].identity, store.dashboardVisibilitySourceIdentity(candidateSource))
    assert.equal(batch[1].identity.found, false)
    assert.deepEqual(batch[2].identity, store.dashboardVisibilitySourceIdentity(forgottenSource))
    for (const invalid of [[], Array(16).fill(candidateSource), [''], ['x'.repeat(257)], [null]]) {
      assert.throws(() => store.dashboardVisibilitySourceIdentities(invalid), /batch is invalid/)
    }
    store.db.prepare('UPDATE l0_messages SET project_key = ? WHERE id = ?').run('other-project', forgottenSource)
    assert.equal(store.dashboardVisibilitySourceIdentities([forgottenSource])[0].identity.found, false,
      'a matching ID with a foreign project tag is not a source for this Store')
    const widerPreset = 'p'.repeat(600)
    store.db.prepare('UPDATE l0_messages SET agent_preset = ? WHERE id = ?').run(widerPreset, candidateSource)
    const narrowIdentity = store.dashboardVisibilitySourceIdentities([candidateSource], 512)[0].identity
    assert.equal(narrowIdentity.agentPreset, undefined, 'the narrow SQL projection omits bytes above its prepaid bound')
    assert.equal(narrowIdentity.agentPresetBytes, 600)
    assert.equal(store.dashboardVisibilitySourceIdentities([candidateSource])[0].identity.agentPreset, widerPreset)
    for (const cap of [-1, 4097, 1.5]) assert.throws(() => store.dashboardVisibilitySourceIdentities([candidateSource], cap))
    store.db.prepare('UPDATE l0_messages SET agent_preset = ? WHERE id = ?').run(Buffer.alloc(5000), candidateSource)
    const malformed = store.dashboardVisibilitySourceIdentities([candidateSource])[0].identity
    assert.equal(malformed.agentPreset, undefined)
    assert.equal(malformed.agentPresetBytes, -1, 'non-text SQLite values remain invalid before JS projection')

    const approved = Array.from({ length: 6 }, (_unused, index) => store.addMemory({
      content: `Synthetic independent overview ordering ${index}.`, status: 'approved',
    }).record)
    for (const [index, memory] of approved.entries()) store.db.prepare('UPDATE l1_memories SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(now + index, now + (index % 2 === 0 ? 100 - index : index), memory.id)
    const heads = store.dashboardOverviewMemoryHeads()
    assert.equal(heads.ready, true)
    assert.equal(heads.projectKey, 'memory-source-page-project')
    for (const status of ['candidate', 'approved', 'forgotten']) assert.deepEqual(
      heads.branches[status].map((row) => row.id), store.dashboardVisibilityMemoryPage(undefined, 4, status).rows.map((row) => row.id))
    assert.deepEqual(heads.branches.recent.map((row) => row.id), store.dashboardRecentApprovedPage(undefined, 4).rows.map((row) => row.id))
    assert.notDeepEqual(heads.branches.recent.map((row) => row.id), heads.branches.approved.map((row) => row.id),
      'recent keeps updated_at/id descending independently of the count cursor')
    assert.equal(heads.branches.approved.length, 4, 'each branch retains its own bounded sentinel')
    const firstHead = heads.branches.candidate.find((row) => row.id === firstCandidate.id)
    assert.equal(firstHead.contentBytes, Buffer.byteLength(firstCandidate.content))
    assert.equal(firstHead.sourceIdsBytes, Buffer.byteLength(JSON.stringify([candidateSource])))
    const boundedCandidate = store.dashboardManagedMemory(firstCandidate.id, firstHead.contentBytes, firstHead.sourceIdsBytes)
    assert.equal(boundedCandidate.content, firstCandidate.content)
    assert.equal(boundedCandidate.sourceMessageIds, JSON.stringify([candidateSource]))
    const omittedCandidate = store.dashboardManagedMemory(firstCandidate.id, 0, 0)
    assert.equal(omittedCandidate.content, undefined)
    assert.equal(omittedCandidate.sourceMessageIds, undefined)
    assert.equal(omittedCandidate.contentBytes, firstHead.contentBytes)
    assert.equal(omittedCandidate.sourceMessageIdsBytes, firstHead.sourceIdsBytes)
    assert.throws(() => store.dashboardManagedMemory(firstCandidate.id, 0, 65537))
    const events = store.dashboardReadEventPage(0, 15)
    const boundedEvents = store.dashboardReadEventPage(0, 15, heads.eventTailId)
    assert.deepEqual(boundedEvents, events, 'the paid event ceiling retains every original event and sentinel')
    const firstEventId = events.rows[0].id
    const oneEvent = store.dashboardReadEventPage(0, 15, firstEventId)
    assert.deepEqual(oneEvent.rows, [events.rows[0]])
    assert.equal(oneEvent.hasMore, false)
    assert.deepEqual(store.dashboardReadEventPage(heads.eventTailId, 15, heads.eventTailId), { rows: [], hasMore: false })
    assert.throws(() => store.dashboardReadEventPage(heads.eventTailId, 15, heads.eventTailId - 1))
    const schemaBefore = store.dashboardOverviewReadVersion()
    assert.equal(schemaBefore.stamp.connectionId, heads.connectionId)
    assert.equal(schemaBefore.schemaVersion, heads.schemaVersion)
    assert.deepEqual(store.dashboardReadVersion(), schemaBefore.stamp)
    store.db.exec('CREATE INDEX synthetic_schema_probe ON l0_messages(role)')
    const schemaAfter = store.dashboardOverviewReadVersion()
    assert.equal(schemaAfter.stamp.connectionId, schemaBefore.stamp.connectionId)
    assert.notEqual(schemaAfter.schemaVersion, schemaBefore.schemaVersion)
    assert.deepEqual(store.dashboardReadVersion(), schemaAfter.stamp)
    store.db.exec('DROP INDEX l1_status_updated_page; CREATE INDEX l1_status_updated_page ON l1_memories(id)')
    assert.equal(store.dashboardOverviewMemoryHeads().ready, false, 'same-name wrong recent ordering cannot certify a fused page')
    for (const suffix of [' COLLATE NOCASE', '']) {
      store.db.exec('DROP INDEX l1_status_updated_page')
      store.db.exec(`CREATE INDEX l1_status_updated_page ON l1_memories(project_key, status, updated_at DESC, id${suffix} DESC)` +
        (suffix === '' ? " WHERE status = 'approved'" : ''))
      assert.equal(store.dashboardOverviewMemoryHeads().ready, false, 'collated and partial same-name indexes fail capability checks')
    }
    store.db.exec('DROP INDEX l1_status_updated_page; CREATE INDEX l1_status_updated_page ON l1_memories(project_key, status, updated_at DESC, id DESC)')
    assert.equal(store.dashboardOverviewMemoryHeads().ready, true, 'the existing exact index shape restores the capability')
  } finally {
    Date.now = actualNow
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('ready extraction retry backoff survives reopening without moving its source deadline', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-ready-retry-'))
  const projectKey = 'ready-retry-project'
  let store = openProjectStore(root, projectKey)
  const now = Date.now()
  try {
    const sourceId = store.recordL0({ sessionId: 'retry-session', role: 'user', content: 'Synthetic queued source.', createdAt: now,
      provider: 'synthetic-provider', model: 'synthetic-model' })
    const queued = store.enqueueExtractionJob({ sessionId: 'retry-session', sourceId, policyRevision: 'policy-v1', quietMs: 0, maxWaitMs: 60_000, now })
    const ready = store.freezeExtractionJob(queued.id, now)
    assert.equal(ready.status, 'ready')
    store.deferReadyExtractionJob(ready.id, 'global billable request gate is held', now + 5_000)
    assert.equal(store.nextExtractionDueAt('retry-session'), now + 35_000)
    store.close()

    store = openProjectStore(root, projectKey)
    assert.equal(store.nextExtractionDueAt('retry-session'), now + 35_000)
    assert.equal(store.nextActionableExtractionJob('retry-session', now + 10_000), undefined)
    assert.equal(store.nextActionableExtractionJob('retry-session', now + 10_000, true)?.status, 'ready', 'a released billable gate may wake its blocked job early')
    assert.equal(store.nextActionableExtractionJob('retry-session', now + 35_000)?.status, 'ready')
    const legacyErrors = ['daily automatic task limit reached (1/1)', 'daily manual token budget exhausted (1+100/1)',
      'estimated request reservation 100 tokens exceeds the configured daily automatic budget 1',
      'automatic daily token and task budgets must be explicitly configured before billable requests']
    for (const [index, error] of legacyErrors.entries()) {
      const blockedAt = now + 40_000 + index * 60_000, dueAt = blockedAt + 30_000
      store.deferReadyExtractionJob(ready.id, error, blockedAt)
      store.close(); store = openProjectStore(root, projectKey)
      assert.equal(store.nextExtractionDueAt('retry-session'), dueAt, 'legacy quota errors retain only ordinary retry backoff after restart')
      assert.equal(store.nextActionableExtractionJob('retry-session', dueAt - 1), undefined)
      assert.equal(store.nextActionableExtractionJob('retry-session', dueAt)?.status, 'ready', 'no daily quota delays the job until midnight')
    }
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('visibility metadata projections omit oversized legacy status and temporal text before returning rows', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-visibility-projection-'))
  let store
  try {
    store = openProjectStore(root, 'visibility-projection-project')
    const memory = store.addMemory({ content: 'Synthetic projection-boundary memory.', status: 'approved' }).record
    const initial = store.dashboardVisibilityNodePage(memory.id)
    assert.deepEqual(initial.meta, store.dashboardVisibilityMemoryMeta(memory.id))
    assert.deepEqual(initial.rows.map(({ inlineSourceJson, ...row }) => row), store.dashboardVisibilityRevisionPage(memory.id).rows)
    assert.equal(initial.rows[0].inlineSourceJson, '[]')
    const narrowNode = store.dashboardVisibilityNodePage(memory.id, 2, 1024)
    assert.deepEqual(narrowNode, initial, 'a single revision needs no unused fourteen-row projection allowance')
    const omittedInline = store.dashboardVisibilityNodePage(memory.id, 2, 0)
    assert.equal(omittedInline.rows[0].inlineSourceJson, undefined)
    assert.equal(omittedInline.rows[0].sourceIdsBytes, 2)
    for (const [rows, bytes] of [[1, 1024], [17, 1024], [2, -1], [2, 4097]]) {
      assert.throws(() => store.dashboardVisibilityNodePage(memory.id, rows, bytes))
    }
    const oversized = 'x'.repeat(5000)
    store.db.prepare('UPDATE l1_memories SET status = ? WHERE project_key = ? AND id = ?')
      .run(oversized, 'visibility-projection-project', memory.id)
    store.db.prepare(`UPDATE l1_revisions SET valid_from_state = ?, valid_from_precision = ?, valid_from_basis = ?
      WHERE memory_id = ? AND revision = ?`).run(oversized, oversized, oversized, memory.id, memory.revision)

    const meta = store.dashboardVisibilityMemoryMeta(memory.id)
    assert.equal(meta?.status, undefined)
    assert.equal(meta?.statusInvalid, true)
    assert.equal(JSON.stringify(meta).includes(oversized), false)

    const revision = store.dashboardVisibilityRevisionPage(memory.id).rows[0]
    assert.ok(revision)
    assert.equal(revision.validFromState, undefined)
    assert.equal(revision.validFromStateInvalid, true)
    assert.equal(revision.validFromPrecision, undefined)
    assert.equal(revision.validFromPrecisionInvalid, true)
    assert.equal(revision.validFromBasis, undefined)
    assert.equal(revision.validFromBasisInvalid, true)
    assert.equal(JSON.stringify(revision).includes(oversized), false)
    const fused = store.dashboardVisibilityNodePage(memory.id)
    assert.equal(fused.projectKey, 'visibility-projection-project')
    assert.equal(fused.meta.statusInvalid, true)
    assert.equal(fused.rows[0].validFromStateInvalid, true)
    assert.equal(JSON.stringify(fused).includes(oversized), false)
    store.db.prepare('UPDATE l1_revisions SET source_message_ids = ? WHERE memory_id = ?').run(oversized, memory.id)
    const withoutInline = store.dashboardVisibilityNodePage(memory.id)
    assert.equal(withoutInline.rows[0].inlineSourceJson, undefined)
    assert.equal(withoutInline.rows[0].sourceIdsBytes, Buffer.byteLength(oversized))
    assert.equal(store.dashboardVisibilityNodePage('missing-node').meta, undefined)
    store.db.prepare('UPDATE l1_revisions SET recorded_at = ? WHERE memory_id = ?').run(9007199254740992n, memory.id)
    const unsafeNumber = store.dashboardVisibilityNodePage(memory.id)
    assert.equal(Number.isNaN(unsafeNumber.rows[0].revision), true, 'unsafe SQLite integers are rejected before JS projection')
    store.db.exec('DROP INDEX l1_revision_effective_lookup; CREATE INDEX l1_revision_effective_lookup ON l1_revisions(revision)')
    assert.throws(() => store.dashboardVisibilityNodePage(memory.id), /indexed capability/)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('scene member page bounds overlong identities without dropping their ordinal sentinel', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-scene-member-id-'))
  const store = openProjectStore(root, 'scene-member-id-project')
  try {
    const base = store.addMemory({ content: 'Bounded scene member base.', status: 'approved', scene: 'long-member-scene' }).record
    store.refreshScenes()
    const projectKey = store.db.prepare('SELECT project_key FROM l1_memories WHERE id = ?').get(base.id).project_key
    const normal = store.addMemory({ content: 'Bounded scene member after sentinel.', status: 'approved', scene: 'long-member-scene' }).record
    const overlong = 'x'.repeat(300)
    store.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
      VALUES (?, ?, ?, ?, ?)`).run(projectKey, 'long-member-scene', overlong, base.revision, 1)
    store.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
      VALUES (?, ?, ?, ?, ?)`).run(projectKey, 'long-member-scene', normal.id, normal.revision, 2)
    const first = store.dashboardSceneMemberPage('long-member-scene', undefined, 1)
    assert.equal(first.rows.length, 1)
    assert.equal(first.rows[0].memoryId, base.id)
    assert.equal(first.hasMore, true)
    const sentinelPage = store.dashboardSceneMemberPage('long-member-scene', first.rows[0].ordinal, 1)
    assert.equal(sentinelPage.rows.length, 1)
    const malformed = sentinelPage.rows[0]
    assert.equal(malformed.memoryId, undefined)
    assert.equal(malformed.memoryIdBytes, 300)
    assert.equal(malformed.ordinal, 1)
    assert.equal(sentinelPage.hasMore, true)
    const after = store.dashboardSceneMemberPage('long-member-scene', sentinelPage.rows[0].ordinal, 1)
    assert.equal(after.rows.length, 1)
    assert.equal(after.rows[0].memoryId, normal.id)
    assert.equal(after.hasMore, false)
    assert.equal(sentinelPage.rows.some((row) => row.memoryId === overlong), false,
      'the SQL projection never materializes more than 256 identity bytes')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboardProjectMeta keeps a bounded friendly-name projection for directory labels', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-project-meta-'))
  const key = 'bounded-label-project'
  try {
    const store = openProjectStore(root, key, { key, name: '记忆项目 α', cwd: '/synthetic/project' })
    const meta = store.dashboardProjectMeta(256)
    assert.deepEqual(meta, { name: '记忆项目 α', nameBytes: Buffer.byteLength('记忆项目 α', 'utf8') })
    assert.throws(() => store.dashboardProjectMeta(257), TypeError, 'the projection bound cannot be raised')
    assert.throws(() => store.dashboardProjectMeta(-1), TypeError)
    store.close()

    const readOnly = openProjectStoreReadOnly(root, key)
    try {
      assert.deepEqual(readOnly.dashboardProjectMeta(256), meta,
        'the read-only member connection returns the same bounded projection')
    } finally { readOnly.close() }

    const oversized = 'x'.repeat(300)
    const writable = openProjectStore(root, key)
    try {
      writable.setProjectMeta({ key, name: oversized, cwd: '/synthetic/project' })
      const bounded = writable.dashboardProjectMeta(256)
      assert.equal(bounded.name, undefined, 'an over-256-byte name is not materialized')
      assert.equal(bounded.nameBytes, 300, 'the true byte length is still reported for revocation checks')
      writable.setProjectMeta({ key, name: 'renamed after label read', cwd: '/synthetic/project' })
      assert.equal(writable.dashboardProjectMeta(256).name, 'renamed after label read',
        'a later projection observes the changed name on the same database')
    } finally { writable.close() }

    const missing = openProjectStore(root, 'label-without-project-meta')
    try {
      assert.equal(missing.dashboardProjectMeta(256), undefined,
        'a database without a project_meta row reports no label rather than inventing one')
    } finally { missing.close() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboardFileIdentity retains the pre/post-open path observation for a live connection', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-file-identity-'))
  const key = 'identity-project'
  try {
    const writer = openProjectStore(root, key, { key, name: 'Identity project', cwd: '/synthetic/identity' })
    const file = path.join(root, 'projects', key, 'memory.db')
    const current = lstatSync(file)
    const identity = writer.dashboardFileIdentity()
    // The stored value is the path observation made around the open; it is not
    // proof of the SQLite handle inode, and an external B→A(open)→B between the
    // pre/post stats is not excluded.
    assert.deepEqual(identity, { dev: current.dev, ino: current.ino },
      'the writer connection retains the path identity observed across its open')
    writer.backupTo(path.join(root, 'replacement.db'))
    renameSync(path.join(root, 'replacement.db'), file)
    assert.deepEqual(writer.dashboardFileIdentity(), identity,
      'a live connection keeps its saved path observation after its path is replaced')
    const readOnly = openProjectStoreReadOnly(root, key)
    try {
      const replacement = readOnly.dashboardFileIdentity()
      assert.ok(replacement)
      assert.notDeepEqual(replacement, identity, 'a fresh read-only connection observes the replacement path identity')
      const replacementStat = lstatSync(file)
      assert.deepEqual(replacement, { dev: replacementStat.dev, ino: replacementStat.ino })
      assert.equal(readOnly.projectMeta().name, 'Identity project',
        'the replacement snapshot is a readable schema-9 database')
    } finally { readOnly.close() }
    writer.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the C event association index has an exact additive capability check', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-events-association-'))
  const key = 'events-association'
  try {
    const store = openProjectStore(root, key, { key, name: 'Association index', cwd: '/synthetic/association' })
    try {
      assert.equal(store.dashboardEventsAssociationIndexReady(), true)
      store.db.exec('DROP INDEX memory_events_association')
      assert.equal(store.dashboardEventsAssociationIndexReady(), false, 'a missing index is not silently recreated or bypassed')
      store.db.exec('CREATE INDEX memory_events_association ON memory_events(project_key)')
      assert.equal(store.dashboardEventsAssociationIndexReady(), false, 'a same-name wrong definition is refused')
    } finally {
      store.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('processing ownership pages expose a bounded raw keyset and per-source point reads', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-processing-sources-'))
  const key = 'processing-source-project'
  const sessionId = 'processing-source-session'
  let store
  try {
    store = openProjectStore(root, key)
    const sourceIds = Array.from({ length: 20 }, (_unused, index) =>
      store.recordL0({ sessionId, role: 'user', content: `Synthetic processing source ${index}.`, createdAt: 1_000 + index }))
    const now = 2_000
    let job
    for (const sourceId of sourceIds) {
      job = store.enqueueExtractionJob({ sessionId, sourceId, policyRevision: 'policy-v1', quietMs: 0, maxWaitMs: 60_000, now })
    }
    assert.ok(job)
    const first = store.dashboardProcessingSourcePage(job.id, undefined, 4)
    assert.equal(first.rows.length, 4)
    assert.equal(first.hasMore, true)
    assert.ok(first.rows.every((row) => row.sessionIdType === 'text'), 'valid owners retain their SQLite text type')
    const seen = [...first.rows.map((row) => row.sourceId)]
    let after = first.rows.at(-1).sourceId
    while (after !== undefined) {
      const page = store.dashboardProcessingSourcePage(job.id, after, 4)
      seen.push(...page.rows.map((row) => row.sourceId))
      after = page.hasMore ? page.rows.at(-1)?.sourceId : undefined
    }
    assert.equal(seen.length, sourceIds.length)
    assert.ok(seen.every((sourceId) => typeof sourceId === 'string'))
    assert.deepEqual(seen, [...sourceIds].sort())
    const projectedSourceId = first.rows[0].sourceId
    assert.ok(projectedSourceId)
    store.db.prepare('UPDATE extraction_job_sources SET session_id = CAST(? AS BLOB) WHERE job_id = ? AND source_id = ?')
      .run('', job.id, projectedSourceId)
    const emptyBlobOwner = store.dashboardProcessingSourcePage(job.id).rows.find((row) => row.sourceId === projectedSourceId)
    assert.equal(emptyBlobOwner.sessionIdType, 'invalid')
    assert.equal(emptyBlobOwner.sessionId, undefined)
    assert.equal(emptyBlobOwner.sessionIdBytes, 0, 'the empty BLOB keeps its zero-byte length without becoming a missing text owner')
    store.db.prepare('UPDATE extraction_job_sources SET session_id = CAST(? AS BLOB) WHERE job_id = ? AND source_id = ?')
      .run('other-session', job.id, projectedSourceId)
    const nonemptyBlobOwner = store.dashboardProcessingSourcePage(job.id).rows.find((row) => row.sourceId === projectedSourceId)
    assert.equal(nonemptyBlobOwner.sessionIdType, 'invalid')
    assert.equal(nonemptyBlobOwner.sessionIdBytes, Buffer.byteLength('other-session'))
    assert.equal(store.dashboardProcessingSourcePending(sourceIds[0]).pending, true)
    store.db.exec('BEGIN')
    store.db.prepare('UPDATE l0_messages SET extracted_at = 1 WHERE project_key = ? AND id = ?').run(key, sourceIds[0])
    store.db.exec('COMMIT')
    assert.equal(store.dashboardProcessingSourcePending(sourceIds[0]).pending, false)
    assert.deepEqual(store.dashboardProcessingSourcePending('missing-processing-source'), { exists: false, pending: false })
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the C repeated route refuses a missing association index instead of falling back unbounded', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-repeated-index-'))
  let store
  try {
    store = openProjectStore(root, 'repeated-index-project')
    store.db.exec('DROP INDEX memory_events_association')
    assert.throws(() => store.repeatedCapturesPage({ from: 0, to: Date.now() }),
      /events association index is missing/u)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the C bounded repeated scan seeks fingerprints, L0 members and capture events without unbounded aggregation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-repeated-seek-'))
  let store
  try {
    store = openProjectStore(root, 'repeated-seek-project')
    const base = Date.UTC(2026, 9, 23, 12)
    const alphaOne = store.recordL0({ sessionId: 'repeat-session', role: 'user', content: 'Synthetic repeat alpha question.', createdAt: base, recordedAt: base,
      sourceEventId: 'repeat-alpha-origin' })
    const alphaTwo = store.recordL0({ sessionId: 'repeat-session', role: 'user', content: 'Synthetic repeat alpha question.', createdAt: base + 1_000, recordedAt: base + 1_000 })
    const beta = store.recordL0({ sessionId: 'repeat-session', role: 'user', content: 'Synthetic repeat beta question.', createdAt: base + 2_000, recordedAt: base + 2_000 })
    const assistant = store.recordL0({ sessionId: 'repeat-session', role: 'assistant', content: 'Synthetic repeat alpha question.', createdAt: base + 3_000, recordedAt: base + 3_000 })
    const fingerprintOf = (id) => store.db.prepare('SELECT fingerprint FROM l0_messages WHERE id = ?').get(id).fingerprint
    const alpha = fingerprintOf(alphaOne)
    const betaFingerprint = fingerprintOf(beta)
    assert.notEqual(alpha, betaFingerprint)
    assert.equal(fingerprintOf(assistant), null, 'assistant rows never receive a fingerprint')
    const ordered = [alpha, betaFingerprint].sort()
    assert.equal(store.dashboardRepeatFingerprintNext().fingerprint, ordered[0])
    assert.equal(store.dashboardRepeatFingerprintNext(ordered[0]).fingerprint, ordered[1])
    assert.equal(store.dashboardRepeatFingerprintNext(ordered[1]), undefined)
    const membersFirst = store.dashboardRepeatGroupMemberPage(alpha, undefined, 1)
    assert.equal(membersFirst.rows.length, 1)
    assert.equal(membersFirst.hasMore, true)
    const firstMember = membersFirst.rows[0]
    assert.equal(firstMember.memberId, alphaOne)
    const membersSecond = store.dashboardRepeatGroupMemberPage(alpha, { createdAt: firstMember.createdAt, rowid: firstMember.rowid }, 1)
    assert.equal(membersSecond.rows.length, 1)
    assert.equal(membersSecond.rows[0].memberId, alphaTwo)
    assert.equal(membersSecond.hasMore, false)
    store.appendEvent({ eventId: 'capture:repeat-extra-1', type: 'capture', sourceId: alphaOne,
      sessionId: 'repeat-session', source: 'dsh-session', occurredAt: base, count: 1 }, base + 10)
    const eventsFirst = store.dashboardRepeatCaptureEventPage(alphaOne, base, base + 60_000, undefined, 1)
    assert.equal(eventsFirst.rows.length, 1)
    assert.equal(eventsFirst.hasMore, true)
    const eventsSecond = store.dashboardRepeatCaptureEventPage(alphaOne, base, base + 60_000,
      { createdAt: eventsFirst.rows[0].createdAt, id: eventsFirst.rows[0].id }, 1)
    assert.equal(eventsSecond.rows.length, 1)
    assert.notEqual(eventsSecond.rows[0].id, eventsFirst.rows[0].id)
    assert.equal(eventsSecond.rows[0].sourceId, alphaOne)
    assert.equal(eventsFirst.rows[0].l0SourceEventId, 'repeat-alpha-origin')
    assert.equal(eventsFirst.rows[0].eventSourceEventId, 'repeat-alpha-origin')
    assert.equal(eventsSecond.rows[0].l0SourceEventId, 'repeat-alpha-origin',
      'the L0 identity is preserved separately from the event identity')
    assert.equal(eventsSecond.rows[0].eventSourceEventId, 'repeat-extra-1',
      'a second event on the same L0 keeps its own Host identity for an independent fence')
    assert.equal(store.dashboardRepeatCaptureEventPage(alphaOne, base + 120_000, base + 180_000).rows.length, 0,
      'events outside the direct record-time window are never enumerated')
    const excerpt = store.dashboardRepeatExcerpt(alphaOne)
    assert.equal(excerpt.excerpt, 'Synthetic repeat alpha question.')
    assert.equal(excerpt.excerptTruncated, false)
    assert.equal(store.dashboardRepeatExcerpt(assistant).excerpt, 'Synthetic repeat alpha question.',
      'excerpt reads the raw L0 row only when explicitly requested')
    const overlongRow = store.recordL0({ sessionId: 'repeat-session', role: 'user',
      content: 'Synthetic overlong legacy fingerprint row.', createdAt: base + 4_000, recordedAt: base + 4_000 })
    store.db.prepare('UPDATE l0_messages SET fingerprint = ? WHERE id = ?').run('z'.repeat(600), overlongRow)
    const overlong = store.dashboardRepeatFingerprintNext(ordered[1])
    assert.equal(overlong.fingerprint, undefined, 'an over-long legacy key is never truncated')
    assert.equal(overlong.fingerprintBytes, 600)
    store.db.exec('DROP INDEX memory_events_association')
    assert.throws(() => store.dashboardRepeatCaptureEventPage(alphaOne, base, base + 60_000),
      /events association index is missing/u)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('event pages distinguish a real project L0 from a bare capture source id', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-event-l0-found-'))
  let store
  try {
    store = openProjectStore(root, 'event-l0-found-project')
    const linked = store.recordL0({ sessionId: 'event-l0-session', role: 'user', content: 'Synthetic linked event.',
      createdAt: 1_000, recordedAt: 1_000 })
    store.appendEvent({ eventId: 'capture:missing-source-event', type: 'capture', sourceId: 'l0_missing_elsewhere',
      sessionId: 'event-l0-session', source: 'synthetic', occurredAt: 1_001, count: 1 }, 1_001)
    const page = store.dashboardReadEventPage(0, 15)
    const linkedRow = page.rows.find((row) => row.sourceId === linked)
    const missingRow = page.rows.find((row) => row.sourceId === 'l0_missing_elsewhere')
    assert.ok(linkedRow && missingRow)
    assert.equal(linkedRow.l0Found, true)
    assert.equal(missingRow.l0Found, false, 'a bare source id is never reported as an existing L0')
    assert.equal(missingRow.sourceId, 'l0_missing_elsewhere')
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('store experience matching uses explicit condition facts and keeps failure history', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-experience-'))
  try {
    const store = openProjectStore(root, 'project-experience')
    const sourceA = store.recordL0({ sessionId: 's1', role: 'user', content: 'Cache recovery requires a moved path.' })
    const sourceB = store.recordL0({ sessionId: 's2', role: 'user', content: 'Independent report about cache recovery.' })
    const evidenceA = store.addMemory({ content: 'Cache recovery evidence one.', status: 'approved', sourceMessageIds: [sourceA], sourceVerified: true }).record
    const evidenceB = store.addMemory({ content: 'Cache recovery evidence two.', status: 'approved', sourceMessageIds: [sourceB], sourceVerified: true }).record
    const card = store.saveExperience({ id: 'exp-env', title: 'Cache recovery', symptom: 'stale cache after path change',
      environment: { os: 'linux', runtime: 'node-22' }, prerequisites: ['path has moved'], steps: ['clear derived index'],
      outcomes: ['index rebuilt'], counterexamples: ['source rows are missing'], evidenceMemoryIds: [evidenceA.id, evidenceB.id] })
    assert.equal(card.status, 'episode')

    const satisfied = store.matchExperiences('cache recovery', { os: 'linux', runtime: 'node-22' }, 10,
      { conditions: { runtime: 'node-22' }, satisfiedPrerequisites: ['path has moved'] })[0]
    assert.equal(satisfied.applicability, 'applicable')
    assert.equal(satisfied.conditionState, 'satisfied')
    assert.deepEqual(satisfied.prerequisites.satisfied, ['path has moved'])
    assert.equal(satisfied.verified, false, 'caller facts never upgrade an episode to verified')
    assert.equal(satisfied.executionAuthorized, false, 'caller facts never grant execution authority')
    assert.equal(satisfied.experience.status, 'episode', 'matching never writes the card status')

    const missing = store.matchExperiences('cache recovery', { os: 'linux', runtime: 'node-22' }, 10)[0]
    assert.equal(missing.applicability, 'conditions_missing')
    assert.deepEqual(missing.prerequisites.unresolved, ['path has moved'])
    const different = store.matchExperiences('cache recovery', { os: 'windows', runtime: 'node-20' }, 10)[0]
    assert.equal(different.applicability, 'inapplicable', 'an explicit environment mismatch is reported even with stored counterexamples')
    const counterexample = store.matchExperiences('cache recovery source rows are missing', { os: 'linux', runtime: 'node-22' }, 10)[0]
    assert.equal(counterexample.applicability, 'known_counterexample')

    store.reviewExperience(card.id, true)
    const verified = store.matchExperiences('cache recovery', { os: 'linux', runtime: 'node-22' }, 10)[0]
    assert.equal(verified.verified, true)
    assert.equal(verified.applicability, 'conditions_missing', 'a verified card still needs its prerequisites supplied explicitly')
    assert.equal(verified.experience.status, 'verified')

    const rejected = store.saveExperience({ id: 'exp-rejected', title: 'Cache recovery variant', symptom: 'stale cache after path change',
      environment: { os: 'linux', runtime: 'node-22' }, prerequisites: [], steps: [], outcomes: [], counterexamples: ['source rows are missing'],
      evidenceMemoryIds: [evidenceA.id, evidenceB.id] })
    assert.equal(store.matchExperiences('cache recovery', { os: 'linux' }, 10).length, 2, 'failed history stays visible for review')
    store.reviewExperience(rejected.id, false)
    const rejectedMatch = store.matchExperiences('cache recovery', { os: 'linux' }, 10).find((item) => item.experience.id === 'exp-rejected')
    assert.equal(rejectedMatch?.experience.status, 'rejected')
    assert.equal(rejectedMatch?.verified, false)

    store.forget(evidenceA.id)
    assert.deepEqual(store.matchExperiences('cache recovery', { os: 'linux' }, 10), [], 'stale evidence hides the card from matching')
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store experience matching propagates truncated environment and prerequisite comparisons', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-store-experience-truncated-'))
  let store
  try {
    store = openProjectStore(root, 'project-experience-truncated')
    const sourceA = store.recordL0({ sessionId: 's1', role: 'user', content: 'Environment overflow evidence.' })
    const sourceB = store.recordL0({ sessionId: 's2', role: 'user', content: 'Prerequisite overflow evidence.' })
    const evidenceA = store.addMemory({ content: 'Environment overflow evidence memory.', status: 'approved', sourceMessageIds: [sourceA], sourceVerified: true }).record
    const evidenceB = store.addMemory({ content: 'Prerequisite overflow evidence memory.', status: 'approved', sourceMessageIds: [sourceB], sourceVerified: true }).record
    const expectedEnvironment = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, `value-${index}`]))
    const prerequisites = Array.from({ length: 33 }, (_, index) => `required condition ${index}`)
    store.saveExperience({ id: 'exp-overflow-env', title: 'Environment overflow', symptom: 'bounded environment facts',
      environment: expectedEnvironment, prerequisites: [], steps: [], outcomes: [], counterexamples: [], evidenceMemoryIds: [evidenceA.id, evidenceB.id] })
    store.saveExperience({ id: 'exp-overflow-prereq', title: 'Prerequisite overflow', symptom: 'bounded prerequisite facts',
      environment: { os: 'linux' }, prerequisites, steps: [], outcomes: [], counterexamples: [], evidenceMemoryIds: [evidenceA.id, evidenceB.id] })

    const matchedEnvironment = Object.fromEntries(Object.entries(expectedEnvironment).slice(0, 32))
    const environmentResult = store.matchExperiences('environment overflow', matchedEnvironment, 10)
      .find((item) => item.experience.id === 'exp-overflow-env')
    assert.equal(environmentResult?.applicability, 'conditions_missing')
    assert.equal(environmentResult?.conditionState, 'unknown')
    assert.equal(environmentResult?.truncated, true)
    assert.equal(environmentResult?.reviewNeeded, true)

    const prerequisiteResult = store.matchExperiences('prerequisite overflow', { os: 'linux' }, 10,
      { satisfiedPrerequisites: prerequisites.slice(0, 32) }).find((item) => item.experience.id === 'exp-overflow-prereq')
    assert.equal(prerequisiteResult?.applicability, 'conditions_missing')
    assert.equal(prerequisiteResult?.conditionState, 'unknown')
    assert.equal(prerequisiteResult?.truncated, true)
    assert.equal(prerequisiteResult?.prerequisites.satisfied.length, 32)
    assert.deepEqual(prerequisiteResult?.prerequisites.unresolved, [])
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})


test('committed route binding splits only same-session same-turn sources and preserves frozen provenance', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-route-proof-'))
  let store = openProjectStore(root, 'route-proof')
  const now = Date.now()
  try {
    const capture = (id, sessionId = 's1') => store.captureMessage({ sessionId, role: 'user', content: `Synthetic source ${id}`,
      createdAt: now, sourceEventId: id, agentPreset: 'agent-mock' }).id
    const unknown = capture('unknown'), first = capture('first'), later = capture('later'), other = capture('other', 's2')
    store.recordSourceRequestContext({ sourceId: first, sessionId: 's1', turn: 1, step: 1, seq: 3 })
    store.recordSourceRequestContext({ sourceId: later, sessionId: 's1', turn: 2, step: 1, seq: 8 })
    store.recordSourceRequestContext({ sourceId: other, sessionId: 's2', turn: 1, step: 1, seq: 3 })
    const queue = (sourceId) => store.enqueueExtractionJob({ sessionId: 's1', sourceId, policyRevision: 'v1', quietMs: 0, maxWaitMs: 60000, now })
    const original = queue(unknown); queue(first); queue(later)
    assert.equal(store.nextActionableExtractionJob('s1', now), undefined)
    assert.equal(store.nextExtractionDueAt('s1'), undefined, 'route-less queue does not create a polling loop')
    const commit = { sessionId: 's1', turn: 1, step: 1, seq: 4, kind: 'request/header', provider: 'mock', model: 'first' }
    assert.equal(store.bindCommittedSourceRoute({ ...commit, seq: 2 }), 0, 'a header older than capture proves nothing')
    assert.equal(store.bindCommittedSourceRoute({ ...commit, step: 2 }), 0, 'another step cannot claim a source')
    assert.equal(store.bindCommittedSourceRoute(commit), 1)
    const runnable = store.nextActionableExtractionJob('s1', now)
    assert.deepEqual(runnable.sourceIds, [first]); assert.equal(runnable.model, 'first')
    assert.deepEqual(store.getExtractionJob(original.id).sourceIds, [unknown, later])
    assert.equal(store.getExtractionJob(original.id).provider, undefined)
    assert.equal(store.db.prepare('SELECT request_seq FROM extraction_source_routes WHERE source_id = ?').get(other).request_seq, null)
    assert.deepEqual(store.captureMessage({ sessionId: 's1', role: 'user', content: 'Synthetic source first', createdAt: now,
      sourceEventId: 'first', agentPreset: 'agent-mock' }), { id: first, created: false }, 'late binding must not break exact event replay')
    store.freezeExtractionJob(runnable.id, now)
    store.updateExtractionJob(runnable.id, 'uncertain_remote', 'synthetic unknown outcome', now)
    assert.equal(store.bindCommittedSourceRoute({ ...commit, seq: 5, model: 'changed' }), 0)
    assert.equal(store.nextActionableExtractionJob('s1', now + 86400000, true, true), undefined)
    store.close(); store = openProjectStore(root, 'route-proof')
    assert.equal(store.getExtractionJob(runnable.id).status, 'uncertain_remote')
    assert.equal(store.getExtractionJob(runnable.id).model, 'first')
    assert.equal(store.db.prepare('SELECT request_seq FROM extraction_source_routes WHERE source_id = ?').get(first).request_seq, 4)
    assert.equal(store.bindCommittedSourceRoute({ ...commit, turn: 2, seq: 9, model: 'second' }), 1)
    assert.deepEqual(store.nextActionableExtractionJob('s1', now).sourceIds, [later], 'the next proven turn progresses independently')
    assert.deepEqual(store.getExtractionJob(original.id).sourceIds, [unknown], 'no evidence is invented for historical unknown sources')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('route-less backlog cannot hide fresh routed sources beyond the first capture batch', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-route-fairness-'))
  const store = openProjectStore(root, 'route-fairness'), now = Date.now()
  try {
    for (let i = 0; i < 30; i += 1) store.recordL0({ sessionId: 's1', role: 'user', content: `Unknown historical source ${i}`, createdAt: now - 1000 + i })
    const fresh = store.recordL0({ sessionId: 's1', role: 'user', content: 'Fresh routed source', provider: 'mock', model: 'mock', createdAt: now })
    assert.equal(store.pendingExtractionSources('s1')[0].id, fresh)
    for (const source of store.unextracted('s1', 100)) store.enqueueExtractionJob({ sessionId: 's1', sourceId: source.id,
      policyRevision: 'v1', quietMs: 0, maxWaitMs: 60000, now })
    assert.equal(store.extractionJobs().filter((job) => job.provider === undefined).length, 2, 'full route-less batches do not reject the next source')
    assert.deepEqual(store.nextActionableExtractionJob('s1', now).sourceIds, [fresh])
    assert.deepEqual(store.pendingExtractionSources('s1'), [], 'owned failed or unresolved sources are not re-enqueued')
    assert.equal(store.unextracted('s1', 100).length, 31)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
