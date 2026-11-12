import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { bounded, oneLine, hash, terms as termSet, entities as entitySet, isInstance, NODE_TERMS } from './util.js'
import { extract, normalize, project } from './skeleton.js'
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

  /**
   * Buffer one event. Its `seq` is the host's event seq when known — the one coordinate that
   * node anchors, the span index and `soul_expand` share — and -1 otherwise. A buffer-local
   * counter used to stand in for it; it restarted every turn, so every turn's nodes claimed
   * seq 0, 1, 2… and anything keyed by seq (promotion, compaction weighting, anchors) collided.
   */
  push(sessionId, event) {
    if (!sessionId || !event) return
    const entry = this.sessions.get(sessionId) ?? { events: [] }
    entry.events.push({ ...event, seq: Number.isInteger(event.seq) && event.seq >= 0 ? event.seq : -1 })
    if (entry.events.length > this.maxEvents) entry.events.splice(0, entry.events.length - this.maxEvents)
    this.sessions.set(sessionId, entry)
  }

  /** Give the newest unsettled buffered event that matches its host seq. Returns true on a match. */
  settle(sessionId, matches, seq) {
    const events = this.sessions.get(sessionId)?.events ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].seq === -1 && matches(events[i])) { events[i].seq = seq; return true }
    }
    return false
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

const currentTurn = (store, scope) => Number(store.readMeta(`turns:${scope}`) ?? 0)

/**
 * Compile one turn's events into the graph. Free: no model call, no prompt bytes.
 * `hashOf(path)` lets artifact nodes remember the content they were written with, which is
 * what later makes "this evidence is stale" decidable instead of a guess.
 */
export function capture(store, scope, events, { hashOf = null, session = null, turn = currentTurn(store, scope), temporal = true } = {}) {
  const blocks = normalize(events)
  if (!blocks.length) return { nodes: 0, edges: 0, superseded: 0 }
  const extracted = extract(blocks, { scope, hashOf, session })
  // Repeated human instructions reinforce one live node. Retired/invalidated nodes must
  // retain their history, and artifact identities remain temporal.
  const live = store.db.prepare("SELECT id, claim FROM node WHERE scope=? AND kind='constraint' AND state='active' AND valid_to IS NULL").all(scope)
  const byClaim = new Map(live.map(row => [row.claim, row.id]))
  // A correction was already recorded at pre-step; when extraction finds the same sentence as an
  // instruction, it reinforces that node instead of pinning a second copy.
  const corrections = store.db.prepare("SELECT id, claim FROM node WHERE scope=? AND source='correction' AND state='active' AND valid_to IS NULL").all(scope)
  const unique = new Map()
  for (const node of extracted.nodes) {
    if (node.kind === 'constraint') {
      node.id = byClaim.get(node.claim) ?? corrections.find(row => row.claim.endsWith(`：${node.claim}`) || row.claim.includes(`：${node.claim}`))?.id ?? node.id
      byClaim.set(node.claim, node.id)
    }
    node.turn = turn
    unique.set(node.id, node)
  }
  const nodes = [...unique.values()]
  const edges = extracted.edges
  if (!nodes.length) return { nodes: 0, edges: 0, superseded: 0 }
  noveltySalience(store, scope, nodes)
  // Close the validity interval of whatever these claims replace *before* writing, so the old
  // row is already out of the card by the time the new one is projected in the same turn.
  edges.push(...supersedeConflicts(store, scope, nodes))
  edges.push(...supersedeArtifacts(store, scope, nodes))
  store.recordNodes(scope, { nodes, edges })
  const related = linkSemantically(store, scope, nodes)
  // The plugin passes `temporal: false` and wires the turn itself, once the outcome is known.
  if (temporal) linkTemporal(store, scope, nodes.map(node => node.id), turn)
  const result = { nodes: nodes.length, edges: edges.length + related, superseded: edges.filter(e => e.rel === 'supersedes').length }
  // Not part of the reported shape: the ids are for the caller that wires the turn.
  Object.defineProperty(result, 'ids', { value: nodes.map(node => node.id), enumerable: false })
  return result
}

/**
 * Novelty at encoding: a progress line or decision that introduces entities the graph has
 * never seen is more surprising, and is encoded more strongly. The prediction-error idea of
 * EM-LLM and Nemori, reduced to what can be computed without a model: "is this new here?"
 */
function noveltySalience(store, scope, nodes) {
  const known = new Set(store.db.prepare('SELECT DISTINCT entity FROM mention WHERE scope=?').all(scope).map(row => row.entity))
  if (!known.size) return
  for (const node of nodes) {
    if (node.kind !== 'progress' && node.kind !== 'decision') continue
    const own = entitySet(node.claim)
    if (!own.length) continue
    const fresh = own.filter(entity => !known.has(entity)).length / own.length
    node.salience = Math.max(Number(node.salience) || 0, Math.round(0.3 * fresh * 100) / 100)
  }
}

/**
 * Words that make a sentence an instruction or a replacement, not what it is about. They are
 * shared by any two instructions, so counting them as overlap made "决定把日志格式改成 JSON 行，
 * 因为…" supersede "决定把连接池上限改成 32，因为…" — two unrelated decisions, one silently hidden.
 */
const MARKERS = /(?:改成|改用|换成|换用|不再|不用|改掉|改为|作废|废弃|取代|替换为|替换|而不是|不要|不能|禁止|必须|只能|只准|不许|务必|记得|决定|因为|所以|因此|以后|今后|一律|instead of|instead|switch(?:ed)? to|no longer|replace[ds]?|don't|do not|never|must|only|always|because)/gi
const contentTerms = text => termSet(String(text ?? '').replace(MARKERS, ' '), NODE_TERMS).filter(term => term.length >= 2)

/**
 * A claim that replaces an older claim about the same object.
 *
 * This is the two-timeline half of the graph (Zep / Graphiti's invalidation): a fact is not
 * deleted when it stops being true, it gets a `valid_to`. The failure it fixes is concrete —
 * "必须用 npm" then "改用 pnpm" must not leave two contradictory pinned instructions.
 *
 * Conservative on purpose, because a false supersession hides a live constraint, which is worse
 * than showing a stale one. Supersession requires the replacement wording AND the same object:
 *   - a shared instance entity (a path, a version, `mod3`) — yes;
 *   - instance entities on both sides that do not overlap (`mod0` vs `mod1`) — no, whatever else
 *     the sentences share;
 *   - otherwise, at least two shared rare *content* terms, with the instruction vocabulary
 *     removed first.
 */
const REPLACES = /(?:改成|改用|换成|换用|改为|不再|不用|改掉|作废|废弃|取代|替换|而不是|替换为|instead|switch(?:ed)? to|no longer|replace)/i

export function sameObject(a, b, { rare = () => true } = {}) {
  const ea = new Set(entitySet(a.claim))
  const eb = new Set(entitySet(b.claim))
  const sharedEntities = [...ea].filter(entity => eb.has(entity))
  if (sharedEntities.some(isInstance)) return true
  const ia = [...ea].filter(isInstance)
  const ib = [...eb].filter(isInstance)
  if (ia.length && ib.length) return false
  const ta = new Set(contentTerms(a.claim))
  const shared = contentTerms(b.claim).filter(term => ta.has(term) && rare(term))
  return shared.length >= 2
}

export function supersedeConflicts(store, scope, nodes, { now = Date.now() } = {}) {
  const candidates = nodes.filter(node => !node.pin || node.kind === 'constraint')
  if (!candidates.length) return []
  const existing = store.activeNodes(scope)
  if (!existing.length) return []

  const frequency = new Map()
  for (const other of existing) for (const term of contentTerms(other.claim)) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const rareFloor = Math.max(2, Math.round(existing.length * 0.15))
  const rare = term => (frequency.get(term) ?? 1) <= rareFloor

  const edges = []
  const closed = new Map()
  for (const node of candidates) {
    if (!REPLACES.test(String(node.claim ?? ''))) continue
    for (const other of existing) {
      // Same kind only: a decision never invalidates a constraint, and a progress line never
      // invalidates anything — it is a note about what happened, not a statement of policy.
      if (other.id === node.id || other.kind !== node.kind) continue
      if (other.kind !== 'constraint' && other.kind !== 'decision') continue
      if (closed.has(other.id) || other.valid_to !== null) continue
      if (!sameObject(node, other, { rare })) continue
      closed.set(other.id, node.id)
      edges.push({ src: node.id, dst: other.id, rel: 'supersedes', w: 1 })
    }
  }
  // Validity is closed after the edge list is complete: one write, one transaction. Each one is
  // logged, because a supersession changes what the model sees and must be explainable later.
  for (const [old, by] of closed) {
    store.supersede(old, now)
    store.log({ scope, action: 'memory_supersede', actor: 'capture', detail: { node: old, by } })
  }
  return edges
}

/** A file written again in a later turn replaces the earlier artifact: same path, newer content. */
function supersedeArtifacts(store, scope, nodes, { now = Date.now() } = {}) {
  const edges = []
  const anchors = new Map()
  for (const node of nodes) if (node.kind === 'artifact' && node.anchor) anchors.set(node.anchor, node.id)
  if (!anchors.size) return edges
  const find = store.db.prepare("SELECT id FROM node WHERE scope=? AND kind='artifact' AND anchor=? AND id!=? AND state='active' AND valid_to IS NULL")
  for (const [anchor, id] of anchors) {
    for (const row of find.all(scope, anchor, id)) {
      store.supersede(row.id, now)
      edges.push({ src: id, dst: row.id, rel: 'supersedes', w: 1 })
    }
  }
  return edges
}

/**
 * Check recorded fingerprints against the files as they are now.
 *
 * An artifact line says "src/x.js was written"; if the file has since changed under someone
 * else's hand, that line is evidence about content that no longer exists. A rewrite through the
 * agent already superseded the old node; what is left changed outside the session, and is
 * marked stale — out of the card, still readable by recall.
 */
export function verifyArtifacts(store, scope, hashOf, { limit = 40 } = {}) {
  if (typeof hashOf !== 'function') return []
  const rows = store.db.prepare(`SELECT id, anchor, hash FROM node WHERE scope=? AND kind='artifact' AND state='active'
    AND valid_to IS NULL AND hash IS NOT NULL AND anchor LIKE 'file:%' ORDER BY seen DESC LIMIT ?`).all(scope, limit)
  const stale = []
  for (const row of rows) {
    const current = hashOf(row.anchor.slice(5))
    if (current === null || current === row.hash) continue
    store.markStale(row.id, 'content_changed')
    stale.push(row.id)
  }
  return stale
}

/**
 * A correction is the strongest memory signal a session produces.
 *
 * Extraction only turns a user message into a constraint when it matches a standing-instruction
 * pattern; "不对，是 pnpm" matches nothing. This writes the correction into the graph, pinned,
 * with `source: 'correction'` so a card line can be traced back to the sentence that caused it.
 *
 * Short on purpose: a correction line competes for the same 600 bytes as everything else, and a
 * 300-byte claim (the 2.0 bound) let two corrections fill the card.
 */
export function recordCorrection(store, scope, { text, intent = '', seq = -1, session = null, turn = currentTurn(store, scope) } = {}, { now = Date.now() } = {}) {
  const statement = bounded(String(text ?? '').trim(), 160)
  // A bare "不对" corrects nothing usable on its own: it says the last answer was wrong without
  // saying what is right, and pinning it would put a contentless line on every future card.
  if (statement.length < 6) return null
  const before = bounded(String(intent ?? '').trim(), 48)
  const claim = before ? `纠正（针对「${before}」）：${statement}` : `纠正：${statement}`
  const node = {
    id: hash([scope, "correction", statement].join("\u0000")).slice(0, 16),
    kind: 'constraint', claim: bounded(claim, 240), seq, pin: 1, source: 'correction',
    session, turn, salience: 1, anchor: Number.isInteger(seq) && seq >= 0 ? `seq:${seq}` : null,
  }
  // A correction may also replace an earlier standing instruction ("不对，改用 pnpm").
  const edges = supersedeConflicts(store, scope, [node], { now })
  store.recordNodes(scope, { nodes: [node], edges })
  return node.id
}

/**
 * Reconsolidation: retrieval re-opens a memory, and a correction right after it rewrites it.
 *
 * The nodes the previous turn used or wrote are the ones the correction can be about. Those that
 * share an instance entity or two content terms with it get a `contradicts` edge: they leave the
 * top of the card (the read path subtracts a penalty), and recall reports who contradicted them.
 * Pinned constraints are left to supersession, which needs the stronger evidence of replacement
 * wording — a correction must not silently disable a standing instruction.
 */
export function reconsolidate(store, scope, correctionId, recentIds = []) {
  const correction = store.nodeRow(correctionId)
  if (!correction || !recentIds.length) return []
  const linked = []
  for (const id of new Set(recentIds)) {
    if (id === correctionId) continue
    const node = store.nodeRow(id)
    if (!node || node.pin || node.valid_to || node.state !== 'active') continue
    // A correction overturns a judgement, not the fact that a file was written.
    if (node.kind !== 'decision' && node.kind !== 'progress') continue
    const ec = new Set(entitySet(correction.claim))
    const sharedInstance = entitySet(node.claim).some(entity => ec.has(entity) && isInstance(entity))
    const tc = new Set(contentTerms(correction.claim))
    const sharedTerms = contentTerms(node.claim).filter(term => tc.has(term)).length
    if (!sharedInstance && sharedTerms < 2) continue
    store.link(scope, { src: correctionId, dst: id, rel: 'contradicts', mode: 'max', cap: 1, delta: 1 })
    linked.push(id)
  }
  return linked
}

/**
 * Connect new knowledge to old knowledge by shared rare content terms.
 *
 * The passive half of the graph: no judgement, just "these two talk about the same things".
 * Instruction vocabulary is removed first for the same reason as in supersession. Entities
 * connect nodes separately, through the mention index, at read time.
 */
function linkSemantically(store, scope, nodes) {
  const existing = store.activeNodes(scope)
  if (existing.length < 2) return 0
  const termsOf = new Map(existing.map(node => [node.id, new Set(contentTerms(node.claim))]))
  const frequency = new Map()
  for (const set of termsOf.values()) for (const term of set) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const rareFloor = Math.max(2, Math.round(existing.length * 0.15))
  const rare = term => (frequency.get(term) ?? 1) <= rareFloor

  let linked = 0
  for (const node of nodes) {
    const own = new Set(contentTerms(node.claim))
    if (own.size < 2) continue
    const scored = []
    for (const other of existing) {
      if (other.id === node.id) continue
      const theirs = termsOf.get(other.id)
      let shared = 0
      for (const term of own) if (theirs.has(term) && rare(term)) shared++
      if (shared < 2) continue
      scored.push({ other, score: shared })
    }
    scored.sort((a, b) => b.score - a.score || a.other.id.localeCompare(b.other.id))
    for (const { other, score } of scored.slice(0, 3)) {
      const [src, dst] = node.id < other.id ? [node.id, other.id] : [other.id, node.id]
      store.link(scope, { src, dst, rel: 'related', mode: 'max', cap: 1, delta: Math.round((0.2 + score * 0.15) * 100) / 100 })
      linked++
    }
  }
  return linked
}

/**
 * Temporal structure: what this turn touched follows what the last turn touched.
 *
 * Directed `precedes` edges are the symbolic form of spike-timing-dependent plasticity — the
 * earlier memory strengthens its link *to* the later one, not the other way round — and of the
 * temporal contiguity that TCM/CMR models: things that happened close together are retrieved
 * together. It is what lets recall answer "and after that we usually…" (a failure, then its fix).
 */
function linkTemporal(store, scope, createdIds, turn, { modulation = 1, cap = 6 } = {}) {
  const key = `turnset:${scope}`
  let previous = null
  try { previous = JSON.parse(store.readMeta(key) ?? 'null') } catch { previous = null }
  const used = store.db.prepare('SELECT DISTINCT node FROM activation WHERE scope=? AND turn=?').all(scope, turn).map(row => row.node)
  const current = [...new Set([...createdIds, ...used])].slice(0, cap)
  if (previous && previous.turn < turn && modulation > 0) {
    for (const src of previous.ids.slice(0, cap)) for (const dst of current) {
      if (src === dst) continue
      store.link(scope, { src, dst, rel: 'precedes', delta: Math.round(0.1 * modulation * 100) / 100, cap: 1 })
    }
  }
  // Merge rather than overwrite inside one turn: capture and use-tracking both report into it.
  const ids = previous && previous.turn === turn ? [...new Set([...previous.ids, ...current])].slice(0, cap * 2) : current
  store.writeMeta(key, JSON.stringify({ turn, ids, prev: previous && previous.turn < turn ? previous.ids : (previous?.prev ?? []) }))
}

/** The nodes this turn and the previous one touched: the synaptic tags a strong event can capture. */
export function recentlyTouched(store, scope) {
  try {
    const value = JSON.parse(store.readMeta(`turnset:${scope}`) ?? 'null')
    return value ? [...new Set([...(value.ids ?? []), ...(value.prev ?? [])])] : []
  } catch { return [] }
}

/**
 * Use, not exposure. A node is activated when something *needs* it: the user names its
 * identifier, a tool touches its path, the reply refers to it. Matching is by entity, never by
 * bigram — "src" or "文件" is in everything and would turn use-tracking into noise — and an
 * entity that too many nodes share activates none of them (the fan effect, again).
 */
export function noteUse(store, scope, { text = '', paths = [], source = 'cue', turn = currentTurn(store, scope), max = 8 } = {}) {
  const wanted = [...new Set([...entitySet(text), ...paths.flatMap(path => entitySet(String(path ?? '')))])]
  if (!wanted.length) return []
  const rows = store.nodesMentioning(scope, wanted)
  if (!rows.length) return []
  const fan = new Map()
  for (const row of store.db.prepare(`SELECT entity, COUNT(*) n FROM mention WHERE scope=? AND entity IN (${wanted.map(() => '?').join(',')}) GROUP BY entity`).all(scope, ...wanted)) fan.set(row.entity, row.n)
  const total = store.db.prepare("SELECT COUNT(*) n FROM node WHERE scope=? AND state='active'").get(scope)?.n ?? 0
  const maxFan = Math.max(3, Math.floor(total * 0.2))
  const already = new Set(store.db.prepare('SELECT node FROM activation WHERE scope=? AND turn=? AND source=?').all(scope, turn, source).map(row => row.node))
  const hit = []
  for (const row of rows) {
    if ((fan.get(row.entity) ?? 0) > maxFan || already.has(row.id) || hit.includes(row.id)) continue
    hit.push(row.id)
    if (hit.length >= max) break
  }
  for (const node of hit) store.activate(scope, { node, query: bounded(text || paths.join(' '), 120), source, turn })
  return hit
}

/**
 * What a finished turn used, from its buffered events: the paths its tools touched and the
 * identifiers its replies referred to. Runs before `capture`, so a node is not "used" by the
 * very sentence that created it.
 */
export function noteTurnUse(store, scope, events, { turn = currentTurn(store, scope) } = {}) {
  const paths = []
  const replies = []
  for (const block of normalize(events)) {
    if (block.kind === 'tool-call' && block.path) paths.push(block.path)
    if (block.kind === 'assistant') replies.push(block.text)
  }
  const used = [
    ...(paths.length ? noteUse(store, scope, { paths, source: 'tool', turn, max: 8 }) : []),
    ...(replies.length ? noteUse(store, scope, { text: bounded(replies.join('\n'), 4000), source: 'answer', turn, max: 6 }) : []),
  ]
  return [...new Set(used)]
}

/**
 * Three-factor Hebbian learning over one turn: the nodes this turn used fire together, and the
 * outcome of the turn gates how much they wire. A clean turn reinforces; a recovery (errors, then
 * done) reinforces more and *captures* the synaptic tags — the nodes touched this turn and the
 * last gain salience (Frey & Morris' tagging and capture); a corrected turn reinforces nothing.
 */
export function wireTurn(store, scope, { used = [], created = [], outcome = {}, turn = currentTurn(store, scope) } = {}) {
  const { corrections = 0, toolErrors = 0, complete = true } = outcome
  const modulation = corrections > 0 ? 0 : !complete ? 0.5 : toolErrors > 0 ? 1.5 : 1
  const live = used.filter(id => { const node = store.nodeRow(id); return node && !node.valid_to && node.state === 'active' }).slice(0, 6)
  let wired = 0
  if (modulation > 0) {
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const [src, dst] = live[i] < live[j] ? [live[i], live[j]] : [live[j], live[i]]
      store.link(scope, { src, dst, rel: 'coactivated', delta: Math.round(0.05 * modulation * 100) / 100 })
      wired++
    }
  }
  linkTemporal(store, scope, [...created, ...live], turn, { modulation })
  let captured = []
  if (toolErrors > 0 && complete && corrections === 0) {
    captured = recentlyTouched(store, scope)
    const bump = store.db.prepare('UPDATE node SET salience=MIN(1, salience+0.2) WHERE id=? AND scope=?')
    for (const id of captured) bump.run(id, scope)
  }
  return { wired, modulation, captured }
}

/**
 * The drifting topic: c ← ρ·c + (1−ρ)·terms(turn). A temporal context vector in the TCM sense,
 * kept as the 48 heaviest terms. Used as a weak cue, so a terse follow-up ("继续") still lifts
 * what the last few turns were about.
 */
export function driftContext(store, scope, text, { rho = 0.7, size = 48 } = {}) {
  const key = `drift:${scope}`
  let current = []
  try { current = JSON.parse(store.readMeta(key) ?? '[]') } catch { current = [] }
  const next = new Map(current.map(([term, weight]) => [term, weight * rho]))
  const fresh = termSet(text, NODE_TERMS).filter(term => term.length >= 2)
  for (const term of fresh) next.set(term, (next.get(term) ?? 0) + (1 - rho) / Math.max(1, Math.sqrt(fresh.length)))
  const kept = [...next].filter(([, weight]) => weight > 0.01).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, size)
    .map(([term, weight]) => [term, Math.round(weight * 1000) / 1000])
  store.writeMeta(key, JSON.stringify(kept))
  return kept
}

export function driftOf(store, scope) {
  try { return new Map(JSON.parse(store.readMeta(`drift:${scope}`) ?? '[]')) } catch { return new Map() }
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

/** Cue terms and entities of a message, in the shape the read path takes. */
export const cuesOf = text => ({ terms: termSet(text), entities: entitySet(text) })

/**
 * The per-turn card. Empty until the graph has something worth saying, so it costs nothing.
 *
 * Two orderings, one switch. `dynamics: false` keeps the 1.5 behaviour — pinned, then kind, then
 * newest. `dynamics: true` routes through `graph-memory`, where the card is ranked by how likely
 * each memory is to be needed now (base level + working memory + cue + graph context), with
 * lateral inhibition so one topic cannot fill it.
 *
 * `now` is threaded through so the card is a pure function of (graph, clock bucket): every call
 * inside one five-minute bucket renders identical bytes, recalls included. Each change appends a
 * new runtime-context snapshot to the model's history, so a card that changes less costs less.
 */
export function projectionText(store, scope, budget = 600, { sessionId = null, dynamics = false, promote = false, now = undefined, cues = null, turn = null } = {}) {
  const nodes = dynamics ? null : store.activeNodes(scope, 200)
  const view = dynamics ? memoryView(store, scope, { now: now ?? Date.now(), cues, context: driftOf(store, scope), turn: Number.isInteger(turn) ? turn : currentTurn(store, scope) }) : null
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
 * Extraction is deliberately narrow, so an environment fact — an error code, a version, a path
 * that only appeared inside a tool result — never becomes a node. A reference node turns it from
 * a coin-flip lexical search into a term lookup, at zero checkpoint bytes. Runs after `capture`.
 */
export function promoteTurn(store, scope, events, { max = 2, now = Date.now(), session = null } = {}) {
  const blocks = normalize(events)
  if (!blocks.length) return []
  return promoteUncovered(store, scope, blocks, { max, now, session })
}

/**
 * Recall: lexical and entity hits as seeds, one hop of neighbours, and a spread over the rest.
 *
 * Superseded and retired rows are searched too — "this was replaced by X" and "this was retired"
 * are answers, and better ones than silence. They are never spread *from* and never wired into
 * anything: an obsolete claim must not pull its old associations back into the live graph.
 *
 * One ranking for the candidates, in both modes: how far the spread reached, how strongly the
 * candidate is tied to the hits, and — when the dynamics view is present — how likely it is to be
 * needed. 2.0 ranked by activation alone with the view and not at all without it (an inverted
 * condition returned 0 for every pair), so association weights never decided anything.
 */
export function recall(store, scope, query, { limit = 8, dynamicsView = null, spread = true, turn = null } = {}) {
  const queryTerms = termSet(query)
  const queryEntities = entitySet(query)
  const lexical = store.searchNodes(scope, queryTerms, limit, { includeSuperseded: true, includeRetired: true })
  // An exact path or package is a better match than any bigram overlap: entity hits lead.
  const byEntity = queryEntities.length
    ? store.db.prepare(`SELECT DISTINCT node FROM mention WHERE scope=? AND entity IN (${queryEntities.map(() => '?').join(',')})`)
      .all(scope, ...queryEntities).map(row => store.nodeRow(row.node)).filter(Boolean)
    : []
  const seen = new Set()
  const hits = []
  for (const row of [...byEntity, ...lexical]) {
    if (seen.has(row.id) || hits.length >= limit) continue
    seen.add(row.id)
    hits.push(row)
  }
  const liveHits = hits.filter(row => row.state === 'active' && !row.valid_to)
  const t = Number.isInteger(turn) ? turn : currentTurn(store, scope)
  for (const row of hits) store.activate(scope, { node: row.id, query: String(query ?? ''), source: 'recall', turn: t })

  const neighbours = store.neighbours(scope, liveHits.map(row => row.id), { associative: true })
    .filter(row => row.state === 'active' && !row.valid_to)
  // Fire together, wire together: live hits retrieved by one cue are linked to each other, and
  // to the first ring around them. 2.0 only paired hits with existing neighbours, so two
  // isolated memories retrieved together never became associated.
  const pairs = []
  const add = (a, b) => {
    if (a === b || pairs.length >= 24) return
    const [src, dst] = a < b ? [a, b] : [b, a]
    if (!pairs.some(pair => pair.src === src && pair.dst === dst)) pairs.push({ src, dst })
  }
  const top = liveHits.slice(0, 4)
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) add(top[i].id, top[j].id)
  for (const hit of top) for (const near of neighbours.slice(0, 6)) add(hit.id, near.id)
  for (const pair of pairs) store.link(scope, { ...pair, rel: 'coactivated', delta: 0.1 })

  const spreadRank = spread ? spreadFrom(store, scope, liveHits) : new Map()
  const extra = spread ? transitive(store, spreadRank, hits, neighbours, limit) : []

  const strengths = strengthsTo(store, scope, hits)
  const rankOf = row => {
    const reach = spreadRank.get(row.id) ?? 0
    const strength = strengths.get(row.id) ?? 0
    const entry = dynamicsView?.byId.get(row.id)
    return 1.5 * reach + Math.log(1 + strength) + (entry ? 0.3 * entry.score : 0)
  }
  const ordered = [...neighbours, ...extra]
    .map(row => ({ row, rank: rankOf(row) }))
    .sort((a, b) => b.rank - a.rank || a.row.id.localeCompare(b.row.id))
    .map(({ row }) => row)
  return {
    query: String(query ?? ''),
    hits: hits.map(row => describe(store, scope, row, dynamicsView)),
    neighbours: ordered.map(row => ({ ...describe(store, scope, row, dynamicsView), strength: Math.round((strengths.get(row.id) ?? 0) * 100) / 100,
      ...(spreadRank.has(row.id) ? { reach: Number(spreadRank.get(row.id).toFixed(3)) } : {}) })),
    next: successors(store, scope, liveHits),
    links: pairs.length,
    spread: spreadRank.size,
  }
}

/** Rank the live project graph from the live hits, entities included, or nothing. */
function spreadFrom(store, scope, hits) {
  if (!hits.length) return new Map()
  const nodes = store.activeNodes(scope)
  if (nodes.length < 3) return new Map()
  const edges = store.edgeWeights(scope)
  const mentions = store.mentions(scope)
  if (!edges.length && !mentions.size) return new Map()
  return propagate(nodes, edges, hits, { mentions })
}

/**
 * Nodes the walk reached that one hop did not. The cut is low (0.05 of the peak) and the real
 * filter is the top-k slice: on a three-node chain a two-hop node scores 0.11, so any absolute
 * cut tuned on a large graph silently drops the far hop on a small one.
 */
function transitive(store, rank, hits, neighbours, limit) {
  if (!rank.size) return []
  const skip = new Set([...hits.map(row => row.id), ...neighbours.map(row => row.id)])
  return [...rank.entries()]
    .filter(([id, share]) => share >= 0.05 && !skip.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 2)
    .map(([id]) => store.nodeRow(id))
    .filter(Boolean)
}

/** Strongest associative edge from each node to any hit, in one query. */
function strengthsTo(store, scope, hits) {
  const out = new Map()
  if (!hits.length) return out
  const ids = new Set(hits.map(row => row.id))
  const slots = [...ids].map(() => '?').join(',')
  const rows = store.db.prepare(`SELECT src, dst, w FROM edge WHERE scope=? AND rel NOT IN ('supersedes','contradicts')
    AND (src IN (${slots}) OR dst IN (${slots}))`).all(scope, ...ids, ...ids)
  for (const row of rows) {
    const other = ids.has(row.src) ? row.dst : row.src
    out.set(other, Math.max(out.get(other) ?? 0, row.w))
  }
  return out
}

/** "And after that, usually…": the strongest `precedes` successors of the hits. */
function successors(store, scope, hits, { limit = 3 } = {}) {
  if (!hits.length) return []
  const ids = hits.map(row => row.id)
  const rows = store.db.prepare(`SELECT dst, MAX(w) w FROM edge WHERE scope=? AND rel='precedes' AND src IN (${ids.map(() => '?').join(',')})
    GROUP BY dst ORDER BY w DESC LIMIT ?`).all(scope, ...ids, limit * 2)
  return rows.filter(row => !ids.includes(row.dst)).map(row => store.nodeRow(row.dst))
    .filter(node => node && node.state === 'active' && !node.valid_to)
    .slice(0, limit)
    .map(node => ({ ...view(node), strength: Math.round(rows.find(row => row.dst === node.id).w * 100) / 100 }))
}

/** Node view plus provenance, contradiction and the numbers the read path used. */
function describe(store, scope, row, dynamicsView) {
  const base = view(row)
  const by = store.db.prepare("SELECT src FROM edge WHERE scope=? AND rel='contradicts' AND dst=?").all(scope, row.id).map(r => r.src)
  if (by.length) base.contradictedBy = by
  if (row.session && Number.isInteger(row.seq) && row.seq >= 0) base.source = { session: row.session, seq: row.seq }
  const entry = dynamicsView?.byId.get(row.id)
  return entry ? { ...base, A: Number(entry.A.toFixed(3)), need: Number(entry.need.toFixed(2)), deg: entry.deg, core: entry.core } : base
}

/**
 * Write a lookup back as a pointer.
 *
 * A retrieval that succeeded once will be needed again; recording it turns the second question
 * into a card hit instead of another scan. The node is a pointer, not a claim — it says where
 * to look, not what is true there. Maintenance may later fold the span into it (`schematize`).
 */
export function recordLookup(store, scope, query, spans) {
  const q = String(query ?? '').trim()
  if (!q || !Array.isArray(spans) || !spans.length) return null
  const first = spans[0]
  const id = hash(`${scope}\u0000lookup\u0000${q.toLowerCase()}`).slice(0, 16)
  store.recordNodes(scope, { nodes: [{
    id, kind: 'reference', claim: `常用检索：${bounded(q, 40)}`,
    anchor: `seq:${first.seq}`, seq: first.seq, session: first.session ?? null, source: 'lookup',
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
 * The duplicates come from writers that hash different strings (`recordLookup` the query,
 * `promoteTurn` the claim, corrections the statement), so the same fact through two paths is two
 * rows. Only exact claims merge, and only within a kind: a similarity threshold would merge
 * "use pnpm" with "do not use pnpm". The survivor is the better-connected one; the absorbed
 * node's edges are re-pointed, its support is added, and it is retired, not deleted.
 */
export function mergeDuplicates(store, scope, { limit = store.maxNodes } = {}) {
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
  store.db.prepare('DELETE FROM edge WHERE scope=? AND (src NOT IN (SELECT id FROM node WHERE scope=?) OR dst NOT IN (SELECT id FROM node WHERE scope=?))')
    .run(scope, scope, scope)
  return merged
}

/** Edges that are learned from use, and therefore decay; structure and similarity do not. */
export const LEARNED = Object.freeze(['coactivated', 'precedes'])

/**
 * Sleep: what an idle pass does to the graph.
 *
 *   1. decay — only learned edges fade. `derived` is provenance and `related` is a property of
 *      two claims; decaying them deleted true structure after enough passes.
 *   2. homeostatic scaling — no node may hold more than `budget` of learned weight, so a hub that
 *      every recall reinforces cannot keep growing (Turrigiano's synaptic scaling).
 *   3. schematization — a lookup that has been needed twice gets the span it points to folded
 *      into its claim, so the third time the card carries the fact, not the pointer.
 */
export function consolidate(store, scope, { factor = 0.97, floor = 0.05, budget = 3 } = {}) {
  const removed = store.decayEdges(scope, { factor, floor, rels: [...LEARNED] })
  const scaled = store.scaleEdges(scope, { rels: [...LEARNED], budget })
  const schematized = schematize(store, scope)
  return { pruned: removed, scaled, schematized, ...store.graphStats(scope) }
}

/** Fold the source span into lookups that keep being needed. */
export function schematize(store, scope, { minHits = 2, limit = 8 } = {}) {
  const rows = store.db.prepare(`SELECT * FROM node WHERE scope=? AND kind='reference' AND source='lookup' AND state='active'
    AND hits>=? AND session IS NOT NULL AND claim NOT LIKE '%→%' ORDER BY hits DESC LIMIT ?`).all(scope, minHits, limit)
  const update = store.db.prepare('UPDATE node SET claim=?, terms=? WHERE id=?')
  const done = []
  for (const row of rows) {
    const span = store.spanAt(scope, row.session, Number(row.seq))
    if (!span?.text) continue
    const gist = identifierGist(span.text)
    if (!gist) continue
    const claim = bounded(oneLine(`${row.claim} → ${gist}`), 240)
    update.run(claim, JSON.stringify(termSet(claim, NODE_TERMS)), row.id)
    store.indexMentions([{ id: row.id, scope, claim }])
    done.push(row.id)
  }
  return done
}

/** The identifier-dense 80 bytes of a span: what makes it worth remembering. */
function identifierGist(text, limit = 80) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (Buffer.byteLength(source) <= limit) return source
  const first = /[A-Za-z0-9_]*[/.][A-Za-z0-9_./-]+|--[a-z][a-z-]+|\bv?\d+\.\d+\.\d+\b|\b[A-Z]{3,}\b/.exec(source)
  const start = first ? Math.max(0, first.index - 16) : 0
  return bounded(source.slice(start), limit).trim()
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
