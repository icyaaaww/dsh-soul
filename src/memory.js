import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { bounded, hash, terms as termSet } from './util.js'
import { extract, normalize, project } from './skeleton.js'

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
  if (!blocks.length) return { nodes: 0, edges: 0 }
  const { nodes, edges } = extract(blocks, { scope, hashOf })
  if (!nodes.length) return { nodes: 0, edges: 0 }
  store.recordNodes(scope, { nodes, edges })
  const related = linkSemantically(store, scope, nodes)
  return { nodes: nodes.length, edges: edges.length + related }
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

/** The per-turn card. Empty until the graph has something worth saying, so it costs nothing. */
export function projectionText(store, scope, budget = 600, { sessionId = null } = {}) {
  const nodes = store.activeNodes(scope, 200)
  if (!nodes.length) return ''
  // Say how far back the index actually reaches. A silent boundary is worse than a short one:
  // "查不到" would be indistinguishable from "不存在".
  const coverage = store.spanCoverage(scope)
  const line = coverage.spans
    ? `[索引] ${coverage.spans} 条可检索（seq ${coverage.from}–${coverage.to}${coverage.sessions > 1 ? `，跨 ${coverage.sessions} 个会话` : ""}；用 soul_recall_session）`
    : ''
  // Only from a *previous* session: inside the same session the card already carries the work.
  const handoff = handoffFor(store, scope)
  const previous = handoff && sessionId && handoff.session !== sessionId
    ? `[上次会话 ${new Date(handoff.at).toISOString().slice(0, 10)}] ${handoff.claim}`
    : ''
  // Do not say the same sentence twice: the handoff line already carries it.
  const body = previous ? nodes.filter(node => node.claim !== handoff.claim) : nodes
  const room = Math.max(160, budget - Buffer.byteLength(line) - Buffer.byteLength(previous) - 2)
  const card = body.length ? project(body, { budget: room }) : ''
  return [previous, card, line].filter(Boolean).join('\n')
}

/** One hop out from the best lexical matches. Lexical on purpose: it stays auditable. */
export function recall(store, scope, query, { limit = 8 } = {}) {
  const queryTerms = termSet(query)
  const hits = store.searchNodes(scope, queryTerms, limit)
  const neighbours = store.neighbours(scope, hits.map(node => node.id))
  for (const node of hits) store.activate(scope, { node: node.id, query: String(query ?? '') })
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
  return {
    query: String(query ?? ''),
    hits: hits.map(view),
    neighbours: neighbours
      .map(node => ({ ...view(node), strength: strengthOf(store, scope, node.id, hits) }))
      .sort((a, b) => b.strength - a.strength || b.weight - a.weight),
    links: pairs.length,
  }
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

/** "Sleep": decay unused associations so the graph forgets instead of accreting noise. */
export function consolidate(store, scope, options) {
  const removed = store.decayEdges(scope, options)
  return { pruned: removed, ...store.graphStats(scope) }
}

export const view = node => ({
  id: node.id, kind: node.kind, claim: node.claim, anchor: node.anchor ?? null,
  pin: Boolean(node.pin), weight: Number(node.weight) || 1, hits: Number(node.hits) || 0,
  state: node.state,
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
