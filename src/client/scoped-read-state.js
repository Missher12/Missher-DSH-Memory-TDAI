export function libraryReadState({ active, hasProject, hasReader, scope, loadedScope, errorScope }) {
  if (!active || !hasProject || !hasReader) return 'idle'
  if (errorScope === scope) return 'error'
  if (loadedScope === scope) return 'ready'
  return 'loading'
}

export function overviewRestoreDecision({ pending, active, scopeMatches, canRead, loading, contentReady, targetReady, failed, interacted }) {
  if (!pending || !active || !scopeMatches || !canRead || interacted) return 'cancel'
  if (failed) return 'cancel'
  if (loading || !contentReady || !targetReady) return 'wait'
  return 'restore'
}

const REPEATED_FAILURE_STATUSES = new Set(['stale', 'expired', 'evicted', 'unavailable'])

/**
 * Classify one repeated read result without turning a failure or an
 * incomplete scan into an empty success. The aggregate owns the business
 * status, target, and completeness; this helper only decides whether the UI
 * may publish rows, may continue, or must surface an error.
 */
export function classifyRepeatedResult(result, target) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { kind: 'failed', reason: 'repeat-result-missing', clear: true }
  }
  const status = result.status
  if (typeof status !== 'string' || typeof result.generatedAt !== 'number') {
    return { kind: 'failed', reason: 'repeat-result-invalid', clear: true }
  }
  if (REPEATED_FAILURE_STATUSES.has(status)) {
    return { kind: 'failed', reason: typeof result.reason === 'string' ? result.reason : status, clear: true }
  }
  if (status !== 'ok' && status !== 'partial' && status !== 'budget_exhausted') {
    return { kind: 'failed', reason: typeof result.reason === 'string' ? result.reason : status, clear: true }
  }
  const repeated = result.repeated
  if (repeated === null || typeof repeated !== 'object' || repeated.target !== target) {
    return { kind: 'failed', reason: 'repeat-result-incomplete', clear: true }
  }
  const reason = typeof repeated.reason === 'string' ? repeated.reason
    : typeof result.reason === 'string' ? result.reason : undefined
  if (repeated.complete === true && status === 'ok') {
    return { kind: 'complete', repeated, reason: undefined }
  }
  return { kind: 'incomplete', repeated, reason: reason ?? 'repeat-scan-incomplete', status }
}

/**
 * Shared lifecycle for the bounded repeated-capture reads. It owns a numeric
 * generation only: every in-flight RPC result is checked against the current
 * generation before the caller may apply it, so a superseded scope, a newer
 * request, or a disposed component can never publish a late page. It performs
 * no state mutation by itself and never opens a browser or a second reader.
 */
export function createRepeatedReadController({ readDashboard } = {}) {
  let active = true
  let generation = 0
  const call = async (payload) => {
    try { return { ok: true, result: await readDashboard(payload) } }
    catch (error) { return { ok: false, error } }
  }
  const start = () => {
    if (!active) return undefined
    generation += 1
    return generation
  }
  const isCurrent = (token) => active && Number.isSafeInteger(token) && token === generation
  const usable = () => active && typeof readDashboard === 'function'
  const load = async (token, request, { maxContinuations = 16, collectEvents = false } = {}) => {
    if (!isCurrent(token) || !usable()) return { stale: true }
    let response = await call(request)
    if (!isCurrent(token)) return { stale: true }
    if (!response.ok) return { error: response.error }
    let result = response.result
    const events = []
    const collect = () => {
      if (!collectEvents) return
      const list = result?.repeated?.events
      if (Array.isArray(list)) events.push(...list)
    }
    collect()
    let steps = 0
    // Only an in-progress scan pause is followed automatically. A ranking or
    // event page cursor is returned to the caller for an explicit load-more.
    while (isCurrent(token) && steps < maxContinuations && result !== null && typeof result === 'object' &&
        result.status === 'budget_exhausted' && typeof result.cursor === 'string') {
      response = await call({ version: 1, action: 'continue', readId: request.readId, cursor: result.cursor })
      if (!isCurrent(token)) return { stale: true }
      if (!response.ok) return { error: response.error }
      result = response.result
      collect()
      steps += 1
    }
    if (!isCurrent(token)) return { stale: true }
    return { result, events }
  }
  const next = async (token, request) => {
    if (!isCurrent(token) || !usable() || typeof request?.cursor !== 'string') return { stale: true }
    const response = await call({ version: 1, action: 'continue', readId: request.readId, cursor: request.cursor })
    if (!isCurrent(token)) return { stale: true }
    return response.ok ? { result: response.result } : { error: response.error }
  }
  const resume = async (token, request, { maxContinuations = 16, collectEvents = false } = {}) => {
    if (!isCurrent(token) || !usable() || typeof request?.cursor !== 'string' || typeof request?.readId !== 'string') {
      return { stale: true }
    }
    let response = await call({ version: 1, action: 'continue', readId: request.readId, cursor: request.cursor })
    if (!isCurrent(token)) return { stale: true }
    if (!response.ok) return { error: response.error }
    let result = response.result
    const events = []
    const collect = () => {
      if (!collectEvents) return
      const list = result?.repeated?.events
      if (Array.isArray(list)) events.push(...list)
    }
    collect()
    let steps = 0
    while (isCurrent(token) && steps < maxContinuations && result !== null && typeof result === 'object' &&
        result.status === 'budget_exhausted' && typeof result.cursor === 'string') {
      response = await call({ version: 1, action: 'continue', readId: request.readId, cursor: result.cursor })
      if (!isCurrent(token)) return { stale: true }
      if (!response.ok) return { error: response.error }
      result = response.result
      collect()
      steps += 1
    }
    if (!isCurrent(token)) return { stale: true }
    return { result, events }
  }
  const dispose = () => {
    if (!active) return
    active = false
    generation += 1
  }
  return { start, isCurrent, load, next, resume, dispose }
}

// The backend owns two sessions, including suspended cursors. Sharing by the
// original transport also accounts for independent settings/directory readers.
const dashboardAdmissions = new WeakMap()
function dashboardAdmission(source) {
  let admission = dashboardAdmissions.get(source)
  if (admission !== undefined) return admission
  let used = 0
  let failed
  const queue = []
  const drain = () => {
    while (failed === undefined && used < 2 && queue.length > 0) {
      const ticket = queue.shift()
      ticket.queued = false
      used += 1
      let released = false
      ticket.release = () => {
        if (released) return
        released = true
        used -= 1
        drain()
      }
      ticket.resolve(ticket.release)
    }
  }
  admission = {
    acquire() {
      let ticket
      const promise = new Promise((resolve, reject) => {
        ticket = { resolve, reject, queued: false }
        if (failed !== undefined) { reject(failed); return }
        if (queue.length >= 16) { reject(new Error('Dashboard read queue is full')); return }
        ticket.queued = true
        queue.push(ticket)
        drain()
      })
      return { promise, get release() { return ticket.release }, cancel() {
        if (!ticket.queued) return
        ticket.queued = false
        queue.splice(queue.indexOf(ticket), 1)
        ticket.resolve(undefined)
      } }
    },
    fail(error) {
      // A lost allocation/close response cannot prove the server released its
      // slot. Fail closed on this transport; never retry or raise its capacity.
      failed ??= error instanceof Error ? error : new Error('Dashboard transport outcome is unknown')
      for (const ticket of queue.splice(0)) { ticket.queued = false; ticket.reject(failed) }
    },
  }
  dashboardAdmissions.set(source, admission)
  return admission
}

/** One page generation owns admission from allocation through awaited close. */
export function createDashboardReadController({ readDashboard, getAdmission = dashboardAdmission } = {}) {
  let generation = 0
  let disposed = false
  let transport = readDashboard
  let admission
  let current
  let boundId
  const retiring = new Set()
  const isCurrent = (token) => !disposed && token === generation
  const closeState = (state) => {
    if (state === undefined) return Promise.resolve()
    if (state.cleanup !== undefined) return state.cleanup
    state.cancelled = true
    state.ticket.cancel()
    if (current === state) current = undefined
    retiring.add(state)
    state.cleanup = (async () => {
      await state.work
      try {
        if (typeof state.readId === 'string' && state.readId !== '') {
          const response = await state.source({ version: 1, action: 'close', readId: state.readId })
          const result = response?.result ?? response
          if (response?.ok === false || !['ok', 'stale', 'expired', 'evicted'].includes(result?.status)) {
            throw new Error('Dashboard reader close was not confirmed')
          }
        }
        state.release?.()
      } catch (error) { state.admission.fail(error) }
      finally { retiring.delete(state) }
    })()
    return state.cleanup
  }
  const start = (nextTransport = transport) => {
    void closeState(current)
    boundId = undefined
    if (typeof nextTransport === 'function') transport = nextTransport
    generation += 1
    return generation
  }
  const load = (token, request, { maxContinuations = 16 } = {}) => {
    if (!isCurrent(token)) return Promise.resolve({ stale: true })
    if (typeof transport !== 'function') return Promise.resolve({ error: new Error('readDashboard transport is unavailable') })
    let state = current
    if (state === undefined) {
      admission ??= getAdmission(transport)
      state = { source: transport, admission, ticket: admission.acquire(), readId: boundId,
        cancelled: false, busy: false, work: Promise.resolve(), cleanup: undefined, release: undefined }
      current = state
    }
    if (state.busy) return Promise.resolve({ error: new Error('Dashboard reader already has an in-flight operation') })
    state.busy = true
    const allocating = (request.action === 'bootstrap' || request.action === 'settings') && request.readId === undefined
    const run = async () => {
      try {
        state.release ??= state.ticket.release ?? await state.ticket.promise
        if (state.release === undefined || state.cancelled || !isCurrent(token)) return { stale: true }
        if (allocating && state.readId !== undefined) return { error: new Error('Dashboard reader already owns a session') }
        if (!allocating && state.readId === undefined) state.readId = request.readId
        if (request.readId !== undefined && state.readId !== request.readId) {
          return { error: new Error('Dashboard reader ownership mismatch') }
        }
        const call = async (payload) => {
          const response = await state.source(payload)
          const result = response?.result ?? response
          if (result === null || typeof result !== 'object' || typeof result.status !== 'string') throw new Error('Dashboard response is invalid')
          // Bind even a late bootstrap to its origin, before checking generation.
          if (typeof result?.readId === 'string') {
            if (state.readId !== undefined && state.readId !== result.readId) throw new Error('Dashboard response ownership mismatch')
            state.readId = result.readId
          }
          if (response?.ok === false) throw response.error ?? new Error('dashboard read rejected')
          return result
        }
        let result = await call(request)
        if (allocating && state.readId === undefined && (['ok', 'partial'].includes(result.status) || typeof result.cursor === 'string')) {
          throw new Error('Dashboard allocation returned no readId')
        }
        let steps = 0
        const limit = Math.max(0, Math.min(16, maxContinuations))
        while (!state.cancelled && isCurrent(token) && result?.status === 'budget_exhausted' &&
            typeof result.cursor === 'string' && steps < limit) {
          result = await call({ version: 1, action: 'continue', readId: state.readId, cursor: result.cursor })
          steps += 1
        }
        return state.cancelled || !isCurrent(token) ? { stale: true } : { result }
      } catch (error) {
        if (allocating && state.release !== undefined && state.readId === undefined) state.admission.fail(error)
        return state.cancelled || !isCurrent(token) ? { stale: true } : { error }
      } finally { state.busy = false }
    }
    let settleWork
    state.work = new Promise((resolve) => { settleWork = resolve })
    const work = run()
    void work.then(settleWork, settleWork)
    return work.then(async (outcome) => {
      const stale = state.cancelled || !isCurrent(token)
      if (stale || 'error' in outcome || state.readId === undefined ||
          ['stale', 'expired', 'evicted', 'unavailable', 'scope_limit'].includes(outcome.result?.status)) {
        await closeState(state)
      }
      return stale || !isCurrent(token) ? { stale: true } : outcome
    })
  }
  const closeCurrent = () => {
    boundId = undefined
    void closeState(current)
    return Promise.all([...retiring].map((state) => state.cleanup)).then(() => {})
  }
  const dispose = () => {
    disposed = true
    generation += 1
    return closeCurrent()
  }
  return { start, rebind: start, isCurrent, load, closeCurrent, invalidate: start, dispose,
    bind(id) { if (typeof id === 'string') { if (current !== undefined) current.readId = id; else boundId = id } },
    get readId() { return current?.readId ?? boundId } }
}

/** Page ownership is independent; admission is shared across the transport. */
export function createDashboardReaderPool({ readDashboard } = {}) {
  let active = true
  const readers = new Map()
  let disposal
  let admission
  // Rebinding the pool does not create another two slots while its old calls close.
  const getAdmission = (source) => admission ??= dashboardAdmission(source)
  return {
    get(name) {
      if (!active || typeof name !== 'string' || name === '') return undefined
      let reader = readers.get(name)
      if (reader === undefined) {
        if (readers.size >= 12) return undefined
        reader = createDashboardReadController({ readDashboard, getAdmission })
        readers.set(name, reader)
      }
      return reader
    },
    dispose() {
      if (disposal !== undefined) return disposal
      active = false
      const closing = [...readers.values()].map((reader) => reader.dispose())
      readers.clear()
      disposal = Promise.all(closing).then(() => {})
      return disposal
    },
  }
}

/** Open a bounded project scope for one page-owned reader. */
export async function openDashboardScope(controller, token, projectKey, range) {
  if (controller === undefined || !controller.isCurrent(token) || typeof projectKey !== 'string' || projectKey === '') {
    return { stale: true }
  }
  const outcome = await controller.load(token, {
    version: 1, action: 'bootstrap', projectKeys: [projectKey], range,
  }, { maxContinuations: 16 })
  if ('stale' in outcome || 'error' in outcome) return outcome
  const result = outcome.result
  if (result.status !== 'ok' || typeof result.readId !== 'string') {
    await controller.closeCurrent()
    return { error: new Error(result.reason ?? `bounded bootstrap failed (${result.status})`), result }
  }
  return { readId: result.readId, result }
}

function mergeDashboardPage(previous, next, action) {
  if (action === 'scene' && previous.scene !== undefined && next.scene !== undefined) {
    const items = [...previous.scene.items]
    const visibleKeys = new Set(items.flatMap((item) => item.state === 'visible' && item.name !== undefined
      ? [`${item.projectKey}\u0000${item.name}`] : []))
    for (const item of next.scene.items) {
      const key = item.state === 'visible' && item.name !== undefined ? `${item.projectKey}\u0000${item.name}` : undefined
      if (key !== undefined && visibleKeys.has(key)) continue
      items.push(item)
      if (key !== undefined) visibleKeys.add(key)
    }
    return { ...next, scene: { ...next.scene, items } }
  }
  if (action === 'detail' && Array.isArray(previous.events) && Array.isArray(next.events)) {
    const events = new Map(previous.events.map((event) => [event.id, event]))
    for (const event of next.events) events.set(event.id, event)
    return { ...next, events: [...events.values()] }
  }
  return next
}

/** Continue one page-owned view, retaining rows returned by per-view cursors. */
export async function continueDashboardScopedPage(controller, token, readId, cursor, action, maxContinuations = 16) {
  if (controller === undefined || !controller.isCurrent(token) || typeof readId !== 'string' || typeof cursor !== 'string') {
    return { stale: true }
  }
  let result
  let nextCursor = cursor
  let steps = 0
  while (controller.isCurrent(token) && nextCursor !== undefined && steps < Math.min(16, maxContinuations)) {
    const outcome = await controller.load(token, { version: 1, action: 'continue', readId, cursor: nextCursor }, { maxContinuations: 0 })
    if ('stale' in outcome || 'error' in outcome) return outcome
    result = result === undefined ? outcome.result : mergeDashboardPage(result, outcome.result, action)
    nextCursor = result.complete ? undefined : result.cursor
    steps += 1
  }
  if (!controller.isCurrent(token)) return { stale: true }
  if (result === undefined) return { stale: true }
  if (result.complete || result.cursor === undefined) await controller.closeCurrent()
  if (!controller.isCurrent(token)) return { stale: true }
  return { readId, result, complete: result.complete && result.status === 'ok', cursor: result.complete ? undefined : result.cursor }
}

/** Open and read one page-owned view, following only its opaque page cursors. */
export async function readDashboardScopedPage(controller, token, { projectKey, range, request, maxContinuations = 16 }) {
  const opened = await openDashboardScope(controller, token, projectKey, range)
  if ('stale' in opened || 'error' in opened) return opened
  const outcome = await controller.load(token, { ...request, readId: opened.readId }, { maxContinuations: 0 })
  if ('stale' in outcome || 'error' in outcome) return outcome
  let result = outcome.result
  let cursor = result.complete ? undefined : result.cursor
  if (cursor !== undefined && maxContinuations > 0) {
    const continued = await continueDashboardScopedPage(controller, token, opened.readId, cursor, request.action, maxContinuations)
    if ('stale' in continued || 'error' in continued) return continued
    result = mergeDashboardPage(result, continued.result, request.action)
    cursor = result.complete ? undefined : continued.cursor
  }
  if (!controller.isCurrent(token)) return { stale: true }
  if (cursor === undefined) await controller.closeCurrent()
  if (!controller.isCurrent(token)) return { stale: true }
  return { readId: opened.readId, result, complete: result.complete && result.status === 'ok', cursor }
}


/** Directory identities have their own transport/generation, never a view scope. */
export function createDashboardProjectDirectory() {
  let generation = 0
  let state = { source: undefined, status: 'idle', projects: [] }
  const isCurrent = (token, source) => token === generation && source === state.source
  const invalidate = (source) => {
    generation += 1
    state = { source, status: 'idle', projects: [] }
  }
  const fail = (token, source) => {
    if (!isCurrent(token, source)) return false
    state = { source, status: 'error', projects: [] }
    return true
  }
  return {
    snapshot: () => state,
    invalidate,
    begin(source) {
      invalidate(source)
      state = { source, status: 'loading', projects: [] }
      return generation
    },
    fail,
    commit(token, source, request, result, projects = result?.projects) {
      if (!isCurrent(token, source)) return false
      // The initiating request proves directory provenance, including when
      // the final response came from one of its bounded continuation pages.
      if (request?.action !== 'bootstrap' || request.readId !== undefined ||
          !Array.isArray(request.projectKeys) || request.projectKeys.length !== 0) return false
      const complete = result?.status === 'selection_required' && result.complete === true && result.cursor === undefined
      const partial = result?.status === 'partial' && result.complete === false
      if (result?.view !== 'bootstrap' || (!complete && !partial) || !Array.isArray(projects) ||
          projects.some((project) => typeof project?.key !== 'string' || project.key === '' || typeof project.name !== 'string')) {
        return fail(token, source)
      }
      const identities = new Map(projects.map(({ key, name }) => [key, { key, name }]))
      state = { source, status: complete ? 'ready' : 'partial', projects: [...identities.values()],
        ...(identities.has(result.activeProjectKey) ? { activeProjectKey: result.activeProjectKey } : {}) }
      return true
    },
  }
}


/** Own one detail return, separate from the overview/library navigation return. */
export function createOverviewDetailReturnController() {
  let context
  let origin
  let pending
  let sequence = 0
  const sync = (next) => {
    if (context === undefined || context.scope !== next.scope || context.transport !== next.transport || context.active !== next.active) {
      origin = undefined
      pending = undefined
      context = { ...next }
    }
  }
  return {
    sync,
    capture(next, value) {
      sync(next)
      pending = undefined
      origin = next.active ? value : undefined
    },
    close(next) {
      sync(next)
      pending = next.active && origin !== undefined ? { token: ++sequence, origin } : undefined
      origin = undefined
      return pending?.token
    },
    peek(token) { return pending?.token === token ? pending?.origin : undefined },
    interact() { pending = undefined },
    cancel() { origin = undefined; pending = undefined },
    take(next, token, { detailOpen, rootReady, targetReady, scrollReady }) {
      sync(next)
      if (pending === undefined || pending.token !== token || !next.active) return undefined
      if (detailOpen) return undefined // Wait for the committed close, never focus behind the detail.
      const saved = pending.origin
      pending = undefined // Consume before focus can emit another interaction.
      if (!rootReady) return undefined
      const restoreOrigin = targetReady && scrollReady
      return { origin: saved, target: restoreOrigin ? 'origin' : 'fallback', restoreScroll: restoreOrigin }
    },
  }
}

/** A single inherited scheme is authoritative; an unspecified/dual scheme follows the OS. */
export function resolveDashboardTheme(colorScheme, systemDark) {
  const schemes = String(colorScheme ?? '').trim().toLowerCase().split(/\s+/u)
  const light = schemes.includes('light')
  const dark = schemes.includes('dark')
  if (light !== dark) return dark ? 'dark' : 'light'
  return systemDark ? 'dark' : 'light'
}

/** Read above the plugin's own palette, and observe only Host ancestors/styles and the OS. */
export function observeDashboardTheme(root, onTheme) {
  const document = root.ownerDocument
  const view = document.defaultView
  if (view === null) return () => {}
  const media = view.matchMedia?.('(prefers-color-scheme: dark)')
  let frame
  let disposed = false
  let previous
  const refresh = () => {
    if (disposed) return
    const parent = root.parentElement ?? document.documentElement
    const theme = resolveDashboardTheme(view.getComputedStyle(parent).colorScheme, media?.matches === true)
    if (theme !== previous) { previous = theme; onTheme(theme) }
  }
  const schedule = () => {
    if (disposed || frame !== undefined) return
    frame = view.requestAnimationFrame(() => { frame = undefined; refresh() })
  }
  const observer = new view.MutationObserver(schedule)
  for (let parent = root.parentElement; parent !== null; parent = parent.parentElement) {
    observer.observe(parent, { attributes: true })
  }
  if (document.head !== null) observer.observe(document.head, { attributes: true, childList: true, characterData: true, subtree: true })
  media?.addEventListener('change', schedule)
  refresh()
  return () => {
    disposed = true
    observer.disconnect()
    media?.removeEventListener('change', schedule)
    if (frame !== undefined) view.cancelAnimationFrame(frame)
  }
}
