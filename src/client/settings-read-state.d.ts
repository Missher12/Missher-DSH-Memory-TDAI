import type {
  ReadDashboardAck, ReadDashboardRequest, ReadDashboardResult, ReadDashboardSettings, UpdateSettingsRequest,
} from '../remote-contract.js'

export function settingsReadId(result: ReadDashboardResult | undefined): string | undefined
export function settingsReadIsCurrent(started: number, current: number, mounted: boolean): boolean
export function isSuccessfulSettingsRead(result: ReadDashboardResult | undefined): result is ReadDashboardResult & { status: 'ok'; complete: true; settings: NonNullable<ReadDashboardResult['settings']> }
export function settingsReadFailure(result: ReadDashboardResult | undefined): string
export function isAcceptedSettingsAck(ack: ReadDashboardAck | undefined): boolean
export function settingsAckMessage(ack: ReadDashboardAck | undefined): string
export function settingsCloseRequest(readId: string): Extract<ReadDashboardRequest, { action: 'close' }>
export function settingsLastErrorNotice(result: ReadDashboardResult | undefined): string | undefined
export function parseSettingsNumberDraft(raw: string, minimum: number, maximum: number):
  { valid: true; value: number } | { valid: false; reason: 'empty' | 'out-of-range' }

export type SettingsReadResult =
  | { kind: 'applied'; settings: ReadDashboardSettings; lastError?: string }
  | { kind: 'failure'; message: string }
  | { kind: 'ignored' }
export type SettingsSaveResult =
  | { kind: 'saved'; acknowledgement: string; settings: ReadDashboardSettings; lastError?: string }
  | { kind: 'read-failed'; acknowledgement: string; message: string }
  | { kind: 'rejected' | 'failed'; message: string }
  | { kind: 'ignored' }
export interface SettingsReadController {
  isActive(): boolean
  isLatestRead(token: number): boolean
  isLatestSave(token: number): boolean
  startRead():
    | { token: number; promise: Promise<SettingsReadResult> }
    | { token: undefined; promise: Promise<{ kind: 'ignored' }>; reason: 'inactive' | 'save-in-progress' }
  startSave(patch: UpdateSettingsRequest): { started: true; token: number; promise: Promise<SettingsSaveResult> } |
    { started: false; reason: 'disposed' | 'in-flight' | 'unavailable' }
  dispose(): void
}
export function createSettingsReadController(options: {
  readDashboard?: (request: ReadDashboardRequest) => Promise<ReadDashboardResult>
  updateSettingsAck?: (request: UpdateSettingsRequest) => Promise<ReadDashboardAck>
}): SettingsReadController
