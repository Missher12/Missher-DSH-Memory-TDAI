import assert from 'node:assert/strict'
import test from 'node:test'
import { registerMemoryTools } from '../lib/tools.js'
import { estimateTokens } from '../lib/tokens.js'

test('model-facing tools expose paging fields and return valid complete budget responses', async () => {
  const definitions = new Map()
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    profile(_cwd, limit, offset) {
      return { persona: null, scenes: [{ name: 'large', summary: 'x'.repeat(12_000), limit, offset }], totalScenes: 1 }
    },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    assert.ok([...definitions.values()].every((definition) => definition.parameters.properties.budget_tokens))
    const profile = definitions.get('memory_profile')
    const raw = definitions.get('memory_read_raw')
    assert.ok(profile.parameters.properties.limit)
    assert.ok(profile.parameters.properties.offset)
    assert.ok(raw.parameters.properties.offset)
    assert.ok(raw.parameters.properties.chars)

    const result = await profile.execute({ limit: 1, offset: 2, budget_tokens: 128 }, {
      agent: { session: { header: { cwd: '/synthetic/project' } } },
    })
    assert.equal(result.status, 'budget_exceeded')
    assert.equal(result.omitted, true)
    assert.equal(JSON.parse(profile.output.render({}, result)[0].text).status, 'budget_exceeded')

    const tooLarge = profile.output.render({}, { payload: 'x'.repeat(60_001) })
    assert.equal(JSON.parse(tooLarge[0].text).status, 'render_limit_exceeded')
  } finally {
    dispose()
  }
})

test('memory_search reports exhaustion separately from policy and hard scan caps', async () => {
  const definitions = new Map()
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    searchCandidatesDetailed() { return { candidates: [], scanLimit: 50, policyMaxCandidates: 50, candidateCount: 0, scanCapped: false } },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const search = definitions.get('memory_search')
    const execution = { agent: { session: { header: { cwd: '/synthetic/project' } } } }
    const cases = [
      { cap: 10, count: 9, capped: false }, { cap: 10, count: 10, capped: false }, { cap: 10, count: 10, capped: true },
      { cap: 50, count: 49, capped: false }, { cap: 50, count: 50, capped: false }, { cap: 50, count: 50, capped: true },
    ]
    for (const item of cases) {
      runtime.searchCandidatesDetailed = () => ({
        candidates: Array.from({ length: item.count }, (_, index) => ({ id: `mem-${index}`, content: `needle ${index}`, kind: 'fact', scene: undefined, confidence: 0.8, score: 1, updatedAt: 1 })),
        scanLimit: item.cap, policyMaxCandidates: item.cap, candidateCount: item.count, scanCapped: item.capped,
      })
      const offset = item.count > 20 ? item.count - 20 : 0
      const result = await search.execute({ query: 'needle', limit: 20, offset, budget_tokens: 6000 }, execution)
      assert.equal(result.scanLimit, item.cap)
      assert.equal(result.scanCapped, item.capped)
      assert.equal(result.exhausted, !item.capped)
      assert.ok(estimateTokens(JSON.stringify(result, null, 2)) <= 6000)
    }
  } finally {
    dispose()
  }
})

test('memory_search returns unknown and still-uncertain effective-time qualifications', async () => {
  const definitions = new Map()
  const now = Date.now()
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    searchCandidatesDetailed() { return {
      candidates: [
        { id: 'mem-unknown', content: 'synthetic unknown-time memory', kind: 'fact', confidence: 0.8, score: 1, updatedAt: now, validFromState: 'unknown' },
        { id: 'mem-month', content: 'synthetic partial-time memory', kind: 'fact', confidence: 0.8, score: 1, updatedAt: now,
          validFromState: 'known', validFrom: now - 10, validFromUpper: now + 60_000, validFromLabel: '2026-10' },
      ], scanLimit: 50, policyMaxCandidates: 50, candidateCount: 2, scanCapped: false,
    } },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const search = definitions.get('memory_search')
    const result = await search.execute({ query: 'synthetic time', limit: 5 }, { agent: { session: { header: { cwd: '/synthetic/project' } } } })
    assert.equal(result.results[0].valid_from_state, 'unknown')
    assert.match(result.results[0].temporal_note, /生效时间未知/u)
    assert.equal(result.results[1].valid_from, '2026-10')
    assert.match(result.results[1].temporal_note, /不确定区间/u)
  } finally {
    dispose()
  }
})

test('memory_get preserves retry ids and offsets when metadata leaves no content progress', async () => {
  const definitions = new Map()
  const makeMemory = (id, offset = 7, longMetadata = false) => ({
    id, revision: 3, kind: longMetadata ? 'x'.repeat(1800) : 'fact', content: '内容'.repeat(500),
    sourceMessageIds: ['source-1'], updatedAt: 1,
    contentPage: { offset, nextOffset: offset + 1000, totalChars: 2000, checksum: 'a'.repeat(64), revision: 3 },
  })
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    memoryDetails(_cwd, ids, options) {
      const memories = ids.map((id) => {
        const memory = makeMemory(id, options.offsets?.[id] ?? 0, id === 'mem-long')
        return { memory: { id: memory.id, revision: memory.revision, kind: memory.kind, content: memory.content, sourceMessageIds: memory.sourceMessageIds, updatedAt: memory.updatedAt }, contentPage: memory.contentPage }
      })
      return { memories, omittedIds: [], omittedReasons: {}, retryableOffsets: [], estimatedTokens: 0, budgetTokens: options.budgetTokens }
    },
    evidencePage() { return { evidence: [], offset: 0, totalEvidence: 0 } },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const get = definitions.get('memory_get')
    const execution = { agent: { session: { header: { cwd: '/synthetic/project' } } } }
    const single = await get.execute({ id: 'mem-long', offset: 7, budget_tokens: 128 }, execution)
    assert.equal(single.status, 'budget_exceeded')
    assert.equal(single.id, 'mem-long')
    assert.equal(single.nextOffset, 7)
    assert.equal(single.metadataOnly, true)
    const batch = await get.execute({ ids: ['mem-long', 'mem-short'], budget_tokens: 128 }, execution)
    assert.equal(batch.status, 'budget_exceeded')
    assert.deepEqual(batch.ids, ['mem-long', 'mem-short'])
    assert.deepEqual(batch.retryableOffsets.map((item) => item.nextOffset), [0, 0])
  } finally {
    dispose()
  }
})

test('memory_get includes final estimatedTokens in the fitted CJK response budget', async () => {
  const definitions = new Map()
  const content = '记忆内容与来源证据。🙂'.repeat(40)
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    memoryDetails(_cwd, ids, options) {
      const id = ids[0]
      return { memories: [{ memory: { id, revision: 1, kind: 'fact', content, sourceMessageIds: ['source-1'], updatedAt: 1 },
        contentPage: { offset: 0, nextOffset: content.length, totalChars: content.length, checksum: 'b'.repeat(64), revision: 1 } }],
        omittedIds: [], omittedReasons: {}, retryableOffsets: [], estimatedTokens: 0, budgetTokens: options.budgetTokens }
    },
    evidencePage() { return { evidence: [], offset: 0, totalEvidence: 0 } },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const get = definitions.get('memory_get')
    const execution = { agent: { session: { header: { cwd: '/synthetic/project' } } } }
    const initial = await get.execute({ id: 'mem-cjk', chars: 600, budget_tokens: 1024 }, execution)
    const exactBudget = estimateTokens(JSON.stringify(initial, null, 2))
    const exact = await get.execute({ id: 'mem-cjk', chars: 600, budget_tokens: Math.max(128, exactBudget) }, execution)
    const measured = estimateTokens(JSON.stringify(exact, null, 2))
    assert.equal(exact.estimatedTokens, measured)
    assert.ok(measured <= Math.max(128, exactBudget))
    assert.equal(exact.memory.id, 'mem-cjk')
    const nextOffset = exact.contentPage.nextOffset
    if (typeof nextOffset === 'number') {
      assert.equal(content.charCodeAt(nextOffset - 1) >= 0xd800 && content.charCodeAt(nextOffset - 1) <= 0xdbff && content.charCodeAt(nextOffset) >= 0xdc00 && content.charCodeAt(nextOffset) <= 0xdfff, false)
    }
  } finally {
    dispose()
  }
})

test('memory_search forwards explicit time and relation depth and reports route metadata', async () => {
  const definitions = new Map()
  let captured
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { captured = { global: true, query, limit }; return { candidates: [], scanLimit: 50, policyMaxCandidates: 50, candidateCount: 0, scanCapped: false, temporal: false } },
    searchCandidatesDetailed(_cwd, _query, _scan, options) {
      captured = options
      const temporal = options.effectiveAt !== undefined
      return {
        candidates: [{ id: 'mem-1', content: 'alpha candidate', kind: 'fact', confidence: 0.8, score: 0.5, updatedAt: 1,
          validFromState: 'known', validFrom: 1, routes: ['lexical', 'relation'],
          ...(temporal ? { temporal: { effectiveAt: options.effectiveAt, knownAt: options.knownAt ?? options.effectiveAt } } : {}) }],
        scanLimit: 50, policyMaxCandidates: 50, candidateCount: 1, scanCapped: false,
        routes: [{ name: 'lexical', candidateCount: 1 }, { name: 'relation', candidateCount: 1 }],
        candidateGaps: ['relation_scan_truncated:mem-1'], stopReason: 'scan_capped', temporal,
        ...(temporal ? { effectiveAt: options.effectiveAt, knownAt: options.knownAt ?? options.effectiveAt } : {}),
      }
    },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const search = definitions.get('memory_search')
    const execution = { agent: { session: { header: { cwd: '/synthetic/project' } } } }
    const result = await search.execute({ query: 'alpha', limit: 5, effective_at: 100, known_at: 200, relation_depth: 2 }, execution)
    assert.deepEqual(captured, { effectiveAt: 100, knownAt: 200, relationDepth: 2 })
    assert.deepEqual(result.routes, [{ name: 'lexical', candidateCount: 1 }, { name: 'relation', candidateCount: 1 }])
    assert.deepEqual(result.candidateGaps, ['relation_scan_truncated:mem-1'])
    assert.equal(result.stopReason, 'scan_capped')
    assert.equal(result.temporal, true)
    assert.deepEqual(result.results[0].routes, ['lexical', 'relation'])
    assert.equal(result.results[0].temporal_selected, true)
    const legacy = await search.execute({ query: 'alpha' }, execution)
    assert.deepEqual(captured, { global: true, query: 'alpha', limit: 50 }, 'ordinary queries use the global interface without inventing a historical timepoint')
    assert.equal(legacy.temporal, false)
    await assert.rejects(search.execute({ query: 'alpha', known_at: 200 }, execution), /known_at requires effective_at/u)
  } finally {
    dispose()
  }
})

test('memory_search reports an explicit budget stop reason when a candidate body cannot fit', async () => {
  const definitions = new Map()
  const gapIds = Array.from({ length: 20 }, (_unused, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
  const envelopeGaps = gapIds.map((id, index) => index < 10
    ? `relation_scan_truncated:${id}` : `${id}:relation_evidence_unreadable`)
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    searchCandidatesDetailed(_cwd, query) {
      const envelopeOverflow = query === 'envelope-too-small'
      return { candidates: [{ id: envelopeOverflow ? 'mem-envelope' : 'mem-huge',
        content: envelopeOverflow ? 'Bounded envelope candidate.' : '字'.repeat(4000),
        kind: 'fact', confidence: 0.8, score: 1, updatedAt: 1 }],
        scanLimit: 50, policyMaxCandidates: 50, candidateCount: 1, scanCapped: false,
        routes: [{ name: 'lexical', candidateCount: 1 }],
        candidateGaps: envelopeOverflow ? envelopeGaps : [], stopReason: 'evidence_exhausted', temporal: false }
    },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const search = definitions.get('memory_search')
    const execution = { agent: { session: { header: { cwd: '/synthetic/project' } } } }
    assert.equal(envelopeGaps.length, 20, 'candidate gaps stay within the collector cap')
    assert.ok(gapIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)))
    assert.ok(envelopeGaps.every((gap) => Buffer.byteLength(gap, 'utf8') <= 256),
      'the query-specific relation gaps use valid bounded IDs and real reason formats')
    const metadataResponse = await search.execute({ query: 'envelope-too-small', limit: 1, budget_tokens: 1024 }, execution)
    assert.deepEqual(metadataResponse.candidateGaps, envelopeGaps)
    const metadataOnlyResponse = { ...metadataResponse, results: [] }
    delete metadataOnlyResponse.estimatedTokens
    assert.ok(estimateTokens(JSON.stringify(metadataOnlyResponse, null, 2)) > 128,
      'the complete metadata envelope cannot fit the minimum budget even after results are removed')
    const tooSmall = await search.execute({ query: 'envelope-too-small', limit: 1, budget_tokens: 128 }, execution)
    assert.equal(tooSmall.status, 'budget_exceeded',
      'a response envelope that cannot fit at the minimum budget returns a whole-response retry')
    assert.equal(tooSmall.omitted, true)
    assert.equal(tooSmall.nextOffset, 0, 'the whole-response fallback does not consume the candidate')
    assert.equal(tooSmall.results?.length ?? 0, 0)
    assert.ok(estimateTokens(JSON.stringify(tooSmall, null, 2)) <= 128, 'the full fallback fits the minimum budget')

    const result = await search.execute({ query: 'huge', limit: 1, budget_tokens: 1024 }, execution)
    assert.equal(result.stopReason, 'budget')
    const measuredTokens = estimateTokens(JSON.stringify(result, null, 2))
    assert.equal(result.estimatedTokens, measuredTokens)
    assert.ok(measuredTokens <= 1024, 'the complete omitted-body response stays within the requested envelope')
    const omitted = result.results.find((item) => item.id === 'mem-huge')
    assert.equal(omitted?.omitted, true)
    assert.equal(omitted?.nextAction, 'memory_get')
  } finally {
    dispose()
  }
})

test('memory_experience forwards explicit condition facts and bounds its inputs', async () => {
  const definitions = new Map()
  let captured
  const runtime = {
    memoryUseAllowed: () => true,
    conversationCwd: () => '/synthetic/profile/session-without-project',
    searchGlobalDetailed(query, limit) { return this.searchCandidatesDetailed(undefined, query, limit) },
    experience(cwd, query, environment, limit, options) {
      captured = { cwd, query, environment, limit, options }
      return []
    },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const experience = definitions.get('memory_experience')
    const execution = { agent: { session: { header: { cwd: '/synthetic/project' } } } }
    await experience.execute({ query: 'cache recovery', environment: { os: 'linux' }, conditions: { runtime: 'node-22' },
      satisfied_prerequisites: ['path has moved', 'path has moved'], limit: 4 }, execution)
    assert.deepEqual(captured.environment, { os: 'linux' })
    assert.deepEqual(captured.options, { conditions: { runtime: 'node-22' }, satisfiedPrerequisites: ['path has moved'] })
    assert.equal(captured.limit, 4)
    const legacy = await experience.execute({ query: 'cache recovery', environment: { os: 'linux' } }, execution)
    assert.deepEqual(captured.options, { conditions: {}, satisfiedPrerequisites: [] })
    assert.deepEqual(legacy.results, [])
    await assert.rejects(experience.execute({ query: 'cache recovery', environment: { os: 22 } }, execution), /environment values must be strings/u)
    await assert.rejects(experience.execute({ query: 'cache recovery', environment: {}, conditions: 'node-22' }, execution), /conditions must be an object/u)
    await assert.rejects(experience.execute({ query: 'cache recovery', environment: {}, conditions: { runtime: 22 } }, execution), /condition values must be strings/u)
    await assert.rejects(experience.execute({ query: 'cache recovery', environment: {}, satisfied_prerequisites: 'path has moved' }, execution), /satisfied_prerequisites must be an array/u)
  } finally {
    dispose()
  }
})


test('memory_search requires a live Host session and accepts a real session without cwd', async () => {
  const definitions = new Map(), calls = []
  const runtime = {
    memoryUseAllowed(session) { return session.header.agentPreset !== 'excluded' && !session.disabled },
    searchGlobalDetailed(query, limit, cursor) { calls.push({ query, limit, cursor }); return { candidates: [], scanLimit: 50, policyMaxCandidates: 50, candidateCount: 0, scanCapped: false } },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const search = definitions.get('memory_search')
    await assert.rejects(search.execute({ query: 'needle' }, {}), /live Host session/)
    await assert.rejects(search.execute({ query: 'needle' }, { agent: {} }), /live Host session/)
    assert.equal(calls.length, 0)
    const result = await search.execute({ query: 'needle' }, { agent: { session: { id: 'real', header: { agentPreset: 'agent-mock' } } } })
    assert.equal(result.candidateCount, 0); assert.equal(calls.length, 1)
    for (const session of [{ id: 'excluded', header: { agentPreset: 'excluded' } }, { id: 'off', header: {}, disabled: true }]) {
      assert.equal((await search.execute({ query: 'needle' }, { agent: { session } })).status, 'memory-use-disabled')
    }
    assert.equal(calls.length, 1)
  } finally { dispose() }
})


test('memory_search retains a global window cursor for offsets and response budget retries', async () => {
  const definitions = new Map(), calls = [], cursor = '00000000-0000-4000-8000-000000000007'
  const runtime = {
    memoryUseAllowed: () => true,
    searchGlobalDetailed(query, limit, scan) {
      calls.push({ query, limit, scan })
      return { candidates: Array.from({ length: 3 }, (_, i) => ({ id: `g:source-a:memory-${i}`, content: 'needle', kind: 'fact', confidence: .9, score: 1, updatedAt: 1 })),
        scanLimit: 50, policyMaxCandidates: 50, candidateCount: 3, scanCapped: true, nextScan: '00000000-0000-4000-8000-000000000008' }
    },
  }
  const dispose = registerMemoryTools({ tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } }, runtime)
  try {
    const search = definitions.get('memory_search'), execution = { agent: { session: { id: 'real', header: {} } } }
    const first = await search.execute({ query: 'needle', scan_cursor: cursor, limit: 1, budget_tokens: 2000 }, execution)
    assert.equal(first.nextOffset, 1)
    const next = await search.execute({ query: 'needle', scan_cursor: cursor, offset: first.nextOffset, limit: 1, budget_tokens: 2000 }, execution)
    assert.notEqual(first.results[0].id, next.results[0].id)
    assert.deepEqual(calls.map((item) => item.scan), [cursor, cursor])
    await assert.rejects(search.execute({ query: 'needle', scan_cursor: cursor, effective_at: 1 }, execution), /current global query/)
  } finally { dispose() }
})
