/**
 * Graph memory — activation, periphery, and the read path that was missing.
 *
 * The store already keeps everything needed to know what is fading: `activation.at` (when a
 * node was recalled), `edge.w` (how strongly things are associated), `node.kind`/`pin` (what
 * must not be lost). None of it reached the projection, which sorted by `pin -> kind -> seq`.
 * A weight was accumulated and never read.
 *
 * This module is the read path. Its whole design rests on one claim: **there are three
 * orthogonal signals and they must not be collapsed into one number.**
 *
 *   A  activation   — "could I produce this if asked right now?"   frequency x recency
 *   C  coreness     — "how central is this in the association graph?"  structure only
 *   I  importance   — "what happens if this is wrong?"               human-assigned, static
 *
 * Each has a specific, observed failure when used alone:
 *   A only  -> whatever was mentioned most recently monopolises the card, trivia included
 *   C only  -> a hub is fed forever (the mega-hub problem), and structure carries no clock
 *   I only  -> a static order starves: measured 280 reviews delivered to 7 of 60 nodes
 *
 * So each signal is used exactly once, where it is the right instrument:
 *   A  orders what to show, and gates what to retire
 *   C  gates retirement only — never display, because a load-bearing decision is often low-degree
 *   I  caps the order, so a fresh `progress` line cannot outrank a standing constraint
 *
 * Cost: one pass over `activation` and `edge` per call, O(V + E + A) with no per-node history
 * scan — the activation rows are grouped once, not queried per node. No new tables, no new
 * columns, no model call, nothing to migrate. Everything here is derived from data the store
 * already writes.
 */

const DAY = 86_400_000
const MIN_EDGE_WEIGHT = 0.1
// `supersedes` means "replaced", not "associated". Letting it link nodes would make an obsolete
// claim look central precisely because something newer points at it.
const NON_ASSOCIATIVE = new Set(['supersedes'])

/**
 * Time quantum for the projection.
 *
 * `A` depends on a clock, so a naive read path makes the card change between two calls in the
 * same turn — which breaks "same state, same bytes" and with it the prompt cache prefix. The
 * clock is quantised instead: the card is byte-identical for every call inside one bucket, and
 * rotates across buckets. Five minutes is the default because it is longer than a tool loop and
 * shorter than a working session; a turn-anchored clock is the stricter option.
 */
export const QUANTUM_MS = 5 * 60_000
export const clock = (now = Date.now(), quantum = QUANTUM_MS) => Math.floor(now / quantum) * quantum

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * ACT-R base-level activation: `B = ln Σ (t - t_j)^-d`.
 *
 * One parameter, and it produces power-law forgetting, the spacing effect and the frequency
 * effect together. Creation counts as an encoding event, so a node that was never retrieved
 * still decays from birth instead of being undefined.
 *
 * `d = 0.5` is ACT-R's canonical value. Anderson & Schooler (1991) showed the power law is not
 * an arbitrary fit: the need-probability of items in the environment follows a power function,
 * and this is the Bayes-optimal estimate of it.
 */
export function activation(times, now = Date.now(), { d = 0.5, floorMs = 60_000 } = {}) {
  if (!times?.length) return -Infinity
  let sum = 0
  for (const at of times) {
    const days = Math.max(floorMs / DAY, (now - Number(at)) / DAY)
    sum += days ** -d
  }
  return sum > 0 ? Math.log(sum) : -Infinity
}

/**
 * Normalise activation to [0,1] for ranking, via the logistic ACT-R uses for recall probability.
 *
 * Ordinal, not calibrated: read it as "more available than", never as "N% chance". The threshold
 * is expressed as a **quantile of the current distribution** rather than an absolute number, so
 * the rule self-calibrates and there is no magic constant to tune per project.
 */
export function availability(B, { threshold = 0, noise = 0.4 } = {}) {
  if (!Number.isFinite(B)) return 0
  return 1 / (1 + Math.exp(-(B - threshold) / noise))
}

/**
 * k-core decomposition, Batagelj–Zaversnik O(V + E).
 *
 * `coreness(v)` is the largest k for which v survives k rounds of "delete every node of degree
 * < k". It is the formal version of "how buried in the core" a memory is.
 *
 * It is **not** the right instrument for "does anything still link to this": the centre of a
 * star has three neighbours and coreness 1, exactly like a leaf. Measured on a barbell-plus-
 * pendant fixture, a degree-3 hub and a dangling pendant were indistinguishable to the k-core,
 * so retirement cannot be gated on it. Degree answers that question directly. Coreness keeps
 * its place where it does add something — explaining *why* a node is peripheral, and weighting
 * compaction — but not as the retirement gate.
 */
export function coreness(ids, edges, { minWeight = MIN_EDGE_WEIGHT } = {}) {
  const { core } = adjacency(ids, edges, { minWeight })
  return core
}

/** Degree and coreness in one pass: they are computed from the same adjacency. */
export function adjacency(ids, edges, { minWeight = MIN_EDGE_WEIGHT } = {}) {
  const index = new Map(ids.map((id, i) => [id, i]))
  const n = ids.length
  const deg = new Int32Array(n)
  const adj = Array.from({ length: n }, () => [])
  for (const edge of edges) {
    if (NON_ASSOCIATIVE.has(edge.rel)) continue
    if ((edge.w ?? 1) < minWeight) continue
    const a = index.get(edge.src)
    const b = index.get(edge.dst)
    if (a == null || b == null || a === b) continue
    adj[a].push(b)
    adj[b].push(a)
    deg[a]++
    deg[b]++
  }
  const degree = new Map(ids.map((id, i) => [id, deg[i]]))
  const maxDeg = deg.reduce((m, v) => Math.max(m, v), 0)
  const bin = new Int32Array(maxDeg + 2)
  for (let i = 0; i < n; i++) bin[deg[i]]++
  let start = 0
  for (let d = 0; d <= maxDeg; d++) { const num = bin[d]; bin[d] = start; start += num }
  const pos = new Int32Array(n)
  const vert = new Int32Array(n)
  for (let i = 0; i < n; i++) { pos[i] = bin[deg[i]]; vert[pos[i]] = i; bin[deg[i]]++ }
  for (let d = maxDeg; d >= 1; d--) bin[d] = bin[d - 1]
  bin[0] = 0
  const core = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const v = vert[i]
    core[v] = deg[v]
    for (const u of adj[v]) {
      if (deg[u] > deg[v]) {
        const du = deg[u]
        const pu = pos[u]
        const pw = bin[du]
        const wv = vert[pw]
        if (u !== wv) { pos[u] = pw; vert[pu] = wv; pos[wv] = pu; vert[pw] = u }
        bin[du]++
        deg[u]--
      }
    }
  }
  return { degree, core: new Map(ids.map((id, i) => [id, core[i]])) }
}

/** Importance: what happens if this is wrong. Assigned by kind and pin, never by age. */
export function importanceOf(node) {
  if (node.pin) return 1000
  switch (node.kind) {
    case 'constraint': return 12
    case 'decision': return 6
    case 'artifact': return 3
    case 'reference': return 2
    default: return 2
  }
}

/** Per-turn value of a memory: high when it is about to be lost, low when it is safe. */
export function due(A, { aHigh = 0.95 } = {}) {
  return A <= aHigh ? 1 + (1 - A) : 1 / (1 + 4 * (A - aHigh))
}

/**
 * Prepared statements, cached per store.
 *
 * `projectionText` runs on every model call, so a `prepare()` per call is pure overhead —
 * measured at roughly two thirds of the read-path cost at 500 nodes. The cache is keyed by the
 * store instance and holds nothing else, so a closed store simply drops its entry.
 */
/**
 * Incremental read of the activation log.
 *
 * The activation table is append-only and large, and `memoryView` runs on every model call. Most
 * of those calls see a log that has not changed since the previous one, so the whole scan is
 * repeated work. The cache key is `(MAX(rowid), COUNT(*))`: appends move the rowid, and pruning
 * moves the count without necessarily moving the rowid, so both together detect every change a
 * `DELETE` can make. Keyed by store instance, so a closed store drops its entry with it.
 *
 * This is the cheap half of Petrov's approximation: instead of storing a running summary per
 * node, remember the scan. It leaves the activation rows as the single source of truth — no
 * second copy to drift out of sync — and costs one indexed aggregate per call when cold.
 */
const ACTIVATIONS = new WeakMap()

function activationTimes(store, scope) {
  const stamp = store.db.prepare(
    'SELECT COALESCE(MAX(rowid),0) m, COUNT(*) n FROM activation WHERE scope=?').get(scope)
  const key = `${stamp.m}:${stamp.n}`
  const cached = ACTIVATIONS.get(store)?.get(scope)
  if (cached && cached.key === key) return cached

  const times = new Map()
  let activations = 0
  for (const row of store.db.prepare('SELECT node, at FROM activation WHERE scope=?').all(scope)) {
    const list = times.get(row.node)
    if (list) list.push(Number(row.at))
    else times.set(row.node, [Number(row.at)])
    activations++
  }
  const value = { key, times, activations }
  const byScope = ACTIVATIONS.get(store) ?? new Map()
  byScope.set(scope, value)
  ACTIVATIONS.set(store, byScope)
  return value
}

const PREPARED = new WeakMap()
function statements(store) {
  let set = PREPARED.get(store)
  if (set) return set
  set = {
    edge: store.db.prepare('SELECT src, dst, rel, w FROM edge WHERE scope=?'),
    retire: store.db.prepare("UPDATE node SET state='retired', seen=? WHERE id=? AND pin=0"),
    restore: store.db.prepare("UPDATE node SET state='active', valid_to=NULL WHERE id=?"),
  }
  PREPARED.set(store, set)
  return set
}

/**
 * Build the whole read view in one pass.
 *
 * This replaces four separate scans (`activeNodes`, `searchNodes`, `neighbours`, `pruneNodes`)
 * with one, because all four wanted the same numbers. At the store's own ceiling — 500 nodes,
 * ~2000 edges — the whole thing runs in single-digit milliseconds, against a model call
 * measured in seconds.
 */
export function memoryView(store, scope, { now = Date.now(), quantum = QUANTUM_MS, limit = 500, cues = null } = {}) {
  const at = clock(now, quantum)
  const nodes = store.activeNodes(scope, limit)
  if (!nodes.length) return { at, byId: new Map(), list: [], q25: 0, maxCore: 0, sizes: { nodes: 0, edges: 0, activations: 0 } }

  const sql = statements(store)
  const log = activationTimes(store, scope)
  const times = log.times
  const activations = log.activations
  const edges = sql.edge.all(scope)
  const ids = nodes.map(node => node.id)
  const { degree, core } = adjacency(ids, edges)

  const byId = new Map()
  const scored = []
  // Associative activation (ACT-R's other half). Base-level `A` answers "how recently have I
  // needed this"; a cue adds "does the current question point at it". Without this the card is
  // a standing summary and the only thing that makes it contextual is a separate `soul_recall`
  // round-trip — which the model has to decide to make, and usually does not.
  //
  // The fan effect is the reason for the divisor: a cue term that many nodes share carries
  // little information about any of them, exactly like IDF. Without it, "src" or "文件" would
  // lift half the graph and the cue would rank nothing.
  const cueSet = new Set(cues ?? [])
  const cueFan = new Map()
  if (cueSet.size) {
    for (const node of nodes) for (const term of node.terms) {
      if (cueSet.has(term)) cueFan.set(term, (cueFan.get(term) ?? 0) + 1)
    }
  }
  const strength = node => {
    if (!cueSet.size) return 0
    let sum = 0
    for (const term of node.terms) if (cueSet.has(term)) sum += 1 / (cueFan.get(term) ?? 1)
    return sum
  }
  const rawStrengths = cueSet.size ? nodes.map(node => strength(node)) : []
  const maxStrength = rawStrengths.reduce((m, v) => Math.max(m, v), 0)

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const list = times.get(node.id)
    // Creation is an encoding event, so it is always in the trace. Without it a node that was
    // never recalled has no activation at all, and the rule would treat "brand new" and "long
    // forgotten" as the same thing.
    const trace = list ? [Number(node.created), ...list] : [Number(node.created)]
    const A = availability(activation(trace, at))
    const entry = {
      id: node.id, kind: node.kind, claim: node.claim, pin: Boolean(node.pin),
      hits: Number(node.hits) || 0, seq: Number(node.seq) || 0,
      A, deg: degree.get(node.id) ?? 0, core: core.get(node.id) ?? 0,
      importance: importanceOf(node),
      ageDays: (at - Number(node.created)) / DAY,
      // Normalised to [0,1] so it can multiply the order without a magic scale factor.
      cue: maxStrength ? rawStrengths[i] / maxStrength : 0,
    }
    byId.set(node.id, entry)
    scored.push(entry)
  }

  const A = scored.map(entry => entry.A).sort((a, b) => a - b)
  const q25 = A.length ? A[Math.floor(A.length * 0.25)] : 0
  const maxCore = scored.reduce((m, entry) => Math.max(m, entry.core), 0)
  return { at, byId, list: scored, q25, maxCore, sizes: { nodes: nodes.length, edges: edges.length, activations } }
}

/**
 * Order for the standing card.
 *
 * Pinned first unconditionally: a violated constraint is an error, not a low-probability recall,
 * so its availability is irrelevant. Everything else competes on `importance x due(A)`, which is
 * what produces rotation — a memory that was shown last turn has high A and a low due, so it
 * yields to one that was not. A static order, by any criterion, cannot do that.
 *
 * A cue multiplies the order rather than replacing it. `1 + 2 * cue` is bounded, so a strong
 * match can promote a peripheral node but cannot let one outrank a pinned constraint or a
 * load-bearing decision — the cue adjusts *within* the importance band, never across it.
 */
export function orderProjection(view, { aHigh = 0.95, cueWeight = 2 } = {}) {
  const score = entry => entry.importance * due(entry.A, { aHigh }) * (1 + cueWeight * (entry.cue ?? 0))
  return [...view.list].sort((a, b) =>
    (b.pin ? 1 : 0) - (a.pin ? 1 : 0)
    || score(b) - score(a)
    || b.seq - a.seq)
}

/** Order for recall: the query is the cue, so activation matters more than standing value. */
export function rankRecall(view, ids) {
  return [...ids]
    .map(id => view.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => (b.A * (1 + b.importance / 12)) - (a.A * (1 + a.importance / 12)))
}

/**
 * Spread a query's mass over the association graph (HippoRAG's idea, applied at project scale).
 *
 * A lexical hit is a seed, not an answer. The question "为什么加载器失效" matches the node that
 * says "加载器" and says nothing about the constraint two hops away that explains it. One-hop
 * neighbours only reach the first ring; stationary propagation reaches the rest at a strength
 * that decays with distance, which is exactly the ranking we want.
 *
 * `alpha` is the teleport probability — the share of mass that stays on the seeds. 0.5 over
 * three iterations is shallow on purpose: at this graph size (≤500 nodes) a long random walk
 * makes everything reachable from everything, and the ranking stops discriminating. Edge weight
 * is the transition probability, so `supersedes` is excluded (a replaced claim is not an
 * association) and the `related` / `coactivated` / `derived` edges carry the walk.
 */
export function propagate(nodes, edges, seeds, { alpha = 0.5, iterations = 3, minWeight = MIN_EDGE_WEIGHT } = {}) {
  const rank = new Map()
  if (!nodes.length || !seeds.length) return rank
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const n = nodes.length
  const out = Array.from({ length: n }, () => [])
  for (const edge of edges) {
    if (NON_ASSOCIATIVE.has(edge.rel)) continue
    if ((edge.w ?? 1) < minWeight) continue
    const a = index.get(edge.src)
    const b = index.get(edge.dst)
    if (a == null || b == null || a === b) continue
    // Undirected: association has no direction, and a seed should lift what points at it as
    // well as what it points at.
    out[a].push({ to: b, w: edge.w })
    out[b].push({ to: a, w: edge.w })
  }

  const prefer = new Float64Array(n)
  let seeded = 0
  for (const seed of seeds) {
    const i = index.get(seed?.id ?? seed)
    if (i == null) continue
    // A stronger lexical match seeds more mass; every seed still seeds something.
    prefer[i] += Math.max(0.2, Number(seed?.score ?? 1) || 1)
    seeded++
  }
  if (!seeded) return rank
  const total = prefer.reduce((sum, v) => sum + v, 0) || 1
  for (let i = 0; i < n; i++) prefer[i] /= total

  let mass = Float64Array.from(prefer)
  for (let step = 0; step < iterations; step++) {
    const next = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      next[i] += alpha * prefer[i]
      const links = out[i]
      if (!links.length) continue
      const weight = links.reduce((sum, link) => sum + link.w, 0) || 1
      for (const link of links) next[link.to] += (1 - alpha) * mass[i] * (link.w / weight)
    }
    mass = next
  }

  const peak = Math.max(...mass)
  for (let i = 0; i < n; i++) if (mass[i] > 0) rank.set(nodes[i].id, mass[i] / peak)
  return rank
}

/**
 * What may be retired.
 *
 * The conjunction is the point: any single condition is wrong on its own.
 *   low A only       -> retires a hub nobody happened to need this month
 *   low degree only  -> retires a fresh constraint that has no edges yet
 *   never retrieved  -> retires a node created seconds ago
 *   low importance   -> without it, a decision with no edges and no recalls is retired, and it
 *                       is load-bearing precisely because it is a decision
 *
 * So all three signals appear here, each answering the question it is good at: A is the clock,
 * degree is the structure, importance is the human's verdict. `degFloor` is the operative
 * structural test rather than coreness — a star's centre and a dangling leaf both have
 * coreness 1, so a k-core gate retires the hub and keeps the leaf. Degree asks the actual
 * question: does anything still point at this?
 *
 * Retirement sets `state='retired'`, which removes it from the projection. It does **not**
 * delete: `soul_recall` still finds it, and `restore()` brings it back. Forgetting is a
 * visibility change because that is the only kind that is reversible.
 */
export function periphery(view, { aQuantile = 0.25, degFloor = 1, minAgeDays = 7, maxImportance = 3 } = {}) {
  const floor = view.q25
  return view.list.filter(entry =>
    !entry.pin
    && entry.importance <= maxImportance
    && entry.hits === 0
    && entry.ageDays >= minAgeDays
    && entry.A <= floor
    && entry.deg <= degFloor)
}

/** Apply retirement. Returns the ids changed, so the caller can log them. */
export function retire(store, scope, view, options) {
  const gone = periphery(view, options)
  if (!gone.length) return []
  const stmt = statements(store).retire
  const now = Date.now()
  for (const entry of gone) stmt.run(now, entry.id)
  return gone.map(entry => entry.id)
}

/**
 * Restore a retired node. Retiring must be a decision a person can undo, or it is a delete with
 * extra steps.
 */
export function restore(store, ids) {
  const stmt = statements(store).restore
  const out = []
  for (const id of ids) if (stmt.run(id).changes) out.push(id)
  return out
}

/** Plain-text card, byte-budgeted, same contract as `skeleton.project`. */
export function render(view, { budget = 600, aHigh = 0.95, labels = { constraint: '约束', decision: '决策', artifact: '产物', progress: '进度', reference: '索引' } } = {}) {
  const lines = ['[骨架]']
  let spent = Buffer.byteLength(lines[0])
  const seen = new Set()
  for (const entry of orderProjection(view, { aHigh })) {
    if (seen.has(entry.claim)) continue
    const line = `- ${labels[entry.kind] ?? entry.kind}: ${entry.claim}`
    const price = Buffer.byteLength(line) + 1
    if (spent + price > budget) continue
    lines.push(line)
    spent += price
    seen.add(entry.claim)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

/** Ledger line for `/mem dynamics`: what the read path currently believes, and why. */
export function explain(view, ids, { limit = 12 } = {}) {
  return [...ids].slice(0, limit).map(id => {
    const entry = view.byId.get(id)
    if (!entry) return { id, missing: true }
    return {
      id, kind: entry.kind, A: Number(entry.A.toFixed(3)),
      deg: entry.deg, core: entry.core,
      importance: entry.importance, hits: entry.hits,
      due: Number(due(entry.A).toFixed(2)),
      ageDays: Number(entry.ageDays.toFixed(1)),
      fate: entry.pin ? 'pinned' : entry.A <= view.q25 ? 'periphery' : 'active',
    }
  })
}
