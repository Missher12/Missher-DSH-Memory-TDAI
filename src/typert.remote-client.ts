import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { invocationDescriptors } from './remote-contract.js'
import type { DashboardSnapshot, ExportResult, ReviewRequest, UpdateSettingsRequest } from './remote-contract.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'memoryTdai/snapshot': () => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/review': (request: ReviewRequest) => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/updateSettings': (request: UpdateSettingsRequest) => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/export': (request: { projectKey: string }) => Promise<RemoteResult<ExportResult>>
    'memoryTdai/refreshPersona': (request: { projectKey: string }) => Promise<RemoteResult<DashboardSnapshot>>
    'memoryTdai/refreshGlobalPersona': () => Promise<RemoteResult<DashboardSnapshot>>
  }

  interface TypertRemoteNamespaceMap {
    memoryTdai: {
      snapshot: () => Promise<RemoteResult<DashboardSnapshot>>
      review: (request: ReviewRequest) => Promise<RemoteResult<DashboardSnapshot>>
      updateSettings: (request: UpdateSettingsRequest) => Promise<RemoteResult<DashboardSnapshot>>
      export: (request: { projectKey: string }) => Promise<RemoteResult<ExportResult>>
      refreshPersona: (request: { projectKey: string }) => Promise<RemoteResult<DashboardSnapshot>>
      refreshGlobalPersona: () => Promise<RemoteResult<DashboardSnapshot>>
    }
  }
}

/** Typert Client contribution for memory dashboard RPC resolution. */
export const TYPERT_REMOTE = {
  package: 'dsh-memory-tdai',
  descriptors: invocationDescriptors,
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
