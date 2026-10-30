/**
 * Browser entry: mount the dashboard RPC descriptors and contribute one
 * Settings section.
 */
import TYPERT_REMOTE from '../typert.remote-client.js'
import { Dashboard, type DashboardActions } from './Dashboard.js'
import type {
  ReadDashboardRequest, ReadDashboardAck, UpdateSettingsRequest,
} from '../remote-contract.js'

export const inject = ['slots', 'remote']

export async function apply(ctx: any): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const remote = ctx.get('remote.memoryTdai') as {
    updateSettingsAck: (request: UpdateSettingsRequest) => Promise<ReadDashboardAck>
    readDashboard: (request: ReadDashboardRequest) => Promise<unknown>
    manage: (request: { projectKey: string; operation: string; payload?: Record<string, unknown> }) => Promise<unknown>
  }
  const unwrap = (result: any): any => {
    if (result?.ok === true) return result.value
    // The native SDK returns RemoteResult.error; preserve its code and cause.
    const error = result?.error ?? new Error('memory operation failed')
    ctx.logger?.warn?.('[memory-tdai] Remote request failed: %s %s', error.code ?? '', error.message ?? '')
    throw error
  }
  const actions: DashboardActions = {
    updateSettingsAck: async (request) => unwrap(await remote.updateSettingsAck(request)),
    readDashboard: async (request) => unwrap(await remote.readDashboard(request)),
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
