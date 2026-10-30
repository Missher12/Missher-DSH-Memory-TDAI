import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExtractionJson } from '../lib/extract.js'

test('parses a fenced JSON extraction response', () => {
  const result = parseExtractionJson(`\`\`\`json
{"memories":[
  {"content":"用户偏好使用 pnpm。","kind":"preference","confidence":0.91,"source_message_ids":["u_1"]},
  {"content":"本项目要求测试离线运行。","kind":"project","confidence":0.7}
]}
\`\`\``)
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  const memories = result.ok ? result.memories : []
  assert.equal(memories.length, 2)
  assert.equal(memories[0].kind, 'preference')
  assert.equal(memories[0].confidence, 0.91)
  assert.deepEqual(memories[0].sourceMessageIds, ['u_1'])
  assert.equal(memories[1].kind, 'project')
})

test('accepts valid empty and bare-array responses', () => {
  const empty = parseExtractionJson('{"memories":[]}')
  assert.equal(empty.ok, true)
  assert.ok(empty.ok)
  if (empty.ok) assert.deepEqual(empty.memories, [])
  assert.equal(parseExtractionJson('[]').ok, true)
  const invalidItems = parseExtractionJson('{"memories":[{"content":"x"}]}')
  assert.equal(invalidItems.ok, true, 'item-level filtering keeps a protocol-conforming response valid')
  if (invalidItems.ok) assert.deepEqual(invalidItems.memories, [], 'items that fail field validation are dropped')
})

test('rejects malformed or off-protocol output instead of returning a legal empty result', () => {
  // Unparseable text / truncated JSON must be a visible failure, never [].
  assert.deepEqual(parseExtractionJson('not json'), { ok: false, reason: 'invalid-json' })
  assert.deepEqual(parseExtractionJson('{"memories":[{"content":"a'), { ok: false, reason: 'invalid-json' })
  assert.deepEqual(parseExtractionJson(''), { ok: false, reason: 'invalid-json' })
  assert.deepEqual(parseExtractionJson('   ```   '), { ok: false, reason: 'invalid-json' })
  // Valid JSON that does not carry a memories array is a protocol violation.
  assert.deepEqual(parseExtractionJson('{}'), { ok: false, reason: 'invalid-shape' })
  assert.deepEqual(parseExtractionJson('{"foo":"bar"}'), { ok: false, reason: 'invalid-shape' })
  assert.deepEqual(parseExtractionJson('{"memories":"nope"}'), { ok: false, reason: 'invalid-shape' })
  assert.deepEqual(parseExtractionJson('{"memories":42}'), { ok: false, reason: 'invalid-shape' })
  assert.deepEqual(parseExtractionJson('null'), { ok: false, reason: 'invalid-shape' })
  assert.deepEqual(parseExtractionJson('"hello"'), { ok: false, reason: 'invalid-shape' })
})

test('clamps confidence and coerces unknown kinds on valid items', () => {
  const result = parseExtractionJson('{"memories":[{"content":"有效记忆内容","kind":"unknown","confidence":3}]}')
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.memories.length, 1)
    assert.equal(result.memories[0].kind, 'fact')
    assert.equal(result.memories[0].confidence, 1)
  }
})

test('a non-empty array whose items are all damaged is not a legal empty result', () => {
  // `{memories:[]}` stays a legal empty answer, but a payload whose items are
  // protocol garbage (null, non-objects, or entries without a non-empty string
  // content) must fail so the caller keeps the L0 rows pending.
  assert.deepEqual(parseExtractionJson('{"memories":[null]}'), { ok: false, reason: 'invalid-items' })
  assert.deepEqual(parseExtractionJson('{"memories":[{}]}'), { ok: false, reason: 'invalid-items' })
  assert.deepEqual(parseExtractionJson('{"memories":[{"content":123}]}'), { ok: false, reason: 'invalid-items' })
  assert.deepEqual(parseExtractionJson('{"memories":[{"content":""}]}'), { ok: false, reason: 'invalid-items' })
  assert.deepEqual(parseExtractionJson('{"memories":[null, {}]}'), { ok: false, reason: 'invalid-items' })
  assert.equal(parseExtractionJson('{"memories":[]}').ok, true)
  // Valid items that merely fail per-field filtering keep the lenient behavior.
  assert.equal(parseExtractionJson('{"memories":[{"content":"x"}]}').ok, true)
  // A damaged item alongside a valid one does not poison the valid memory.
  const mixed = parseExtractionJson('{"memories":[null, {"content":"有效内容继续保留。"}]}')
  assert.equal(mixed.ok, true)
  if (mixed.ok) assert.equal(mixed.memories.length, 1)
})
test('extraction preserves all source IDs and rejects oversized results instead of silently dropping tails', () => {
  const ids = Array.from({ length: 24 }, (_, i) => `source-${i}`)
  const memory = { content: 'A preference supported by the complete input batch.', source_message_ids: ids }
  const parsed = parseExtractionJson(JSON.stringify({ memories: [memory] }))
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.memories[0].sourceMessageIds, ids)
  assert.deepEqual(parseExtractionJson(JSON.stringify({ memories: Array.from({ length: 51 }, () => memory) })),
    { ok: false, reason: 'invalid-items' })
  assert.deepEqual(parseExtractionJson(JSON.stringify({ memories: [{ ...memory, source_message_ids: [...ids, null] }] })),
    { ok: false, reason: 'invalid-items' })
})
