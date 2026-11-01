import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { bounded, hash, terms as termSet } from './util.js'
import { extract, identifierTerms, normalize, project } from './skeleton.js'
import { memoryView, propagate, render } from './graph-memory.js'
import { promoteUncovered } from './consolidation.js'

/**
 * Session-side memory: buffer raw surface events, then compile them into nodes at turn end.
 *
 * The buffer holds events, not blocks, so exactly one normalizer (`skeleton.normalize`) decides
 * what a block is. Two normalizers would drift, and the drift would show up as silently
 * missing constraints rather than as an error.
 */

export class MemoryBuffer {
  constructor({ maxEvents = 800 } = {}) {
    this.maxEvents = maxEvents
    this.sessions = new Map()
  }

  push(sessionId, event) {
    if (!sessionId || !event) return
    const entry = this.sessions.get(sessionId) ?? { seq: 0, events: [] }
    entry.events.push({ ...event, seq: entry.seq++ })
    if (entry.events.length > this.maxEvents) entry.events.splice(0, entry.events.length - this.maxEvents)
    this.sessions.set(sessionId, entry)
  }

  /** Drain the buffer: a turn is compiled once, then forgotten, so a crash costs one turn. */
  take(sessionId) {
    const entry = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    return entry?.events ?? []
  }

  peek(sessionId) { return this.sessions.get(sessionId)?.events ?? [] }
  clear(sessionId) { this.sessions.delete(sessionId) }
  get size() { return this.sessions.size }
}

/**
 * Compile one turn's events into the graph. Free: no model call, no prompt bytes.
 * `hashOf(path)` lets artifact nodes remember the content they were written with, which is
 * what later makes "this evidence is stale" decidable instead of a guess.
 */
export function capture(store, scope, events, { hashOf = null } = {}) {
  const blocks = normalize(events)
  if (!blocks.length) return { nodes: 0, edges: 0, superseded: 0 }
  const extracted = extract(blocks, { scope, hashOf })
  // Repeated human instructions reinforce one live node. Retired/invalidated nodes must
  // retain their history, and artifact identities remain temporal.
  const live = store.db.prepare("SELECT id, claim FROM node WHERE scope=? AND kind='constraint' AND state='active' AND valid_to IS NULL").all(scope)
  const byClaim = new Map(live.map(row => [row.claim, row.id]))
  const unique = new Map()
  for (const node of extracted.nodes) {
    if (node.kind === 'constraint') {
      node.id = byClaim.get(node.claim) ?? node.id
      byClaim.set(node.claim, node.id)
    }
    unique.set(node.id, node)
  }
  const nodes = [...unique.values()]
  const edges = extracted.edges
  if (!nodes.length) return { nodes: 0, edges: 0, superseded: 0 }
  // Close the validity interval of whatever these claims replace *before* writing, so the old
  // row is already out of the card by the time the new one is projected in the same turn.
  edges.push(...supersedeConflicts(store, scope, nodes))
  store.recordNodes(scope, { nodes, edges })
  const related = linkSemantically(store, scope, nodes)
  return { nodes: nodes.length, edges: edges.length + related, superseded: edges.filter(e => e.rel === 'supersedes').length }
}

/**
 * A claim that replaces an older claim about the same object.
 *
 * This is the two-timeline half of the graph (Zep / Graphiti's invalidation): a fact is not
 * deleted when it stops being true, it gets a `valid_to`. The failure this fixes is concrete —
 * the user says "必须用 npm", later says "改用 pnpm", and without this both lines are `pin=1`
 * and the card shows two contradictory standing instructions for the rest of the project.
 *
 * Conservative on purpose. Supersession requires BOTH:
 *   1. the new claim says it replaces something (改成 / 不再 / instead of …), and
 *   2. the two claims are about the same object — a shared identifier (path, flag, package
 *      name), or at least two shared rare terms.
 * Without (1) every new constraint would retire every earlier one that mentions a common file;
 * without (2) a rewrite of one instruction would retire an unrelated one that shares a word.
 * A false supersession hides a live constraint, which is worse than showing a stale one, so
 * when in doubt this does nothing.
 */
const REPLACES = /(?:改成|改用|换成|换成|不再|不用|改掉|作废|废弃|取代|替换|而不是|替换为|instead|switch(?:ed)? to|no longer|replace)/i

export function supersedeConflicts(store, scope, nodes, { now = Date.now() } = {}) {
  const candidates = nodes.filter(node => !node.pin || node.kind === 'constraint')
  if (!candidates.length) return []
  const existing = store.activeNodes(scope, 400)
  if (!existing.length) return []

  const frequency = new Map()
  for (const other of existing) for (const term of other.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const rareFloor = Math.max(2, Math.round(existing.length * 0.15))
  const rare = term => (frequency.get(term) ?? 1) <= rareFloor

  const edges = []
  const closed = new Set()
  for (const node of candidates) {
    if (!REPLACES.test(String(node.claim ?? ''))) continue
    const ids = identifierTerms(node.claim)
    const own = new Set(termSet(node.claim))
    for (const other of existing) {
      // Same kind only: a decision never invalidates a constraint, and a progress line never
      // invalidates anything — it is a note about what happened, not a statement of policy.
      if (other.id === node.id || other.kind !== node.kind) continue
      if (other.kind !== 'constraint' && other.kind !== 'decision') continue
      if (closed.has(other.id) || other.valid_to !== null) continue
      const sameObject = [...ids].some(id => identifierTerms(other.claim).has(id))
        || [...own].filter(term => rare(term) && other.terms.includes(term)).length >= 2
      if (!sameObject) continue
      closed.add(other.id)
      edges.push({ src: node.id, dst: other.id, rel: 'supersedes', w: 1 })
    }
  }
  // Validity is closed after the edge list is complete: one write, one transaction.
  for (const id of closed) store.supersede(id, now)
  return edges
}

/**
 * A correction is the strongest memory signal a session produces.
 *
 * Extraction only turns a user message into a constraint when it matches a standing-instruction
 * pattern. "不对，是 pnpm" and "把我刚写的那个改回去" match nothing — they correct past work and
 * are phrased as reactions, so the one thing the user bothered to correct is the one thing that
 * never reaches the card. The correction detector in `observe.js` already finds them for the
 * evolution pool; this writes the same event into the memory graph, where it can actually be
 * re-read on a later turn.
 *
 * Pinned like a constraint, because that is what it is: a statement about what must be true,
 * made by the only authority in the session. Marked `source: 'correction'` so a card line can
 * be traced back to the sentence that caused it.
 */
export function recordCorrection(store, scope, { text, intent = '', seq = 0 } = {}, { now = Date.now() } = {}) {
  const statement = bounded(String(text ?? '').trim(), 200)
  // A bare "不对" corrects nothing usable on its own: it says the last answer was wrong without
  // saying what is right, and pinning it would put a contentless line on every future card.
  if (statement.length < 6) return null
  const before = bounded(String(intent ?? '').trim(), 120)
  const claim = before ? `纠正（针对「${before}」）：${statement}` : `纠正：${statement}`
  const node = {
    id: hash([scope, "correction", statement].join("\u0000")).slice(0, 16),
    kind: 'constraint', claim: bounded(claim, 400), seq, pin: 1, source: 'correction',
  }
  store.recordNodes(scope, { nodes: [node] })
  return node.id
}

/**
 * Connect new knowledge to old knowledge by shared terms.
 *
 * This is the passive half of the graph: no judgement, just "these two talk about the same
 * things". The active half is co-activation at recall time, which is what makes weights move.
 */
function linkSemantically(store, scope, nodes) {
  const existing = store.activeNodes(scope, 400)
  if (existing.length < 2) return 0
  // Jaccard over whole claims never fires on real text: two notes about the same file share
  // three terms out of eighty. What matters is sharing a *rare* term — a path, a symbol, an
  // error code — so weight rarity, not overall overlap.
  const frequency = new Map()
  for (const other of existing) for (const term of other.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const rareFloor = Math.max(2, Math.round(existing.length * 0.15))
  const rare = term => (frequency.get(term) ?? 1) <= rareFloor

  let linked = 0
  for (const node of nodes) {
    const own = new Set(termSet(node.claim))
    if (own.size < 2) continue
    const scored = []
    for (const other of existing) {
      if (other.id === node.id) continue
      const theirs = new Set(other.terms)
      let shared = 0
      for (const term of own) if (theirs.has(term) && rare(term)) shared++
      if (shared < 2) continue
      scored.push({ other, score: shared, rarity: shared / Math.max(2, Math.min(own.size, theirs.size)) })
    }
    scored.sort((a, b) => b.score - a.score || a.other.id.localeCompare(b.other.id))
    for (const { other, score, rarity } of scored.slice(0, 3)) {
      const [src, dst] = node.id < other.id ? [node.id, other.id] : [other.id, node.id]
      store.link(scope, { src, dst, rel: 'related', mode: 'max', cap: 1, delta: Math.round((0.2 + score * 0.15) * 100) / 100 })
      linked++
    }
  }
  return linked
}

/**
 * Record where a session left off.
 *
 * A cross-session index is useless without an entry point: the model has to know that a
 * previous session exists and what it was about before it thinks to search. One line in the
 * card turns "there is an index" into "here is what to look for".
 */
export function recordHandoff(store, scope, sessionId, claim, at = Date.now()) {
  const text = bounded(String(claim ?? '').trim(), 120)
  if (!text) return null
  store.writeMeta(`handoff:${scope}`, JSON.stringify({ claim: text, session: String(sessionId), at }))
  return text
}

export function handoffFor(store, scope) {
  const raw = store.readMeta(`handoff:${scope}`)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/**
 * The per-turn card. Empty until the graph has something worth saying, so it costs nothing.
 *
 * Two orderings, one switch. `dynamics: false` keeps the 1.5 behaviour — pinned, then kind, then
 * newest. `dynamics: true` routes through `graph-memory`, where the card is a review schedule:
 * a memory that was shown last turn has high activation and yields to one that was not. The
 * switch exists because a scheduling policy that cannot be turned off in one line is not a
 * policy, it is a rewrite.
 *
 * `now` is threaded through so the card is a pure function of (graph, clock bucket): every call
 * inside one five-minute bucket must produce identical bytes, or the prompt cache prefix breaks.
 */
export function projectionText(store, scope, budget = 600, { sessionId = null, dynamics = false, promote = false, now = undefined, cues = null } = {}) {
  const nodes = dynamics ? null : store.activeNodes(scope, 200)
  const view = dynamics ? memoryView(store, scope, { now: now ?? Date.now(), cues }) : null
  if (dynamics ? !view.list.length : !nodes.length) return ''
  // Say how far back the index actually reaches. A silent boundary is worse than a short one:
  // "查不到" would be indistinguishable from "不存在".
  const coverage = store.spanCoverage(scope)
  const line = coverage.spans
    ? `[索引] ${coverage.spans} 条可检索（seq ${coverage.from}–${coverage.to}${coverage.sessions > 1 ? `，跨 ${coverage.sessions} 个会话` : ""}；用 soul_recall）`
    : ''
  // Only from a *previous* session: inside the same session the card already carries the work.
  const handoff = handoffFor(store, scope)
  const previous = handoff && sessionId && handoff.session !== sessionId
    ? `[上次会话 ${new Date(handoff.at).toISOString().slice(0, 10)}] ${handoff.claim}`
    : ''
  // Do not say the same sentence twice: the handoff line already carries it.
  const room = Math.max(160, budget - Buffer.byteLength(line) - Buffer.byteLength(previous) - 2)
  let card = ''
  if (dynamics) {
    // Shallow view with the handoff claim removed: `render` only reads `.list`, and the same
    // sentence must not appear twice in one card.
    card = render({ ...view, list: view.list.filter(entry => entry.claim !== handoff?.claim) }, { budget: room })
  } else {
    const body = previous ? nodes.filter(node => node.claim !== handoff.claim) : nodes
    // `referenceLast` only when a feature that manufactures reference nodes is on. Off by
    // default so an upgrade without config changes renders the same bytes as 1.5.
    card = body.length ? project(body, { budget: room, referenceLast: dynamics || promote }) : ''
  }
  return [previous, card, line].filter(Boolean).join('\n')
}

/**
 * Close the coverage gap left by extraction, at the end of a turn.
 *
 * Extraction is deliberately narrow: it turns tool calls and user corrections into constraints,
 * decisions, artifacts and progress, and nothing else. That is why it is cheap and why it is
 * trustworthy. The cost is that an environment fact — an error code, a version, a path that only
 * ever appeared inside a tool result — never becomes a node at all. `SKELETON-BENCH` measured
 * exactly this: nine of eleven memory items are extractable, and the two ambient ones score
 * 17.7% and 0%.
 *
 * A node is findable by *term*. A shadowed span is findable only by guessing the words. So for
 * those two items, writing a reference node is the difference between a lookup and a coin flip —
 * and it costs the checkpoint zero bytes, because the card is unchanged.
 *
 * Runs after `capture`, never before: extraction gets its turn first, and promotion only sees
 * what it left uncovered.
 */
export function promoteTurn(store, scope, events, { max = 2, now = Date.now() } = {}) {
  const blocks = normalize(events)
  if (!blocks.length) return []
  return promoteUncovered(store, scope, blocks, { max, now })
}

/**
 * One hop out from the best lexical matches. Lexical on purpose: it stays auditable.
 *
 * `dynamicsView` is optional. Ranking has two jobs that are not the same one: edge strength says
 * "this is one hop from what you asked about", activation says "you could still produce this".
 * A strongly linked neighbour that nobody has recalled in a month is a worse answer than a
 * weaker link you can actually use, so when the dynamics layer is present it orders and edge
 * strength breaks ties. Without it, behaviour is exactly as before.
 */
export function recall(store, scope, query, { limit = 8, dynamicsView = null, spread = true } = {}) {
  const queryTerms = termSet(query)
  // Superseded nodes are searched too. "This was replaced by X" is an answer, and it is a
  // better answer than silence — a model told nothing will re-derive the stale fact.
  const hits = store.searchNodes(scope, queryTerms, limit, { includeSuperseded: true })
  const neighbours = store.neighbours(scope, hits.map(row => row.id))
  for (const row of hits) store.activate(scope, { node: row.id, query: String(query ?? '') })
  // Fire together, wire together: what one retrieval pulls in becomes a candidate association
  // for the next one. The weight is small on purpose — a single co-occurrence is a hint.
  const pairs = []
  for (const hit of hits) {
    for (const near of neighbours.slice(0, 6)) {
      if (hit.id === near.id) continue
      const [src, dst] = hit.id < near.id ? [hit.id, near.id] : [near.id, hit.id]
      if (pairs.length < 24) pairs.push({ src, dst })
    }
  }
  for (const pair of pairs) store.link(scope, { ...pair, rel: 'coactivated', delta: 0.1 })

  // Multi-hop spread over the whole project graph. Lexical hits seed it; every node with a
  // reachable share of the mass competes for the result, so "the constraint two hops away"
  // surfaces without the query having to name it.
  const spreadRank = spread ? spreadFrom(store, scope, hits) : new Map()
  const extra = spread ? transitive(store, scope, hits, spreadRank, limit) : []

  const quality = row => {
    if (!dynamicsView) return 0
    const entry = dynamicsView.byId.get(row.id)
    return entry ? entry.A * (1 + entry.importance / 12) : 0
  }
  const ordered = [...neighbours, ...extra].sort((a, b) => {
    const delta = quality(b) - quality(a)
    if (!dynamicsView || Math.abs(delta) > 1e-9) return delta
    const sa = strengthOf(store, scope, a.id, hits)
    const sb = strengthOf(store, scope, b.id, hits)
    return sb - sa || (spreadRank.get(b.id) ?? 0) - (spreadRank.get(a.id) ?? 0) || b.weight - a.weight
  })
  return {
    query: String(query ?? ''),
    hits: hits.map(row => (dynamicsView ? withActivation(dynamicsView, row) : view(row))),
    neighbours: ordered.map(row => ({ ...view(row), strength: strengthOf(store, scope, row.id, hits),
      ...(spreadRank.has(row.id) ? { reach: Number(spreadRank.get(row.id).toFixed(3)) } : {}) })),
    links: pairs.length,
    spread: spreadRank.size,
  }
}

/** Rank the whole project graph from the lexical hits, or nothing when there is no graph. */
function spreadFrom(store, scope, hits) {
  if (!hits.length) return new Map()
  const nodes = store.activeNodes(scope, 500, { includeSuperseded: true })
  if (nodes.length < 3) return new Map()
  const edges = store.edgeWeights(scope)
  if (!edges.length) return new Map()
  return propagate(nodes, edges, hits)
}

/**
 * Nodes the walk reached that one hop did not.
 *
 * The cut is deliberately low (0.05 of the peak) and the real filter is the top-k slice below:
 * on a three-node chain a two-hop node scores 0.11, so any absolute cut tuned on a large graph
 * silently drops the far hop on a small one. Noise suppression is the job of the ranking, and
 * a candidate set the caller re-ranks cannot over-rank anything by being generous.
 */
function transitive(store, scope, hits, rank, limit) {
  if (!rank.size) return []
  const hitIds = new Set(hits.map(row => row.id))
  const direct = new Set(store.neighbours(scope, hits.map(row => row.id)).map(row => row.id))
  return [...rank.entries()]
    .filter(([id, share]) => share >= 0.05 && !hitIds.has(id) && !direct.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 2)
    .map(([id]) => store.nodeRow(id))
    .filter(Boolean)
}

/** Node view plus the numbers the read path used, so the ranking is inspectable. */
function withActivation(dynamicsView, row) {
  const entry = dynamicsView.byId.get(row.id)
  return entry
    ? { ...view(row), A: Number(entry.A.toFixed(3)), deg: entry.deg, core: entry.core }
    : view(row)
}

/** How strongly a node is tied to what was just retrieved. */
function strengthOf(store, scope, id, hits) {
  const rows = store.edgesOf(scope, id)
  let best = 0
  for (const row of rows) {
    const other = row.src === id ? row.dst : row.src
    if (hits.some(hit => hit.id === other)) best = Math.max(best, row.w)
  }
  return Math.round(best * 100) / 100
}

/**
 * Write a lookup back as a pointer.
 *
 * A retrieval that succeeded once will be needed again; recording it turns the second question
 * into a card hit instead of another scan. The node is a pointer, not a claim — it says where
 * to look, not what is true there.
 */
export function recordLookup(store, scope, query, spans) {
  const q = String(query ?? '').trim()
  if (!q || !Array.isArray(spans) || !spans.length) return null
  const first = spans[0]
  const id = hash(`${scope}\u0000lookup\u0000${q.toLowerCase()}`).slice(0, 16)
  store.recordNodes(scope, { nodes: [{
    id, kind: 'reference', claim: `常用检索：${bounded(q, 40)}`,
    anchor: `seq:${first.seq}`, seq: first.seq,
  }] })
  return id
}

/** The neighbourhood of one node, ranked by edge weight. */
export function neighbourhood(store, scope, id, { limit = 8 } = {}) {
  const seen = new Set()
  const out = []
  for (const row of store.edgesOf(scope, id)) {
    const other = row.src === id ? row.dst : row.src
    if (seen.has(other)) continue
    const node = store.nodeRow(other)
    if (!node) continue
    seen.add(other)
    out.push({ ...view(node), rel: row.rel, strength: Math.round(row.w * 100) / 100 })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Fold duplicate nodes into one.
 *
 * Extraction is deterministic, so the same sentence about the same file produces the same node
 * id and `recordNodes` only raises its support — no duplicate there. The duplicates come from
 * the other three writers: `recordLookup` hashes the query, `promoteTurn` hashes the claim, and
 * corrections hash the statement. Each hashes a slightly different string, so the same fact
 * recorded through two paths becomes two rows that say the same thing. On a card that is a
 * wasted line; in the graph it is two half-connected copies of one memory, so neither ever
 * accumulates the edges that make it central.
 *
 * Only exact claims merge, and only within a kind. Near-duplicates need a similarity threshold,
 * and a threshold tuned on this corpus would merge two constraints that differ by one word —
 * which is the difference between "use pnpm" and "do not use pnpm". Merging what is provably
 * identical is a win; guessing is not.
 *
 * The survivor is the better-connected one, ties broken by support, hits, then age. Edges of the
 * absorbed node are re-pointed, its support is added, and it is retired rather than deleted:
 * `restore` can still bring it back, and `soul_recall` still finds it.
 */
export function mergeDuplicates(store, scope, { limit = 500 } = {}) {
  const nodes = store.activeNodes(scope, limit)
  const groups = new Map()
  for (const node of nodes) {
    const key = node.kind + '\u0000' + String(node.claim ?? '').trim()
    const list = groups.get(key)
    if (list) list.push(node)
    else groups.set(key, [node])
  }

  const merged = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const ranked = [...list].sort((a, b) =>
      store.edgesOf(scope, b.id).length - store.edgesOf(scope, a.id).length
      || Number(b.support) - Number(a.support)
      || Number(b.hits) - Number(a.hits)
      || Number(a.created) - Number(b.created))
    const keep = ranked[0]
    for (const node of ranked.slice(1)) {
      for (const edge of store.edgesOf(scope, node.id)) {
        const src = edge.src === node.id ? keep.id : edge.src
        const dst = edge.dst === node.id ? keep.id : edge.dst
        if (src === dst) continue
        store.link(scope, { src, dst, rel: edge.rel, mode: 'max', cap: 5, delta: Number(edge.w) })
      }
      store.tx(() => {
        store.db.prepare('UPDATE node SET support=support+?, hits=hits+? WHERE id=?')
          .run(Number(node.support) || 1, Number(node.hits) || 0, keep.id)
        store.db.prepare("UPDATE node SET state='retired' WHERE id=?").run(node.id)
      })
      merged.push({ id: node.id, into: keep.id, claim: keep.claim })
    }
  }
  // Re-pointing replaced the edges inside each group; this clears any that still name a node
  // that no longer exists.
  store.db.prepare('DELETE FROM edge WHERE scope=? AND (src NOT IN (SELECT id FROM node WHERE scope=?) OR dst NOT IN (SELECT id FROM node WHERE scope=?))')
    .run(scope, scope, scope)
  return merged
}

/** "Sleep": decay unused associations so the graph forgets instead of accreting noise. */
export function consolidate(store, scope, options) {
  const removed = store.decayEdges(scope, options)
  return { pruned: removed, ...store.graphStats(scope) }
}

export const view = node => ({
  id: node.id, kind: node.kind, claim: node.claim, anchor: node.anchor ?? null,
  pin: Boolean(node.pin), weight: Number(node.weight) || 1, hits: Number(node.hits) || 0,
  state: node.state,
  // `valid_to` is set when a later claim replaced this one. Recall says so explicitly, because
  // a stale fact returned as current is worse than a stale fact returned as stale.
  ...(node.valid_to ? { supersededAt: Number(node.valid_to) } : {}),
})

/**
 * Content fingerprint of a project file, or null when it cannot be read safely.
 * Bounded on purpose: an artifact node must never make a turn read a 200 MB file.
 */
export function fileFingerprint(cwd, path) {
  try {
    const root = resolve(cwd)
    const full = resolve(root, String(path ?? ''))
    if (full !== root && !full.startsWith(root + sep)) return null
    const stat = statSync(full)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null
    return hash(readFileSync(full))
  } catch { return null }
}
