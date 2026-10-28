import test from 'node:test'
import assert from 'node:assert/strict'
import { harvest, searchSession, searchSpans, textOfEvent } from '../src/session-search.js'

const user = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const assistant = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const result = text => ({ type: 'tool/result', data: { content: [{ type: 'text', text }] } })

/** A minimal stand-in for the host session: a surface order plus addressable events. */
function fakeSession(events) {
  const bySeq = new Map(events.map((event, index) => [index + 1, event]))
  return {
    surface: { nodes: [...bySeq.keys()] },
    eventAt: seq => bySeq.get(seq),
  }
}

test('event text is read from every shape the host uses', () => {
  assert.equal(textOfEvent(user('甲')), '甲')
  assert.equal(textOfEvent(assistant('乙')), '乙')
  assert.equal(textOfEvent(result('丙')), '丙')
  assert.equal(textOfEvent({ type: 'x', data: { text: '丁' } }), '丁')
  assert.equal(textOfEvent({ type: 'x', data: {} }), '')
})

test('harvest follows surface order and skips empty events', () => {
  const session = fakeSession([user('第一句'), { type: 'noise', data: {} }, result('第三句')])
  const spans = harvest(session)
  assert.deepEqual(spans.map(span => span.seq), [1, 3])
  assert.equal(spans[0].text, '第一句')
})

test('a literal hit outranks a loose term overlap', () => {
  const spans = [
    { seq: 1, type: 'tool/result', text: '改了配置，重新跑了一遍构建，输出正常。' },
    { seq: 2, type: 'tool/result', text: 'mod 源包: D:\\modsss\\HD2 LUA_AR834269 已解包' },
  ]
  const out = searchSpans(spans, 'HD2 LUA_AR834269', { limit: 1 })
  assert.equal(out.spans.length, 1)
  assert.equal(out.spans[0].seq, 2)
})

test('a long span is quoted at its densest window rather than its head', () => {
  const filler = '日志行。'.repeat(400)
  const spans = [{ seq: 7, type: 'tool/result', text: `${filler}关键路径 D:\\modsss\\bingus\\boot.lua 在这里${filler}` }]
  const out = searchSpans(spans, 'boot.lua', { limit: 1, maxSpanBytes: 300 })
  assert.ok(out.spans[0].text.includes('boot.lua'), out.spans[0].text)
  assert.ok(Buffer.byteLength(out.spans[0].text) <= 340)
})

test('the byte budget is respected across several spans', () => {
  const spans = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, type: 'x', text: `alpha beta ${'filler '.repeat(200)}` }))
  const out = searchSpans(spans, 'alpha beta', { limit: 5, maxSpanBytes: 400, maxTotalBytes: 700 })
  assert.ok(out.bytes <= 700, String(out.bytes))
  assert.ok(out.spans.length >= 1)
})

test('a session without an addressable surface reports that instead of throwing', () => {
  assert.deepEqual(harvest({}), [])
  const out = searchSession({}, 'anything')
  assert.equal(out.spans.length, 0)
  assert.match(out.note, /没有可检索的原文/)
})
