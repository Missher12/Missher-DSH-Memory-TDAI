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

type SchemaNode = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  enum?: readonly string[]
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
  required?: readonly string[]
  additionalProperties?: boolean
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

function cwdOf(exec: ToolExecutionLike): string {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('memory tool requires a live session with a working directory')
  return cwd
}

function jsonRender(value: unknown): Array<{ type: 'text'; text: string }> {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated)` : text }]
}

function tool(definition: {
  name: string
  description: string
  parameters: SchemaNode
  execute: (args: Record<string, unknown>, exec: ToolExecutionLike) => Promise<unknown>
}): ToolDefinitionLike {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as unknown as Record<string, unknown>,
    output: {
      schema: { type: 'object' } as unknown as Record<string, unknown>,
      render: (_args, value) => jsonRender(value),
    },
    execute: async (args, exec) => definition.execute(asRecord(args), exec),
  }
}

export function registerMemoryTools(ctx: { tools?: { register(definition: ToolDefinitionLike): () => void } }, runtime: MemoryRuntime): () => void {
  const disposers: Array<() => void> = []
  const register = (definition: ToolDefinitionLike): void => {
    const disposer = ctx.tools?.register(definition)
    if (disposer !== undefined) disposers.push(disposer)
  }

  register(
    tool({
      name: 'memory_search',
      description:
        'Search this project’s reviewed long-term memories. Use it when the user refers to earlier work, preferences, decisions, or conventions that are not in the current context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short literal query; prefer names, file names, or concrete terms.' },
          limit: { type: 'integer', description: 'Maximum results, 1–20. Default 5.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const query = requireString(args, 'query')
        const limit = optionalNumber(args, 'limit', 5, 1, 20)
        const hits = runtime.search(cwdOf(exec), query, limit)
        return {
          results: hits.map((hit) => ({
            id: hit.id,
            content: hit.content,
            kind: hit.kind,
            scene: hit.scene,
            confidence: hit.confidence,
            score: Number(hit.score.toFixed(4)),
            updated_at: hit.updatedAt,
          })),
          total: hits.length,
        }
      },
    }),
  )

  register(
    tool({
      name: 'memory_get',
      description: 'Read one memory by its exact id, including its status and source metadata.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Memory id, for example mem_…' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const id = requireString(args, 'id')
        const record = runtime.get(cwdOf(exec), id)
        if (record === undefined) throw new Error(`memory not found: ${id}`)
        return record
      },
    }),
  )

  register(
    tool({
      name: 'memory_propose',
      description:
        'Propose one durable memory for this project. The proposal enters the review queue unless the operator configured automatic approval; it never becomes visible to future turns immediately.',
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
        const record = runtime.propose(cwdOf(exec), content, kind, confidence)
        return { id: record.id, status: record.status, content: record.content }
      },
    }),
  )

  register(
    tool({
      name: 'memory_read_raw',
      description: 'Read the full text of a tool result that was offloaded to this project’s local offload directory.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Offload id, for example off_…' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const id = requireString(args, 'id')
        return { id, text: runtime.readRaw(cwdOf(exec), id) }
      },
    }),
  )

  register(
    tool({
      name: 'memory_profile',
      description: 'Read the project’s current L3 persona summary and L2 scene index. The persona is derived only from approved memories.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        return runtime.profile(cwdOf(exec))
      },
    }),
  )

  register(
    tool({
      name: 'memory_status',
      description: 'Read this installation’s memory status: storage root, project isolation, counts, and pending extraction state.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return runtime.status()
      },
    }),
  )

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
