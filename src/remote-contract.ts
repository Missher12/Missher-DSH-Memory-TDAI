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
import { isValidProjectKey, MAX_PROJECT_KEY_LENGTH } from './project-key.js'

export const PACKAGE = '@missher/dsh-memory-tdai'
export const SERVICE = 'memoryTdai'

/**
 * Shared wire validation for a project key. It mirrors the store path guard:
 * traversal/absolute/separator-like keys are refused up front, while legitimate
 * non-ASCII keys (for example Chinese project basenames) keep working.
 */
export const ProjectKeySchema = z
  .string()
  .min(1)
  .max(MAX_PROJECT_KEY_LENGTH)
  .refine((value) => isValidProjectKey(value), { message: 'invalid project key' })

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
    revision: z.number(),
    validFrom: z.number().optional(),
    validFromState: z.enum(['known', 'unknown']),
    validFromPrecision: z.enum(['instant', 'second', 'minute', 'day', 'month', 'year', 'unknown']),
    validFromBasis: z.enum(['default_record_time', 'explicit', 'explicit_unknown']),
    validFromUpper: z.number().optional(),
    validFromLabel: z.string().optional(),
    temporalUncertainAt: z.boolean().optional(),
    validTo: z.number().optional(),
    recordedAt: z.number(),
    supersededAt: z.number().optional(),
    sourceVerified: z.boolean(),
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
    sourceIds: z.array(z.string()),
    sourceRevisions: z.record(z.string(), z.number().int().positive()),
    summaryComplete: z.boolean(),
  })
  .strict()

export const PersonaViewSchema = z
  .object({
    content: z.string(),
    sourceCount: z.number(),
    updatedAt: z.number(),
    /** True when a source memory was forgotten after generation. */
    stale: z.boolean(),
    projectKey: z.string(),
    projectName: z.string(),
  })
  .strict()

export const GlobalPersonaViewSchema = z
  .object({
    content: z.string(),
    sourceCount: z.number(),
    updatedAt: z.number(),
    /** True when a source memory was forgotten after generation. */
    stale: z.boolean(),
  })
  .strict()

export const DashboardSnapshotSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.number(),
    root: z.string(),
    mode: z.string(),
    activeProjectKey: ProjectKeySchema.optional(),
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
        extractionEnabled: z.boolean(),
        characterEnabled: z.boolean(),
        characterDescription: z.string(),
      })
      .strict(),
    lastError: z.string().optional(),
  })
  .strict()

export const ReviewRequestSchema = z
  .object({
    projectKey: ProjectKeySchema,
    id: z.string().min(1),
    action: z.enum(['approve', 'forget']),
  })
  .strict()

export const UpdateSettingsRequestSchema = z
  .object({
    generateMemory: z.boolean().optional(),
    useMemory: z.boolean().optional(),
    mode: z.enum(['review', 'balanced', 'auto']).optional(),
    recallMaxTokens: z.number().int().min(40).max(4000).optional(),
    dedupeSession: z.boolean().optional(),
    includePersona: z.boolean().optional(),
    globalPersona: z.boolean().optional(),
    extractionEveryN: z.number().int().min(1).max(100).optional(),
    extractionEnabled: z.boolean().optional(),
    extractionProvider: z.string().max(160).optional(),
    extractionModel: z.string().max(240).optional(),
    characterEnabled: z.boolean().optional(),
    characterDescription: z.string().max(400).optional(),
  })
  .strict()

export const ExportRequestSchema = z.object({ projectKey: ProjectKeySchema }).strict()
export const ExportResultSchema = z.object({ fileName: z.string(), content: z.string() }).strict()
export const RefreshPersonaRequestSchema = z.object({ projectKey: ProjectKeySchema }).strict()

export const OverviewRequestSchema = z.object({
  projectKey: ProjectKeySchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  timeZone: z.string().min(1).max(128),
  activity: z.enum(['capture', 'recall', 'revision', 'initial_approval', 'injection']),
}).strict()

const ActivityOverviewDaySchema = z.object({
  date: z.string(), captures: z.number(), recalls: z.number(), recallRequests: z.number(), revisions: z.number(), initialApprovals: z.number(),
  preparedInjections: z.number(), preparedInjectionEvents: z.number(),
  coverage: z.enum(['covered', 'partial', 'unknown']),
}).strict()

export const OverviewResultSchema = z.object({
  project: z.object({ key: ProjectKeySchema, name: z.string() }).strict(),
  generatedAt: z.number(), timezone: z.string(),
  range: z.object({ from: z.string(), to: z.string(), maxDays: z.number() }).strict(),
  current: z.object({ effectiveMemories: z.number(), candidates: z.number() }).strict(),
  period: z.object({
    captures: z.number(), sessions: z.number(), unknownSessionEvents: z.number(), recallRequests: z.number(), recallResults: z.number(),
    acceptedRevisions: z.number(), initialApprovals: z.number(), unknownAgentEvents: z.number(), unknownAgentPresetEvents: z.number(),
    preparedInjectionEvents: z.number(), preparedInjectionMemories: z.number(), repeatedTotal: z.number(),
    recordedOriginalMessageLowerBound: z.number().int().nonnegative().optional(),
    unknownOriginalMessageEvents: z.number().int().nonnegative().optional(),
    sources: z.array(z.object({ source: z.string(), count: z.number(), other: z.boolean().optional() }).strict()),
    agents: z.array(z.object({ agentId: z.string(), count: z.number(), other: z.boolean().optional() }).strict()),
    agentPresets: z.array(z.object({ agentPreset: z.string(), count: z.number(), other: z.boolean().optional() }).strict()),
    providers: z.array(z.object({ provider: z.string(), count: z.number(), other: z.boolean().optional() }).strict()),
    models: z.array(z.object({ model: z.string(), count: z.number(), other: z.boolean().optional() }).strict()),
    repeated: z.array(z.object({ fingerprint: z.string(), repeatCount: z.number() }).strict()),
    longestSession: z.object({ sessionId: z.string(), messages: z.number() }).strict().nullable(),
    mostLinkedL0Session: z.object({ sessionId: z.string(), linkedL0Messages: z.number(), originalMessageCount: z.null(), events: z.number(),
      recordedOriginalMessageLowerBound: z.number().int().nonnegative().optional(), unknownOriginalMessageEvents: z.number().int().nonnegative().optional() }).strict().nullable().optional(),
    topSessions: z.array(z.object({ sessionId: z.string(), messages: z.number().optional(), events: z.number(),
      linkedL0Messages: z.number().optional(), originalMessageCount: z.null().optional(),
      recordedOriginalMessageLowerBound: z.number().int().nonnegative().optional(), unknownOriginalMessageEvents: z.number().int().nonnegative().optional() }).strict()),
    activity: z.array(ActivityOverviewDaySchema),
  }).strict(),
  usage: z.object({
    inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cacheReadTokens: z.number().nullable(),
    cacheWriteTokens: z.number().nullable(), reasoningTokens: z.number().nullable(), costMicros: z.number().nullable(),
    knownAttempts: z.number(), unknownAttempts: z.number(), preparedInjectionTokensEstimate: z.number(),
    actualInjectionReceipt: z.literal('unavailable'), comparableNetSavings: z.literal('unavailable'),
    byModel: z.array(z.object({ provider: z.string(), model: z.string(), calls: z.number(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), unknownCalls: z.number(), other: z.boolean().optional() }).strict()),
    byPurpose: z.array(z.object({ purpose: z.string(), calls: z.number(), tokens: z.number().nullable(), unknownCalls: z.number(), other: z.boolean().optional() }).strict()),
  }).strict(),
  processing: z.object({
    queued: z.number(), oldestWaitingAt: z.number().nullable(), failed: z.number(), uncertainUsage: z.number(),
    jobs: z.array(z.object({ id: z.string(), status: z.enum(['queued', 'ready', 'dispatching', 'result_ready', 'completed', 'failed', 'source_pruned', 'uncertain_remote', 'blocked_charged', 'superseded']),
      updatedAt: z.number(), provider: z.string().optional(), model: z.string().optional(), hasError: z.boolean(), error: z.string().optional() }).strict()),
  }).strict(),
  coverage: z.object({
    status: z.enum(['covered', 'partial', 'unknown']),
    windows: z.array(z.object({ id: z.number(), startedAt: z.number(), endedAt: z.number().nullable(), status: z.enum(['active', 'closed', 'interrupted']), policyRevision: z.string() }).strict()),
  }).strict(),
}).strict()

export const ExplainRequestSchema = z.object({ projectKey: ProjectKeySchema, query: z.string().min(1).max(4000), limit: z.number().int().min(1).max(12).optional() }).strict()
export const ExplainResultSchema = z.object({
  project: z.object({ key: ProjectKeySchema, name: z.string() }).strict(), intent: z.string(), normalizedQuestion: z.string(),
  routes: z.array(z.object({ name: z.string(), candidateCount: z.number() }).strict()),
  candidates: z.array(z.object({ id: z.string(), revision: z.number(), content: z.string(), kind: z.string(), validFrom: z.number().optional(),
    validFromState: z.enum(['known', 'unknown']).optional(), validFromPrecision: z.enum(['instant', 'second', 'minute', 'day', 'month', 'year', 'unknown']).optional(),
    validFromBasis: z.enum(['default_record_time', 'explicit', 'explicit_unknown']).optional(), validFromUpper: z.number().optional(), validFromLabel: z.string().optional(),
    temporalUncertainAt: z.boolean().optional(), validTo: z.number().optional(),
    score: z.number(), routes: z.array(z.string()), sourceIds: z.array(z.string()), evidence: z.array(z.object({ id: z.string(), role: z.string(), createdAt: z.number(), excerpt: z.string() }).strict()),
  }).strict()), gaps: z.array(z.string()),
}).strict()

export const LibraryRequestSchema = z.object({
  projectKey: ProjectKeySchema,
  status: z.enum(['candidate', 'approved', 'forgotten']).optional(),
  after: z.object({ createdAt: z.number(), id: z.string().min(1) }).strict().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export const LibraryResultSchema = z.object({
  project: z.object({ key: ProjectKeySchema, name: z.string() }).strict(),
  records: z.array(MemoryViewSchema),
  next: z.object({ createdAt: z.number(), id: z.string() }).strict().optional(),
}).strict()

export const ManageRequestSchema = z.object({
  projectKey: ProjectKeySchema,
  operation: z.enum([
    'task.list', 'task.save', 'experience.list', 'experience.save', 'experience.review', 'experience.counterexample',
    'revision.list', 'revision.propose', 'revision.review', 'relation.list', 'relation.repairs', 'relation.repair.propose', 'relation.propose', 'relation.review',
    'decision.impact', 'knowledge.list', 'knowledge.detail', 'knowledge.history', 'evaluation.list', 'evaluation.save', 'evaluation.run',
    'strategy.list', 'strategy.propose', 'strategy.shadow', 'strategy.select', 'strategy.rollback',
    'attempt.list', 'attempt.reviewUnknown', 'billable.list', 'billable.reviewUnknown', 'billable.reconcileUsage', 'billable.summary', 'overview.detail',
    'overview.repeated', 'processing.jobs', 'processing.coverage', 'processing.recover',
    'source.revoke.preview', 'source.revoke', 'content.delete.inventory', 'content.delete.preview', 'content.delete.apply',
    'recovery.snapshot', 'recovery.list', 'recovery.plan', 'recovery.apply',
    'v7.forget', 'v7.approve',
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict()
export const ManageResultSchema = z.object({ data: z.unknown() }).strict()

const DashboardReadActivitySchema = z.enum(['capture', 'recall', 'revision', 'initial_approval', 'injection'])
const DashboardReadStatusSchema = z.enum(['candidate', 'approved', 'forgotten'])
const DashboardReadRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  timeZone: z.string().min(1).max(128),
  activity: DashboardReadActivitySchema,
}).strict()

/**
 * Combined repeated-capture filters. Values are the same bounded scalars used
 * by the overview dimensions; the literal `unknown` selects rows whose bounded
 * projection is missing, empty, or over length. Every supplied filter must
 * match the same capture event.
 */
const ReadDashboardRepeatedFiltersSchema = z.object({
  agentId: z.string().min(1).max(512).optional(),
  agentPreset: z.string().min(1).max(512).optional(),
  source: z.string().min(1).max(512).optional(),
}).strict()

/** Stable ranking key: repeatCount DESC, fingerprint ASC, projectKey ASC. */
const ReadDashboardRepeatedRankSchema = z.object({
  repeatCount: z.number().int().nonnegative(),
  fingerprint: z.string().min(1).max(512),
  projectKey: ProjectKeySchema,
}).strict()

export const ReadDashboardRepeatedGroupSchema = z.object({
  projectKey: ProjectKeySchema, projectName: z.string().max(256),
  fingerprint: z.string().min(1).max(512),
  repeatCount: z.number().int().nonnegative(),
  eventCount: z.number().int().positive(),
}).strict()

export const ReadDashboardRepeatedEventSchema = z.object({
  id: z.number().int().positive(), type: z.literal('capture'), eventId: z.string().max(2048).optional(),
  createdAt: z.number().int().nonnegative(), projectKey: ProjectKeySchema,
  sourceId: z.string().max(256).optional(), sourceEventId: z.string().max(2000).optional(),
  sessionId: z.string().max(512).optional(), source: z.string().max(512).optional(),
  agentId: z.string().max(512).optional(), agentPreset: z.string().max(512).optional(),
  provider: z.string().max(256).optional(), model: z.string().max(256).optional(),
  fingerprint: z.string().max(512).optional(),
  excerpt: z.string().max(160).optional(), excerptTruncated: z.boolean().optional(),
}).strict()

export const ReadDashboardRepeatedSchema = z.object({
  target: z.enum(['groups', 'events']),
  complete: z.boolean(), hasMore: z.boolean(),
  groups: z.array(ReadDashboardRepeatedGroupSchema).max(15).optional(),
  events: z.array(ReadDashboardRepeatedEventSchema).max(15).optional(),
  fingerprint: z.string().max(512).optional(),
  projectKeys: z.array(ProjectKeySchema).max(4).optional(),
  scannedGroups: z.number().int().nonnegative().optional(),
  scannedEvents: z.number().int().nonnegative().optional(),
  reason: z.string().max(160).optional(),
}).strict()

export const ReadDashboardRequestSchema = z.discriminatedUnion('action', [
  z.object({ version: z.literal(1), action: z.literal('global'), readId: z.never().optional(), resume: z.string().uuid().optional(),
    status: z.enum(['approved', 'candidate']).optional(),
    layer: z.enum(['home', 'L0', 'L1', 'L2', 'L3']), query: z.string().max(200).default(''),
    relationDepth: z.number().int().min(0).max(2).optional(),
    year: z.number().int().min(1970).max(9998), timeZone: z.string().min(1).max(128),
    scene: z.object({ projectKey: ProjectKeySchema, name: z.string().min(1).max(512) }).strict().optional(),
  }).strict(),
  z.object({ version: z.literal(1), action: z.literal('bootstrap'), readId: z.string().uuid().optional(),
    projectKeys: z.array(ProjectKeySchema).max(15).default([]),
    focusProjectKey: ProjectKeySchema.optional(),
    range: DashboardReadRangeSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal('overview'), readId: z.string().uuid(), focusProjectKey: ProjectKeySchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal('settings'), readId: z.string().uuid().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal('persona'), readId: z.string().uuid(), projectKey: ProjectKeySchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal('globalPersona'), readId: z.string().uuid() }).strict(),
  z.object({ version: z.literal(1), action: z.literal('scene'), readId: z.string().uuid(), projectKey: ProjectKeySchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal('library'), readId: z.string().uuid(), projectKey: ProjectKeySchema,
    status: z.enum(['candidate', 'approved', 'forgotten', 'all']), limit: z.number().int().min(1).max(15).optional(),
    query: z.string().max(200).optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal('detail'), readId: z.string().uuid(), projectKey: ProjectKeySchema,
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('memory'), status: DashboardReadStatusSchema, id: z.string().min(1).max(256) }).strict(),
      z.object({ kind: z.literal('events'), dimension: z.enum(['date', 'source', 'agent', 'agentPreset', 'provider', 'model', 'fingerprint']),
        value: z.string().min(1).max(512) }).strict().superRefine((item, context) => {
          if (item.dimension === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(item.value)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'date drilldown value must be YYYY-MM-DD', path: ['value'] })
          }
        }),
    ]) }).strict(),
  z.object({ version: z.literal(1), action: z.literal('repeated'), readId: z.string().uuid(),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('groups'), projectKeys: z.array(ProjectKeySchema).min(1).max(4).optional(),
        filters: ReadDashboardRepeatedFiltersSchema.optional(),
        after: ReadDashboardRepeatedRankSchema.optional(),
        limit: z.number().int().min(1).max(15).optional() }).strict(),
      z.object({ kind: z.literal('events'), projectKey: ProjectKeySchema,
        fingerprint: z.string().min(1).max(512),
        filters: ReadDashboardRepeatedFiltersSchema.optional(),
        includeExcerpt: z.boolean().optional(),
        limit: z.number().int().min(1).max(15).optional() }).strict(),
    ]) }).strict(),
  z.object({ version: z.literal(1), action: z.literal('continue'), readId: z.string().uuid(), cursor: z.string().uuid() }).strict(),
  z.object({ version: z.literal(1), action: z.literal('close'), readId: z.string().uuid() }).strict(),
])

export const ReadDashboardMetricSchema = z.object({
  value: z.number().nullable(),
  relation: z.enum(['exact', 'lower_bound', 'unknown']),
  reason: z.string().max(128).optional(),
}).strict()

export const ReadDashboardRecordSchema = z.object({
  id: z.string().max(256), content: z.string().max(65_536), kind: z.string().max(256), scene: z.string().max(512).optional(),
  confidence: z.number(), status: DashboardReadStatusSchema, source: z.string().max(512), sourceMessageIds: z.array(z.string().max(256)).max(100),
  createdAt: z.number(), updatedAt: z.number(), approvedAt: z.number().optional(), forgottenAt: z.number().optional(), revision: z.number().int().positive(),
  validFrom: z.number().optional(), validFromState: z.enum(['known', 'unknown']),
  validFromPrecision: z.enum(['instant', 'second', 'minute', 'day', 'month', 'year', 'unknown']),
  validFromBasis: z.enum(['default_record_time', 'explicit', 'explicit_unknown']), validFromUpper: z.number().optional(),
  validFromLabel: z.string().max(512).optional(), validTo: z.number().optional(), recordedAt: z.number(), supersededAt: z.number().optional(),
  sourceVerified: z.boolean(), expiryAt: z.number().optional(), projectKey: ProjectKeySchema, projectName: z.string().max(256),
}).strict()

export const ReadDashboardProjectSchema = z.object({ key: ProjectKeySchema, name: z.string().max(256) }).strict()

export const ReadDashboardSettingsSchema = z.object({
  generateMemory: z.boolean().optional(), useMemory: z.boolean().optional(),
  mode: z.string().max(32), recallMaxTokens: z.number(), extractionEveryN: z.number().min(1).max(100),
  extractionEnabled: z.boolean(), includePersona: z.boolean(), globalPersona: z.boolean(),
  extractionProvider: z.string().max(160).optional(), extractionModel: z.string().max(240).optional(),
  characterEnabled: z.boolean(), characterDescription: z.string().max(400),
}).strict()

export const ReadDashboardPagePersonaSchema = z.object({
  projectKey: ProjectKeySchema, projectName: z.string().max(256), content: z.string().max(65_536),
  sourceCount: z.number(), updatedAt: z.number(), stale: z.boolean(),
}).strict()
export const ReadDashboardPageGlobalPersonaSchema = z.object({
  content: z.string().max(65_536), sourceCount: z.number(), updatedAt: z.number(), stale: z.boolean(),
}).strict()
export const ReadDashboardPageSceneSchema = z.object({
  projectKey: ProjectKeySchema, projectName: z.string().max(256), name: z.string().max(512),
  summary: z.string().max(65_536), memoryCount: z.number(), summaryComplete: z.boolean(),
}).strict()
export const ReadDashboardSceneItemSchema = z.object({
  projectKey: ProjectKeySchema, projectName: z.string().max(256), name: z.string().max(512).optional(),
  state: z.enum(['visible', 'hidden', 'unresolved']), reason: z.string().max(160).optional(),
  summary: z.string().max(65_536).optional(), memoryCount: z.number().int().nonnegative(), updatedAt: z.number(),
  summaryComplete: z.boolean(),
}).strict()
export const ReadDashboardScenePageSchema = z.object({
  projectKey: ProjectKeySchema, projectName: z.string().max(256),
  items: z.array(ReadDashboardSceneItemSchema).max(6), hasMore: z.boolean(),
}).strict()
export const ReadDashboardPageProjectSchema = z.object({
  key: ProjectKeySchema, name: z.string().max(256), memories: ReadDashboardMetricSchema,
  approved: ReadDashboardMetricSchema, candidates: ReadDashboardMetricSchema, forgotten: ReadDashboardMetricSchema,
}).strict()
export const ReadDashboardPageMemorySchema = z.object({
  id: z.string().max(256), kind: z.string().max(256), scene: z.string().max(512).optional(), confidence: z.number(),
  status: DashboardReadStatusSchema, source: z.string().max(512), sourceMessageIds: z.array(z.string().max(256)).max(100),
  contentBytes: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
  approvedAt: z.number().optional(), forgottenAt: z.number().optional(), revision: z.number().int().positive(),
  validFrom: z.number().optional(), validFromState: z.enum(['known', 'unknown']),
  validFromPrecision: z.enum(['instant', 'second', 'minute', 'day', 'month', 'year', 'unknown']),
  validFromBasis: z.enum(['default_record_time', 'explicit', 'explicit_unknown']), validFromUpper: z.number().optional(),
  validFromLabel: z.string().max(512).optional(), validTo: z.number().optional(), recordedAt: z.number(), supersededAt: z.number().optional(),
  sourceVerified: z.boolean(), expiryAt: z.number().optional(), projectKey: ProjectKeySchema, projectName: z.string().max(256),
  content: z.string().max(65_536).optional(),
}).strict()
export const ReadDashboardPageSchema = z.object({
  activeProjectKey: ProjectKeySchema.optional(), settings: ReadDashboardSettingsSchema,
  projects: z.array(ReadDashboardPageProjectSchema).max(15),
  candidates: z.array(ReadDashboardPageMemorySchema).max(24),
  recent: z.array(ReadDashboardPageMemorySchema).max(24),
  personas: z.array(ReadDashboardPagePersonaSchema).max(4).optional(),
  globalPersona: ReadDashboardPageGlobalPersonaSchema.nullable().optional(),
  scenes: z.array(ReadDashboardPageSceneSchema).max(40).optional(),
  lastError: z.string().max(2000).optional(),
}).strict()

export const ReadDashboardAckSchema = z.object({
  ok: z.boolean(), scope: z.enum(['project', 'global']), operation: z.string().max(64),
  projectKey: ProjectKeySchema.optional(), targetId: z.string().max(256).optional(),
  result: z.enum(['applied', 'confirmed', 'noop', 'rejected']), reason: z.string().max(160).optional(),
}).strict()
export const ReadDashboardActivityDaySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  count: ReadDashboardMetricSchema, coverage: z.enum(['covered', 'partial', 'unknown']) }).strict()
export const ReadDashboardMemorySummarySchema = z.object({
  id: z.string().max(256), kind: z.string().max(256), scene: z.string().max(512).optional(), confidence: z.number(),
  status: DashboardReadStatusSchema, source: z.string().max(512), sourceMessageIds: z.array(z.string().max(256)).max(100),
  contentBytes: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
  approvedAt: z.number().optional(), forgottenAt: z.number().optional(), revision: z.number().int().positive(),
  validFrom: z.number().optional(), validFromState: z.enum(['known', 'unknown']),
  validFromPrecision: z.enum(['instant', 'second', 'minute', 'day', 'month', 'year', 'unknown']),
  validFromBasis: z.enum(['default_record_time', 'explicit', 'explicit_unknown']), validFromUpper: z.number().optional(),
  validFromLabel: z.string().max(512).optional(), validTo: z.number().optional(), recordedAt: z.number(), supersededAt: z.number().optional(),
  sourceVerified: z.boolean(), expiryAt: z.number().optional(), projectKey: ProjectKeySchema, projectName: z.string().max(256),
  content: z.string().max(65_536).optional(),
}).strict()
const ReadDashboardDimensionSchema = z.object({ key: z.string().max(512), count: ReadDashboardMetricSchema }).strict()
const ReadDashboardProcessingSchema = z.object({ queued: ReadDashboardMetricSchema, failed: ReadDashboardMetricSchema,
  uncertainUsage: ReadDashboardMetricSchema,
  oldestWaiting: z.object({ state: z.enum(['unknown', 'none', 'partial', 'exact']),
    value: z.number().nullable() }).strict() }).strict()
const ReadDashboardUsageFieldSchema = ReadDashboardMetricSchema.extend({
  seen: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative(),
}).strict().refine((field) => field.uncertain <= field.seen &&
  (field.relation === 'unknown' ? field.value === null && field.seen === 0
    : field.value !== null && field.value >= 0 && (field.seen > 0 || field.value === 0)) &&
  (field.relation !== 'exact' || field.missing === 0 && field.uncertain === 0) &&
  (field.relation !== 'lower_bound' || field.seen > 0),
  { message: 'Usage evidence must match the observed field state' })
const ReadDashboardUsageGroupingSchema = z.object({ selection: z.literal('first_seen'), overflow: z.boolean(),
  unknownIdentityCalls: ReadDashboardMetricSchema }).strict()
const ReadDashboardModelUsageSchema = z.object({
  key: z.string().max(96), provider: z.string().max(256).nullable(), model: z.string().max(256).nullable(), other: z.boolean(),
  count: ReadDashboardMetricSchema, knownCalls: ReadDashboardMetricSchema, unknownCalls: ReadDashboardMetricSchema,
  unknownIdentityCalls: ReadDashboardMetricSchema,
  inputTokens: ReadDashboardUsageFieldSchema, outputTokens: ReadDashboardUsageFieldSchema,
  cacheReadTokens: ReadDashboardUsageFieldSchema, cacheWriteTokens: ReadDashboardUsageFieldSchema,
  reasoningTokens: ReadDashboardUsageFieldSchema, costMicros: ReadDashboardUsageFieldSchema,
}).strict().refine((group) => !group.other || group.provider === null && group.model === null,
  { message: 'An overflow model group cannot claim an individual identity' })
const ReadDashboardPurposeUsageSchema = z.object({
  key: z.string().max(96), purpose: z.string().max(128).nullable(), other: z.boolean(),
  count: ReadDashboardMetricSchema, knownCalls: ReadDashboardMetricSchema, unknownCalls: ReadDashboardMetricSchema,
  unknownIdentityCalls: ReadDashboardMetricSchema, actualTokens: ReadDashboardUsageFieldSchema,
}).strict().refine((group) => !group.other || group.purpose === null,
  { message: 'An overflow purpose group cannot claim an individual identity' })
const ReadDashboardUsageSchema = z.object({
  attempts: z.object({ calls: ReadDashboardMetricSchema, knownCalls: ReadDashboardMetricSchema, unknownCalls: ReadDashboardMetricSchema,
    inputTokens: ReadDashboardMetricSchema, outputTokens: ReadDashboardMetricSchema, cacheReadTokens: ReadDashboardMetricSchema,
    cacheWriteTokens: ReadDashboardMetricSchema, reasoningTokens: ReadDashboardMetricSchema, costMicros: ReadDashboardMetricSchema,
    byProvider: z.array(ReadDashboardDimensionSchema).max(10), byModel: z.array(ReadDashboardModelUsageSchema).max(10),
    grouping: ReadDashboardUsageGroupingSchema }).strict(),
  billable: z.object({ calls: ReadDashboardMetricSchema, tokens: ReadDashboardMetricSchema,
    byPurpose: z.array(ReadDashboardPurposeUsageSchema).max(10), grouping: ReadDashboardUsageGroupingSchema }).strict(),
  preparedInjectionTokensEstimate: ReadDashboardMetricSchema,
  preparedInjectionEstimateMethod: z.literal('sum-prepared-event-tokens'), mainModelCoverage: z.literal('unavailable'),
  actualInjectionReceipt: z.literal('unavailable'),
  comparableNetSavings: z.literal('unavailable'),
}).strict()
const ReadDashboardDimensionsSchema = z.object({
  sources: z.array(ReadDashboardDimensionSchema).max(10), agents: z.array(ReadDashboardDimensionSchema).max(10),
  agentPresets: z.array(ReadDashboardDimensionSchema).max(10), providers: z.array(ReadDashboardDimensionSchema).max(10),
  models: z.array(ReadDashboardDimensionSchema).max(10), sessions: z.array(ReadDashboardDimensionSchema).max(10),
  fingerprints: z.array(ReadDashboardDimensionSchema).max(10),
}).strict()
/**
 * `dimensions` retains its v1 all-event grouping (fingerprints remain capture-only).
 * `scopedDimensions` is an additive overview projection: captureSources always counts
 * captures; selected counts activityTypes(range.activity), matching event detail filters.
 * Missing scopedDimensions on an older response means unavailable, never an alias of
 * legacy dimensions or a confirmed empty set. Strict result codecs require the producer
 * and bundled client to upgrade together before publishing this additive field.
 * Empty arrays in a present projection
 * retain the response/metric completeness bounds. Non-overview responses omit it.
 */
const ReadDashboardScopedDimensionsSchema = z.object({
  activity: DashboardReadActivitySchema,
  captureSources: z.array(ReadDashboardDimensionSchema).max(10),
  selected: ReadDashboardDimensionsSchema.pick({ sources: true, agents: true, agentPresets: true, providers: true, models: true }),
}).strict()

const ReadDashboardEventSchema = z.object({ id: z.number().int().positive(), type: z.string().max(64), createdAt: z.number(),
  eventCount: z.literal(1), count: z.number(),
  source: z.string().max(512).optional(), agentId: z.string().max(512).optional(), agentPreset: z.string().max(512).optional(),
  provider: z.string().max(256).optional(), model: z.string().max(256).optional(), fingerprint: z.string().max(512).optional(),
  sessionId: z.string().max(512).optional() }).strict()
const ReadDashboardSessionSchema = z.object({
  projectKey: ProjectKeySchema, projectName: z.string().max(256),
  sessionId: z.string().min(1).max(512),
  events: z.number().int().nonnegative(),
  linkedL0Messages: z.number().int().nonnegative(),
  linkedL0Complete: z.boolean(),
  originalMessageCount: z.null(),
  identityLowerBound: z.number().int().nonnegative(),
  identityComplete: z.boolean(),
  unknownIdentityEvents: z.number().int().nonnegative(),
}).strict()
export const ReadDashboardSessionsSchema = z.object({
  complete: z.boolean(), truncated: z.boolean(),
  scannedEvents: z.number().int().nonnegative(), scannedSessions: z.number().int().nonnegative(),
  items: z.array(ReadDashboardSessionSchema).max(10),
  unknownSessionEvents: z.number().int().nonnegative(),
  unknownIdentityEvents: z.number().int().nonnegative(),
  reason: z.string().max(160).optional(),
}).strict()
export const GlobalMemoryItemSchema = z.object({
  memory: ReadDashboardRecordSchema.optional(),
  routes: z.array(z.enum(['profile_lexical', 'relation'])).max(2).optional(), score: z.number().min(0).max(1).optional(),
  key: z.string().max(2048), layer: z.enum(['L0', 'L1', 'L2', 'L3']),
  projectKey: ProjectKeySchema, id: z.string().max(512), content: z.string().max(65_536),
  createdAt: z.number(), updatedAt: z.number(), revision: z.number().int().positive().optional(),
  scene: z.string().max(512).optional(),
  sources: z.array(z.object({ id: z.string().max(256), projectKey: ProjectKeySchema.optional(), sessionId: z.string().max(512).optional(),
    createdAt: z.number().optional() }).strict()).max(300), sourcesComplete: z.boolean(),
}).strict()
export const GlobalMemoryPageSchema = z.object({
  processing: z.object({ queued: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative(), pendingApproval: z.number().int().nonnegative(),
    latestIssue: z.string().max(1024).optional() }).strict().optional(),
  next: z.string().uuid().optional(),
  layer: z.enum(['home', 'L0', 'L1', 'L2', 'L3']), query: z.string().max(200),
  items: z.array(GlobalMemoryItemSchema).max(8),
  counts: z.object({ L0: ReadDashboardMetricSchema, L1: ReadDashboardMetricSchema,
    L2: ReadDashboardMetricSchema, L3: ReadDashboardMetricSchema }).strict(),
  days: z.array(z.object({ date: z.string(), added: z.number().int().nonnegative(), updated: z.number().int().nonnegative(),
    records: z.array(z.string().max(2048)).max(128) }).strict()).max(366),
  recentAdded: ReadDashboardMetricSchema,
  activityComplete: z.boolean(), year: z.number(), timeZone: z.string(),
  generateMemory: z.boolean(), useMemory: z.boolean(), paused: z.boolean(),
  pauseReasons: z.array(z.enum(['generation_disabled', 'capture_disabled', 'extraction_disabled'])).max(3).optional(),
}).strict()
export type GlobalMemoryItem = z.infer<typeof GlobalMemoryItemSchema>
export type GlobalMemoryPage = z.infer<typeof GlobalMemoryPageSchema>

export const ReadDashboardResultSchema = z.object({
  version: z.literal(1), status: z.enum(['ok', 'partial', 'stale', 'expired', 'evicted', 'unavailable', 'budget_exhausted', 'scope_limit', 'selection_required']),
  view: z.enum(['bootstrap', 'overview', 'settings', 'persona', 'globalPersona', 'scene', 'library', 'detail', 'repeated', 'global', 'control']), readId: z.string().uuid().optional(),
  generatedAt: z.number().int().nonnegative(), complete: z.boolean(), reason: z.string().max(160).optional(),
  global: GlobalMemoryPageSchema.optional(),
  projects: z.array(ReadDashboardProjectSchema).max(15).optional(), page: ReadDashboardPageSchema.optional(),
  processing: ReadDashboardProcessingSchema.optional(), sessions: ReadDashboardSessionsSchema.optional(),
  globalPersona: ReadDashboardPageGlobalPersonaSchema.nullable().optional(),
  settings: ReadDashboardSettingsSchema.optional(), activeProjectKey: ProjectKeySchema.optional(), lastError: z.string().max(2000).optional(), lastErrorState: z.enum(['absent', 'present', 'omitted']).optional(),
  persona: z.object({ state: z.enum(['visible', 'unresolved', 'hidden']), projectKey: ProjectKeySchema, reason: z.string().max(160).optional(),
    content: z.string().max(65_536).optional(), sourceCount: z.number().int().nonnegative(), updatedAt: z.number(), stale: z.boolean() }).strict().optional(),
  scene: ReadDashboardScenePageSchema.optional(), metrics: z.record(z.string(), ReadDashboardMetricSchema).optional(),
  activity: z.array(ReadDashboardActivityDaySchema).max(400).optional(), dimensions: ReadDashboardDimensionsSchema.optional(),
  scopedDimensions: ReadDashboardScopedDimensionsSchema.optional(),
  identity: z.object({ recordedOriginalMessageLowerBound: ReadDashboardMetricSchema,
    unknownOriginalMessageEvents: ReadDashboardMetricSchema }).strict().optional(),
  usage: ReadDashboardUsageSchema.optional(), coverage: z.object({ status: z.enum(['covered', 'partial', 'unknown']),
    coveredDays: ReadDashboardMetricSchema,
    windows: z.array(z.object({ id: z.number().int().positive(), startedAt: z.number(), endedAt: z.number().nullable(),
      status: z.enum(['active', 'closed', 'interrupted']), policyRevision: z.string().max(128) }).strict()).max(8),
  }).strict().optional(),
  records: z.array(ReadDashboardMemorySummarySchema).max(15).optional(), events: z.array(ReadDashboardEventSchema).max(15).optional(),
  repeated: ReadDashboardRepeatedSchema.optional(),
  record: ReadDashboardRecordSchema.nullable().optional(), itemState: z.enum(['visible', 'hidden', 'unresolved']).optional(),
  cursor: z.string().uuid().optional(),
}).strict()

export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>
export type MemoryView = z.infer<typeof MemoryViewSchema>
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>
export type ExportRequest = z.infer<typeof ExportRequestSchema>
export type ExportResult = z.infer<typeof ExportResultSchema>
export type RefreshPersonaRequest = z.infer<typeof RefreshPersonaRequestSchema>
export type OverviewRequest = z.infer<typeof OverviewRequestSchema>
export type OverviewResult = z.infer<typeof OverviewResultSchema>
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>
export type ExplainResult = z.infer<typeof ExplainResultSchema>
export type LibraryRequest = z.infer<typeof LibraryRequestSchema>
export type LibraryResult = z.infer<typeof LibraryResultSchema>
export type ManageRequest = z.infer<typeof ManageRequestSchema>
export type ManageResult = z.infer<typeof ManageResultSchema>
export type ReadDashboardRequest = z.infer<typeof ReadDashboardRequestSchema>
export type ReadDashboardResult = z.infer<typeof ReadDashboardResultSchema>
export type ReadDashboardPage = z.infer<typeof ReadDashboardPageSchema>
export type ReadDashboardAck = z.infer<typeof ReadDashboardAckSchema>
export type ReadDashboardSettings = z.infer<typeof ReadDashboardSettingsSchema>

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
    id: `${PACKAGE}#${SERVICE}/readDashboard`, service: SERVICE, namespace: SERVICE, method: 'readDashboard',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#ReadDashboardRequest`, ReadDashboardRequestSchema) }],
    result: strictCodec(`${PACKAGE}#ReadDashboardResult`, ReadDashboardResultSchema), sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
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
    id: `${PACKAGE}#${SERVICE}/reviewAck`,
    service: SERVICE, namespace: SERVICE, method: 'reviewAck', invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#ReviewRequest`, ReviewRequestSchema) }],
    result: strictCodec(`${PACKAGE}#ReadDashboardAck`, ReadDashboardAckSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/updateSettingsAck`,
    service: SERVICE, namespace: SERVICE, method: 'updateSettingsAck', invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#UpdateSettingsRequest`, UpdateSettingsRequestSchema) }],
    result: strictCodec(`${PACKAGE}#ReadDashboardAck`, ReadDashboardAckSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/refreshPersonaAck`,
    service: SERVICE, namespace: SERVICE, method: 'refreshPersonaAck', invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#RefreshPersonaRequest`, RefreshPersonaRequestSchema) }],
    result: strictCodec(`${PACKAGE}#ReadDashboardAck`, ReadDashboardAckSchema),
    sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/refreshGlobalPersonaAck`,
    service: SERVICE, namespace: SERVICE, method: 'refreshGlobalPersonaAck', invocation: { kind: 'direct' as const },
    parameters: [],
    result: strictCodec(`${PACKAGE}#ReadDashboardAck`, ReadDashboardAckSchema),
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
  {
    id: `${PACKAGE}#${SERVICE}/overview`, service: SERVICE, namespace: SERVICE, method: 'overview',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#OverviewRequest`, OverviewRequestSchema) }],
    result: strictCodec(`${PACKAGE}#OverviewResult`, OverviewResultSchema), sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/explain`, service: SERVICE, namespace: SERVICE, method: 'explain',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#ExplainRequest`, ExplainRequestSchema) }],
    result: strictCodec(`${PACKAGE}#ExplainResult`, ExplainResultSchema), sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/library`, service: SERVICE, namespace: SERVICE, method: 'library',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#LibraryRequest`, LibraryRequestSchema) }],
    result: strictCodec(`${PACKAGE}#LibraryResult`, LibraryResultSchema), sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/manage`, service: SERVICE, namespace: SERVICE, method: 'manage',
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: strictCodec(`${PACKAGE}#ManageRequest`, ManageRequestSchema) }],
    result: strictCodec(`${PACKAGE}#ManageResult`, ManageResultSchema), sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
  },
])
