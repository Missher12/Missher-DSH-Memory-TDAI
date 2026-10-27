import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface BillableUsageReceipt {
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  costMicros: number | null
}

export type BillableResultOperation =
  | { kind: 'extraction'; projectKey: string; jobId: string; attemptId: string }
  | { kind: 'project_persona'; projectKey: string; sourceIds: string[]; sourceRevisions: Record<string, number>; policyRevision: string; sourceCount: number }
  | { kind: 'global_persona'; policyRevision?: string; projectKey: '*'; projects: string[]; sources: Array<{ projectKey: string; id: string; revision: number }>; sourceCount: number }

export interface SavedBillableResult {
  version: 1
  callId: string
  projectKey: string
  purpose: string
  provider: string
  model: string
  requestHash: string
  responseText: string
  usage: BillableUsageReceipt
  operation: BillableResultOperation
  savedAt: number
}

const MAX_RESPONSE_BYTES = 1_000_000
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u

function safeDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('billable response directory must be a regular directory')
  chmodSync(directory, 0o700)
  return realpathSync(directory)
}

function responseHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Private local response storage; the content-free control ledger keeps only its path hash. */
export class BillableResultStore {
  readonly directory: string

  constructor(root: string) {
    this.directory = safeDirectory(path.join(path.resolve(root), 'billable-results'))
  }

  save(result: SavedBillableResult): { sha256: string; file: string } {
    if (!CALL_ID_PATTERN.test(result.callId)) throw new Error('invalid billable response id')
    if (result.version !== 1 || result.responseText.length === 0 || result.responseText.length > 750_000) throw new Error('billable response is empty or exceeds the local recovery limit')
    const bytes = Buffer.from(`${JSON.stringify(result)}\n`, 'utf8')
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('billable response file exceeds the local recovery limit')
    const sha256 = responseHash(bytes)
    const file = path.join(this.directory, `${result.callId}.json`)
    if (existsSync(file)) {
      const prior = this.load(result.callId)
      if (prior.sha256 !== sha256) throw new Error('billable response id already contains a different result')
      chmodSync(file, 0o600)
      return { sha256, file }
    }
    const temporary = path.join(this.directory, `.${result.callId}.${randomUUID()}.partial`)
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    try {
      renameSync(temporary, file)
    } catch (error) {
      try { lstatSync(temporary); } catch { throw error }
      throw error
    }
    try {
      const directoryFd = openSync(this.directory, 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch {
      // Some supported filesystems do not allow directory fsync; the response file itself is synced before rename.
    }
    return { sha256, file }
  }

  load(callId: string, expectedHash?: string): { result: SavedBillableResult; sha256: string; file: string } {
    if (!CALL_ID_PATTERN.test(callId)) throw new Error('invalid billable response id')
    const file = path.join(this.directory, `${callId}.json`)
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RESPONSE_BYTES) throw new Error('billable response file is not a safe bounded regular file')
    const bytes = readFileSync(file)
    const sha256 = responseHash(bytes)
    if (expectedHash !== undefined && sha256 !== expectedHash) throw new Error('billable response hash does not match the control ledger')
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<SavedBillableResult>
    if (parsed.version !== 1 || parsed.callId !== callId || typeof parsed.projectKey !== 'string' || typeof parsed.purpose !== 'string' ||
        typeof parsed.provider !== 'string' || typeof parsed.model !== 'string' || typeof parsed.requestHash !== 'string' ||
        typeof parsed.responseText !== 'string' || parsed.responseText.length === 0 || parsed.usage === undefined || parsed.operation === undefined ||
        typeof parsed.savedAt !== 'number' || !Number.isSafeInteger(parsed.savedAt)) {
      throw new Error('billable response file has an invalid schema')
    }
    return { result: parsed as SavedBillableResult, sha256, file }
  }

  callIds(): string[] {
    return lstatSync(this.directory).isDirectory()
      ? readdirSync(this.directory).filter((name) => name.endsWith('.json') && CALL_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort()
      : []
  }

  remove(callId: string): boolean {
    if (!CALL_ID_PATTERN.test(callId)) throw new Error('invalid billable response id')
    const file = path.join(this.directory, `${callId}.json`)
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat === undefined) return false
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RESPONSE_BYTES) throw new Error('billable response file is not a safe bounded regular file')
    unlinkSync(file)
    try { const directoryFd = openSync(this.directory, 'r'); try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) } }
    catch { /* the unlink is the local content removal boundary on unsupported filesystems */ }
    return true
  }

  partialFiles(): string[] {
    return readdirSync(this.directory).filter((name) => name.startsWith('.') && name.endsWith('.partial')).sort()
  }
}
