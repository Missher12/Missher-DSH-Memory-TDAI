/**
 * Wire contract for the Settings dashboard.
 *
 * The descriptors are authored manually so the plugin can expose a small,
 * stable RPC surface without running the Typert build generator.
 *
 * @module dsh-memory-tdai/remote-contract
 */

import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const PACKAGE = 'dsh-memory-tdai'
export const SERVICE = 'memoryTdai'

export const MemoryViewSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    kind: z.string(),
    scene: z.string().optional(),
    confidence: z.number(),
    status: z.enum(['candidate', 'approved', 'forgotten']),
    source: z.string(),
    sourceMessageIds: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
    approvedAt: z.number().optional(),
    forgottenAt: z.number().optional(),
    projectKey: z.string(),
    projectName: z.string(),
  })
  .strict()

export const ActivityDaySchema = z
  .object({
    date: z.string(),
    captures: z.number(),
    memories: z.number(),
    recalls: z.number(),
  })
  .strict()

export const SceneViewSchema = z
  .object({
    name: z.string(),
    summary: z.string(),
    memoryCount: z.number(),
    updatedAt: z.number(),
    projectKey: z.string(),
    projectName: z.string(),
  })
  .strict()

export const PersonaViewSchema = z
  .object({
    content: z.string(),
    sourceCount: z.number(),
    updatedAt: z.number(),
    projectKey: z.string(),
    projectName: z.string(),
  })
  .strict()

export const GlobalPersonaViewSchema = z
  .object({
    content: z.string(),
    sourceCount: z.number(),
    updatedAt: z.number(),
  })
  .strict()

export const DashboardSnapshotSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.number(),
    root: z.string(),
    mode: z.string(),
    totals: z
      .object({
        memories: z.number(),
        approved: z.number(),
        candidates: z.number(),
        forgotten: z.number(),
        sessions: z.number(),
        projects: z.number(),
        l0Messages: z.number(),
        repeatedQuestions: z.number(),
        injectedCount: z.number(),
        injectedTokens: z.number(),
        rawTokens: z.number(),
        savedTokens: z.number(),
      })
      .strict(),
    sources: z.array(z.object({ source: z.string(), count: z.number() }).strict()),
    activity: z.array(ActivityDaySchema),
    projects: z.array(
      z
        .object({
          key: z.string(),
          name: z.string(),
          cwd: z.string(),
          memories: z.number(),
          approved: z.number(),
          candidates: z.number(),
          sessions: z.number(),
          lastActivity: z.number(),
        })
        .strict(),
    ),
    candidates: z.array(MemoryViewSchema),
    recent: z.array(MemoryViewSchema),
    scenes: z.array(SceneViewSchema),
    personas: z.array(PersonaViewSchema),
    globalPersona: GlobalPersonaViewSchema.nullable(),
    longestSession: z
      .object({ sessionId: z.string(), messages: z.number(), projectName: z.string() })
      .strict()
      .nullable(),
    settings: z
      .object({
        mode: z.string(),
        recallMaxTokens: z.number(),
        recallMaxResults: z.number(),
        dedupeSession: z.boolean(),
        includePersona: z.boolean(),
        globalPersona: z.boolean(),
        extractionEveryN: z.number(),
        autoApproveConfidence: z.number(),
      })
      .strict(),
    lastError: z.string().optional(),
  })
  .strict()

export const ReviewRequestSchema = z
  .object({
    projectKey: z.string().min(1),
    id: z.string().min(1),
    action: z.enum(['approve', 'forget']),
  })
  .strict()

export const UpdateSettingsRequestSchema = z
  .object({
    mode: z.enum(['review', 'balanced', 'auto']).optional(),
    recallMaxTokens: z.number().int().min(40).max(4000).optional(),
    dedupeSession: z.boolean().optional(),
    includePersona: z.boolean().optional(),
    globalPersona: z.boolean().optional(),
    extractionEveryN: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const ExportRequestSchema = z.object({ projectKey: z.string().min(1) }).strict()
export const ExportResultSchema = z.object({ fileName: z.string(), content: z.string() }).strict()
export const RefreshPersonaRequestSchema = z.object({ projectKey: z.string().min(1) }).strict()

export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>
export type MemoryView = z.infer<typeof MemoryViewSchema>
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>
export type ExportRequest = z.infer<typeof ExportRequestSchema>
export type ExportResult = z.infer<typeof ExportResultSchema>
export type RefreshPersonaRequest = z.infer<typeof RefreshPersonaRequestSchema>

function strictCodec(typeSymbol: string, schema: z.ZodType): InvocationDescriptor['result'] {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => schema,
  }
}

export const invocationDescriptors = Object.freeze([
  {
    id: `${PACKAGE}#${SERVICE}/snapshot`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'snapshot',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: strictCodec(`${PACKAGE}#DashboardSnapshot`, DashboardSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/review`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'review',
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#ReviewRequest`, ReviewRequestSchema),
    }],
    result: strictCodec(`${PACKAGE}#DashboardSnapshot`, DashboardSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/updateSettings`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'updateSettings',
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#UpdateSettingsRequest`, UpdateSettingsRequestSchema),
    }],
    result: strictCodec(`${PACKAGE}#DashboardSnapshot`, DashboardSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/export`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'export',
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#ExportRequest`, ExportRequestSchema),
    }],
    result: strictCodec(`${PACKAGE}#ExportResult`, ExportResultSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/refreshPersona`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'refreshPersona',
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#RefreshPersonaRequest`, RefreshPersonaRequestSchema),
    }],
    result: strictCodec(`${PACKAGE}#DashboardSnapshot`, DashboardSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/refreshGlobalPersona`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'refreshGlobalPersona',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: strictCodec(`${PACKAGE}#DashboardSnapshot`, DashboardSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
])
