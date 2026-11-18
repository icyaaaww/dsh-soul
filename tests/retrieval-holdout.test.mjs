import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../bench/retrieval-holdout.mjs'

test('holdout separates hit@3 from abstention and never retrieves from future snapshots', () => {
  const result = evaluate({ snapshots: [
    { nodes: [], queries: [{ id: 'before', text: '快照周期', gold: [] }] },
    { nodes: [{ id: 'n', claim: '快照周期是三天' }], queries: [{ id: 'after', text: '快照周期', gold: ['n'] }] },
  ] })
  for (const metric of [result.hit3, result.abstain]) assert.deepEqual(metric, { n: 1, legacy: 1, ranked: 1, gained: 0, lost: 0 })
})

test('holdout rejects unknown gold and duplicate query IDs', () => {
  const q = { id: 'q', text: '快照周期', gold: [] }
  assert.throws(() => evaluate({ snapshots: [{ nodes: [], queries: [{ ...q, gold: ['future'] }] }] }), /invalid query/)
  assert.throws(() => evaluate({ snapshots: [{ nodes: [], queries: [q, q] }] }), /invalid query/)
})
