import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

test('client bundle registers the Memory settings section through the module loader', async () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client', 'index.js')
  const code = readFileSync(file, 'utf8')
  const mounted = []
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

    for (const dispose of cleanups) dispose()
    await unmount()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
