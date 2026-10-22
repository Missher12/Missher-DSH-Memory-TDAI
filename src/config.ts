/**
 * Runtime configuration for the TDAI-derived memory plugin.
 *
 * Every field is optional and defaulted at the plugin boundary. The profile
 * patch may override the whole object under the `memory-tdai` row.
 *
 * @module dsh-memory-tdai/config
 */

export type MemoryMode = 'review' | 'balanced' | 'auto'

export interface MemoryTdaiConfig {
  /** Master switch. @default true */
  enabled?: boolean
  /** How extracted memories become injectable. @default 'balanced' */
  mode?: MemoryMode
  /** Balanced mode threshold; >= this confidence auto-approves. @default 0.82 */
  autoApproveConfidence?: number
  /** Override the state root; default `$DSH_HOME/memory-tdai`. */
  dataDir?: string
  capture?: {
    /** Capture L0 conversation messages. @default true */
    enabled?: boolean
    /** Skip sessions whose agent preset matches one of these globs. */
    excludeAgents?: string[]
    /** Keep at most this many characters per captured message. @default 8000 */
    maxCharsPerMessage?: number
  }
  extraction?: {
    /** Run L1 extraction in the background. @default true */
    enabled?: boolean
    /** Trigger after every N completed turns. @default 3 */
    everyNConversations?: number
    /** Also trigger after this much idle time. @default 60 */
    idleSeconds?: number
    /** Upper bound for one extraction pass. @default 12 */
    maxMemoriesPerPass?: number
    /** Explicit model route. When absent the session/default route is used. */
    provider?: string
    model?: string
    /** Output-token cap for one extraction call. @default 1200 */
    maxTokens?: number
    /** Do not extract turns shorter than this many characters. @default 40 */
    minTurnChars?: number
  }
  recall?: {
    /** Inject approved memories into the next step. @default true */
    enabled?: boolean
    /** Maximum memories injected per step. @default 5 */
    maxResults?: number
    /** Approximate token budget for the injected block. @default 220 */
    maxTokens?: number
    /** Character safety cap; 0 disables it. @default 1600 */
    maxChars?: number
    /** Minimum normalized relevance score. @default 0.05 */
    minScore?: number
    /** Skip memories already injected in this session. @default true */
    dedupeSession?: boolean
    /** Include the compact L3 persona with recalled facts. @default true */
    includePersona?: boolean
  }
  retention?: {
    /** Delete L0/L1 older than this many days; 0 keeps forever. @default 0 */
    days?: number
  }
  persona?: {
    /** Opt in to a cross-project profile when a project has none. @default false */
    global?: boolean
  }
  offload?: {
    /** Replace very large text tool results with a short retrieval stub. @default true */
    enabled?: boolean
    /** Only offload results at least this many characters. @default 8000 */
    minChars?: number
    /** Refuse to store a single result larger than this; leave it inline. @default 2000000 */
    maxChars?: number
    /** Tool names that must never be offloaded. */
    excludeTools?: string[]
  }
}

export interface ResolvedConfig {
  enabled: boolean
  mode: MemoryMode
  autoApproveConfidence: number
  dataDir?: string
  capture: { enabled: boolean; excludeAgents: string[]; maxCharsPerMessage: number }
  extraction: {
    enabled: boolean
    everyNConversations: number
    idleSeconds: number
    maxMemoriesPerPass: number
    provider?: string
    model?: string
    maxTokens: number
    minTurnChars: number
  }
  recall: { enabled: boolean; maxResults: number; maxTokens: number; maxChars: number; minScore: number; dedupeSession: boolean; includePersona: boolean }
  retention: { days: number }
  persona: { global: boolean }
  offload: { enabled: boolean; minChars: number; maxChars: number; excludeTools: string[] }
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function globList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

export function resolveConfig(raw: MemoryTdaiConfig | undefined): ResolvedConfig {
  const input = raw ?? {}
  const mode: MemoryMode =
    input.mode === 'review' || input.mode === 'balanced' || input.mode === 'auto' ? input.mode : 'balanced'
  return {
    enabled: bool(input.enabled, true),
    mode,
    autoApproveConfidence: numberIn(input.autoApproveConfidence, 0.82, 0, 1),
    dataDir: typeof input.dataDir === 'string' && input.dataDir.trim() !== '' ? input.dataDir : undefined,
    capture: {
      enabled: bool(input.capture?.enabled, true),
      excludeAgents: globList(input.capture?.excludeAgents),
      maxCharsPerMessage: numberIn(input.capture?.maxCharsPerMessage, 8000, 200, 200_000),
    },
    extraction: {
      enabled: bool(input.extraction?.enabled, true),
      everyNConversations: numberIn(input.extraction?.everyNConversations, 3, 1, 100),
      idleSeconds: numberIn(input.extraction?.idleSeconds, 60, 5, 86_400),
      maxMemoriesPerPass: numberIn(input.extraction?.maxMemoriesPerPass, 12, 1, 50),
      provider: typeof input.extraction?.provider === 'string' ? input.extraction.provider : undefined,
      model: typeof input.extraction?.model === 'string' ? input.extraction.model : undefined,
      maxTokens: numberIn(input.extraction?.maxTokens, 1200, 128, 16_000),
      minTurnChars: numberIn(input.extraction?.minTurnChars, 40, 0, 100_000),
    },
    recall: {
      enabled: bool(input.recall?.enabled, true),
      maxResults: numberIn(input.recall?.maxResults, 5, 1, 20),
      maxTokens: numberIn(input.recall?.maxTokens, 220, 40, 4000),
      maxChars: numberIn(input.recall?.maxChars, 1600, 0, 20_000),
      minScore: numberIn(input.recall?.minScore, 0.05, 0, 1),
      dedupeSession: bool(input.recall?.dedupeSession, true),
      includePersona: bool(input.recall?.includePersona, true),
    },
    retention: { days: numberIn(input.retention?.days, 0, 0, 3650) },
    persona: { global: bool(input.persona?.global, false) },
    offload: {
      enabled: bool(input.offload?.enabled, true),
      minChars: numberIn(input.offload?.minChars, 8000, 500, 1_000_000),
      maxChars: numberIn(input.offload?.maxChars, 2_000_000, 10_000, 20_000_000),
      excludeTools: globList(input.offload?.excludeTools),
    },
  }
}
