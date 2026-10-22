import {
  DashboardSnapshotSchema,
  ExportRequestSchema,
  ExportResultSchema,
  GlobalPersonaViewSchema,
  RefreshPersonaRequestSchema,
  ReviewRequestSchema,
  UpdateSettingsRequestSchema,
  invocationDescriptors,
} from './remote-contract.js'

/** Typert Host contribution for the memory dashboard RPC. */
export const TYPERT = {
  package: 'dsh-memory-tdai',
  face: 'host',
  schemas: [
    { name: 'DashboardSnapshot', schema: DashboardSnapshotSchema },
    { name: 'ReviewRequest', schema: ReviewRequestSchema },
    { name: 'UpdateSettingsRequest', schema: UpdateSettingsRequestSchema },
    { name: 'ExportRequest', schema: ExportRequestSchema },
    { name: 'ExportResult', schema: ExportResultSchema },
    { name: 'RefreshPersonaRequest', schema: RefreshPersonaRequestSchema },
    { name: 'GlobalPersonaView', schema: GlobalPersonaViewSchema },
  ],
  invocations: invocationDescriptors,
  model: {
    services: [{
      tags: [],
      description: 'Local reviewed memory dashboard and review actions.',
      key: 'memoryTdai',
      exportName: 'MemoryTdaiRemote',
      members: [
        { kind: 'method', name: 'snapshot', signature: 'snapshot(): Promise<DashboardSnapshot>' },
        { kind: 'method', name: 'review', signature: 'review(request: ReviewRequest): Promise<DashboardSnapshot>' },
        { kind: 'method', name: 'updateSettings', signature: 'updateSettings(request: UpdateSettingsRequest): Promise<DashboardSnapshot>' },
        { kind: 'method', name: 'export', signature: 'export(request: ExportRequest): Promise<ExportResult>' },
        { kind: 'method', name: 'refreshPersona', signature: 'refreshPersona(request: RefreshPersonaRequest): Promise<DashboardSnapshot>' },
        { kind: 'method', name: 'refreshGlobalPersona', signature: 'refreshGlobalPersona(): Promise<DashboardSnapshot>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
} as const

export default TYPERT
