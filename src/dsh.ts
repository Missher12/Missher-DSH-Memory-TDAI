/**
 * Structural view of the DSH 0.2.1-rc.2 Host services this plugin consumes.
 *
 * The plugin deliberately imports no `@deepseek-ai/dsh-*` package at runtime:
 * every capability is reached through the Cordis `ctx` handed to `apply`, so
 * the bundle stays installable without a second copy of any Host package.
 *
 * @module dsh-memory-tdai/dsh
 */

export interface LoggerLike {
  debug?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export interface TextBlockLike {
  type: 'text'
  text: string
}

export interface MessageLike {
  id?: string
  role: string
  content: Array<TextBlockLike | { type: string; [key: string]: unknown }>
  source?: { kind: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface SessionHeaderLike {
  id?: string
  cwd?: string
  createdAt?: number
  agentPreset?: string
  [key: string]: unknown
}

export interface SessionLike {
  id: string
  header?: SessionHeaderLike
  requestHeader?: () => { config?: { provider?: string; model?: string }; [key: string]: unknown } | undefined
  [key: string]: unknown
}

export interface SessionEventLike {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

export interface LlmChunkLike {
  type: string
  text?: string
  index?: number
  [key: string]: unknown
}

export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: string; content: unknown }>
    maxTokens?: number
    [key: string]: unknown
  }): AsyncIterable<LlmChunkLike>
  listProviders?(): unknown
}

export interface ToolExecutionLike {
  /** The exact Agent on whose behalf the call runs. */
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
  [key: string]: unknown
}

export type JsonSchemaLike = Record<string, unknown>

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: JsonSchemaLike
  output: {
    schema: JsonSchemaLike
    render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>, exec: ToolExecutionLike) => Promise<unknown>
}

export interface AgentLike {
  id?: string
  session?: SessionLike
  ctx?: HostContextLike
  [key: string]: unknown
}

export interface HostContextLike {
  on(event: string, listener: (...args: never[]) => void): () => void
  effect(disposer: () => unknown, label?: string): void
  get(name: string): unknown
  inject(names: string[], callback: (scope: HostContextLike) => void): unknown
  logger?: LoggerLike
  tools?: { register(definition: ToolDefinitionLike): () => void }
  llm?: LlmLike
  sessions?: { get(id: string): SessionLike | undefined; list?(): SessionLike[] }
  agents?: { get(id: string): AgentLike | undefined; list?(): AgentLike[] }
  systemPrompt?: {
    section(section: { name: string; order: number; text: string }): () => void
    getSectionOrder(name: string): number
  }
}

export interface PreStepDecisionLike {
  kind: 'reject' | 'enter'
  messages?: MessageLike[]
  startsRequestSeries?: boolean
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function textOfMessage(message: MessageLike): string {
  return message.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}
