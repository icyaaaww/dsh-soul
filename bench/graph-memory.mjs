/**
 * Graph memory bench — the read path, and what it costs.
 *
 * Two questions, both mechanical:
 *   1. how long does one `memoryView` take at the store's actual ceiling (500 nodes)?
 *   2. does using it in the projection change what the model sees, at the same byte budget?
 *
 *   node bench/graph-memory.mjs
 *   node bench/graph-memory.mjs --turns=60 --budget=600
 */

import { Store } from '../src/store.js'
import { memoryView, orderProjection, periphery, explain, render } from '../src/graph-memory.js'
import { availability, activation, due, importanceOf } from '../src/graph-memory.js'

const arg = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const TURNS = arg('turns', 60)
const BUDGET = arg('budget', 600)
const TURN_DAYS = arg('turn-days', 0.5)
const NODES = arg('nodes', 500)          // the store's own cap: pruneNodes(scope, 500)
const DAY = 86_400_000
const T0 = 1_790_000_000_000
const pct = v => `${(v * 100).toFixed(1)}%`
const pad = (s, n) => String(s).padEnd(n)

/* ------------------------------------------------------------------ */
/* fixture: a store at the size the cap actually allows                 */
/* ------------------------------------------------------------------ */

const SPEC = [['constraint', 12, 5], ['decision', 60, 0], ['artifact', 128, 0], ['progress', NODES - 200, 0]]

let seed = 20261031
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

function build({ consolidated = 0.3 } = {}) {
  const store = new Store(':memory:')
  const nodes = []
  const seqOf = new Map()
  let seq = 0
  for (const [kind, count, pinned] of SPEC) {
    for (let k = 0; k < count; k++) {
      const id = `${kind}-${k}`
      nodes.push({
        id, kind, pin: k < pinned ? 1 : 0, seq: seq++,
        claim: `${kind} ${k} 的载荷性标识符 mod${k}.js`,
      })
      seqOf.set(id, seq - 1)
    }
  }
  store.recordNodes('p', { nodes })

  // Associations with a heavy tail, the shape a real graph takes: each node attaches to a
  // couple of existing ones with preference for the already-connected (preferential
  // attachment), and a tenth of the nodes never get an edge at all — that tenth is the
  // periphery the retirement rule exists for. A uniform 4-edges-per-node graph makes every
  // node's coreness identical, which is what a first attempt at this fixture did and why it
  // could not tell a hub from a leaf.
  const edges = []
  const targets = []
  const isolated = new Set()
  for (let i = 0; i < nodes.length; i++) {
    if (i > 20 && i % 10 === 0) { isolated.add(nodes[i].id); continue }
    for (let k = 0; k < 2 && targets.length; k++) {
      // Preferential attachment: pick from the target list, which grows in proportion to degree.
      const to = targets[Math.floor(rnd() * targets.length)]
      const from = nodes[i].id
      if (to !== from) edges.push({ src: from, dst: to, rel: 'related', w: 1 })
    }
    targets.push(nodes[i].id, nodes[i].id) // the attached-to node gains two of the slots
  }
  store.recordNodes('p', { edges })

  // A month of history. `consolidated` of the load-bearing nodes were pulled back repeatedly;
  // the rest were written once and never needed again, which is what most of a graph looks like.
  const now = T0
  const insert = store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
  const back = store.db.prepare('UPDATE node SET created=?, seen=? WHERE id=?')
  const loadBearing = nodes.filter(n => n.kind === 'decision' || n.pin)
  const warm = new Set()
  for (let i = 0; i < loadBearing.length; i++) if (i / loadBearing.length < consolidated) warm.add(loadBearing[i].id)
  let n = 0
  for (const node of nodes) {
    const born = now - (7 + (n % 24)) * DAY
    back.run(born, born, node.id)
    n++
    if (!warm.has(node.id)) continue
    for (const daysAgo of [20, 14, 9, 5, 2, 0.5]) {
      insert.run(`a-${node.id}-${daysAgo}`, 'p', node.id, 'bench', now - daysAgo * DAY)
    }
  }
  return { store, nodes, seqOf }
}

/* ------------------------------------------------------------------ */
/* 1. cost                                                              */
/* ------------------------------------------------------------------ */

function cost() {
  const { store } = build()
  try {
    const runs = 200
    // Warm up, then measure. `memoryView` is the whole read path: one activation scan, one edge
    // scan, k-core, activation and scoring for every node.
    for (let i = 0; i < 20; i++) memoryView(store, 'p', { now: T0 })
    const start = process.hrtime.bigint()
    let view = null
    for (let i = 0; i < runs; i++) view = memoryView(store, 'p', { now: T0 + i * 1000 })
    const ns = Number(process.hrtime.bigint() - start) / runs

    // The projection it replaces: the store scan it already pays for.
    const scanStart = process.hrtime.bigint()
    for (let i = 0; i < runs; i++) store.activeNodes('p', 200)
    const scanNs = Number(process.hrtime.bigint() - scanStart) / runs
    return { ns, scanNs, sizes: view.sizes }
  } finally { store.close() }
}

/* ------------------------------------------------------------------ */
/* 2. same budget, two orderings                                        */
/* ------------------------------------------------------------------ */

const KIND_ORDER = { constraint: 0, reference: 1, decision: 2, artifact: 3, progress: 4 }

/** Seed the order the code uses today: pinned, then kind, then newest. */
function orderRecency(view) {
  return [...view.list].sort((a, b) =>
    (b.pin ? 1 : 0) - (a.pin ? 1 : 0)
    || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || b.seq - a.seq)
}

const priceOf = entry => Buffer.byteLength(`- ${entry.kind}: ${entry.claim}`) + 1

function fill(order, budget) {
  const picked = []
  let spent = 0
  for (const entry of order) {
    const price = priceOf(entry)
    if (spent + price > budget) continue
    picked.push(entry)
    spent += price
  }
  return picked
}

function experiment({ policy }) {
  const { store, nodes } = build()
  try {
    const state = new Map(nodes.map(n => [n.id, { last: T0 - 30 * DAY, shown: 0 }]))
    const covered = new Set()
    let slots = 0
    for (let turn = 0; turn < TURNS; turn++) {
      const now = T0 + turn * TURN_DAYS * DAY
      const view = memoryView(store, 'p', { now })
      const order = policy === 'recency' ? orderRecency(view) : orderProjection(view)
      const picked = fill(order, BUDGET)
      for (const entry of picked) {
        covered.add(entry.id)
        slots++
        // Being shown is a recall: it enters the activation log, exactly as `store.activate` does.
        store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
          .run(`t-${turn}-${entry.id}`, 'p', entry.id, 'projection', now)
        store.db.prepare('UPDATE node SET hits=hits+1, seen=? WHERE id=?').run(now, entry.id)
      }
    }
    const end = T0 + TURNS * TURN_DAYS * DAY
    const view = memoryView(store, 'p', { now: end })
    const critical = view.list.filter(entry => entry.pin || entry.kind === 'decision')
    const decayed = critical.filter(entry => entry.A <= view.q25)
    const trash = view.list.filter(entry => entry.kind === 'progress')
    const trashDecayed = trash.filter(entry => entry.A <= view.q25)
    return {
      slots,
      covered: covered.size,
      total: nodes.length,
      critical: critical.length,
      criticalDecayed: decayed.length,
      trashDecayed: trashDecayed.length / Math.max(1, trash.length),
      retired: periphery(view).length,
      meanA: view.list.reduce((s, e) => s + e.A, 0) / view.list.length,
    }
  } finally { store.close() }
}

/* ------------------------------------------------------------------ */

const out = []
const c = cost()
out.push(`${c.sizes.nodes} 节点 · ${c.sizes.edges} 条边 · ${c.sizes.activations} 条激活 · 预算 ${BUDGET} B · ${TURNS} 轮\n`)

out.push('## 1. 一次读路径的成本\n')
const us = v => `${(v / 1e6).toFixed(3)} ms`
out.push(`memoryView（激活扫描 + 边扫描 + k-core + 全部打分）：${us(c.ns)}`)
out.push(`它取代的 activeNodes 扫描：                            ${us(c.scanNs)}`)
out.push(`→ 增量 ${us(c.ns - c.scanNs)}。一次模型调用以秒计，占 ${(c.ns / 1e9 * 100).toFixed(3)}%。`)

const rec = experiment({ policy: 'recency' })
const dyn = experiment({ policy: 'dynamics' })
out.push('\n## 2. 同一预算、同一批节点、只有排法不同\n')
out.push(pad('', 24) + pad('最新优先（现状）', 20) + pad('importance×衰减', 20))
const rows = [
  ['期末 A 均值', rec.meanA.toFixed(3), dyn.meanA.toFixed(3)],
  ['关键节点落入低四分位', `${rec.criticalDecayed}/${rec.critical}`, `${dyn.criticalDecayed}/${dyn.critical}`],
  ['progress 落入低四分位', pct(rec.trashDecayed), pct(dyn.trashDecayed)],
  [`覆盖到的不同节点`, `${rec.covered}/${rec.total}`, `${dyn.covered}/${dyn.total}`],
  ['可退役节点', String(rec.retired), String(dyn.retired)],
]
for (const row of rows) out.push(pad(row[0], 24) + pad(row[1], 20) + pad(row[2], 20))

const sample = memoryView(build().store, 'p', { now: T0 })
out.push('\n## 3. 账本（/mem dynamics 会打印的样子）\n')
out.push(pad('id', 18) + pad('kind', 12) + pad('A', 8) + pad('deg', 6) + pad('core', 6) + pad('importance', 12) + 'fate')
for (const row of explain(sample, sample.list.slice(0, 8).map(e => e.id))) {
  out.push(pad(row.id, 18) + pad(row.kind, 12) + pad(String(row.A), 8) + pad(String(row.deg), 6) + pad(String(row.core), 6) + pad(String(row.importance), 12) + row.fate)
}

const card = render(sample, { budget: BUDGET })
out.push(`\n## 4. 卡片（${Buffer.byteLength(card)} 字节）\n`)
out.push(card)

console.log(out.join('\n'))
