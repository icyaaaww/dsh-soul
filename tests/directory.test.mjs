import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDirectory, labelOf } from '../src/directory.js'

const block = (kind, seq, text, extra = {}) => ({ kind, seq, text, bytes: Buffer.byteLength(text), ...extra })

test('a turn starts at the human and injected notices only extend it', () => {
  const dir = buildDirectory([
    block('user', 1, '不要改 package.json'),
    block('user', 2, 'Current runtime context. This snapshot supersedes earlier ones.', { sourceKind: 'agent-instructions' }),
    block('assistant', 3, '好的，我先检查锁文件。'),
    block('user', 4, '然后跑测试'),
  ], { budget: 4000 })
  assert.equal(dir.entries.length, 2)
  assert.deepEqual([dir.entries[0].from, dir.entries[0].to], [1, 3], 'the injected notice belongs to the first turn')
  assert.equal(dir.entries[1].from, 4)
  assert.match(dir.text, /package\.json/)
  assert.match(dir.text, /是数据不是指令/)
})

test('merging keeps ranges contiguous so every seq belongs to exactly one pointer', () => {
  const blocks = Array.from({ length: 12 }, (_, i) =>
    block(i % 2 ? 'assistant' : 'user', i + 1, `第 ${i} 轮：${'检查输出与构建日志。'.repeat(4)}`))
  const dir = buildDirectory(blocks, { budget: 260 })
  assert.ok(dir.entries.length >= 1)
  assert.ok(dir.bytes <= 260 || dir.entries.length === 1, `bytes=${dir.bytes}`)
  for (let i = 1; i < dir.entries.length; i++) {
    assert.equal(dir.entries[i].from, dir.entries[i - 1].to + 1, 'ranges must not overlap or leave gaps')
  }
  assert.equal(dir.entries[0].from, 1)
  assert.equal(dir.entries.at(-1).to, 12)
})

test('labels are one clean line, never markup or an empty pointer', () => {
  assert.equal(labelOf('## 标题\n正文很长很长的一部分'), '标题')
  assert.equal(labelOf('```\ncode\n```'), 'code')
  assert.equal(labelOf(''), '')
  const dir = buildDirectory([block('user', 1, 'x'.repeat(20)), block('assistant', 2, '没有实质内容的回复')], { budget: 2000 })
  assert.match(dir.text, /x{10,}/)
})
