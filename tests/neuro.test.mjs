import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import {
  MemoryBuffer, capture, recall, promoteTurn, recordCorrection, reconsolidate, noteUse, wireTurn,
  consolidate, driftContext, projectionText, verifyArtifacts,
} from '../src/memory.js'
import { memoryView, render, propagate } from '../src/graph-memory.js'
import { boostOf } from '../src/skeleton.js'
import { alignSeqs, fromConversation } from '../src/compaction.js'
import { isCorrection } from '../src/observe.js'

/**
 * Regression tests for the 2.1 review. Each one reproduces a probe that failed on 2.0.
 */

const DAY = 86_400_000
const user = text => ({ type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
const say = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const write = path => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'write', input: { path } }] } } })
const read = path => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read', input: { path } }] } } })
const result = text => ({ type: 'tool/result', data: { content: [{ type: 'text', text }], isError: false } })
const live = store => store.db.prepare("SELECT claim FROM node WHERE scope='p' AND valid_to IS NULL AND state='active'").all().map(r => r.claim)

test('unrelated decisions that share only instruction words do not supersede each other', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('先看日志'), say('决定把日志格式改成 JSON 行，因为方便后续检索和聚合')])
    capture(store, 'p', [user('再看数据库'), say('决定把数据库连接池上限改成 32，因为高峰期并发太高')])
    assert.equal(live(store).filter(c => c.startsWith('决定')).length, 2)
  } finally { store.close() }
})

test('unrelated constraints phrased with 不再…必须 both stay live', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('以后提交前不再跳过 lint，必须先跑 npm run lint')])
    capture(store, 'p', [user('接口文档不再手写，必须从 openapi.yaml 生成')])
    assert.equal(live(store).length, 2)
  } finally { store.close() }
})

test('different instances never supersede: mod0 and mod1 are different objects', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('x'), say('决定把 mod0 的加载改成惰性加载，因为启动太慢')])
    capture(store, 'p', [user('y'), say('决定把 mod1 的加载改成惰性加载，因为启动太慢')])
    assert.equal(live(store).filter(c => c.startsWith('决定')).length, 2)
  } finally { store.close() }
})

test('a file rewritten in a later turn supersedes its earlier artifact', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('a'), write('src/a.js'), result('ok')])
    capture(store, 'p', [user('b'), write('src/a.js'), result('ok')])
    assert.equal(live(store).filter(c => c.includes('src/a.js')).length, 1)
  } finally { store.close() }
})

test('the buffer keeps host seqs, and promotion keeps working after the first turn', () => {
  const store = new Store(':memory:')
  const buffer = new MemoryBuffer()
  try {
    let seq = 0
    let promoted = 0
    for (let t = 0; t < 4; t++) {
      for (const e of [user(`检查服务 ${t}`), read(`conf/svc${t}.yaml`), result(`port 80${t}0, tag v1.${t}.7, ERRCODE${t}X`)]) buffer.push('s', { ...e, seq: seq++ })
      const events = buffer.take('s')
      assert.ok(events.every(e => e.seq >= 3 * t), 'host seqs survive the turn boundary')
      capture(store, 'p', events, { session: 's' })
      promoted += promoteTurn(store, 'p', events, { session: 's' }).length
    }
    assert.ok(promoted >= 4, `every turn's new facts are promotable, got ${promoted}`)
  } finally { store.close() }
})

test('retired nodes stay recallable and are not deleted after 30 days', () => {
  let now = 1_790_000_000_000
  const store = new Store(':memory:', { now: () => now })
  try {
    store.recordNodes('p', { nodes: [{ id: 'n1', kind: 'decision', seq: 0, claim: '决定迁移到 ORANGE-KITE 方案' }] })
    store.db.prepare("UPDATE node SET state='retired' WHERE id='n1'").run()
    assert.equal(recall(store, 'p', 'ORANGE-KITE').hits.length, 1)
    now += 31 * DAY
    store.recordNodes('p', { nodes: [{ id: 'n2', kind: 'progress', seq: 0, claim: '无关进度' }] })
    assert.ok(store.nodeRow('n1'), 'retirement is a visibility change, not a delete')
  } finally { store.close() }
})

test('recall ranks neighbours by association in default mode, not by id', () => {
  for (const ids of [['a1', 'a2', 'a3', 'a4'], ['z9', 'z8', 'z7', 'z6']]) {
    const store = new Store(':memory:')
    try {
      store.recordNodes('p', { nodes: [{ id: 'hit', kind: 'decision', seq: 0, claim: '决定用 QUASAR 方案' },
        ...ids.map((id, i) => ({ id, kind: 'artifact', seq: i + 1, claim: `src/file${i}.js 已写入` }))] })
      const w = [0.1, 0.9, 0.3, 0.6]
      ids.forEach((id, i) => store.link('p', { src: 'hit', dst: id, rel: 'related', delta: w[i] }))
      const order = recall(store, 'p', 'QUASAR').neighbours.map(n => n.strength)
      assert.deepEqual(order, [...order].sort((a, b) => b - a), `strength order, got ${order}`)
    } finally { store.close() }
  }
})

test('nodes retrieved together get wired together, even with no prior edge', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('缓存'), say('决定会话缓存改用 redis，因为多实例要共享状态')])
    capture(store, 'p', [user('超时'), say('redis 连接超时已经定位，下一步加重试与告警')])
    const out = recall(store, 'p', 'redis')
    assert.equal(out.hits.length, 2)
    assert.ok(out.links >= 1)
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM edge WHERE rel='coactivated'").get().n, 1)
  } finally { store.close() }
})

test('recall never spreads through or wires to a superseded claim', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [
      { id: 'new', kind: 'decision', seq: 1, claim: '决定改用 esbuild 打包' },
      { id: 'old', kind: 'decision', seq: 2, claim: '决定用 webpack 打包' },
      { id: 'a', kind: 'artifact', seq: 3, claim: 'webpack.config.js 已写入' },
      { id: 'b', kind: 'artifact', seq: 4, claim: 'build.mjs 已写入' },
    ] })
    store.link('p', { src: 'new', dst: 'old', rel: 'supersedes', delta: 1 })
    store.supersede('old')
    store.link('p', { src: 'old', dst: 'a', rel: 'derived', delta: 1 })
    store.link('p', { src: 'new', dst: 'b', rel: 'derived', delta: 1 })
    const out = recall(store, 'p', 'esbuild')
    assert.ok(!out.neighbours.some(n => n.id === 'old' || n.id === 'a'), 'nothing reached through the replaced claim')
    const wired = store.db.prepare("SELECT src, dst FROM edge WHERE rel='coactivated'").all()
    assert.ok(!wired.some(e => e.src === 'old' || e.dst === 'old'))
  } finally { store.close() }
})

test('the oldest node is still findable when the graph is at its cap', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, kind: 'decision', seq: i, claim: `决策 ${i} 标识 uniq${String(i).padStart(3, '0')}x` })) })
    assert.equal(store.searchNodes('p', ['uniq000x'], 5).length, 1)
  } finally { store.close() }
})

test('use, not exposure: naming a path activates its node; a shared word activates nothing', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('a'), write('src/loader.js'), result('ok'), write('src/other.js'), result('ok')])
    assert.deepEqual(noteUse(store, 'p', { text: '看看 loader.js 为什么报错', turn: 2 }).length, 1)
    assert.equal(noteUse(store, 'p', { text: '整理一下 src', turn: 2 }).length, 0)
  } finally { store.close() }
})

test('a corrected turn wires nothing; a recovery captures salience on recent nodes', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [{ id: 'x', kind: 'decision', seq: 0, claim: 'x 决策' }, { id: 'y', kind: 'decision', seq: 0, claim: 'y 决策' }] })
    assert.equal(wireTurn(store, 'p', { used: ['x', 'y'], outcome: { corrections: 1 }, turn: 1 }).wired, 0)
    const out = wireTurn(store, 'p', { used: ['x', 'y'], outcome: { toolErrors: 2, complete: true }, turn: 2 })
    assert.equal(out.wired, 1)
    assert.ok(store.nodeRow('x').salience > 0)
  } finally { store.close() }
})

test('temporal edges point forward: what the last turn touched precedes this one', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('a'), say('构建失败：ENOSPC 磁盘满了，暂时无法继续')], { turn: 1 })
    capture(store, 'p', [user('b'), say('决定清理 /tmp 缓存后重试，因为 ENOSPC 是空间不足')], { turn: 2 })
    const edges = store.db.prepare("SELECT src, dst FROM edge WHERE rel='precedes'").all()
    assert.ok(edges.length >= 1)
    const out = recall(store, 'p', 'ENOSPC 磁盘满')
    assert.ok(Array.isArray(out.next))
  } finally { store.close() }
})

test('a correction contradicts the decision it is about, and the card demotes it', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('a'), say('决定把 vite.config.js 里的 react 标成 external，因为包太大')], { turn: 1 })
    const decision = store.db.prepare("SELECT id FROM node WHERE kind='decision'").get().id
    const id = recordCorrection(store, 'p', { text: '不对，vite.config.js 里不能把 react 标成 external，会白屏' })
    assert.deepEqual(reconsolidate(store, 'p', id, [decision]), [decision])
    const view = memoryView(store, 'p')
    assert.ok(view.byId.get(decision).contradicted)
    assert.ok(recall(store, 'p', 'vite.config.js').hits.find(h => h.id === decision).contradictedBy)
  } finally { store.close() }
})

test('a correction line is bounded so two cannot fill the card', () => {
  const store = new Store(':memory:')
  try {
    const id = recordCorrection(store, 'p', { text: '不对，'.repeat(80), intent: '排查'.repeat(60) })
    assert.ok(Buffer.byteLength(store.nodeRow(id).claim) <= 240)
  } finally { store.close() }
})

test('lateral inhibition: twenty artifacts in one directory share a line instead of filling the card', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('不要改 package.json'), say('决定拆分模块，因为文件太大'),
      ...Array.from({ length: 20 }, (_, i) => [write(`src/area/f${i}.js`), result('ok')]).flat()])
    const card = render(memoryView(store, 'p'), { budget: 600 })
    assert.ok(card.includes('决定拆分模块'), 'the decision survives')
    assert.ok(card.split('\n').filter(l => l.startsWith('- 产物')).length <= 2, card)
    assert.ok(Buffer.byteLength(card) <= 600)
  } finally { store.close() }
})

test('maintenance decays only learned edges and caps any one hub', () => {
  const store = new Store(':memory:')
  try {
    store.link('p', { src: 'a', dst: 'b', rel: 'derived', delta: 1 })
    for (const x of ['c', 'd', 'e', 'f', 'g']) store.link('p', { src: 'hub', dst: x, rel: 'coactivated', delta: 2 })
    for (let i = 0; i < 100; i++) consolidate(store, 'p')
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM edge WHERE rel='derived'").get().n, 1, 'provenance is not forgotten')
    const load = store.db.prepare("SELECT COALESCE(SUM(w),0) s FROM edge WHERE src='hub'").get().s
    assert.ok(load <= 3 + 1e-9, `hub load ${load}`)
  } finally { store.close() }
})

test('the drifting context keeps the recent topic as a weak cue', () => {
  const store = new Store(':memory:')
  try {
    driftContext(store, 'p', '数据库迁移 数据库迁移')
    const after = driftContext(store, 'p', '继续')
    assert.ok(after.some(([term]) => term === '迁移'))
  } finally { store.close() }
})

test('an artifact changed outside the session is marked stale and leaves the card', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('a'), write('src/x.js'), result('ok')], { hashOf: () => 'v1' })
    assert.equal(verifyArtifacts(store, 'p', () => 'v2').length, 1)
    assert.ok(!projectionText(store, 'p', 600).includes('src/x.js'))
  } finally { store.close() }
})

test('entities bridge the spread: two claims naming one path meet without sharing a bigram', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const mentions = new Map([['a', ['src/loader.js']], ['b', ['src/loader.js']], ['c', ['x']], ['d', ['y']]])
  const rank = propagate(nodes, [], [{ id: 'a' }], { mentions })
  assert.ok((rank.get('b') ?? 0) > 0)
  assert.equal(rank.get('c') ?? 0, 0)
})

test('compaction boost is keyed by entity, so it lands on the block that names it', () => {
  const weights = new Map([['src/loader.js', 4]])
  assert.ok(boostOf(weights, '改了 src/loader.js 的加载顺序') > boostOf(weights, '无关的输出'))
})

test('compaction messages align to host seqs, or not at all', () => {
  const events = new Map([[0, 'sys'], [3, 'u1'], [4, 'a1']])
  const session = {
    surface: { nodes: [0, 3, 4] },
    eventAt: seq => ({ seq, text: events.get(seq) }),
    deriveEventMessage: e => ({ role: 'x', content: e.text }),
  }
  assert.deepEqual(alignSeqs([{ role: 'x', content: 'u1' }, { role: 'x', content: 'a1' }], session), [3, 4])
  assert.equal(alignSeqs([{ role: 'x', content: 'zz' }], session), null)
  const evs = fromConversation([{ role: 'user', content: 'hi', source: { kind: 'user' } }], [7])
  assert.equal(evs[0].seq, 7)
})

test('reporting an error is not a correction; saying the agent was wrong is', () => {
  assert.equal(isCorrection('构建报错了看看'), false)
  assert.equal(isCorrection('又出错了'), false)
  assert.equal(isCorrection('你改错了，不是这个文件'), true)
})
