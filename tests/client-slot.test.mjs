import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

test('client bundle registers the Memory settings section through the module loader', async () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client', 'index.js')
  const code = readFileSync(file, 'utf8')
  const mounted = []
  const remoteCalls = []
  const sections = []
  const registrations = []
  const cleanups = []
  let loadedId
  let clientModule

  const windowStub = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loadedId = id
        clientModule = factory((name) => {
          if (name === 'react' || name === 'react/jsx-runtime') return require(name)
          throw new Error(`unexpected external module: ${name}`)
        })
      },
    },
  }

  const remote = {
    snapshot: async () => ({ ok: true, value: { version: 1 } }),
    review: async () => ({ ok: true, value: {} }),
    updateSettings: async () => ({ ok: true, value: {} }),
    updateSettingsAck: async (request) => {
      remoteCalls.push({ method: 'updateSettingsAck', request })
      return { ok: true, value: { ok: true, scope: 'global', operation: 'settings.update', result: 'applied' } }
    },
    readDashboard: async (request) => {
      remoteCalls.push({ method: 'readDashboard', request })
      return { ok: true, value: {
        version: 1, status: 'partial', complete: false, view: 'settings',
        generatedAt: 1, readId: '00000000-0000-4000-8000-000000000001',
        reason: `synthetic:${request.action}`,
        settings: {
          mode: 'review', recallMaxTokens: 777, extractionEveryN: 3, extractionEnabled: false,
          includePersona: true, globalPersona: false,
        },
      } }
    },
    export: async () => ({ ok: true, value: { fileName: 'memory.jsonl', content: '' } }),
    refreshPersona: async () => ({ ok: true, value: {} }),
    refreshGlobalPersona: async () => ({ ok: true, value: {} }),
  }

  const ctx = {
    remote: {
      async $mount(packageValue) {
        mounted.push(packageValue)
        return async () => {}
      },
      memoryTdai: remote,
    },
    get(name) {
      return name === 'remote.memoryTdai' ? remote : undefined
    },
    slots: {
      inject(name, callback) {
        sections.push(name)
        callback()
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
  }

  const previousWindow = globalThis.window
  globalThis.window = windowStub
  try {
    const evaluate = new Function('window', code)
    evaluate(windowStub)

    assert.equal(loadedId, '@missher/dsh-memory-tdai')
    assert.equal(typeof clientModule.apply, 'function')
    assert.deepEqual(clientModule.inject, ['slots', 'remote'])

    const unmount = await clientModule.apply(ctx)
    assert.equal(typeof unmount, 'function')
    assert.equal(mounted.length, 1)
    assert.deepEqual(sections, ['settings.section'])
    assert.equal(registrations.length, 1)

    const { definition, component } = registrations[0]
    assert.equal(definition.name, 'settings.section')
    assert.equal(definition.id, 'memory-tdai')
    assert.equal(definition.order, 16)
    assert.equal(definition.label(), 'Memory')
    assert.equal(typeof component, 'function')

    const actions = definition.inject()
    assert.equal(typeof actions.readDashboard, 'function')
    assert.equal(typeof actions.updateSettingsAck, 'function')
    const settingsRead = await actions.readDashboard({ version: 1, action: 'settings' })
    assert.equal(settingsRead.status, 'partial')
    assert.equal(settingsRead.reason, 'synthetic:settings')
    assert.deepEqual(remoteCalls.at(-1), { method: 'readDashboard', request: { version: 1, action: 'settings' } })
    const closeRead = await actions.readDashboard({ version: 1, action: 'close',
      readId: '00000000-0000-4000-8000-000000000001' })
    assert.equal(closeRead.readId, '00000000-0000-4000-8000-000000000001')
    assert.deepEqual(remoteCalls.at(-1), { method: 'readDashboard',
      request: { version: 1, action: 'close', readId: '00000000-0000-4000-8000-000000000001' } })
    const ack = await actions.updateSettingsAck({ mode: 'review', recallMaxTokens: 777 })
    assert.equal(ack.ok, true)
    assert.equal(ack.scope, 'global')
    assert.equal(ack.operation, 'settings.update')
    assert.deepEqual(remoteCalls.at(-1), { method: 'updateSettingsAck',
      request: { mode: 'review', recallMaxTokens: 777 } })

    const originalUpdateSettingsAck = remote.updateSettingsAck
    remote.updateSettingsAck = async (request) => {
      remoteCalls.push({ method: 'updateSettingsAck', request })
      return { ok: true, value: { ok: false, scope: 'global', operation: 'settings.update',
        result: 'rejected', reason: 'synthetic-rejected' } }
    }
    const rejected = await actions.updateSettingsAck({ globalPersona: true })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.result, 'rejected')
    assert.equal(rejected.reason, 'synthetic-rejected')
    remote.updateSettingsAck = originalUpdateSettingsAck

    const originalReadDashboard = remote.readDashboard
    const nativeTransportError = Object.assign(new Error('synthetic-transport'), { code: 'transport' })
    remote.readDashboard = async () => ({ ok: false, error: nativeTransportError })
    await assert.rejects(() => actions.readDashboard({ version: 1, action: 'settings' }), error => error === nativeTransportError)
    remote.readDashboard = originalReadDashboard

    const pendingLoad = () => new Promise(() => {})
    const baseProps = { ...actions, load: pendingLoad }
    const pendingMarkup = renderToStaticMarkup(createElement(component, baseProps))
    // Demo v7 semantic replacement: the real Settings slot now exposes only the compact global surface.
    assert.match(pendingMarkup, /全局记忆/u)
    assert.match(pendingMarkup, /aria-label="记忆设置"/u)
    assert.match(pendingMarkup, /正在读取/u)
    for (const label of ['原始对话', '提炼记忆', '场景索引', '画像', '记忆活动', '最近活动']) assert.ok(pendingMarkup.includes(label))
    for (const label of ['处理状态', '召回解释', '任务接续', '经验卡', '修订关系', '决策知识', '本地评测', '用量治理', '恢复', '新建记忆']) assert.ok(!pendingMarkup.includes(label))
    assert.match(pendingMarkup, /data-unknown="true"/u, 'pending calendar cells never claim measured zero')
    assert.match(pendingMarkup, /aria-busy="true"/u)
    const { memoryYear } = await import('../src/client/memory-v7-model.js')
    const pendingYear = memoryYear(new Date().getFullYear(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', [], false)
    assert.equal((pendingMarkup.match(/data-day="/gu) ?? []).length, pendingYear.cells.length)
    assert.equal((pendingMarkup.match(/data-padding="true"/gu) ?? []).length + pendingYear.cells.length, pendingYear.weeks * 7,
      'the pending render already occupies the complete calendar grid')

    const previewSnapshot = {
      version: 1, generatedAt: 1, root: '.', mode: 'review',
      totals: { memories: 0, approved: 0, candidates: 0, forgotten: 0, sessions: 0, projects: 0,
        l0Messages: 0, repeatedQuestions: 0, injectedCount: 0, injectedTokens: 0, rawTokens: 0, savedTokens: 0 },
      sources: [], activity: [], projects: [], candidates: [], recent: [], scenes: [], personas: [],
      globalPersona: null, longestSession: null,
      settings: { mode: 'review', recallMaxTokens: 777, recallMaxResults: 8, dedupeSession: false,
        includePersona: true, globalPersona: false, extractionEveryN: 3, autoApproveConfidence: 0.8,
        extractionEnabled: false },
    }
    const previewMarkup = renderToStaticMarkup(createElement(component, {
      ...baseProps, initialSnapshot: previewSnapshot, readDashboard: undefined, updateSettingsAck: undefined,
    }))
    assert.match(previewMarkup, /全局记忆服务不可用/u, 'a legacy snapshot cannot impersonate a global read')
    assert.doesNotMatch(previewMarkup, /777/u)

    for (const dispose of cleanups) dispose()
    await unmount()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})


function memorySettingsTransport({ write, read } = {}) {
  const calls = [], state = { generateMemory: true, useMemory: true }
  let readId = 0
  return { calls, state, actions: {
    async updateSettingsAck(patch) {
      calls.push({ action: 'save', patch: { ...patch } })
      if (write) return write(patch, state, calls)
      Object.assign(state, patch)
      return { ok: true, scope: 'global', operation: 'settings.update', result: 'applied' }
    },
    async readDashboard(request) {
      calls.push({ ...request })
      if (request.action === 'close') return { status: 'ok', complete: true }
      assert.equal(request.action, 'settings')
      if (read) return read(request, state)
      return { status: 'ok', complete: true, readId: `settings-${++readId}`, settings: { ...state } }
    },
  } }
}

test('Memory settings saves character fields with ACK and exact readback rather than ignoring them', async () => {
  const { createMemorySettingsMutation } = await import('../src/client/memory-v7-model.js')
  const transport = memorySettingsTransport()
  Object.assign(transport.state, { characterEnabled: false, characterDescription: '' })
  const controller = createMemorySettingsMutation(transport.actions)
  try {
    assert.equal((await controller.save({ characterEnabled: true })).kind, 'saved')
    assert.equal(transport.state.characterEnabled, true)
    const result = await controller.save({ characterDescription: '坦率、耐心' })
    assert.equal(result.kind, 'saved')
    assert.equal(result.settings.characterDescription, '坦率、耐心')
  } finally { controller.dispose() }
})

test('Memory settings retry resends the exact failed switch patch and waits for ACK plus matching readback', async () => {
  const { createMemorySettingsMutation } = await import('../src/client/memory-v7-model.js')
  for (const key of ['generateMemory', 'useMemory']) {
    let first = true
    const transport = memorySettingsTransport({ write(patch, state) {
      if (first) { first = false; throw new Error('synthetic transport failure') }
      Object.assign(state, patch)
      return { ok: true, scope: 'global', operation: 'settings.update', result: 'confirmed' }
    } })
    const controller = createMemorySettingsMutation(transport.actions), patch = { [key]: false }
    let visible = { ...transport.state }
    const pending = controller.save(patch); patch[key] = true
    assert.deepEqual(await pending, { kind: 'failed' })
    assert.equal(controller.hasFailed(), true); assert.equal(visible[key], true)
    await Promise.resolve()
    assert.equal(transport.calls.length, 1, 'failure never schedules an automatic write or read')
    assert.deepEqual(await controller.save({ [key]: true }), { kind: 'ignored' }, 'another toggle cannot replace the failed intent')
    transport.actions.updateSettingsAck = async () => { assert.fail('retry must retain the original transport') }
    transport.actions.readDashboard = async () => { assert.fail('readback must retain the original transport') }
    const result = await controller.retry()
    assert.equal(result.kind, 'saved'); visible = result.settings
    assert.equal(visible[key], false); assert.deepEqual(visible, transport.state)
    assert.equal(controller.hasFailed(), false)
    assert.deepEqual(transport.calls.filter((call) => call.action === 'save').map((call) => call.patch), [{ [key]: false }, { [key]: false }])
    assert.deepEqual(transport.calls.filter((call) => call.action !== 'save').map((call) => call.action), ['settings', 'close'])
    assert.deepEqual(await controller.retry(), { kind: 'ignored' })
    controller.dispose()
  }
})

test('Memory settings retry keeps its intent on invalid ACK rejected read or mismatching saved state', async () => {
  const { createMemorySettingsMutation } = await import('../src/client/memory-v7-model.js')
  for (const defect of ['ack-scope', 'ack-operation', 'ack-result', 'ack-noop', 'read-failure', 'read-mismatch', 'read-missing']) {
    let corrected = false
    const transport = memorySettingsTransport({ write(patch, state) {
      Object.assign(state, patch)
      return { ok: true, scope: !corrected && defect === 'ack-scope' ? 'project' : 'global',
        operation: !corrected && defect === 'ack-operation' ? 'review' : 'settings.update',
        result: !corrected && defect === 'ack-result' ? 'rejected' : !corrected && defect === 'ack-noop' ? 'noop' : 'applied' }
    }, read(_request, state) {
      if (!corrected && defect === 'read-failure') return { status: 'unavailable', complete: false, readId: 'failed-read' }
      return { status: 'ok', complete: true, readId: 'saved-read', settings: !corrected && defect === 'read-mismatch'
        ? { ...state, useMemory: true } : !corrected && defect === 'read-missing' ? {} : { ...state } }
    } })
    const controller = createMemorySettingsMutation(transport.actions)
    assert.deepEqual(await controller.save({ useMemory: false }), { kind: 'failed' }, defect)
    assert.equal(controller.hasFailed(), true)
    if (defect.startsWith('ack-')) assert.equal(transport.calls.some((call) => call.action === 'settings'), false)
    corrected = true
    const result = await controller.retry()
    assert.deepEqual(result, { kind: 'saved', settings: { generateMemory: true, useMemory: false } })
    assert.deepEqual(transport.calls.filter((call) => call.action === 'save').map((call) => call.patch), [{ useMemory: false }, { useMemory: false }])
    controller.dispose()
  }
})

test('Memory settings mutation rejects concurrent writes and ignores disposed transport responses while closing their own readers', async () => {
  const { createMemorySettingsMutation } = await import('../src/client/memory-v7-model.js')
  let releaseAck
  const old = memorySettingsTransport({ write: () => new Promise((resolve) => { releaseAck = resolve }) })
  const controller = createMemorySettingsMutation(old.actions)
  const pending = controller.save({ generateMemory: false })
  assert.deepEqual(await controller.save({ useMemory: false }), { kind: 'ignored' })
  assert.deepEqual(await controller.retry(), { kind: 'ignored' })
  assert.equal(old.calls.length, 1)
  controller.dispose()
  const next = memorySettingsTransport(), fresh = createMemorySettingsMutation(next.actions)
  assert.equal((await fresh.save({ useMemory: false })).kind, 'saved')
  releaseAck({ ok: true, scope: 'global', operation: 'settings.update', result: 'applied' })
  assert.deepEqual(await pending, { kind: 'ignored' })
  assert.equal(old.calls.length, 1, 'late ACK cannot start a read or write through either transport')
  assert.deepEqual(await controller.retry(), { kind: 'ignored' }); fresh.dispose()

  let releaseRead, readStarted
  const started = new Promise((resolve) => { readStarted = resolve })
  const late = memorySettingsTransport({ read: () => { readStarted(); return new Promise((resolve) => { releaseRead = resolve }) } })
  const disposed = createMemorySettingsMutation(late.actions), saving = disposed.save({ useMemory: false })
  await started; disposed.dispose()
  releaseRead({ status: 'ok', complete: true, readId: 'old-transport-reader', settings: { generateMemory: true, useMemory: false } })
  assert.deepEqual(await saving, { kind: 'ignored' })
  assert.deepEqual(late.calls.filter((call) => call.action === 'close'), [{ version: 1, action: 'close', readId: 'old-transport-reader' }])
  assert.equal(next.calls.some((call) => call.readId === 'old-transport-reader'), false)
})

test('Memory activity presentation keeps a full 54-column year and separates unknown partial zero and future days', async () => {
  const { memoryYear, memoryDayPresentation } = await import('../src/client/memory-v7-model.js')
  const now = Date.parse('2012-12-31T12:00:00Z'), full = memoryYear(2012, 'UTC', [], true, now)
  assert.equal(full.cells.length, 366); assert.equal(full.firstWeekday, 6); assert.equal(full.weeks, 54)
  assert.equal(full.cells[0].date, '2012-01-01'); assert.equal(full.cells.at(-1).date, '2012-12-31')
  assert.equal(new Set(full.cells.map((cell) => cell.date)).size, 366)
  const last = memoryDayPresentation(full.cells.at(-1), 365, full.firstWeekday, full.weeks)
  assert.ok(last.x > 98 && last.x < 100); assert.equal(last.edge, 'right')
  assert.equal(memoryDayPresentation(full.cells[0], 0, full.firstWeekday, full.weeks).edge, 'left')
  const incomplete = memoryYear(2012, 'UTC', [{ date: '2012-01-02', added: 2, updated: 1, records: ['origin'] }], false, now)
  const unknown = memoryDayPresentation(incomplete.cells[0], 0, incomplete.firstWeekday, incomplete.weeks)
  assert.match(unknown.text, /活动数据未知/u); assert.doesNotMatch(unknown.text, /总记录 0/u); assert.equal(unknown.level, 0)
  const partial = memoryDayPresentation(incomplete.cells[1], 1, incomplete.firstWeekday, incomplete.weeks)
  assert.match(partial.text, /已知至少 总记录 3，新增 2，更新 1/u)
  assert.match(memoryDayPresentation(full.cells[1], 1, full.firstWeekday, full.weeks).text, /总记录 0/u)
  const futureYear = memoryYear(2012, 'America/New_York', [], false, Date.parse('2012-06-01T12:00:00Z'))
  const future = memoryDayPresentation(futureYear.cells.at(-1), 365, futureYear.firstWeekday, futureYear.weeks)
  assert.equal(futureYear.cells.at(-1).future, true); assert.match(future.text, /未来日期/u); assert.doesNotMatch(future.text, /总记录/u)
  assert.deepEqual([0, 1, 3, 7, 15, 31].map((count) => memoryDayPresentation({ ...full.cells[0], count }, 0, 6, 54).level), [0, 1, 2, 3, 4, 5])
  for (const zone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    const year = memoryYear(2024, zone, [], false, Date.parse('2024-11-03T12:00:00Z'))
    assert.equal(year.cells.length, 366); assert.equal(new Set(year.cells.map((cell) => cell.date)).size, 366)
    assert.ok(year.firstWeekday + year.cells.length <= year.weeks * 7)
  }
})


test('Memory settings ignore removed quota mutations without creating a retry intent', async () => {
  const { createMemorySettingsMutation } = await import('../src/client/memory-v7-model.js')
  const transport = memorySettingsTransport({})
  const controller = createMemorySettingsMutation(transport.actions)
  try {
    for (const value of [0, 1, 10000]) {
      assert.deepEqual(await controller.save({ automaticDailyTokens: value, automaticDailyTasks: value }), { kind: 'ignored' })
      assert.equal(controller.hasFailed(), false)
    }
    assert.deepEqual(await controller.retry(), { kind: 'ignored' })
    assert.equal(transport.calls.filter((call) => call.action === 'save').length, 0)
    assert.equal((await controller.save({ useMemory: false })).kind, 'saved')
    assert.equal(transport.calls.filter((call) => call.action === 'save').length, 1)
  } finally { controller.dispose() }
})

test('Memory calendar fills whole weeks and aligns months without inventing padding activity', async () => {
  const { memoryYear } = await import('../src/client/memory-v7-model.js')
  for (const [year, days] of [[2023, 365], [2024, 366], [2012, 366]]) {
    const calendar = memoryYear(year, 'UTC', [], false, Date.UTC(year, 5, 1))
    assert.equal(calendar.cells.length, days)
    assert.equal(calendar.grid.length, calendar.weeks * 7)
    assert.equal(calendar.grid.filter(Boolean).length, days)
    assert.deepEqual(calendar.grid.slice(0, calendar.firstWeekday), Array(calendar.firstWeekday).fill(null))
    assert.ok(calendar.grid.slice(calendar.firstWeekday + days).every((slot) => slot === null))
    assert.deepEqual(calendar.grid.filter(Boolean), calendar.cells)
    for (const month of calendar.months) {
      const first = calendar.grid.findIndex((cell) => cell?.date === `${year}-${String(month.month).padStart(2, '0')}-01`)
      assert.equal(month.column, Math.floor(first / 7) + 1)
      assert.ok(month.span >= 1 && month.column + month.span - 1 <= calendar.weeks)
    }
    assert.equal(calendar.months.reduce((sum, month) => sum + month.span, 0), calendar.weeks)
    assert.equal(calendar.cells[0].known, false); assert.equal(calendar.cells[0].count, 0)
    assert.equal(calendar.cells.at(-1).future, true)
  }
})
