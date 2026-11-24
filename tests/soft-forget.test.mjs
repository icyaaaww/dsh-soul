import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { recall } from '../src/memory.js'
import { restore } from '../src/graph-memory.js'
import { softForget } from '../src/soft-forget.js'

const DAY = 86_400_000
const NOW = 1_790_000_000_000
const GRACE = 30 * DAY

function fixture() {
  let time = NOW
  const store = new Store(':memory:', { now: () => time })
  return { store, setNow: value => { time = value } }
}

function add(store, scope, nodes, edges = []) {
  store.recordNodes(scope, { nodes: nodes.map(node => ({
    id: node.id,
    kind: node.kind ?? 'progress',
    claim: node.claim ?? `note ${node.id}`,
    pin: node.pin ?? 0,
    salience: node.salience ?? 0,
  })), edges })
}

function age(store, scope, id, days = 40) {
  const at = NOW - days * DAY
  store.db.prepare('UPDATE node SET created=?, seen=? WHERE id=? AND scope=?').run(at, at, id, scope)
}

test('soft forgetting retires opt-in cold notes but recall and restore keep their history', () => {
  const { store, setNow } = fixture()
  try {
    add(store, 'project-a', [
      { id: 'cold', claim: 'xenon keepsake record' },
      { id: 'grace', claim: 'separate isolated note' },
    ])
    age(store, 'project-a', 'cold')
    age(store, 'project-a', 'grace')

    assert.deepEqual(softForget(store, 'project-a'), ['cold', 'grace'])
    assert.equal(store.nodeRow('cold').state, 'retired')
    assert.ok(store.nodeRow('cold'), 'retirement never physically deletes the row')
    assert.ok(recall(store, 'project-a', 'xenon keepsake', { spread: false }).hits.some(row => row.id === 'cold'),
      'existing recall can still find a retired node as history')

    assert.deepEqual(restore(store, ['cold', 'grace']), ['cold', 'grace'])
    assert.equal(store.nodeRow('cold').state, 'active')
    assert.equal(store.nodeRow('cold').seen, NOW, 'restore starts a fresh grace period')
    assert.deepEqual(softForget(store, 'project-a', { now: NOW }), [], 'restore cannot immediately re-retire nodes')
    setNow(NOW + GRACE - 1)
    assert.deepEqual(softForget(store, 'project-a'), [], 'restored nodes get a full 30-day idle interval')
    setNow(NOW + GRACE)
    assert.deepEqual(softForget(store, 'project-a'), ['grace'],
      'the unused restored node becomes eligible when grace expires; the recalled node stays protected')
  } finally { store.close() }
})

test('pins, durable kinds, salience, incidents, recency, use, and graph connections are protected', () => {
  const { store } = fixture()
  try {
    add(store, 'p', [
      { id: 'cold' },
      { id: 'pinned', pin: 1 },
      { id: 'constraint', kind: 'constraint' },
      { id: 'decision', kind: 'decision' },
      { id: 'artifact', kind: 'artifact' },
      { id: 'salient', salience: 0.1 },
      { id: 'incident', kind: 'incident' },
      { id: 'recent' },
      { id: 'hit' },
      { id: 'logged' },
      { id: 'linked-a' },
      { id: 'linked-b' },
    ], [{ src: 'linked-a', dst: 'linked-b', rel: 'related', w: 1 }])
    for (const id of ['cold', 'pinned', 'constraint', 'decision', 'artifact', 'salient', 'incident', 'hit', 'logged', 'linked-a', 'linked-b']) age(store, 'p', id)
    const recentAt = NOW - DAY
    store.db.prepare('UPDATE node SET created=?, seen=? WHERE id=? AND scope=?').run(recentAt, recentAt, 'recent', 'p')
    store.db.prepare('UPDATE node SET hits=1 WHERE id=? AND scope=?').run('hit', 'p')
    store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
      .run('logged-use', 'p', 'logged', 'historic use', NOW - 35 * DAY)

    assert.deepEqual(softForget(store, 'p'), ['cold'])
    for (const id of ['pinned', 'constraint', 'decision', 'artifact', 'salient', 'incident', 'recent', 'hit', 'logged', 'linked-a', 'linked-b']) {
      assert.equal(store.nodeRow(id).state, 'active', `${id} remains active`)
    }
  } finally { store.close() }
})

test('forgetting is project-scoped and processes no more than 25 nodes per call', () => {
  const { store } = fixture()
  try {
    add(store, 'a', [{ id: 'a-cold' }])
    add(store, 'b', [{ id: 'b-cold' }])
    age(store, 'a', 'a-cold')
    age(store, 'b', 'b-cold')
    assert.deepEqual(softForget(store, 'a'), ['a-cold'])
    assert.equal(store.nodeRow('b-cold').state, 'active', 'another project is untouched')

    const batch = Array.from({ length: 40 }, (_, index) => ({ id: `batch-${index}` }))
    add(store, 'batch-project', batch)
    for (const { id } of batch) age(store, 'batch-project', id)
    const retired = softForget(store, 'batch-project')
    assert.equal(retired.length, 25, 'each invocation is bounded to 25 transitions')
    assert.ok(retired.every(id => store.nodeRow(id)?.state === 'retired'))
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM node WHERE scope='batch-project' AND state='active'").get().n, 15)
  } finally { store.close() }
})
