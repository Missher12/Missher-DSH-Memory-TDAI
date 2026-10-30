/** Pure, deterministic R4.1 policy helpers. No Host calls, IO or side effects. */
import { estimateTokens } from './tokens.js'

export type InputClass = 'structured' | 'correction' | 'conversation' | 'small_talk' | 'derived' | 'system' | 'unknown'
export type QueryIntent = 'lookup' | 'history' | 'decision' | 'resume' | 'experience' | 'explore' | 'unknown'

/** Only actual dialogue can become conversation evidence; an absent source supports minimal/legacy hosts. */
export function isConversationSource(sourceKind?: string | null, role?: string): boolean {
  if (role !== undefined && role !== 'user' && role !== 'assistant') return false
  if (sourceKind == null || sourceKind === '' || sourceKind === 'conversation') return true
  if (sourceKind === 'user' || sourceKind === 'user-question-reply') return role !== 'assistant'
  return sourceKind === 'model' && role !== 'user'
}

export function normalizeExactQuestion(text: string): string {
  // Only whitespace and Unicode canonical composition are normalized. Negation,
  // numbers, dates, model names, punctuation and version strings stay intact.
  return text.normalize('NFC').replace(/[\t\n\r\f\v ]+/gu, ' ').trim()
}

export function classifyInput(input: { role: string; text: string; sourceKind?: string; derivedFrom?: string[] }): { kind: InputClass; process: boolean; reason: string } {
  const sourceKind = input.sourceKind ?? ''
  if (sourceKind === 'memory' || sourceKind === 'runtime-context' ||
      (input.role === 'user' || input.role === 'assistant') && !isConversationSource(sourceKind, input.role) ||
      (input.derivedFrom?.length ?? 0) > 0) {
    return { kind: 'derived', process: false, reason: 'derived_or_injected_content' }
  }
  if (input.role !== 'user' && input.role !== 'assistant') return { kind: 'system', process: false, reason: 'unsupported_role' }
  const text = normalizeExactQuestion(input.text)
  if (text === '') return { kind: 'unknown', process: false, reason: 'empty' }
  if (input.role === 'user' && /^(?:你好|您好|hello|hi|hey|thanks|thank you|谢谢|多谢)[.!。！]?$/iu.test(text)) {
    return { kind: 'small_talk', process: false, reason: 'exact_whitelisted_greeting' }
  }
  if (/(?:不|别|不要|取消|撤回|忘掉|忘记|更正|改成|改为|改回|恢复|纠正|之前那个|刚才那个|不是|应为|应该是|撤销|纠错)|\b(?:not|don't|do not|cancel|revert|correct|change back|instead)\b/iu.test(text)) {
    return { kind: 'correction', process: true, reason: 'possible_correction_or_negation' }
  }
  if (/^\s*\{[\s\S]{2,}\}\s*$/u.test(text)) {
    try {
      const value: unknown = JSON.parse(text)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { kind: 'structured', process: true, reason: 'parseable_structured_object' }
    } catch { /* retain unknown structured text for bounded processing */ }
  }
  return { kind: 'conversation', process: true, reason: 'conservative_default' }
}

export function classifyQuery(query: string, explicit?: QueryIntent): QueryIntent {
  if (explicit !== undefined && ['lookup', 'history', 'decision', 'resume', 'experience', 'explore'].includes(explicit)) return explicit
  if (/(?:当时|那天|之前|后来|截至|在.{0,18}(?:日期|时间)|历史|何时|哪一天|当时知道|当时实际|effective_at|known_at)/iu.test(query)) return 'history'
  if (/(?:为什么|依据|影响|决定|决策|约束|导致|because|decision|depends_on)/iu.test(query)) return 'decision'
  if (/(?:继续|接着|上次的任务|待办|做到哪里|接续|resume|task_ref)/iu.test(query)) return 'resume'
  if (/(?:经验|之前怎么处理|怎么修|失败过|反例|适用|workaround|experience)/iu.test(query)) return 'experience'
  if (query.trim().length > 120 || /(?:所有|整理|梳理|比较|有哪些|之间|关系|跨项目|整体)/iu.test(query)) return 'explore'
  if (query.trim() !== '') return 'lookup'
  return 'unknown'
}

export interface BudgetItem {
  id: string
  revision: number
  content: string
  kind?: string
  validFrom?: number
  validTo?: number
  sourceIds?: string[]
  priority: number
  complete: boolean
}

export interface BudgetPacket {
  items: Array<BudgetItem & { estimatedTokens: number }>
  estimatedTokens: number
  budgetTokens: number
  truncated: boolean
  gaps: string[]
}

/** Whole-item packer; it never truncates negation, dates, versions or conditions. */
export function packEvidence(items: BudgetItem[], budgetTokens: number, wrapperTokens = 18, maxCharacters = Number.POSITIVE_INFINITY): BudgetPacket {
  const budget = Math.max(16, Math.floor(budgetTokens))
  const gaps: string[] = []
  const ordered = [...items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id) || b.revision - a.revision)
  const output: BudgetPacket['items'] = []
  let used = wrapperTokens
  let usedCharacters = 0
  for (const item of ordered) {
    if (!item.complete) { gaps.push(`${item.id}:incomplete_record`); continue }
    const body = `- [${item.id}@r${item.revision}] ${item.content}\n`
    const estimatedTokens = estimateTokens(body)
    if (used + estimatedTokens > budget) { gaps.push(`${item.id}:budget`); continue }
    if (usedCharacters + body.length > maxCharacters) { gaps.push(`${item.id}:characters`); continue }
    output.push({ ...item, estimatedTokens })
    used += estimatedTokens
    usedCharacters += body.length
  }
  return { items: output, estimatedTokens: Math.min(used, budget), budgetTokens: budget, truncated: gaps.length > 0, gaps }
}

export interface RoutedCandidate { id: string; revision: number; score: number; routes: string[]; sourceIds: string[] }

export interface RankedTextCandidate<T> { record: T; score: number; routes: string[] }

/** Shared literal/lexical retrieval used by runtime recall and local evaluation. */
export function rankTextCandidates<T extends { id: string; revision: number; content: string; sourceMessageIds: string[] }>(
  query: string,
  records: T[],
  tokenizeText: (text: string) => string[],
  maxCandidates = 60,
): RankedTextCandidate<T>[] {
  const normalizedQuery = normalizeExactQuestion(query).toLocaleLowerCase()
  if (normalizedQuery === '') return []
  const terms = [...new Set(tokenizeText(query).map((term) => term.toLocaleLowerCase()).filter((term) => term.length > 1))].slice(0, 6)
  const exact: Array<{ id: string; revision: number; score: number; sourceIds: string[] }> = []
  const lexical: Array<{ id: string; revision: number; score: number; sourceIds: string[] }> = []
  const byKey = new Map<string, T>()
  for (const record of records) {
    const content = normalizeExactQuestion(record.content).toLocaleLowerCase()
    const key = `${record.id}@${record.revision}`
    byKey.set(key, record)
    if (normalizedQuery.length >= 3 && content.includes(normalizedQuery)) {
      exact.push({ id: record.id, revision: record.revision, score: 1, sourceIds: record.sourceMessageIds })
    }
    if (terms.length > 0) {
      const matched = terms.filter((term) => content.includes(term)).length
      if (matched > 0) lexical.push({ id: record.id, revision: record.revision, score: matched / terms.length, sourceIds: record.sourceMessageIds })
    }
  }
  return mergeRouteCandidates([{ name: 'exact_phrase', candidates: exact }, { name: 'lexical', candidates: lexical }], maxCandidates)
    .flatMap((candidate) => {
      const record = byKey.get(`${candidate.id}@${candidate.revision}`)
      return record === undefined ? [] : [{ record, score: candidate.score, routes: candidate.routes }]
    })
}

/**
 * Merge route signals without treating repeated retrieval of one source as extra evidence.
 *
 * Each route has its own cap upstream; this merge only deduplicates by
 * `id@revision`, keeps the best score per route and unions source IDs. The
 * bounded route-count bonus is a relevance signal only: it never adds source
 * IDs, never marks a record as source-verified and never counts one source
 * root twice, so multi-route hits from one root gain no extra fact support.
 */
export function mergeRouteCandidates(routes: Array<{ name: string; candidates: Array<{ id: string; revision: number; score: number; sourceIds?: string[] }> }>, maxCandidates = 60): RoutedCandidate[] {
  const merged = new Map<string, { id: string; revision: number; routeScores: Map<string, number>; sourceIds: Set<string> }>()
  for (const route of routes) for (const candidate of route.candidates) {
    const key = `${candidate.id}@${candidate.revision}`
    const current = merged.get(key)
    if (current === undefined) merged.set(key, {
      id: candidate.id, revision: candidate.revision, routeScores: new Map([[route.name, candidate.score]]),
      sourceIds: new Set(candidate.sourceIds ?? []),
    })
    else {
      current.routeScores.set(route.name, Math.max(current.routeScores.get(route.name) ?? Number.NEGATIVE_INFINITY, candidate.score))
      for (const sourceId of candidate.sourceIds ?? []) current.sourceIds.add(sourceId)
    }
  }
  return [...merged.values()].map((candidate) => {
    const routeScores = [...candidate.routeScores.values()]
    const score = Math.max(...routeScores) + Math.min(0.08, Math.max(0, routeScores.length - 1) * 0.02)
    return { id: candidate.id, revision: candidate.revision, score, routes: [...candidate.routeScores.keys()].sort(), sourceIds: [...candidate.sourceIds] }
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(200, maxCandidates)))
}

export interface EnvironmentMatch {
  applicability: 'applicable' | 'partially_applicable' | 'conditions_missing' | 'known_counterexample' | 'inapplicable'
  matched: string[]
  missing: string[]
  different: Array<{ key: string; expected: string; actual: string }>
}

export interface ExperienceConditionInput {
  /** Environment keys/values recorded on the experience card. */
  expected: Record<string, string>
  /** Caller-reported current condition facts; never inferred from free text. */
  actual: Record<string, string>
  /** Free-text prerequisites recorded on the card. */
  prerequisites?: string[]
  /** Prerequisite statements the caller explicitly declares as currently satisfied (exact normalized text only). */
  satisfiedPrerequisites?: string[]
  /** Counterexamples the caller explicitly matched (for example by quoting them); an explicit signal only. */
  counterexampleMatches?: string[]
  /** Upper bound for compared environment keys; omitted environment keys or prerequisites are reported through `truncated`. */
  maxKeys?: number
}

export interface ExperienceConditionMatch extends EnvironmentMatch {
  conditionState: 'satisfied' | 'missing' | 'different' | 'unknown' | 'known_counterexample'
  satisfiedPrerequisites: string[]
  unresolvedPrerequisites: string[]
  counterexampleMatches: string[]
  truncated: boolean
}

function conditionLabel(text: string): string {
  // Caller-provided condition facts are compared by exact normalized text only.
  // No similarity, stemming or token overlap is used to decide that a
  // prerequisite or counterexample holds.
  return normalizeExactQuestion(text).toLocaleLowerCase()
}

/**
 * Deterministic, bounded condition match for an experience card.
 *
 * The caller supplies current condition facts; this function never infers a
 * condition from lexical similarity and never changes or upgrades the card
 * status. Precedence: explicit counterexample, then a fully known environment
 * mismatch, then unknown/missing conditions, then a partial mismatch, then
 * applicable only when every recorded environment key matched and every
 * recorded prerequisite was explicitly declared satisfied.
 */
export function matchExperienceConditions(input: ExperienceConditionInput): ExperienceConditionMatch {
  const maxKeys = Math.max(1, Math.min(64, Math.floor(input.maxKeys ?? 32)))
  const expectedEntries = Object.entries(input.expected).slice(0, maxKeys)
  const environmentTruncated = Object.keys(input.expected).length > maxKeys
  const environment = matchEnvironment(Object.fromEntries(expectedEntries), input.actual)
  const allPrerequisites = [...new Set((input.prerequisites ?? []).map((item) => normalizeExactQuestion(item)).filter((item) => item !== ''))]
  const prerequisitesTruncated = allPrerequisites.length > 32
  const prerequisites = allPrerequisites.slice(0, 32)
  const truncated = environmentTruncated || prerequisitesTruncated
  const satisfiedSet = new Set((input.satisfiedPrerequisites ?? []).map(conditionLabel).filter((item) => item !== ''))
  const satisfiedPrerequisites = prerequisites.filter((item) => satisfiedSet.has(conditionLabel(item)))
  const unresolvedPrerequisites = prerequisites.filter((item) => !satisfiedSet.has(conditionLabel(item)))
  const counterexampleMatches = [...new Set((input.counterexampleMatches ?? []).map((item) => normalizeExactQuestion(item)).filter((item) => item !== ''))].slice(0, 32)
  const allDifferent = !environmentTruncated && expectedEntries.length > 0 && environment.different.length === expectedEntries.length
  const nothingVerifiable = expectedEntries.length === 0 && prerequisites.length === 0
  let applicability: EnvironmentMatch['applicability']
  let conditionState: ExperienceConditionMatch['conditionState']
  if (counterexampleMatches.length > 0) {
    applicability = 'known_counterexample'
    conditionState = 'known_counterexample'
  } else if (allDifferent) {
    applicability = 'inapplicable'
    conditionState = 'different'
  } else if (nothingVerifiable) {
    applicability = 'conditions_missing'
    conditionState = 'unknown'
  } else if (unresolvedPrerequisites.length > 0 || environment.missing.length > 0) {
    applicability = 'conditions_missing'
    conditionState = 'missing'
  } else if (environment.different.length > 0) {
    applicability = 'partially_applicable'
    conditionState = 'different'
  } else if (truncated) {
    applicability = 'conditions_missing'
    conditionState = 'unknown'
  } else {
    applicability = 'applicable'
    conditionState = 'satisfied'
  }
  return { applicability, matched: environment.matched, missing: environment.missing, different: environment.different,
    conditionState, satisfiedPrerequisites, unresolvedPrerequisites, counterexampleMatches, truncated }
}

export function matchEnvironment(expected: Record<string, string>, actual: Record<string, string>, counterexampleKeys: string[] = []): EnvironmentMatch {
  const matched: string[] = []
  const missing: string[] = []
  const different: EnvironmentMatch['different'] = []
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = actual[key]
    if (actualValue === undefined || actualValue.trim() === '') missing.push(key)
    else if (actualValue === value) matched.push(key)
    else different.push({ key, expected: value, actual: actualValue })
  }
  const knownCounterexample = different.some((item) => counterexampleKeys.includes(item.key))
  let applicability: EnvironmentMatch['applicability']
  if (knownCounterexample) applicability = 'known_counterexample'
  else if (different.length === Object.keys(expected).length && Object.keys(expected).length > 0) applicability = 'inapplicable'
  else if (missing.length > 0) applicability = matched.length > 0 ? 'partially_applicable' : 'conditions_missing'
  else if (different.length > 0) applicability = 'partially_applicable'
  else applicability = 'applicable'
  return { applicability, matched, missing, different }
}

function zonedParts(timestamp: number, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

export function dateAtZone(timestamp: number, timeZone: string): string {
  const p = zonedParts(timestamp, timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function localDateStartUtc(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day || month > 12 || day > 31) throw new Error('invalid local date')
  const desiredWallTime = Date.UTC(year, month - 1, day)
  let guess = desiredWallTime
  for (let index = 0; index < 5; index += 1) {
    const p = zonedParts(guess, timeZone)
    const represented = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
    const next = desiredWallTime - (represented - guess)
    if (next === guess) break
    guess = next
  }
  return guess
}

export function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year!, month! - 1, day! + days))
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

export function dateRange(start: string, end: string, timeZone: string, maxDays = 400): Array<{ date: string; from: number; to: number }> {
  // Construct the formatter up front so unsupported zones fail before querying.
  new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  const strictDate = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('dates must use YYYY-MM-DD')
    const parsed = Date.parse(`${value}T00:00:00Z`)
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error('invalid calendar date')
    return parsed
  }
  const startMs = strictDate(start)
  const endMs = strictDate(end)
  if (startMs > endMs) throw new Error('invalid date range')
  const days = Math.floor((endMs - startMs) / 86_400_000) + 1
  if (days > maxDays) throw new Error(`date range exceeds ${maxDays} days`)
  const output: Array<{ date: string; from: number; to: number }> = []
  for (let index = 0; index < days; index += 1) {
    const date = shiftIsoDate(start, index)
    output.push({ date, from: localDateStartUtc(date, timeZone), to: localDateStartUtc(shiftIsoDate(date, 1), timeZone) })
  }
  return output
}

export function coverageForDay(from: number, to: number, windows: Array<{ startedAt: number; endedAt: number | null; status: string }>): 'covered' | 'partial' | 'unknown' {
  const matching = windows.filter((window) => window.startedAt < to && (window.endedAt === null || window.endedAt > from))
  if (matching.length === 0) return 'unknown'
  if (matching.some((window) => window.status === 'interrupted')) return 'partial'
  const intervals = matching
    .filter((window) => window.status === 'closed' || window.status === 'active')
    .map((window) => [Math.max(from, window.startedAt), Math.min(to, window.endedAt ?? Date.now())] as const)
    .sort((a, b) => a[0] - b[0])
  let cursor = from
  for (const [left, right] of intervals) {
    if (left > cursor) return 'partial'
    cursor = Math.max(cursor, right)
    if (cursor >= to) return 'covered'
  }
  return cursor > from ? 'partial' : 'unknown'
}
