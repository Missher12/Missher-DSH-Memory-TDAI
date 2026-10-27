/**
 * Browser entry: mount the dashboard RPC descriptors and contribute one
 * Settings section.
 */
import TYPERT_REMOTE from '../typert.remote-client.js'
import { Dashboard, type DashboardActions } from './Dashboard.js'
import type {
  OverviewRequest, ReadDashboardRequest, ReadDashboardAck, UpdateSettingsRequest,
} from '../remote-contract.js'

export const inject = ['slots', 'remote']

export async function apply(ctx: any): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const remote = ctx.get('remote.memoryTdai') as {
    snapshot: () => Promise<unknown>
    review: (request: { projectKey: string; id: string; action: 'approve' | 'forget' }) => Promise<unknown>
    reviewAck: (request: { projectKey: string; id: string; action: 'approve' | 'forget' }) => Promise<unknown>
    refreshPersonaAck: (request: { projectKey: string }) => Promise<unknown>
    refreshGlobalPersonaAck: () => Promise<unknown>
    updateSettings: (request: Record<string, unknown>) => Promise<unknown>
    updateSettingsAck: (request: UpdateSettingsRequest) => Promise<ReadDashboardAck>
    readDashboard: (request: ReadDashboardRequest) => Promise<unknown>
    export: (request: { projectKey: string }) => Promise<unknown>
    refreshPersona: (request: { projectKey: string }) => Promise<unknown>
    refreshGlobalPersona: () => Promise<unknown>
    overview: (request: OverviewRequest) => Promise<unknown>
    explain: (request: { projectKey: string; query: string; limit?: number }) => Promise<unknown>
    library: (request: { projectKey: string; status?: 'candidate' | 'approved' | 'forgotten'; after?: { createdAt: number; id: string }; limit?: number }) => Promise<unknown>
    manage: (request: { projectKey: string; operation: string; payload?: Record<string, unknown> }) => Promise<unknown>
  }
  const unwrap = (result: any): any => {
    if (result?.ok === true) return result.value
    throw new Error(result?.failure?.code ?? 'memory operation failed')
  }
  const actions: DashboardActions = {
    load: async () => unwrap(await remote.snapshot()),
    review: async (request) => unwrap(await remote.review(request)),
    reviewAck: async (request) => unwrap(await remote.reviewAck(request)),
    refreshPersonaAck: async (projectKey) => unwrap(await remote.refreshPersonaAck({ projectKey })),
    refreshGlobalPersonaAck: async () => unwrap(await remote.refreshGlobalPersonaAck()),
    updateSettings: async (request) => unwrap(await remote.updateSettings(request)),
    updateSettingsAck: async (request) => unwrap(await remote.updateSettingsAck(request)),
    readDashboard: async (request) => unwrap(await remote.readDashboard(request)),
    exportProject: async (projectKey) => unwrap(await remote.export({ projectKey })),
    refreshPersona: async (projectKey) => unwrap(await remote.refreshPersona({ projectKey })),
    refreshGlobalPersona: async () => unwrap(await remote.refreshGlobalPersona()),
    overview: async (request) => unwrap(await remote.overview(request)),
    explain: async (request) => unwrap(await remote.explain(request)),
    library: async (request) => unwrap(await remote.library(request)),
    manage: async (request) => unwrap(await remote.manage({ ...request, payload: request.payload ?? {} })),
  }
  const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory-tdai',
    order: 16,
    label: () => 'Memory',
    inject: () => actions,
  }, Dashboard))
  ctx.effect(() => () => {
    void unmountRemote()
    dispose?.()
  })
  return unmountRemote
}
