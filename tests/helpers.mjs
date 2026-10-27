/**
 * Shared synthetic harness for the Memory-TDAI first-batch regression tests.
 *
 * Everything here uses temporary directories and mock LLM streams only; never
 * a real DSH profile, real credentials, or a real provider call.
 */

const syntheticUsage = { inputTokens: 48, outputTokens: 24 }

function stream(text, finish, usage) {
  return async function* () {
    const first = Math.floor(text.length / 3)
    yield { type: 'text-delta', index: 0, text: text.slice(0, first) }
    yield { type: 'text-delta', index: 0, text: text.slice(first) }
    if (usage !== null) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish }
  }
}

/** An intentionally unmetered stream for missing-usage safety cases. */
export function plainStream(text, finish = { kind: 'stop' }) {
  return stream(text, finish, null)
}

/** A successful synthetic provider stream with an explicit usage receipt. */
export function meteredStream(text, finish = { kind: 'stop' }) {
  return stream(text, finish, syntheticUsage)
}

/** A stream that stalls before its finish chunk until `release()` is called. */
export function gatedStream(text, { holdBeforeFinish = true, usage = null } = {}) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const makeStream = (resolvedText) => (async function* () {
    const first = Math.floor(resolvedText.length / 3)
    yield { type: 'text-delta', index: 0, text: resolvedText.slice(0, first) }
    yield { type: 'text-delta', index: 0, text: resolvedText.slice(first) }
    if (holdBeforeFinish) await gate
    if (usage !== null) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const stream = typeof text === 'function' ? (options) => makeStream(text(options)) : makeStream(text)
  return { stream, release: () => release() }
}

export function meteredGatedStream(text, options = {}) {
  return gatedStream(text, { ...options, usage: Object.hasOwn(options, 'usage') ? options.usage : syntheticUsage })
}

/**
 * A memory that fails loudly if it is ever asked to serve another LLM call.
 * Used to prove excluded sessions never call extraction.
 */
export const neverStream = async function* () {
  throw new Error('llm.stream must not be called for an excluded session')
}

/**
 * Build a synthetic Host context whose `llm.stream` serves `script` entries in
 * call order. Each entry is an async iterable (or a factory returning one).
 */
export function scriptedContext({ script = [], config, session } = {}) {
  const calls = []
  let index = 0
  let liveSession = session
  let explicitSession = session !== undefined
  const standardSession = () => explicitSession ? liveSession : {
      id: 's1',
      header: { cwd: process.cwd(), agentPreset: 'agent-mock' },
      requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
    }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    llm: {
      stream(options) {
        calls.push(options)
        const entry = script[index++]
        if (entry === undefined) {
          throw new Error(`unexpected extra llm.stream call (#${index})`)
        }
        return typeof entry === 'function' ? entry(options) : entry
      },
    },
    sessions: { get: (id) => {
      const current = standardSession()
      return current.id === id ? current : undefined
    } },
    get() {
      return undefined
    },
  }
  return { ctx, calls, config, setSession: (value) => { explicitSession = true; liveSession = value } }
}

/** Create a valid extraction response whose provenance matches the frozen Host prompt. */
export function sourceIdsFromOptions(options) {
  const prompt = (options.messages ?? []).map((message) => {
    if (typeof message.content === 'string') return message.content
    return Array.isArray(message.content) ? message.content.map((part) => part?.text ?? '').join('\n') : ''
  }).join('\n')
  return [...new Set([...prompt.matchAll(/\[(l0_[A-Za-z0-9_-]+)\]/gu)].map((match) => match[1]))]
}

export function sourceAwareStream(makePayload) {
  return (options) => {
    const sourceIds = sourceIdsFromOptions(options)
    const payload = typeof makePayload === 'function' ? makePayload(sourceIds) : makePayload
    return meteredStream(JSON.stringify(payload))()
  }
}

export function sourceAwareGatedStream(makePayload, options) {
  return meteredGatedStream((callOptions) => JSON.stringify(makePayload(sourceIdsFromOptions(callOptions))), options)
}

/**
 * Emit a turn-end event after the synthetic quiet window has elapsed.
 * The runtime's real 1.2 second scheduler remains unchanged; this only moves
 * the fixture clock back while the durable extraction job is queued.
 */
export function endTurnAfterQuietWindow(runtime, session, seq = 999) {
  const wallClock = Date.now
  Date.now = () => wallClock() - 1300
  try {
    runtime.onSessionEvent(session, { type: 'turn/end', seq, data: { turn: seq } })
  } finally {
    Date.now = wallClock
  }
}

/** Advance a queued synthetic extraction through its quiet window. */
export async function withAdvancedClock(milliseconds, callback) {
  const wallClock = Date.now
  Date.now = () => wallClock() + milliseconds
  try {
    return await callback()
  } finally {
    Date.now = wallClock
  }
}

export function userEvent(seq, text) {
  return { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

export function assistantEvent(seq, text = '好的。') {
  return { type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}
