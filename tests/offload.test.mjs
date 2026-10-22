import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryRuntime } from '../lib/memory.js'

test('large text tool results are offloaded and retrievable by id', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdai-offload-'))
  let runtime
  try {
    const cwd = process.cwd()
    runtime = new MemoryRuntime(
      { logger: { info() {}, warn() {}, debug() {}, error() {} }, get() { return undefined } },
      resolveConfig({ offload: { enabled: true, minChars: 100 } }),
      root,
    )
    const text = `tool output line\n${'x'.repeat(2000)}`
    const decision = runtime.offloadToolResult(
      { name: 'bash', agent: { session: { header: { cwd } } } },
      { content: [{ type: 'text', text }] },
      { kind: 'accept' },
    )
    assert.equal(decision.kind, 'accept')
    const placeholder = decision.content[0].text
    assert.match(placeholder, /offloaded/)
    const id = placeholder.match(/id=(off_[a-f0-9]+)/)?.[1]
    assert.ok(id)
    assert.equal(runtime.readRaw(cwd, id), text)
    assert.equal(runtime.dashboard().totals.savedTokens > 0, true)
  } finally {
    runtime?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
