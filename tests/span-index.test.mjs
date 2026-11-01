import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { ingest, searchIndex } from '../src/span-index.js'

const user = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })

function fakeSession(events) {
  const bySeq = new Map(events.map((event, index) => [index, event]))
  return { seq: events.length, eventAt: seq => bySeq.get(seq) }
}

test('ingest is incremental: a second call with no new events adds nothing', () => {
  const store = new Store(':memory:')
  try {
    const session = fakeSession([user('第一轮：修好了加载器'), user('第二轮：反作弊失效')])
    const first = ingest(store, 'p', session)
    assert.deepEqual([first.added, first.watermark, first.total, first.remaining], [2, 1, 2, 0])
    assert.equal(ingest(store, 'p', session).added, 0)
    assert.equal(store.spanCoverage('p').spans, 2)
  } finally { store.close() }
})

test('only new events are read on the second ingest', () => {
  const store = new Store(':memory:')
  try {
    let reads = 0
    const bySeq = new Map([[0, user('a')], [1, user('b')]])
    const session = { seq: 2, eventAt: seq => { reads++; return bySeq.get(seq) } }
    ingest(store, 'p', session)
    assert.equal(reads, 2)
    bySeq.set(2, user('c'))
    session.seq = 3
    reads = 0
    ingest(store, 'p', session)
    assert.equal(reads, 1, 'the watermark must skip what is already indexed')
    assert.equal(store.spanCoverage('p').spans, 3)
  } finally { store.close() }
})

test('identical content is stored once, whichever seq it arrives at', () => {
  const store = new Store(':memory:')
  try {
    const session = fakeSession([user('同样的输出'), user('同样的输出'), user('同样的输出')])
    assert.equal(ingest(store, 'p', session).added, 1)
    assert.equal(store.spanCoverage('p').spans, 1)
  } finally { store.close() }
})

test('full-text search finds a Chinese phrase and substring search finds a path', () => {
  const store = new Store(':memory:')
  try {
    ingest(store, 'p', fakeSession([
      user('反作弊为什么失效，需要查 GameGuard 的加载顺序'),
      user('mod 源包在 D:\\modsss\\HD2 LUA_AR834269 下面'),
      user('无关的一段日志'),
    ]))
    const byText = searchIndex(store, 'p', '反作弊 失效')
    assert.equal(byText.spans[0].seq, 0)
    const byPath = searchIndex(store, 'p', 'D:\\modsss\\HD2 LUA_AR834269')
    assert.equal(byPath.spans[0].seq, 1)
  } finally { store.close() }
})

test('results stay within the byte budget and report coverage', () => {
  const store = new Store(':memory:')
  try {
    ingest(store, 'p', fakeSession(Array.from({ length: 8 }, (_, i) => user(`alpha beta ${'填充'.repeat(300)} ${i}`))))
    const out = searchIndex(store, 'p', 'alpha beta', { limit: 5, maxSpanBytes: 300 })
    assert.ok(out.bytes <= 4000)
    assert.ok(out.spans.every(span => Buffer.byteLength(span.text) <= 340))
    assert.deepEqual(out.coverage.spans, 8)
    assert.equal(out.coverage.from, 0)
    assert.equal(out.coverage.to, 7)
  } finally { store.close() }
})

test('two sessions in the same project are indexed independently and searched together', () => {
  const store = new Store(':memory:')
  try {
    const a = { id: 'sess-a', seq: 2, eventAt: s => [{ type: 'user/message', data: { content: [{ type: 'text', text: '上个会话：反作弊加载顺序' }] } }, { type: 'user/message', data: { content: [{ type: 'text', text: '上个会话结尾：继续修 bundle' }] } }][s] }
    const b = { id: 'sess-b', seq: 2, eventAt: s => [{ type: 'user/message', data: { content: [{ type: 'text', text: '这个会话：新的任务' }] } }, { type: 'user/message', data: { content: [{ type: 'text', text: '这个会话：继续' }] } }][s] }
    assert.equal(ingest(store, 'p', a).added, 2)
    // 第二个会话的 seq 从 0 重新开始，绝不能因为 watermark 或 seq 冲突而丢内容
    assert.equal(ingest(store, 'p', b).added, 2, 'a second session must not be skipped by the first session watermark')
    const coverage = store.spanCoverage('p')
    assert.equal(coverage.spans, 4)
    assert.equal(coverage.sessions, 2)

    const old = searchIndex(store, 'p', '反作弊 加载顺序', { sessionId: 'sess-b' })
    assert.equal(old.spans[0].session, 'sess-a')
    assert.equal(old.spans[0].current, false, 'a hit from an earlier session is labelled as such')

    const fresh = searchIndex(store, 'p', '新的任务', { sessionId: 'sess-b' })
    assert.equal(fresh.spans[0].current, true)
  } finally { store.close() }
})

test('the index survives reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-index-'))
  const path = join(dir, 'index.sqlite')
  try {
    const first = new Store(path)
    ingest(first, 'p', fakeSession([user('跨进程也要留住的编号 ORANGE-KITE-19')]))
    const before = first.spanCoverage('p').spans
    first.close()

    const second = new Store(path)
    const after = second.spanCoverage('p').spans
    second.close()
    assert.equal(before, 1)
    assert.equal(after, 1, 'opening the database must not wipe the derived index')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('spans are redacted before they reach disk', () => {
  const store = new Store(':memory:')
  try {
    const secret = 'sk-' + 'A'.repeat(24)
    ingest(store, 'p', fakeSession([user(`token 是 ${secret}，部署到 staging`), user('api_key=hunter2hunter2')]))
    const raw = JSON.stringify(store.db.prepare('SELECT text FROM span').all()) +
      JSON.stringify(store.db.prepare('SELECT text FROM span_fts').all())
    assert.equal(raw.includes(secret), false)
    assert.equal(raw.includes('hunter2hunter2'), false)
    assert.equal(searchIndex(store, 'p', 'staging').spans.length, 1, 'the rest of the span stays searchable')
  } finally { store.close() }
})

test('migrating a v6 database redacts spans already on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-index-'))
  const path = join(dir, 'index.sqlite')
  const secret = 'ghp_' + 'B'.repeat(24)
  try {
    const first = new Store(path)
    first.putSpans('p', 's', [{ seq: 0, kind: 'user/message', hash: 'h0', text: `推送用 ${secret}`, indexText: `推送用 ${secret}` }])
    first.db.exec('PRAGMA user_version=6')
    first.close()

    const second = new Store(path)
    try {
      const text = second.db.prepare('SELECT text FROM span').get().text
      const indexed = second.db.prepare('SELECT text FROM span_fts').get().text
      assert.equal(text.includes(secret), false)
      assert.equal(indexed.includes(secret), false)
      assert.equal(second.spanCoverage('p').spans, 1, 'migration must redact in place, not drop')
    } finally { second.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the span index is bounded per project, oldest first', () => {
  const store = new Store(':memory:')
  try {
    const rows = Array.from({ length: 12 }, (_, seq) => ({ seq, kind: 'user/message', hash: `h${seq}`, text: `span ${seq}` }))
    store.putSpans('p', 's', rows.slice(0, 6))
    store.putSpans('q', 's', rows.slice(0, 3))
    store.pruneSpans('p', 4)
    assert.deepEqual(store.db.prepare("SELECT seq FROM span WHERE scope='p' ORDER BY seq").all().map(r => r.seq), [2, 3, 4, 5])
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM span_fts WHERE scope='p'").get().n, 4, 'FTS rows go with their spans')
    assert.equal(store.spanCoverage('q').spans, 3, 'other projects are untouched')
  } finally { store.close() }
})
