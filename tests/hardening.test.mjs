import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { MEMORY_SCHEMA_VERSION, openProjectStore, openProjectStoreReadOnly } from '../lib/store.js'
import { estimateTokens } from '../lib/tokens.js'
import { endTurnAfterQuietWindow, sourceAwareStream } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

function mockContext(cwd, memoryText = '用户偏好使用 pnpm 管理前端项目。', confidence = 0.93) {
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: { stream: sourceAwareStream((sourceIds) => ({ memories: [{ content: memoryText, kind: 'preference', confidence, source_message_ids: sourceIds }] })) },
    sessions: {
      get: () => ({
        id: 's1',
        header: { cwd, agentPreset: 'agent-mock' },
        requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
      }),
    },
    get() {
      return undefined
    },
  }
}

function captureTurn(runtime, cwd, userText = '以后前端都用 pnpm。') {
  const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
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
  endTurnAfterQuietWindow(runtime, session, 3)
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
      extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0, provider: 'mock', model: 'mock-model' },
      budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
      recall: { enabled: true, minScore: 0 },
    })
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }

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
    endTurnAfterQuietWindow(second, session, 3)
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
    // Demo v7 replaces mandatory review with confidence gating. Preserve the negative: uncertain candidates need explicit legacy approval.
    const config = resolveConfig({
      mode: 'review',
      extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0, provider: 'mock', model: 'mock-model' },
      budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
      recall: { enabled: true, minScore: 0 },
    })
    runtime = new MemoryRuntime(mockContext(cwd, '用户偏好使用 pnpm 管理前端项目。', 0.2), config, root)
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

test('recall packets refresh only memories retained in current messages and cap results', () => {
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
    assert.equal(first.length, 3, 'recall returns a bounded candidate window before packet result limits')
    const block = runtime.formatRecall(cwd, first, 's1')
    assert.ok(block?.includes('pnpm'))
    const references = (text) => [...text.matchAll(/\[([^\]@]+)@r(\d+)\]/gu)].map((match) => ({ id: match[1], revision: Number(match[2]) }))
    const selectedIds = (text) => references(text).map((reference) => reference.id)
    const firstInjected = references(block ?? '')
    assert.equal(firstInjected.length, 2, 'the final injected packet respects maxResults')
    const next = runtime.recall(cwd, 'pnpm', 's1')
    const nextBlock = runtime.formatRecall(cwd, next, 's1', firstInjected)
    const secondInjected = selectedIds(nextBlock ?? '')
    assert.equal(secondInjected.length, 2, 'the replacement packet retains current message references within maxResults')
    assert.deepEqual(secondInjected.sort(), firstInjected.map((reference) => reference.id).sort())
    assert.ok(estimateTokens(nextBlock ?? '') <= runtime.config.recall.maxTokens, 'the single replacement packet stays within its final token budget')
    const retainedOnly = runtime.formatRecall(cwd, [], 's1', firstInjected)
    assert.equal(selectedIds(retainedOnly ?? '').length, 2, 'valid current references can be regenerated without new search hits')
    assert.equal(runtime.formatRecall(cwd, [], 's1'), undefined, 'no hits and no references in the current messages produce no packet')
    const otherSessionBlock = runtime.formatRecall(cwd, runtime.recall(cwd, 'pnpm', 's2'), 's2')
    assert.equal(selectedIds(otherSessionBlock ?? '').length, 2, 'another session can format its own current search results')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent recall explanation pages candidates and measures the complete rendered packet', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-explain-budget-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-explain-budget-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = openProjectStore(root, project.key, project)
    for (let index = 0; index < 12; index += 1) {
      store.addMemory({
        content: `pagination retrieval decision marker item ${index}`,
        kind: 'decision', confidence: 0.9, status: 'approved',
      })
    }
    store.close()

    const config = resolveConfig({ capture: { enabled: true }, extraction: { enabled: false } })
    runtime = new MemoryRuntime(mockContext(cwd), config, root)
    const first = runtime.explainForAgent(cwd, 'pagination retrieval', { limit: 4, budgetTokens: 6000 })
    assert.equal(first.candidates.length, 4)
    assert.ok(first.candidateCount > first.candidates.length)
    assert.equal(first.nextOffset, 4)
    assert.equal(first.estimatedTokens, estimateTokens(JSON.stringify(first, null, 2)))
    assert.ok(first.estimatedTokens <= 6000)

    const second = runtime.explainForAgent(cwd, 'pagination retrieval', { limit: 4, offset: first.nextOffset, budgetTokens: 6000 })
    assert.equal(second.offset, 4)
    assert.equal(second.candidates.length, 4)
    assert.ok(first.candidates.every((candidate) => !second.candidates.some((next) => next.id === candidate.id)))
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('memory evidence pages preserve source order and advance by source IDs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-evidence-page-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-evidence-page-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = openProjectStore(root, project.key, project)
    const sourceIds = Array.from({ length: 4 }, (_, index) => store.recordL0({
      sessionId: 's1', role: 'user', content: `ordered evidence source ${index}`, turn: index + 1,
      createdAt: 1_000 + index, agentPreset: 'agent-mock',
    }))
    const memory = store.addMemory({
      content: 'Approved evidence pagination memory.', kind: 'fact', confidence: 0.9, status: 'approved',
      sourceMessageIds: sourceIds, sourceVerified: true,
    })
    store.close()

    const config = resolveConfig({ capture: { enabled: true }, extraction: { enabled: false } })
    runtime = new MemoryRuntime(mockContext(cwd), config, root)
    const first = runtime.evidencePage(cwd, memory.record.id, 2, 0)
    assert.deepEqual(first.evidence.map((item) => item.id), sourceIds.slice(0, 2))
    assert.equal(first.totalEvidence, 4)
    assert.equal(first.nextEvidenceOffset, 2)

    const second = runtime.evidencePage(cwd, memory.record.id, 2, first.nextEvidenceOffset)
    assert.deepEqual(second.evidence.map((item) => item.id), sourceIds.slice(2))
    assert.equal(second.nextEvidenceOffset, undefined)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('store upgrades and reopens at the current schema while rejecting future versions', () => {
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
    assert.equal(store.stats().schemaVersion, MEMORY_SCHEMA_VERSION)
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, MEMORY_SCHEMA_VERSION)
    const rows = store.unextracted('s1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].content, '旧库中的未抽取消息。')
    store.close()
    store = undefined

    store = openProjectStore(root, 'legacy', project)
    assert.equal(store.stats().schemaVersion, MEMORY_SCHEMA_VERSION)
    store.close()
    store = undefined

    const filePath = path.join(root, 'projects', 'legacy', 'memory.db')
    const futureMetaDb = new DatabaseSync(filePath)
    futureMetaDb.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(MEMORY_SCHEMA_VERSION + 1))
    futureMetaDb.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
    futureMetaDb.close()
    assert.throws(() => openProjectStore(root, 'legacy', project), /schema is newer than this plugin supports/u)

    const futureUserVersionDb = new DatabaseSync(filePath)
    futureUserVersionDb.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(MEMORY_SCHEMA_VERSION))
    futureUserVersionDb.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION + 1}`)
    futureUserVersionDb.close()
    assert.throws(() => openProjectStore(root, 'legacy', project), /schema is newer than this plugin supports/u)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('schema 7 and 8 migrations keep a verified pre-migration backup and do not duplicate it on current-schema reopen', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-upgrade-r78-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-upgrade-r78-project-'))
  const project = projectIdentity(cwd)
  try {
    for (const oldVersion of [7, 8]) {
      const seed = openProjectStore(root, project.key, project)
      const sourceId = seed.recordL0({ sessionId: `legacy-${oldVersion}`, role: 'user', content: `Synthetic schema ${oldVersion} source.` })
      const memory = seed.addMemory({ content: `Synthetic schema ${oldVersion} memory.`, status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true }).record
      seed.close()
      const file = path.join(root, 'projects', project.key, 'memory.db')
      const downgrade = new DatabaseSync(file)
      downgrade.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(oldVersion))
      downgrade.exec(`PRAGMA user_version = ${oldVersion}`)
      downgrade.close()

      const migrated = openProjectStore(root, project.key, project)
      assert.equal(migrated.stats().schemaVersion, MEMORY_SCHEMA_VERSION)
      migrated.close()
      const backupDirectory = path.join(path.dirname(file), 'migration-backups')
      const backups = readdirSync(backupDirectory).filter((name) => name.endsWith('.db'))
      assert.equal(backups.length, oldVersion === 7 ? 1 : 2)
      const matchingBackup = backups.filter((name) => name.startsWith(`schema-${oldVersion}-`))
      assert.equal(matchingBackup.length, 1)
      const backupFile = path.join(backupDirectory, matchingBackup[0])
      const receipt = JSON.parse(readFileSync(`${backupFile}.json`, 'utf8'))
      assert.equal(receipt.schema.recordedVersion, oldVersion)
      assert.equal(receipt.schema.userVersion, oldVersion)
      assert.equal(receipt.dataIdentity.l0Count, oldVersion === 7 ? 1 : 2)
      assert.ok(receipt.dataIdentity.l0IdsSha256)
      const backupDb = new DatabaseSync(backupFile, { readOnly: true })
      assert.equal(backupDb.prepare('SELECT 1 AS found FROM l1_memories WHERE id = ?').get(memory.id)?.found, 1)
      backupDb.close()

      const beforeReopenCount = backups.length
      const current = openProjectStore(root, project.key, project)
      assert.equal(current.stats().schemaVersion, MEMORY_SCHEMA_VERSION)
      current.close()
      assert.equal(readdirSync(backupDirectory).filter((name) => name.endsWith('.db')).length, beforeReopenCount)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a failed pre-migration backup blocks schema 7 migration before the database is changed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-upgrade-r7-fail-root-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-upgrade-r7-fail-project-'))
  const project = projectIdentity(cwd)
  try {
    const seed = openProjectStore(root, project.key, project)
    seed.recordL0({ sessionId: 'legacy', role: 'user', content: 'Synthetic backup failure source.' })
    seed.close()
    const file = path.join(root, 'projects', project.key, 'memory.db')
    const downgrade = new DatabaseSync(file)
    downgrade.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run()
    downgrade.exec('PRAGMA user_version = 7')
    downgrade.close()
    const backupDirectory = path.join(path.dirname(file), 'migration-backups')
    const externalDirectory = path.join(root, 'external-backups')
    mkdirSync(externalDirectory)
    symlinkSync(externalDirectory, backupDirectory, 'dir')

    assert.throws(() => openProjectStore(root, project.key, project), /pre-migration backup directory/u)
    const unchanged = new DatabaseSync(file, { readOnly: true })
    assert.equal(unchanged.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, '7')
    assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version, 7)
    unchanged.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})


test('route provenance migration backs up schema 9 while retaining compatible read-only access', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-route-migration-'))
  let store
  try {
    store = openProjectStore(root, 'route-migration')
    const sourceId = store.recordL0({ sessionId: 'legacy', role: 'user', content: 'Synthetic original capture without route.' })
    const file = store.file
    store.close(); store = undefined
    const legacy = new DatabaseSync(file)
    legacy.exec("DROP TABLE extraction_source_routes; UPDATE meta SET value = '9' WHERE key = 'schema_version'; PRAGMA user_version = 9")
    legacy.close()
    store = openProjectStoreReadOnly(root, 'route-migration')
    assert.equal(store.unextracted('legacy')[0].id, sourceId)
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 9, 'read-only access does not migrate inactive projects')
    store.close()
    store = openProjectStore(root, 'route-migration')
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, MEMORY_SCHEMA_VERSION)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM extraction_source_routes').get().n, 0, 'old unknown routes are not backfilled')
    assert.equal(store.unextracted('legacy')[0].id, sourceId)
    const directory = path.join(path.dirname(file), 'migration-backups')
    const backups = readdirSync(directory).filter((name) => name.endsWith('.db'))
    assert.equal(backups.length, 1)
    const receipt = JSON.parse(readFileSync(path.join(directory, `${backups[0]}.json`), 'utf8'))
    assert.equal(receipt.schema.userVersion, 9); assert.equal(receipt.dataIdentity.l0Count, 1)
    store.close(); store = openProjectStore(root, 'route-migration')
    assert.equal(readdirSync(directory).filter((name) => name.endsWith('.db')).length, 1)
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }) }
})
