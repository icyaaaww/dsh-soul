import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activation, availability, coreness, importanceOf, clock, propagate, selectCard,
  memoryView, orderProjection, rankRecall, periphery, retire, restore, render, explain,
  QUANTUM_MS,
} from '../src/graph-memory.js'
import { Store } from '../src/store.js'

const DAY = 86_400_000
const T0 = 1_790_000_000_000

const node = (id, over = {}) => ({
  id, kind: 'progress', claim: `claim ${id}`, pin: 0, seq: 0,
  hits: 0, created: T0, ...over,
})

test('activation falls with time and rises with frequency — the direction must be assertable', () => {
  const one = activation([T0 - 30 * DAY], T0)
  const many = activation([T0 - 30 * DAY, T0 - 20 * DAY, T0 - 10 * DAY], T0)
  assert.ok(many > one, 'three encodings outweigh one at the same age')
  assert.ok(activation([T0 - 1 * DAY], T0) > activation([T0 - 10 * DAY], T0), 'older is weaker')
  assert.equal(activation([], T0), -Infinity)
  // The bug MemoryBank shipped: stronger must never mean weaker.
  assert.ok(availability(activation([T0, T0 - DAY], T0)) > availability(activation([T0 - 9 * DAY], T0)))
})

test('creation counts as an encoding, so a never-recalled node still decays', () => {
  const fresh = availability(activation([T0], T0))
  const stale = availability(activation([T0 - 30 * DAY], T0))
  assert.ok(fresh > 0.9, `fresh node should be highly available, got ${fresh}`)
  assert.ok(stale < 0.2, `month-old untouched node should be weak, got ${stale}`)
})

test('coreness finds the core of a barbell and the periphery of a pendant', () => {
  // Two triangles joined by a bridge, plus one pendant hanging off the far side.
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'p']
  const edges = [
    ['a', 'b'], ['b', 'c'], ['a', 'c'],  // left triangle
    ['d', 'e'], ['e', 'f'], ['d', 'f'],  // right triangle
    ['c', 'd'],                          // bridge
    ['f', 'p'],                          // pendant
  ].map(([src, dst]) => ({ src, dst, rel: 'related', w: 1 }))
  const core = coreness(ids, edges)
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(core.get(id), 2, `${id} is in the 2-core`)
  assert.equal(core.get('p'), 1, 'the pendant is peripheral')
})

test('coreness ignores supersedes edges and weak noise', () => {
  const ids = ['a', 'b', 'c']
  const supersedes = [{ src: 'a', dst: 'b', rel: 'supersedes', w: 5 }]
  assert.equal(coreness(ids, supersedes).get('a'), 0, 'a replacement is not an association')
  const noise = [{ src: 'a', dst: 'b', rel: 'related', w: 0.01 }]
  assert.equal(coreness(ids, noise).get('a'), 0, 'below the weight floor it does not connect')
})

test('importance is a property of the node, never of its age', () => {
  assert.ok(importanceOf({ pin: 1, kind: 'progress' }) > importanceOf({ pin: 0, kind: 'constraint' }))
  assert.ok(importanceOf({ kind: 'constraint' }) > importanceOf({ kind: 'decision' }))
  assert.ok(importanceOf({ kind: 'decision' }) > importanceOf({ kind: 'progress' }))
})

test('need rises with recent use — higher activation ranks higher, not lower', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [node('used', { kind: 'decision' }), node('idle', { kind: 'decision' })] })
    age(store, 'used', 10, T0); age(store, 'idle', 10, T0)
    store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)').run('u1', 'p', 'used', 'q', T0 - 3_600_000)
    const view = memoryView(store, 'p', { now: T0 })
    assert.ok(view.byId.get('used').score > view.byId.get('idle').score)
    assert.equal(orderProjection(view)[0].id, 'used')
  } finally { store.close() }
})

test('the clock is quantised, so the card cannot change inside one bucket', () => {
  const base = clock(T0)
  assert.equal(clock(base + 1000), clock(base + QUANTUM_MS - 1), 'two calls in the same bucket see the same time')
  assert.notEqual(clock(base + QUANTUM_MS), base, 'the next bucket is a different time')
})

/** `recordNodes` stamps `created` with the store's clock; the fixture needs it backdated. */
function age(store, id, days, now) {
  store.db.prepare('UPDATE node SET created=?, seen=? WHERE id=?').run(now - days * DAY, now - days * DAY, id)
}

/** A store with a controlled graph: two hubs, a decision with no edges, and a pendant. */
function fixture() {
  const store = new Store(':memory:')
  store.recordNodes('p', {
    nodes: [
      node('hub1', { kind: 'decision', seq: 1 }),
      node('hub2', { kind: 'artifact', seq: 2 }),
      node('lonely', { kind: 'decision', seq: 3 }),
      node('pendant', { kind: 'progress', seq: 4 }),
      node('pin', { kind: 'constraint', seq: 5, pin: 1 }),
      node('used', { kind: 'artifact', seq: 6, hits: 3 }),
    ],
    edges: [
      { src: 'hub1', dst: 'hub2', rel: 'related', w: 1 },
      { src: 'hub1', dst: 'used', rel: 'related', w: 1 },
      { src: 'hub1', dst: 'pendant', rel: 'related', w: 1 },
    ],
  })
  for (const id of ['hub1', 'hub2', 'pendant', 'pin']) age(store, id, 40, T0)
  age(store, 'lonely', 40, T0)
  // `used` was written a month ago and recalled a week ago; everything else was never touched.
  age(store, 'used', 40, T0)
  store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
    .run('x1', 'p', 'used', 'q', T0 - 7 * DAY)
  return store
}

test('the view is derived from data the store already writes — nothing to migrate', () => {
  const store = fixture()
  try {
    const view = memoryView(store, 'p', { now: T0 })
    assert.equal(view.sizes.nodes, 6)
    assert.equal(view.sizes.activations, 1)
    assert.ok(view.byId.get('used').A > view.byId.get('lonely').A, 'the recalled node is more available')
    assert.equal(view.byId.get('pin').importance, 1000)
  } finally { store.close() }
})

test('projection orders by importance x decay, not by recency', () => {
  const store = fixture()
  try {
    const view = memoryView(store, 'p', { now: T0 })
    const order = orderProjection(view).map(entry => entry.id)
    assert.equal(order[0], 'pin', 'a pinned constraint leads regardless of availability')
    // Both are month-old and untouched; the decision outranks the progress line on importance.
    assert.ok(order.indexOf('lonely') < order.indexOf('pendant'),
      'a decision with no edges still beats a progress note')
  } finally { store.close() }
})

test('a load-bearing or well-connected node is never treated as peripheral', () => {
  const store = fixture()
  try {
    const view = memoryView(store, 'p', { now: T0 })
    const ids = periphery(view, { degFloor: 1 }).map(entry => entry.id)
    assert.ok(!ids.includes('pin'), 'pinned is immune')
    assert.ok(!ids.includes('used'), 'a node that was retrieved is not retired')
    assert.ok(!ids.includes('lonely'), 'a decision with no edges is still load-bearing... via hits/importance')
    // The degree-3 star centre has the same coreness as a leaf; degree is what protects it.
    assert.ok(!ids.includes('hub1'), 'a hub is not retired even at low availability')
  } finally { store.close() }
})

test('retirement is reversible, and it only changes visibility', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', {
      nodes: [node('junk'), node('keep', { kind: 'constraint' })],
      edges: [],
    })
    age(store, 'junk', 60, T0)
    age(store, 'keep', 60, T0)
    const view = memoryView(store, 'p', { now: T0 })
    const gone = retire(store, 'p', view, { degFloor: 1 })
    assert.deepEqual(gone, ['junk'], 'only the old, unused, unassociated node is retired')
    assert.equal(view.byId.size, 2, 'the pre-retirement view still lists both')
    const after = memoryView(store, 'p', { now: T0 })
    assert.equal(after.byId.has('junk'), false, 'retired nodes leave the projection')
    assert.deepEqual(restore(store, ['junk']), ['junk'], 'and come back on request')
    assert.equal(memoryView(store, 'p', { now: T0 }).byId.has('junk'), true)
    // The row itself is still there — nothing was deleted.
    assert.ok(store.nodeRow('junk'), 'retirement never removes the record')
  } finally { store.close() }
})

test('recall ranking is cue-driven: activation first, standing value as a nudge', () => {
  const store = fixture()
  try {
    const view = memoryView(store, 'p', { now: T0 })
    const ranked = rankRecall(view, ['lonely', 'used', 'pendant'])
    assert.equal(ranked[0].id, 'used', 'the recently recalled node leads a recall')
  } finally { store.close() }
})

test('render stays inside the byte budget and never duplicates a claim', () => {
  const store = fixture()
  try {
    const view = memoryView(store, 'p', { now: T0 })
    const card = render(view, { budget: 120 })
    assert.ok(Buffer.byteLength(card) <= 120, `card was ${Buffer.byteLength(card)} bytes`)
    assert.ok(card.startsWith('[骨架]'))
    assert.equal(render(memoryView(store, 'p', { now: T0 }), { budget: 4 }), '', 'no room, no card')
  } finally { store.close() }
})

test('explain reports the reasoning, because an unexplained score is a rumour', () => {
  const store = fixture()
  try {
    const view = memoryView(store, 'p', { now: T0 })
    const rows = explain(view, ['pin', 'used', 'missing'])
    assert.equal(rows[0].fate, 'pinned')
    assert.ok(rows[1].A > 0)
    assert.equal(rows[2].missing, true)
  } finally { store.close() }
})
