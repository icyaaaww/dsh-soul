import { oneLine } from './util.js'

/**
 * Graph memory — the read path.
 *
 * The question the card answers is "what will the model need *now*", and the reader matters:
 * the model is stateless. Nothing it saw last call is still in its head unless it is in the
 * context again, so a spacing-effect schedule — show what is about to be forgotten — has no
 * reader whose forgetting it could slow down. 2.0 shipped exactly that schedule (`due(A)`:
 * lower activation, higher priority) and in production it showed the *oldest* items of every
 * kind, statically, because nothing logged an exposure.
 *
 * Anderson & Schooler (1991) is the right reading of ACT-R here: base-level activation is the
 * log-odds that an item is needed, estimated from when it was needed before. So activation is
 * computed from *use* — a recall, the user naming it, a tool touching its path, the reply
 * referring to it — and a higher value ranks *higher*.
 *
 * Everything is summed in that log-odds space, the way ACT-R sums it:
 *
 *   need  = B            base level: ln Σ (t − t_j)^−d over creation and every use
 *         + ln(1 + W)    working memory: a leaky integrator over the last few turns
 *         + Σ w_j S_ji   cue: the current message (and the drifting topic), S_ji = S − ln fan_j
 *         + β·P          graph context: personalized PageRank from the cue-matched nodes
 *         + ln(1 + 2s)   salience: surprise at encoding (a failure, a recovery, a correction)
 *         − penalty      contradicted by a later correction (reconsolidation)
 *   score = need + ln(importance)
 *
 * Three signals still stay out of the sum because they answer other questions: coreness
 * explains, degree gates retirement, and `pin` puts a constraint on the card regardless.
 *
 * Cost: one pass over nodes, edges, mentions and the activation log, O(V + E + A), no model
 * call. The log is read only up to the start of the current clock bucket, so a recall in the
 * middle of a turn cannot change the card under the next model call.
 */

const DAY = 86_400_000
const MIN_EDGE_WEIGHT = 0.1
// `supersedes` means "replaced" and `contradicts` means "corrected": neither is an association.
// Letting them carry the walk would make an obsolete claim look central precisely because
// something newer points at it.
export const NON_ASSOCIATIVE = new Set(['supersedes', 'contradicts'])

/** Time quantum for the projection: same bucket, same bytes. */
export const QUANTUM_MS = 5 * 60_000
export const clock = (now = Date.now(), quantum = QUANTUM_MS) => Math.floor(now / quantum) * quantum

/** Tunables, named once. Fitted values (see `bench/replay.mjs --fit`) replace these, not code. */
export const PARAMS = Object.freeze({
  d: 0.5,          // ACT-R decay
  leak: 0.5,       // working-memory retention per turn
  beta: 1.5,       // weight of the graph context term
  inhibition: Math.LN2, // each already-shown node about the same object halves the next one
  contradicted: 1.5,
  pinShare: 0.6,   // pinned lines may take this much of the card before they compete
})

/**
 * ACT-R base-level activation: `B = ln Σ (t - t_j)^-d`, t in days.
 *
 * One parameter, and it produces power-law forgetting, the spacing effect and the frequency
 * effect together. Creation counts as an encoding event, so a node that was never used still
 * has a finite value that decays from birth.
 */
export function activation(times, now = Date.now(), { d = PARAMS.d, floorMs = 60_000 } = {}) {
  if (!times?.length) return -Infinity
  let sum = 0
  for (const at of times) {
    const days = Math.max(floorMs / DAY, (now - Number(at)) / DAY)
    sum += days ** -d
  }
  return sum > 0 ? Math.log(sum) : -Infinity
}

/** ACT-R's recall probability, mapped to [0,1]. Ordinal, not calibrated. */
export function availability(B, { threshold = 0, noise = 0.4 } = {}) {
  if (!Number.isFinite(B)) return 0
  return 1 / (1 + Math.exp(-(B - threshold) / noise))
}

/**
 * k-core decomposition, Batagelj–Zaversnik O(V + E). Explains *why* a node is peripheral; it is
 * not the retirement gate (a star's centre and a leaf both have coreness 1 — degree is).
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

/**
 * The activation log, read incrementally.
 *
 * Keyed by `(MAX(rowid), COUNT(*))`: appends move the rowid, pruning moves the count. Keyed by
 * store instance, so a closed store drops its entry with it. The rows themselves stay the single
 * source of truth — no running summary to drift out of sync.
 */
const ACTIVATIONS = new WeakMap()

function activationLog(store, scope) {
  const stamp = store.db.prepare(
    'SELECT COALESCE(MAX(rowid),0) m, COUNT(*) n FROM activation WHERE scope=?').get(scope)
  const key = `${stamp.m}:${stamp.n}`
  const cached = ACTIVATIONS.get(store)?.get(scope)
  if (cached && cached.key === key) return cached
  const rows = new Map()
  let activations = 0
  for (const row of store.db.prepare('SELECT node, at, turn FROM activation WHERE scope=?').all(scope)) {
    const list = rows.get(row.node)
    const entry = { at: Number(row.at), turn: row.turn == null ? null : Number(row.turn) }
    if (list) list.push(entry)
    else rows.set(row.node, [entry])
    activations++
  }
  const value = { key, rows, activations }
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
    restore: store.db.prepare("UPDATE node SET state='active' WHERE id=? AND state='retired'"),
  }
  PREPARED.set(store, set)
  return set
}

/** Normalise a cue argument: a term list (2.0 callers) or `{ terms, entities }`. */
function cueSources(cues, context) {
  const sources = new Map()
  const add = (key, weight) => { if (key) sources.set(key, (sources.get(key) ?? 0) + weight) }
  if (Array.isArray(cues)) for (const term of cues) add(term, 1)
  else if (cues) {
    for (const term of cues.terms ?? []) add(term, 1)
    // A named path or package says much more about what is needed than a shared bigram.
    for (const entity of cues.entities ?? []) add(entity, 2)
  }
  // The drifting topic of the last few turns (a temporal context model, TCM): weaker than what
  // was just said, but it keeps "what we have been working on" in play across a short question.
  if (context) for (const [term, weight] of context) add(term, 0.5 * weight)
  return sources
}

/**
 * Build the whole read view in one pass.
 *
 * `cues` is the current message; `context` the drifting topic; `turn` the current turn number,
 * for the working-memory term. All optional: without them the view is the base level plus
 * importance and salience, which is still a pure function of (graph, clock bucket).
 */
export function memoryView(store, scope, { now = Date.now(), quantum = QUANTUM_MS, limit = store.maxNodes ?? 500, cues = null, context = null, turn = null, params = PARAMS } = {}) {
  const at = clock(now, quantum)
  const all = store.activeNodes(scope, limit)
  // A lookup written back in the middle of a bucket waits for the next one; a constraint does
  // not — a correction is meant to change the very next call.
  const nodes = all.filter(node => node.kind !== 'reference' || Number(node.created) <= at)
  const empty = { at, byId: new Map(), list: [], q25: 0, maxCore: 0, sizes: { nodes: 0, edges: 0, activations: 0 } }
  if (!nodes.length) return empty

  const sql = statements(store)
  const log = activationLog(store, scope)
  const edges = sql.edge.all(scope)
  const ids = nodes.map(node => node.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const { degree, core } = adjacency(ids, edges)
  const mentions = typeof store.mentions === 'function' ? store.mentions(scope) : new Map()

  // Cue: ACT-R's associative term. Each source j spreads W_j·(S − ln fan_j) to the nodes that
  // contain it; a term every node shares carries no information (fan = N, strength 0).
  const sources = cueSources(cues, context)
  const fan = new Map()
  const featuresOf = node => {
    const own = new Set(node.terms ?? [])
    for (const entity of mentions.get(node.id) ?? []) own.add(entity)
    return own
  }
  const features = nodes.map(featuresOf)
  if (sources.size) for (const set of features) for (const key of set) if (sources.has(key)) fan.set(key, (fan.get(key) ?? 0) + 1)
  const S = Math.log(nodes.length + 1)
  const total = [...sources.values()].reduce((sum, w) => sum + w, 0) || 1
  const cueOf = i => {
    if (!sources.size) return 0
    let sum = 0
    for (const key of features[i]) {
      const weight = sources.get(key)
      if (!weight) continue
      sum += (weight / total) * Math.max(0, S - Math.log(fan.get(key) ?? 1))
    }
    // The sum is over the node's features, so a long claim cannot win by repeating a cue: the
    // normaliser is the cue's total weight, and the result is bounded by S.
    return sum
  }
  const cue = nodes.map((_, i) => cueOf(i))

  // Graph context: what the cue-matched nodes are connected to. Without it, a question about
  // the loader lifts the loader node and nothing that explains it.
  const seeds = []
  cue.forEach((value, i) => { if (value > 0) seeds.push({ id: ids[i], score: value }) })
  const seeded = new Set(seeds.map(seed => seed.id))
  const reach = seeds.length ? propagate(nodes, edges, seeds, { mentions }) : new Map()

  // Contradicted by a live correction: the memory was re-opened and found wrong.
  const contradicted = new Set()
  for (const edge of edges) if (edge.rel === 'contradicts' && index.has(edge.src)) contradicted.add(edge.dst)

  const byId = new Map()
  const scored = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const uses = (log.rows.get(node.id) ?? []).filter(row => row.at <= at)
    const B = activation([Number(node.created), ...uses.map(row => row.at)], at, { d: params.d })
    let W = 0
    if (Number.isInteger(turn)) {
      const turns = [Number.isInteger(node.turn) ? node.turn : null, ...uses.map(row => row.turn)]
      for (const t of turns) if (t != null && t <= turn) W += params.leak ** (turn - t)
    }
    const P = reach.get(node.id) ?? 0
    const salience = Number(node.salience) || 0
    const importance = importanceOf(node)
    const need = (Number.isFinite(B) ? B : -10)
      + Math.log(1 + W)
      + cue[i]
      // A seed already counts through its cue; P is for what the cue reaches, not what it hit.
      + params.beta * (seeded.has(node.id) ? 0 : P)
      + Math.log(1 + 2 * salience)
      - (contradicted.has(node.id) ? params.contradicted : 0)
    const entry = {
      id: node.id, kind: node.kind, claim: node.claim, pin: Boolean(node.pin),
      hits: Number(node.hits) || 0, seq: Number(node.seq) || 0, created: Number(node.created) || 0,
      anchor: node.anchor ?? null,
      A: availability(B), need, score: need + Math.log(importance),
      deg: degree.get(node.id) ?? 0, core: core.get(node.id) ?? 0,
      importance, salience, contradicted: contradicted.has(node.id),
      entities: mentions.get(node.id) ?? [],
      ageDays: (at - Number(node.created)) / DAY,
      cue: cue[i], reach: P,
    }
    byId.set(node.id, entry)
    scored.push(entry)
  }

  const A = scored.map(entry => entry.A).sort((a, b) => a - b)
  const q25 = A.length ? A[Math.floor(A.length * 0.25)] : 0
  const maxCore = scored.reduce((m, entry) => Math.max(m, entry.core), 0)
  return { at, byId, list: scored, q25, maxCore, sizes: { nodes: nodes.length, edges: edges.length, activations: log.activations } }
}

/** Pinned first, then by score; equal scores fall back to the static order's tiebreak. */
export function orderProjection(view) {
  return [...view.list].sort((a, b) =>
    (b.pin ? 1 : 0) - (a.pin ? 1 : 0)
    || b.score - a.score
    || b.created - a.created
    || b.seq - a.seq)
}

/** Order for recall: the query is the cue, so the score already contains it. */
export function rankRecall(view, ids) {
  return [...ids]
    .map(id => view.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
}

/**
 * Spread a query's mass over the association graph (HippoRAG's mechanism at project scale).
 *
 * Edges carry the walk in proportion to weight; `supersedes` and `contradicts` never do. When
 * `mentions` is given, entities act as hub nodes: two claims that never share a rare bigram
 * still meet at the path or package they both name (HippoRAG's phrase nodes, Graphiti's entity
 * nodes). Entities everyone mentions are skipped — they connect everything to everything.
 *
 * `alpha` is the teleport share; three shallow rounds, because at ≤500 nodes a long walk makes
 * everything reachable and the ranking stops discriminating.
 */
export function propagate(nodes, edges, seeds, { alpha = 0.5, iterations = 3, minWeight = MIN_EDGE_WEIGHT, mentions = null, entityWeight = 0.5 } = {}) {
  const rank = new Map()
  if (!nodes.length || !seeds.length) return rank
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  let n = nodes.length
  const out = Array.from({ length: n }, () => [])
  for (const edge of edges) {
    if (NON_ASSOCIATIVE.has(edge.rel)) continue
    if ((edge.w ?? 1) < minWeight) continue
    const a = index.get(edge.src)
    const b = index.get(edge.dst)
    if (a == null || b == null || a === b) continue
    // Undirected: a seed lifts what points at it as well as what it points at.
    out[a].push({ to: b, w: edge.w })
    out[b].push({ to: a, w: edge.w })
  }
  if (mentions?.size) {
    const holders = new Map()
    for (const node of nodes) for (const entity of mentions.get(node.id) ?? []) {
      const list = holders.get(entity)
      if (list) list.push(index.get(node.id))
      else holders.set(entity, [index.get(node.id)])
    }
    const maxFan = Math.max(3, Math.floor(nodes.length * 0.2))
    for (const list of holders.values()) {
      if (list.length < 2 || list.length > maxFan) continue
      const hub = n++
      out.push([])
      for (const i of list) { out[i].push({ to: hub, w: entityWeight }); out[hub].push({ to: i, w: entityWeight }) }
    }
  }

  const prefer = new Float64Array(n)
  let seeded = 0
  for (const seed of seeds) {
    const i = index.get(seed?.id ?? seed)
    if (i == null) continue
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

  let peak = 0
  for (let i = 0; i < nodes.length; i++) peak = Math.max(peak, mass[i])
  if (!(peak > 0)) return rank
  for (let i = 0; i < nodes.length; i++) if (mass[i] > 0) rank.set(nodes[i].id, mass[i] / peak)
  return rank
}

/**
 * What may be retired: old, never used, unconnected, unimportant — all four at once. Any single
 * condition retires something load-bearing (a hub, a fresh constraint, a node created seconds
 * ago, an edge-less decision). Retirement hides; recall still reads retired rows.
 */
export function periphery(view, { degFloor = 1, minAgeDays = 7, maxImportance = 3 } = {}) {
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
 * Restore a retired node. Only retirement is undone: a node that a later claim superseded stays
 * superseded, because restoring visibility must not resurrect an instruction the user replaced.
 */
export function restore(store, ids) {
  const stmt = statements(store).restore
  const out = []
  for (const id of ids) if (stmt.run(id).changes) out.push(id)
  return out
}

const LABELS = { constraint: '约束', decision: '决策', artifact: '产物', progress: '进度', reference: '索引' }

/** Artifacts in one directory share a card line: `src/area1/ 下 a.js、b.js 已写入`. */
const artifactPath = entry => entry.kind === 'artifact' && typeof entry.anchor === 'string' && entry.anchor.startsWith('file:')
  ? entry.anchor.slice(5) : null
const dirOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''

/** What a node is about, for inhibition: its instance entities, or its directory for artifacts. */
function topicsOf(entry) {
  const path = artifactPath(entry)
  if (path) return [`dir:${dirOf(path)}`]
  return (entry.entities ?? []).filter(entity => /[\d/.]/.test(entity)).slice(0, 4)
}

/**
 * Choose the card: greedy by score under a byte budget, with lateral inhibition.
 *
 * k-winners-take-all with inhibition between competitors about the same object: every node
 * already chosen for a topic lowers the next one on that topic by `inhibition` (a halving in
 * odds). Without it a session that wrote twenty files fills the card with twenty "已写入"
 * lines and nothing else. Pinned lines go first up to `pinShare` of the budget, then compete
 * like constraints — an unbounded pin set was how a few long corrections ate the whole card.
 */
export function selectCard(view, { budget = 600, labels = LABELS, params = PARAMS } = {}) {
  const lines = []         // { kind, text } or { kind: 'artifact', dir, names: [] }
  const groups = new Map() // dir -> line
  const seen = new Set()
  const chosen = []
  let spent = Buffer.byteLength('[骨架]')
  // The exact byte change the line makes to the card: a second member turns a plain-path line
  // into the grouped form, so the price is the difference between the two renderings.
  const priceOf = entry => {
    const path = artifactPath(entry)
    const dir = path ? dirOf(path) : ''
    if (path && dir) {
      const group = groups.get(dir)
      const name = path.slice(dir.length)
      if (group) return Buffer.byteLength(renderLine({ ...group, names: [...group.names, name] }, labels)) - Buffer.byteLength(renderLine(group, labels))
      return Buffer.byteLength(renderLine({ kind: 'artifact', dir, names: [name] }, labels)) + 1
    }
    return Buffer.byteLength(`- ${labels[entry.kind] ?? entry.kind}: ${entry.claim}`) + 1
  }
  const take = entry => {
    const path = artifactPath(entry)
    const dir = path ? dirOf(path) : ''
    if (path && dir) {
      const group = groups.get(dir)
      if (group) group.names.push(path.slice(dir.length))
      else { const line = { kind: 'artifact', dir, names: [path.slice(dir.length)] }; groups.set(dir, line); lines.push(line) }
    } else lines.push({ kind: entry.kind, text: entry.claim })
    seen.add(entry.claim)
    chosen.push(entry)
  }

  const ordered = orderProjection(view)
  const pins = ordered.filter(entry => entry.pin)
  const pinBudget = Math.floor(budget * params.pinShare)
  const rest = []
  for (const entry of pins) {
    if (seen.has(entry.claim)) continue
    const price = priceOf(entry)
    if (spent + price <= pinBudget) { take(entry); spent += price }
    // Over the pin share, a pin competes as an ordinary constraint.
    else rest.push({ ...entry, score: entry.need + Math.log(12) })
  }
  rest.push(...ordered.filter(entry => !entry.pin))

  const load = new Map()
  const remaining = rest.filter(entry => !seen.has(entry.claim))
  while (remaining.length) {
    let best = -1
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const entry = remaining[i]
      if (spent + priceOf(entry) > budget) continue
      let effective = entry.score
      for (const topic of topicsOf(entry)) effective -= params.inhibition * (load.get(topic) ?? 0)
      if (effective > bestScore) { bestScore = effective; best = i }
    }
    if (best < 0) break
    const [entry] = remaining.splice(best, 1)
    if (seen.has(entry.claim)) continue
    spent += priceOf(entry)
    take(entry)
    for (const topic of topicsOf(entry)) load.set(topic, (load.get(topic) ?? 0) + 1)
  }
  return { lines, chosen, spent }
}

/** Plain-text card, byte-budgeted, same contract as `skeleton.project`. */
export function render(view, { budget = 600, labels = LABELS, params = PARAMS } = {}) {
  const { lines } = selectCard(view, { budget, labels, params })
  if (!lines.length) return ''
  return ['[骨架]', ...lines.map(line => renderLine(line, labels))].join('\n')
}

/** One card line. A one-member artifact group reads as its plain path. */
function renderLine(line, labels = LABELS) {
  // Single-line by construction: the card is a system prompt, so a newline in a claim
  // would render as a second line that is indistinguishable from a real entry.
  if (!(line.kind === 'artifact' && line.names)) return `- ${labels[line.kind] ?? line.kind}: ${oneLine(line.text)}`
  const dir = oneLine(line.dir)
  const names = line.names.map(oneLine)
  return names.length === 1
    ? `- ${labels.artifact}: ${dir}${names[0]} 已写入`
    : `- ${labels.artifact}: ${dir} 下 ${names.join('、')} 已写入`
}

/** Ledger line for `/mem dynamics`: what the read path currently believes, and why. */
export function explain(view, ids, { limit = 12 } = {}) {
  return [...ids].slice(0, limit).map(id => {
    const entry = view.byId.get(id)
    if (!entry) return { id, missing: true }
    return {
      id, kind: entry.kind, A: Number(entry.A.toFixed(3)),
      need: Number(entry.need.toFixed(2)), score: Number(entry.score.toFixed(2)),
      cue: Number(entry.cue.toFixed(2)), reach: Number(entry.reach.toFixed(2)),
      deg: entry.deg, core: entry.core,
      importance: entry.importance, salience: entry.salience, hits: entry.hits,
      ageDays: Number(entry.ageDays.toFixed(1)),
      fate: entry.pin ? 'pinned' : entry.contradicted ? 'contradicted' : entry.A <= view.q25 ? 'periphery' : 'active',
    }
  })
}
