/**
 * Background L1 extraction through the Host LLM service.
 *
 * The DSH loop owns model routing and credentials. This module only asks
 * `ctx.llm.stream` for a text response and parses a bounded JSON payload; it
 * never persists raw provider traces or credentials.
 *
 * @module dsh-memory-tdai/extract
 */

import type { HostContextLike, LlmLike, SessionLike } from './dsh.js'
import type { ResolvedConfig } from './config.js'
import { buildL1UserPrompt, systemPromptFor } from './prompts.js'

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'project' | 'next' | string

export interface ExtractedMemory {
  content: string
  kind: MemoryKind
  confidence: number
  scene?: string
  sourceMessageIds: string[]
}

export interface Route {
  provider: string
  model: string
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
  try {
    const defaults = ctx.get('agentDefaultModel') as { current?: () => { provider?: string; model?: string } } | undefined
    const current = defaults?.current?.()
    if (current?.provider && current?.model) return { provider: current.provider, model: current.model }
  } catch {
    // The default-model service is optional in custom compositions.
  }
  return undefined
}

export function formatConversation(entries: ConversationEntry[]): string {
  return entries
    .map((entry) => `[${entry.id}] ${entry.role}: ${entry.content.replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line.length > 8)
    .join('\n')
}

export function parseExtractionJson(text: string): ExtractedMemory[] {
  const trimmed = text.trim()
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
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)
      ? (parsed as { memories: unknown[] }).memories
      : []
  const output: ExtractedMemory[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.replace(/\s+/g, ' ').trim() : ''
    if (content.length < 4 || content.length > 2000) continue
    const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : 0.5
    const confidence = Math.min(1, Math.max(0, confidenceRaw))
    const kindRaw = typeof record.kind === 'string' ? record.kind : 'fact'
    const kind = VALID_KINDS.has(kindRaw) ? kindRaw : 'fact'
    const scene = typeof record.scene === 'string' && record.scene.trim() !== '' ? record.scene.trim().slice(0, 120) : undefined
    const sourceMessageIds = Array.isArray(record.source_message_ids)
      ? record.source_message_ids.filter((value): value is string => typeof value === 'string').slice(0, 12)
      : []
    output.push({ content, kind, confidence, scene, sourceMessageIds })
  }
  return output.slice(0, 50)
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
  const messages = [
    { role: 'system', content: [{ type: 'text', text: systemPromptFor(maxMemories) }] },
    { role: 'user', content: [{ type: 'text', text: buildL1UserPrompt(conversation, maxMemories, existing) }] },
  ]
  return requestText(llm, route, messages, maxTokens, signal)
}

/** Run one text-only Host model call and return the joined text deltas. */
export async function requestText(
  llm: LlmLike,
  route: Route,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  let text = ''
  let failure: string | undefined
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    maxTokens,
    ...(signal === undefined ? {} : { signal }),
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk.type === 'finish') {
      const reason = chunk.reason as { kind?: string; failure?: { code?: string; message?: string } } | undefined
      if (reason?.kind === 'error') {
        failure = reason.failure?.code ?? reason.failure?.message ?? 'LLM stream failed'
      }
    }
  }
  if (failure !== undefined) throw new Error(`memory extraction failed: ${failure}`)
  return text
}
