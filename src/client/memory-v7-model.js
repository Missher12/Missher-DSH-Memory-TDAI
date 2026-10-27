import { createSettingsReadController } from './settings-read-state.js'

/** Pure calendar projection: source counts remain partial until the server proves the full range. */
export function memoryYear(year, timeZone, days, complete, now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  const today = `${parts.year}-${parts.month}-${parts.day}`
  const observed = new Map(days.map((day) => [day.date, day]))
  const cells = [], start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1)
  for (let time = start; time < end; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10), row = observed.get(date)
    const future = date > today
    cells.push({ date, added: row?.added ?? 0, updated: row?.updated ?? 0, records: row?.records ?? [],
      known: !future && complete, future, count: (row?.added ?? 0) + (row?.updated ?? 0) })
  }
  // A day is a local calendar label; UTC construction avoids 23/25-hour DST arithmetic.
  const firstWeekday = (new Date(start).getUTCDay() + 6) % 7
  const recent = cells.filter((cell) => !cell.future &&
    Date.parse(`${today}T00:00:00Z`) - Date.parse(`${cell.date}T00:00:00Z`) < 30 * 86400000)
  return { cells, firstWeekday, weeks: Math.ceil((firstWeekday + cells.length) / 7),
    recentAdded: recent.reduce((sum, cell) => sum + cell.added, 0), recentComplete: complete }
}
export function memoryMetric(metric) {
  if (!metric || metric.value === null || metric.relation === 'unknown') return '—'
  return `${metric.relation === 'lower_bound' ? '≥ ' : ''}${metric.value.toLocaleString()}`
}

// One transport queue owns every in-flight read until the original readId has a confirmed close.
const queues = new WeakMap()
export function readGlobalMemory(transport, request, cancelled = () => false) {
  const previous = queues.get(transport) ?? Promise.resolve()
  const task = previous.then(async () => {
    if (cancelled()) return undefined
    let readId, current, items = []
    try {
      current = await transport(request)
      for (let round = 0; round < 17; round += 1) {
        readId = current?.readId ?? readId
        if (cancelled()) return undefined
        if (!['ok', 'partial'].includes(current?.status) || !current.global) throw new Error('读取未完成，请重试')
        items = current.global.layer === 'home' ? current.global.items : [...items, ...current.global.items]
        if (items.length > 128) throw new Error('读取达到上限，请缩小搜索范围')
        if (!current.cursor) return { ...current, global: { ...current.global, items } }
        if (!readId) throw new Error('读取凭据缺失')
        current = await transport({ version: 1, action: 'continue', readId, cursor: current.cursor })
      }
      throw new Error('读取达到总预算上限')
    } finally {
      if (readId) {
        try {
          const closed = await transport({ version: 1, action: 'close', readId })
          if (closed?.status !== 'ok' || closed.complete !== true) throw new Error('unconfirmed')
        } catch { throw new Error('读取资源尚未确认关闭，请重新连接 Memory 服务') }
      } else if (current === undefined) {
        throw new Error('读取资源尚未确认关闭，请重新连接 Memory 服务')
      }
    }
  })
  // Rejected read bodies may retry after a confirmed release. Unknown close outcomes fail closed.
  const queue = task.then(() => undefined).catch((error) => {
    if (/资源尚未确认关闭/.test(String(error))) throw error
  })
  queue.catch(() => {})
  queues.set(transport, queue)
  return task
}


/** One immutable failed switch intent per mounted transport; only an explicit retry writes again. */
export function createMemorySettingsMutation(actions) {
  const updateSettingsAck = actions.updateSettingsAck
  const controller = createSettingsReadController({ readDashboard: actions.readDashboard, updateSettingsAck: async (patch) => {
    const ack = await updateSettingsAck(patch)
    if (ack?.ok !== true || ack.scope !== 'global' || ack.operation !== 'settings.update' ||
        !['applied', 'confirmed'].includes(ack.result)) throw new Error('settings acknowledgement rejected')
    return ack
  } })
  let failed, busy = false
  const send = async (patch) => {
    if (!controller.isActive() || busy || patch === undefined) return { kind: 'ignored' }
    const keys = Object.keys(patch)
    if (keys.length !== 1 || !['generateMemory', 'useMemory'].includes(keys[0]) || typeof patch[keys[0]] !== 'boolean') {
      return { kind: 'ignored' }
    }
    const intent = Object.freeze({ ...patch }), started = controller.startSave(intent)
    if (!started.started) return { kind: 'ignored' }
    busy = true
    try {
      const result = await started.promise
      if (!controller.isActive() || result.kind === 'ignored') return { kind: 'ignored' }
      if (result.kind !== 'saved' || typeof result.settings.generateMemory !== 'boolean' ||
          typeof result.settings.useMemory !== 'boolean' || result.settings[keys[0]] !== intent[keys[0]]) {
        failed = intent
        return { kind: 'failed' }
      }
      failed = undefined
      return { kind: 'saved', settings: { generateMemory: result.settings.generateMemory, useMemory: result.settings.useMemory } }
    } finally { busy = false }
  }
  return {
    save: (patch) => failed === undefined ? send(patch) : Promise.resolve({ kind: 'ignored' }),
    retry: () => send(failed),
    hasFailed: () => failed !== undefined,
    dispose: () => { failed = undefined; controller.dispose() },
  }
}

/** Presentation only: unknown days never become measured zero and all real dates keep their column. */
export function memoryDayPresentation(cell, index, firstWeekday, weeks) {
  const column = Math.floor((firstWeekday + index) / 7), x = (column + .5) / weeks * 100
  const text = cell.future ? `${cell.date}：未来日期` : !cell.known && cell.count === 0 ? `${cell.date}：活动数据未知`
    : `${cell.date}：${cell.known ? '' : '已知至少 '}总记录 ${cell.count}，新增 ${cell.added}，更新 ${cell.updated}`
  return { text, level: cell.future || cell.count === 0 ? 0 : Math.min(5, Math.ceil(Math.log2(cell.count + 1))),
    x, edge: x < 15 ? 'left' : x > 85 ? 'right' : 'middle' }
}
