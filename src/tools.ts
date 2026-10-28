/**
 * Model-facing memory tools.
 *
 * Definitions use the raw JSON-Schema shape accepted by the DSH tool registry,
 * the same shape used by other zero-dependency DSH plugins. The plugin never
 * imports `dsh-tools`; the Host owns validation and presentation.
 *
 * @module dsh-memory-tdai/tools
 */

import type { ToolDefinitionLike, ToolExecutionLike } from './dsh.js'
import type { MemoryRuntime } from './memory.js'
import { estimateTokens } from './tokens.js'

const DEFAULT_AGENT_TOOL_BUDGET = 1600
const MAX_AGENT_TOOL_BUDGET = 6000
const MAX_RENDER_CHARS = 60_000

type SchemaNode = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  enum?: readonly string[]
  anyOf?: readonly SchemaNode[]
  minimum?: number
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
  required?: readonly string[]
  additionalProperties?: boolean | SchemaNode
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid arguments: "${key}" must be a non-empty string`)
  return value.trim()
}

function optionalNumber(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid arguments: "${key}" must be a number`)
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function cwdOf(exec: ToolExecutionLike, runtime: MemoryRuntime): string {
  const cwd = exec.agent?.session?.header?.cwd
  if (exec.agent?.session === undefined) throw new Error('memory tool requires a live Host session')
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : runtime.conversationCwd(exec.agent.session)
}

function jsonRender(value: unknown): Array<{ type: 'text'; text: string }> {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= MAX_RENDER_CHARS) return [{ type: 'text', text }]
  return [{ type: 'text', text: JSON.stringify({ status: 'render_limit_exceeded', outputCharacters: text.length,
    hint: 'Reduce the requested result count or use a smaller continuation page.' }) }]
}

function withinBudget(value: unknown, budgetTokens: number): boolean {
  return estimateTokens(JSON.stringify(value, null, 2) ?? '') <= budgetTokens
}

function withEstimatedTokens<T extends Record<string, unknown>>(value: T): T & { estimatedTokens: number } {
  let output: T & { estimatedTokens: number } = { ...value, estimatedTokens: 0 }
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const next = estimateTokens(JSON.stringify(output, null, 2) ?? '')
    if (next === output.estimatedTokens) return output
    output = { ...value, estimatedTokens: next }
  }
  return output
}

function fitSearchResponse(value: unknown, budgetTokens: number): unknown {
  const input = asRecord(value)
  if (!Array.isArray(input.results)) return value
  const rows = input.results
  const offset = typeof input.offset === 'number' ? input.offset : 0
  const requestedLimit = typeof input.resultLimit === 'number' ? Math.max(1, Math.min(20, input.resultLimit)) : rows.length
  const output: Record<string, unknown> = { ...input, results: [] }
  delete output.resultLimit
  const fallback = (nextOffset: number): unknown => ({
    status: 'budget_exceeded', omitted: true, budgetTokens, nextOffset, stopReason: 'budget',
    hint: 'No candidate was consumed. Increase budget_tokens or retry with limit=1; read long matches by id with memory_get.',
  })
  if (!withinBudget(output, budgetTokens)) return fallback(offset)
  const selected: unknown[] = []
  let processed = 0
  const omittedCandidateIds: string[] = []
  const candidateCount = typeof input.candidateCount === 'number' ? input.candidateCount : offset + rows.length
  const scanLimit = typeof input.scanLimit === 'number' ? input.scanLimit : 50
  const scanCapped = input.scanCapped === true
  const makeResponse = (consumed = processed, results = selected, omitted = omittedCandidateIds): Record<string, unknown> => {
    const nextOffset = offset + consumed
    const response: Record<string, unknown> = {
      ...output,
      results: [...results],
      exhausted: nextOffset >= candidateCount && !scanCapped,
    }
    if (omitted.length > 0) { response.omittedCandidateIds = [...omitted]; response.stopReason = 'budget' }
    else if (results.some((item) => asRecord(item).omitted === true)) response.stopReason = 'budget'
    if (nextOffset < candidateCount) response.nextOffset = nextOffset
    else delete response.nextOffset
    return withEstimatedTokens(response)
  }
  for (const item of rows) {
    if (selected.length >= requestedLimit) break
    const fullResponse = makeResponse(processed + 1, [...selected, item])
    if (withinBudget(fullResponse, budgetTokens)) {
      selected.push(item)
      processed += 1
      continue
    }
    const record = asRecord(item)
    const id = typeof record.id === 'string' ? record.id : ''
    if (id === '') break
    const omission = [...omittedCandidateIds, id]
    const omissionResponse = makeResponse(processed + 1, selected, omission)
    if (withinBudget(omissionResponse, budgetTokens)) {
      omittedCandidateIds.push(id)
      processed += 1
      continue
    }
    break
  }
  for (const id of [...omittedCandidateIds]) {
    if (selected.length >= requestedLimit) break
    const item = rows.find((candidate) => asRecord(candidate).id === id)
    if (item === undefined) continue
    const stub = { id, score: asRecord(item).score, omitted: true, reason: 'response_budget', nextAction: 'memory_get' }
    const index = omittedCandidateIds.indexOf(id)
    omittedCandidateIds.splice(index, 1)
    selected.push(stub)
    if (!withinBudget(makeResponse(), budgetTokens)) {
      selected.pop()
      omittedCandidateIds.splice(index, 0, id)
    }
  }
  if (processed === 0 && rows.length > 0) return fallback(offset)
  const response = makeResponse()
  if (!withinBudget(response, budgetTokens)) return fallback(offset)
  return response
}

function fitMemoryGetResponse(value: unknown, budgetTokens: number): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const response = value as Record<string, unknown>
  if (response.status === 'budget_exceeded') {
    const finalized = withEstimatedTokens(response)
    if (estimateTokens(JSON.stringify(finalized, null, 2) ?? '') <= budgetTokens) return finalized
    const fallback: Record<string, unknown> = { status: 'budget_exceeded', omitted: true, retryable: true, metadataOnly: true, budgetTokens }
    for (const key of ['id', 'nextOffset', 'ids', 'retryableOffsets'] as const) {
      if (!Object.prototype.hasOwnProperty.call(response, key)) continue
      const candidate = withEstimatedTokens({ ...fallback, [key]: response[key] })
      if (estimateTokens(JSON.stringify(candidate, null, 2) ?? '') <= budgetTokens) Object.assign(fallback, { [key]: response[key] })
    }
    return withEstimatedTokens(fallback)
  }
  const entries: Array<{ memory: Record<string, unknown>; contentPage: Record<string, unknown> }> = []
  if (response.memory !== null && typeof response.memory === 'object' && !Array.isArray(response.memory) &&
      response.contentPage !== null && typeof response.contentPage === 'object' && !Array.isArray(response.contentPage)) {
    entries.push({ memory: response.memory as Record<string, unknown>, contentPage: response.contentPage as Record<string, unknown> })
  }
  if (Array.isArray(response.memories)) {
    for (const item of response.memories) {
      const record = asRecord(item)
      if (record.memory !== null && typeof record.memory === 'object' && !Array.isArray(record.memory) &&
          record.contentPage !== null && typeof record.contentPage === 'object' && !Array.isArray(record.contentPage)) {
        entries.push({ memory: record.memory as Record<string, unknown>, contentPage: record.contentPage as Record<string, unknown> })
      }
    }
  }
  const cost = (): number => estimateTokens(JSON.stringify(withEstimatedTokens(response), null, 2) ?? '')
  const retryableBudgetResponse = (id?: string, nextOffset?: number): unknown => {
    const retryableOffsets = entries.map(({ memory, contentPage }) => ({
      id: String(memory.id ?? ''), nextOffset: Number(contentPage.offset ?? 0),
    })).filter((item) => item.id !== '')
    for (const item of Array.isArray(response.retryableOffsets) ? response.retryableOffsets : []) {
      const row = asRecord(item)
      if (typeof row.id === 'string' && typeof row.nextOffset === 'number' && !retryableOffsets.some((current) => current.id === row.id)) {
        retryableOffsets.push({ id: row.id, nextOffset: row.nextOffset })
      }
    }
    if (id !== undefined && nextOffset !== undefined && !retryableOffsets.some((item) => item.id === id)) retryableOffsets.push({ id, nextOffset })
    const ids = [...new Set([...retryableOffsets.map((item) => item.id), ...(Array.isArray(response.omittedIds) ? response.omittedIds.filter((item): item is string => typeof item === 'string') : [])])]
    const makeFallback = (count: number): Record<string, unknown> => {
      const keptIds = ids.slice(0, count)
      const keptOffsets = retryableOffsets.filter((item) => keptIds.includes(item.id))
      return {
        status: 'budget_exceeded', omitted: true, retryable: true, metadataOnly: true, budgetTokens,
        ...(keptIds.length === 1 ? { id: keptIds[0], nextOffset: keptOffsets.find((item) => item.id === keptIds[0])?.nextOffset ?? nextOffset } : { ids: keptIds, retryableOffsets: keptOffsets }),
        ...(count < ids.length ? { remainingIds: ids.length - count } : {}),
      }
    }
    for (let count = ids.length; count > 0; count -= 1) {
      const fallback = withEstimatedTokens(makeFallback(count))
      if (estimateTokens(JSON.stringify(fallback, null, 2) ?? '') <= budgetTokens) return fallback
    }
    return withEstimatedTokens({ status: 'budget_exceeded', omitted: true, retryable: true, metadataOnly: true, budgetTokens, nextOffset: nextOffset ?? 0 })
  }
  for (const entry of [...entries].reverse()) {
    if (cost() <= budgetTokens || typeof entry.memory.content !== 'string' || entry.contentPage.revisionChanged === true) continue
    const original = entry.memory.content
    const offset = typeof entry.contentPage.offset === 'number' ? entry.contentPage.offset : 0
    const totalChars = typeof entry.contentPage.totalChars === 'number' ? entry.contentPage.totalChars : offset + original.length
    let low = 0
    let high = original.length
    let best = -1
    while (low <= high) {
      const length = Math.floor((low + high) / 2)
      entry.memory.content = original.slice(0, length)
      const nextOffset = offset + length
      if (nextOffset < totalChars) entry.contentPage.nextOffset = nextOffset
      else delete entry.contentPage.nextOffset
      if (cost() <= budgetTokens) { best = length; low = length + 1 }
      else high = length - 1
    }
    if (best < 0) return retryableBudgetResponse(typeof entry.memory.id === 'string' ? entry.memory.id : undefined, offset)
    if (best > 0 && /[\uD800-\uDBFF]/u.test(original[best - 1]!)) best -= 1
    if (best === 0 && offset < totalChars) return retryableBudgetResponse(typeof entry.memory.id === 'string' ? entry.memory.id : undefined, offset)
    entry.memory.content = original.slice(0, best)
    const nextOffset = offset + best
    if (nextOffset < totalChars) entry.contentPage.nextOffset = nextOffset
    else delete entry.contentPage.nextOffset
  }
  if (Array.isArray(response.evidence) && cost() > budgetTokens) {
    const evidence = response.evidence
    const offset = typeof response.offset === 'number' ? response.offset : 0
    response.evidenceOmitted = true
    response.nextEvidenceOffset = offset + evidence.length
    while (evidence.length > 0 && cost() > budgetTokens) {
      evidence.pop()
      response.nextEvidenceOffset = offset + evidence.length
    }
  }
  if (cost() > budgetTokens) {
    return retryableBudgetResponse()
  }
  const finalized = withEstimatedTokens(response)
  return estimateTokens(JSON.stringify(finalized, null, 2) ?? '') <= budgetTokens ? finalized : retryableBudgetResponse()
}

function tool(definition: {
  name: string
  description: string
  parameters: SchemaNode
  execute: (args: Record<string, unknown>, exec: ToolExecutionLike) => Promise<unknown>
  fit?: (value: unknown, budgetTokens: number) => unknown
}): ToolDefinitionLike {
  const parameters = {
    ...definition.parameters,
    properties: {
      ...(definition.parameters.properties ?? {}),
      budget_tokens: { type: 'integer' as const, description: 'Maximum complete response budget in estimated tokens, 128–6000. Default 1600.' },
    },
  }
  return {
    name: definition.name,
    description: definition.description,
    parameters: parameters as unknown as Record<string, unknown>,
    output: {
      schema: { type: 'object' } as unknown as Record<string, unknown>,
      render: (_args, value) => jsonRender(value),
    },
    execute: async (rawArgs, exec) => {
      const args = asRecord(rawArgs)
      const budgetTokens = optionalNumber(args, 'budget_tokens', DEFAULT_AGENT_TOOL_BUDGET, 128, MAX_AGENT_TOOL_BUDGET)
      const rawValue = await definition.execute(args, exec)
      const value = definition.fit === undefined ? rawValue : definition.fit(rawValue, budgetTokens)
      const encoded = JSON.stringify(value, null, 2)
      const estimatedTokens = estimateTokens(encoded ?? '')
      if (encoded !== undefined && estimatedTokens <= budgetTokens && encoded.length <= MAX_RENDER_CHARS) return value
      const source = asRecord(value)
      const fallback: Record<string, unknown> = { status: 'budget_exceeded', omitted: true, retryable: true, budgetTokens, stopReason: 'budget' }
      for (const key of ['id', 'nextOffset', 'retryableOffsets', 'ids', 'omittedCandidateIds', 'scanLimit', 'policyMaxCandidates', 'scanCapped'] as const) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue
        const candidate = { ...fallback, [key]: source[key] }
        if (estimateTokens(JSON.stringify(withEstimatedTokens(candidate), null, 2) ?? '') <= budgetTokens) Object.assign(fallback, { [key]: source[key] })
      }
      const finalized = withEstimatedTokens(fallback)
      if (estimateTokens(JSON.stringify(finalized, null, 2) ?? '') <= budgetTokens) return finalized
      return withEstimatedTokens({ status: 'budget_exceeded', omitted: true, retryable: true, budgetTokens })
    },
  }
}

export function registerMemoryTools(ctx: { tools?: { register(definition: ToolDefinitionLike): () => void } }, runtime: MemoryRuntime): () => void {
  const disposers: Array<() => void> = []
  const register = (definition: ToolDefinitionLike): void => {
    const disposer = ctx.tools?.register({ ...definition, execute: async (args, exec) => {
      if (exec.agent?.session == null) throw new Error('memory tools require a live Host session')
      if (!runtime.memoryUseAllowed(exec.agent?.session) && definition.name !== 'memory_propose' && definition.name !== 'memory_status') return { status: 'memory-use-disabled' }
      return definition.execute(args, exec)
    } })
    if (disposer !== undefined) disposers.push(disposer)
  }

  register(
    tool({
      name: 'memory_search',
      description:
        'Search the current profile’s visible long-term memories. Origin-qualified IDs distinguish records from different sources; a partial profile scan is reported explicitly. Explicit historical-time calls retain the legacy provenance-local compatibility reader. Results preserve effective-time labels and flag unknown or still-uncertain partial start times. Candidate scanning is bounded by the smaller of 50 and the selected strategy policy; result count is applied separately. The candidate window merges exact/keyword routes with a bounded approved relation route; supplying explicit effective_at/known_at selects the revision valid at that time and adds the temporal route (a natural-language wording is never treated as a historical timepoint). Each route is capped; scanCapped means more candidates may exist beyond the bound, while exhausted means the available candidate set was fully scanned.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short literal query; prefer names, file names, or concrete terms.' },
          scan_cursor: { type: 'string', description: 'Opaque next_scan from a previous exhausted global scan. Keep query unchanged. Start the next window at offset 0; retain this cursor for that window’s nextOffset or response-budget retries. Each request performs a fresh bounded read.' },
          limit: { type: 'integer', description: 'Maximum results, 1–20. Default 5.' },
          offset: { type: 'integer', description: 'Continuation offset from nextOffset. Default 0.' },
          effective_at: { type: 'integer', description: 'Optional explicit effective time in Unix milliseconds; selects the historical revision valid at that time. Requires the same explicit contract as memory_history.' },
          known_at: { type: 'integer', description: 'Optional explicit knowledge time in Unix milliseconds; defaults to effective_at. Only valid together with effective_at.' },
          relation_depth: { type: 'integer', description: 'Optional approved relation expansion depth, 0–2. Default 1; 0 disables the relation route.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const query = requireString(args, 'query')
        const limit = optionalNumber(args, 'limit', 5, 1, 20)
        const offset = optionalNumber(args, 'offset', 0, 0, 49)
        const effectiveAt = optionalNumber(args, 'effective_at', Number.NaN, 0, Number.MAX_SAFE_INTEGER)
        const knownAt = optionalNumber(args, 'known_at', Number.NaN, 0, Number.MAX_SAFE_INTEGER)
        if (Number.isFinite(knownAt) && !Number.isFinite(effectiveAt)) throw new Error('known_at requires effective_at')
        const relationDepth = optionalNumber(args, 'relation_depth', 1, 0, 2)
        const timeOptions: { effectiveAt?: number; knownAt?: number } = Number.isFinite(effectiveAt)
          ? { effectiveAt, ...(Number.isFinite(knownAt) ? { knownAt } : {}) }
          : {}
        const scanCursor = args.scan_cursor === undefined ? undefined : requireString(args, 'scan_cursor')
        if (scanCursor !== undefined && timeOptions.effectiveAt !== undefined) throw new Error('scan_cursor requires a current global query')
        const search = timeOptions.effectiveAt === undefined ? runtime.searchGlobalDetailed(query, 50, scanCursor, relationDepth)
          : runtime.searchCandidatesDetailed(cwdOf(exec, runtime), query, 50, { ...timeOptions, relationDepth })
        const candidates = search.candidates
        const hits = candidates.slice(offset)
        const effectiveAtNow = Number.isFinite(effectiveAt) ? effectiveAt : Date.now()
        return {
          results: hits.map((hit) => ({
            id: hit.id,
            content: hit.content,
            kind: hit.kind,
            scene: hit.scene,
            valid_from_state: hit.validFromState,
            ...(hit.validFromLabel === undefined ? {} : { valid_from: hit.validFromLabel }),
            ...(hit.validFromState === 'unknown' || hit.validFrom === undefined
              ? { temporal_note: '生效时间未知；不能据此确认当前是否生效。' }
              : hit.validFromUpper !== undefined && effectiveAtNow >= hit.validFrom && effectiveAtNow < hit.validFromUpper
                ? { temporal_note: `生效时间仅知 ${hit.validFromLabel ?? new Date(hit.validFrom).toISOString().slice(0, 10)}；当前时点仍在不确定区间。` }
                : {}),
            confidence: hit.confidence,
            score: Number(hit.score.toFixed(4)),
            updated_at: hit.updatedAt,
            ...(hit.routes === undefined ? {} : { routes: hit.routes }),
            ...(hit.temporal === undefined ? {} : { temporal_selected: true }),
          })),
          candidateCount: candidates.length,
          offset,
          resultLimit: limit,
          scanLimit: search.scanLimit,
          policyMaxCandidates: search.policyMaxCandidates,
          scanCapped: search.scanCapped,
          ...('nextScan' in search && search.nextScan !== undefined ? { next_scan: search.nextScan } : {}),
          routes: search.routes,
          candidateGaps: search.candidateGaps,
          stopReason: search.stopReason,
          temporal: search.temporal === true,
          exhausted: offset >= candidates.length && !search.scanCapped,
        }
      },
      fit: fitSearchResponse,
    }),
  )

  register(
    tool({
      name: 'memory_get',
      description: 'Read up to 12 currently approved memories under one shared response budget. Long bodies are revision-bound pages with checksum and nextOffset; a changed revision requires restarting at offset 0. If even metadata leaves no room for content, return a retryable metadata-only budget status with the affected id and unchanged offset. A single id keeps the legacy memory field and may include a small evidence page; source excerpts are withheld when any memory citing that source is not currently readable. Forgotten, expired, excluded, or candidate memories are not returned.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'One memory id, for example mem_…' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Up to 12 memory ids sharing one total response budget.' },
          offset: { type: 'integer', description: 'Character offset from the previous contentPage.nextOffset.' },
          expected_revision: { type: 'integer', description: 'Revision returned by the prior page; a mismatch returns revisionChanged and no stale body.' },
          chars: { type: 'integer', description: 'Requested page size, 100–6000 characters. Default 1400; actual size is reduced to fit the shared budget.' },
          evidence_limit: { type: 'integer', description: 'Evidence rows per page, 1–4. Default 2.' },
          evidence_offset: { type: 'integer', description: 'Continuation offset from nextEvidenceOffset. Default 0.' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : undefined
        const rawIds = args.ids
        if (id === undefined && rawIds === undefined) throw new Error('provide id or ids')
        if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((item) => typeof item !== 'string'))) throw new Error('ids must be an array of strings')
        const ids = rawIds === undefined ? [id!] : [...new Set((rawIds as string[]).map((value) => value.trim()).filter(Boolean))]
        if (ids.length < 1 || ids.length > 12) throw new Error('ids must contain 1–12 unique memory ids')
        if (id !== undefined && rawIds !== undefined && !ids.includes(id)) {
          if (ids.length >= 12) throw new Error('id plus ids must contain at most 12 unique memory ids')
          ids.unshift(id)
        }
        const expectedRevision = args.expected_revision === undefined ? undefined : optionalNumber(args, 'expected_revision', 0, 1, Number.MAX_SAFE_INTEGER)
        const details = runtime.memoryDetails(cwdOf(exec, runtime), ids, {
          offsets: id === undefined ? undefined : { [id]: optionalNumber(args, 'offset', 0, 0, 20_000_000) },
          expectedRevisions: id === undefined || expectedRevision === undefined ? undefined : { [id]: expectedRevision },
          charsPerMemory: optionalNumber(args, 'chars', 1400, 100, 6000),
          budgetTokens: optionalNumber(args, 'budget_tokens', DEFAULT_AGENT_TOOL_BUDGET, 128, MAX_AGENT_TOOL_BUDGET),
        })
        if (id !== undefined && rawIds === undefined) {
          const entry = details.memories.find((item) => item.memory.id === id)
          if (entry === undefined && details.omittedReasons[id] === 'response_budget') return {
            status: 'budget_exceeded', omitted: true, retryable: true, metadataOnly: true, id,
            nextOffset: details.retryableOffsets.find((item) => item.id === id)?.nextOffset ?? optionalNumber(args, 'offset', 0, 0, 20_000_000), budgetTokens: details.budgetTokens,
            hint: 'No content offset was consumed. Retry fewer ids, reduce chars/evidence_limit, or request a higher budget_tokens value.',
          }
          if (entry === undefined) throw new Error(`memory not found or outside current scope: ${id}`)
          const evidencePage = runtime.evidencePage(cwdOf(exec, runtime), id, optionalNumber(args, 'evidence_limit', 2, 1, 4), optionalNumber(args, 'evidence_offset', 0, 0, 1000))
          return { memory: entry.memory, contentPage: entry.contentPage, ...evidencePage, omittedIds: details.omittedIds,
            omittedReasons: details.omittedReasons, estimatedTokens: details.estimatedTokens, budgetTokens: details.budgetTokens }
        }
        return details
      },
      fit: fitMemoryGetResponse,
    }),
  )

  register(
    tool({
      name: 'memory_propose',
      description:
        'Propose one durable memory for this project. The proposal is an unapproved candidate. It is not usable in future turns until its sources and acceptance are verified; submitting this tool never approves it.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'One self-contained factual statement in the user’s language.' },
          kind: {
            type: 'string',
            enum: ['fact', 'preference', 'decision', 'project', 'next'],
            description: 'Memory category. Default fact.',
          },
          confidence: { type: 'number', description: '0–1 confidence that the statement is a real project fact. Default 0.5.' },
          valid_from: { anyOf: [
            { type: 'number', minimum: 0, description: 'Explicit effective start as Unix milliseconds.' },
            { type: 'string', description: 'Explicit effective start with precision preserved: YYYY, YYYY-MM, YYYY-MM-DD, or timezone-qualified ISO timestamp.' },
            { type: 'null', description: 'Use only when the source explicitly says the effective start is unknown.' },
          ], description: 'Omit to use the record-time default. Null explicitly means unknown; it is not replaced with now or zero.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const content = requireString(args, 'content')
        const kindRaw = args.kind
        const kind = typeof kindRaw === 'string' ? kindRaw : 'fact'
        const confidenceRaw = args.confidence
        const confidence = typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5
        const validFrom = args.valid_from === undefined ? undefined : args.valid_from === null || typeof args.valid_from === 'number' || typeof args.valid_from === 'string'
          ? args.valid_from : (() => { throw new Error('valid_from must be null, a string, or a number') })()
        const record = runtime.propose(cwdOf(exec, runtime), content, kind, confidence, validFrom)
        return { id: record.id, status: record.status, content: record.content, activatedByThisCall: false,
          ...(record.status === 'candidate' ? { usable: false, reason: 'pending_review', message: '已保存为待审核候选，尚未生效；不会自动用于其他会话。' }
            : { reason: 'existing_record', message: '返回已有记录；本次提交没有改变其审核状态或召回资格。' }) }
      },
    }),
  )

  register(
    tool({
      name: 'memory_read_raw',
      description: 'Read a page of text from a tool result offloaded to this project’s local directory. Continue with nextOffset; set chars up to 6000.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Offload id, for example off_…' },
          offset: { type: 'integer', description: 'Character offset from nextOffset. Default 0.' },
          chars: { type: 'integer', description: 'Characters per page, 100–6000. Default 900.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const id = requireString(args, 'id')
        const offset = optionalNumber(args, 'offset', 0, 0, 20_000_000)
        const chars = optionalNumber(args, 'chars', 900, 100, 6000)
        return runtime.readRawPage(cwdOf(exec, runtime), id, offset, chars)
      },
    }),
  )

  register(
    tool({
      name: 'memory_profile',
      description: 'Read the project’s current L3 persona summary and a page of its L2 scene index. The persona is derived only from approved memories; continue scenes with nextOffset.',
      parameters: { type: 'object', properties: {
        limit: { type: 'integer', description: 'Scene rows per page, 1–20. Default 8.' },
        offset: { type: 'integer', description: 'Continuation offset from nextOffset. Default 0.' },
      }, additionalProperties: false },
      async execute(args, exec) {
        return runtime.profile(cwdOf(exec, runtime), optionalNumber(args, 'limit', 8, 1, 20), optionalNumber(args, 'offset', 0, 0, 10_000))
      },
    }),
  )

  register(
    tool({
      name: 'memory_status',
      description: 'Read memory status and pending extraction state for the current project only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        const status = runtime.status(cwdOf(exec, runtime))
        return { enabled: status.enabled, mode: status.mode, projects: status.projects.map(({ key, name, stats }) => ({ key, name, stats })),
          pending: status.pending, ...(status.lastError === undefined ? {} : { lastError: status.lastError }) }
      },
    }),
  )

register(tool({
    name: 'memory_explain',
    description: 'Explain local read-only retrieval for this project: query intent, exact, lexical, bounded relation and explicit-time routes, approved candidates, source evidence, and known gaps. A source excerpt is omitted when any citing memory is not currently readable. Explicit effective_at/known_at select the historical revision at that time; natural-language wording is never treated as a timepoint. It makes no model call.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Question or phrase to explain.' },
      limit: { type: 'integer', description: 'Maximum candidates, 1–12. Default 6.' },
      offset: { type: 'integer', description: 'Continuation offset from nextOffset. Default 0.' },
      effective_at: { type: 'integer', description: 'Optional explicit effective time in Unix milliseconds.' },
      known_at: { type: 'integer', description: 'Optional explicit knowledge time in Unix milliseconds; defaults to effective_at.' },
      relation_depth: { type: 'integer', description: 'Optional approved relation expansion depth, 0–2. Default 1.' },
    }, required: ['query'], additionalProperties: false },
    async execute(args, exec) {
      const budgetTokens = optionalNumber(args, 'budget_tokens', DEFAULT_AGENT_TOOL_BUDGET, 128, MAX_AGENT_TOOL_BUDGET)
      const effectiveAt = optionalNumber(args, 'effective_at', Number.NaN, 0, Number.MAX_SAFE_INTEGER)
      const knownAt = optionalNumber(args, 'known_at', Number.NaN, 0, Number.MAX_SAFE_INTEGER)
      if (Number.isFinite(knownAt) && !Number.isFinite(effectiveAt)) throw new Error('known_at requires effective_at')
      return runtime.explainForAgent(cwdOf(exec, runtime), requireString(args, 'query'), {
        limit: optionalNumber(args, 'limit', 6, 1, 12), offset: optionalNumber(args, 'offset', 0, 0, 59), budgetTokens,
        ...(Number.isFinite(effectiveAt) ? { effectiveAt, ...(Number.isFinite(knownAt) ? { knownAt } : {}) } : {}),
        relationDepth: optionalNumber(args, 'relation_depth', 1, 0, 2),
      })
    },
  }))

  register(tool({
    name: 'memory_history',
    description: 'Read approved revisions recorded by an explicit knowledge timestamp, select the version valid at an explicit effective timestamp, and paginate the known revision history. Current approval, retention, Agent exclusion, and forget rules still apply. Continue with nextOffset.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Exact memory id.' },
      effective_at: { type: 'number', description: 'Effective time in Unix milliseconds.' },
      known_at: { type: 'number', description: 'Knowledge time in Unix milliseconds.' },
      limit: { type: 'integer', description: 'Revision rows per page, 1–100. Default 20.' },
      offset: { type: 'integer', description: 'Continuation offset from nextOffset. Default 0.' },
    }, required: ['id', 'effective_at', 'known_at'], additionalProperties: false },
    async execute(args, exec) {
      const id = requireString(args, 'id')
      const effectiveAt = optionalNumber(args, 'effective_at', NaN, 0, Number.MAX_SAFE_INTEGER)
      const knownAt = optionalNumber(args, 'known_at', NaN, 0, Number.MAX_SAFE_INTEGER)
      if (!Number.isFinite(effectiveAt) || !Number.isFinite(knownAt)) throw new Error('effective_at and known_at must be finite Unix millisecond timestamps')
      const result = runtime.history(cwdOf(exec, runtime), id, effectiveAt, knownAt,
        optionalNumber(args, 'limit', 20, 1, 100), optionalNumber(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER))
      if (result === undefined) throw new Error(`approved memory not found: ${id}`)
      return result
    },
  }))

  register(tool({
    name: 'memory_task_context',
    description: 'Read a task handoff from the current project. Context with stale memory sources is redacted; artifact references are not verified by this plugin.',
    parameters: { type: 'object', properties: { task_ref: { type: 'string', description: 'Stable task reference.' } }, required: ['task_ref'], additionalProperties: false },
    async execute(args, exec) {
      const task = runtime.taskContext(cwdOf(exec, runtime), requireString(args, 'task_ref'))
      if (task === undefined) throw new Error('task context not found in this project')
      return task
    },
  }))

  register(tool({
    name: 'memory_relations',
    description: 'Read current, revision-matched approved relations around one memory in this project.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Exact approved memory id.' }, limit: { type: 'integer', description: 'Maximum relations, 1–20. Default 6.' } }, required: ['id'], additionalProperties: false },
    async execute(args, exec) {
      return { relations: runtime.relations(cwdOf(exec, runtime), requireString(args, 'id'), optionalNumber(args, 'limit', 6, 1, 20)) }
    },
  }))

  register(tool({
    name: 'memory_experience',
    description: 'Find project-local experience cards and compare their recorded environment and prerequisites with explicitly supplied condition facts. Supply environment (known key/value facts) and optionally conditions (extra bounded facts) and satisfied_prerequisites (exact prerequisite statements the caller declares as currently satisfied). Results keep their episode, candidate, or verified status; caller-supplied conditions never upgrade a card to verified and never authorize executing its steps. Missing or omitted conditions are reported as conditions_missing with truncated=true when the bounded comparison omits stored conditions, not guessed from text similarity.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Symptom, title, or problem description.' },
      environment: { type: 'object', description: 'Known environment key/value pairs; omit unknown values.', additionalProperties: { type: 'string' } },
      conditions: { type: 'object', description: 'Optional extra explicit current condition facts, bounded to 32 keys of at most 80 characters. The legacy environment wins on a duplicate key.', additionalProperties: { type: 'string' } },
      satisfied_prerequisites: { type: 'array', items: { type: 'string' }, description: 'Prerequisite statements the caller explicitly declares as currently satisfied; matched by exact normalized text only, never by similarity.' },
      limit: { type: 'integer', description: 'Maximum results, 1–12. Default 6.' },
    }, required: ['query', 'environment'], additionalProperties: false },
    async execute(args, exec) {
      const raw = asRecord(args.environment)
      const environment: Record<string, string> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string') throw new Error('environment values must be strings')
        environment[key.slice(0, 80)] = value.slice(0, 300)
      }
      const conditions: Record<string, string> = {}
      if (args.conditions !== undefined) {
        if (args.conditions === null || typeof args.conditions !== 'object' || Array.isArray(args.conditions)) throw new Error('conditions must be an object of string values')
        for (const [key, value] of Object.entries(args.conditions as Record<string, unknown>).slice(0, 32)) {
          if (typeof value !== 'string') throw new Error('condition values must be strings')
          conditions[key.slice(0, 80)] = value.slice(0, 300)
        }
      }
      const rawSatisfied = args.satisfied_prerequisites
      if (rawSatisfied !== undefined && (!Array.isArray(rawSatisfied) || rawSatisfied.some((item) => typeof item !== 'string'))) {
        throw new Error('satisfied_prerequisites must be an array of strings')
      }
      const satisfiedPrerequisites = [...new Set(((rawSatisfied as string[] | undefined) ?? [])
        .map((item) => item.trim().slice(0, 300)).filter((item) => item !== ''))].slice(0, 32)
      return { results: runtime.experience(cwdOf(exec, runtime), requireString(args, 'query'), environment, optionalNumber(args, 'limit', 6, 1, 12),
        { conditions, satisfiedPrerequisites }) }
    },
  }))

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // Tool disposal is best-effort during plugin unload.
      }
    }
  }
}
