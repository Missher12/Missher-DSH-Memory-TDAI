/**
 * S3 dashboard RPC integration test.
 *
 * This file deliberately goes through the real plugin boundary: a Cordis
 * context loads `lib/index.js`, the plugin registers the `memoryTdai`
 * service, and local calls use the exported Typert descriptors' real Zod
 * codecs. Those calls are not Loader/Gateway proof; the appended Host-contract
 * cases load actual Host modules through normal resolution or
 * DSH_TDAI_TEST_HOST_ROOT. Inputs are synthetic SQLite databases and temporary
 * package compositions under `os.tmpdir()`. No personal data, daily profile,
 * provider, or network endpoint is touched.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { resolveConfig } from '../lib/config.js'
import { ControlLedger } from '../lib/control.js'
import * as plugin from '../lib/index.js'
import { MemoryRuntime } from '../lib/memory.js'
import { projectIdentity } from '../lib/project.js'
import { MemoryTdaiRemote } from '../lib/remote.js'
import { ReadDashboardRequestSchema, invocationDescriptors } from '../lib/remote-contract.js'
import { openProjectStore, openProjectStoreReadOnly } from '../lib/store.js'
import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const READ_DASHBOARD = '@missher/dsh-memory-tdai#memoryTdai/readDashboard'
const REVIEW = '@missher/dsh-memory-tdai#memoryTdai/review'
const REVIEW_ACK = '@missher/dsh-memory-tdai#memoryTdai/reviewAck'
const UPDATE_SETTINGS = '@missher/dsh-memory-tdai#memoryTdai/updateSettings'
const UPDATE_SETTINGS_ACK = '@missher/dsh-memory-tdai#memoryTdai/updateSettingsAck'
const DAY_MS = 86_400_000
const MANAGE = '@missher/dsh-memory-tdai#memoryTdai/manage'

function descriptorOf(id) {
  const descriptor = invocationDescriptors.find((entry) => entry.id === id)
  assert.ok(descriptor, `missing Typert descriptor ${id}`)
  return descriptor
}

function assertRemoteMarker(service, descriptorId) {
  const descriptor = descriptorOf(descriptorId)
  const markers = remoteMethods(service)
  assert.ok(Array.isArray(markers), 'remoteMethods must return the decorated method metadata')
  const matched = markers.filter((marker) => (marker.exportName ?? marker.method) === descriptor.method)
  assert.equal(matched.length, 1, `expected exactly one @Remote marker for ${descriptor.method}`)
  const marker = matched[0]
  assert.equal(marker.method, descriptor.method)
  assert.equal(marker.mode, undefined, `${descriptor.method} must be a non-stream Remote method`)
  assert.deepEqual(marker.invocation, { kind: 'direct' })
  assert.equal(service.typertRemote.serviceKey, descriptor.service)
  assert.equal(service.typertRemote.namespace, descriptor.namespace)
  return marker
}

async function callRpc(service, descriptorId, wireArgs) {
  const descriptor = descriptorOf(descriptorId)
  assert.equal(typeof service[descriptor.method], 'function', `service method ${descriptor.method} is missing`)
  const args = descriptor.parameters.map((parameter) => {
    const value = wireArgs?.[parameter.wire]
    return parameter.codec.create().parse(value)
  })
  const result = await service[descriptor.method](...args)
  return descriptor.result.create().parse(result)
}

function utcDate(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftUtcDate(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function rangeFor(captureDate) {
  return {
    from: shiftUtcDate(captureDate, -1),
    to: shiftUtcDate(captureDate, 1),
    timeZone: 'UTC',
    activity: 'capture',
  }
}

function seedDashboardFixture(store, { verifiedCandidateA = false } = {}) {
  const now = Date.now()
  const captureDate = utcDate(now)
  const sourceA = store.recordL0({
    sessionId: 'session-a', role: 'user', content: 'Synthetic source for approved memory A.', createdAt: now,
  })
  const sourceB = store.recordL0({
    sessionId: 'session-a', role: 'assistant', content: 'Synthetic source for approved memory B.', createdAt: now,
  })
  const approvedA = store.addMemory({
    content: 'Synthetic approved memory A.', kind: 'preference', scene: 'synthetic',
    confidence: 0.91, status: 'approved', sourceMessageIds: [sourceA], sourceVerified: true,
  }).record
  const approvedB = store.addMemory({
    content: 'Synthetic approved memory B.', kind: 'fact',
    confidence: 0.88, status: 'approved', sourceMessageIds: [sourceB], sourceVerified: true,
  }).record
  const candidateSourceA = verifiedCandidateA ? store.recordL0({
    sessionId: 'session-review-candidate-a', role: 'user', content: 'Synthetic source for review candidate A.', createdAt: now,
  }) : undefined
  const candidateA = store.addMemory({
    content: 'Synthetic candidate memory A.', kind: 'fact', confidence: 0.5, status: 'candidate',
    ...(candidateSourceA === undefined ? {} : { sourceMessageIds: [candidateSourceA], sourceVerified: true }),
  }).record
  const candidateB = store.addMemory({
    content: 'Synthetic candidate memory B.', kind: 'preference', confidence: 0.4, status: 'candidate',
  }).record
  const forgottenSource = store.addMemory({
    content: 'Synthetic forgotten memory.', kind: 'fact', confidence: 0.7, status: 'approved',
  }).record
  const forgotten = store.forget(forgottenSource.id)
  assert.equal(forgotten.status, 'forgotten')
  store.recordEvent('recall_returned', 1, 3, 3, now)
  store.recordEvent('recall_no_result', 1, 0, 0, now)
  return {
    captureDate, sourceA, sourceB, approvedA, approvedB, candidateA, candidateB, forgotten,
  }
}

function seedBulk(store, captures, memories) {
  const now = Date.now()
  const captureDate = utcDate(now)
  for (let index = 0; index < captures; index += 1) {
    store.recordL0({
      sessionId: 'session-bulk', role: 'user', content: `Synthetic capture row ${index}.`, createdAt: now,
    })
  }
  for (let index = 0; index < memories; index += 1) {
    store.addMemory({
      content: `Synthetic approved bulk memory ${index}.`, kind: 'fact', confidence: 0.8, status: 'approved',
    })
  }
  return { captureDate }
}

function seedOversizedPersona(store) {
  const data = seedDashboardFixture(store)
  store.setPersona('x'.repeat(65_536), 1, [data.approvedA.id], Date.now(), { [data.approvedA.id]: data.approvedA.revision })
  return data
}

function seedThirtyCapturesSevenMemories(store) {
  return seedBulk(store, 30, 7)
}
function seedComplexPersona3(store) {
  const data = seedDashboardFixture(store)
  const evidence = store.recordL0({ sessionId: 'complex-persona-evidence', role: 'user',
    content: 'Synthetic evidence for persona dependency proofs.' })
  const roots = []
  for (let index = 0; index < 3; index += 1) {
    const dependencies = [0, 1].map((dep) => store.addMemory({ content: `Dependency ${index}-${dep}.`,
      kind: 'fact', confidence: 0.8, status: 'approved' }).record)
    const root = store.addMemory({ content: `Complex persona root ${index}.`, kind: 'fact', confidence: 0.8, status: 'approved' }).record
    for (const dependency of dependencies) {
      const candidate = store.proposeRelation({ fromId: root.id, toId: dependency.id, type: 'depends_on', evidenceIds: [evidence] })
      store.reviewRelationCandidate(candidate.id, true)
    }
    roots.push(root)
  }
  store.setPersona('Synthetic complex three-source persona.', roots.length, roots.map((record) => record.id),
    Date.now(), Object.fromEntries(roots.map((record) => [record.id, record.revision])))
  return { ...data, personaRoots: roots }
}

function seedPersona16(store) {
  const data = seedDashboardFixture(store)
  const extra = Array.from({ length: 14 }, (_unused, index) => store.addMemory({
    content: `Synthetic persona source ${index + 1}.`, kind: 'fact', confidence: 0.8, status: 'approved',
  }).record)
  const sources = [data.approvedA, data.approvedB, ...extra]
  store.setPersona('Synthetic sixteen-source persona.', sources.length, sources.map((record) => record.id),
    Date.now(), Object.fromEntries(sources.map((record) => [record.id, record.revision])))
  return { ...data, personaSources: sources }
}


function seedScenePagination(store) {
  const data = seedDashboardFixture(store)
  const singles = []
  for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f']) {
    singles.push(store.addMemory({ content: `Synthetic scene ${suffix} member.`, kind: 'fact', confidence: 0.8,
      status: 'approved', scene: `scene-${suffix}` }).record)
  }
  const many = Array.from({ length: 16 }, (_unused, index) => store.addMemory({
    content: `Synthetic scene-many member ${index} with unique text ${'m'.repeat(index + 3)}.`,
    kind: 'fact', confidence: 0.8, status: 'approved', scene: 'scene-many',
  }).record)
  store.refreshScenes()
  const expected = store.scenes().map((scene) => ({ name: scene.name, memoryCount: scene.memoryCount,
    summaryComplete: scene.summaryComplete }))
    .sort((left, right) => right.memoryCount - left.memoryCount || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { ...data, scenes: expected, sceneSingles: singles, sceneMany: many }
}

function seedSceneSourceRevoke(store) {
  const data = seedDashboardFixture(store)
  const source = store.recordL0({ sessionId: 'scene-rpc-revoke-source', role: 'user',
    content: 'Synthetic RPC scene source to revoke.' })
  const member = store.addMemory({ content: 'RPC scene source revocation member.', kind: 'fact', confidence: 0.8,
    status: 'approved', scene: 'rpc-revoked-scene', sourceMessageIds: [source] }).record
  store.refreshScenes()
  return { ...data, revokedSceneSource: source, revokedSceneMember: member }
}

function seedSceneManagedRevoke(store) {
  const data = seedDashboardFixture(store)
  const source = store.recordL0({ sessionId: 'scene-managed-revoke-source', role: 'user',
    content: 'Synthetic managed scene revoke source.', sourceEventId: 'scene-managed-revoke-event' })
  const members = []
  for (let index = 0; index < 16; index += 1) {
    members.push(store.addMemory({ content: `Managed revoke scene member ${index}.`, kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'managed-revoke-scene',
      ...(index === 0 ? { sourceMessageIds: [source], sourceVerified: true } : {}) }).record)
  }
  store.refreshScenes()
  return { ...data, managedRevokeSource: source, managedRevokeMembers: members }
}

function seedSceneEarlyUnresolved(store) {
  const data = seedDashboardFixture(store)
  const unresolvedName = 'a-early-unresolved-scene'
  store.addMemory({ content: 'Early unresolved scene member.', kind: 'fact', confidence: 0.8,
    status: 'approved', scene: unresolvedName })
  const normal = []
  for (let index = 0; index < 7; index += 1) {
    normal.push(store.addMemory({ content: `Normal scene after early unresolved ${index}.`, kind: 'fact', confidence: 0.8,
      status: 'approved', scene: `normal-later-scene-${index}` }).record)
  }
  store.refreshScenes()
  const expected = store.scenes().map((scene) => scene.name).sort()
  store.db.prepare(`UPDATE l2_scenes SET summary_frontier_ready = 0 WHERE name = ?`).run(unresolvedName)
  return { ...data, earlyUnresolvedName: unresolvedName, sceneNormalMembers: normal, expectedSceneNames: expected }
}

function seedScene101(store) {
  const data = seedDashboardFixture(store)
  const members = Array.from({ length: 101 }, (_unused, index) => store.addMemory({
    content: `Synthetic scene-101 member ${index}.`, kind: 'fact', confidence: 0.8,
    status: 'approved', scene: 'scene-101',
  }).record)
  store.refreshScenes()
  return { ...data, scene101Members: members }
}

function seedSceneAbnormal(store) {
  const realNow = Date.now
  const seedNow = realNow() - 1_000
  assert.equal(Number.isFinite(seedNow), true)
  Date.now = () => seedNow
  let data
  let dirtyBase
  let frontier
  let missingA
  let missingB
  let longName
  let longMember
  let afterLong
  let dirtyCandidate
  let badIdBase
  let oversizedName
  let oversizedNameMember
  try {
    data = seedDashboardFixture(store)
    dirtyBase = store.addMemory({ content: 'Dirty scene base member.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'dirty-scene' }).record
    frontier = store.addMemory({ content: 'Frontier scene member.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'frontier-scene' }).record
    missingA = store.addMemory({ content: 'Missing scene member A.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'missing-scene' }).record
    missingB = store.addMemory({ content: 'Missing scene member B.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'missing-scene' }).record
    longName = `a${'x'.repeat(519)}`
    longMember = store.addMemory({ content: 'Long scene name member.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: longName }).record
    afterLong = store.addMemory({ content: 'Scene after the overlong name.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'b-after-long' }).record
    badIdBase = store.addMemory({ content: 'Malformed scene member base.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: 'bad-id-scene' }).record
    oversizedName = `z${'x'.repeat(4_096)}`
    oversizedNameMember = store.addMemory({ content: 'Oversized scene name member.', kind: 'fact', confidence: 0.8,
      status: 'approved', scene: oversizedName }).record
    store.refreshScenes()
    dirtyCandidate = store.addMemory({ content: 'Dirty scene incremental member.', kind: 'fact', confidence: 0.8,
      status: 'candidate', scene: 'dirty-scene' }).record
  } finally { Date.now = realNow }
  const projectKey = projectKeyOfStore(store)
  // The real approval runs after the frozen refresh timestamp. Store.approve
  // updates the memory/events only; the production scene path then advances the
  // normalized index explicitly, selecting a genuine dirty prepend.
  const approved = store.approve(dirtyCandidate.id)
  const sceneAdvanced = store.advanceSceneIndexForApproval(dirtyCandidate.id)
  store.db.prepare(`UPDATE l2_scenes SET summary_frontier_ready = 0 WHERE project_key = ? AND name = 'frontier-scene'`)
    .run(projectKey)
  store.db.prepare(`DELETE FROM l2_scene_members WHERE project_key = ? AND scene_name = 'missing-scene' AND memory_id = ?`)
    .run(projectKey, missingB.id)
  // Bounded fault fixture: keep the frontier flag ready so the reader must
  // diagnose the normalized member-count mismatch instead of the trigger flag.
  store.db.prepare(`UPDATE l2_scenes SET summary_frontier_ready = 1 WHERE project_key = ? AND name = 'missing-scene'`)
    .run(projectKey)
  store.db.prepare(`INSERT INTO l2_scene_members(project_key, scene_name, memory_id, revision, ordinal)
    VALUES (?, ?, ?, ?, ?)`).run(projectKey, 'bad-id-scene', 'x'.repeat(300), badIdBase.revision, 1)
  // Keep the frontier flag ready so the reader reaches the malformed-identity
  // sentinel rather than stopping at the trigger-maintained frontier bit.
  store.db.prepare(`UPDATE l2_scenes SET summary_frontier_ready = 1 WHERE project_key = ? AND name = 'bad-id-scene'`)
    .run(projectKey)
  const dirtyMembers = store.dashboardSceneMemberPage('dirty-scene', undefined, 100).rows
  const dirtyContinuation = store.dashboardSceneMemberPage('dirty-scene', dirtyMembers[0]?.ordinal, 1).rows
  const dirtyRow = store.db.prepare(`SELECT source_snapshot_dirty, summary_frontier_ready, memory_count
    FROM l2_scenes WHERE project_key = ? AND name = 'dirty-scene'`).get(projectKey)
  return { ...data, dirtyBase, dirtyCandidate, approved, sceneAdvanced, dirtyRow, badIdBase, oversizedName,
    oversizedNameMember, frontier, missingA, missingB, longName, longMember, afterLong, dirtyMembers, dirtyContinuation,
    negativeOrdinals: dirtyMembers.some((member) => member.ordinal < 0) }
}

function projectKeyOfStore(store) {
  const row = store.db.prepare('SELECT project_key FROM l1_memories LIMIT 1').get()
  if (row === undefined || typeof row.project_key !== 'string') throw new Error('scene fixture project key unavailable')
  return row.project_key
}

function seedThirtyCapturesTwentyMemories(store) {
  return seedBulk(store, 30, 20)
}

function memoryServiceOf(fiber, root) {
  let service
  try { service = fiber.ctx.get('memoryTdai') } catch { service = undefined }
  if (service === undefined) {
    try { service = root.get('memoryTdai') } catch { service = undefined }
  }
  if (service === undefined) service = fiber.ctx.memoryTdai
  assert.ok(service, 'the plugin must register the memoryTdai service')
  return service
}

async function createHarness(seed, prepare) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-s3-rpc-store-'))
  const projectCwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-s3-rpc-project-'))
  const project = projectIdentity(projectCwd)
  let store
  let context
  let fiber
  try {
    store = openProjectStore(root, project.key, project)
    const data = seed(store)
    store.close()
    store = undefined
    if (prepare !== undefined) prepare(root, project, data)

    context = new Context()
    const tools = []
    context.provide('tools', {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    })
    context.provide('sessions', { list: () => [], get: () => undefined })
    fiber = await context.plugin(
      { name: plugin.name, inject: plugin.inject, apply: plugin.apply },
      {
        dataDir: root,
        mode: 'review',
        capture: { enabled: false, excludeAgents: [] },
        extraction: { enabled: false },
        recall: { enabled: false },
      },
    )
    const service = memoryServiceOf(fiber, context)
    const leaseFile = path.join(root, 'runtime-writer.lock')
    let disposed = false
    const harness = {
      root, projectCwd, project, data, tools, service, leaseFile,
      get fiber() { return fiber },
      get context() { return context },
      async disposeFiber() {
        if (disposed) return
        disposed = true
        await fiber.dispose()
      },
      async cleanup() {
        let failure
        try {
          if (!disposed) {
            disposed = true
            await fiber?.dispose()
          }
        } catch (error) {
          failure = error
        }
        try { await context?.fiber.dispose() } catch (error) { failure ??= error }
        try { rmSync(root, { recursive: true, force: true }) } catch (error) { failure ??= error }
        try { rmSync(projectCwd, { recursive: true, force: true }) } catch (error) { failure ??= error }
        if (failure !== undefined) throw failure
      },
    }
    return harness
  } catch (error) {
    try { store?.close() } catch { /* preserve the original fixture failure */ }
    try { await fiber?.dispose() } catch { /* preserve the original fixture failure */ }
    try { await context?.fiber.dispose() } catch { /* preserve the original fixture failure */ }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* preserve the original fixture failure */ }
    try { rmSync(projectCwd, { recursive: true, force: true }) } catch { /* preserve the original fixture failure */ }
    throw error
  }
}

async function createRuntimeRpcHarness(seed, configOverrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-s3-rpc-runtime-'))
  const projectCwd = mkdtempSync(path.join(os.tmpdir(), 'tdai-s3-rpc-runtime-project-'))
  const project = projectIdentity(projectCwd)
  let store
  let runtime
  let context
  let data
  try {
    if (seed !== undefined) {
      store = openProjectStore(root, project.key, project)
      data = seed(store)
      store.close()
      store = undefined
    }
    const host = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      sessions: { list: () => [], get: () => undefined },
      get() { return undefined },
    }
    runtime = new MemoryRuntime(host, resolveConfig({
      dataDir: root,
      capture: { enabled: false, excludeAgents: [] },
      extraction: { enabled: false },
      recall: { enabled: false },
      ...configOverrides,
    }), root)
    context = new Context()
    const remote = new MemoryTdaiRemote(context, {
      readDashboard: (request) => runtime.readDashboard(request),
    })
    const leaseFile = path.join(root, 'runtime-writer.lock')
    let closed = false
    return {
      root, projectCwd, project, data, runtime, context, remote, leaseFile,
      async cleanup() {
        let failure
        if (!closed) {
          closed = true
          try { runtime.close() } catch (error) { failure = error }
        }
        try { await context?.fiber.dispose() } catch (error) { failure ??= error }
        try { rmSync(root, { recursive: true, force: true }) } catch (error) { failure ??= error }
        try { rmSync(projectCwd, { recursive: true, force: true }) } catch (error) { failure ??= error }
        if (failure !== undefined) throw failure
      },
    }
  } catch (error) {
    try { store?.close() } catch { /* preserve the original fixture failure */ }
    try { runtime?.close() } catch { /* preserve the original fixture failure */ }
    try { await context?.fiber.dispose() } catch { /* preserve the original fixture failure */ }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* preserve the original fixture failure */ }
    try { rmSync(projectCwd, { recursive: true, force: true }) } catch { /* preserve the original fixture failure */ }
    throw error
  }
}

async function startSelectedDashboard(service, projectKey, captureDate) {  const selection = await callRpc(service, READ_DASHBOARD, {
    request: { version: 1, action: 'bootstrap' },
  })
  assert.equal(selection.status, 'selection_required')
  assert.equal(selection.complete, true)
  assert.ok(Array.isArray(selection.projects))
  assert.equal(selection.projects[0]?.key, projectKey)
  assert.ok(selection.readId, 'a nonempty project page carries a selection readId')

  const started = await callRpc(service, READ_DASHBOARD, {
    request: {
      version: 1, action: 'bootstrap', readId: selection.readId, projectKeys: [projectKey],
      range: rangeFor(captureDate),
    },
  })
  assert.equal(started.status, 'ok')
  assert.equal(started.complete, true)
  assert.ok(started.readId)
  assert.notEqual(started.readId, selection.readId, 'selecting projects retires the old scope and opens a new readId')
  assert.equal(started.projects.length, 1)
  assert.equal(started.projects[0].key, projectKey)
  assert.equal(typeof started.projects[0].name, 'string')
  return { selection, started }
}

async function finishOverview(service, readId) {
  let result = await callRpc(service, READ_DASHBOARD, {
    request: { version: 1, action: 'overview', readId },
  })
  let continuations = 0
  while (result.cursor !== undefined && continuations < 16) {
    result = await callRpc(service, READ_DASHBOARD, {
      request: { version: 1, action: 'continue', readId, cursor: result.cursor },
    })
    continuations += 1
  }
  return { result, continuations }
}

function withoutPayload(result) {
  for (const key of ['metrics', 'dimensions', 'scopedDimensions', 'identity', 'usage', 'coverage', 'activity', 'records',
    'events', 'record', 'itemState', 'cursor']) {
    assert.equal(result[key], undefined, `unexpected ${key} payload on ${result.status}`)
  }
  assert.equal(result.complete, false)
}

/**
 * Freeze the S1 monotonic clock for a single integration test. This freezes
 * both the cooperative 100 ms activity window and the manager's monotonic
 * lifetime/continuation checks; it is not only a 100 ms fixture. The fixed
 * work/row/byte/resident/continuation limits are untouched, but the frozen
 * lifetime means these tests cannot prove any production timing or expiry
 * behavior.
 */
async function withFixedMonotonicClock(callback) {
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now')
  Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => 0 })
  try {
    return await callback()
  } finally {
    if (ownNow === undefined) delete performance.now
    else Object.defineProperty(performance, 'now', ownNow)
  }
}

/** Freeze only the clocks that bound RPC read lifetime during multi-page fixtures. */
async function withFixedDashboardReadClock(callback) {
  const ownNow = Object.getOwnPropertyDescriptor(Date, 'now')
  const fixedWallNow = Date.now()
  Object.defineProperty(Date, 'now', { configurable: true, writable: true, value: () => fixedWallNow })
  try { return await withFixedMonotonicClock(callback) }
  finally {
    if (ownNow === undefined) delete Date.now
    else Object.defineProperty(Date, 'now', ownNow)
  }
}

async function withHarness(create, body) {
  const harness = await create()
  let bodyError
  let result
  try {
    result = await body(harness)
  } catch (error) {
    bodyError = error
  }
  let cleanupError
  try {
    await harness.cleanup()
  } catch (error) {
    cleanupError = error
  }
  if (bodyError !== undefined) {
    if (cleanupError !== undefined) {
      // Preserve the body assertion/error as the primary failure and attach
      // the cleanup failure for diagnosis. Only a cleanup-only failure is
      // surfaced as the test failure below.
      try {
        Object.defineProperty(bodyError, 'cleanupError', {
          value: cleanupError, configurable: true, enumerable: false,
        })
      } catch { /* preserve the body error if it cannot be annotated */ }
      try { if (bodyError.cause === undefined) bodyError.cause = cleanupError } catch { /* best effort */ }
    }
    throw bodyError
  }
  if (cleanupError !== undefined) throw cleanupError
  return result
}

async function startDirectDashboard(service, projectKey, captureDate) {
  const started = await callRpc(service, READ_DASHBOARD, {
    request: {
      version: 1, action: 'bootstrap', projectKeys: [projectKey], range: rangeFor(captureDate),
    },
  })
  assert.equal(started.status, 'ok')
  assert.equal(started.complete, true)
  assert.ok(started.readId)
  assert.deepEqual(started.projects.map((project) => project.key), [projectKey])
  return started
}

function installControlledSweepClock() {
  const originalDateNow = Date.now
  const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now')
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let wallNow = Date.now()
  let monotonicNow = 1_000
  const timers = []
  Date.now = () => wallNow
  Object.defineProperty(performance, 'now', {
    configurable: true, writable: true, value: () => monotonicNow,
  })
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = {
      unref() {},
      delay,
      run: () => callback(...args),
    }
    timers.push(handle)
    return handle
  }
  globalThis.clearTimeout = () => {}
  let restored = false
  return {
    timers,
    now: () => wallNow,
    advance(milliseconds) {
      wallNow += milliseconds
      monotonicNow += milliseconds
    },
    restore() {
      if (restored) return
      restored = true
      Date.now = originalDateNow
      if (originalPerformanceNow === undefined) delete performance.now
      else Object.defineProperty(performance, 'now', originalPerformanceNow)
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

async function withControlledSweep(seed, callback) {
  return withHarness(
    () => createRuntimeRpcHarness(seed),
    async (harness) => {
      const clock = installControlledSweepClock()
      let bodyError
      let result
      try {
        result = await callback({ harness, ...clock })
      } catch (error) {
        bodyError = error
      }
      let restoreError
      try {
        clock.restore()
      } catch (error) {
        restoreError = error
      }
      if (bodyError !== undefined) {
        if (restoreError !== undefined) {
          try {
            Object.defineProperty(bodyError, 'cleanupError', {
              value: restoreError, configurable: true, enumerable: false,
            })
          } catch { /* preserve the body error if it cannot be annotated */ }
        }
        throw bodyError
      }
      if (restoreError !== undefined) throw restoreError
      return result
    },
  )
}

function assertSweptRuntime(runtime, before) {
  const stats = runtime.dashboardReadSessions.stats()
  assert.equal(stats.sessions, 0)
  assert.equal(stats.activeCalls, 0)
  assert.ok(stats.accountedBytes < before.accountedBytes,
    `retired tokens may remain, but the owned session resident bytes must drop (${stats.accountedBytes} < ${before.accountedBytes})`)
  assert.ok(stats.accountedBytes <= 128, 'only bounded retired-token tombstones may remain')
  assert.equal(runtime.dashboardVisibilityReaders.size, 0)
  assert.equal(runtime.dashboardReadOnlyStores.size, 0)
  assert.equal(runtime.dashboardAggregate.states.size, 0)
  assert.equal(runtime.dashboardAggregate.directoryStates.size, 0)
  assert.equal(runtime.dashboardAggregate.sweepTimer, undefined)
}

test('the exported host/client descriptors and live service share the real readDashboard codec', async () => {
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    assert.ok(harness.service instanceof MemoryTdaiRemote)
    assert.equal(harness.service.name, 'memoryTdai')
    assert.equal(harness.service.typertRemote.serviceKey, 'memoryTdai')
    assert.equal(harness.service.typertRemote.namespace, 'memoryTdai')
    assert.equal(remoteMethods(harness.service).length, 15,
      'every exported dashboard method, including the S4 ACK methods, must carry a @Remote marker')
    assertRemoteMarker(harness.service, READ_DASHBOARD)
    assertRemoteMarker(harness.service, REVIEW)
    assertRemoteMarker(harness.service, UPDATE_SETTINGS)

    const descriptor = descriptorOf(READ_DASHBOARD)
    assert.equal(descriptor.service, 'memoryTdai')
    assert.equal(descriptor.namespace, 'memoryTdai')
    assert.equal(descriptor.method, 'readDashboard')
    assert.deepEqual(descriptor.parameters.map((parameter) => parameter.wire), ['request'])
    assert.equal(descriptor.parameters[0].codec.mode, 'strict')
    assert.equal(descriptor.parameters[0].codec.create(), ReadDashboardRequestSchema)
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(typeof descriptor.result.create, 'function')
    assert.equal(TYPERT.invocations.find((entry) => entry.id === READ_DASHBOARD), descriptor)
    assert.equal(TYPERT_REMOTE.descriptors.find((entry) => entry.id === READ_DASHBOARD), descriptor)
    const modelService = TYPERT.model.services.find((entry) => entry.key === 'memoryTdai')
    assert.ok(modelService)
    assert.ok(modelService.members.some((member) => member.name === 'readDashboard'))

    const invalidRequest = () => descriptorOf(READ_DASHBOARD).parameters[0].codec.create().parse({
      version: 1, action: 'bootstrap', projectKeys: ['../escape'],
    })
    assert.throws(invalidRequest, 'the real request codec rejects a traversal project key')
    await assert.rejects(
      harness.service.readDashboard({ version: 1, action: 'overview', readId: 'not-a-uuid' }),
      'the live service keeps its own strict request validation',
    )
  })
})

test('real plugin RPC path covers bootstrap, overview, library, detail, continue, close and error states', async () => {
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    const service = harness.service
    const projectKey = harness.project.key
    const data = harness.data
    const read = (request) => callRpc(service, READ_DASHBOARD, { request })

    const { selection, started: overviewStarted } = await startSelectedDashboard(service, projectKey, data.captureDate)
    assert.equal(overviewStarted.projects[0].name, harness.project.name)
    const retired = await read({ version: 1, action: 'close', readId: selection.readId })
    assert.equal(retired.status, 'stale')
    assert.equal(retired.reason, 'project-scope-changed')

    const overviewRun = await finishOverview(service, overviewStarted.readId)
    const overview = overviewRun.result
    assert.equal(overview.status, 'ok')
    assert.equal(overview.complete, true)
    assert.ok(overviewRun.continuations < 16)
    assert.equal(overview.metrics.captures.value, 2)
    assert.equal(overview.metrics.captures.relation, 'exact')
    assert.equal(overview.metrics.effectiveMemories.value, 2)
    assert.equal(overview.metrics.candidates.value, 2)
    assert.equal(overview.metrics.initialApprovals.value, 2)
    assert.equal(overview.metrics.recallRequests.value, 2)
    assert.equal(overview.metrics.recallResults.value, 1)
    assert.equal(overview.identity.unknownOriginalMessageEvents.value, 2)
    assert.equal(overview.identity.recordedOriginalMessageLowerBound.value, 0)
    assert.equal(overview.coverage.status, 'unknown')
    const captureDay = overview.activity.find((entry) => entry.date === data.captureDate)
    assert.ok(captureDay)
    assert.equal(captureDay.count.value, 2)
    assert.equal(captureDay.coverage, 'unknown')

    // The overview readId has already consumed its bootstrap and overview
    // handoffs. Close it explicitly and open a fresh scope before exercising
    // the library/detail views; the default 16-continuation ceiling is not
    // widened.
    const overviewClosed = await read({ version: 1, action: 'close', readId: overviewStarted.readId })
    assert.equal(overviewClosed.view, 'control')
    assert.equal(overviewClosed.status, 'ok')
    const overviewReadAfterClose = await read({ version: 1, action: 'overview', readId: overviewStarted.readId })
    assert.equal(overviewReadAfterClose.status, 'stale')
    withoutPayload(overviewReadAfterClose)

    const { started } = await startSelectedDashboard(service, projectKey, data.captureDate)
    assert.ok(started.readId)
    assert.notEqual(started.readId, overviewStarted.readId)
    assert.equal(started.projects[0].name, harness.project.name)

    const approvedFirst = await read({
      version: 1, action: 'library', readId: started.readId, projectKey, status: 'approved', limit: 1,
    })
    assert.equal(approvedFirst.status, 'ok')
    assert.equal(approvedFirst.complete, false)
    assert.equal(approvedFirst.records.length, 1)
    assert.ok(approvedFirst.records[0].id === data.approvedA.id || approvedFirst.records[0].id === data.approvedB.id)
    assert.ok(approvedFirst.cursor)

    const wrongCursor = await read({
      version: 1, action: 'continue', readId: started.readId, cursor: randomUUID(),
    })
    assert.equal(wrongCursor.status, 'stale')
    assert.equal(wrongCursor.reason, 'cursor-invalid-or-consumed')
    assert.equal(wrongCursor.records, undefined)

    const approvedSecond = await read({
      version: 1, action: 'continue', readId: started.readId, cursor: approvedFirst.cursor,
    })
    assert.equal(approvedSecond.status, 'ok')
    assert.equal(approvedSecond.complete, true)
    assert.equal(approvedSecond.records.length, 1)
    assert.notEqual(approvedSecond.records[0].id, approvedFirst.records[0].id)
    assert.equal(approvedSecond.cursor, undefined)

    const replay = await read({
      version: 1, action: 'continue', readId: started.readId, cursor: approvedFirst.cursor,
    })
    assert.equal(replay.status, 'stale')
    assert.equal(replay.reason, 'cursor-invalid-or-consumed')
    assert.equal(replay.records, undefined)

    const candidateFirst = await read({
      version: 1, action: 'library', readId: started.readId, projectKey, status: 'candidate', limit: 1,
    })
    assert.equal(candidateFirst.status, 'ok')
    assert.equal(candidateFirst.complete, false)
    assert.equal(candidateFirst.records.length, 1)
    assert.equal(candidateFirst.records[0].status, 'candidate')
    const candidateSecond = await read({
      version: 1, action: 'continue', readId: started.readId, cursor: candidateFirst.cursor,
    })
    assert.equal(candidateSecond.status, 'ok')
    assert.equal(candidateSecond.complete, true)
    assert.equal(candidateSecond.records.length, 1, 'a continuation returns only its own page, never the accumulated list')
    assert.notEqual(candidateSecond.records[0].id, candidateFirst.records[0].id)
    const candidateIds = [...candidateFirst.records, ...candidateSecond.records]
      .map((record) => record.id).sort()
    assert.deepEqual(candidateIds, [data.candidateA.id, data.candidateB.id].sort())
    assert.equal(new Set(candidateIds).size, 2)

    const forgottenPage = await read({
      version: 1, action: 'library', readId: started.readId, projectKey, status: 'forgotten', limit: 5,
    })
    assert.equal(forgottenPage.status, 'ok')
    assert.equal(forgottenPage.complete, true)
    assert.deepEqual(forgottenPage.records.map((record) => record.id), [data.forgotten.id])
    assert.equal(forgottenPage.records[0].status, 'forgotten')

    const approvedDetail = await read({
      version: 1, action: 'detail', readId: started.readId, projectKey,
      target: { kind: 'memory', status: 'approved', id: data.approvedA.id },
    })
    assert.equal(approvedDetail.status, 'ok')
    assert.equal(approvedDetail.itemState, 'visible')
    assert.equal(approvedDetail.record.content, data.approvedA.content)
    assert.deepEqual(approvedDetail.record.sourceMessageIds, [data.sourceA])
    assert.equal(approvedDetail.record.sourceVerified, true)
    assert.equal(approvedDetail.record.projectKey, projectKey)

    const candidateDetail = await read({
      version: 1, action: 'detail', readId: started.readId, projectKey,
      target: { kind: 'memory', status: 'candidate', id: data.candidateA.id },
    })
    assert.equal(candidateDetail.status, 'ok')
    assert.equal(candidateDetail.itemState, 'visible')
    assert.equal(candidateDetail.record.status, 'candidate')
    assert.equal(candidateDetail.record.content, data.candidateA.content)

    const forgottenDetail = await read({
      version: 1, action: 'detail', readId: started.readId, projectKey,
      target: { kind: 'memory', status: 'forgotten', id: data.forgotten.id },
    })
    assert.equal(forgottenDetail.status, 'ok')
    assert.equal(forgottenDetail.itemState, 'visible')
    assert.equal(forgottenDetail.record.status, 'forgotten')
    assert.equal(forgottenDetail.record.forgottenAt, data.forgotten.forgottenAt)

    const hiddenDetail = await read({
      version: 1, action: 'detail', readId: started.readId, projectKey,
      target: { kind: 'memory', status: 'approved', id: 'synthetic-missing-memory' },
    })
    assert.equal(hiddenDetail.status, 'ok')
    assert.equal(hiddenDetail.itemState, 'hidden')
    assert.equal(hiddenDetail.record, null)

    const eventDetail = await read({
      version: 1, action: 'detail', readId: started.readId, projectKey,
      target: { kind: 'events', dimension: 'date', value: data.captureDate },
    })
    assert.equal(eventDetail.status, 'ok')
    assert.equal(eventDetail.complete, true)
    assert.equal(eventDetail.events.length, 2)
    assert.ok(eventDetail.events.every((event) => event.type === 'capture' && event.eventCount === 1))

    const notSelected = await read({
      version: 1, action: 'library', readId: started.readId, projectKey: 'synthetic-other-project',
      status: 'approved', limit: 1,
    })
    assert.equal(notSelected.status, 'scope_limit')
    assert.equal(notSelected.reason, 'project-not-selected')
    assert.equal(notSelected.records, undefined)

    const unknownRead = await read({ version: 1, action: 'overview', readId: randomUUID() })
    assert.equal(unknownRead.status, 'stale')
    assert.equal(unknownRead.reason, 'unknown-or-finished-read')
    withoutPayload(unknownRead)

    const tooManyProjects = await read({
      version: 1, action: 'bootstrap', projectKeys: ['one', 'two', 'three', 'four', 'five'],
      range: rangeFor(data.captureDate),
    })
    assert.equal(tooManyProjects.status, 'scope_limit')
    assert.equal(tooManyProjects.reason, 'project-selection-limit')
    assert.equal(tooManyProjects.projects, undefined)

    const missingProject = await read({
      version: 1, action: 'bootstrap', projectKeys: ['synthetic-missing-project'],
      range: rangeFor(data.captureDate),
    })
    assert.equal(missingProject.status, 'scope_limit')
    assert.equal(missingProject.reason, 'project-not-available')
    assert.equal(missingProject.projects, undefined)

    const oversizedRange = await read({
      version: 1, action: 'bootstrap', projectKeys: [projectKey],
      range: { from: '2020-01-01', to: '2022-01-01', timeZone: 'UTC', activity: 'capture' },
    })
    assert.equal(oversizedRange.status, 'scope_limit')
    assert.equal(oversizedRange.reason, 'date-range-invalid-or-too-large')

    const invalidExtra = descriptorOf(READ_DASHBOARD).parameters[0].codec.create()
    assert.throws(() => invalidExtra.parse({ version: 1, action: 'bootstrap', unexpected: true }))

    const closed = await read({ version: 1, action: 'close', readId: started.readId })
    assert.equal(closed.view, 'control')
    assert.equal(closed.status, 'ok')
    assert.equal(closed.complete, true)
    const afterClose = await read({ version: 1, action: 'overview', readId: started.readId })
    assert.equal(afterClose.status, 'stale')
    withoutPayload(afterClose)

    const settings = await callRpc(service, UPDATE_SETTINGS, { request: { globalPersona: true } })
    assert.equal(settings.version, 1)
    assert.equal(settings.settings.globalPersona, true)
  })
})

test('real RPC overview completes 30 captures and 7 approved memories inside the fixed continuation cap', async () => {
  await withFixedDashboardReadClock(async () => {
    await withHarness(() => createHarness(seedThirtyCapturesSevenMemories), async (harness) => {
      const { started } = await startSelectedDashboard(
        harness.service, harness.project.key, harness.data.captureDate,
      )
      // Observe the existing Cordis call and its registered reader, without
      // adding database reads or replacing any store/proof/codec operation. Keep only
      // one session rejection and at most 17 publication cost snapshots.
      const diagnostics = { rpcCalls: 0, phaseCalls: {}, handoffs: [], originQueries: 0, summaryQueries: 0 }
      const restorers = []
      let capturedRuntime
      let capturedReader
      let phase = 'rpc'
      let observerFailure
      const observe = (callback) => {
        try { callback() } catch (error) { observerFailure ??= String(error).slice(0, 512) }
      }
      const wrap = (target, name, invoke) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, name)
        const original = target[name]
        assert.equal(typeof original, 'function', `observed method ${name} exists`)
        Object.defineProperty(target, name, { configurable: true, writable: true,
          enumerable: descriptor?.enumerable ?? false,
          value: function (...args) { return invoke.call(this, original, args) } })
        restorers.push(() => {
          if (descriptor === undefined) delete target[name]
          else Object.defineProperty(target, name, descriptor)
        })
      }
      const capture = (runtime) => {
        assert.ok(runtime instanceof MemoryRuntime)
        const aggregate = runtime.dashboardAggregate
        const state = aggregate.states.get(started.readId)
        assert.ok(state && state.projects.length === 1 && state.projects[0].key === harness.project.key)
        const reader = state.reader
        assert.ok(runtime.dashboardVisibilityReaders.has(reader))
        capturedReader = reader
        for (const method of ['scanEvent', 'scanMemories', 'scanPage', 'scanProcessing',
          'scanAttempts', 'scanBillable', 'scanCoverage']) {
          wrap(aggregate, method, function (original, args) {
            const previous = phase
            phase = method === 'scanMemories' ? `${method}:${args[2]}` : method
            observe(() => { diagnostics.phaseCalls[phase] = (diagnostics.phaseCalls[phase] ?? 0) + 1 })
            try {
              const result = Reflect.apply(original, this, args)
              if (result.status === 'fatal' && diagnostics.firstFatalStep === undefined) observe(() => {
                diagnostics.firstFatalStep = { phase, rpc: diagnostics.rpcCalls, outcome: result.outcome,
                  remaining: reader.remainingReadWorkBreakdown() }
              })
              return result
            } finally { phase = previous }
          })
        }
        wrap(reader, 'personaReserveStatus', function (original, args) {
          const result = Reflect.apply(original, this, args)
          if (!result.ok && result.reason === 'persona-session-headroom' && diagnostics.firstSessionRejection === undefined) {
            observe(() => {
              const remaining = this.remainingReadWorkBreakdown()
              const reserve = this.personaReserveCost(args[1], args[2])
              const counters = this.manager.counters(this.callToken)
              diagnostics.firstSessionRejection = { phase, rpc: diagnostics.rpcCalls, cost: { ...args[0] }, reserve,
                remaining, counters: counters.status === 'ok' ? counters.value : { status: counters.status },
                exceeded: remaining === undefined ? [] : ['sqlStatements', 'rowsVisited', 'materializedBytes', 'keyBytes']
                  .filter((key) => args[0][key] + reserve[key] > remaining.session[key]) }
            })
          }
          return result
        })
        wrap(reader, 'suspendForRpc', function (original, args) {
          observe(() => {
            const counters = this.manager.counters(this.callToken)
            if (diagnostics.handoffs.length < 17 && counters.status === 'ok') diagnostics.handoffs.push({
              rpc: diagnostics.rpcCalls, call: { ...counters.value.call }, session: { ...counters.value.session } })
          })
          return Reflect.apply(original, this, args)
        })
        const store = reader.stores.get(harness.project.key)
        assert.ok(store)
        for (const [method, counter] of [['dashboardVisibilityDirectCreationOrigin', 'originQueries'],
          ['dashboardManagedMemory', 'summaryQueries']]) {
          wrap(store, method, function (original, args) {
            diagnostics[counter] += 1
            return Reflect.apply(original, this, args)
          })
        }
      }
      let drained
      try {
        wrap(MemoryRuntime.prototype, 'readDashboard', function (original, args) {
          if (args[0]?.readId === started.readId) observe(() => {
            diagnostics.rpcCalls += 1
            if (capturedRuntime === undefined) {
              capturedRuntime = this
              capture(this)
            } else {
              assert.equal(this, capturedRuntime, 'every matching RPC uses the same runtime')
              assert.equal(this.dashboardAggregate.states.get(started.readId)?.reader, capturedReader,
                'every continuation keeps the reader bound to the selected state')
            }
          })
          return Reflect.apply(original, this, args)
        })
        drained = await finishOverview(harness.service, started.readId)
      } finally {
        let restoreFailure
        for (const restore of restorers.reverse()) {
          try { restore() } catch (error) { restoreFailure ??= error }
        }
        if (restoreFailure !== undefined) throw restoreFailure
      }
      const { result, continuations } = drained
      assert.equal(observerFailure, undefined, `passive cost observer failed: ${observerFailure}`)
      assert.ok(capturedRuntime instanceof MemoryRuntime && capturedReader)
      assert.equal(diagnostics.rpcCalls, continuations + 1)
      assert.equal(result.status, 'ok',
        'overview ended ' + result.status + '/' + (result.reason ?? 'no reason') +
        ' after ' + continuations + ' continuations; cursor=' + (result.cursor ?? 'none') +
        '; costs=' + JSON.stringify(diagnostics))
      assert.equal(result.complete, true,
        'overview status=' + result.status + ', reason=' + (result.reason ?? 'none') +
        ', continuations=' + continuations)
      assert.equal(result.metrics.captures.value, 30)
      assert.equal(result.metrics.captures.relation, 'exact')
      assert.equal(result.metrics.effectiveMemories.value, 7)
      assert.equal(result.metrics.effectiveMemories.relation, 'exact')
      assert.equal(result.metrics.initialApprovals.value, 7)
      assert.ok(continuations < 16, `small-library drain used ${continuations} continuations`)
      assert.equal(diagnostics.originQueries, 7, 'each direct approval executes its origin helper once across RPC resumes')
      assert.equal(diagnostics.summaryQueries, 0, 'approved aggregate summaries reuse proved metadata without duplicate SQL')
    })
  })
})

test('review ACK reports applied only for an actual project-scoped state change or noop for invalid targets', async () => {
  const originalIsForgotten = ControlLedger.prototype.isForgotten
  let actualControl
  ControlLedger.prototype.isForgotten = function (projectKey, id) {
    actualControl = this
    return originalIsForgotten.call(this, projectKey, id)
  }
  try {
    await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
      const read = (request) => callRpc(harness.service, REVIEW_ACK, { request })
      const projectKey = harness.project.key
      const valid = await read({ projectKey, id: harness.data.candidateA.id, action: 'approve' })
      assert.equal(valid.ok, true)
      assert.equal(valid.scope, 'project')
      assert.equal(valid.operation, 'review.approve')
      assert.equal(valid.projectKey, projectKey)
      assert.equal(valid.targetId, harness.data.candidateA.id)
      assert.equal(valid.result, 'applied')
      assert.ok(actualControl, 'the real control ledger instance was observed')

      const afterFirst = openProjectStoreReadOnly(harness.root, projectKey)
      let firstRevision
      try {
        const firstRecord = afterFirst.get(harness.data.candidateA.id)
        assert.ok(firstRecord)
        assert.equal(firstRecord.status, 'approved')
        firstRevision = firstRecord.revision
      } finally { afterFirst.close() }
      const repeated = await read({ projectKey, id: harness.data.candidateA.id, action: 'approve' })
      assert.equal(repeated.ok, true)
      assert.equal(repeated.result, 'confirmed')
      const state = openProjectStoreReadOnly(harness.root, projectKey)
      try {
        const repeatedRecord = state.get(harness.data.candidateA.id)
        assert.ok(repeatedRecord)
        assert.equal(repeatedRecord.status, 'approved')
        assert.equal(repeatedRecord.revision, firstRevision, 'a repeated approval must not manufacture a new revision')
      } finally { state.close() }

      assert.equal(actualControl.isForgotten(projectKey, harness.data.forgotten.id), false,
        'the direct Store.forget fixture has no control fence')
      const forgotten = await read({ projectKey, id: harness.data.forgotten.id, action: 'approve' })
      assert.equal(forgotten.ok, false)
      assert.equal(forgotten.scope, 'project')
      assert.equal(forgotten.operation, 'review.approve')
      assert.equal(forgotten.projectKey, projectKey)
      assert.equal(forgotten.targetId, harness.data.forgotten.id)
      assert.equal(forgotten.result, 'rejected')
      assert.equal(forgotten.reason, 'review-target-forgotten')
      const forgottenState = openProjectStoreReadOnly(harness.root, projectKey)
      try {
        const old = forgottenState.get(harness.data.forgotten.id)
        assert.ok(old)
        assert.equal(old.status, 'forgotten')
        assert.equal(old.revision, harness.data.forgotten.revision)
      } finally { forgottenState.close() }

      const refence = await read({ projectKey, id: harness.data.forgotten.id, action: 'forget' })
      assert.equal(refence.ok, true)
      assert.equal(refence.result, 'confirmed')
      assert.equal(actualControl.isForgotten(projectKey, harness.data.forgotten.id), true,
        're-forgetting a Store-only forgotten target must establish the real control fence')
      const reforcedState = openProjectStoreReadOnly(harness.root, projectKey)
      try {
        const old = reforcedState.get(harness.data.forgotten.id)
        assert.ok(old)
        assert.equal(old.status, 'forgotten')
        assert.equal(old.revision, harness.data.forgotten.revision, 're-forget must not add a revision')
      } finally { reforcedState.close() }

      const missing = await read({ projectKey, id: 'synthetic-missing-memory', action: 'forget' })
      assert.equal(missing.ok, false)
      assert.equal(missing.result, 'noop')
      assert.equal(missing.reason, 'review-target-missing')

      const forgot = await read({ projectKey, id: harness.data.candidateB.id, action: 'forget' })
      assert.equal(forgot.ok, true)
      assert.equal(forgot.result, 'applied')
      assert.equal(actualControl.isForgotten(projectKey, harness.data.candidateB.id), true)
      const forgotState = openProjectStoreReadOnly(harness.root, projectKey)
      let forgotRevision
      try {
        const record = forgotState.get(harness.data.candidateB.id)
        assert.ok(record)
        assert.equal(record.status, 'forgotten')
        forgotRevision = record.revision
      } finally { forgotState.close() }
      const afterForgetApprove = await read({ projectKey, id: harness.data.candidateB.id, action: 'approve' })
      assert.equal(afterForgetApprove.ok, false)
      assert.equal(afterForgetApprove.result, 'rejected')
      assert.equal(afterForgetApprove.reason, 'review-control-fence')
      const finalState = openProjectStoreReadOnly(harness.root, projectKey)
      try {
        const record = finalState.get(harness.data.candidateB.id)
        assert.ok(record)
        assert.equal(record.status, 'forgotten')
        assert.equal(record.revision, forgotRevision)
      } finally { finalState.close() }
    })
  } finally {
    ControlLedger.prototype.isForgotten = originalIsForgotten
  }
})

test('registered plugin readDashboard settings returns exact configured values and update invalidation', async () => {
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    const service = harness.service
    const expected = { mode: 'balanced', recallMaxTokens: 777, extractionEveryN: 3, extractionEnabled: false,
      includePersona: true, globalPersona: false }
    const updated = await callRpc(service, UPDATE_SETTINGS_ACK, { request: expected })
    assert.equal(updated.ok, true)
    assert.equal(updated.operation, 'settings.update')
    const { started } = await startSelectedDashboard(service, harness.project.key, harness.data.captureDate)
    const settings = await callRpc(service, READ_DASHBOARD, {
      request: { version: 1, action: 'settings', readId: started.readId },
    })
    assert.equal(settings.status, 'ok')
    assert.equal(settings.view, 'settings')
    assert.equal(settings.readId, started.readId)
    assert.deepEqual(settings.settings, { ...expected, generateMemory: true, useMemory: true })
    assert.equal(settings.lastErrorState, 'absent')

    await callRpc(service, UPDATE_SETTINGS_ACK, { request: { recallMaxTokens: 778 } })
    const stale = await callRpc(service, READ_DASHBOARD, {
      request: { version: 1, action: 'settings', readId: started.readId },
    })
    assert.equal(stale.status, 'stale')
    assert.equal(stale.settings, undefined)
  })
})

test('settings action reads the bounded in-memory projection and never invokes legacy dashboard', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture, { mode: 'review', extraction: { enabled: false, everyNConversations: 2.5 } }), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const runtime = harness.runtime
    runtime.activeProjectKey = harness.project.key
    let legacyCalls = 0
    runtime.dashboard = () => {
      legacyCalls += 1
      throw new Error('legacy dashboard must not run for settings')
    }

    const settings = await read({ version: 1, action: 'settings', readId: started.readId })
    assert.equal(settings.status, 'ok')
    assert.equal(settings.view, 'settings')
    assert.equal(settings.readId, started.readId)
    assert.equal(settings.activeProjectKey, harness.project.key)
    assert.deepEqual(Object.keys(settings.settings).sort(), [
      'extractionEnabled', 'extractionEveryN', 'generateMemory', 'globalPersona', 'includePersona', 'mode', 'recallMaxTokens', 'useMemory',
    ])
    assert.equal(settings.settings.mode, 'review')
    assert.equal(settings.settings.extractionEnabled, false)
    assert.equal(typeof settings.settings.recallMaxTokens, 'number')
    assert.equal(settings.settings.extractionEveryN, 2.5, 'the read DTO preserves a legal fractional config value')
    assert.equal(legacyCalls, 0)

    runtime.activeProjectKey = 'synthetic-out-of-scope-project'
    const outOfScope = await read({ version: 1, action: 'settings', readId: started.readId })
    assert.equal(outOfScope.status, 'ok')
    assert.equal(outOfScope.readId, started.readId)
    assert.equal(outOfScope.activeProjectKey, undefined, 'activeProjectKey is omitted outside the bound read scope')

    const unknown = await read({ version: 1, action: 'settings', readId: randomUUID() })
    assert.equal(unknown.status, 'stale')
    assert.equal(unknown.settings, undefined)

    const ownedStoresBefore = [...runtime.dashboardReadOnlyStores.keys()].sort()
    const zeroScope = await read({ version: 1, action: 'settings' })
    assert.equal(zeroScope.status, 'ok')
    assert.ok(zeroScope.readId)
    assert.deepEqual(zeroScope.settings, settings.settings)
    assert.equal(zeroScope.activeProjectKey, undefined)
    assert.ok(runtime.dashboardAggregate.states.get(zeroScope.readId), 'the zero-scope read owns a resumable state lease')
    assert.deepEqual([...runtime.dashboardReadOnlyStores.keys()].sort(), ownedStoresBefore,
      'settings without a project must not open extra project databases')

    runtime.lastError = 'synthetic-settings-error'
    const withError = await read({ version: 1, action: 'settings', readId: zeroScope.readId })
    assert.equal(withError.status, 'ok')
    assert.equal(withError.readId, zeroScope.readId)
    assert.equal(withError.lastErrorState, 'present')
    assert.equal(withError.lastError, 'synthetic-settings-error')
    runtime.lastError = '😀'.repeat(501)
    const overLimit = await read({ version: 1, action: 'settings', readId: zeroScope.readId })
    assert.equal(overLimit.readId, zeroScope.readId)
    assert.equal(overLimit.lastErrorState, 'omitted')
    assert.equal(overLimit.lastError, undefined)
    await read({ version: 1, action: 'close', readId: zeroScope.readId })
    assert.equal(runtime.dashboardAggregate.states.has(zeroScope.readId), false, 'closing the zero-scope read releases its state')

    const closed = await read({ version: 1, action: 'close', readId: started.readId })
    assert.equal(closed.status, 'ok')
    const afterClose = await read({ version: 1, action: 'settings', readId: started.readId })
    assert.equal(afterClose.status, 'stale')
    assert.equal(afterClose.settings, undefined)

    const second = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    runtime.updateSettings({ globalPersona: true })
    const afterSettingsChange = await read({ version: 1, action: 'settings', readId: second.started.readId })
    assert.equal(afterSettingsChange.status, 'stale')
    assert.equal(afterSettingsChange.settings, undefined)
  })
})

test('settings refuses a readId with an unconsumed one-shot cursor', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedThirtyCapturesTwentyMemories), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const overview = await read({ version: 1, action: 'overview', readId: started.readId })
    assert.ok(overview.cursor, 'the fixture must expose a pending one-shot cursor')
    const settings = await read({ version: 1, action: 'settings', readId: started.readId })
    assert.equal(settings.status, 'stale')
    assert.equal(settings.reason, 'single-use-cursor-required')
    assert.equal(settings.settings, undefined)
  })
})

test('settings final proof failure drops the entire settings payload and releases the read', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const runtime = harness.runtime
    const readers = [...runtime.dashboardVisibilityReaders]
    assert.equal(readers.length, 1)
    const reader = readers[0]
    const originalSuspend = reader.suspendForRpc.bind(reader)
    let finalBoundaryReached = false
    reader.suspendForRpc = (beforeHandoff) => {
      if (!finalBoundaryReached) {
        finalBoundaryReached = true
        runtime.dashboardReadSessions.probeControl = () => ({
          status: 'unavailable-probe', reason: 'synthetic-settings-final-probe',
        })
      }
      return originalSuspend(beforeHandoff)
    }
    const settings = await read({ version: 1, action: 'settings', readId: started.readId })
    assert.equal(finalBoundaryReached, true, 'settings must reach the real final suspend, not fail at resume')
    assert.equal(settings.settings, undefined)
    assert.equal(settings.activeProjectKey, undefined)
    assert.equal(settings.lastErrorState, undefined)
    assert.equal(runtime.dashboardReadSessions.stats().sessions, 0)
    assert.equal(runtime.dashboardVisibilityReaders.size, 0)
    assert.equal(runtime.dashboardAggregate.states.size, 0)
  })
})

test('persona action proves sixteen persisted sources across the registered RPC continuation path', async () => {
  await withHarness(() => createHarness(seedPersona16), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let persona = await read({ version: 1, action: 'persona', readId: started.readId, projectKey: harness.project.key })
    let continuations = 0
    while (persona.cursor !== undefined && continuations < 16) {
      assert.equal(persona.persona.state, 'unresolved')
      assert.equal(persona.persona.content, undefined)
      persona = await read({ version: 1, action: 'continue', readId: started.readId, cursor: persona.cursor })
      continuations += 1
    }
    assert.equal(persona.status, 'ok')
    assert.equal(persona.view, 'persona')
    assert.equal(persona.readId, started.readId)
    assert.equal(persona.persona.state, 'visible')
    assert.equal(persona.persona.content, 'Synthetic sixteen-source persona.')
    assert.equal(persona.persona.sourceCount, 16)
    assert.equal(persona.persona.stale, false)
    assert.ok(continuations >= 1 && continuations < 16)

    const closed = await read({ version: 1, action: 'close', readId: started.readId })
    assert.equal(closed.status, 'ok')
    const afterClose = await read({ version: 1, action: 'persona', readId: started.readId, projectKey: harness.project.key })
    assert.equal(afterClose.status, 'stale')
    assert.equal(afterClose.persona, undefined)
  })
})

test('persona call-budget no-progress terminal is cleaned without payload or cursor', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedOversizedPersona), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const first = await read({ version: 1, action: 'persona', readId: started.readId, projectKey: harness.project.key })
    assert.equal(first.status, 'partial')
    assert.ok(first.cursor)
    assert.equal(first.persona.content, undefined)
    const terminal = await read({ version: 1, action: 'continue', readId: started.readId, cursor: first.cursor })
    assert.equal(terminal.status, 'budget_exhausted')
    assert.equal(terminal.cursor, undefined)
    assert.equal(terminal.persona, undefined)
    const runtime = harness.runtime
    const stats = runtime.dashboardReadSessions.stats()
    assert.equal(stats.sessions, 0)
    assert.equal(stats.activeCalls, 0)
    assert.equal(runtime.dashboardVisibilityReaders.size, 0)
    assert.equal(runtime.dashboardAggregate.states.size, 0)
  })
})

test('persona three-source dependency roots complete across registered RPC calls under default budget', async () => {
  await withHarness(() => createHarness(seedComplexPersona3), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let persona = await read({ version: 1, action: 'persona', readId: started.readId, projectKey: harness.project.key })
    let continuations = 0
    while (persona.cursor !== undefined && continuations < 16) {
      assert.equal(persona.readId, started.readId)
      assert.equal(persona.view, 'persona')
      assert.equal(persona.persona.content, undefined)
      persona = await read({ version: 1, action: 'continue', readId: started.readId, cursor: persona.cursor })
      continuations += 1
    }
    assert.equal(persona.status, 'ok')
    assert.equal(persona.readId, started.readId)
    assert.equal(persona.view, 'persona')
    assert.equal(persona.persona.state, 'visible')
    assert.equal(persona.persona.sourceCount, 3)
    assert.equal(persona.persona.content, 'Synthetic complex three-source persona.')
    assert.ok(continuations >= 1)
    assert.ok(continuations < 16)
    const closed = await read({ version: 1, action: 'close', readId: started.readId })
    assert.equal(closed.status, 'ok')
    const afterClose = await read({ version: 1, action: 'persona', readId: started.readId, projectKey: harness.project.key })
    assert.equal(afterClose.status, 'stale')
    assert.equal(afterClose.persona, undefined)
  })
})

test('review ACK rejects approval when the raw store is approved but a control forget fence exists', async () => {
  let fencedId
  await withHarness(() => createHarness(seedDashboardFixture, (root, project, data) => {
    const control = new ControlLedger(root)
    fencedId = data.approvedA.id
    try {
      control.appendControl({ eventId: `forget:${project.key}:${fencedId}`, projectKey: project.key,
        type: 'forget', memoryId: fencedId })
      assert.equal(control.isForgotten(project.key, fencedId), true)
    } finally { control.close() }
  }), async (harness) => {
    const read = (request) => callRpc(harness.service, REVIEW_ACK, { request })
    const projectKey = harness.project.key
    const id = fencedId
    const before = openProjectStoreReadOnly(harness.root, projectKey)
    let revision
    try {
      const record = before.get(id)
      assert.ok(record)
      assert.equal(record.status, 'approved')
      revision = record.revision
    } finally { before.close() }
    const ack = await read({ projectKey, id, action: 'approve' })
    assert.equal(ack.ok, false)
    assert.equal(ack.result, 'rejected')
    assert.equal(ack.reason, 'review-control-fence')
    assert.equal(ack.projectKey, projectKey)
    assert.equal(ack.targetId, id)
    const after = openProjectStoreReadOnly(harness.root, projectKey)
    try {
      const record = after.get(id)
      assert.ok(record)
      assert.equal(record.status, 'approved')
      assert.equal(record.revision, revision)
    } finally { after.close() }
  })
})

test('registered sweep expires an idle suspended read without another RPC', async () => {
  await withControlledSweep(seedDashboardFixture, async ({ harness, timers, advance }) => {
    const started = await startDirectDashboard(
      harness.remote, harness.project.key, harness.data.captureDate,
    )
    const runtime = harness.runtime
    const before = runtime.dashboardReadSessions.stats()
    assert.equal(before.sessions, 1)
    assert.equal(before.activeCalls, 0)
    assert.ok(before.accountedBytes > 0)
    assert.equal(runtime.dashboardVisibilityReaders.size, 1)
    assert.equal(runtime.dashboardReadOnlyStores.size, 1)
    assert.equal(runtime.dashboardAggregate.states.size, 1)
    assert.ok(timers.length >= 1, 'the aggregate must have registered a sweep timer')

    const state = runtime.dashboardAggregate.states.get(started.readId)
    assert.ok(state)
    advance(15_001)
    assert.ok(Date.now() - state.lastActivityAt >= 15_000)
    assert.ok(Date.now() - state.generatedAt < 60_000)
    timers.at(-1).run()

    assertSweptRuntime(runtime, before)
  })
})

test('registered sweep expires an absolute-lifetime suspended read without another RPC', async () => {
  await withControlledSweep(seedDashboardFixture, async ({ harness, timers, advance, now }) => {
    const started = await startDirectDashboard(
      harness.remote, harness.project.key, harness.data.captureDate,
    )
    const runtime = harness.runtime
    const before = runtime.dashboardReadSessions.stats()
    assert.equal(before.sessions, 1)
    assert.equal(before.activeCalls, 0)
    assert.ok(before.accountedBytes > 0)
    assert.equal(runtime.dashboardVisibilityReaders.size, 1)
    assert.equal(runtime.dashboardReadOnlyStores.size, 1)
    assert.equal(runtime.dashboardAggregate.states.size, 1)
    assert.ok(timers.length >= 1, 'the aggregate must have registered a sweep timer')

    const state = runtime.dashboardAggregate.states.get(started.readId)
    assert.ok(state)
    // Keep only the absolute ceiling in play at the controlled sweep point.
    // This is a local fixture timestamp change; no product limit is touched.
    state.lastActivityAt = now() + 60_000
    advance(60_001)
    assert.ok(Date.now() - state.lastActivityAt < 15_000)
    assert.ok(Date.now() - state.generatedAt >= 60_000)
    timers.at(-1).run()

    assertSweptRuntime(runtime, before)
  })
})

test('real RPC drops the whole payload when a write lands between its data read and final handoff', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const { started } = await startSelectedDashboard(
      harness.remote, harness.project.key, harness.data.captureDate,
    )
    const readers = [...harness.runtime.dashboardVisibilityReaders]
    assert.equal(readers.length, 1)
    const reader = readers[0]
    const originalSuspend = reader.suspendForRpc.bind(reader)
    let finalCheckReached = false
    reader.suspendForRpc = (beforeHandoff) => {
      if (!finalCheckReached) {
        // This is the boundary after overview has constructed its in-memory
        // result and before the reader's final scope/TTL proof. A real second
        // connection commits here, so the pending body must not escape.
        finalCheckReached = true
        const writer = openProjectStore(harness.root, harness.project.key)
        try {
          writer.addMemory({
            content: 'Synthetic write committed between data read and final handoff.',
            kind: 'fact', confidence: 0.8, status: 'approved',
          })
        } finally {
          writer.close()
        }
      }
      return originalSuspend(beforeHandoff)
    }

    const result = await callRpc(harness.remote, READ_DASHBOARD, {
      request: { version: 1, action: 'overview', readId: started.readId },
    })
    assert.equal(finalCheckReached, true, 'the response body was already constructed before the final check')
    assert.equal(result.status, 'stale')
    assert.equal(result.reason, 'database-version-changed')
    withoutPayload(result)
    const stats = harness.runtime.dashboardReadSessions.stats()
    assert.equal(stats.sessions, 0)
    assert.equal(stats.activeCalls, 0)
    assert.equal(harness.runtime.dashboardVisibilityReaders.size, 0)
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 0)
    assert.equal(harness.runtime.dashboardAggregate.states.size, 0)
  })
})

test('real RPC drops the batch when a deferred event proof boundary fails after visible verification', async () => {
  const modes = ['project-write', 'control-change', 'final-probe-rejection', 'memo-proof-loss']
  for (const mode of modes) {
    await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
      const { started } = await startSelectedDashboard(
        harness.remote, harness.project.key, harness.data.captureDate,
      )
      const runtime = harness.runtime
      const readers = [...runtime.dashboardVisibilityReaders]
      assert.equal(readers.length, 1)
      const reader = readers[0]
      const originalVerify = reader.verifyEventMemory.bind(reader)
      let deferredProofs = 0
      let faultApplied = false
      const applyFault = () => {
        if (mode === 'project-write') {
          // A real second connection commits after the event proof returned
          // visible, before this page's single final S1 boundary.
          const writer = openProjectStore(harness.root, harness.project.key)
          try {
            writer.addMemory({
              content: 'Synthetic project write after a deferred event proof.',
              kind: 'fact', confidence: 0.8, status: 'approved',
            })
          } finally { writer.close() }
          return
        }
        if (mode === 'control-change') {
          runtime.control.appendControl({
            eventId: 'synthetic-deferred-boundary-control',
            projectKey: harness.project.key,
            type: 'synthetic-deferred-boundary-control',
          })
          return
        }
        if (mode === 'final-probe-rejection') {
          runtime.dashboardReadSessions.probeControl = () => ({
            status: 'unavailable-probe', reason: 'synthetic-final-probe-rejected',
          })
          return
        }
        reader.memoProofStateLost = true
      }
      reader.verifyEventMemory = (projectKey, memoryId, validateBoundary) => {
        const result = originalVerify(projectKey, memoryId, validateBoundary)
        if (!faultApplied && validateBoundary === false && result.status === 'ok' &&
            result.value.state === 'visible') {
          faultApplied = true
          deferredProofs += 1
          applyFault()
        }
        return result
      }

      let result = await callRpc(harness.remote, READ_DASHBOARD, {
        request: { version: 1, action: 'overview', readId: started.readId },
      })
      let continuations = 0
      while (!faultApplied && result.cursor !== undefined && continuations < 16) {
        result = await callRpc(harness.remote, READ_DASHBOARD, {
          request: { version: 1, action: 'continue', readId: started.readId, cursor: result.cursor },
        })
        continuations += 1
      }
      assert.equal(faultApplied, true, `${mode}: the event batch must reach a visible deferred proof`)
      assert.equal(deferredProofs, 1, `${mode}: exactly the first visible deferred proof injects the fault`)
      withoutPayload(result)
      if (mode === 'final-probe-rejection') {
        assert.equal(result.status, 'unavailable')
        assert.equal(result.reason, 'synthetic-final-probe-rejected')
      } else if (mode === 'memo-proof-loss') {
        assert.equal(result.status, 'budget_exhausted')
        assert.equal(result.reason, 'visibility-proof-cache-lost')
      } else {
        assert.equal(result.status, 'stale')
        assert.equal(result.reason, 'database-version-changed')
      }
      const stats = runtime.dashboardReadSessions.stats()
      assert.equal(stats.sessions, 0)
      assert.equal(stats.activeCalls, 0)
      assert.equal(runtime.dashboardVisibilityReaders.size, 0)
      assert.equal(runtime.dashboardReadOnlyStores.size, 0)
      assert.equal(runtime.dashboardAggregate.states.size, 0)
    })
  }
})

test('direct event-memory verification keeps its own immediate boundary for omitted and explicit true', async () => {
  for (const explicit of [false, true]) {
    await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
      const { started } = await startSelectedDashboard(
        harness.remote, harness.project.key, harness.data.captureDate,
      )
      const runtime = harness.runtime
      const readers = [...runtime.dashboardVisibilityReaders]
      assert.equal(readers.length, 1)
      const reader = readers[0]
      const resumed = reader.resumeForRpc()
      assert.equal(resumed.status, 'ok')
      let proofCalls = 0
      const originalProve = reader.proveRoot.bind(reader)
      reader.proveRoot = (...args) => {
        proofCalls += 1
        return originalProve(...args)
      }
      runtime.dashboardReadSessions.probeControl = () => ({
        status: 'unavailable-probe', reason: 'synthetic-direct-final-probe-rejected',
      })

      const result = explicit
        ? reader.verifyEventMemory(harness.project.key, harness.data.approvedA.id, true)
        : reader.verifyEventMemory(harness.project.key, harness.data.approvedA.id)
      assert.equal(proofCalls, 1, `${explicit ? 'true' : 'omitted'}: the proof must form before the boundary`)
      assert.equal(result.status, 'unavailable-probe')
      assert.equal(result.reason, 'synthetic-direct-final-probe-rejected')
      assert.equal(runtime.dashboardReadSessions.stats().sessions, 0,
        'the direct method must retire the session itself rather than waiting for an outer suspend')
      assert.equal(runtime.dashboardVisibilityReaders.size, 0)
    })
  }
})

test('real RPC rejects a cross-RPC version change at the next resume and fresh reads see review/forget state', async () => {
  await withFixedDashboardReadClock(() => withHarness(() => createHarness((store) =>
    seedDashboardFixture(store, { verifiedCandidateA: true })), async (harness) => {
    const service = harness.service
    const projectKey = harness.project.key
    const data = harness.data
    const read = (request) => callRpc(service, READ_DASHBOARD, { request })

    const first = await startSelectedDashboard(service, projectKey, data.captureDate)
    const firstOverview = await finishOverview(service, first.started.readId)
    assert.equal(firstOverview.result.complete, true)

    const approved = await callRpc(service, REVIEW, {
      request: { projectKey, id: data.candidateA.id, action: 'approve' },
    })
    assert.equal(approved.version, 1)
    assert.equal(approved.candidates.some((record) => record.id === data.candidateA.id), false)
    assert.equal(approved.recent.some((record) => record.id === data.candidateA.id), true)

    const failedProof = await read({ version: 1, action: 'overview', readId: first.started.readId })
    assert.equal(failedProof.status, 'stale')
    assert.equal(failedProof.reason, 'database-version-changed')
    withoutPayload(failedProof)

    const observeVisibilityProofs = (runtime, reader) => {
      assert.ok(runtime instanceof MemoryRuntime, 'visibility diagnostics attach to the real Cordis runtime')
      assert.ok(runtime.dashboardVisibilityReaders.has(reader),
        'visibility diagnostics attach to the reader bound to the captured overview state')
      const observations = []
      const restorers = []
      let restored = false
      const restore = () => {
        if (restored) return
        restored = true
        let firstError
        for (const restoreMethod of restorers.splice(0).reverse()) {
          try { restoreMethod() } catch (error) { firstError ??= error }
        }
        if (firstError !== undefined) throw firstError
      }
      const memoryAliases = new Map([[data.candidateA.id, 'candidateA'], [data.candidateB.id, 'candidateB'],
        [data.approvedA.id, 'approvedA']])
      try {
        for (const [method, kind] of [['readManagedPageInternal', 'managed'],
          ['readRecentManagedPageInternal', 'recent']]) {
          const ownDescriptor = Object.getOwnPropertyDescriptor(reader, method)
          const original = reader[method]
          assert.equal(typeof original, 'function', `captured reader exposes ${method}`)
          Object.defineProperty(reader, method, { configurable: true, enumerable: ownDescriptor?.enumerable ?? false,
            writable: true, value: function (...args) {
              let outcome
              try {
                outcome = Reflect.apply(original, this, args)
                return outcome
              } finally {
                try {
                  if (outcome !== undefined) observations.push({ kind,
                    project: args[0] === projectKey ? 'project[0]' : 'project[other]',
                    status: outcome.status, reason: outcome.reason,
                    items: outcome.status === 'ok' ? outcome.value.items.map((item) => ({
                      id: memoryAliases.get(item.id) ?? 'memory[other]', state: item.state, reason: item.reason,
                      hasRecord: item.record !== undefined, hasSummary: item.summary !== undefined,
                    })) : [] })
                } catch { /* diagnostic projection cannot change the original result */ }
              }
            } })
          restorers.push(() => {
            if (ownDescriptor === undefined) delete reader[method]
            else Object.defineProperty(reader, method, ownDescriptor)
          })
        }
      } catch (error) {
        try { restore() } catch { /* preserve the original observer-install failure */ }
        throw error
      }
      return { items: observations, restore }
    }

    const observeOverviewCompleteness = (runtime, readId, reader) => {
      assert.ok(runtime instanceof MemoryRuntime, 'completeness diagnostics attach to the real Cordis runtime')
      const aggregate = runtime.dashboardAggregate
      const state = aggregate.states.get(readId)
      assert.ok(state, 'the diagnostic attaches to the existing in-memory overview state')
      assert.ok(state.projects.some((project) => project.key === projectKey),
        'the captured read state belongs to the fixture project')
      assert.equal(state.reader, reader, 'completeness and visibility diagnostics use the same captured reader')
      assert.ok(runtime.dashboardVisibilityReaders.has(reader),
        'the captured read state is tied to a registered visibility reader')
      const trace = []
      const initiallyTrue = []
      let initiallyTrueOverflow = 0
      let overflow = 0
      let firstTransition
      let observerFailure
      let activeTask = 'outside-task'
      const restorers = []
      const taskRestorers = []
      const projectAliases = new Map((state.projects ?? []).map((project, index) => [project.key, `project[${index}]`]))
      let restored = false

      const snapshot = () => {
        const flags = Object.create(null)
        const add = (name, value) => {
          if (typeof value === 'boolean') flags[name] = value
        }
        const overview = state.overview
        add('overview.incomplete', overview?.incomplete)
        add('overview.currentIncomplete.approved', overview?.currentIncomplete?.approved)
        add('overview.currentIncomplete.candidate', overview?.currentIncomplete?.candidate)
        add('overview.attemptsIncomplete', overview?.attemptsIncomplete)
        add('overview.billableIncomplete', overview?.billableIncomplete)
        add('overview.coverageTruncated', overview?.coverageTruncated)
        add('overview.sessionCaptureIncomplete', overview?.sessionCaptureIncomplete)
        add('overview.sessionIncomplete', overview?.sessionIncomplete)
        add('overview.sessionTruncated', overview?.sessionTruncated)
        for (const [index, project] of (state.projects ?? []).entries()) {
          for (const status of ['approved', 'candidate', 'forgotten']) {
            add(`project[${index}].${status}.incomplete`, project?.[status]?.incomplete)
          }
        }
        add('page.incomplete', state.page?.incomplete)
        add('processingScan.incomplete', state.processingScan?.incomplete)
        const sessionAgg = overview?.sessionAgg
        const sessionItems = sessionAgg instanceof Map ? sessionAgg.values()
          : Array.isArray(sessionAgg) ? sessionAgg
            : sessionAgg !== null && typeof sessionAgg === 'object' ? Object.values(sessionAgg) : []
        let sessionIndex = 0
        for (const item of sessionItems) {
          add(`session[${sessionIndex}].projectionIncomplete`, item?.projectionIncomplete)
          sessionIndex += 1
        }
        return flags
      }

      const baseline = snapshot()
      for (const [flag, value] of Object.entries(baseline)) {
        if (value !== true) continue
        const item = { flag, kind: 'already-true-at-install' }
        if (initiallyTrue.length < 128) initiallyTrue.push(item)
        else initiallyTrueOverflow += 1
        if (firstTransition === undefined) firstTransition = { ...item, task: 'before-first-task', method: 'baseline' }
      }

      const taskLabel = (key) => {
        if (typeof key !== 'string') return 'task'
        for (const [projectKey, alias] of projectAliases) {
          if (key.includes(projectKey)) return key.replace(projectKey, alias).slice(0, 96)
        }
        return key.slice(0, 96)
      }
      const outcomeFields = (value) => {
        if (typeof value === 'string') return { status: value }
        if (value === null || typeof value !== 'object') return {}
        return {
          ...(typeof value.status === 'string' ? { status: value.status } : {}),
          ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        }
      }
      const observeCall = (method, original, receiver, args) => {
        let before
        try { before = snapshot() } catch (error) { observerFailure ??= error }
        let result
        let threw = false
        try {
          result = Reflect.apply(original, receiver, args)
          return result
        } catch (error) {
          threw = true
          throw error
        } finally {
          try {
            const after = snapshot()
            const changes = []
            if (before !== undefined) {
              for (const flag of new Set([...Object.keys(before), ...Object.keys(after)])) {
                if (after[flag] !== true || before[flag] === true) continue
                const kind = before[flag] === false ? 'false-to-true' : 'missing-to-true'
                const change = { flag, kind }
                changes.push(change)
                if (firstTransition === undefined) firstTransition = {
                  ...change, task: activeTask, method, ...outcomeFields(result),
                  ...(threw ? { threw: true } : {}),
                }
              }
            }
            const entry = { task: activeTask, method, ...outcomeFields(result),
              ...(threw ? { threw: true } : {}), ...(changes.length === 0 ? {} : { changes }) }
            if (trace.length < 128) trace.push(entry)
            else overflow += 1
          } catch (error) { observerFailure ??= error }
        }
      }
      const patchMethod = (target, name, makeWrapper, restoreList = restorers) => {
        const ownDescriptor = Object.getOwnPropertyDescriptor(target, name)
        const original = target[name]
        if (typeof original !== 'function') return false
        Object.defineProperty(target, name, { configurable: true,
          enumerable: ownDescriptor?.enumerable ?? false, writable: true, value: makeWrapper(original) })
        restoreList.push(() => {
          if (ownDescriptor === undefined) delete target[name]
          else Object.defineProperty(target, name, ownDescriptor)
        })
        return true
      }

      const restore = () => {
        if (restored) return
        restored = true
        let firstError
        for (const restoreMethod of taskRestorers.splice(0).reverse()) {
          try { restoreMethod() } catch (error) { firstError ??= error }
        }
        for (const restoreMethod of restorers.splice(0).reverse()) {
          try { restoreMethod() } catch (error) { firstError ??= error }
        }
        if (firstError !== undefined) throw firstError
      }

      try {
        patchMethod(aggregate, 'overviewTasks', (original) => function (...args) {
          const result = Reflect.apply(original, this, args)
          if (!Array.isArray(result)) return result
          for (const task of result) {
            try {
              if (task === null || typeof task !== 'object') continue
              const originalRun = task.run
              if (typeof originalRun !== 'function') continue
              const ownRunDescriptor = Object.getOwnPropertyDescriptor(task, 'run')
              const label = taskLabel(task.key)
              Object.defineProperty(task, 'run', { configurable: true,
                enumerable: ownRunDescriptor?.enumerable ?? true, writable: true,
                value: function (...runArgs) {
                  const previousTask = activeTask
                  activeTask = label
                  try { return observeCall('overviewTasks.run', originalRun, this, runArgs) }
                  finally { activeTask = previousTask }
                } })
              taskRestorers.push(() => {
                if (ownRunDescriptor === undefined) delete task.run
                else Object.defineProperty(task, 'run', ownRunDescriptor)
              })
            } catch (error) { observerFailure ??= error }
          }
          return result
        })

        for (const method of ['scanEvent', 'scanMemories', 'scanProcessing', 'scanProcessingSources', 'scanPage',
          'scanAttempts', 'addAttempt', 'scanBillable', 'addBillable', 'scanCoverage', 'addCoverageWindow',
          'countEvent', 'noteSessionEvent', 'noteEventProjection', 'sessionAggregateFor', 'verifyEvent', 'visibilityResult']) {
          patchMethod(aggregate, method, (original) => function (...args) {
            return observeCall(method, original, this, args)
          })
        }
      } catch (error) {
        try { restore() } catch { /* preserve the original observer-install failure */ }
        throw error
      }

      return {
        get firstTransition() { return firstTransition },
        get observerFailure() { return observerFailure },
        initiallyTrue,
        initiallyTrueOverflow,
        trace,
        get overflow() { return overflow },
        restore,
      }
    }

    const observeRealOverview = (readId) => {
      const prototype = MemoryRuntime.prototype
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'readDashboard')
      assert.ok(prototypeDescriptor && typeof prototypeDescriptor.value === 'function',
        'the real Cordis runtime exposes its readDashboard method on the prototype')
      const originalReadDashboard = prototypeDescriptor.value
      const matchingInstances = new Set()
      let matchingCalls = 0
      let runtime
      let boundReader
      let bindingVerified = false
      let visibilityProofs
      let diagnostics
      let captureFailure
      let prototypeInstalled = false
      let restored = false

      const restoreCapturedObservers = () => {
        let firstError
        for (const observer of [diagnostics, visibilityProofs]) {
          if (observer === undefined) continue
          try { observer.restore() } catch (error) { firstError ??= error }
        }
        if (firstError !== undefined) throw firstError
      }

      const restore = () => {
        if (restored) return
        restored = true
        let firstError
        try { restoreCapturedObservers() } catch (error) { firstError ??= error }
        if (prototypeInstalled) {
          try { Object.defineProperty(prototype, 'readDashboard', prototypeDescriptor) }
          catch (error) { firstError ??= error }
          prototypeInstalled = false
        }
        if (firstError !== undefined) throw firstError
      }

      const wrappedReadDashboard = function (...args) {
        let matchesRead
        try { matchesRead = args[0]?.readId === readId }
        catch (error) { captureFailure ??= error }
        if (matchesRead) {
          matchingCalls += 1
          matchingInstances.add(this)
          if (runtime === undefined) {
            runtime = this
            try {
              assert.ok(runtime instanceof MemoryRuntime,
                'the observed read must use the real Cordis MemoryRuntime')
              const state = runtime.dashboardAggregate?.states.get(readId)
              assert.ok(state, 'the natural RPC read has an existing in-memory overview state')
              assert.ok(state.projects.some((project) => project.key === projectKey),
                'the captured read state belongs to the fixture project')
              boundReader = state.reader
              assert.ok(runtime.dashboardVisibilityReaders.has(boundReader),
                'the captured state reader is registered on the same runtime instance')
              visibilityProofs = observeVisibilityProofs(runtime, boundReader)
              diagnostics = observeOverviewCompleteness(runtime, readId, boundReader)
              bindingVerified = true
            } catch (error) {
              captureFailure = error
              try { restoreCapturedObservers() } catch { /* preserve capture failure for the post-read assertion */ }
            }
          }
        }
        return Reflect.apply(originalReadDashboard, this, args)
      }

      try {
        Object.defineProperty(prototype, 'readDashboard', {
          ...prototypeDescriptor,
          value: wrappedReadDashboard,
        })
        prototypeInstalled = true
      } catch (error) {
        try { restore() } catch { /* preserve the original prototype-install failure */ }
        throw error
      }

      return {
        get firstTransition() { return diagnostics?.firstTransition },
        get initiallyTrue() { return diagnostics?.initiallyTrue ?? [] },
        get initiallyTrueOverflow() { return diagnostics?.initiallyTrueOverflow ?? 0 },
        get trace() { return diagnostics?.trace ?? [] },
        get overflow() { return diagnostics?.overflow ?? 0 },
        get visibilityProofs() { return visibilityProofs },
        restore,
        assertCaptured() {
          assert.equal(captureFailure, undefined,
            `observer capture/install failed: ${captureFailure?.stack ?? captureFailure ?? 'unknown failure'}`)
          assert.ok(matchingCalls > 0, 'the natural Cordis RPC invoked readDashboard for the expected readId')
          assert.equal(matchingInstances.size, 1,
            'all matching readDashboard calls used one real runtime instance')
          assert.ok(runtime instanceof MemoryRuntime)
          assert.equal([...matchingInstances][0], runtime)
          assert.ok(bindingVerified, 'the runtime, fixture project, overview state, and reader bindings were verified')
          assert.ok(visibilityProofs, 'visibility proof diagnostics were installed on the captured state reader')
          assert.ok(diagnostics, 'overview completeness diagnostics were installed on the captured aggregate')
          assert.equal(diagnostics.observerFailure, undefined,
            `completeness observer failed without changing the RPC: ${diagnostics.observerFailure?.stack ?? diagnostics.observerFailure ?? 'unknown failure'}`)
        },
      }
    }

    const second = await startSelectedDashboard(service, projectKey, data.captureDate)
    const secondDiagnostics = observeRealOverview(second.started.readId)
    let secondOverview
    try { secondOverview = await finishOverview(service, second.started.readId) }
    finally { secondDiagnostics.restore() }
    secondDiagnostics.assertCaptured()
    const secondVisibilityProofs = secondDiagnostics.visibilityProofs
    assert.ok(secondDiagnostics.trace.length > 0, 'the first post-review RPC work is passively observed')
    assert.ok(secondDiagnostics.trace.length <= 128)
    assert.equal(secondOverview.result.complete, true,
      'fresh post-review read ended ' + secondOverview.result.status + '/' +
      (secondOverview.result.reason ?? 'no reason') + ' after ' + secondOverview.continuations +
      ' continuations; cursor=' + (secondOverview.result.cursor ?? 'none') +
      '; firstTransition=' + JSON.stringify(secondDiagnostics.firstTransition ?? null) +
      '; initiallyTrue=' + JSON.stringify({ items: secondDiagnostics.initiallyTrue,
        overflow: secondDiagnostics.initiallyTrueOverflow }) +
      '; trace=' + JSON.stringify({ items: secondDiagnostics.trace, overflow: secondDiagnostics.overflow }) +
      '; visibility=' + JSON.stringify(secondVisibilityProofs.items))
    assert.equal(secondVisibilityProofs.items.some((entry) => entry.items.some((item) => item.state === 'unresolved')), false,
      'fresh post-review pages retain the underlying item reason for any unresolved proof')
    assert.equal(secondOverview.result.metrics.effectiveMemories.value, 3)
    assert.equal(secondOverview.result.metrics.candidates.value, 1)

    const forgotten = await callRpc(service, REVIEW, {
      request: { projectKey, id: data.approvedA.id, action: 'forget' },
    })
    assert.equal(forgotten.version, 1)
    assert.equal(forgotten.recent.some((record) => record.id === data.approvedA.id), false)

    const failedForgetProof = await read({ version: 1, action: 'overview', readId: second.started.readId })
    assert.equal(failedForgetProof.status, 'stale')
    assert.equal(failedForgetProof.reason, 'database-version-changed')
    withoutPayload(failedForgetProof)

    const third = await startSelectedDashboard(service, projectKey, data.captureDate)
    const thirdDiagnostics = observeRealOverview(third.started.readId)
    let thirdOverview
    try { thirdOverview = await finishOverview(service, third.started.readId) }
    finally { thirdDiagnostics.restore() }
    thirdDiagnostics.assertCaptured()
    const thirdVisibilityProofs = thirdDiagnostics.visibilityProofs
    assert.ok(thirdDiagnostics.trace.length > 0, 'the first post-forget RPC work is passively observed')
    assert.ok(thirdDiagnostics.trace.length <= 128)
    assert.equal(thirdOverview.result.complete, true,
      'fresh post-forget read ended ' + thirdOverview.result.status + '/' +
      (thirdOverview.result.reason ?? 'no reason') + ' after ' + thirdOverview.continuations +
      ' continuations; cursor=' + (thirdOverview.result.cursor ?? 'none') +
      '; firstTransition=' + JSON.stringify(thirdDiagnostics.firstTransition ?? null) +
      '; initiallyTrue=' + JSON.stringify({ items: thirdDiagnostics.initiallyTrue,
        overflow: thirdDiagnostics.initiallyTrueOverflow }) +
      '; trace=' + JSON.stringify({ items: thirdDiagnostics.trace, overflow: thirdDiagnostics.overflow }) +
      '; visibility=' + JSON.stringify(thirdVisibilityProofs.items))
    assert.equal(thirdVisibilityProofs.items.some((entry) => entry.items.some((item) => item.state === 'unresolved')), false,
      'fresh post-forget pages retain the underlying item reason for any unresolved proof')
    assert.equal(thirdOverview.result.metrics.effectiveMemories.value, 2)
    assert.equal(thirdOverview.result.metrics.candidates.value, 1)
    const forgottenLibrary = await read({
      version: 1, action: 'library', readId: third.started.readId, projectKey, status: 'forgotten', limit: 5,
    })
    assert.equal(forgottenLibrary.status, 'ok')
    assert.ok(forgottenLibrary.records.some((record) => record.id === data.approvedA.id))

    assert.equal((await read({ version: 1, action: 'close', readId: third.started.readId })).status, 'ok')
    const noSourceApproval = await callRpc(service, REVIEW_ACK, {
      request: { projectKey, id: data.candidateB.id, action: 'approve' },
    })
    assert.equal(noSourceApproval.ok, true)
    assert.equal(noSourceApproval.result, 'applied')
    assert.equal(noSourceApproval.targetId, data.candidateB.id)
    const persistedNoSource = openProjectStoreReadOnly(harness.root, projectKey)
    try {
      const record = persistedNoSource.get(data.candidateB.id)
      assert.ok(record)
      assert.equal(record.status, 'approved')
      assert.deepEqual(record.sourceMessageIds, [])
      assert.equal(record.sourceVerified, false)
    } finally { persistedNoSource.close() }

    const noSourceRead = await startSelectedDashboard(service, projectKey, data.captureDate)
    const noSourceOverview = await finishOverview(service, noSourceRead.started.readId)
    assert.equal(noSourceOverview.result.complete, false,
      'approving a candidate without sources cannot make the overview claim an exact complete set')
    assert.equal(noSourceOverview.result.metrics.effectiveMemories.relation, 'lower_bound')
    assert.equal((await read({ version: 1, action: 'close', readId: noSourceRead.started.readId })).status, 'ok')
  }))
})

test('plugin disposal releases the writer lease and service while a suspended read and directory state exist', async () => {
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    const { started } = await startSelectedDashboard(
      harness.service, harness.project.key, harness.data.captureDate,
    )
    const directory = await callRpc(harness.service, READ_DASHBOARD, {
      request: { version: 1, action: 'bootstrap' },
    })
    assert.equal(directory.status, 'selection_required')
    assert.ok(started.readId)
    assert.ok(directory.readId, 'keep a real suspended directory read alive as well')
    assert.equal(existsSync(harness.leaseFile), true, 'the runtime owns the single-writer lease while active')
    await harness.disposeFiber()
    assert.equal(existsSync(harness.leaseFile), false, 'fiber disposal closes the runtime and removes its lease')
    let serviceAfterDispose
    try { serviceAfterDispose = harness.fiber.ctx.get('memoryTdai') } catch { serviceAfterDispose = undefined }
    assert.equal(serviceAfterDispose, undefined, 'the memoryTdai service is unregistered with its fiber')
  })
})

test('runtime close releases suspended reads, directory state, read-only stores, sessions and timers', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const directory = await callRpc(harness.remote, READ_DASHBOARD, {
      request: { version: 1, action: 'bootstrap' },
    })
    assert.equal(directory.status, 'selection_required')
    assert.ok(directory.readId)
    const { started } = await startSelectedDashboard(
      harness.remote, harness.project.key, harness.data.captureDate,
    )
    assert.ok(started.readId)

    const runtime = harness.runtime
    assert.equal(runtime.dashboardReadSessions.stats().sessions, 2, 'directory and selected reads both own sessions')
    assert.equal(runtime.dashboardReadSessions.stats().activeCalls, 0, 'suspended RPCs do not hold an active call')
    assert.ok(runtime.dashboardReadSessions.stats().accountedBytes > 0)
    assert.equal(runtime.dashboardVisibilityReaders.size, 2)
    assert.equal(runtime.dashboardReadOnlyStores.size, 1, 'the selected project opened one read-only handle')
    assert.equal(runtime.dashboardAggregate.directoryStates.size, 1)
    assert.equal(runtime.dashboardAggregate.states.size, 1)
    assert.ok(runtime.dashboardAggregate.sweepTimer !== undefined, 'a lifecycle sweep is scheduled')
    assert.equal(runtime.retentionTimer, undefined, 'retention pruning is disabled in this fixture')

    runtime.close()
    assert.deepEqual(runtime.dashboardReadSessions.stats(),
      { sessions: 0, activeCalls: 0, accountedBytes: 0, closed: true })
    assert.equal(runtime.dashboardVisibilityReaders.size, 0)
    assert.equal(runtime.dashboardReadOnlyStores.size, 0)
    assert.equal(runtime.dashboardAggregate.states.size, 0)
    assert.equal(runtime.dashboardAggregate.directoryStates.size, 0)
    assert.equal(runtime.dashboardAggregate.sweepTimer, undefined)
    assert.equal(runtime.retentionTimer, undefined)
    assert.equal(existsSync(harness.leaseFile), false)
  })
})

test('real RPC cumulative S1 work exhausts across views, fails without payload, and releases state', async () => {
  await withFixedMonotonicClock(async () => {
    await withHarness(() => createRuntimeRpcHarness(seedThirtyCapturesTwentyMemories), async (harness) => {
      const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
      const { started } = await startSelectedDashboard(
        harness.remote, harness.project.key, harness.data.captureDate,
      )
      const runtime = harness.runtime
      const manager = runtime.dashboardReadSessions
      const readers = [...runtime.dashboardVisibilityReaders]
      assert.equal(readers.length, 1)
      const reader = readers[0]
      const observations = []
      let currentView = 'overview'
      const observe = (phase) => {
        const counters = manager.counters(reader.callToken)
        if (counters.status !== 'ok') return
        observations.push({ phase, view: currentView, ...counters.value })
      }
      const originalResume = reader.resumeForRpc.bind(reader)
      const originalSuspend = reader.suspendForRpc.bind(reader)
      reader.resumeForRpc = () => {
        const result = originalResume()
        if (result.status === 'ok') observe('resume')
        return result
      }
      reader.suspendForRpc = (beforeHandoff) => {
        observe('suspend')
        return originalSuspend(beforeHandoff)
      }

      let overview = await read({ version: 1, action: 'overview', readId: started.readId })
      let overviewSteps = 0
      while (overview.cursor !== undefined && overviewSteps < 3) {
        overview = await read({
          version: 1, action: 'continue', readId: started.readId, cursor: overview.cursor,
        })
        overviewSteps += 1
      }
      assert.ok(overviewSteps >= 1, 'overview work must accumulate before switching views')
      currentView = 'library'

      let failure
      let successfulLibrary = false
      let libraryCounters
      let calls = 0
      for (let index = 0; index < 40; index += 1) {
        calls += 1
        const page = await read({
          version: 1, action: 'library', readId: started.readId, projectKey: harness.project.key,
          status: 'approved', limit: 1,
        })
        if (page.status === 'ok' && Array.isArray(page.records) && page.records.length > 0) {
          successfulLibrary = true
          libraryCounters = observations.at(-1)
        }
        if (page.status === 'budget_exhausted' && page.records === undefined) {
          failure = page
          break
        }
        if (page.cursor !== undefined) {
          const continued = await read({
            version: 1, action: 'continue', readId: started.readId, cursor: page.cursor,
          })
          if (continued.status === 'ok' && Array.isArray(continued.records) && continued.records.length > 0) {
            successfulLibrary = true
            libraryCounters = observations.at(-1)
          }
          if (continued.status === 'budget_exhausted' && continued.records === undefined) {
            failure = continued
            break
          }
        }
      }
      assert.ok(failure, 'the same S1 session must eventually exhaust its cumulative work')
      assert.ok(successfulLibrary, 'the library view must consume one real page before the negative failure')
      assert.ok(overviewSteps + calls >= 3,
        'exhaustion must be observed after multiple cross-view RPCs, not on a reset single call')
      withoutPayload(failure)

      const baseline = observations[0]
      const afterOverview = observations.filter((entry) => entry.view === 'overview').at(-1)
      const lastObservation = observations.at(-1)
      assert.ok(baseline && afterOverview && libraryCounters && lastObservation)
      assert.deepEqual([...new Set(observations.map((entry) => entry.view))].sort(), ['library', 'overview'])
      const sessionSql = observations.map((entry) => entry.session.sqlStatements)
      assert.ok(sessionSql.every((value, index) => index === 0 || value >= sessionSql[index - 1]),
        'the same session counters must not reset between RPCs')
      assert.ok(libraryCounters.session.sqlStatements > baseline.session.sqlStatements,
        'library work must accumulate on top of the overview session work')
      assert.ok(libraryCounters.session.continuations > baseline.session.continuations,
        'the library view must continue the same S1 session')

      const reason = failure.reason ?? ''
      assert.equal(failure.status, 'budget_exhausted')
      assert.ok(['work-limit', 'continuation-limit', 'accounted-capacity', 'resident-capacity', 'session-work-limit',
        'persona-session-headroom']
        .includes(reason), `unexpected cumulative failure reason: ${reason}`)
      if (reason === 'continuation-limit') {
        assert.ok(lastObservation.session.continuations >= manager.limits.maxContinuations - 1,
          `continuation failure must be at the session ceiling (${lastObservation.session.continuations})`)
      } else {
        assert.ok(lastObservation.session.sqlStatements > baseline.session.sqlStatements,
          'a work/capacity failure must still show cumulative session work')
        assert.ok(lastObservation.session.sqlStatements <= manager.limits.perSession.sqlStatements)
      }

      const stats = runtime.dashboardReadSessions.stats()
      assert.equal(stats.sessions, 0)
      assert.equal(stats.activeCalls, 0)
      assert.equal(runtime.dashboardVisibilityReaders.size, 0)
      assert.equal(runtime.dashboardReadOnlyStores.size, 0)
      assert.equal(runtime.dashboardAggregate.states.size, 0)
      await runtime.close()
      const closed = runtime.dashboardReadSessions.stats()
      assert.equal(closed.closed, true)
      assert.equal(closed.sessions, 0)
      assert.equal(closed.activeCalls, 0)
      assert.equal(closed.accountedBytes, 0)
      assert.equal(existsSync(harness.leaseFile), false)
    })
  })
})

test('synthetic fixture timestamps stay in a bounded UTC day window', () => {
  const date = utcDate(Date.UTC(2026, 9, 23, 12))
  assert.equal(date, '2026-10-23')
  assert.equal(shiftUtcDate(date, -1), '2026-10-22')
  assert.equal(shiftUtcDate(date, 1), '2026-10-24')
  const range = rangeFor(date)
  assert.deepEqual(range, { from: '2026-10-22', to: '2026-10-24', timeZone: 'UTC', activity: 'capture' })
  assert.equal(Date.UTC(2026, 9, 24) - Date.UTC(2026, 9, 23), DAY_MS)
})

test('registered scene readDashboard pages at most six, continues one readId, and proves sixteen members', async () => {
  await withHarness(() => createHarness(seedScenePagination), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let result = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    const firstCursor = result.cursor
    assert.ok(firstCursor, 'the sixteen-member scene must pause with a one-shot cursor')
    const otherProject = await read({ version: 1, action: 'scene', readId: started.readId,
      projectKey: 'u11-scene-other-project' })
    assert.equal(otherProject.status, 'scope_limit')
    assert.equal(otherProject.reason, 'project-not-selected')
    const ignored = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    assert.equal(ignored.status, 'stale')
    assert.equal(ignored.reason, 'single-use-cursor-required')
    const crossedRead = await read({ version: 1, action: 'continue', readId: randomUUID(), cursor: firstCursor })
    assert.equal(crossedRead.status, 'stale')
    assert.equal(crossedRead.reason, 'unknown-or-finished-read')
    const seen = []
    const seenNames = new Set()
    const byName = new Map()
    let continuations = 0
    const expected = new Map(harness.data.scenes.map((scene) => [scene.name, scene]))
    while (true) {
      assert.equal(result.view, 'scene')
      assert.equal(result.readId, started.readId)
      assert.ok(Array.isArray(result.scene?.items))
      assert.ok(result.scene.items.length <= 6)
      assert.equal(result.scene.projectKey, harness.project.key)
      for (const item of result.scene.items) {
        if (item.name !== undefined) {
          assert.equal(seenNames.has(item.name), false, `scene ${item.name} was not repeated across pages`)
          seenNames.add(item.name)
          seen.push(item.name)
          byName.set(item.name, item)
        }
        assert.equal(item.state, 'visible')
        assert.equal(item.summaryComplete, expected.get(item.name)?.summaryComplete)
        assert.equal(item.memoryCount, expected.get(item.name)?.memoryCount)
        assert.equal(typeof item.summary, 'string')
      }
      if (result.cursor === undefined) break
      assert.ok(continuations < 16, 'the scene read must remain within the finite continuation budget')
      result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    assert.ok(continuations >= 1, 'the sixteen-member scene must actually cross a call')
    assert.deepEqual(seen, harness.data.scenes.map((scene) => scene.name))
    assert.equal(result.scene.hasMore, false)
    assert.equal(result.complete, true)
    assert.equal(result.status, 'ok')
    const replayed = await read({ version: 1, action: 'continue', readId: started.readId, cursor: firstCursor })
    assert.equal(replayed.status, 'stale')
    assert.equal(replayed.reason, 'cursor-invalid-or-consumed')
    const many = byName.get('scene-many')
    assert.ok(many, 'scene-many item must be observed before the final page')
    assert.equal(many.memoryCount, 16)
    assert.equal(many.summaryComplete, false)
    assert.match(many.summary, /另有/u)
  })
})

test('registered scene readDashboard preserves dirty members, frontier refusal, missing members and overlong names', async () => {
  await withHarness(() => createHarness(seedSceneAbnormal), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let result = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    const byName = new Map()
    let overlong
    let materializedOversize
    const order = []
    let continuations = 0
    while (true) {
      assert.ok(result.scene.items.length <= 6)
      for (const item of result.scene.items) {
        if (item.name !== undefined) {
          byName.set(item.name, item)
          order.push(item.name)
        } else if (item.reason === 'scene-name-materialization-limit') {
          materializedOversize = item
        } else {
          overlong = item
        }
      }
      if (result.cursor === undefined) break
      assert.ok(continuations < 16)
      result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    assert.equal(harness.data.approved?.status, 'approved')
    assert.equal(harness.data.sceneAdvanced, true, 'the production scene index advance must succeed')
    assert.equal(harness.data.dirtyRow?.source_snapshot_dirty, 1, 'the real incremental scene must remain dirty')
    assert.equal(harness.data.dirtyRow?.summary_frontier_ready, 1)
    assert.equal(harness.data.dirtyRow?.memory_count, 2)
    assert.equal(harness.data.negativeOrdinals, true, 'the dirty scene must retain a real negative ordinal')
    assert.equal(harness.data.dirtyMembers.length, 2)
    const dirtyMemberScroll = harness.data.dirtyMembers
    assert.ok(dirtyMemberScroll.length >= 2)
    assert.ok(dirtyMemberScroll.some((member) => member.ordinal < 0))
    assert.equal(harness.data.dirtyContinuation.length, 1)
    assert.ok(harness.data.dirtyContinuation[0].ordinal > dirtyMemberScroll[0].ordinal,
      'the negative-first member page continues with a real ordinal comparison')
    const dirty = byName.get('dirty-scene')
    assert.ok(dirty)
    assert.equal(dirty.state, 'visible')
    assert.equal(dirty.memoryCount, 2)
    assert.equal(typeof dirty.summary, 'string')
    assert.equal(typeof dirty.summaryComplete, 'boolean')

    const frontier = byName.get('frontier-scene')
    assert.ok(frontier)
    assert.equal(frontier.state, 'unresolved')
    assert.equal(frontier.reason, 'scene-frontier-not-ready')
    assert.equal(frontier.summary, undefined)

    const badId = byName.get('bad-id-scene')
    assert.ok(badId)
    assert.equal(badId.state, 'unresolved')
    assert.equal(badId.reason, 'scene-member-identity-invalid')
    assert.equal(badId.summary, undefined)

    const missing = byName.get('missing-scene')
    assert.ok(missing)
    assert.equal(missing.state, 'unresolved')
    assert.equal(missing.reason, 'scene-members-incomplete')
    assert.equal(missing.summary, undefined)
    assert.ok(missing.memoryCount < 2)

    assert.ok(overlong)
    assert.equal(overlong.state, 'unresolved')
    assert.equal(overlong.reason, 'scene-name-over-budget')
    assert.equal(overlong.name, undefined)
    assert.equal(overlong.summary, undefined)
    assert.ok(materializedOversize)
    assert.equal(materializedOversize.state, 'unresolved')
    assert.equal(materializedOversize.reason, 'scene-name-materialization-limit')
    assert.equal(materializedOversize.name, undefined)
    assert.equal(materializedOversize.summary, undefined)
    assert.equal(result.cursor, undefined)
    assert.equal(result.complete, false)
    const after = byName.get('b-after-long')
    assert.ok(after, 'a valid scene after the overlong identity must remain reachable')
    assert.equal(after.state, 'visible')
    assert.ok(order.indexOf('b-after-long') >= 0)
  })
})

test('a startup source fence hides a scene member before the plugin opens', async () => {
  await withHarness(() => createHarness(seedSceneSourceRevoke, (root, project, data) => {
    const control = new ControlLedger(root)
    try {
      control.revokeSourceEvent(project.key, 'rpc-scene-revoke-event', data.revokedSceneSource)
    } finally { control.close() }
  }), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let result = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    let revoked
    let continuations = 0
    while (true) {
      revoked = result.scene.items.find((item) => item.name === 'rpc-revoked-scene') ?? revoked
      if (result.cursor === undefined) break
      assert.ok(continuations < 16)
      result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    assert.ok(revoked)
    assert.equal(revoked.state, 'hidden')
    assert.equal(revoked.summary, undefined)
    assert.equal(revoked.summaryComplete, false)
  })
})

test('scene completion remains partial when an earlier page had an unresolved scene', async () => {
  await withHarness(() => createHarness(seedSceneEarlyUnresolved), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let result = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    const seen = []
    let sawEarlyUnresolved = false
    let pages = 0
    let continuations = 0
    while (true) {
      pages += 1
      for (const item of result.scene.items) {
        if (item.name !== undefined) seen.push(item.name)
        if (item.name === harness.data.earlyUnresolvedName) {
          assert.equal(item.state, 'unresolved')
          assert.equal(item.summary, undefined)
          sawEarlyUnresolved = true
        }
      }
      if (result.cursor === undefined) break
      assert.ok(continuations < 16)
      result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    assert.equal(sawEarlyUnresolved, true)
    assert.ok(pages >= 2, 'the unresolved scene must be on an earlier page than the final all-normal page')
    assert.equal(result.scene.items.every((item) => item.state === 'visible'), true)
    assert.equal(result.scene.hasMore, false)
    assert.equal(result.cursor, undefined)
    assert.equal(result.complete, false)
    assert.equal(result.status, 'partial')
    assert.deepEqual(seen, harness.data.expectedSceneNames)
  })
})

test('scene final boundary failure drops the constructed payload and releases the read', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedScenePagination), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const first = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    assert.ok(first.cursor, 'the sixteen-member scene must pause after a bounded member batch')
    assert.equal(first.scene.items.some((item) => item.name === 'scene-many'), false,
      'no partial scene summary may be published before all members are proven')
    const readers = [...harness.runtime.dashboardVisibilityReaders]
    assert.equal(readers.length, 1)
    const reader = readers[0]
    const originalSuspend = reader.suspendForRpc.bind(reader)
    const originalProbeControl = harness.runtime.dashboardReadSessions.probeControl
    let targetSummarySeen = false
    let finalBoundaryReached = false
    reader.suspendForRpc = (beforeHandoff) => {
      const state = harness.runtime.dashboardAggregate.states.get(started.readId)
      const target = state?.sceneState?.items?.find((item) => item.name === 'scene-many')
      if (!finalBoundaryReached && target?.state === 'visible' && typeof target.summary === 'string') {
        targetSummarySeen = true
        finalBoundaryReached = true
        harness.runtime.dashboardReadSessions.probeControl = () => ({
          status: 'unavailable-probe', reason: 'synthetic-scene-final-probe',
        })
      }
      return originalSuspend(beforeHandoff)
    }
    try {
      let dropped = first
      let continuations = 0
      while (dropped.cursor !== undefined && !finalBoundaryReached) {
        assert.ok(continuations < 16)
        dropped = await read({ version: 1, action: 'continue', readId: started.readId, cursor: dropped.cursor })
        continuations += 1
      }
      assert.equal(targetSummarySeen, true, 'the scene-many visible summary must be constructed before injection')
      assert.equal(finalBoundaryReached, true, 'the scene body must reach the real final suspend')
      assert.equal(dropped.scene, undefined)
      assert.equal(dropped.cursor, undefined)
      assert.equal(dropped.complete, false)
      assert.equal(dropped.status, 'unavailable')
      assert.equal(dropped.reason, 'synthetic-scene-final-probe')
    } finally {
      reader.suspendForRpc = originalSuspend
      harness.runtime.dashboardReadSessions.probeControl = originalProbeControl
    }
    const stats = harness.runtime.dashboardReadSessions.stats()
    assert.equal(stats.sessions, 0)
    assert.equal(stats.activeCalls, 0)
    assert.equal(harness.runtime.dashboardVisibilityReaders.size, 0)
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 0)
    assert.equal(harness.runtime.dashboardAggregate.states.size, 0)
  })
})

test('a scene member forgotten between calls cannot publish the old summary', async () => {
  await withHarness(() => createHarness(seedScenePagination), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    const first = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    assert.ok(first.cursor)
    const writer = openProjectStore(harness.root, harness.project.key)
    try {
      const removed = writer.forget(harness.data.sceneMany[0].id)
      assert.equal(removed?.status, 'forgotten')
    } finally { writer.close() }
    let result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: first.cursor })
    let continuations = 0
    let many
    while (true) {
      for (const item of result.scene?.items ?? []) if (item.name === 'scene-many') many = item
      if (result.cursor === undefined) break
      assert.ok(continuations < 16)
      result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    assert.ok(many === undefined || many.state !== 'visible',
      'a member forgotten after the first proof batch must not yield a visible old summary')
    assert.equal(many?.summary, undefined)
    if (result.scene !== undefined) assert.equal(result.complete, false)
  })
})


test('managed source.revoke invalidates a scene continuation and a new read hides the member', async () => {
  await withHarness(() => createHarness(seedSceneManagedRevoke), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    const first = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    assert.ok(first.cursor, 'the sixteen-member scene must expose a continuation')
    const revoked = await callRpc(harness.service, MANAGE, { request: { projectKey: harness.project.key,
      operation: 'source.revoke', payload: { sourceId: harness.data.managedRevokeSource } } })
    assert.equal(revoked.data?.revoked, true)
    let old = await read({ version: 1, action: 'continue', readId: started.readId, cursor: first.cursor })
    let oldTarget
    let continuations = 0
    while (true) {
      oldTarget = old.scene?.items.find((item) => item.name === 'managed-revoke-scene') ?? oldTarget
      if (old.cursor === undefined) break
      assert.ok(continuations < 16)
      old = await read({ version: 1, action: 'continue', readId: started.readId, cursor: old.cursor })
      continuations += 1
    }
    if (oldTarget !== undefined) {
      assert.notEqual(oldTarget.state, 'visible')
      assert.equal(oldTarget.summary, undefined)
    } else {
      assert.equal(old.status, 'stale')
    }
    await read({ version: 1, action: 'close', readId: started.readId })
    const { started: fresh } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let current = await read({ version: 1, action: 'scene', readId: fresh.readId, projectKey: harness.project.key })
    let freshTarget
    let freshContinuations = 0
    while (true) {
      freshTarget = current.scene?.items.find((item) => item.name === 'managed-revoke-scene') ?? freshTarget
      if (current.cursor === undefined) break
      assert.ok(freshContinuations < 16)
      current = await read({ version: 1, action: 'continue', readId: fresh.readId, cursor: current.cursor })
      freshContinuations += 1
    }
    assert.ok(freshTarget)
    assert.equal(freshTarget.state, 'hidden')
    assert.equal(freshTarget.summary, undefined)
    assert.equal(freshTarget.summaryComplete, false)
  })
})

test('scene final handoff memo loss drops the constructed summary and releases the read', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedScenePagination), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const first = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    assert.ok(first.cursor)
    const reader = [...harness.runtime.dashboardVisibilityReaders][0]
    assert.ok(reader)
    const originalBeginProofGuard = reader.beginPersonaProofGuard.bind(reader)
    let activeProofGuards = 0
    reader.beginPersonaProofGuard = (proofs) => {
      const release = originalBeginProofGuard(proofs)
      activeProofGuards += 1
      let released = false
      return () => {
        if (released) return
        released = true
        activeProofGuards -= 1
        release()
      }
    }
    const originalSuspend = reader.suspendForRpc.bind(reader)
    let targetSummarySeen = false
    let finalBoundaryReached = false
    reader.suspendForRpc = (beforeHandoff) => {
      assert.equal(activeProofGuards, 0,
        'the scene-only proof reserve is released before the final RPC scope/TTL check')
      const state = harness.runtime.dashboardAggregate.states.get(started.readId)
      const target = state?.sceneState?.items?.find((item) => item.name === 'scene-many')
      if (!finalBoundaryReached && target?.state === 'visible' && typeof target.summary === 'string') {
        targetSummarySeen = true
        finalBoundaryReached = true
        reader.memoProofStateLost = true
      }
      return originalSuspend(beforeHandoff)
    }
    try {
      let dropped = first
      let continuations = 0
      while (dropped.cursor !== undefined && !finalBoundaryReached) {
        assert.ok(continuations < 16)
        dropped = await read({ version: 1, action: 'continue', readId: started.readId, cursor: dropped.cursor })
        continuations += 1
      }
      assert.equal(targetSummarySeen, true)
      assert.equal(finalBoundaryReached, true)
      assert.equal(dropped.scene, undefined)
      assert.equal(dropped.cursor, undefined)
      assert.equal(dropped.complete, false)
      assert.equal(dropped.status, 'budget_exhausted')
      assert.equal(dropped.reason, 'visibility-proof-cache-lost')
    } finally {
      reader.suspendForRpc = originalSuspend
      reader.beginPersonaProofGuard = originalBeginProofGuard
    }
    const stats = harness.runtime.dashboardReadSessions.stats()
    assert.equal(stats.sessions, 0)
    assert.equal(stats.activeCalls, 0)
    assert.equal(harness.runtime.dashboardVisibilityReaders.size, 0)
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 0)
    assert.equal(harness.runtime.dashboardAggregate.states.size, 0)
  })
})

test('scene readDashboard does not hard-truncate the old 100-member helper ceiling', async () => {
  await withHarness(() => createHarness(seedScene101), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const { started } = await startSelectedDashboard(harness.service, harness.project.key, harness.data.captureDate)
    let result = await read({ version: 1, action: 'scene', readId: started.readId, projectKey: harness.project.key })
    let target
    let continuations = 0
    let pages = 0
    let observedItems = 0
    while (true) {
      pages += 1
      observedItems += result.scene?.items.length ?? 0
      target = result.scene?.items.find((item) => item.name === 'scene-101') ?? target
      if (result.cursor === undefined) break
      assert.ok(continuations < 16)
      result = await read({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    if (target !== undefined) {
      assert.notEqual(target.reason, 'scene-members-over-budget',
        'the removed old helper ceiling must not report a 101-member scene as illegally over-budget')
      if (target.state === 'visible') assert.equal(target.memoryCount, 101)
      else assert.ok(['visibility-budget-exhausted', 'scene-members-over-state-budget'].includes(target.reason))
    } else {
      assert.equal(result.status, 'budget_exhausted',
        'no target item is acceptable only as an explicit resource/session budget terminal')
      assert.equal(result.complete, false)
      assert.equal(result.cursor, undefined)
      assert.equal(typeof result.reason, 'string')
      assert.ok(result.reason.length > 0, 'the terminal must expose the real resource reason')
      assert.ok(pages >= 1)
      assert.ok(observedItems >= 0)
    }
  })
})

// ---------------------------------------------------------------------------
// S4-A registered directory labels and active-project membership
// ---------------------------------------------------------------------------

function installDirectorySequence(entries) {
  const probe = opendirSync(os.tmpdir())
  const prototype = Object.getPrototypeOf(probe)
  probe.closeSync()
  const original = prototype.readSync
  let index = 0
  prototype.readSync = function () {
    if (index >= entries.length) return null
    const entry = entries[index]
    index += 1
    return { name: entry.name, isDirectory: () => entry.isDirectory !== false }
  }
  return { restore() { prototype.readSync = original } }
}

function createExtraRuntimeProject(root, key, name) {
  const cwd = path.join(root, 'synthetic-project-cwds', key)
  const store = openProjectStore(root, key, { key, name, cwd })
  store.close()
  return { key, name, cwd }
}

test('registered directory bootstrap returns the stored friendly name without opening a body scope', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const friendly = openProjectStore(harness.root, harness.project.key, { ...harness.project, name: '项目 友好名' })
    friendly.close()
    const directory = await read({ version: 1, action: 'bootstrap' })
    assert.equal(directory.status, 'selection_required')
    assert.equal(directory.complete, true)
    assert.equal(directory.projects.length, 1)
    assert.equal(directory.projects[0].key, harness.project.key)
    assert.equal(directory.projects[0].name, '项目 友好名')
    assert.notEqual(directory.projects[0].name, harness.project.key, 'the key fallback is replaced by the real project name')
    assert.ok(directory.readId)

    const bodyAttempt = await read({ version: 1, action: 'library', readId: directory.readId,
      projectKey: harness.project.key, status: 'approved', limit: 1 })
    assert.equal(bodyAttempt.status, 'stale')
    assert.equal(bodyAttempt.records, undefined, 'a directory listing readId never becomes a body scope')

    const started = await read({ version: 1, action: 'bootstrap', readId: directory.readId,
      projectKeys: [harness.project.key], range: rangeFor(harness.data.captureDate) })
    assert.equal(started.status, 'ok')
    assert.equal(started.projects[0].name, '项目 友好名')
    assert.equal(started.projects[0].key, harness.project.key)
    const closed = await read({ version: 1, action: 'close', readId: started.readId })
    assert.equal(closed.status, 'ok')
  })
})

test('registered directory bootstrap reports a truthful complete empty selection', async () => {
  await withHarness(() => createRuntimeRpcHarness(undefined), async (harness) => {
    const directory = await callRpc(harness.remote, READ_DASHBOARD, { request: { version: 1, action: 'bootstrap' } })
    assert.equal(directory.status, 'selection_required')
    assert.equal(directory.complete, true)
    assert.deepEqual(directory.projects, [])
    assert.equal(directory.readId, undefined)
    assert.equal(directory.activeProjectKey, undefined)
    assert.equal(harness.runtime.dashboardReadSessions.stats().sessions, 0)
    assert.equal(harness.runtime.dashboardAggregate.directoryStates.size, 0)
  })
})

test('registered directory pages prove the active project only on its enumerated page and ignore a forged focus', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture, { recall: { enabled: true } }), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const extras = [
      createExtraRuntimeProject(harness.root, 'rpc-directory-extra-1', 'Extra one'),
      createExtraRuntimeProject(harness.root, 'rpc-directory-extra-2', 'Extra two'),
      createExtraRuntimeProject(harness.root, 'rpc-directory-extra-3', 'Extra three'),
      createExtraRuntimeProject(harness.root, 'rpc-directory-extra-4', 'Extra four'),
      createExtraRuntimeProject(harness.root, 'rpc-directory-extra-5', 'Extra five'),
    ]
    const selectedProjects = extras.slice(0, 4)
    for (const [index, project] of selectedProjects.entries()) {
      const store = openProjectStore(harness.root, project.key, project)
      try {
        const sourceId = store.recordL0({ sessionId: `four-project-session-${index}`, role: 'user',
          content: `Synthetic four-project proof source ${index}.`, createdAt: Date.now() })
        store.addMemory({ content: `Synthetic four-project candidate ${index}.`, kind: 'fact', confidence: 0.8,
          status: 'candidate', sourceMessageIds: [sourceId], sourceVerified: true })
        store.addMemory({ content: `Synthetic four-project approved ${index}.`, kind: 'fact', confidence: 0.8,
          status: 'approved', sourceMessageIds: [sourceId], sourceVerified: true })
      } finally { store.close() }
    }
    const ordered = [...extras.map((project) => project.key), harness.project.key]
    const sequence = installDirectorySequence(ordered.map((name) => ({ name })))
    try {
      const hits = harness.runtime.recall(harness.projectCwd, 'synthetic active project question', 'rpc-active-session')
      assert.ok(Array.isArray(hits))
      assert.equal(harness.runtime.activeProjectKey, harness.project.key,
        'the trusted runtime active-project source is the selected project')
      const first = await read({ version: 1, action: 'bootstrap', focusProjectKey: harness.project.key })
      assert.equal(first.status, 'partial')
      assert.equal(first.complete, false)
      assert.equal(first.projects.length, 4)
      assert.equal(first.activeProjectKey, undefined,
        'the request focus hint is not member proof and page one must not expose the unenumerated active project')
      assert.ok(first.cursor)
      const forged = await read({ version: 1, action: 'continue', readId: first.readId, cursor: randomUUID() })
      assert.equal(forged.status, 'stale')
      assert.equal(forged.reason, 'cursor-invalid-or-consumed')
      const second = await read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
      assert.equal(second.status, 'selection_required')
      assert.equal(second.complete, true)
      const active = second.projects.find((project) => project.key === harness.project.key)
      assert.ok(active, 'the second page enumerates the active project')
      assert.equal(active.name, harness.project.name)
      assert.equal(second.activeProjectKey, harness.project.key,
        'the hint appears only after this page proved the enumerated member')
      assert.equal((await read({ version: 1, action: 'close', readId: second.readId })).status, 'ok')
    } finally {
      sequence.restore()
    }

    const fourProjectRead = await read({ version: 1, action: 'bootstrap',
      projectKeys: selectedProjects.map((project) => project.key), range: rangeFor(harness.data.captureDate) })
    assert.equal(fourProjectRead.status, 'ok')
    assert.equal(fourProjectRead.projects.length, 4)
    const observeBudget = (reader) => {
      const diagnostics = { handoffs: [], finalBoundaries: [], resumes: [], leaseCount: 0,
        leasePayloadBytes: 0, leaseOverheadBytes: 0, peakSessionBytes: 0, peakGlobalBytes: 0, outputEnvelopes: 0 }
      const restorers = []
      const observe = (callback) => {
        try { callback() } catch (error) { diagnostics.observerFailure ??= String(error).slice(0, 512) }
      }
      for (const method of ['personaReserveStatus', 'suspendForRpc', 'resumeForRpc']) {
        const descriptor = Object.getOwnPropertyDescriptor(reader, method)
        const original = reader[method]
        Object.defineProperty(reader, method, { configurable: true, writable: true,
          enumerable: descriptor?.enumerable ?? false, value: function (...args) {
            if (method === 'suspendForRpc') observe(() => {
              const counters = this.manager.counters(this.callToken)
              if (diagnostics.handoffs.length < 4 && counters.status === 'ok') diagnostics.handoffs.push(counters.value)
            })
            const result = Reflect.apply(original, this, args)
            observe(() => {
              if (method === 'personaReserveStatus' && !result.ok) {
                const name = result.reason === 'persona-session-headroom' ? 'firstSession' : 'firstCall'
                if (diagnostics[name] === undefined) diagnostics[name] = { reason: result.reason,
                  phase: this.activeManagedPageItem?.key?.slice(0, 240), cost: { ...args[0] },
                  reserve: this.personaReserveCost(args[1], args[2]), remaining: this.remainingReadWorkBreakdown() }
              } else if (method === 'resumeForRpc' && result.status === 'ok') {
                const counters = this.manager.counters(this.callToken)
                if (diagnostics.resumes.length < 4 && counters.status === 'ok') diagnostics.resumes.push(counters.value)
              } else if (method === 'resumeForRpc' && result.status !== 'ok' && diagnostics.firstResume === undefined) {
                diagnostics.firstResume = { status: result.status, reason: result.reason }
              }
            })
            return result
          } })
        restorers.push(() => {
          if (descriptor === undefined) delete reader[method]
          else Object.defineProperty(reader, method, descriptor)
        })
      }
      // Observe the real manager after the final probes and around every
      // resident allocation; forwarding preserves its arguments, result and errors.
      for (const method of ['finish', 'reserveResident']) {
        const manager = reader.manager
        const descriptor = Object.getOwnPropertyDescriptor(manager, method)
        const original = manager[method]
        Object.defineProperty(manager, method, { configurable: true, writable: true,
          enumerable: descriptor?.enumerable ?? false, value: function (...args) {
            let before
            if (args[0] === reader.callToken) observe(() => {
              const counters = this.counters(args[0])
              if (counters.status === 'ok') {
                before = counters.value
                if (method === 'finish' && diagnostics.finalBoundaries.length < 4) diagnostics.finalBoundaries.push(before)
              }
            })
            const result = Reflect.apply(original, this, args)
            if (method === 'reserveResident' && before !== undefined && result.status === 'ok') observe(() => {
              const current = this.counters(args[0])
              assert.equal(current.status, 'ok')
              const after = current.value
              assert.equal(after.sessionAccountedBytes - before.sessionAccountedBytes, args[2] + 64,
                'each lease pays its own metadata, including replacement overlap')
              diagnostics.leaseCount += 1
              diagnostics.leasePayloadBytes += args[2]
              diagnostics.leaseOverheadBytes += 64
              diagnostics.peakSessionBytes = Math.max(diagnostics.peakSessionBytes, after.sessionAccountedBytes)
              diagnostics.peakGlobalBytes = Math.max(diagnostics.peakGlobalBytes, after.accountedBytes)
              if (args[1] === 'cache' && args[2] === 256 * 1024) diagnostics.outputEnvelopes += 1
            })
            return result
          } })
        restorers.push(() => {
          if (descriptor === undefined) delete manager[method]
          else Object.defineProperty(manager, method, descriptor)
        })
      }
      return { diagnostics, restore() { for (const restore of restorers.reverse()) restore() } }
    }
    const overviewState = harness.runtime.dashboardAggregate.states.get(fourProjectRead.readId)
    assert.ok(overviewState && harness.runtime.dashboardVisibilityReaders.has(overviewState.reader))
    const budgetObserver = observeBudget(overviewState.reader)
    let fourProjectOverview
    try { fourProjectOverview = await finishOverview(harness.remote, fourProjectRead.readId) }
    finally { budgetObserver.restore() }
    assert.equal(budgetObserver.diagnostics.observerFailure, undefined)
    assert.equal(fourProjectOverview.result.status, 'ok', 'four-project default64: ' +
      JSON.stringify({ reason: fourProjectOverview.result.reason, continuations: fourProjectOverview.continuations,
        ...budgetObserver.diagnostics }))
    assert.equal(fourProjectOverview.result.complete, true,
      'the default four-project RPC scan completes every overview task within its existing continuation limit')
    assert.ok(fourProjectOverview.continuations < 16)
    assert.ok(fourProjectOverview.continuations <= 2, 'bootstrap plus at most three full overview calls fit sixteen project visits')
    const ledger = budgetObserver.diagnostics
    assert.equal(ledger.finalBoundaries.length, fourProjectOverview.continuations + 1)
    assert.equal(ledger.outputEnvelopes, ledger.finalBoundaries.length, 'every published RPC pays its unchanged 256 KiB envelope')
    assert.equal(ledger.leaseOverheadBytes, ledger.leaseCount * 64)
    assert.ok(ledger.peakSessionBytes <= 4 * 1024 * 1024)
    assert.ok(ledger.peakGlobalBytes <= 8 * 1024 * 1024)
    assert.equal(ledger.resumes[0].session.projects, 8, 'the first resume includes four bootstrap and four current visits')
    for (const snapshot of ledger.finalBoundaries) {
      assert.equal(snapshot.call.projects, 4)
      assert.ok(snapshot.call.sqlStatements <= 64 && snapshot.session.sqlStatements <= 512)
      assert.ok(snapshot.call.materializedBytes <= 1024 * 1024 && snapshot.session.materializedBytes <= 8 * 1024 * 1024)
      assert.ok(snapshot.call.rowsVisited <= 2048 && snapshot.session.rowsVisited <= 32768)
      assert.ok(snapshot.call.keyBytes <= 64 * 1024 && snapshot.session.keyBytes <= 256 * 1024)
      assert.ok(snapshot.session.projects <= 16 && snapshot.session.continuations <= 16)
    }
    assert.equal(fourProjectOverview.result.metrics.effectiveMemories.value, 4)
    assert.equal(fourProjectOverview.result.metrics.candidates.value, 4)
    assert.equal(fourProjectOverview.result.page.projects.length, 4)
    for (const project of fourProjectOverview.result.page.projects) {
      assert.equal(project.approved.value, 1)
      assert.equal(project.candidates.value, 1)
      assert.equal(project.memories.value, 2)
    }
    const selectedKeys = selectedProjects.map((project) => project.key).sort()
    assert.equal(fourProjectOverview.result.page.candidates.length, 4)
    assert.equal(fourProjectOverview.result.page.recent.length, 4)
    assert.deepEqual(fourProjectOverview.result.page.candidates.map((item) => item.projectKey).sort(), selectedKeys)
    assert.deepEqual(fourProjectOverview.result.page.recent.map((item) => item.projectKey).sort(), selectedKeys)
  })
})

test('registered RPC rejects forged directory fields and never turns a listing readId into a body scope', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const codec = descriptorOf(READ_DASHBOARD).parameters[0].codec.create()
    assert.throws(() => codec.parse({ version: 1, action: 'bootstrap', enumeratedKeys: [harness.project.key] }))
    assert.throws(() => codec.parse({ version: 1, action: 'continue', readId: randomUUID(), cursor: randomUUID(), memberLabels: [] }))
    const directory = await read({ version: 1, action: 'bootstrap' })
    assert.ok(directory.readId)
    const attempts = [
      { version: 1, action: 'library', readId: directory.readId, projectKey: harness.project.key, status: 'approved', limit: 1 },
      { version: 1, action: 'detail', readId: directory.readId, projectKey: harness.project.key,
        target: { kind: 'memory', status: 'approved', id: 'synthetic-memory' } },
      { version: 1, action: 'persona', readId: directory.readId, projectKey: harness.project.key },
      { version: 1, action: 'scene', readId: directory.readId, projectKey: harness.project.key },
    ]
    for (const attempt of attempts) {
      const refused = await read(attempt)
      assert.equal(refused.status, 'stale', attempt.action)
      assert.equal(refused.complete, false, attempt.action)
      assert.equal(refused.records, undefined, attempt.action)
      assert.equal(refused.record, undefined, attempt.action)
      assert.equal(refused.persona, undefined, attempt.action)
      assert.equal(refused.scene, undefined, attempt.action)
    }
  })
})

// ---------------------------------------------------------------------------
// S4-A turn1 repair: real runtime connection identity and ownership
// ---------------------------------------------------------------------------

function replaceRuntimeProjectDirectory(root, key, name) {
  const projects = path.join(root, 'projects')
  const retired = path.join(root, `retired-${key}`)
  renameSync(path.join(projects, key), retired)
  const store = openProjectStore(root, key, { key, name, cwd: path.join(root, 'replacement-cwds', key) })
  store.close()
  return { retired, name }
}

test('registered directory readers share one read-only member cache and release it only on the last close', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const key = harness.project.key
    const first = await read({ version: 1, action: 'bootstrap' })
    const second = await read({ version: 1, action: 'bootstrap' })
    assert.ok(first.readId)
    assert.ok(second.readId)
    assert.equal(first.projects[0].name, harness.project.name)
    assert.equal(second.projects[0].name, harness.project.name)
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 1)
    let entry = harness.runtime.dashboardReadOnlyStores.get(key)
    assert.ok(entry)
    assert.equal(entry.references, 2)
    const shared = entry.store
    assert.equal(shared.projectMeta().name, harness.project.name)

    assert.equal((await read({ version: 1, action: 'close', readId: first.readId })).status, 'ok')
    entry = harness.runtime.dashboardReadOnlyStores.get(key)
    assert.ok(entry, 'the second reader still owns the connection')
    assert.equal(entry.references, 1)
    assert.equal(shared.projectMeta().name, harness.project.name, 'the surviving reader can still read the shared connection')

    const third = await read({ version: 1, action: 'bootstrap' })
    assert.equal(third.status, 'selection_required')
    assert.equal(third.projects[0].name, harness.project.name)
    entry = harness.runtime.dashboardReadOnlyStores.get(key)
    assert.equal(entry.references, 2, 'the new reader reuses the same proven connection')

    // The surviving second reader opens a legitimate body scope on the same
    // shared connection and actually reads through it.
    const body = await read({ version: 1, action: 'bootstrap', readId: second.readId,
      projectKeys: [key], range: rangeFor(harness.data.captureDate) })
    assert.equal(body.status, 'ok')
    const library = await read({ version: 1, action: 'library', readId: body.readId, projectKey: key,
      status: 'approved', limit: 1 })
    assert.equal(library.status, 'ok')
    assert.equal((await read({ version: 1, action: 'close', readId: body.readId })).status, 'ok')
    assert.equal(harness.runtime.dashboardReadOnlyStores.get(key).references, 1)
    assert.equal((await read({ version: 1, action: 'close', readId: third.readId })).status, 'ok')
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 0)
  })
})

test('registered directory labels reuse the runtime writer connection without closing it', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture, { recall: { enabled: true } }), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const key = harness.project.key
    const hits = harness.runtime.recall(harness.projectCwd, 'synthetic writer reuse', 'writer-reuse')
    assert.ok(Array.isArray(hits))
    const writer = harness.runtime.stores.get(key)
    assert.ok(writer)
    assert.equal(writer.projectMeta().name, harness.project.name)
    const directory = await read({ version: 1, action: 'bootstrap' })
    assert.equal(directory.status, 'selection_required')
    assert.equal(directory.projects[0].name, harness.project.name)
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 0, 'the writer connection is reused for the label')
    assert.equal((await read({ version: 1, action: 'close', readId: directory.readId })).status, 'ok')
    assert.equal(harness.runtime.stores.get(key), writer)
    assert.equal(writer.projectMeta().name, harness.project.name, 'the directory reader never closed the runtime writer')
    const started = await read({ version: 1, action: 'bootstrap', projectKeys: [key],
      range: rangeFor(harness.data.captureDate) })
    assert.equal(started.status, 'ok', 'the writer connection remains readable after the directory reader closed')
    assert.equal(started.projects[0].name, harness.project.name)
    assert.equal((await read({ version: 1, action: 'close', readId: started.readId })).status, 'ok')
  })
})

test('registered directory labels never prove a replaced directory under the cached writer connection', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture, { recall: { enabled: true } }), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const key = harness.project.key
    const oldName = harness.project.name
    harness.runtime.recall(harness.projectCwd, 'synthetic activation', 'identity-writer')
    const writer = harness.runtime.stores.get(key)
    assert.ok(writer)
    assert.equal(writer.projectMeta().name, oldName)
    replaceRuntimeProjectDirectory(harness.root, key, 'Replacement writer identity')
    const directory = await read({ version: 1, action: 'bootstrap' })
    assert.equal(directory.status, 'selection_required')
    assert.equal(directory.projects.length, 1)
    assert.equal(directory.projects[0].key, key)
    assert.equal(directory.projects[0].name, 'Replacement writer identity')
    assert.notEqual(directory.projects[0].name, oldName,
      'the cached writer connection is never published as proof of the replacement file')
    assert.equal(harness.runtime.stores.get(key), writer, 'the runtime writer remains registered')
    assert.equal(writer.projectMeta().name, oldName, 'the old writer connection was neither reused nor closed')
    assert.equal((await read({ version: 1, action: 'close', readId: directory.readId })).status, 'ok')
    assert.equal(writer.projectMeta().name, oldName)
  })
})

test('registered directory labels keep a stale shared read-only connection for its readers and prove the replacement file independently', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const key = harness.project.key
    const oldName = harness.project.name
    const first = await read({ version: 1, action: 'bootstrap' })
    const second = await read({ version: 1, action: 'bootstrap' })
    assert.ok(first.readId)
    assert.ok(second.readId)
    assert.equal(first.projects[0].name, oldName)
    let entry = harness.runtime.dashboardReadOnlyStores.get(key)
    assert.ok(entry)
    assert.equal(entry.references, 2)
    const shared = entry.store
    replaceRuntimeProjectDirectory(harness.root, key, 'Replacement read-only identity')
    assert.equal((await read({ version: 1, action: 'close', readId: first.readId })).status, 'ok')
    const third = await read({ version: 1, action: 'bootstrap' })
    assert.equal(third.status, 'selection_required')
    assert.equal(third.projects[0].name, 'Replacement read-only identity')
    assert.notEqual(third.projects[0].name, oldName)
    entry = harness.runtime.dashboardReadOnlyStores.get(key)
    assert.ok(entry, 'the pre-replacement shared connection remains while its surviving reader is active')
    assert.equal(entry.store, shared)
    assert.equal(entry.references, 1, 'closing one old reader leaves the other reader on its original connection')
    assert.equal(shared.projectMeta().name, oldName, 'the shared connection still reads its own original file')
    assert.equal((await read({ version: 1, action: 'close', readId: third.readId })).status, 'ok')
    entry = harness.runtime.dashboardReadOnlyStores.get(key)
    assert.ok(entry)
    assert.equal(entry.references, 1)
    assert.equal(shared.projectMeta().name, oldName)
    assert.equal((await read({ version: 1, action: 'close', readId: second.readId })).status, 'ok')
    assert.equal(harness.runtime.dashboardReadOnlyStores.size, 0)
  })
})

test('plugin.apply directory labels continue on one readId and then open a legitimate body selection', async () => {
  const extras = [
    ['plugin-extra-1', 'Plugin extra one'],
    ['plugin-extra-2', 'Plugin extra two'],
    ['plugin-extra-3', 'Plugin extra three'],
    ['plugin-extra-4', 'Plugin extra four'],
    ['plugin-extra-5', 'Plugin extra five'],
  ]
  await withHarness(() => createHarness(seedDashboardFixture, (root, project) => {
    const friendly = openProjectStore(root, project.key, { ...project, name: 'Plugin 友好名' })
    friendly.close()
    for (const [key, name] of extras) {
      const store = openProjectStore(root, key, { key, name, cwd: path.join(root, 'synthetic-plugin-cwds', key) })
      store.close()
    }
  }), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const first = await read({ version: 1, action: 'bootstrap' })
    assert.equal(first.status, 'partial')
    assert.equal(first.complete, false)
    assert.equal(first.projects.length, 4)
    assert.ok(first.readId)
    assert.ok(first.cursor)
    const second = await read({ version: 1, action: 'continue', readId: first.readId, cursor: first.cursor })
    assert.equal(second.readId, first.readId, 'the plugin directory continuation keeps the same readId')
    assert.equal(second.complete, true)
    const names = new Map([...first.projects, ...second.projects].map((project) => [project.key, project.name]))
    assert.equal(names.get(harness.project.key), 'Plugin 友好名')
    assert.ok([...names.values()].every((name) => typeof name === 'string' && name.length > 0))
    const started = await read({ version: 1, action: 'bootstrap', readId: first.readId,
      projectKeys: [harness.project.key], range: rangeFor(harness.data.captureDate) })
    assert.equal(started.status, 'ok', 'a legitimate body selection follows the directory listing')
    assert.equal(started.projects[0].key, harness.project.key)
    assert.equal(started.projects[0].name, 'Plugin 友好名')
    const closed = await read({ version: 1, action: 'close', readId: started.readId })
    assert.equal(closed.status, 'ok')
  })
})

test('registered bounded overview counts a real forgotten row with an independent cursor', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    const read = (request) => callRpc(harness.remote, READ_DASHBOARD, { request })
    const bootstrap = await read({ version: 1, action: 'bootstrap', projectKeys: [harness.project.key],
      range: rangeFor(harness.data.captureDate) })
    const readId = bootstrap.readId
    let page = await read({ version: 1, action: 'overview', readId })
    let continuations = 0
    while (page.cursor !== undefined && !page.complete && continuations < 16) {
      page = await read({ version: 1, action: 'continue', readId, cursor: page.cursor })
      continuations += 1
    }
    assert.equal(page.complete, true)
    const project = page.page.projects[0]
    assert.equal(project.forgotten.value, 1)
    assert.equal(project.forgotten.relation, 'exact')
    assert.equal(project.approved.value, 2)
    assert.equal(project.candidates.value, 2)
    assert.equal(page.metrics.effectiveMemories.value, 2, 'the forgotten row never merges into approved counts')
    assert.equal(page.metrics.candidates.value, 2)
  })
})

function seedRepeatedRpc(store) {
  const data = seedDashboardFixture(store)
  const now = Date.now()
  const captureDate = utcDate(now)
  const alpha = []
  for (const offset of [0, 1_000, 2_000]) {
    alpha.push(store.recordL0({ sessionId: 'rpc-repeat-alpha', role: 'user',
      content: 'Synthetic RPC repeated alpha question.', createdAt: now + offset, recordedAt: now + offset,
      sourceEventId: `rpc-repeat-alpha-${offset}`, agentPreset: 'rpc-repeat-agent', origin: 'rpc-repeat-source' }))
  }
  const beta = store.recordL0({ sessionId: 'rpc-repeat-beta', role: 'user',
    content: 'Synthetic RPC repeated beta question.', createdAt: now + 3_000, recordedAt: now + 3_000,
    sourceEventId: 'rpc-repeat-beta-1', agentPreset: 'rpc-repeat-other', origin: 'rpc-repeat-other' })
  const betaExtraEventId = 'rpc-repeat-beta-extra'
  store.appendEvent({ eventId: `capture:${betaExtraEventId}`, type: 'capture', sourceId: beta,
    sessionId: 'rpc-repeat-beta', source: 'rpc-repeat-other', agentPreset: 'rpc-repeat-other',
    occurredAt: now + 3_500, count: 1 }, now + 3_500)
  store.appendEvent({ eventId: `capture:${beta}`, type: 'capture', sourceId: beta,
    sessionId: 'rpc-repeat-beta', source: 'rpc-repeat-other', agentPreset: 'rpc-repeat-other',
    occurredAt: now + 3_750, count: 1 }, now + 3_750)
  const betaSecond = store.recordL0({ sessionId: 'rpc-repeat-beta', role: 'user',
    content: 'Synthetic RPC repeated beta question.', createdAt: now + 4_000, recordedAt: now + 4_000,
    sourceEventId: 'rpc-repeat-beta-2', agentPreset: 'rpc-repeat-other', origin: 'rpc-repeat-other' })
  const missingLinked = store.recordL0({ sessionId: 'rpc-repeat-missing-link', role: 'user',
    content: 'Synthetic RPC capture without a linked host event ID.', createdAt: now + 5_000, recordedAt: now + 5_000 })
  const localControl = store.recordL0({ sessionId: 'rpc-repeat-local-control', role: 'user',
    content: 'Synthetic RPC local capture positive control.', createdAt: now + 6_000, recordedAt: now + 6_000 })
  const fingerprintOf = (id) => store.db.prepare('SELECT fingerprint FROM l0_messages WHERE id = ?').get(id).fingerprint
  return { ...data, captureDate, alpha, beta, betaSecond, betaExtraEventId, betaCollisionSourceEventId: beta,
    missingLinked, localControl,
    alphaFingerprint: fingerprintOf(alpha[0]), betaFingerprint: fingerprintOf(beta),
    missingLinkedFingerprint: fingerprintOf(missingLinked), localControlFingerprint: fingerprintOf(localControl) }
}

async function collectRepeatedRpcEvents(service, readId, request, target) {
  let result = await request({ version: 1, action: 'repeated', readId, target: { kind: 'events', ...target } })
  const events = [...(result.repeated?.events ?? [])]
  let steps = 0
  while (result.cursor !== undefined && steps < 8) {
    result = await request({ version: 1, action: 'continue', readId, cursor: result.cursor })
    events.push(...(result.repeated?.events ?? []))
    steps += 1
  }
  return { result, events }
}

async function collectRepeatedRpcGroups(readId, request, target) {
  let result = await request({ version: 1, action: 'repeated', readId, target: { kind: 'groups', ...target } })
  const groups = [...(result.repeated?.groups ?? [])]
  let steps = 0
  while (result.cursor !== undefined && steps < 8) {
    result = await request({ version: 1, action: 'continue', readId, cursor: result.cursor })
    groups.push(...(result.repeated?.groups ?? []))
    steps += 1
  }
  return { result, groups, steps }
}

test('registered readDashboard repeated RPC publishes a stable ranking and opt-in excerpts from the real Store', async () => {
  await withHarness(() => createHarness(seedRepeatedRpc, (root, project, data) => {
    const control = new ControlLedger(root)
    try {
      control.revokeSourceEvent(project.key, data.betaExtraEventId)
      control.revokeSourceEvent(project.key, data.betaCollisionSourceEventId)
      control.revokeSourceEvent(project.key, data.missingLinked)
    } finally { control.close() }
  }), async (harness) => {
    const started = await startDirectDashboard(harness.service, harness.project.key, harness.data.captureDate)
    const request = (payload) => callRpc(harness.service, READ_DASHBOARD, { request: payload })
    let result = await request({ version: 1, action: 'repeated', readId: started.readId,
      target: { kind: 'groups', projectKeys: [harness.project.key], limit: 1 } })
    let scanSteps = 0
    while (result.status === 'budget_exhausted' && result.cursor !== undefined && scanSteps < 8) {
      result = await request({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      scanSteps += 1
    }
    assert.equal(result.status, 'ok')
    assert.equal(result.view, 'repeated')
    assert.equal(result.repeated.target, 'groups')
    assert.equal(result.repeated.complete, true)
    assert.equal(result.repeated.hasMore, true)
    const firstPage = result.repeated.groups
    assert.equal(firstPage.length, 1)
    assert.equal(firstPage[0].fingerprint, harness.data.alphaFingerprint)
    assert.equal(firstPage[0].repeatCount, 2, 'three capture events publish repeatCount 2 through the wire codec')
    const collected = [...firstPage]
    let steps = 0
    while (result.cursor !== undefined && steps < 8) {
      result = await request({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      assert.equal(result.status, 'ok')
      collected.push(...(result.repeated.groups ?? []))
      steps += 1
    }
    assert.equal(collected.length, 2)
    assert.equal(new Set(collected.map((group) => group.fingerprint)).size, 2, 'ranking pages never repeat a group')
    assert.equal(collected[1].fingerprint, harness.data.betaFingerprint)
    assert.equal(collected[1].repeatCount, 1)
    const betaGroup = collected.find((group) => group.fingerprint === harness.data.betaFingerprint)
    assert.ok(betaGroup)
    assert.equal(betaGroup.repeatCount, 1,
      'the revoked same-L0 beta event is not counted through the L0 Host identity')
    const bareResult = await collectRepeatedRpcEvents(harness.service, started.readId, request,
      { projectKey: harness.project.key, fingerprint: harness.data.alphaFingerprint, includeExcerpt: false, limit: 15 })
    const bare = bareResult.events
    assert.equal(bare.length, 3)
    assert.equal(bare.every((event) => event.type === 'capture' && event.sourceId !== undefined), true)
    assert.equal(bare.every((event) => event.excerpt === undefined), true, 'the wire codec never invents an excerpt')
    const excerptResult = await collectRepeatedRpcEvents(harness.service, started.readId, request,
      { projectKey: harness.project.key, fingerprint: harness.data.alphaFingerprint, includeExcerpt: true, limit: 15 })
    const excerpts = excerptResult.events
    assert.equal(excerpts.length, 3)
    assert.equal(excerpts.every((event) => event.excerpt === 'Synthetic RPC repeated alpha question.'), true)
    assert.equal(excerpts.every((event) => event.excerptTruncated === false), true)
    const betaEvents = await collectRepeatedRpcEvents(harness.service, started.readId, request,
      { projectKey: harness.project.key, fingerprint: harness.data.betaFingerprint, includeExcerpt: false, limit: 15 })
    assert.equal(betaEvents.result.status, 'ok')
    assert.equal(betaEvents.result.repeated.complete, true)
    assert.equal(betaEvents.events.length, 2)
    assert.equal(betaEvents.events.some((event) => event.eventId === 'capture:rpc-repeat-beta-extra'), false,
      'the individually revoked same-L0 event is absent from the RPC detail page')
    assert.equal(betaEvents.events.some((event) => event.eventId === `capture:${harness.data.beta}`), false,
      'a direct event ID colliding with the L0 row ID still honors its independent revoke fence')
    assert.deepEqual(betaEvents.events.map((event) => event.eventId).sort(),
      ['capture:rpc-repeat-beta-1', 'capture:rpc-repeat-beta-2'],
      'the linked event identities remain visible as the independent control')
    const missingLinkEvents = await collectRepeatedRpcEvents(harness.service, started.readId, request,
      { projectKey: harness.project.key, fingerprint: harness.data.missingLinkedFingerprint, includeExcerpt: false, limit: 15 })
    assert.equal(missingLinkEvents.result.status, 'ok')
    assert.equal(missingLinkEvents.result.repeated.complete, true)
    assert.equal(missingLinkEvents.events.length, 0,
      'a direct event collision is revoked even when the linked L0 has no host event ID')
    const localEvents = await collectRepeatedRpcEvents(harness.service, started.readId, request,
      { projectKey: harness.project.key, fingerprint: harness.data.localControlFingerprint, includeExcerpt: false, limit: 15 })
    assert.equal(localEvents.result.status, 'ok')
    assert.equal(localEvents.result.repeated.complete, true)
    assert.equal(localEvents.events.length, 1, 'a real local capture with no external event ID remains boundedly readable')
    assert.equal(localEvents.events[0].sourceId, harness.data.localControl)
    assert.equal(localEvents.events[0].eventId, `capture:${harness.data.localControl}`)
    const filtered = await collectRepeatedRpcGroups(started.readId, request, {
      projectKeys: [harness.project.key],
      filters: { agentPreset: 'rpc-repeat-agent', source: 'rpc-repeat-source' },
    })
    assert.equal(filtered.result.status, 'ok',
      'filtered group scan ended ' + filtered.result.status + '/' + (filtered.result.reason ?? 'no reason') +
      ' after ' + filtered.steps + ' continuations')
    assert.equal(filtered.result.repeated.complete, true)
    assert.equal(filtered.groups.length, 1)
    assert.equal(filtered.groups[0].fingerprint, harness.data.alphaFingerprint)
    const close = await request({ version: 1, action: 'close', readId: started.readId })
    assert.equal(close.status, 'ok')

    const mismatchRead = await startDirectDashboard(harness.service, harness.project.key, harness.data.captureDate)
    const mismatch = await collectRepeatedRpcGroups(mismatchRead.readId, request, {
      projectKeys: [harness.project.key],
      filters: { agentPreset: 'rpc-repeat-agent', source: 'rpc-repeat-other' },
    })
    assert.equal(mismatch.result.status, 'ok',
      'mismatched group scan ended ' + mismatch.result.status + '/' + (mismatch.result.reason ?? 'no reason') +
      ' after ' + mismatch.steps + ' continuations')
    assert.equal(mismatch.result.repeated.complete, true)
    assert.equal(mismatch.groups.length, 0, 'combined filters intersect on the same event')
    const mismatchClose = await request({ version: 1, action: 'close', readId: mismatchRead.readId })
    assert.equal(mismatchClose.status, 'ok')
  })
})

function seedSessionsRpc(store) {
  const now = Date.now()
  const captureDate = utcDate(now)
  const identity = (digest) => ({ schema: 'memory-tdai/original-message/v1', algorithm: 'sha256', digest })
  for (let index = 0; index < 2; index += 1) {
    store.recordL0({ sessionId: 'rpc-session-two', role: 'user', content: `Synthetic RPC session two ${index}.`,
      createdAt: now + index, recordedAt: now + index, sourceEventId: `rpc-session-two-${index}`,
      originalMessageIdentity: identity(`${index}`.padStart(64, '2')) })
  }
  const one = store.recordL0({ sessionId: 'rpc-session-one', role: 'user', content: 'Synthetic RPC session one origin.',
    createdAt: now + 10, recordedAt: now + 10, sourceEventId: 'rpc-session-one-origin' })
  store.appendEvent({ eventId: 'capture:rpc-session-one-extra-1', type: 'capture', sourceId: one,
    sessionId: 'rpc-session-one', source: 'rpc-session', occurredAt: now + 11, count: 1 }, now + 11)
  store.appendEvent({ eventId: 'capture:rpc-session-one-extra-2', type: 'capture', sourceId: one,
    sessionId: 'rpc-session-one', source: 'rpc-session', occurredAt: now + 12, count: 1 }, now + 12)
  const revokedEventId = 'rpc-session-one-revoked'
  store.appendEvent({ eventId: `capture:${revokedEventId}`, type: 'capture', sourceId: one,
    sessionId: 'rpc-session-one', source: 'rpc-session', occurredAt: now + 13, count: 1 }, now + 13)
  for (let index = 0; index < 18; index += 1) {
    store.recordL0({ sessionId: 'rpc-session-many', role: 'user', content: `Synthetic RPC session many ${index}.`,
      createdAt: now + 20 + index, recordedAt: now + 20 + index, sourceEventId: `rpc-session-many-${index}` })
  }
  store.appendEvent({ eventId: 'capture:rpc-no-session', type: 'capture', sessionId: undefined,
    source: 'rpc-session', occurredAt: now + 50, count: 1 }, now + 50)
  return { captureDate, revokedEventId }
}

test('registered readDashboard overview publishes project-scoped linked-L0 sessions across real continuations', async () => {
  await withHarness(() => createHarness(seedSessionsRpc, (root, project, data) => {
    const control = new ControlLedger(root)
    try { control.revokeSourceEvent(project.key, data.revokedEventId) } finally { control.close() }
  }), async (harness) => {
    const started = await startDirectDashboard(harness.service, harness.project.key, harness.data.captureDate)
    const request = (payload) => callRpc(harness.service, READ_DASHBOARD, { request: payload })
    let result = await request({ version: 1, action: 'overview', readId: started.readId })
    let continuations = 0
    while (result.cursor !== undefined && !result.complete && continuations < 16) {
      result = await request({ version: 1, action: 'continue', readId: started.readId, cursor: result.cursor })
      continuations += 1
    }
    assert.equal(result.status, 'ok')
    assert.ok(continuations > 0, 'the 24-event fixture exercises the real first/continuation page path')
    assert.equal(result.sessions.complete, true)
    assert.equal(result.sessions.scannedEvents, 24)
    assert.equal(result.sessions.scannedSessions, 3)
    assert.equal(result.sessions.unknownSessionEvents, 1)
    assert.deepEqual(result.sessions.items.map((item) => item.sessionId),
      ['rpc-session-many', 'rpc-session-two', 'rpc-session-one'])
    assert.equal(result.sessions.items[0].linkedL0Messages, 18)
    assert.equal(result.sessions.items[0].events, 18)
    assert.equal(result.sessions.items[1].linkedL0Messages, 2)
    assert.equal(result.sessions.items[1].events, 2)
    assert.equal(result.sessions.items[2].linkedL0Messages, 1)
    assert.equal(result.sessions.items[2].events, 3,
      'three capture events on one L0 rank below the two-linked-L0 session')
    assert.equal(result.sessions.items.every((item) => item.projectKey === harness.project.key), true)
    assert.equal(result.sessions.items.every((item) => item.originalMessageCount === null), true)
    assert.equal(result.sessions.items.every((item) => item.linkedL0Complete === true), true)
    const close = await request({ version: 1, action: 'close', readId: started.readId })
    assert.equal(close.status, 'ok')
  })
})


async function u09RuntimeUsage(harness, count = 12) {
  const control = harness.runtime.control
  const now = Date.parse(`${harness.data.captureDate}T12:00:00Z`)
  for (let index = 0; index < count; index += 1) {
    const id = `u09-real-attempt-${String(index).padStart(3, '0')}`
    const provider = index === 0 ? 'a/b' : index === 1 ? 'a' : `provider-${index}`
    const model = index === 0 ? 'c' : index === 1 ? 'b/c' : 'shared-model'
    control.beginAttempt({ id, projectKey: harness.project.key, jobId: `u09-job-${index}`, provider, model, inputHash: 'synthetic', sourceDigest: 'synthetic-u09-source', now })
    control.settleAttempt(id, 'complete', { inputTokens: index, outputTokens: 2, cacheReadTokens: index === 0 ? 0 : 1,
      cacheWriteTokens: 0, reasoningTokens: 1, ...(index === 0 ? {} : { costMicros: 0 }) }, undefined, now)
    const billableId = `u09-real-billable-${String(index).padStart(3, '0')}`
    control.reserveBillableCall({ id: billableId, projectKey: harness.project.key, purpose: `purpose-${index}`,
      budgetClass: 'manual', reservedTokens: 100, dailyTokenLimit: 1_000_000, dailyTaskLimit: 100, now })
    control.settleBillableCall(billableId, 'complete', { inputTokens: index, outputTokens: 2 }, now)
  }
  control.beginAttempt({ id: 'u09-real-foreign', projectKey: 'unselected-project', jobId: 'foreign-u09',
    provider: 'foreign', model: 'foreign', inputHash: 'synthetic', sourceDigest: 'synthetic-u09-source', now })
  control.settleAttempt('u09-real-foreign', 'complete', { inputTokens: 999 }, undefined, now)
  control.beginAttempt({ id: 'u09-real-old', projectKey: harness.project.key, jobId: 'old-u09',
    provider: 'old', model: 'old', inputHash: 'synthetic', sourceDigest: 'synthetic-u09-source', now: now - 3 * DAY_MS })
  control.settleAttempt('u09-real-old', 'complete', { inputTokens: 999 }, undefined, now - 3 * DAY_MS)
}

test('U09 registered RPC publishes real grouped ledger fields and reconciled overflow within scope', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    await u09RuntimeUsage(harness)
    const manager = harness.runtime.dashboardReadSessions
    const descriptor = Object.getOwnPropertyDescriptor(manager, 'reserveResident')
    const reserve = manager.reserveResident
    const leases = []
    let observerError
    manager.reserveResident = function (...args) {
      const before = this.counters(args[0])
      const outcome = Reflect.apply(reserve, this, args)
      try {
        if (outcome.status === 'ok' && before.status === 'ok') {
          const after = this.counters(args[0])
          assert.equal(after.status, 'ok')
          assert.equal(after.value.sessionAccountedBytes - before.value.sessionAccountedBytes, args[2] + 64)
          assert.ok(leases.length < 512)
          leases.push({ kind: args[1], bytes: args[2] })
        }
      } catch (error) { observerError ??= error }
      return outcome
    }
    let started
    let drained
    try {
      started = await startDirectDashboard(harness.remote, harness.project.key, harness.data.captureDate)
      drained = await finishOverview(harness.remote, started.readId)
    } finally {
      if (descriptor === undefined) delete manager.reserveResident
      else Object.defineProperty(manager, 'reserveResident', descriptor)
    }
    assert.equal(observerError, undefined)
    assert.ok(leases.some((lease) => lease.kind === 'cache' && lease.bytes === 16 * 4096), 'raw usage pages own an admitted retained copy')
    assert.ok(leases.some((lease) => lease.kind === 'cache' && lease.bytes === 4096), 'model state is prepaid')
    assert.ok(leases.some((lease) => lease.kind === 'cache' && lease.bytes === 2048), 'purpose state is prepaid')
    assert.ok(leases.some((lease) => lease.kind === 'key' && lease.bytes >= 256), 'canonical identities and digests are prepaid')
    const { result, continuations } = drained
    assert.equal(result.status, 'ok')
    assert.equal(result.complete, true)
    assert.ok(continuations < 16)
    const { attempts, billable } = result.usage
    assert.equal(attempts.calls.value, 12)
    assert.equal(billable.calls.value, 12)
    assert.equal(attempts.byModel.length, 10)
    assert.equal(billable.byPurpose.length, 10)
    assert.equal(attempts.byModel[9].other, true)
    assert.equal(billable.byPurpose[9].other, true)
    assert.notEqual(attempts.byModel[0].key, attempts.byModel[1].key)
    assert.equal(attempts.byModel[0].provider, 'a/b')
    assert.equal(attempts.byModel[1].model, 'b/c')
    assert.equal(attempts.byModel[0].inputTokens.value, 0)
    assert.equal(attempts.byModel[0].inputTokens.relation, 'exact')
    assert.equal(attempts.byModel[0].costMicros.relation, 'unknown')
    assert.equal(attempts.byModel.reduce((sum, group) => sum + group.inputTokens.value, 0), 66)
    assert.equal(attempts.inputTokens.value, 66)
    assert.equal(attempts.outputTokens.value, 24)
    assert.equal(attempts.cacheReadTokens.value, 11, 'cache receipts stay separate from input totals')
    assert.equal(attempts.reasoningTokens.value, 12, 'reasoning receipts stay separate from output totals')
    assert.equal(billable.tokens.value, 90)
    assert.equal(billable.byPurpose.reduce((sum, group) => sum + group.actualTokens.value, 0), 90)
    assert.equal(result.usage.mainModelCoverage, 'unavailable')
    assert.equal(result.usage.comparableNetSavings, 'unavailable')
    assert.equal(result.usage.preparedInjectionEstimateMethod, 'sum-prepared-event-tokens')
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024)
    const state = harness.runtime.dashboardAggregate.states.get(started.readId)
    assert.equal(state.overview.usage.modelGroups.length, 9)
    assert.equal(state.overview.usage.purposeGroups.length, 9)
    assert.equal(state.overview.attemptPage, undefined)
    assert.equal(state.overview.billablePage, undefined)
    assert.ok(harness.runtime.dashboardReadSessions.stats().accountedBytes <= 8 * 1024 * 1024)
  })
})

test('U09 registered wire rejects malformed group evidence overflow identities and invented coverage', async () => {
  await withHarness(() => createRuntimeRpcHarness(seedDashboardFixture), async (harness) => {
    await u09RuntimeUsage(harness, 1)
    const started = await startDirectDashboard(harness.remote, harness.project.key, harness.data.captureDate)
    const { result } = await finishOverview(harness.remote, started.readId)
    assert.equal(result.status, 'ok')
    const codec = descriptorOf(READ_DASHBOARD).result.create()
    assert.deepEqual(codec.parse(result), result)
    for (const mutate of [
      (copy) => { copy.usage.attempts.byModel[0].inputTokens.seen = -1 },
      (copy) => { copy.usage.attempts.byModel[0].inputTokens.uncertain = 2 },
      (copy) => { copy.usage.attempts.byModel[0].inputTokens.missing = 1 },
      (copy) => { copy.usage.attempts.byModel[0].costMicros.seen = 1 },
      (copy) => { copy.usage.attempts.byModel[0].inputTokens.untrusted = true },
      (copy) => { copy.usage.attempts.byModel[0].provider = 'x'.repeat(257) },
      (copy) => { copy.usage.attempts.byModel[0].other = true },
      (copy) => { copy.usage.billable.byPurpose[0].other = true },
      (copy) => { copy.usage.attempts.byModel = Array(11).fill(copy.usage.attempts.byModel[0]) },
      (copy) => { delete copy.usage.billable.byPurpose[0].actualTokens },
      (copy) => { copy.usage.mainModelCoverage = 'complete' },
      (copy) => { copy.usage.comparableNetSavings = 99 },
    ]) {
      const invalid = structuredClone(result)
      mutate(invalid)
      assert.throws(() => codec.parse(invalid))
    }
  })
})


// These cases need the real Host integration modules. An isolated verification
// window can bind its read-only Host root explicitly; absence is a failure.
async function u09InstalledTypertHost() {
  const hostRoot = process.env.DSH_TDAI_TEST_HOST_ROOT
  if (hostRoot !== undefined) assert.ok(path.isAbsolute(hostRoot), 'DSH_TDAI_TEST_HOST_ROOT must be an absolute Host composition root')
  const resolveFrom = createRequire(hostRoot === undefined ? import.meta.url : pathToFileURL(path.join(hostRoot, 'package.json')))
  const names = { cordis: '@deepseek-ai/cordis', loader: '@deepseek-ai/dsh-typert-loader',
    registry: '@deepseek-ai/dsh-typert-registry', gateway: '@deepseek-ai/dsh-api-gateway',
    protocol: '@deepseek-ai/dsh-typert-protocol' }
  const entries = await Promise.all(Object.entries(names).map(async ([key, name]) => {
    let entry
    try { entry = resolveFrom.resolve(name) }
    catch (cause) { throw new Error(`Real Host module ${name} is required; provide DSH_TDAI_TEST_HOST_ROOT or normal package resolution`, { cause }) }
    return [key, await import(pathToFileURL(entry).href)]
  }))
  return Object.fromEntries(entries)
}

function u09TypertComposition(context, defect) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-u09-typert-composition-'))
  try {
    // TMPDIR can live inside the tested package. A separate package scope keeps
    // Node's self-reference resolution from bypassing this composition's fixtures.
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'tdai-u09-typert-composition', private: true, type: 'module',
    }))
    const packageRoot = fileURLToPath(new URL('../', import.meta.url))
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(manifest.name, '@missher/dsh-memory-tdai')
    const packageDirectory = path.join(root, 'node_modules', ...manifest.name.split('/'))
    mkdirSync(path.dirname(packageDirectory), { recursive: true })
    if (defect === undefined) {
      // Resolve the real package.json and ./typert export, without a resolver stub.
      symlinkSync(packageRoot, packageDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      assert.ok(defect === 'owner' || defect === 'factory')
      mkdirSync(packageDirectory)
      writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: manifest.name, type: 'module',
        exports: { './package.json': './package.json', './typert': './typert.mjs' } }))
      const artifact = new URL('../lib/typert.host.js', import.meta.url).href
      const change = defect === 'owner' ? "package: 'dsh-memory-tdai'"
        : 'schemas: actual.schemas.map(({ name, create }) => ({ name, schema: create() }))'
      // Only the fixture contribution is malformed; validation stays inside the installed Loader.
      writeFileSync(path.join(packageDirectory, 'typert.mjs'),
        `import { TYPERT as actual } from ${JSON.stringify(artifact)};\nexport const TYPERT = { ...actual, ${change} };\n`)
    }
    // Explicit packages drive the real Loader; there are no unrelated mounted entries.
    context.provide('loader', { entries: () => [] })
    return { root, manifest, context: context.extend({ baseUrl: pathToFileURL(path.join(root, 'composition.json')).href }) }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

async function u09RejectTypertContribution(defect, expected) {
  const host = await u09InstalledTypertHost()
  const context = new host.cordis.Context()
  let composition
  try {
    const registry = new host.registry.TypertRegistry(context)
    composition = u09TypertComposition(context, defect)
    const packageName = composition.manifest.name
    const packageDirectory = path.join(composition.root, 'node_modules', ...packageName.split('/'))
    const resolveFrom = createRequire(composition.context.baseUrl)
    assert.equal(composition.context.get('pluginPackages'), undefined, 'the fixture uses normal package resolution')
    assert.equal(resolveFrom.resolve(`${packageName}/package.json`), path.join(packageDirectory, 'package.json'))
    assert.equal(resolveFrom.resolve(`${packageName}/typert`), path.join(packageDirectory, 'typert.mjs'))
    assert.ok(composition.context.get('typert'), 'the real Typert registry is available before Loader activation')
    assert.equal(typeof composition.context.get('loader')?.entries, 'function', 'the Loader entry service is available')
    const loaderFiber = composition.context.plugin(host.loader, { packages: [packageName] })
    assert.equal(loaderFiber.state, 1, 'the real Loader must start with both required services available')
    await assert.rejects(async () => {
      await loaderFiber
    }, (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 1)
      assert.match(error.errors[0].message, expected)
      return true
    })
    assert.equal(registry.getPackage(composition.manifest.name), undefined)
    assert.deepEqual(registry.local.list(), [], 'a failed Loader contribution cannot partially register endpoints')
    assert.deepEqual(registry.list(), [], 'a failed Loader contribution cannot partially register schemas')
  } finally {
    try { await context.fiber.dispose() }
    finally { if (composition !== undefined) rmSync(composition.root, { recursive: true, force: true }) }
  }
}

test('U09 Host Loader rejects a manifest owned by a different package before registration', async () => {
  await u09RejectTypertContribution('owner', /manifest must be owned by the package that exports it/u)
})

test('U09 Host Loader rejects schema entries without create factories before registration', async () => {
  await u09RejectTypertContribution('factory', /schema "DashboardSnapshot" has no create\(\) factory/u)
})

test('U09 Host Loader registers scoped codecs and Gateway dispatches bootstrap settings and ACK', async () => {
  const host = await u09InstalledTypertHost()
  const contract = await import('../lib/remote-contract.js')
  let composition
  try {
    await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
      assert.equal(host.cordis.Context.is(harness.context), true)
      const registry = new host.registry.TypertRegistry(harness.context)
      composition = u09TypertComposition(harness.context)
      const packageName = composition.manifest.name
      assert.equal(TYPERT.package, packageName)
      assert.equal(TYPERT_REMOTE.package, packageName)
      const loaderFiber = await composition.context.plugin(host.loader, { packages: [packageName] })
      assert.equal(registry.getPackage(packageName).face, 'host')
      assert.equal(registry.getPackage('dsh-memory-tdai'), undefined)
      assert.equal(registry.local.list().length, invocationDescriptors.length)
      assert.equal(registry.list({ package: packageName }).length, TYPERT.schemas.length)
      for (const schema of TYPERT.schemas) {
        assert.equal(typeof schema.create, 'function')
        assert.equal(schema.create(), contract[`${schema.name}Schema`], 'the factory preserves the original strict Zod object')
        assert.equal(registry.resolve(`${packageName}#${schema.name}`).schema, schema.create())
      }
      registry.remotes.register(TYPERT_REMOTE)
      for (const descriptor of invocationDescriptors) {
        const endpoint = `${descriptor.namespace}/${descriptor.method}`
        assert.equal(descriptor.id, `${packageName}#${endpoint}`)
        assert.equal(descriptor.namespace, 'memoryTdai')
        assert.equal(registry.local.get(endpoint), descriptor)
        assert.equal(registry.remotes.get(endpoint), descriptor)
        for (const codec of [descriptor.result, ...descriptor.parameters.map((parameter) => parameter.codec)]) {
          assert.equal(codec.mode, 'strict', 'no SRC fallback codec is permitted')
          assert.ok(codec.typeSymbol.startsWith(`${packageName}#`))
          assert.equal(typeof codec.create, 'function')
        }
      }
      assert.equal(host.protocol.remoteMethods(harness.service).length, 15)
      harness.context.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'synthetic-owner-only' }) })
      const gatewayFiber = await harness.context.plugin(host.gateway.TypertGatewayService, {})
      const gateway = gatewayFiber.ctx.get('typertGateway')
      assert.ok(gateway)
      const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
      const signal = new AbortController().signal
      const dispatch = (method, args) => gateway.dispatchRpc(`memoryTdai/${method}`, { args }, signal, peer)
      const read = (request) => dispatch('readDashboard', { request })
      const bootstrap = async () => {
        const response = await read({ version: 1, action: 'bootstrap', projectKeys: [harness.project.key], range: rangeFor(harness.data.captureDate) })
        assert.equal(response.ok, true, JSON.stringify(response.error))
        assert.equal(response.value.status, 'ok')
        assert.equal(response.value.complete, true)
        assert.ok(response.value.readId)
        assert.deepEqual(response.value.projects.map((project) => project.key), [harness.project.key])
        return response.value
      }
      const started = await bootstrap()
      const settings = await read({ version: 1, action: 'settings', readId: started.readId })
      assert.equal(settings.ok, true, JSON.stringify(settings.error))
      assert.equal(settings.value.status, 'ok')
      assert.equal(settings.value.view, 'settings')
      assert.equal(settings.value.readId, started.readId)
      assert.equal(settings.value.settings.mode, 'review')
      assert.equal(settings.value.settings.extractionEnabled, false)

      const wrongWire = await dispatch('readDashboard', { input: { version: 1, action: 'bootstrap' } })
      assert.equal(wrongWire.ok, false)
      assert.equal(wrongWire.error.code, 'gateway/arguments-invalid', 'the request wire name is preserved, not renamed to the source parameter')
      for (const request of [{ version: 1, action: 'bootstrap', unexpected: true },
        { version: 1, action: 'bootstrap', projectKeys: ['../outside'] }]) {
        const rejected = await read(request)
        assert.equal(rejected.ok, false)
        assert.equal(rejected.error.code, 'gateway/input-invalid', 'real Gateway decoding retains strict Zod validation')
      }
      const rejectedAck = await dispatch('updateSettingsAck', { request: { recallMaxTokens: 777, unexpected: true } })
      assert.equal(rejectedAck.ok, false)
      assert.equal(rejectedAck.error.code, 'gateway/input-invalid')
      const expected = { mode: 'balanced', recallMaxTokens: 777, extractionEveryN: 3, extractionEnabled: false,
        includePersona: true, globalPersona: false }
      const ack = await dispatch('updateSettingsAck', { request: expected })
      assert.equal(ack.ok, true, JSON.stringify(ack.error))
      assert.equal(ack.value.ok, true)
      assert.equal(ack.value.operation, 'settings.update')
      const stale = await read({ version: 1, action: 'settings', readId: started.readId })
      assert.equal(stale.ok, true)
      assert.equal(stale.value.status, 'stale')
      const refreshed = await bootstrap()
      const updated = await read({ version: 1, action: 'settings', readId: refreshed.readId })
      assert.equal(updated.ok, true, JSON.stringify(updated.error))
      assert.equal(updated.value.status, 'ok')
      assert.deepEqual(updated.value.settings, { ...expected, generateMemory: true, useMemory: true }, 'ACK dispatch changes the real plugin state observed by settings')

      await loaderFiber.dispose()
      assert.equal(registry.getPackage(packageName), undefined)
      assert.equal(registry.local.get('memoryTdai/readDashboard'), undefined)
      const withdrawn = await read({ version: 1, action: 'bootstrap' })
      assert.equal(withdrawn.ok, false)
      assert.equal(withdrawn.error.code, 'gateway/definition-unavailable', 'withdrawing the Loader registration cannot fall back to SRC')
    })
  } finally {
    if (composition !== undefined) rmSync(composition.root, { recursive: true, force: true })
  }
})

function u09LifecycleBarrier() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('U09 six page lifetimes share real two-session RPC capacity with directory and settings reads', { timeout: 15000 }, async () => {
  const { createDashboardReaderPool, createDashboardReadController } = await import('../src/client/scoped-read-state.js')
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    const firstAllocations = u09LifecycleBarrier(), releaseAllocations = u09LifecycleBarrier()
    const firstCloses = u09LifecycleBarrier(), releaseCloses = u09LifecycleBarrier()
    const live = new Set(), initial = new Set(), results = []
    let allocations = 0, heldCloses = 0, peak = 0
    const source = async (request) => {
      if (request.action === 'close' && initial.has(request.readId)) {
        heldCloses += 1
        if (heldCloses === 2) firstCloses.resolve()
        await releaseCloses.promise
      }
      const result = await callRpc(harness.service, READ_DASHBOARD, { request })
      results.push({ request, result })
      assert.notEqual(result.reason, 'session-capacity')
      assert.notEqual(result.status, 'evicted')
      if ((request.action === 'bootstrap' || request.action === 'settings') && request.readId === undefined) {
        const expectedStatus = request.action === 'bootstrap' && Array.isArray(request.projectKeys) && request.projectKeys.length === 0
          ? 'selection_required' : 'ok'
        assert.equal(result.status, expectedStatus, `allocation ${request.action}: ${result.reason}`)
        assert.equal(typeof result.readId, 'string')
        allocations += 1
        live.add(result.readId)
        peak = Math.max(peak, live.size)
        if (allocations <= 2) {
          initial.add(result.readId)
          if (allocations === 2) firstAllocations.resolve()
          await releaseAllocations.promise
        }
      }
      if (request.action === 'close') live.delete(request.readId)
      return result
    }
    const pool = createDashboardReaderPool({ readDashboard: source })
    const directory = createDashboardReadController({ readDashboard: source })
    const settings = createDashboardReadController({ readDashboard: source })
    const requests = [
      { version: 1, action: 'overview', focusProjectKey: harness.project.key },
      { version: 1, action: 'persona', projectKey: harness.project.key },
      { version: 1, action: 'globalPersona' },
      { version: 1, action: 'scene', projectKey: harness.project.key },
      { version: 1, action: 'library', projectKey: harness.project.key, status: 'approved', limit: 1 },
      { version: 1, action: 'repeated', target: { kind: 'groups', projectKeys: [harness.project.key], limit: 10 } },
    ]
    const jobs = requests.map(async (request, index) => {
      const reader = pool.get(`page-${index}`), token = reader.start()
      try {
        const opened = await reader.load(token, { version: 1, action: 'bootstrap',
          projectKeys: [harness.project.key], range: rangeFor(harness.data.captureDate) }, { maxContinuations: 0 })
        assert.ok('result' in opened)
        const readId = opened.result.readId
        await Promise.resolve() // Admission must survive the gap between bootstrap and data RPC.
        const read = await reader.load(token, { ...request, readId }, { maxContinuations: 0 })
        assert.ok('result' in read)
        assert.ok(['ok', 'partial', 'budget_exhausted', 'scope_limit'].includes(read.result.status), read.result.reason)
        assert.equal(read.result.readId, readId)
        return read.result
      } finally { await reader.closeCurrent() } // Explicitly end even a partial view; no completeness claim.
    })
    jobs.push((async () => {
      try {
        const read = await directory.load(directory.start(), { version: 1, action: 'bootstrap', projectKeys: [] })
        assert.ok('result' in read)
        assert.ok(read.result.projects.some((project) => project.key === harness.project.key))
      } finally { await directory.closeCurrent() }
    })())
    jobs.push((async () => {
      try {
        const read = await settings.load(settings.start(), { version: 1, action: 'settings' })
        assert.ok('result' in read)
        assert.equal(read.result.settings.mode, 'review')
      } finally { await settings.closeCurrent() }
    })())
    // Attach rejection handlers immediately; an assertion failure still releases every barrier.
    const settled = Promise.allSettled(jobs)
    try {
      await firstAllocations.promise
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(allocations, 2)
      releaseAllocations.resolve()
      await firstCloses.promise
      assert.equal(allocations, 2, 'neither a returned RPC nor a pending close releases admission')
      releaseCloses.resolve()
      const completed = await settled
      for (const outcome of completed) assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack)
      assert.equal(allocations, 8)
      assert.equal(peak, 2)
      assert.equal(live.size, 0)
      assert.equal(results.filter(({ request }) => request.action === 'close').length, 8)
    } finally {
      releaseAllocations.resolve(); releaseCloses.resolve()
      await settled
      await Promise.all([pool.dispose(), directory.dispose(), settings.dispose()])
    }
  })
})

test('U09 retained real RPC cursors remain owned while later page admission waits', { timeout: 15000 }, async () => {
  const { createDashboardReaderPool } = await import('../src/client/scoped-read-state.js')
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    const calls = []
    const source = async (request) => {
      const result = await callRpc(harness.service, READ_DASHBOARD, { request })
      calls.push({ request, result })
      assert.notEqual(result.reason, 'session-capacity')
      assert.notEqual(result.status, 'evicted')
      return result
    }
    const pool = createDashboardReaderPool({ readDashboard: source })
    const first = pool.get('library'), second = pool.get('review'), third = pool.get('overview')
    try {
      const open = async (reader) => {
        const token = reader.start()
        const opened = await reader.load(token, { version: 1, action: 'bootstrap',
          projectKeys: [harness.project.key], range: rangeFor(harness.data.captureDate) })
        assert.ok('result' in opened)
        const readId = opened.result.readId
        const page = await reader.load(token, { version: 1, action: 'library', readId,
          projectKey: harness.project.key, status: 'approved', limit: 1 }, { maxContinuations: 0 })
        assert.ok('result' in page)
        assert.equal(page.result.complete, false)
        assert.equal(page.result.records.length, 1)
        assert.equal(typeof page.result.cursor, 'string')
        return { token, readId, page: page.result }
      }
      const [a, b] = await Promise.all([open(first), open(second)])
      const thirdToken = third.start()
      const queued = third.load(thirdToken, { version: 1, action: 'bootstrap',
        projectKeys: [harness.project.key], range: rangeFor(harness.data.captureDate) })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(calls.filter(({ request }) => request.action === 'bootstrap').length, 2)
      const resumedA = await first.load(a.token, { version: 1, action: 'continue', readId: a.readId, cursor: a.page.cursor })
      assert.ok('result' in resumedA)
      assert.equal(resumedA.result.status, 'ok')
      assert.notEqual(resumedA.result.records[0].id, a.page.records[0].id)
      await first.closeCurrent()
      assert.ok('result' in await queued)
      assert.equal(second.readId, b.readId, 'another page cannot replace the retained owner')
      const resumedB = await second.load(b.token, { version: 1, action: 'continue', readId: b.readId, cursor: b.page.cursor })
      assert.ok('result' in resumedB)
      assert.equal(resumedB.result.status, 'ok')
      assert.notEqual(resumedB.result.records[0].id, b.page.records[0].id)
      assert.equal(calls.filter(({ request }) => request.action === 'bootstrap').length, 3,
        'continuations do not reopen sessions or reset cumulative budgets')
    } finally { await pool.dispose() }
  })
})

test('U09 registered RPC preserves capture source counts and activity-specific unknown drilldowns', async () => {
  const { boundedEventDetailRequest, boundedOverviewModel } = await import('../src/client/dashboard-view-model.js')
  await withHarness(() => createHarness((store) => {
    const now = Date.now()
    const sources = [0, 1].map((index) => store.recordL0({ sessionId: 'scope-count-session', role: 'user',
      content: `Synthetic scoped source ${index}.`, createdAt: now, recordedAt: now,
      sourceEventId: `scope-count-${index}`, origin: 'dsh-session' }))
    store.appendEvent({ eventId: 'capture:scope-count-unknown', type: 'capture', sourceId: sources[0],
      sessionId: 'scope-count-session', occurredAt: now, count: 1 }, now)
    const memory = store.addMemory({ content: 'Synthetic source-linked approved memory.', kind: 'fact', status: 'approved',
      sourceMessageIds: [sources[0]], sourceVerified: true }).record
    store.appendEvent({ eventId: 'revision:scope-count-revision', type: 'revision', sourceId: memory.id,
      occurredAt: now, count: 1 }, now)
    return { date: utcDate(now) }
  }), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const projectKey = harness.project.key
    for (const activity of ['revision', 'capture', 'initial_approval']) {
      const range = { from: harness.data.date, to: harness.data.date, timeZone: 'UTC', activity }
      const started = await read({ version: 1, action: 'bootstrap', projectKeys: [projectKey], range })
      assert.equal(started.status, 'ok')
      const { result, continuations } = await finishOverview(harness.service, started.readId)
      assert.equal(result.complete, true)
      assert.ok(continuations < 16)
      assert.equal(result.metrics.captures.value, 3)
      assert.equal(result.metrics.initialApprovals.value, 1)
      assert.equal(result.metrics.acceptedRevisions.value, 1)
      assert.equal(result.dimensions.sources.reduce((sum, row) => sum + row.count.value, 0), 5)
      const model = boundedOverviewModel(result, activity)
      assert.deepEqual(model.captureSources, [
        { key: 'dsh-session', count: { value: 2, relation: 'exact' } },
        { key: 'unknown', count: { value: 1, relation: 'exact' } },
      ])
      assert.equal(model.selectedDimensions.sources.find((row) => row.key === 'unknown').count.value, 1)
      const selectedRequest = boundedEventDetailRequest({ projectKey, range, dimension: 'source', value: 'unknown', date: '' })
      const selected = await read({ ...selectedRequest.request, readId: started.readId })
      assert.equal(selected.complete, true)
      assert.equal(selected.events.length, 1)
      assert.equal(selected.events[0].type, activity, 'selected groups use the session activity, including non-capture unknowns')
      assert.equal((await read({ version: 1, action: 'close', readId: started.readId })).status, 'ok')

      const captureRequest = boundedEventDetailRequest({ projectKey, range, activity: 'capture', dimension: 'source', value: 'unknown', date: '' })
      assert.equal(captureRequest.range.activity, 'capture', 'capture panel does not inherit a revision/approval filter')
      const captureScope = await read({ version: 1, action: 'bootstrap', projectKeys: [projectKey], range: captureRequest.range })
      assert.equal(captureScope.status, 'ok')
      const captureDetail = await read({ ...captureRequest.request, readId: captureScope.readId })
      assert.equal(captureDetail.complete, true)
      assert.equal(captureDetail.events.length, 1, 'genuine unknown capture is clickable through the real codec and visibility proof')
      assert.equal(captureDetail.events[0].type, 'capture')
      assert.equal(captureDetail.events[0].source, undefined)
      assert.equal((await read({ version: 1, action: 'close', readId: captureScope.readId })).status, 'ok')
    }
  })
})


test('Demo v7 forget crosses the real Typert manage contract and preserves confirmation version and readability guards', async () => {
  const { readGlobalMemory } = await import('../src/client/memory-v7-model.js')
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    assertRemoteMarker(harness.service, MANAGE)
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const globalRequest = { version: 1, action: 'global', layer: 'L1', query: '', year: new Date().getUTCFullYear(), timeZone: 'UTC' }
    const before = await readGlobalMemory(read, globalRequest)
    const item = before.global.items.find((row) => row.id === harness.data.approvedA.id)
    assert.ok(item, 'use the actual readable L1 version returned to the UI')
    const payload = { layer: item.layer, id: item.id, updatedAt: item.updatedAt, confirmed: true }
    const manage = (request) => callRpc(harness.service, MANAGE, { request })
    const base = { projectKey: harness.project.key, operation: 'v7.forget', payload }
    for (const operation of ['v7.forgetAll', 'arbitrary.write']) await assert.rejects(() => manage({ ...base, operation }))
    await assert.rejects(() => manage({ ...base, extra: true }), 'the outer contract remains strict')
    for (const change of [{ confirmed: false }, { layer: 'L0' }, { layer: 'L2' }, { layer: 'L3' }]) {
      await assert.rejects(() => manage({ ...base, payload: { ...payload, ...change } }), /L1 forget confirmation invalid/u)
    }
    await assert.rejects(() => manage({ ...base, payload: { ...payload, updatedAt: item.updatedAt + 1 } }), /memory changed/u)
    await assert.rejects(() => manage({ ...base, payload: { ...payload, id: harness.data.candidateA.id,
      updatedAt: harness.data.candidateA.updatedAt } }), /memory changed/u)
    const unchanged = await readGlobalMemory(read, globalRequest)
    assert.ok(unchanged.global.items.some((row) => row.key === item.key), 'all rejected requests leave the original record readable')
    const ack = await manage(base)
    assert.deepEqual(ack, { data: { applied: true } })
    const after = await readGlobalMemory(read, globalRequest)
    assert.equal(after.global.items.some((row) => row.key === item.key), false)
    assert.ok(after.global.items.some((row) => row.id === harness.data.approvedB.id), 'unrelated L1 remains readable')
    await assert.rejects(() => manage(base), /memory changed/u, 'a forgotten record cannot be written again through stale UI data')
  })
})

test('Demo v7 Typert forget refuses a runtime whose writer epoch has been replaced', async () => {
  await withHarness(() => createHarness(seedDashboardFixture), async (harness) => {
    const replacement = new ControlLedger(harness.root)
    try {
      const item = harness.data.approvedA
      await assert.rejects(() => callRpc(harness.service, MANAGE, { request: { projectKey: harness.project.key,
        operation: 'v7.forget', payload: { layer: 'L1', id: item.id, updatedAt: item.updatedAt, confirmed: true } } }), /forget unavailable/u)
      assert.equal(replacement.isForgotten(harness.project.key, item.id), false)
      const store = openProjectStore(harness.root, harness.project.key)
      try { assert.equal(store.get(item.id).status, 'approved') } finally { store.close() }
    } finally { replacement.close() }
  })
})


test('Memory settings RPC omits quotas and retains switch ACKs and proposal review', async () => {
  const { createMemorySettingsMutation, readGlobalMemory } = await import('../src/client/memory-v7-model.js')
  await withHarness(() => createHarness(() => ({})), async (harness) => {
    const read = (request) => callRpc(harness.service, READ_DASHBOARD, { request })
    const write = (request) => callRpc(harness.service, UPDATE_SETTINGS_ACK, { request })
    const controller = createMemorySettingsMutation({ readDashboard: read, updateSettingsAck: write })
    const global = () => readGlobalMemory(read, { version: 1, action: 'global', layer: 'home', query: '', year: new Date().getUTCFullYear(), timeZone: 'UTC' })
    try {
      for (const generateMemory of [true, false, true]) {
        const result = await controller.save({ generateMemory })
        assert.equal(result.kind, 'saved'); assert.equal(result.settings.generateMemory, generateMemory)
        const page = await global()
        assert.equal('automaticBudget' in page.global, false)
        assert.equal(page.global.paused, !generateMemory)
        assert.deepEqual(page.global.pauseReasons, generateMemory ? [] : ['generation_disabled'])
        for (const key of ['automaticDailyTokens', 'automaticDailyTasks', 'manualDailyTokens', 'manualDailyTasks']) assert.equal(key in result.settings, false)
      }
      const proposal = await harness.tools.find((tool) => tool.name === 'memory_propose').execute({ content: 'Synthetic tool-only proposal remains unapproved.', confidence: 1 },
        { agent: { session: { id: 'proposal', header: { cwd: harness.projectCwd } } } })
      assert.equal(proposal.status, 'candidate'); assert.equal(proposal.usable, false)
      assert.equal(proposal.activatedByThisCall, false); assert.equal(proposal.reason, 'pending_review')
      const store = openProjectStoreReadOnly(harness.root, harness.project.key)
      try { assert.equal(store.get(proposal.id).status, 'candidate'); assert.equal(store.search('tool-only proposal', 10).length, 0) }
      finally { store.close() }
    } finally { controller.dispose() }
  })
})
