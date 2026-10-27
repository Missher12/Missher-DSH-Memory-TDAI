/**
 * Background L1 extraction through the Host LLM service.
 *
 * The DSH loop owns model routing and credentials. This module only asks
 * `ctx.llm.stream` for a text response and parses a bounded JSON payload; it
 * never persists raw provider traces or credentials.
 *
 * @module dsh-memory-tdai/extract
 */

import { createHash } from 'node:crypto'
import type { HostContextLike, LlmLike, SessionLike } from './dsh.js'
import type { ResolvedConfig } from './config.js'
import { buildL1UserPrompt, systemPromptFor } from './prompts.js'
import { normalizeEffectiveStart } from './temporal.js'

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'project' | 'next' | string

export interface ExtractedMemory {
  /** Explicit conflict with another source; never automatically approve. */
  hasConflict?: boolean
  content: string
  kind: MemoryKind
  confidence: number
  scene?: string
  sourceMessageIds: string[]
  /** Omitted uses the record-time policy; null means the source explicitly says the start is unknown. */
  validFrom?: number | string | null
}

export interface Route {
  provider: string
  model: string
}

export interface ObservedUsage {
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  costMicros: number | null
}

export type StreamTerminal = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' | 'missing-finish' | 'stream-error'

export interface ExtractionStreamResult {
  ok: boolean
  text: string
  usage: ObservedUsage
  terminal: StreamTerminal
  error?: string
}

export function requestIdentityHash(route: Route, messages: Array<{ role: string; content: unknown }>, maxTokens: number): string {
  return createHash('sha256').update(JSON.stringify({ provider: route.provider, model: route.model, maxTokens, messages })).digest('hex')
}

export function extractionRequestIdentityHash(route: Route, conversation: string, maxMemories: number, existing: string[], maxTokens: number): string {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: systemPromptFor(maxMemories) }] },
    { role: 'user', content: [{ type: 'text', text: buildL1UserPrompt(conversation, maxMemories, existing) }] },
  ]
  return requestIdentityHash(route, messages, maxTokens)
}

export class ObservedStreamError extends Error {
  constructor(message: string, readonly usage: ObservedUsage, readonly terminal: StreamTerminal) {
    super(message)
    this.name = 'ObservedStreamError'
  }
}

export interface ConversationEntry {
  id: string
  role: string
  content: string
  createdAt: number
  /** Local L0 row id; used to mark the row consumed after extraction. */
  l0Id?: string
}

const VALID_KINDS = new Set(['fact', 'preference', 'decision', 'project', 'next'])

export function routeFromHost(ctx: HostContextLike, session: SessionLike | undefined, config: ResolvedConfig): Route | undefined {
  // A provider default can change between capture and dispatch. Only an
  // explicit plugin route or the session's committed request route is safe to
  // freeze into a durable extraction job.
  void ctx
  if (config.extraction.provider && config.extraction.model) {
    return { provider: config.extraction.provider, model: config.extraction.model }
  }
  try {
    const headerRoute = session?.requestHeader?.()?.config
    if (headerRoute?.provider && headerRoute?.model) {
      return { provider: headerRoute.provider, model: headerRoute.model }
    }
  } catch {
    // A session without a committed request header is normal before the first call.
  }
  return undefined
}

export function formatConversation(entries: ConversationEntry[]): string {
  return entries
    .map((entry) => `[${entry.id}] ${entry.role}: ${entry.content.replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line.length > 8)
    .join('\n')
}

/**
 * Result of parsing one extraction response.
 *
 * A `{ok: false}` outcome is a protocol violation (unparseable JSON, a
 * response that does not carry a `memories` array, or a non-empty array whose
 * items are all damaged — `null`, non-objects, or entries without a non-empty
 * string `content`). It must never be treated as a legal empty extraction: the
 * caller keeps the L0 rows pending instead of marking them consumed. A
 * `{ok: true, memories: []}` outcome is a legal empty answer (the model
 * understood the task and found nothing worth keeping).
 */
export type ExtractionParseResult =
  | { ok: true; memories: ExtractedMemory[] }
  | { ok: false; reason: 'invalid-json' | 'invalid-shape' | 'invalid-items' }

export function parseExtractionJson(text: string): ExtractionParseResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, reason: 'invalid-json' }
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { memories?: unknown }).memories)
      ? (parsed as { memories: unknown[] }).memories
      : undefined
  if (list === undefined) return { ok: false, reason: 'invalid-shape' }
  const output: ExtractedMemory[] = []
  // "Damaged" items are protocol garbage (not an object, or without a non-empty
  // string content). `{memories:[]}` stays legal; a non-empty array whose items
  // are ALL damaged must fail like any other off-protocol payload instead of
  // silently becoming a legal empty result and consuming the batch. Valid items
  // that merely fail per-field filtering (e.g. too-short content) keep the
  // existing lenient behavior.
  let damaged = 0
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      damaged += 1
      continue
    }
    const record = item as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.replace(/\s+/g, ' ').trim() : ''
    if (content === '') {
      damaged += 1
      continue
    }
    if (content.length < 4 || content.length > 2000) continue
    if (Object.prototype.hasOwnProperty.call(record, 'has_conflict') && typeof record.has_conflict !== 'boolean') return { ok: false, reason: 'invalid-items' }
    if (typeof record.confidence === 'number' && !Number.isFinite(record.confidence)) return { ok: false, reason: 'invalid-items' }
    const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : 0.5
    const confidence = Math.min(1, Math.max(0, confidenceRaw))
    const kindRaw = typeof record.kind === 'string' ? record.kind : 'fact'
    const kind = VALID_KINDS.has(kindRaw) ? kindRaw : 'fact'
    const scene = typeof record.scene === 'string' && record.scene.trim() !== '' ? record.scene.trim().slice(0, 120) : undefined
    const sourceMessageIds = Array.isArray(record.source_message_ids)
      ? record.source_message_ids.filter((value): value is string => typeof value === 'string').slice(0, 12)
      : []
    let validFrom: number | string | null | undefined
    if (Object.prototype.hasOwnProperty.call(record, 'valid_from')) {
      const rawValidFrom = record.valid_from
      if (rawValidFrom !== null && typeof rawValidFrom !== 'number' && typeof rawValidFrom !== 'string') return { ok: false, reason: 'invalid-items' }
      try { normalizeEffectiveStart(rawValidFrom, 1) } catch { return { ok: false, reason: 'invalid-items' } }
      validFrom = rawValidFrom
    }
    output.push({ content, kind, confidence, scene, sourceMessageIds, ...(typeof record.has_conflict === 'boolean' ? { hasConflict: record.has_conflict } : {}), ...(validFrom === undefined && !Object.prototype.hasOwnProperty.call(record, 'valid_from') ? {} : { validFrom }) })
  }
  if (list.length > 0 && damaged === list.length) return { ok: false, reason: 'invalid-items' }
  return { ok: true, memories: output.slice(0, 50) }
}

export async function requestExtraction(
  llm: LlmLike,
  route: Route,
  conversation: string,
  maxMemories: number,
  existing: string[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await requestExtractionDetailed(llm, route, conversation, maxMemories, existing, maxTokens, signal)
  if (!result.ok) throw new ObservedStreamError(result.error ?? `incomplete extraction stream (${result.terminal})`, result.usage, result.terminal)
  return result.text
}

export async function requestExtractionDetailed(
  llm: LlmLike,
  route: Route,
  conversation: string,
  maxMemories: number,
  existing: string[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<ExtractionStreamResult> {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: systemPromptFor(maxMemories) }] },
    { role: 'user', content: [{ type: 'text', text: buildL1UserPrompt(conversation, maxMemories, existing) }] },
  ]
  return collectTextStream(llm, route, messages, maxTokens, signal)
}

/** Run one text-only Host model call and return the joined text deltas. */
export async function requestText(
  llm: LlmLike,
  route: Route,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  return (await requestTextDetailed(llm, route, messages, maxTokens, signal)).text
}

export async function requestTextDetailed(
  llm: LlmLike,
  route: Route,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ text: string; usage: ObservedUsage }> {
  const result = await collectTextStream(llm, route, messages, maxTokens, signal)
  if (!result.ok) throw new ObservedStreamError(result.error ?? `incomplete LLM stream (${result.terminal})`, result.usage, result.terminal)
  return { text: result.text, usage: result.usage }
}

async function collectTextStream(
  llm: LlmLike,
  route: Route,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<ExtractionStreamResult> {
  let text = ''
  let finish: { kind?: string; failure?: { code?: string; message?: string }; usage?: unknown } | undefined
  let streamFailure: string | undefined
  const usage: ObservedUsage = {
    inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: null, costMicros: null,
  }
  const numberField = (record: Record<string, unknown>, names: string[]): number | null => {
    for (const name of names) {
      const value = record[name]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
    }
    return null
  }
  const absorbUsage = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const fields: Array<[keyof ObservedUsage, string[]]> = [
      ['inputTokens', ['inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens']],
      ['outputTokens', ['outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens']],
      ['cachedInputTokens', ['cachedInputTokens', 'cached_input_tokens', 'cached_tokens']],
      ['cacheReadTokens', ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens']],
      ['cacheWriteTokens', ['cacheWriteTokens', 'cache_write_tokens']],
      ['reasoningTokens', ['reasoningTokens', 'reasoning_tokens']],
      ['costMicros', ['costMicros', 'cost_micros']],
    ]
    for (const [field, aliases] of fields) {
      const value = numberField(record, aliases)
      if (value !== null) usage[field] = value
    }
  }
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens,
      ...(signal === undefined ? {} : { signal }),
    })) {
      const record = chunk as unknown as Record<string, unknown>
      if (chunk.type === 'usage') absorbUsage(record.usage)
      else absorbUsage(chunk)
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish') {
        finish = chunk.reason as typeof finish
        absorbUsage(finish?.usage)
      }
    }
  } catch (error) {
    streamFailure = error instanceof Error ? error.message : String(error)
  }
  let terminal: StreamTerminal
  if (streamFailure !== undefined) terminal = signal?.aborted === true ? 'aborted' : 'stream-error'
  else if (finish?.kind === 'stop') terminal = 'stop'
  else if (finish?.kind === 'tool-calls') terminal = 'tool-calls'
  else if (finish?.kind === 'max-tokens') terminal = 'max-tokens'
  else if (finish?.kind === 'aborted') terminal = 'aborted'
  else if (finish?.kind === 'error') terminal = 'error'
  else terminal = 'missing-finish'
  const error = streamFailure ?? (finish?.failure?.code ?? finish?.failure?.message) ?? (terminal === 'stop' ? undefined : `stream ended with ${terminal}`)
  return { ok: terminal === 'stop', text, usage, terminal, ...(error === undefined ? {} : { error }) }
}
