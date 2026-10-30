import type { ReadDashboardRequest, ReadDashboardResult, GlobalMemoryPage } from '../remote-contract.js'
export interface MemoryDay { date: string; added: number; updated: number; records: string[]; known: boolean; future: boolean; count: number }
export function memoryYear(year: number, timeZone: string, days: GlobalMemoryPage['days'], complete: boolean, now?: number): {
  cells: MemoryDay[]; grid: Array<MemoryDay | null>; months: Array<{ month: number; column: number; span: number }>; firstWeekday: number; weeks: number; recentAdded: number; recentComplete: boolean
}
export function memoryMetric(metric?: { value: number | null; relation: string }): string
export function readGlobalMemory(transport: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>,
  request: Extract<ReadDashboardRequest, { action: 'global' }>, cancelled?: () => boolean): Promise<ReadDashboardResult | undefined>
export function readCompleteGlobalMemory(transport: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>,
  request: Extract<ReadDashboardRequest, { action: 'global' }>, cancelled?: () => boolean,
  onProgress?: (value: ReadDashboardResult) => void): Promise<ReadDashboardResult | undefined>

export type MemorySwitchPatch = { generateMemory: boolean; useMemory?: never } | { useMemory: boolean; generateMemory?: never }
export type MemorySettingsPatch = MemorySwitchPatch | { characterEnabled: boolean } | { characterDescription: string }
export type MemorySettingsMutationResult = { kind: 'ignored' | 'failed' } |
  { kind: 'saved'; settings: { generateMemory: boolean; useMemory: boolean; characterEnabled?: boolean; characterDescription?: string } }
export function createMemorySettingsMutation(actions: {
  readDashboard: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>;
  updateSettingsAck: (patch: MemorySettingsPatch) => Promise<import('../remote-contract.js').ReadDashboardAck>
}): {
  save(patch: MemorySettingsPatch): Promise<MemorySettingsMutationResult>;
  retry(): Promise<MemorySettingsMutationResult>; hasFailed(): boolean; dispose(): void
}
export function memoryDayPresentation(cell: MemoryDay, index: number, firstWeekday: number, weeks: number): {
  text: string; level: number; x: number; edge: 'left' | 'middle' | 'right'
}
