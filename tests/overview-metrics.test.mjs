import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openProjectStore } from '../lib/store.js'

test('capture overview uses recorded time, excludes configured agents, and bounds groups with an exact other count', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-capture-'))
  const store = openProjectStore(root, 'overview-capture')
  const recordedAt = Date.UTC(2025, 0, 2, 12)
  const sourceAt = Date.UTC(2025, 0, 1, 12)
  try {
    for (let index = 0; index < 101; index += 1) {
      store.captureMessage({
        sessionId: `session-${index}`, role: 'user', content: `recorded capture ${index}`,
        createdAt: sourceAt + index, recordedAt: recordedAt + index, origin: `source-${index}`,
      })
    }
    store.captureMessage({
      sessionId: 'private-session', role: 'user', content: 'excluded agent capture',
      createdAt: sourceAt + 200, recordedAt: recordedAt + 200, origin: 'private-source',
      agentId: 'private-id', agentPreset: 'private-agent',
    })

    const overview = store.captureOverview(recordedAt, recordedAt + 86_400_000, ['private-*'])
    assert.equal(overview.messageCount, 101)
    assert.equal(overview.sessions, 101)
    assert.equal(overview.unknownAgentEvents, 101)
    assert.equal(overview.unknownSessionEvents, 0)
    assert.equal(overview.topSessions.length, 10)
    assert.equal(overview.topSessions[0].sessionId, 'session-0')
    assert.equal(overview.topSessions[0].linkedL0Messages, 1)
    assert.equal(overview.topSessions[0].originalMessageCount, null)
    assert.equal(overview.topSessions[0].events, 1)
    assert.equal(overview.sources.length, 100)
    assert.equal(overview.sources.filter((item) => item.other).length, 1)
    assert.equal(overview.sources.find((item) => item.other)?.count, 2)

    const sourceTimeOverview = store.captureOverview(sourceAt, sourceAt + 86_400_000, ['private-*'])
    assert.equal(sourceTimeOverview.messageCount, 0, 'original message time is not used as capture recording time')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('top sessions rank by linked local L0 rows, keep original Host message counts unknown, and report events separately', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-top-sessions-'))
  const store = openProjectStore(root, 'overview-top-sessions')
  const from = Date.UTC(2025, 5, 1)
  try {
    const first = store.captureMessage({ sessionId: 'event-heavy', role: 'user', content: 'one original message', createdAt: from + 1, recordedAt: from + 1 })
    store.appendEvent({ eventId: 'event-heavy-duplicate-1', type: 'capture', sessionId: 'event-heavy', sourceId: first.id, occurredAt: from + 2 }, from + 2)
    store.appendEvent({ eventId: 'event-heavy-duplicate-2', type: 'capture', sessionId: 'event-heavy', sourceId: first.id, occurredAt: from + 3 }, from + 3)
    store.captureMessage({ sessionId: 'message-heavy', role: 'user', content: 'first distinct message', createdAt: from + 4, recordedAt: from + 4 })
    store.captureMessage({ sessionId: 'message-heavy', role: 'user', content: 'second distinct message', createdAt: from + 5, recordedAt: from + 5 })
    store.appendEvent({ eventId: 'capture-without-l0-link', type: 'capture', sessionId: 'unlinked-session', occurredAt: from + 6 }, from + 6)

    const overview = store.captureOverview(from, from + 86_400_000)
    assert.equal(overview.topSessions[0].sessionId, 'message-heavy')
    assert.equal(overview.topSessions[0].linkedL0Messages, 2)
    assert.equal(overview.topSessions[0].originalMessageCount, null)
    assert.equal(overview.topSessions[0].events, 2)
    assert.equal(overview.topSessions[1].sessionId, 'event-heavy')
    assert.equal(overview.topSessions[1].linkedL0Messages, 1)
    assert.equal(overview.topSessions[1].originalMessageCount, null)
    assert.equal(overview.topSessions[1].events, 3)
    const unlinked = overview.topSessions.find((item) => item.sessionId === 'unlinked-session')
    assert.equal(unlinked.linkedL0Messages, 0, 'zero means zero linked local L0 rows, not zero original Host messages')
    assert.equal(unlinked.originalMessageCount, null, 'missing L0 association keeps the original-message count unknown')
    assert.equal(unlinked.events, 1)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('visible status counts subtract hidden ids in SQL while retaining the same eligibility filters', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-visible-count-'))
  const store = openProjectStore(root, 'overview-visible-count')
  try {
    const visible = store.addMemory({ content: 'Visible candidate for count.', status: 'candidate' }).record
    const hidden = store.addMemory({ content: 'Hidden candidate for count.', status: 'candidate' }).record
    assert.equal(store.visibleStatusCount('candidate'), 2)
    assert.equal(store.visibleStatusCount('candidate', [], new Set([hidden.id])), 1)
    assert.equal(store.visibleStatusCount('candidate', [], new Set([visible.id, hidden.id])), 0)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('most-linked session reports local L0 rows and separate event totals', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-session-count-'))
  const store = openProjectStore(root, 'overview-session-count')
  const from = Date.UTC(2025, 3, 1)
  try {
    const first = store.captureMessage({ sessionId: 'session-a', role: 'user', content: 'first original message', createdAt: from + 10, recordedAt: from + 10, origin: 'user' })
    store.appendEvent({ eventId: 'duplicate-derived-capture-event', type: 'capture', sessionId: 'session-a', sourceId: first.id, occurredAt: from + 11 }, from + 11)
    store.captureMessage({ sessionId: 'session-a', role: 'assistant', content: 'second original message', createdAt: from + 20, recordedAt: from + 20, origin: 'assistant' })
    const overview = store.captureOverview(from, from + 86_400_000)
    assert.equal(overview.longestSession, null, 'the legacy raw-message summary stays unknown without proven Host message identity')
    assert.equal(overview.mostLinkedL0Session.sessionId, 'session-a')
    assert.equal(overview.mostLinkedL0Session.linkedL0Messages, 2)
    assert.equal(overview.mostLinkedL0Session.originalMessageCount, null)
    assert.equal(overview.mostLinkedL0Session.events, 3)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('daily activity counts successful recall results and accepted revisions while keeping request totals', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-events-'))
  const store = openProjectStore(root, 'overview-events')
  const jan1 = Date.UTC(2025, 0, 1)
  const jan2 = Date.UTC(2025, 0, 2)
  try {
    store.captureMessage({ sessionId: 's1', role: 'user', content: 'captured on day two', createdAt: jan1 + 100, recordedAt: jan2 + 100 })
    store.appendEvent({ eventId: 'recall-none', type: 'recall_no_result', occurredAt: jan2 + 200 }, jan1 + 200)
    store.appendEvent({ eventId: 'recall-hit', type: 'recall_returned', occurredAt: jan2 + 300 }, jan1 + 300)
    store.appendEvent({ eventId: 'revision-ok', type: 'revision', occurredAt: jan2 + 400 }, jan1 + 400)
    store.appendEvent({ eventId: 'initial-approval', type: 'initial_approval', occurredAt: jan2 + 450 }, jan1 + 450)
    store.appendEvent({ eventId: 'candidate-rejected', type: 'candidate_rejected', occurredAt: jan2 + 500 }, jan1 + 500)

    const daily = store.eventDayMetrics([
      { date: '2025-01-01', from: jan1, to: jan2 },
      { date: '2025-01-02', from: jan2, to: jan2 + 86_400_000 },
    ])
    assert.deepEqual(daily, [
      { date: '2025-01-01', captures: 0, recalls: 0, recallRequests: 0, revisions: 0, initialApprovals: 0, preparedInjections: 0, preparedInjectionEvents: 0 },
      { date: '2025-01-02', captures: 1, recalls: 1, recallRequests: 2, revisions: 1, initialApprovals: 1, preparedInjections: 0, preparedInjectionEvents: 0 },
    ])
    assert.deepEqual(store.eventOverviewMetrics(jan2, jan2 + 86_400_000), {
      recallRequests: 2, recallResults: 1, preparedInjectionEvents: 0, preparedInjectionMemories: 0, preparedInjectionTokens: 0,
    })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepared injection metrics keep event, selected-memory, and estimated-token units separate', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-injection-units-'))
  const store = openProjectStore(root, 'overview-injection-units')
  const from = Date.UTC(2025, 4, 1)
  try {
    store.appendEvent({ eventId: 'prepared-one', type: 'inject_prepared', count: 3, tokens: 42, rawTokens: 60,
      occurredAt: from + 10, metadata: { memoryIds: ['m1', 'm2', 'm3'], estimate: true } }, from + 10)
    const [day] = store.eventDayMetrics([{ date: '2025-05-01', from, to: from + 86_400_000 }])
    assert.equal(day.preparedInjectionEvents, 1)
    assert.equal(day.preparedInjections, 3, 'legacy preparedInjections remains selected-memory count')
    assert.deepEqual(store.eventOverviewMetrics(from, from + 86_400_000), {
      recallRequests: 0, recallResults: 0, preparedInjectionEvents: 1, preparedInjectionMemories: 3, preparedInjectionTokens: 42,
    })
    const dimensions = store.eventDimensions(from, from + 86_400_000, 'inject_prepared')
    assert.equal(dimensions.sources.reduce((sum, group) => sum + group.count, 0), 1)
    const details = store.eventDetails({ from, to: from + 86_400_000, type: 'inject_prepared' })
    assert.equal(details.events[0].count, 3)
    assert.equal(details.events[0].tokens, 42)
    assert.equal(details.events[0].rawTokens, 60)
    assert.equal(details.events[0].tokenEstimate, true)
    assert.deepEqual(details.events[0].selectedMemoryIds, ['m1', 'm2', 'm3'])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('first approval is counted separately and never increments accepted revisions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-overview-initial-approval-'))
  const store = openProjectStore(root, 'overview-initial-approval')
  const now = Date.now()
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000
  try {
    store.addMemory({ content: 'Approved at creation.', status: 'approved' })
    assert.equal(store.addMemory({ content: 'Approved at creation.', status: 'approved' }).created, false)
    const candidate = store.addMemory({ content: 'Approved after review.', status: 'candidate' }).record
    store.approve(candidate.id)
    const sourceId = store.recordL0({ sessionId: 'revision-session', role: 'user', content: 'Synthetic evidence for the existing logical memory.',
      createdAt: dayStart - 2000, recordedAt: dayStart - 2000 })
    const originalDateNow = Date.now
    let existing
    try {
      Date.now = () => dayStart - 1000
      existing = store.addMemory({ content: 'Existing logical memory before its later correction.', status: 'approved',
        sourceMessageIds: [sourceId], sourceVerified: true }).record
    } finally {
      Date.now = originalDateNow
    }
    const revision = store.proposeRevision({ memoryId: existing.id, expectedRevision: existing.revision,
      content: 'Existing logical memory after its later correction.', sourceMessageIds: [sourceId], reason: 'Synthetic accepted revision.' })
    store.approveRevision(revision.id)
    const privateSourceId = store.recordL0({ sessionId: 'private-session', role: 'user', content: 'Excluded source for a private memory.', agentPreset: 'private-agent' })
    const privateMemory = store.addMemory({ content: 'Private approved memory.', status: 'approved', sourceMessageIds: [privateSourceId], sourceVerified: true }).record
    const privateRevision = store.proposeRevision({ memoryId: privateMemory.id, expectedRevision: privateMemory.revision,
      content: 'Private approved memory with a later correction.', sourceMessageIds: [privateSourceId], reason: 'Synthetic excluded correction.' })
    store.approveRevision(privateRevision.id)
    const daily = store.eventDayMetrics([{ date: new Date(dayStart).toISOString().slice(0, 10), from: dayStart, to: dayStart + 86_400_000 }], ['private-*'])
    assert.equal(daily[0].initialApprovals, 2)
    assert.equal(daily[0].revisions, 1)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
