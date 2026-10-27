/**
 * Host RPC service exposed to the Settings dashboard.
 *
 * @module dsh-memory-tdai/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ExportRequestSchema,
  ExportResultSchema,
  ExplainRequestSchema,
  ExplainResultSchema,
  OverviewRequestSchema,
  OverviewResultSchema,
  LibraryRequestSchema,
  LibraryResultSchema,
  ReadDashboardAckSchema,
  ReadDashboardRequestSchema,
  ReadDashboardResultSchema,
  ManageRequestSchema,
  ManageResultSchema,
  RefreshPersonaRequestSchema,
  ReviewRequestSchema,
  UpdateSettingsRequestSchema,
  type DashboardSnapshot,
  type ExportResult,
  type ExplainResult,
  type OverviewResult,
  type OverviewRequest,
  type LibraryResult,
  type ReadDashboardAck,
  type ReadDashboardRequest,
  type ReadDashboardResult,
  type UpdateSettingsRequest,
} from './remote-contract.js'

export interface MemoryTdaiRemoteBackend {
  snapshot(): Promise<DashboardSnapshot>
  review(projectKey: string, id: string, action: 'approve' | 'forget'): Promise<DashboardSnapshot>
  reviewAck(projectKey: string, id: string, action: 'approve' | 'forget'): Promise<ReadDashboardAck>
  updateSettings(patch: UpdateSettingsRequest): Promise<DashboardSnapshot>
  updateSettingsAck(patch: UpdateSettingsRequest): Promise<ReadDashboardAck>
  exportProject(projectKey: string): Promise<ExportResult>
  refreshPersona(projectKey: string): Promise<DashboardSnapshot>
  refreshPersonaAck(projectKey: string): Promise<ReadDashboardAck>
  refreshGlobalPersona(): Promise<DashboardSnapshot>
  refreshGlobalPersonaAck(): Promise<ReadDashboardAck>
  overview(input: OverviewRequest): Promise<OverviewResult>
  explain(projectKey: string, query: string, limit: number): Promise<ExplainResult>
  library(projectKey: string, input: { status?: 'candidate' | 'approved' | 'forgotten'; after?: { createdAt: number; id: string }; limit?: number }): Promise<LibraryResult>
  manage(projectKey: string, operation: string, payload: Record<string, unknown>): Promise<unknown>
  readDashboard(request: ReadDashboardRequest): Promise<ReadDashboardResult>
}

/** Pathless RPC service for the memory dashboard. */
export class MemoryTdaiRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly backend: MemoryTdaiRemoteBackend,
  ) {
    super(ctx, 'memoryTdai')
  }

  @Remote('snapshot')
  async snapshot(): Promise<DashboardSnapshot> {
    return this.backend.snapshot()
  }

  @Remote('readDashboard')
  async readDashboard(input: unknown): Promise<ReadDashboardResult> {
    const request = ReadDashboardRequestSchema.parse(input)
    return ReadDashboardResultSchema.parse(await this.backend.readDashboard(request))
  }

  @Remote('review')
  async review(input: unknown): Promise<DashboardSnapshot> {
    const request = ReviewRequestSchema.parse(input)
    return this.backend.review(request.projectKey, request.id, request.action)
  }

  @Remote('reviewAck')
  async reviewAck(input: unknown): Promise<ReadDashboardAck> {
    const request = ReviewRequestSchema.parse(input)
    return ReadDashboardAckSchema.parse(await this.backend.reviewAck(request.projectKey, request.id, request.action))
  }

  @Remote('updateSettingsAck')
  async updateSettingsAck(input: unknown): Promise<ReadDashboardAck> {
    const request = UpdateSettingsRequestSchema.parse(input)
    return ReadDashboardAckSchema.parse(await this.backend.updateSettingsAck(request))
  }

  @Remote('refreshPersonaAck')
  async refreshPersonaAck(input: unknown): Promise<ReadDashboardAck> {
    const request = RefreshPersonaRequestSchema.parse(input)
    return ReadDashboardAckSchema.parse(await this.backend.refreshPersonaAck(request.projectKey))
  }

  @Remote('refreshGlobalPersonaAck')
  async refreshGlobalPersonaAck(): Promise<ReadDashboardAck> {
    return ReadDashboardAckSchema.parse(await this.backend.refreshGlobalPersonaAck())
  }

  @Remote('updateSettings')
  async updateSettings(input: unknown): Promise<DashboardSnapshot> {
    const request = UpdateSettingsRequestSchema.parse(input)
    return this.backend.updateSettings(request)
  }

  @Remote('export')
  async export(input: unknown): Promise<ExportResult> {
    const request = ExportRequestSchema.parse(input)
    return ExportResultSchema.parse(await this.backend.exportProject(request.projectKey))
  }

  @Remote('refreshPersona')
  async refreshPersona(input: unknown): Promise<DashboardSnapshot> {
    const request = RefreshPersonaRequestSchema.parse(input)
    return this.backend.refreshPersona(request.projectKey)
  }

  @Remote('refreshGlobalPersona')
  async refreshGlobalPersona(): Promise<DashboardSnapshot> {
    return this.backend.refreshGlobalPersona()
  }

  @Remote('overview')
  async overview(input: unknown): Promise<OverviewResult> {
    const request = OverviewRequestSchema.parse(input)
    return OverviewResultSchema.parse(await this.backend.overview(request))
  }

  @Remote('explain')
  async explain(input: unknown): Promise<ExplainResult> {
    const request = ExplainRequestSchema.parse(input)
    return ExplainResultSchema.parse(await this.backend.explain(request.projectKey, request.query, request.limit ?? 6))
  }

  @Remote('library')
  async library(input: unknown): Promise<LibraryResult> {
    const request = LibraryRequestSchema.parse(input)
    return LibraryResultSchema.parse(await this.backend.library(request.projectKey, request))
  }

  @Remote('manage')
  async manage(input: unknown): Promise<{ data: unknown }> {
    const request = ManageRequestSchema.parse(input)
    return ManageResultSchema.parse({ data: await this.backend.manage(request.projectKey, request.operation, request.payload) })
  }
}
