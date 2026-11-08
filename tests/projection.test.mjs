import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { projectionText, capture, recordHandoff, recall, promoteTurn } from '../src/memory.js'
import { project } from '../src/skeleton.js'
import { QUANTUM_MS, clock, memoryView } from '../src/graph-memory.js'
import { terms as termSet } from '../src/util.js'

/**
 * The switch, from the outside.
 *
 * Everything here goes through the public entry point that `index.js` calls, because the point
 * of a feature flag is that the caller cannot tell which branch ran except by the bytes.
 */

const DAY = 86_400_000
const T0 = 1_790_000_000_000
const user = text => ({ type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
const write = path => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'write', input: { path } }] } } })
const wrote = () => ({ type: 'tool/result', data: { content: [{ type: 'text', text: 'ok' }], isError: false } })

/** A graph with one standing constraint and a spread of less important work. */
function seed(store, scope, { count = 24 } = {}) {
  capture(store, scope, [user('不要改 package.json，锁文件必须原样'), write('src/store.js'), wrote()], { hashOf: () => null })
  const nodes = []
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `d${i}`, kind: i % 3 === 0 ? 'decision' : 'artifact',
      claim: `第 ${i} 项：src/mod${i}.js 的标识符 mod${i}`, seq: 100 + i,
    })
  }
  store.recordNodes(scope, { nodes })
  const back = store.db.prepare('UPDATE node SET created=?, seen=? WHERE scope=?')
  back.run(T0 - 30 * DAY, T0 - 30 * DAY, scope)
}

test('with no recall history the two orderings agree — a fresh graph holds no surprises', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    const off = projectionText(store, 'p', 600, { dynamics: false })
    // Far from the turn that wrote anything, so working memory is empty too.
    const on = projectionText(store, 'p', 600, { dynamics: true, now: T0, turn: 1000 })
    assert.ok(off.length > 0 && on.length > 0, 'neither branch may return an empty card for a populated graph')
    // Every node has the same activation here, so `importance x due` ties and falls through to
    // the same tiebreak the static order uses. That is the intended behaviour: switching the
    // flag on a project with no history must not reshuffle the card.
    assert.equal(off, on, 'with flat activation, dynamics must degenerate to the static order')
  } finally { store.close() }
})

test('a memory that was needed recently ranks higher — the reader is stateless, so need, not spacing', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    // d0 is the oldest decision, last on the static card; it was just used five times.
    const insert = store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
    for (const hoursAgo of [1, 2, 3, 5, 8]) insert.run(`a-d0-${hoursAgo}`, 'p', 'd0', 'q', T0 - hoursAgo * 3_600_000)
    const off = projectionText(store, 'p', 600, { dynamics: false })
    const on = projectionText(store, 'p', 600, { dynamics: true, now: T0, turn: 1000 })
    const first = text => text.split('\n').find(line => line.startsWith('- 决策'))
    assert.ok(first(off).includes('mod21.js'), 'static keeps the newest decision first')
    assert.ok(first(on).includes('mod0.js'), `the used decision leads the dynamic card, got "${first(on)}"`)
  } finally { store.close() }
})

test('the dynamic card stays inside its byte budget', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    for (const budget of [160, 300, 600, 1200]) {
      const card = projectionText(store, 'p', budget, { dynamics: true, now: T0 })
      // The index line is budgeted separately by design, so allow it on top.
      const body = card.split('\n').filter(line => !line.startsWith('[索引]')).join('\n')
      assert.ok(Buffer.byteLength(body) <= budget, `budget ${budget} produced ${Buffer.byteLength(body)} bytes`)
    }
  } finally { store.close() }
})

test('the card is byte-identical inside one clock bucket — the prompt cache depends on it', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    const base = clock(T0)
    const a = projectionText(store, 'p', 600, { dynamics: true, now: base + 1000 })
    const b = projectionText(store, 'p', 600, { dynamics: true, now: base + QUANTUM_MS - 1000 })
    assert.equal(a, b, 'two calls within five minutes must render the same bytes')
  } finally { store.close() }
})

test('a recall inside a bucket does not change the card — the log is read up to the bucket start', () => {
  const store = new Store(':memory:', { now: () => clock(T0) + 60_000 })
  try {
    seed(store, 'p', { count: 40 })
    const before = projectionText(store, 'p', 300, { dynamics: true, now: clock(T0) + 30_000, turn: 1000 })
    recall(store, 'p', 'mod2', { limit: 3 })
    const after = projectionText(store, 'p', 300, { dynamics: true, now: clock(T0) + QUANTUM_MS - 1000, turn: 1000 })
    assert.equal(after, before, 'same bucket, same bytes, recalls included')
    const next = projectionText(store, 'p', 300, { dynamics: true, now: clock(T0) + QUANTUM_MS, turn: 1000 })
    assert.ok(next.includes('mod2.js'), 'the next bucket reflects the use')
  } finally { store.close() }
})

test('the card follows the question: a cue on a cold node brings it onto a full card', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p', { count: 40 })
    const plain = projectionText(store, 'p', 300, { dynamics: true, now: T0, turn: 1000 })
    assert.ok(!plain.includes('mod4.js'), 'an old artifact is off a small card')
    const cued = projectionText(store, 'p', 300, { dynamics: true, now: T0, turn: 1000, cues: { terms: [], entities: ['src/mod4.js'] } })
    assert.ok(cued.includes('mod4.js'), 'naming it brings it on')
  } finally { store.close() }
})

test('an empty graph costs nothing, in either mode', () => {
  const store = new Store(':memory:')
  try {
    assert.equal(projectionText(store, 'p', 600, { dynamics: false }), '')
    assert.equal(projectionText(store, 'p', 600, { dynamics: true, now: T0 }), '')
  } finally { store.close() }
})

test('the handoff line is never repeated in the body, in either mode', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    const claim = '第 3 项：src/mod3.js 的标识符 mod3'
    recordHandoff(store, 'p', 'previous-session', claim, T0)
    for (const dynamics of [false, true]) {
      const card = projectionText(store, 'p', 1200, { sessionId: 'current-session', dynamics, now: T0 })
      const hits = card.split('\n').filter(line => line.includes(claim)).length
      assert.equal(hits, 1, `claim appeared ${hits} times with dynamics=${dynamics}`)
      assert.ok(card.startsWith('[上次会话'), 'the handoff leads the card')
    }
  } finally { store.close() }
})

test('a retired node leaves the card and comes back when restored', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    // `d21` is a decision, so it is near the top of the card and its absence is unambiguous.
    const before = projectionText(store, 'p', 1200, { dynamics: true, now: T0 })
    assert.ok(before.includes('mod21.js'), 'present to begin with')
    store.db.prepare("UPDATE node SET state='retired' WHERE id=?").run('d21')
    const after = projectionText(store, 'p', 1200, { dynamics: true, now: T0 })
    assert.ok(!after.includes('mod21.js'), 'a retired node is not projected')
    store.db.prepare("UPDATE node SET state='active' WHERE id=?").run('d21')
    const back = projectionText(store, 'p', 1200, { dynamics: true, now: T0 })
    assert.ok(back.includes('mod21.js'), 'restoring brings it back')
  } finally { store.close() }
})

test('pruning keeps what was used and lets go of what was never touched', () => {
  const store = new Store(':memory:')
  try {
    // One old node that was actually retrieved, one brand-new node that was not.
    store.recordNodes('p', {
      nodes: [
        { id: 'used', kind: 'decision', claim: '旧结论：走 anchor', seq: 1 },
        { id: 'fresh', kind: 'progress', claim: '刚刚的步骤', seq: 2 },
        { id: 'pin', kind: 'constraint', claim: '不要改 package.json', pin: 1, seq: 3 },
      ],
      edges: [],
    })
    store.db.prepare('UPDATE node SET seen=? WHERE id=?').run(T0 - 30 * DAY, 'used')
    store.db.prepare('UPDATE node SET hits=3 WHERE id=?').run('used')
    // Cap of 1: the retrieved node outranks the untouched one even though it is far older.
    store.pruneNodes('p', 1)
    const kept = store.activeNodes('p', 10).map(row => row.id)
    assert.ok(kept.includes('pin'), 'pinned is never pruned')
    assert.ok(kept.includes('used'), 'a node that was retrieved survives a newer untouched one')
    assert.ok(!kept.includes('fresh'), 'the untouched progress line is the one that goes')
  } finally { store.close() }
})

test('recall orders neighbours by activation when the dynamics view is present', () => {
  const store = new Store(':memory:')
  try {
    // Only the cue matches the query, so the other two surface as one-hop neighbours.
    store.recordNodes('p', {
      nodes: [
        { id: 'cue', kind: 'decision', claim: '决定走双时态', seq: 1 },
        { id: 'cold', kind: 'artifact', claim: 'src/store.js 已写入', seq: 2 },
        { id: 'warm', kind: 'artifact', claim: 'src/skeleton.js 已写入', seq: 3 },
      ],
      edges: [
        // Cold is the stronger association; warm is the one anyone could still produce.
        { src: 'cue', dst: 'cold', rel: 'derived', w: 5 },
        { src: 'cue', dst: 'warm', rel: 'derived', w: 1 },
      ],
    })
    store.db.prepare('UPDATE node SET created=?, seen=? WHERE id=?').run(T0 - 90 * DAY, T0 - 90 * DAY, 'cold')
    store.db.prepare('UPDATE node SET seen=? WHERE id=?').run(T0 - 90 * DAY, 'warm')
    store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
      .run('x1', 'p', 'warm', 'q', T0 - 60_000)

    const plain = recall(store, 'p', '双时态', { limit: 3 })
    const ordered = plain.neighbours.map(row => row.id)
    assert.ok(ordered.includes('cold') && ordered.includes('warm'), 'both are one hop out')
    assert.equal(ordered[0], 'cold', 'without the dynamics view, raw edge strength decides')

    const dynamicsView = memoryView(store, 'p', { now: T0 })
    const withDynamics = recall(store, 'p', '双时态', { limit: 3, dynamicsView })
    const ranked = withDynamics.neighbours.map(row => row.id)
    assert.equal(ranked.indexOf('warm') < ranked.indexOf('cold'), true,
      'the reachable neighbour outranks the stronger but unreadable one')
    assert.ok(withDynamics.neighbours.every(row => typeof row.strength === 'number'),
      'edge strength is still reported; it just stopped deciding')
  } finally { store.close() }
})

test('promotion closes the coverage gap extraction leaves, and only that gap', () => {
  const store = new Store(':memory:')
  try {
    // Extraction is narrow on purpose. A *failed* command becomes a progress node, so its error
    // code is already safe; a *successful* result carrying an environment fact becomes nothing
    // at all, and that is the residual loss the bench measures.
    const events = [
      user('不要改 package.json，锁文件必须原样'),
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read', input: { path: 'CHANGELOG.md' } }] } } },
      { type: 'tool/result', data: { content: [{ type: 'text', text: '版本 0.9.4 要求 node >= 24，本机 20.11.1，sdk/adapter.js 第 88 行' }], isError: false } },
    ]
    capture(store, 'p', events, { hashOf: () => null })
    const before = store.activeNodes('p', 50)
    assert.ok(before.some(node => node.kind === 'constraint'), 'extraction took the constraint')
    assert.ok(!before.some(node => node.claim.includes('0.9.4')), 'and missed the ambient version')

    const created = promoteTurn(store, 'p', events)
    assert.ok(created.length >= 1, 'the uncovered block gets a pointer')
    assert.ok(created.some(row => row.claim.includes('0.9.4')), 'the claim carries the identifier')
    const after = store.activeNodes('p', 50)
    assert.ok(after.some(node => node.claim.includes('0.9.4')))
    assert.equal(after.filter(node => node.kind === 'constraint').length,
      before.filter(node => node.kind === 'constraint').length, 'covered blocks are not re-created')
    // And the pointer is findable by a term lookup, which is the whole point of writing it.
    //
    // Caveat worth knowing: `termSet('0.9.4')` returns [] — a bare version string is not a
    // token. What makes the node reachable is the prose around the identifier, which is why the
    // claim is the whole snippet ("版本 0.9.4 要求 node…") rather than the identifier alone.
    const found = store.searchNodes('p', termSet('版本要求 node 是多少'), 5)
    assert.ok(found.some(node => node.claim.includes('0.9.4')), 'a phrase lookup now reaches it')
    assert.deepEqual([...termSet('0.9.4')], [], 'and a bare version string still does not — documented, not fixed')
  } finally { store.close() }
})

test('the default card ordering is a golden value — an upgrade must not reshuffle it', () => {
  // Captured from 1.5 semantics. `reference` ranks second by default and last only when a
  // feature that manufactures reference nodes is on. If this assertion ever needs "fixing",
  // the change is a compatibility break and has to be argued, not edited.
  const nodes = [
    { id: 'c', kind: 'constraint', claim: '不要改 package.json', pin: 1, seq: 9 },
    { id: 'd', kind: 'decision', claim: '决定走 anchor', pin: 0, seq: 8 },
    { id: 'a', kind: 'artifact', claim: 'src/store.js 已写入', pin: 0, seq: 7 },
    { id: 'r', kind: 'reference', claim: '常用检索：双时态', pin: 0, seq: 6 },
    { id: 'p', kind: 'progress', claim: '下一步重跑成对验证', pin: 0, seq: 5 },
  ]
  assert.equal(project(nodes, { budget: 600 }), [
    '[骨架]',
    '- 约束: 不要改 package.json',
    '- 索引: 常用检索：双时态',
    '- 决策: 决定走 anchor',
    '- 产物: src/store.js 已写入',
    '- 进度: 下一步重跑成对验证',
  ].join('\n'))
  assert.equal(project(nodes, { budget: 600, referenceLast: true }), [
    '[骨架]',
    '- 约束: 不要改 package.json',
    '- 决策: 决定走 anchor',
    '- 产物: src/store.js 已写入',
    '- 进度: 下一步重跑成对验证',
    '- 索引: 常用检索：双时态',
  ].join('\n'), 'only the switch that creates reference nodes may move it')
})

test('with every switch off, the card is the one 1.5 renders', () => {
  const store = new Store(':memory:')
  try {
    seed(store, 'p')
    // A reference node as `recordLookup` leaves one, so the ordering rule is actually exercised.
    store.recordNodes('p', { nodes: [{ id: 'ref', kind: 'reference', claim: '常用检索：mod3', seq: 900 }] })
    const off = projectionText(store, 'p', 600, {})
    assert.ok(off.split('\n').some(line => line.startsWith('- 索引:')), 'the reference is on the card')
    const idx = off.split('\n').findIndex(line => line.startsWith('- 索引:'))
    const dec = off.split('\n').findIndex(line => line.startsWith('- 决策:'))
    assert.ok(idx < dec, 'by default a reference outranks a decision, exactly as in 1.5')
  } finally { store.close() }
})

test('promotion creates nothing when extraction already covered the turn', () => {
  const store = new Store(':memory:')
  try {
    const events = [user('不要改 package.json，锁文件必须原样')]
    capture(store, 'p', events, { hashOf: () => null })
    assert.deepEqual(promoteTurn(store, 'p', events), [], 'nothing to promote, nothing written')
  } finally { store.close() }
})

test('promotion is capped, so a long turn cannot flood the graph', () => {
  const store = new Store(':memory:')
  try {
    const events = Array.from({ length: 20 }, (_, i) => ({
      type: 'tool/result', data: { content: [{ type: 'text', text: `第 ${i} 步: src/mod${i}.js 报错 E${1000 + i}` }], isError: isOdd(i) },
    }))
    const created = promoteTurn(store, 'p', events, { max: 3 })
    assert.ok(created.length <= 3, `capped at 3, created ${created.length}`)
  } finally { store.close() }
})

function isOdd(n) { return n % 2 === 1 }

test('a cue lifts the node the question points at, inside its own importance band', () => {
  const store = new Store(':memory:')
  try {
    // Two decisions at the same age and the same activation: only the cue can separate them.
    store.recordNodes('p', { nodes: [
      { id: 'lua', kind: 'decision', claim: '决定改用 Lua 注入加载器', seq: 1 },
      { id: 'db', kind: 'decision', claim: '决定把索引迁到 SQLite', seq: 2 },
      { id: 'pin', kind: 'constraint', claim: '不要改 package.json', pin: 1, seq: 3 },
    ] })
    const flat = projectionText(store, 'p', 600, { dynamics: true, now: T0 })
    assert.equal(flat, projectionText(store, 'p', 600, { dynamics: true, now: T0, cues: null }),
      'no cue must render exactly what the uncued path renders')

    const cued = projectionText(store, 'p', 600, { dynamics: true, now: T0, cues: ['lua', '加载'] })
    const lines = cued.split('\n').filter(line => line.startsWith('- 决策'))
    assert.ok(lines[0].includes('Lua'), `the cued decision leads, got "${lines[0]}"`)
    assert.ok(cued.includes('不要改 package.json'), 'a constraint is pinned regardless of cue')

    const other = projectionText(store, 'p', 600, { dynamics: true, now: T0, cues: ['sqlite', '索引'] })
    assert.ok(other.split('\n').filter(line => line.startsWith('- 决策'))[0].includes('SQLite'))
  } finally { store.close() }
})

test('a cue shared by many nodes lifts none of them — the fan effect', () => {
  const store = new Store(':memory:')
  try {
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`, kind: 'decision', claim: `决定：src/mod${i}.js 使用 common 方案`, seq: i + 1,
    }))
    store.recordNodes('p', { nodes })
    // `common` appears in every node, so it carries no information about any one of them.
    const cued = projectionText(store, 'p', 600, { dynamics: true, now: T0, cues: ['common'] })
    const flat = projectionText(store, 'p', 600, { dynamics: true, now: T0 })
    assert.equal(cued, flat, 'a term every node shares must not reorder the card')
  } finally { store.close() }
})

test('recall spreads across the graph: the constraint two hops away surfaces', () => {
  const store = new Store(':memory:')
  try {
    // chain: 起点 --related--> 中间 --derived--> 远端约束
    // Only "起点" matches the query lexically; "无头" and "回滚" share no term with it.
    store.recordNodes('p', {
      nodes: [
        { id: 'a', kind: 'decision', claim: '决定重构加载器', seq: 1 },
        { id: 'b', kind: 'artifact', claim: 'src/loader.js 已写入', seq: 2 },
        { id: 'c', kind: 'constraint', claim: '失败必须回滚到上一版本', pin: 1, seq: 3 },
      ],
      edges: [],
    })
    store.link('p', { src: 'a', dst: 'b', rel: 'related', delta: 1 })
    store.link('p', { src: 'b', dst: 'c', rel: 'derived', delta: 1 })

    const out = recall(store, 'p', '加载器', { limit: 5 })
    assert.equal(out.hits[0].id, 'a', 'the lexical hit still leads')
    const reached = out.neighbours.map(row => row.id)
    assert.ok(reached.includes('b'), 'one hop is reachable')
    assert.ok(reached.includes('c'), 'two hops are reachable through the spread')
    const c = out.neighbours.find(row => row.id === 'c')
    assert.ok(c.reach > 0 && c.reach <= 1, 'the far node is weaker than the near one')
    assert.ok(c.reach < out.neighbours.find(row => row.id === 'b').reach,
      'reach decays with distance')
  } finally { store.close() }
})

test('the spread never crosses a supersedes edge — a replaced claim is not an association', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', {
      nodes: [
        { id: 'new', kind: 'decision', claim: '决定改用 pnpm', seq: 1 },
        { id: 'old', kind: 'decision', claim: '决定用 npm', seq: 2 },
      ],
      edges: [],
    })
    store.link('p', { src: 'new', dst: 'old', rel: 'supersedes', delta: 1 })
    const out = recall(store, 'p', 'pnpm', { limit: 5 })
    assert.ok(!out.neighbours.some(row => row.id === 'old' && row.reach > 0),
      'a stale claim must not be re-surfaced as related knowledge')
  } finally { store.close() }
})
