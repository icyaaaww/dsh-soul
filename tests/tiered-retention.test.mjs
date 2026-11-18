import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { recall } from '../src/memory.js'

test('a displaced decision leaves the card but its value is retrievable', t => {
  let now = 1000
  const store = new Store(':memory:', { maxNodes: 1, now: () => now++, tieredRetention: true })
  t.after(() => store.close())
  for (const [id, claim] of [['old', 'alpha.js timeout is 17'], ['new', 'beta.js limit is 82']]) {
    store.recordNodes('p', { nodes: [{ id, kind: 'decision', claim }] })
  }
  assert.equal(store.nodeRow('old').state, 'retired')
  assert.deepEqual(store.activeNodes('p').map(n => n.id), ['new'])
  assert.ok(recall(store, 'p', 'alpha.js timeout').hits.some(h => h.claim.includes('timeout is 17')))
})

test('tiered eviction bounds both pools, never touches pins or another scope, and cleans indexes', t => {
  let now = 1000
  const store = new Store(':memory:', { maxNodes: 2, now: () => now++, tieredRetention: true })
  t.after(() => store.close())
  store.recordNodes('other', { nodes: [{ id: 'outside', kind: 'progress', claim: 'outside.js' }] })
  store.recordNodes('p', { nodes: [{ id: 'pin', kind: 'constraint', claim: 'keep me', pin: true }] })
  for (let i = 0; i < 20; i++) store.recordNodes('p', { nodes: [{ id: `a${i}`, kind: 'progress', claim: `file${i}.js` }],
    edges: [{ src: 'pin', dst: `a${i}`, rel: 'supports' }] })
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM node WHERE scope='p' AND pin=0").get().n, 8)
  assert.equal(store.activeNodes('p', 100).length, 3)
  assert.equal(store.nodeRow('pin').pin, 1)
  assert.equal(store.nodeRow('outside').state, 'active')
  assert.equal(store.db.prepare('SELECT count(*) n FROM mention WHERE node NOT IN (SELECT id FROM node)').get().n, 0)
  assert.equal(store.db.prepare('SELECT count(*) n FROM edge WHERE dst NOT IN (SELECT id FROM node)').get().n, 0)
})

test('superseded decisions yield archive space before current retired facts', t => {
  let now = 1000
  const store = new Store(':memory:', { maxNodes: 1, now: () => now++, tieredRetention: true })
  t.after(() => store.close())
  const add = (id, kind) => store.recordNodes('p', { nodes: [{ id, kind, claim: `${id}.js` }] })
  add('obsolete', 'decision'); store.supersede('obsolete')
  add('current', 'decision'); add('newer', 'decision'); add('traceA', 'progress'); add('traceB', 'progress')
  assert.equal(store.nodeRow('obsolete'), null)
  assert.equal(store.nodeRow('current').state, 'retired')
})
