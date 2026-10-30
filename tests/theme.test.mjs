import assert from 'node:assert/strict'
import test from 'node:test'

test('U09 inherited Host light and dark take precedence over opposite system preferences', async () => {
  const { resolveDashboardTheme } = await import('../src/client/theme.js')
  assert.equal(resolveDashboardTheme('dark', false), 'dark', 'Host dark with OS light reproduces the observed mismatch')
  assert.equal(resolveDashboardTheme('light', true), 'light', 'explicit Host light must also win over OS dark')
  assert.equal(resolveDashboardTheme('only dark', false), 'dark')
  assert.equal(resolveDashboardTheme('light only', true), 'light')
  for (const scheme of [undefined, '', 'normal', 'light dark', 'dark light']) {
    assert.equal(resolveDashboardTheme(scheme, false), 'light')
    assert.equal(resolveDashboardTheme(scheme, true), 'dark')
  }
})

test('U09 theme subscription follows Host and system changes without observing its own palette and cleans up', async () => {
  const { observeDashboardTheme } = await import('../src/client/theme.js')
  let scheme = 'dark'
  let mutation
  let disconnected = false
  let nextFrame = 0
  const frames = new Map()
  const listeners = new Set()
  const observed = []
  const html = { parentElement: null }
  const body = { parentElement: html }
  const head = {}
  const media = { matches: false,
    addEventListener: (event, listener) => { assert.equal(event, 'change'); listeners.add(listener) },
    removeEventListener: (event, listener) => { assert.equal(event, 'change'); listeners.delete(listener) } }
  const view = {
    matchMedia: (query) => { assert.equal(query, '(prefers-color-scheme: dark)'); return media },
    getComputedStyle: (element) => { assert.equal(element, body, 'read inherited Host scheme above plugin overrides'); return { colorScheme: scheme } },
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id) => frames.delete(id),
    MutationObserver: class {
      constructor(callback) { mutation = callback }
      observe(element, options) { observed.push({ element, options }) }
      disconnect() { disconnected = true }
    },
  }
  const root = Object.freeze({ parentElement: body, ownerDocument: { defaultView: view, documentElement: html, head } })
  const themes = []
  const dispose = observeDashboardTheme(root, (theme) => themes.push(theme))
  const flushFrame = () => {
    const callbacks = [...frames.values()]; frames.clear()
    for (const callback of callbacks) callback()
  }
  const systemChange = (dark) => { media.matches = dark; for (const listener of listeners) listener() }
  assert.deepEqual(themes, ['dark'])
  assert.deepEqual(observed.map(({ element }) => element), [body, html, head])
  assert.ok(observed.slice(0, 2).every(({ options }) => options.attributes === true && options.subtree === undefined))
  assert.equal(observed[2].options.characterData, true, 'Host stylesheet replacement is observed as well as attributes')
  scheme = 'light'; mutation(); mutation()
  assert.equal(frames.size, 1, 'coalesce a Host theme batch')
  systemChange(true); flushFrame()
  assert.deepEqual(themes, ['dark', 'light'], 'explicit light survives opposite OS preference')
  scheme = 'light dark'; mutation(); flushFrame()
  assert.deepEqual(themes, ['dark', 'light', 'dark'], 'standalone/system mode adopts the current OS setting')
  systemChange(false); flushFrame()
  assert.deepEqual(themes, ['dark', 'light', 'dark', 'light'])
  scheme = 'dark'; mutation(); flushFrame()
  assert.deepEqual(themes, ['dark', 'light', 'dark', 'light', 'dark'], 'Host can switch back to explicit dark at runtime')
  mutation(); dispose()
  assert.equal(disconnected, true)
  assert.equal(listeners.size, 0)
  assert.equal(frames.size, 0)
  mutation(); systemChange(true); flushFrame()
  assert.equal(themes.length, 5, 'disposed Shell cannot publish a late theme')
})
