import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { legacyCandidates } from '../src/memory.js'
import { terms } from '../src/util.js'
import { expandTopic, listTopics } from '../src/topics.js'
import { softForget } from '../src/soft-forget.js'

// Fixed source-backed workload: each independently addressable file has 2–12 facts
// distributed across sessions. The query carries only the shared object, not fact text.
const now = 1_790_000_000_000
const store = new Store(':memory:', { now: () => now, maxNodes: 500 })
const groups = Array.from({ length: 36 }, (_, g) => ({
  path: `src/area${g}/component${g}.js`,
  count: 2 + (g * 7) % 11,
}))
const nodes = [], spans = [], gold = new Map()
for (let g = 0; g < groups.length; g++) {
  const group = groups[g]
  const ids = []
  for (let i = 0; i < group.count; i++) {
    const id = `g${g}-fact${i}`
    const session = `session-${g}-${i}`
    const seq = i * 10 + g
    const claim = `${group.path} 记录事实编号 ${i}，状态为 已核验-${g}-${i}。`
    nodes.push({ id, scope: 'p', kind: i === 0 ? 'decision' : 'progress', claim, session, seq })
    spans.push({ scope: 'p', session, seq, kind: 'user/message', text: `原始证据：${claim}`, hash: `h-${g}-${i}` })
    ids.push(id)
  }
  gold.set(group.path, ids)
}

function forgettingComparison() {
  const forgotten = new Store(':memory:', { now: () => now, maxNodes: 500 })
  try {
    const cold = Array.from({ length: 100 }, (_, i) => ({
      id: `cold-${i}`, kind: 'progress', claim: `cold workspace marker ${i} ref-unique-${i}`,
    }))
    const protectedRows = [
      { id: 'pinned', kind: 'progress', claim: 'protected pinned note', pin: true },
      { id: 'durable', kind: 'decision', claim: 'protected decision note' },
      { id: 'linked-a', kind: 'progress', claim: 'src/protected/a.js related note' },
      { id: 'linked-b', kind: 'progress', claim: 'src/protected/a.js related result' },
      { id: 'recent', kind: 'progress', claim: 'recent progress note' },
    ]
    forgotten.recordNodes('p', { nodes: [...cold, ...protectedRows], edges: [{ src: 'linked-a', dst: 'linked-b', rel: 'related', w: 1 }] })
    const agedAt = now - 31 * 86_400_000
    forgotten.db.prepare(`UPDATE node SET created=?,seen=? WHERE scope='p' AND id LIKE 'cold-%'`)
      .run(agedAt, agedAt)
    for (const row of protectedRows.filter(row => row.id !== 'recent')) {
      forgotten.db.prepare('UPDATE node SET created=?,seen=? WHERE scope=? AND id=?').run(agedAt, agedAt, 'p', row.id)
    }
    const before = forgotten.db.prepare("SELECT COUNT(*) n FROM node WHERE scope='p' AND state='active'").get().n
    const archivedQuery = 'ref-unique-99 cold workspace marker'
    const inTopSix = () => legacyCandidates(forgotten, 'p', archivedQuery, 6).some(row => row.id === 'cold-99')
    const beforeTopSix = inTopSix()
    const retired = []
    for (let pass = 0; pass < 4; pass++) retired.push(...softForget(forgotten, 'p', { now }))
    const active = forgotten.db.prepare("SELECT COUNT(*) n FROM node WHERE scope='p' AND state='active'").get().n
    const stillRecallable = forgotten.searchNodes('p', terms(archivedQuery), 100, { includeRetired: true }).some(row => row.id === 'cold-99')
    const report = {
      '2.2 active nodes (no soft retirement)': before,
      '2.3 active nodes after four bounded passes': active,
      '2.3 retired but retained': retired.length,
      'legacy top 6 hit before retirement': beforeTopSix,
      'legacy top 6 hit after retirement': inTopSix(),
      'retained record in index results (limit 100)': stillRecallable,
    }
    console.log('fixed synthetic forgetting workload (isolated old progress nodes; no real-session claim)')
    console.table(report)
    assert.equal(retired.length, 100)
    assert.equal(active, before - 100)
    assert.equal(stillRecallable, true, 'soft retirement leaves archived evidence searchable')
  } finally {
    forgotten.close()
  }
}
forgettingComparison()

try {
  store.recordNodes('p', { nodes })
  for (const span of spans) store.putSpans('p', span.session, [span])

  let legacyTop3 = 0, legacyTop6 = 0, hierarchy = 0, hierarchySources = 0
  let legacyBytes = 0, topicIndexBytes = 0, topicExpansionBytes = 0
  for (const group of groups) {
    const expected = gold.get(group.path)
    const baseline = legacyCandidates(store, 'p', group.path, 6)
    const baseline3 = baseline.slice(0, 3)
    legacyTop3 += baseline3.filter(node => expected.includes(node.id)).length / expected.length
    legacyTop6 += baseline.filter(node => expected.includes(node.id)).length / expected.length
    legacyBytes += Buffer.byteLength(JSON.stringify(baseline3.map(node => ({
      id: node.id, claim: node.claim,
      excerpt: store.spanAt('p', node.session, node.seq)?.text.slice(0, 300) ?? null,
    }))))

    const listed = listTopics(store, 'p', group.path, 8)
    assert.equal(listed.length, 1, `one exact group for ${group.path}`)
    topicIndexBytes += Buffer.byteLength(JSON.stringify({ topics: listed }))
    const expanded = expandTopic(store, 'p', listed[0].id)
    assert.ok(expanded)
    const members = expanded.members.filter(member => expected.includes(member.id))
    hierarchy += members.length / expected.length
    hierarchySources += members.filter(member => member.excerpt !== null).length / expected.length
    topicExpansionBytes += Buffer.byteLength(JSON.stringify(expanded))
  }

  const n = groups.length
  const metrics = {
    topics: n,
    sourceFacts: groups.reduce((sum, group) => sum + group.count, 0),
    '2.2 legacy source coverage @3': Number((legacyTop3 / n).toFixed(3)),
    '2.2 legacy node coverage @6': Number((legacyTop6 / n).toFixed(3)),
    '2.3 topic member coverage': Number((hierarchy / n).toFixed(3)),
    '2.3 topic source coverage': Number((hierarchySources / n).toFixed(3)),
    '2.2 bytes/query (top 3 + sources)': Math.round(legacyBytes / n),
    '2.3 directory bytes/query': Math.round(topicIndexBytes / n),
    '2.3 expansion bytes/query': Math.round(topicExpansionBytes / n),
  }
  console.log('fixed synthetic source-backed topic workload (not a real-session quality claim)')
  console.table(metrics)
  assert.equal(hierarchy, n, 'every source fact is expanded')
  assert.equal(hierarchySources, n, 'every expanded fact has a source excerpt')
  assert.ok(topicIndexBytes < legacyBytes, 'the first routing step stays smaller than direct evidence results')
  assert.ok(topicExpansionBytes > legacyBytes, 'full evidence expansion should disclose its additional byte cost')
} finally {
  store.close()
}
