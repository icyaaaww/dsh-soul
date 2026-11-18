import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { recall } from '../src/memory.js'
import { rankedCandidates } from '../src/graph-search.js'

const put = (s, id, claim, scope = 'p') => s.recordNodes(scope, { nodes: [{ id, kind: 'decision', claim }] })
const ids = (s, query) => rankedCandidates(s, 'p', query, 3).map(row => row.id)

test('full paths disambiguate basenames, unknown attributes and scopes do not create hits', t => {
  const s = new Store(':memory:', { rankedRecall: true }); t.after(() => s.close())
  put(s, 'a', 'src/alpha/index.js 连接池上限 17'); put(s, 'b', 'src/beta/index.js 连接池上限 24')
  put(s, 'other', 'src/beta/index.js 快照周期', 'elsewhere')
  assert.deepEqual(ids(s, 'src/beta/index.js 连接池上限'), ['b'])
  assert.deepEqual(ids(s, 'src/gamma/index.js 连接池上限'), [])
  const result = recall(s, 'p', 'src/beta/index.js 快照周期')
  assert.deepEqual(result.hits, []); assert.deepEqual(result.neighbours, []); assert.equal(result.links, 0)
  assert.equal(s.db.prepare('SELECT count(*) n FROM activation').get().n, 0)
})

test('Chinese lexical queries without identifiers work; current facts outrank equally matched history', t => {
  const s = new Store(':memory:', { rankedRecall: true }); t.after(() => s.close())
  put(s, 'old', '快照周期定为三天'); s.supersede('old'); put(s, 'current', '快照周期定为五天')
  assert.deepEqual(ids(s, '快照周期'), ['current','old'])
  assert.deepEqual(ids(s, '为什么昨天发布过程突然超时'), [])
})

test('first enable backfills; another legacy writer updates and deletes indexed rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-rank-')), path = join(dir, 'test.sqlite')
  let first, ranked
  try {
    first = new Store(path); put(first, 'fact', 'connection budget')
    ranked = new Store(path, { rankedRecall: true }); assert.deepEqual(ids(ranked, 'connection budget'), ['fact'])
    put(first, 'fact', 'cache timeout'); assert.deepEqual(ids(ranked, 'connection budget'), [])
    assert.deepEqual(ids(ranked, 'cache timeout'), ['fact'])
    first.db.prepare('DELETE FROM node WHERE id=?').run('fact'); assert.deepEqual(ids(ranked, 'cache timeout'), [])
  } finally { ranked?.close(); first?.close(); rmSync(dir, { recursive: true, force: true }) }
})
