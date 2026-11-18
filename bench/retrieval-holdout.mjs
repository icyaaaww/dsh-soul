import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Store } from '../src/store.js'
import { legacyCandidates } from '../src/memory.js'
import { rankedCandidates } from '../src/graph-search.js'

// One snapshot per question group: only claims available before those questions.
export function evaluate(data) {
  if (!Array.isArray(data.snapshots) || !data.snapshots.length) throw Error('need pre-query snapshots')
  const cases = [], ids = new Set()
  for (const snap of data.snapshots) {
    if (!Array.isArray(snap.nodes) || !Array.isArray(snap.queries) || !snap.queries.length) throw Error('invalid snapshot')
    const known = new Set()
    for (const n of snap.nodes) {
      if (typeof n.id !== 'string' || !n.id || known.has(n.id) || typeof n.claim !== 'string' || !n.claim.trim() ||
          (n.seen !== undefined && !Number.isSafeInteger(n.seen)) || (n.valid_to != null && !Number.isSafeInteger(n.valid_to)) ||
          !['active', 'retired', 'stale'].includes(n.state ?? 'active')) throw Error('invalid node')
      known.add(n.id)
    }
    const store = new Store(':memory:', { rankedRecall: true, maxNodes: Math.max(1, known.size), now: () => 1 })
    try {
      store.recordNodes('p', { nodes: snap.nodes.map(({id, claim, kind, pin}) => ({ id, claim, kind: kind ?? 'decision', pin })) })
      const restore = store.db.prepare('UPDATE node SET seen=?,state=?,valid_to=? WHERE id=?')
      store.tx(() => snap.nodes.forEach((n,i) => restore.run(n.seen ?? i+1, n.state ?? 'active', n.valid_to ?? null, n.id)))
      for (const q of snap.queries) {
        if (typeof q.id !== 'string' || !q.id || ids.has(q.id) || typeof q.text !== 'string' || !q.text.trim() || !Array.isArray(q.gold) || q.gold.some(id => !known.has(id))) throw Error('invalid query or gold id')
        ids.add(q.id)
        const row = { id: q.id, answerable: q.gold.length > 0 }
        for (const [name, fn] of [['legacy', legacyCandidates], ['ranked', rankedCandidates]]) {
          const out = fn(store, 'p', q.text, 6)
          row[name] = row.answerable ? out.slice(0,3).some(n => q.gold.includes(n.id)) : !out.length
        }
        cases.push(row)
      }
    } finally { store.close() }
  }
  const summary = positive => {
    const set = cases.filter(r => r.answerable === positive)
    return { n: set.length, legacy: set.filter(r => r.legacy).length, ranked: set.filter(r => r.ranked).length,
      gained: set.filter(r => !r.legacy && r.ranked).length, lost: set.filter(r => r.legacy && !r.ranked).length }
  }
  return { hit3: summary(true), abstain: summary(false), cases }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) throw Error('usage: node bench/retrieval-holdout.mjs <labeled.json>')
  const raw = readFileSync(process.argv[2]); const fingerprint = createHash('sha256').update(raw).digest('hex')
  console.log(JSON.stringify({ fingerprint, ...evaluate(JSON.parse(raw)) }, null, 2))
}
