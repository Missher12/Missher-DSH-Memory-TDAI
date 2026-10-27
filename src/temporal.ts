export type ValidFromPrecision = 'instant' | 'second' | 'minute' | 'day' | 'month' | 'year' | 'unknown'
export type ValidFromBasis = 'default_record_time' | 'explicit' | 'explicit_unknown'

export interface EffectiveStart {
  state: 'known' | 'unknown'
  precision: ValidFromPrecision
  basis: ValidFromBasis
  value?: number
  upperExclusive?: number
  label?: string
}

function utcStart(year: number, month = 1, day = 1, hour = 0, minute = 0, second = 0, millisecond = 0): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  return date.getTime()
}

/**
 * Missing time uses the legacy record-time policy. Explicit null is a different
 * claim: the source says the effective start is unknown. Partial ISO dates are
 * stored as a bounded uncertainty interval instead of being inflated to an
 * exact instant.
 */
export function normalizeEffectiveStart(input: number | string | null | undefined, now: number): EffectiveStart {
  if (input === undefined) return { state: 'known', value: now, precision: 'instant', basis: 'default_record_time' }
  if (input === null) return { state: 'unknown', precision: 'unknown', basis: 'explicit_unknown' }
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) throw new Error('validFrom must be a non-negative Unix millisecond timestamp')
    return { state: 'known', value: input, precision: 'instant', basis: 'explicit' }
  }

  let match = /^(\d{4})$/u.exec(input)
  if (match !== null) {
    const year = Number(match[1])
    if (year < 1 || year > 9999) throw new Error('validFrom year is out of range')
    return { state: 'known', value: utcStart(year), upperExclusive: utcStart(year + 1), precision: 'year', basis: 'explicit', label: input }
  }

  match = /^(\d{4})-(\d{2})$/u.exec(input)
  if (match !== null) {
    const year = Number(match[1]); const month = Number(match[2])
    if (year < 1 || year > 9999 || month < 1 || month > 12) throw new Error('validFrom month is invalid')
    return { state: 'known', value: utcStart(year, month), upperExclusive: utcStart(year + (month === 12 ? 1 : 0), month === 12 ? 1 : month + 1),
      precision: 'month', basis: 'explicit', label: input }
  }

  match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input)
  if (match !== null) {
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
    const value = utcStart(year, month, day)
    const check = new Date(value)
    if (year < 1 || year > 9999 || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
      throw new Error('validFrom day is invalid')
    }
    return { state: 'known', value, upperExclusive: value + 86_400_000, precision: 'day', basis: 'explicit', label: input }
  }

  const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(input)
  if (timestamp !== null) {
    const parsed = Date.parse(input)
    if (!Number.isSafeInteger(parsed)) throw new Error('validFrom timestamp is invalid')
    const precision: ValidFromPrecision = timestamp[4] === undefined ? 'minute' : timestamp[5] === undefined ? 'second' : 'instant'
    const width = precision === 'minute' ? 60_000 : precision === 'second' ? 1000 : undefined
    return { state: 'known', value: parsed, ...(width === undefined ? {} : { upperExclusive: parsed + width }), precision, basis: 'explicit', label: input }
  }
  throw new Error('validFrom must be null, a Unix millisecond timestamp, or an ISO year, month, day, or timezone-qualified timestamp')
}

export function effectiveStartFromStored(input: {
  state?: unknown
  precision?: unknown
  basis?: unknown
  value?: unknown
  upperExclusive?: unknown
  label?: unknown
  recordedAt?: number
}): EffectiveStart {
  const state = input.state === 'unknown' ? 'unknown' : 'known'
  const precision = input.precision === 'year' || input.precision === 'month' || input.precision === 'day' || input.precision === 'minute' || input.precision === 'second'
    ? input.precision : state === 'unknown' ? 'unknown' : 'instant'
  const basis = input.basis === 'explicit' || input.basis === 'explicit_unknown' ? input.basis : 'default_record_time'
  if (state === 'unknown') return { state, precision: 'unknown', basis: 'explicit_unknown' }
  const value = typeof input.value === 'number' && Number.isSafeInteger(input.value) ? input.value : input.recordedAt ?? 0
  return { state, value, precision, basis,
    ...(typeof input.upperExclusive === 'number' && Number.isSafeInteger(input.upperExclusive) ? { upperExclusive: input.upperExclusive } : {}),
    ...(typeof input.label === 'string' ? { label: input.label } : {}),
  }
}

export function effectiveStartIsUncertainAt(start: EffectiveStart, effectiveAt: number): boolean {
  return start.state === 'unknown' || (start.upperExclusive !== undefined && effectiveAt < start.upperExclusive)
}
