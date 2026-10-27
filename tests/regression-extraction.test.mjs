import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { openProjectStore } from '../lib/store.js'
import { endTurnAfterQuietWindow, meteredGatedStream, meteredStream, scriptedContext, sourceAwareGatedStream, sourceAwareStream, userEvent, assistantEvent, withAdvancedClock } from './helpers.mjs'

function baseConfig() {
  return resolveConfig({
    mode: 'balanced',
    autoApproveConfidence: 0.5,
    extraction: { enabled: true, everyNConversations: 1, minTurnChars: 0, provider: 'mock', model: 'mock' },
    budget: { automaticDailyTokens: 1_000_000, automaticDailyTasks: 100 },
    recall: { enabled: true, minScore: 0 },
  })
}

function oneMemory(content, kind = 'fact') {
  return sourceAwareStream((sourceIds) => ({ memories: [{ content, kind, confidence: 0.9, source_message_ids: sourceIds }] }))
}

test('a paid malformed extraction response remains failed and a later source progresses independently', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-parse-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-parse-project-'))
  let first
  let firstScripted
  let second
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    // First runtime: the model answers with garbage and truncated JSON.
    firstScripted = scriptedContext({ script: [meteredStream('not json')], config: baseConfig(), session })
    first = new MemoryRuntime(firstScripted.ctx, baseConfig(), root)
    // A user turn plus its assistant turn are BOTH captured at L0.
    first.onSessionEvent(session, userEvent(1, '以后前端都用 pnpm。'))
    first.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(first, session, 3)
    await first.runExtraction('s1')
    await first.runExtraction('s1')
    assert.match(first.lastError ?? '', /model response rejected/, 'a malformed response must be visible as an error')
    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    const originalSourceIds = store.unextracted('s1').map((row) => row.id)
    const failedJob = store.extractionJobs(10).find((job) => job.attemptId !== undefined)
    assert.equal(failedJob?.status, 'failed', 'the charged bad-JSON job retains its terminal failure')
    assert.equal(firstScripted.calls.length, 1, 'calling the scheduler again does not redispatch the paid malformed response')
    assert.equal(store.unextracted('s1').length, 2, 'failed parsing must never consume the captured L0 rows')
    assert.equal(store.list('approved', 20).length, 0)
    store.close()
    first.close()
    first = undefined

    // A fresh source after restart gets its own job. The earlier paid input
    // remains pending with its failed job and is never sent again.
    const scripted = scriptedContext({
      script: [oneMemory('用户偏好使用 Deno 编写示例。', 'preference')],
      config: baseConfig(),
      session,
    })
    second = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    second.onSessionEvent(session, userEvent(3, '今后示例代码使用 Deno。'))
    second.onSessionEvent(session, assistantEvent(4, '我会在示例中使用 Deno。'))
    endTurnAfterQuietWindow(second, session, 5)
    await second.runExtraction('s1')
    const store2 = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.deepEqual(store2.unextracted('s1').map((row) => row.id), originalSourceIds, 'the original source rows remain pending after the independent pass')
    assert.equal(store2.getExtractionJob(failedJob.id).status, 'failed', 'the original failure is preserved across restart')
    assert.equal(store2.list('approved', 20).length, 1, 'the new source produced a memory independently')
    store2.close()
    assert.equal(scripted.calls.length, 1, 'only the fresh source has one new provider request')
    assert.equal(second.recall(cwd, 'Deno').length, 1)
  } finally {
    first?.close()
    second?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('an in-flight usage receipt audits A without releasing the slot for queued B', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-inflight-usage-receipt-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-inflight-usage-project-'))
  const project = projectIdentity(cwd)
  const session = { id: 's-inflight-receipt', header: { cwd, agentPreset: 'agent-mock' } }
  const gateA = sourceAwareGatedStream((sourceIds) => ({ memories: [{ content: 'A 的合成记忆。', kind: 'fact', confidence: 0.9, source_message_ids: sourceIds }] }))
  const gateB = sourceAwareGatedStream(() => ({ memories: [] }))
  const scripted = scriptedContext({ script: [gateA.stream, gateB.stream], config: baseConfig(), session })
  let runtime
  let restarted
  try {
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    runtime.onSessionEvent(session, userEvent(1, '这是 A 的消息。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    const extractionA = runtime.runExtraction(session.id)
    assert.equal(scripted.calls.length, 1, 'A is the only provider request so far')
    const callA = runtime.control.listBillableCalls(project.key, 10)[0]
    assert.ok(callA?.attemptId && callA.jobId && callA.requestHash)

    runtime.onSessionEvent(session, userEvent(4, '这是 B 的新消息。'))
    runtime.onSessionEvent(session, assistantEvent(5))
    endTurnAfterQuietWindow(runtime, session, 6)
    const receipt = { callId: callA.id, receiptId: 'inflight-receipt-a', provider: callA.provider, model: callA.model,
      requestHash: callA.requestHash, jobId: callA.jobId, attemptId: callA.attemptId, inputTokens: 48, outputTokens: 24,
      evidenceRef: 'synthetic-provider://receipt-a', reason: 'Synthetic in-flight receipt audit fixture' }
    const recorded = await runtime.manageProjectOperation(project.key, 'billable.reconcileUsage', receipt)
    assert.equal(recorded.call.state, 'dispatching')
    assert.equal(recorded.call.localEnded, false)
    assert.equal(recorded.verification, 'recorded_not_independently_verified')
    assert.equal(recorded.reservationStillHeld, true)
    assert.equal(runtime.control.getAttempt(callA.attemptId).state, 'dispatching')
    assert.equal(runtime.control.billableCallSummary().active?.id, callA.id)
    assert.equal(scripted.calls.length, 1, 'queued B cannot dispatch while A is still streaming')

    gateA.release()
    await extractionA
    const settledA = runtime.control.getBillableCall(callA.id)
    assert.equal(settledA.localEnded, true)
    assert.equal(settledA.state, 'complete')
    const duplicate = await runtime.manageProjectOperation(project.key, 'billable.reconcileUsage', { ...receipt, authorized: true })
    assert.equal(duplicate.call.state, 'complete', 'the same receipt may be reconciled after local stream end')
    assert.equal(duplicate.usageAudit.receipts.length, 1, 'duplicate receipt remains idempotent')

    for (let attempt = 0; attempt < 40 && scripted.calls.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(scripted.calls.length, 2, 'B may dispatch after A reaches its local end')
    const callB = runtime.control.listBillableCalls(project.key, 10).find((call) => call.id !== callA.id)
    assert.ok(callB)
    gateB.release()
    for (let attempt = 0; attempt < 40 && runtime.control.getBillableCall(callB.id).state !== 'complete'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(runtime.control.getBillableCall(callB.id).state, 'complete')

    const conflict = await runtime.manageProjectOperation(project.key, 'billable.reconcileUsage', {
      ...receipt, receiptId: 'inflight-receipt-a-conflict', inputTokens: 49, evidenceRef: 'synthetic-provider://receipt-a-conflict', authorized: true,
    })
    assert.equal(conflict.call.state, 'uncertain')
    assert.equal(conflict.call.localEnded, true)
    assert.equal(conflict.usageAudit.conflicts.length, 1)
    runtime.close()
    runtime = undefined
    restarted = new MemoryRuntime({ logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } }, baseConfig(), root)
    assert.equal(restarted.control.getBillableCall(callA.id).state, 'uncertain', 'receipt conflicts persist through restart')
    assert.equal(restarted.control.hasBillableUsageConflict(callA.id), true)
  } finally {
    runtime?.close()
    restarted?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a legal empty response completes extraction once and consumes the batch', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-empty-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-empty-project-'))
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const scripted = scriptedContext({ script: [meteredStream('{"memories":[]}')], config: baseConfig(), session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    runtime.onSessionEvent(session, userEvent(1, '这段对话没有值得记忆的内容。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    await runtime.runExtraction('s1')
    assert.equal(scripted.calls.length, 1)
    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s1').length, 0, 'legal empty marks the batch consumed')
    assert.equal(store.stats().approved, 0)
    store.close()
    // status() lists every live session buffer, so assert per-session entries.
    assert.deepEqual(runtime.status().pending.map((row) => row.entries), [0], 'no rows remain pending after a legal empty batch')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('entries captured while a deferred stream runs are never wiped or consumed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-deferred-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-deferred-project-'))
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const gate = sourceAwareGatedStream((sourceIds) => ({ memories: [{ content: '第一条记忆内容。', kind: 'fact', confidence: 0.9, source_message_ids: sourceIds }] }))
    const scripted = scriptedContext({ script: [gate.stream, oneMemory('第二条记忆内容。')], config: baseConfig(), session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    runtime.onSessionEvent(session, userEvent(1, '记住这条：第一条记忆内容。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)

    const extraction = runtime.runExtraction('s1')
    // While the model call is still streaming, a new user turn plus its
    // assistant reply arrive — both become L0 rows.
    runtime.onSessionEvent(session, userEvent(3, '记住这条：第二条记忆内容。'))
    runtime.onSessionEvent(session, assistantEvent(4))
    runtime.onSessionEvent(session, { type: 'turn/end', seq: 5, data: { turn: 5 } })
    gate.release()
    await extraction

    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    const pending = store.unextracted('s1')
    assert.equal(pending.length, 2, 'both lines captured during the model call stay pending')
    assert.equal(pending[0].content, '记住这条：第二条记忆内容。', 'the in-flight user line is the oldest pending row')
    assert.equal(store.list('approved', 20).length, 1, 'only the snapshot batch produced a memory')
    store.close()
    assert.deepEqual(runtime.status().pending.map((row) => row.entries), [2], 'both in-flight entries remain tracked')

    // The next pass extracts the deferred rows without replaying the first batch.
    await withAdvancedClock(1300, () => runtime.runExtraction('s1'))
    const after = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(after.unextracted('s1').length, 0)
    assert.equal(after.list('approved', 20).length, 2)
    after.close()
    assert.equal(scripted.calls.length, 2)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a backlog beyond 24 advances batch by batch, oldest first, without replays', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-backlog-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-backlog-project-'))
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const scripts = []
    for (let batch = 0; batch < 2; batch += 1) {
      scripts.push(oneMemory(`批次 ${batch} 的记忆内容。`))
    }
    const scripted = scriptedContext({ script: scripts, config: baseConfig(), session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    for (let index = 1; index <= 30; index += 1) {
      runtime.onSessionEvent(session, userEvent(index, `待抽取的对话内容序号 ${index}`))
    }
    endTurnAfterQuietWindow(runtime, session, 31)
    await runtime.runExtraction('s1')
    let store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s1').length, 6, 'the first batch consumes exactly the oldest 24 rows')
    store.close()
    assert.deepEqual(runtime.status().pending.map((row) => row.entries), [6])

    await withAdvancedClock(1300, () => runtime.runExtraction('s1'))
    store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s1').length, 0, 'the second batch consumes the remaining 6 rows')
    store.close()
    assert.equal(scripted.calls.length, 2, 'exactly two model calls for 30 rows')
    assert.deepEqual(runtime.status().pending.map((row) => row.entries), [0])
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('in-flight captures never jump ahead of older durable backlog rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-dborder-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-dborder-project-'))
  let runtime
  try {
    const project = projectIdentity(cwd)
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    // Pre-seed 25 durable L0 rows (a backlog > MAX_BATCH) without any capture turn.
    const seed = openProjectStore(root, project.key, project)
    for (let index = 1; index <= 25; index += 1) {
      seed.recordL0({ sessionId: 's1', role: 'user', content: `旧积压第 ${index} 条。`, turn: index, step: 1,
        agentPreset: 'agent-mock', provider: 'mock', model: 'mock' })
    }
    seed.close()

    const gate = meteredGatedStream('{"memories":[]}')
    const scripted = scriptedContext({ script: [gate.stream, meteredStream('{"memories":[]}')], config: baseConfig(), session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    // Establish the session buffer WITHOUT adding any L0 row: a header-like
    // event is routed through bufferFor (which only registers the buffer) and
    // then returns on the default branch, so the seed backlog stays exactly 25.
    runtime.onSessionEvent(session, { type: 'session/header', seq: 0, data: { header: { cwd } } })
    endTurnAfterQuietWindow(runtime, session, 1)
    const extraction = runtime.runExtraction('s1')
    assert.equal(scripted.calls.length, 1, 'the first batch must be in flight on the gate before any new capture')
    // A new message arrives while the model streams — it is a NEW L0 row.
    runtime.onSessionEvent(session, userEvent(99, '抽取期间到达的新消息。'))
    endTurnAfterQuietWindow(runtime, session, 100)
    gate.release()
    await extraction

    const store1 = openProjectStore(root, project.key, project)
    assert.equal(store1.unextracted('s1').length, 2, 'oldest 24 consumed; oldest durable + in-flight row remain')
    store1.close()

    await withAdvancedClock(1300, () => runtime.runExtraction('s1'))
    const textOf = (call) => call.messages?.[call.messages.length - 1]?.content?.[0]?.text ?? ''
    const secondCall = textOf(scripted.calls[1])
    assert.match(secondCall, /旧积压第 25 条/, 'second batch starts at the oldest remaining durable row')
    assert.match(secondCall, /抽取期间到达的新消息/, 'the in-flight row is included once the batch reaches it')
    assert.ok(
      secondCall.indexOf('旧积压第 25 条') < secondCall.indexOf('抽取期间到达的新消息'),
      'durable oldest-first order wins; in-flight captures never jump ahead of older backlog',
    )
    const store2 = openProjectStore(root, project.key, project)
    assert.equal(store2.unextracted('s1').length, 0)
    store2.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('disposing a session while extraction streams never writes back', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-dispose-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-dispose-project-'))
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const gate = sourceAwareGatedStream((sourceIds) => ({ memories: [{ content: '这条不应被写回。', kind: 'fact', confidence: 0.9, source_message_ids: sourceIds }] }))
    const scripted = scriptedContext({ script: [gate.stream], config: baseConfig(), session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    runtime.onSessionEvent(session, userEvent(1, '一句话内容用于抽取。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    const extraction = runtime.runExtraction('s1')
    // The session is released while the model call is still streaming; the
    // in-flight callback must not consume rows or create memories afterwards.
    runtime.onSessionEvent(session, { type: 'session/disposed', seq: 9, data: {} })
    gate.release()
    await extraction

    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s1').length, 2, 'disposed mid-stream leaves the L0 rows durable and pending')
    assert.equal(store.list('approved', 20).length, 0, 'no memory is written after disposal')
    store.close()
    assert.deepEqual(runtime.status().pending, [], 'the disposed session buffer is gone')
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('closing while extraction streams never writes to a closed database', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-closed-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r1-closed-project-'))
  let runtime
  try {
    const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
    const gate = sourceAwareGatedStream((sourceIds) => ({ memories: [{ content: '这条不应被写回。', kind: 'fact', confidence: 0.9, source_message_ids: sourceIds }] }))
    const scripted = scriptedContext({ script: [gate.stream], config: baseConfig(), session })
    runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
    runtime.onSessionEvent(session, userEvent(1, '一句话内容用于抽取。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    const extraction = runtime.runExtraction('s1')
    runtime.close()
    gate.release()
    await extraction

    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s1').length, 2, 'closing mid-stream leaves the captured L0 rows durable and pending')
    assert.equal(store.list('approved', 20).length, 0)
    store.close()
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

async function assertLateResponseBlocked(changeLiveState) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-gate-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-gate-project-'))
  const otherCwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-r41-gate-other-'))
  const session = { id: 's1', header: { cwd, agentPreset: 'agent-mock' } }
  const gate = sourceAwareGatedStream((sourceIds) => ({
    memories: [{ content: '迟到响应不得接受。', kind: 'fact', confidence: 0.9, source_message_ids: sourceIds }],
  }))
  const scripted = scriptedContext({ script: [gate.stream], config: baseConfig(), session })
  const runtime = new MemoryRuntime(scripted.ctx, baseConfig(), root)
  try {
    runtime.onSessionEvent(session, userEvent(1, '待验证的抽取来源。'))
    runtime.onSessionEvent(session, assistantEvent(2))
    endTurnAfterQuietWindow(runtime, session, 3)
    const extraction = runtime.runExtraction('s1')
    assert.equal(scripted.calls.length, 1, 'the synthetic provider call reached the gated response')
    changeLiveState({ runtime, scripted, session, otherCwd })
    gate.release()
    await extraction

    const store = openProjectStore(root, projectIdentity(cwd).key, projectIdentity(cwd))
    assert.equal(store.unextracted('s1').length, 2, 'a blocked response leaves every frozen L0 source pending')
    assert.equal(store.list('approved', 20).length, 0, 'a blocked response creates no L1 memory')
    assert.equal(store.list('candidate', 20).length, 0, 'a blocked response creates no candidate')
    const job = store.extractionJobs(20)[0]
    assert.equal(job.status, 'result_ready', 'the provider result stays durable for explicit recovery')
    store.close()
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    rmSync(otherCwd, { recursive: true, force: true })
  }
}

test('late extraction response is not accepted when the live Host session disappears', async () => {
  await assertLateResponseBlocked(({ scripted }) => scripted.setSession(undefined))
})

test('late extraction response is not accepted after the live project scope changes', async () => {
  await assertLateResponseBlocked(({ scripted, session, otherCwd }) => {
    scripted.setSession({ ...session, header: { cwd: otherCwd, agentPreset: 'agent-mock' } })
  })
})

test('late extraction response is not accepted after the live Host agent changes', async () => {
  await assertLateResponseBlocked(({ scripted, session }) => {
    scripted.setSession({ ...session, header: { ...session.header, agentPreset: 'different-agent' } })
  })
})

test('late extraction response is not accepted after policy changes', async () => {
  await assertLateResponseBlocked(({ runtime }) => {
    runtime.config.extraction.maxMemoriesPerPass += 1
  })
})

test('late extraction response is not accepted into a replacement session buffer', async () => {
  await assertLateResponseBlocked(({ runtime, session }) => {
    runtime.onSessionEvent(session, { type: 'session/disposed', seq: 3, data: {} })
    runtime.onSessionEvent(session, { type: 'session/header', seq: 4, data: {} })
  })
})
