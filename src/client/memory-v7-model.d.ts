import type { ReadDashboardRequest, ReadDashboardResult, GlobalMemoryPage } from '../remote-contract.js'
export interface MemoryDay { date: string; added: number; updated: number; records: string[]; known: boolean; future: boolean; count: number }
export function memoryYear(year: number, timeZone: string, days: GlobalMemoryPage['days'], complete: boolean, now?: number): {
  cells: MemoryDay[]; firstWeekday: number; weeks: number; recentAdded: number; recentComplete: boolean
}
export function memoryMetric(metric?: { value: number | null; relation: string }): string
export function readGlobalMemory(transport: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>,
  request: Extract<ReadDashboardRequest, { action: 'global' }>, cancelled?: () => boolean): Promise<ReadDashboardResult | undefined>

export type MemorySwitchPatch = { generateMemory: boolean; useMemory?: never } | { useMemory: boolean; generateMemory?: never }
export type MemorySettingsMutationResult = { kind: 'ignored' | 'failed' } |
  { kind: 'saved'; settings: { generateMemory: boolean; useMemory: boolean } }
export function createMemorySettingsMutation(actions: {
  readDashboard: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>;
  updateSettingsAck: (patch: MemorySwitchPatch) => Promise<import('../remote-contract.js').ReadDashboardAck>
}): {
  save(patch: MemorySwitchPatch): Promise<MemorySettingsMutationResult>;
  retry(): Promise<MemorySettingsMutationResult>; hasFailed(): boolean; dispose(): void
}
export function memoryDayPresentation(cell: MemoryDay, index: number, firstWeekday: number, weeks: number): {
  text: string; level: number; x: number; edge: 'left' | 'middle' | 'right'
}
