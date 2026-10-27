import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE, invocationDescriptors } from './remote-contract.js'
import type { DashboardSnapshot, ExplainRequest, ExplainResult, ExportResult, LibraryRequest, LibraryResult, ManageRequest, ManageResult, OverviewRequest, OverviewResult, ReadDashboardAck, ReadDashboardRequest, ReadDashboardResult, ReviewRequest, UpdateSettingsRequest } from './remote-contract.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'memoryTdai/snapshot': () => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/readDashboard': (request: ReadDashboardRequest) => Promise<RemoteResult<ReadDashboardResult>>
    'memoryTdai/review': (request: ReviewRequest) => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/reviewAck': (request: ReviewRequest) => Promise<RemoteResult<ReadDashboardAck>>
    'memoryTdai/updateSettingsAck': (request: UpdateSettingsRequest) => Promise<RemoteResult<ReadDashboardAck>>
    'memoryTdai/refreshPersonaAck': (request: { projectKey: string }) => Promise<RemoteResult<ReadDashboardAck>>
    'memoryTdai/refreshGlobalPersonaAck': () => Promise<RemoteResult<ReadDashboardAck>>
    'memoryTdai/updateSettings': (request: UpdateSettingsRequest) => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/export': (request: { projectKey: string }) => Promise<RemoteResult<ExportResult>>
    'memoryTdai/refreshPersona': (request: { projectKey: string }) => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/refreshGlobalPersona': () => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/overview': (request: OverviewRequest) => Promise<RemoteResult<OverviewResult>>
    'memoryTdai/explain': (request: ExplainRequest) => Promise<RemoteResult<ExplainResult>>
    'memoryTdai/library': (request: LibraryRequest) => Promise<RemoteResult<LibraryResult>>
    'memoryTdai/manage': (request: ManageRequest) => Promise<RemoteResult<ManageResult>>
  }

  interface TypertRemoteNamespaceMap {
    memoryTdai: {
      snapshot: () => Promise<RemoteResult<DashboardSnapshot>>
      readDashboard: (request: ReadDashboardRequest) => Promise<RemoteResult<ReadDashboardResult>>
      review: (request: ReviewRequest) => Promise<RemoteResult<DashboardSnapshot>>
      reviewAck: (request: ReviewRequest) => Promise<RemoteResult<ReadDashboardAck>>
      updateSettingsAck: (request: UpdateSettingsRequest) => Promise<RemoteResult<ReadDashboardAck>>
      refreshPersonaAck: (request: { projectKey: string }) => Promise<RemoteResult<ReadDashboardAck>>
      refreshGlobalPersonaAck: () => Promise<RemoteResult<ReadDashboardAck>>
      updateSettings: (request: UpdateSettingsRequest) => Promise<RemoteResult<DashboardSnapshot>>
      export: (request: { projectKey: string }) => Promise<RemoteResult<ExportResult>>
      refreshPersona: (request: { projectKey: string }) => Promise<RemoteResult<DashboardSnapshot>>
      refreshGlobalPersona: () => Promise<RemoteResult<DashboardSnapshot>>
      overview: (request: OverviewRequest) => Promise<RemoteResult<OverviewResult>>
      explain: (request: ExplainRequest) => Promise<RemoteResult<ExplainResult>>
      library: (request: LibraryRequest) => Promise<RemoteResult<LibraryResult>>
      manage: (request: ManageRequest) => Promise<RemoteResult<ManageResult>>
    }
  }
}

/** Typert Client contribution for memory dashboard RPC resolution. */
export const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: invocationDescriptors,
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
