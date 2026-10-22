import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExtractionJson } from '../lib/extract.js'

test('parses a fenced JSON extraction response', () => {
  const memories = parseExtractionJson(`\`\`\`json
{"memories":[
  {"content":"用户偏好使用 pnpm。","kind":"preference","confidence":0.91,"source_message_ids":["u_1"]},
  {"content":"本项目要求测试离线运行。","kind":"project","confidence":0.7}
]}
\`\`\``)
  assert.equal(memories.length, 2)
  assert.equal(memories[0].kind, 'preference')
  assert.equal(memories[0].confidence, 0.91)
  assert.deepEqual(memories[0].sourceMessageIds, ['u_1'])
  assert.equal(memories[1].kind, 'project')
})

test('rejects malformed output and clamps confidence', () => {
  assert.deepEqual(parseExtractionJson('not json'), [])
  const memories = parseExtractionJson('{"memories":[{"content":"有效记忆内容","kind":"unknown","confidence":3}]}')
  assert.equal(memories.length, 1)
  assert.equal(memories[0].kind, 'fact')
  assert.equal(memories[0].confidence, 1)
  assert.deepEqual(parseExtractionJson('{"memories":[{"content":"x"}]}'), [])
})
