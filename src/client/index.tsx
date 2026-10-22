/**
 * Browser entry: mount the dashboard RPC descriptors and contribute one
 * Settings section.
 */
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '../typert.remote-client'
import { Dashboard, type DashboardActions } from './Dashboard'

export const inject = ['slots', 'remote']

export async function apply(ctx: any): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const remote = ctx.get('remote.memoryTdai') as {
    snapshot: () => Promise<unknown>
    review: (request: { projectKey: string; id: string; action: 'approve' | 'forget' }) => Promise<unknown>
    updateSettings: (request: Record<string, unknown>) => Promise<unknown>
    export: (request: { projectKey: string }) => Promise<unknown>
    refreshPersona: (request: { projectKey: string }) => Promise<unknown>
    refreshGlobalPersona: () => Promise<unknown>
  }
  const unwrap = (result: any): any => {
    if (result?.ok === true) return result.value
    throw new Error(result?.failure?.code ?? 'memory operation failed')
  }
  const actions: DashboardActions = {
    load: async () => unwrap(await remote.snapshot()),
    review: async (request) => unwrap(await remote.review(request)),
    updateSettings: async (request) => unwrap(await remote.updateSettings(request)),
    exportProject: async (projectKey) => unwrap(await remote.export({ projectKey })),
    refreshPersona: async (projectKey) => unwrap(await remote.refreshPersona({ projectKey })),
    refreshGlobalPersona: async () => unwrap(await remote.refreshGlobalPersona()),
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
