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
  RefreshPersonaRequestSchema,
  ReviewRequestSchema,
  UpdateSettingsRequestSchema,
  type DashboardSnapshot,
  type ExportResult,
} from './remote-contract.js'

export interface MemoryTdaiRemoteBackend {
  snapshot(): Promise<DashboardSnapshot>
  review(projectKey: string, id: string, action: 'approve' | 'forget'): Promise<DashboardSnapshot>
  updateSettings(patch: {
    mode?: string
    recallMaxTokens?: number
    dedupeSession?: boolean
    includePersona?: boolean
    extractionEveryN?: number
  }): Promise<DashboardSnapshot>
  exportProject(projectKey: string): Promise<ExportResult>
  refreshPersona(projectKey: string): Promise<DashboardSnapshot>
  refreshGlobalPersona(): Promise<DashboardSnapshot>
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

  @Remote('review')
  async review(input: unknown): Promise<DashboardSnapshot> {
    const request = ReviewRequestSchema.parse(input)
    return this.backend.review(request.projectKey, request.id, request.action)
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
}
