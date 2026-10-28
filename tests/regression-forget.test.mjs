import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { meteredGatedStream, meteredStream, scriptedContext } from './helpers.mjs'

function cfg(withGlobal = false) {
  return resolveConfig({
    mode: 'balanced',
    extraction: { provider: 'mock', model: 'mock' },
    recall: { enabled: true, minScore: 0, includePersona: true, maxResults: 20 },
    persona: { global: withGlobal },
    budget: { manualDailyTokens: 1_000_000, manualDailyTasks: 100 },
  })
}

function seededStore(root, project, memories) {
  const store = openProjectStore(root, project.key, project)
  for (const m of memories) {
    store.addMemory({ content: m.content, kind: m.kind ?? 'fact', scene: m.scene ?? 'workflow', confidence: 0.9, status: 'approved', source: 'manual' })
  }
  return store
}

function openInterruptedObservedCall(root, cwd, usage) {
  const config = cfg()
  const project = projectIdentity(cwd)
  const openRuntime = () => new MemoryRuntime(scriptedContext({ script: [], config }).ctx, config, root)
  let runtime = openRuntime()
  const callId = 'bill_r11_interrupted_observed_usage'
  const requestHash = 'e'.repeat(64)
  const now = Date.now()
  try {
    runtime.status(cwd)
    runtime.control.reserveBillableCall({ id: callId, projectKey: project.key, purpose: 'project_persona', budgetClass: 'manual',
      reservedTokens: 512,
      provider: 'mock', model: 'mock-model', requestHash, now })
    runtime.control.markBillableCallDispatched(callId, now + 1)
    runtime.control.recordBillableUsageObservation({ callId, projectKey: project.key, purpose: 'project_persona',
      provider: 'mock', model: 'mock-model', requestHash, usage, now: now + 2 })
    runtime.close()
    runtime = openRuntime()
    return { runtime, project, callId, requestHash, config }
  } catch (error) {
    runtime.close()
    throw error
  }
}

test('forget rebuilds L2 and stales the project persona that referenced it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-forget-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-forget-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = seededStore(root, project, [
      { content: 'AlphaFact 使用 pnpm 锁版本。', scene: 'tooling' },
      { content: 'BetaFact 部署走 GitHub Actions。', scene: 'tooling' },
      { content: 'GammaFact 接口超时改为 30 秒。', scene: 'tooling' },
    ])
    const storeList = store.list('approved', 50)
    const alpha = storeList.find((r) => r.content.includes('AlphaFact'))
    const beta = storeList.find((r) => r.content.includes('BetaFact'))
    assert.ok(alpha && beta)
    store.setPersona('本项目的工具与部署约定。', 3, storeList.map((r) => r.id), Date.now(), Object.fromEntries(storeList.map((r) => [r.id, r.revision])))
    // settle scenes once, as if a previous extraction had built them
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg() }).ctx, cfg(), root)
    const hitsStore = openProjectStore(root, project.key, project)
    const hits = hitsStore.list('approved', 50).map((r) => ({ record: r, score: 0.9 }))
    hitsStore.close()

    const before = runtime.formatRecall(cwd, hits)
    assert.match(before ?? '', /persona-summary/, 'stale-free persona is injected')

    const store3 = openProjectStore(root, project.key, project)
    const sceneBefore = store3.scenes().find((s) => s.name === 'tooling')
    assert.ok(sceneBefore)
    assert.match(sceneBefore.summary, /AlphaFact/)
    store3.close()

    runtime.forget(cwd, alpha.id)

    const store4 = openProjectStore(root, project.key, project)
    const sceneAfter = store4.scenes().find((s) => s.name === 'tooling')
    assert.ok(sceneAfter)
    assert.doesNotMatch(sceneAfter.summary, /AlphaFact/, 'L2 scene no longer contains the forgotten fact')
    assert.equal(sceneAfter.memoryCount, 2)
    const persona = store4.persona()
    assert.ok(persona, 'persona row remains but is flagged stale')
    assert.equal(persona?.stale, true)
    store4.close()

    const after = runtime.formatRecall(cwd, hits)
    assert.doesNotMatch(after ?? '<none>', /persona-summary/, 'stale persona is not injected')
    assert.match(after ?? '', /BetaFact/, 'recalled facts are still injected')
    assert.doesNotMatch(after ?? '', /AlphaFact/, 'forgotten fact is no longer recalled')
    assert.ok(runtime.status().lastError === undefined)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('review forget also rebuilds L2 and stales the persona', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-review-forget-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-review-forget-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = seededStore(root, project, [
      { content: 'DeltaFact 使用 Vitest。', scene: 'tooling' },
      { content: 'EpsilonFact 使用 pnpm。', scene: 'tooling' },
      { content: 'ZetaFact 使用 Node 22。', scene: 'tooling' },
    ])
    const approved = store.list('approved', 50)
    const delta = approved.find((r) => r.content.includes('DeltaFact'))
    assert.ok(delta)
    store.setPersona('测试工具链约定。', 3, approved.map((r) => r.id), Date.now(), Object.fromEntries(approved.map((r) => [r.id, r.revision])))
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg() }).ctx, cfg(), root)
    runtime.review(project.key, delta.id, 'forget')
    const reopened = openProjectStore(root, project.key, project)
    const scene = reopened.scenes().find((s) => s.name === 'tooling')
    assert.ok(scene)
    assert.doesNotMatch(scene.summary, /DeltaFact/)
    assert.equal(scene.memoryCount, 2)
    assert.equal(reopened.persona()?.stale, true)
    reopened.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('review refreshes non-target scenes when valid-time boundaries cross', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-review-time-scenes-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-review-time-project-'))
  const project = projectIdentity(cwd)
  let runtime
  try {
    const store = openProjectStore(root, project.key, project)
    const now = Date.now()
    const futureStart = now + 5_000
    const expiry = now + 10_000
    const expired = store.addMemory({ content: 'Synthetic expiring memory in scene A.', status: 'approved', scene: 'scene-a',
      validFrom: now - 1000, validTo: expiry }).record
    const stable = store.addMemory({ content: 'Synthetic stable memory in scene A.', status: 'approved', scene: 'scene-a' }).record
    const future = store.addMemory({ content: 'Synthetic future memory in scene A.', status: 'approved', scene: 'scene-a', validFrom: futureStart }).record
    const target = store.addMemory({ content: 'Synthetic candidate in scene B.', status: 'candidate', scene: 'scene-b' }).record
    store.refreshScenes()
    store.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg() }).ctx, cfg(), root)
    const actualNow = Date.now
    Date.now = () => expiry + 1
    try {
      runtime.review(project.key, target.id, 'approve')
      const sceneA = runtime.dashboard().scenes.find((scene) => scene.name === 'scene-a')
      assert.ok(sceneA, 'the still-readable non-target scene remains visible')
      assert.equal(sceneA.memoryCount, 2)
      assert.deepEqual(new Set(sceneA.sourceIds), new Set([stable.id, future.id]))
      assert.equal(sceneA.sourceIds.includes(expired.id), false)
      assert.match(sceneA.summary, /stable memory/)
      assert.match(sceneA.summary, /future memory/)
      assert.doesNotMatch(sceneA.summary, /expiring memory/)
    } finally { Date.now = actualNow }
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('forget rebuilds persisted old scenes when exclude or valid-time makes the old revision unreadable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-forget-persisted-scenes-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-forget-persisted-scenes-project-'))
  const project = projectIdentity(cwd)
  let runtime
  const actualNow = Date.now
  try {
    const now = actualNow()
    Date.now = () => now
    const expiry = now + 60_000
    const futureStart = expiry + 60_000
    const store = openProjectStore(root, project.key, project)
    const excludedSource = store.recordL0({ sessionId: 'forget-excluded', role: 'user', content: 'Synthetic excluded scene evidence.', agentPreset: 'private-agent' })
    const expiredSource = store.recordL0({ sessionId: 'forget-expired', role: 'user', content: 'Synthetic non-excluded scene evidence.' })
    const excluded = store.addMemory({ content: 'Synthetic excluded old-scene memory.', status: 'approved', scene: 'excluded-old-scene',
      sourceMessageIds: [excludedSource], sourceVerified: true }).record
    const excludedStable = store.addMemory({ content: 'Synthetic stable excluded-scene neighbor.', status: 'approved', scene: 'excluded-old-scene' }).record
    const expired = store.addMemory({ content: 'Synthetic naturally expired old-scene memory.', status: 'approved', scene: 'expired-old-scene',
      validFrom: now - 1_000, validTo: expiry, sourceMessageIds: [expiredSource], sourceVerified: true }).record
    const expiredStable = store.addMemory({ content: 'Synthetic stable expired-scene neighbor.', status: 'approved', scene: 'expired-old-scene' }).record
    store.refreshScenes(now)
    store.close()

    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg() }).ctx, cfg(), root)
    const excludedRevision = runtime.proposeRevision(project.key, { memoryId: excluded.id, expectedRevision: excluded.revision,
      content: 'Synthetic future revision for excluded memory.', sourceMessageIds: [excludedSource], reason: 'Move scene in future.',
      scene: 'excluded-new-scene', validFrom: futureStart })
    runtime.reviewRevision(project.key, excludedRevision.id, true)
    const expiredRevision = runtime.proposeRevision(project.key, { memoryId: expired.id, expectedRevision: expired.revision,
      content: 'Synthetic future revision after expiration.', sourceMessageIds: [expiredSource], reason: 'Move scene after expiry.',
      scene: 'expired-new-scene', validFrom: futureStart })
    runtime.reviewRevision(project.key, expiredRevision.id, true)

    const scenarioStore = openProjectStore(root, project.key, project)
    try {
      assert.equal(scenarioStore.get(excluded.id)?.scene, 'excluded-new-scene', 'L1 metadata points at the future scene')
      assert.equal(scenarioStore.getApprovedForRead(excluded.id, [], now)?.scene, 'excluded-old-scene', 'the currently effective revision remains in the old scene')
      assert.equal(scenarioStore.getApprovedForRead(excluded.id, ['private-agent'], now), undefined, 'the configured display exclusion hides that memory')
      assert.equal(scenarioStore.get(expired.id)?.scene, 'expired-new-scene', 'the expired memory L1 metadata points at the future scene')
      assert.equal(scenarioStore.getApprovedForRead(expired.id, [], expiry + 1), undefined, 'no revision is effective after the old validTo and before the future start')
    } finally { scenarioStore.close() }

    runtime.config.capture.excludeAgents = ['private-agent']
    runtime.review(project.key, excluded.id, 'forget')
    let excludedOldScene = runtime.dashboard().scenes.find((scene) => scene.name === 'excluded-old-scene')
    assert.ok(excludedOldScene, 'persisted old scene is rebuilt even when excludeAgents hides the memory before forget')
    assert.deepEqual(excludedOldScene.sourceIds, [excludedStable.id])

    Date.now = () => expiry + 1
    runtime.review(project.key, expired.id, 'forget')
    const expiredOldScene = runtime.dashboard().scenes.find((scene) => scene.name === 'expired-old-scene')
    assert.ok(expiredOldScene, 'persisted old scene is rebuilt after no revision is currently effective')
    assert.deepEqual(expiredOldScene.sourceIds, [expiredStable.id])
  } finally {
    Date.now = actualNow
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a forget during persona generation aborts the write instead of writing old facts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-guard-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-guard-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const store = seededStore(root, project, [
      { content: '旧事实一 使用 Webpack。', scene: 'build' },
      { content: '旧事实二 使用 npm。', scene: 'build' },
      { content: '旧事实三 运行在 2016 年。', scene: 'build' },
    ])
    const approved = store.list('approved', 50)
    const firstFact = approved.find((r) => r.content.includes('旧事实一'))
    assert.ok(firstFact)
    store.setPersona('既有画像。', 3, approved.map((r) => r.id), Date.now(), Object.fromEntries(approved.map((r) => [r.id, r.revision])))
    store.close()

    const gate = meteredGatedStream('{"persona":"新画像内容。"}')
    const scripted = scriptedContext({ script: [gate.stream], config: cfg() })
    runtime = new MemoryRuntime(scripted.ctx, cfg(), root)
    const beforeStore = openProjectStore(root, project.key, project)
    const before = beforeStore.persona()
    beforeStore.close()
    assert.equal(before?.stale, false)

    const running = runtime.refreshPersona(project.key)
    // The persona model call is still streaming when the user forgets a fact.
    assert.equal(scripted.calls.length, 1, 'the provider response is still in flight before the source is forgotten')
    runtime.forget(cwd, firstFact.id)
    gate.release()

    await assert.rejects(running, /response discarded/u, 'the current source fence discards an outdated persona response')
    const after = openProjectStore(root, project.key, project)
    const persona = after.persona()
    assert.ok(persona)
    assert.equal(persona.content, '既有画像。', 'the old persona text is left untouched')
    assert.equal(persona.stale, true, 'the persona is now stale because one of its sources was forgotten')
    assert.equal(scripted.calls.length, 1, 'no automatic second model call')
    after.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R10 CR03B discards a late project persona response after content deletion and retains its usage receipt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r9-project-persona-delete-race-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r9-project-persona-project-'))
  const project = projectIdentity(cwd)
  const config = cfg()
  let runtime
  try {
    const store = seededStore(root, project, [
      { content: 'Synthetic project persona fact one.' },
      { content: 'Synthetic project persona fact two.' },
      { content: 'Synthetic project persona fact three.' },
    ])
    const selected = store.list('approved', 20)[0]
    store.close()
    const usage = { inputTokens: 48, outputTokens: 24, cachedInputTokens: 6, cacheReadTokens: 11, cacheWriteTokens: 13, reasoningTokens: 7, costMicros: 19 }
    const gate = meteredGatedStream('{"persona":"Synthetic late project persona body."}', { usage })
    const scripted = scriptedContext({ script: [gate.stream], config })
    runtime = new MemoryRuntime(scripted.ctx, config, root)
    const running = runtime.refreshPersona(project.key)
    let active
    for (let index = 0; index < 100 && active?.state !== 'dispatching'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      active = runtime.control.billableCallSummary().active
    }
    assert.equal(active?.state, 'dispatching', 'the persona provider request is waiting at the stream gate')
    const callId = active.id
    const preview = await runtime.manageProjectOperation(project.key, 'content.delete.preview', { memoryIds: [selected.id] })
    const deleted = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [selected.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(deleted.cleanupStatus, 'complete')
    gate.release()

    await assert.rejects(running, /response discarded/u)
    const call = runtime.control.getBillableCall(callId)
    assert.equal(call?.state, 'complete')
    assert.equal(call?.responseStatus, 'none')
    const receipt = runtime.control.billableUsageAudit(callId).observedUsageReceipt
    assert.equal(receipt?.verification, 'recorded_not_independently_verified')
    assert.equal(receipt?.callId, callId)
    assert.equal(receipt?.projectKey, project.key)
    assert.equal(receipt?.purpose, 'project_persona')
    assert.equal(receipt?.provider, call?.provider)
    assert.equal(receipt?.model, call?.model)
    assert.equal(receipt?.requestHash, call?.requestHash)
    assert.deepEqual(receipt?.usage, usage)
    assert.deepEqual(receipt?.conflicts, [])
    assert.equal(runtime.billableResults.callIds().includes(callId), false, 'the late body never reaches a sidecar')

    assert.equal(scripted.calls.length, 1, 'the race performs a single provider call')
    runtime.close()
    runtime = new MemoryRuntime(scriptedContext({ script: [], config }).ctx, config, root)
    assert.deepEqual(runtime.control.billableUsageAudit(callId).observedUsageReceipt?.usage, usage,
      'the no-body receipt survives a runtime restart')
    const retry = await runtime.manageProjectOperation(project.key, 'content.delete.apply', {
      memoryIds: [selected.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(retry.cleanupStatus, 'complete')
    assert.equal(runtime.get(cwd, selected.id), undefined)
    assert.equal(runtime.billableResults.callIds().includes(callId), false, 'retrying the completed deletion cannot resurrect the response')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R10 CR03B discards a late cross-project persona response and retains its usage receipt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r9-global-persona-delete-race-'))
  const cwdA = mkdtempSync(path.join(os.tmpdir(), 'tdai-r9-global-persona-project-a-'))
  const cwdB = mkdtempSync(path.join(os.tmpdir(), 'tdai-r9-global-persona-project-b-'))
  const projectA = projectIdentity(cwdA)
  const projectB = projectIdentity(cwdB)
  const config = cfg(true)
  let runtime
  try {
    const storeA = seededStore(root, projectA, [
      { content: 'Synthetic global persona project A fact one.' },
      { content: 'Synthetic global persona project A fact two.' },
      { content: 'Synthetic global persona project A fact three.' },
    ])
    const selected = storeA.list('approved', 20)[0]
    const storeB = seededStore(root, projectB, [
      { content: 'Synthetic global persona project B fact one.' },
      { content: 'Synthetic global persona project B fact two.' },
    ])
    storeA.close()
    storeB.close()
    const usage = { inputTokens: 48, outputTokens: 24, cachedInputTokens: 6, cacheReadTokens: 11, cacheWriteTokens: 13, reasoningTokens: 7, costMicros: 19 }
    const gate = meteredGatedStream('{"persona":"Synthetic late global persona body."}', { usage })
    const scripted = scriptedContext({ script: [gate.stream], config })
    runtime = new MemoryRuntime(scripted.ctx, config, root)
    const running = runtime.refreshGlobalPersona()
    let active
    for (let index = 0; index < 100 && active?.state !== 'dispatching'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      active = runtime.control.billableCallSummary().active
    }
    assert.equal(active?.state, 'dispatching', 'the global persona provider request is waiting at the stream gate')
    const callId = active.id
    const preview = await runtime.manageProjectOperation(projectA.key, 'content.delete.preview', { memoryIds: [selected.id] })
    const deleted = await runtime.manageProjectOperation(projectA.key, 'content.delete.apply', {
      memoryIds: [selected.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(deleted.cleanupStatus, 'complete')
    gate.release()

    await assert.rejects(running, /response discarded/u)
    const call = runtime.control.getBillableCall(callId)
    assert.equal(call?.projectKey, '*')
    assert.equal(call?.state, 'complete')
    assert.equal(call?.responseStatus, 'none')
    const receipt = runtime.control.billableUsageAudit(callId).observedUsageReceipt
    assert.equal(receipt?.verification, 'recorded_not_independently_verified')
    assert.equal(receipt?.callId, callId)
    assert.equal(receipt?.projectKey, '*')
    assert.equal(receipt?.purpose, 'global_persona')
    assert.equal(receipt?.provider, call?.provider)
    assert.equal(receipt?.model, call?.model)
    assert.equal(receipt?.requestHash, call?.requestHash)
    assert.deepEqual(receipt?.usage, usage)
    assert.deepEqual(receipt?.conflicts, [])
    assert.equal(runtime.billableResults.callIds().includes(callId), false, 'the global body never reaches a sidecar')

    assert.equal(scripted.calls.length, 1, 'the global race performs a single provider call')
    runtime.close()
    runtime = new MemoryRuntime(scriptedContext({ script: [], config }).ctx, config, root)
    assert.deepEqual(runtime.control.billableUsageAudit(callId).observedUsageReceipt?.usage, usage,
      'the global no-body receipt survives a runtime restart')
    const retry = await runtime.manageProjectOperation(projectA.key, 'content.delete.apply', {
      memoryIds: [selected.id], previewToken: preview.previewToken, confirm: true,
    })
    assert.equal(retry.cleanupStatus, 'complete')
    assert.equal(runtime.get(cwdA, selected.id), undefined)
    assert.equal(runtime.billableResults.callIds().includes(callId), false, 'completed deletion retry does not restore global response bytes')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwdA, { recursive: true, force: true })
    rmSync(cwdB, { recursive: true, force: true })
  }
})

test('R11 CR01 reconciles a matching durable observation through the normal management route after restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r11-observed-usage-match-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r11-observed-usage-project-'))
  const usage = { inputTokens: 48, outputTokens: 24, cachedInputTokens: 6, cacheReadTokens: 11, cacheWriteTokens: 13, reasoningTokens: 7, costMicros: 19 }
  let runtime
  try {
    const setup = openInterruptedObservedCall(root, cwd, usage)
    runtime = setup.runtime
    const interrupted = runtime.control.getBillableCall(setup.callId)
    assert.equal(interrupted?.state, 'uncertain', 'restart settles the unclosed local dispatch into uncertain')
    assert.equal(interrupted?.localEnded, true)
    const beforeProjection = runtime.control.db.prepare('SELECT input_tokens, output_tokens FROM billable_calls WHERE id = ?').get(setup.callId)
    assert.equal(beforeProjection.input_tokens, null)
    assert.equal(beforeProjection.output_tokens, null)
    const reconciled = await runtime.manageProjectOperation(setup.project.key, 'billable.reconcileUsage', {
      callId: setup.callId, receiptId: 'receipt-r11-match', provider: 'mock', model: 'mock-model', requestHash: setup.requestHash,
      inputTokens: 48, outputTokens: 24, evidenceRef: 'provider-receipt://synthetic-r11-match',
      reason: 'Synthetic matching receipt after an interrupted settle', authorized: true,
    })
    assert.equal(reconciled.call.state, 'complete')
    assert.equal(reconciled.call.actualTokens, 72)
    assert.equal(reconciled.reservationStillHeld, false)
    assert.deepEqual(reconciled.usageAudit.observedUsageReceipt.usage, usage, 'the original full observation remains available')
    assert.equal(reconciled.usageAudit.receipts.length, 1)
    assert.deepEqual(reconciled.usageAudit.conflicts, [])
    runtime.close()
    runtime = new MemoryRuntime(scriptedContext({ script: [], config: setup.config }).ctx, setup.config, root)
    assert.equal(runtime.control.getBillableCall(setup.callId)?.state, 'complete')
    assert.deepEqual(runtime.control.billableUsageAudit(setup.callId).observedUsageReceipt?.usage, usage,
      'the matching settlement and original observation survive another restart')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R11 CR01 fills an unknown observed token field from an authorized matching receipt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r11-observed-usage-fill-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r11-observed-usage-project-'))
  const partialUsage = { inputTokens: 48, outputTokens: null, cachedInputTokens: null, cacheReadTokens: 11,
    cacheWriteTokens: null, reasoningTokens: null, costMicros: null }
  let runtime
  try {
    const setup = openInterruptedObservedCall(root, cwd, partialUsage)
    runtime = setup.runtime
    const reconciled = await runtime.manageProjectOperation(setup.project.key, 'billable.reconcileUsage', {
      callId: setup.callId, receiptId: 'receipt-r11-fill', provider: 'mock', model: 'mock-model', requestHash: setup.requestHash,
      inputTokens: 48, outputTokens: 24, evidenceRef: 'provider-receipt://synthetic-r11-fill',
      reason: 'Synthetic receipt fills only the unknown output count', authorized: true,
    })
    assert.equal(reconciled.call.state, 'complete')
    assert.equal(reconciled.call.actualTokens, 72)
    const projection = runtime.control.db.prepare('SELECT input_tokens, output_tokens FROM billable_calls WHERE id = ?').get(setup.callId)
    assert.equal(projection.input_tokens, 48)
    assert.equal(projection.output_tokens, 24)
    assert.equal(reconciled.reservationStillHeld, false)
    assert.equal(reconciled.usageAudit.observedUsageReceipt.usage.outputTokens, null,
      'reconciliation does not rewrite the original unknown into the observed receipt')
    assert.deepEqual(reconciled.usageAudit.conflicts, [])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('R11 CR01 preserves observation conflicts, receipt evidence, and the gate through restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r11-observed-usage-conflict-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r11-observed-usage-project-'))
  const usage = { inputTokens: 48, outputTokens: 24, cachedInputTokens: 6, cacheReadTokens: 11, cacheWriteTokens: 13, reasoningTokens: 7, costMicros: 19 }
  let runtime
  try {
    const setup = openInterruptedObservedCall(root, cwd, usage)
    runtime = setup.runtime
    const reconciled = await runtime.manageProjectOperation(setup.project.key, 'billable.reconcileUsage', {
      callId: setup.callId, receiptId: 'receipt-r11-conflict', provider: 'mock', model: 'mock-model', requestHash: setup.requestHash,
      inputTokens: 49, outputTokens: 24, evidenceRef: 'provider-receipt://synthetic-r11-conflict',
      reason: 'Synthetic receipt conflicts with the durable first observation', authorized: true,
    })
    assert.equal(reconciled.call.state, 'uncertain')
    assert.equal(reconciled.call.actualTokens, null)
    const projection = runtime.control.db.prepare('SELECT input_tokens, output_tokens FROM billable_calls WHERE id = ?').get(setup.callId)
    assert.equal(projection.input_tokens, 48, 'the known first observation remains the ledger projection')
    assert.equal(projection.output_tokens, 24)
    assert.equal(reconciled.reservationStillHeld, true)
    assert.deepEqual(reconciled.usageAudit.observedUsageReceipt.usage, usage)
    assert.equal(reconciled.usageAudit.receipts[0].inputTokens, 49, 'the authorized incoming receipt remains auditable')
    assert.deepEqual(reconciled.usageAudit.conflicts.map(({ field, preservedValue, conflictingValue }) => ({ field, preservedValue, conflictingValue })), [
      { field: 'input_tokens', preservedValue: 48, conflictingValue: 49 },
    ])
    assert.equal(runtime.control.hasBillableUsageConflict(setup.callId), true)
    runtime.close()
    runtime = new MemoryRuntime(scriptedContext({ script: [], config: setup.config }).ctx, setup.config, root)
    assert.equal(runtime.control.getBillableCall(setup.callId)?.state, 'uncertain')
    assert.equal(runtime.control.billableCallSummary().active?.id, setup.callId, 'the global gate remains held after restart')
    const audit = runtime.control.billableUsageAudit(setup.callId)
    assert.deepEqual(audit.observedUsageReceipt?.usage, usage)
    assert.equal(audit.receipts[0].inputTokens, 49)
    assert.equal(audit.conflicts[0].preservedValue, 48)
    assert.equal(audit.conflicts[0].conflictingValue, 49)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('forgetting a source stales the global persona and drops it from injection', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-global-'))
  const cwdA = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-global-projectA-'))
  const cwdB = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-global-projectB-'))
  const cwdC = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-global-projectC-'))
  let runtime
  try {
    const projA = projectIdentity(cwdA)
    const projB = projectIdentity(cwdB)
    const projC = projectIdentity(cwdC)
    const storeA = seededStore(root, projA, [
      { content: 'A-记忆-1。', scene: 'a' },
      { content: 'A-记忆-2。', scene: 'a' },
      { content: 'A-记忆-3。', scene: 'a' },
    ])
    const storeB = seededStore(root, projB, [
      { content: 'B-记忆-1。', scene: 'a' },
      { content: 'B-记忆-2。', scene: 'a' },
    ])
    const storeC = seededStore(root, projC, [{ content: 'C-本地可召回记忆。', scene: 'a' }])
    const approvedA = storeA.list('approved', 50)
    const aMem = approvedA.find((r) => r.content.includes('A-记忆-2'))
    assert.ok(aMem)
    storeA.close()
    storeB.close()
    storeC.close()

    // This test is about persistence, not concurrency: a plain (non-gated)
    // stream is enough and cannot hang.
    const scripted = scriptedContext({ script: [meteredStream('{"persona":"跨项目画像。"}')], config: cfg(true) })
    runtime = new MemoryRuntime(scripted.ctx, cfg(true), root)
    const persona = await runtime.refreshGlobalPersona()
    assert.match(persona.content, /.+/)
    assert.equal(runtime.globalPersona()?.stale, false, 'a freshly built global persona is not stale until a source changes')

    const hitsStoreC = openProjectStore(root, projC.key, projC)
    const hitsC = hitsStoreC.list('approved', 50).map((r) => ({ record: r, score: 0.8 }))
    hitsStoreC.close()
    assert.match(runtime.formatRecall(cwdC, hitsC) ?? '', /persona-summary/, 'global persona injected while valid')

    runtime.forget(cwdA, aMem.id)
    assert.equal(runtime.globalPersona()?.stale, true, 'forgetting a source stales the global persona')
    assert.doesNotMatch(runtime.formatRecall(cwdC, hitsC) ?? '<none>', /persona-summary/, 'stale global persona is not injected')

    // Replace the generated file with a pre-provenance legacy global persona
    // (no `sources` field), then close and rebuild the runtime so the
    // persistence requirement is actually exercised, not just re-read.
    mkdirSync(path.join(root, 'global'), { recursive: true })
    writeFileSync(path.join(root, 'global', 'persona.json'), '{"content":"旧版无来源全局画像。","sourceCount":1,"updatedAt":1}\n', 'utf8')
    runtime.close()
    runtime = new MemoryRuntime(scriptedContext({ script: [], config: cfg(true) }).ctx, cfg(true), root)
    assert.equal(runtime.globalPersona()?.stale, true, 'a global persona without sources is stale after a restart')
    assert.doesNotMatch(runtime.formatRecall(cwdC, hitsC) ?? '<none>', /persona-summary/, 'no-provenance global persona is not injected')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    for (const c of [cwdA, cwdB, cwdC]) rmSync(c, { recursive: true, force: true })
  }
})
