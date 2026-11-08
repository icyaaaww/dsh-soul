/**
 * Consolidation bridge — where the forgetting curve meets graph compaction.
 *
 * The two modules were designed separately and it shows: `compact()` picks what survives a
 * checkpoint using PPR over block adjacency, while the memory graph keeps activation history
 * that the compressor never reads. The background handoff between them is one number
 * (`graphBoost`: seq -> multiplier from edge weight), which carries centrality and nothing
 * about time.
 *
 * The claim this module makes is that they are not two mechanisms. Systems consolidation *is*
 * compaction: a verbatim span (fast store, hippocampal, session-scoped) is turned into a
 * self-contained claim (slow store, cortical, project-scoped). DSH already has both halves and
 * calls them different names. What memory dynamics adds is the missing question —
 * **can this be dropped yet?**
 *
 * Three decisions follow, each from a different signal, deliberately kept separate:
 *
 *   1. how much of the budget goes to claims vs verbatim excerpts   <- claimability (hits)
 *   2. which blocks are worth their bytes                            <- loss risk (1 - A)
 *   3. what may be shadowed at all                                   <- recovery (A)
 *
 * The third one is the sharp edge. `compact()` shadows every block it does not pick and the
 * design assumes `soul_recall` gets them back — but recall is lexical, so a shadowed block is
 * recoverable only if the model happens to guess the right words. For a span whose knowledge
 * was never consolidated, "shadowed" is much closer to "gone" than the checkpoint text implies.
 */

import { bounded, hash } from './util.js'
// ACT-R activation has exactly one implementation, in the read-path module, and this one
// delegates to it. Two copies of the same log-sum drifted apart once already in this project
// (`normalize` had the same problem); the compressor is allowed to depend on pure math.
import { activation as actrActivation, availability as actrAvailability } from './graph-memory.js'

/**
 * ACT-R availability, mapped to [0,1].
 *
 * `B = ln Σ (t - t_j)^-d` over the node's encodings — creation is an encoding event, so a node
 * that was never retrieved still has a finite activation that decays from birth. The logistic
 * uses ACT-R's conventional threshold and noise (τ=0, s=0.4); **they are not fitted to this
 * workload and the result is ordinal, not calibrated.** Use it for ranking and for coarse
 * thresholds; do not read a 0.62 as "62% chance of recall".
 *
 * The maths itself lives in `graph-memory.js`. Two copies of the same log-sum is exactly the
 * drift this project has already paid for once (`normalize`), so this is a delegation.
 */
export const ACTR = Object.freeze({ d: 0.5, threshold: 0, noise: 0.4 })

export function availability(encodings, now = Date.now(), { d = ACTR.d, threshold = ACTR.threshold, noise = ACTR.noise } = {}) {
  return actrAvailability(actrActivation(encodings, now, { d }), { threshold, noise })
}

/** Encodings per node: creation plus every activation. Zero model calls, one table scan. */
export function encodingsByNode(store, scope) {
  const byNode = new Map()
  for (const row of store.db.prepare('SELECT node, at FROM activation WHERE scope=? ORDER BY at').all(scope)) {
    const list = byNode.get(row.node) ?? []
    list.push(Number(row.at))
    byNode.set(row.node, list)
  }
  return byNode
}

/**
 * One pass over the graph, producing what the compressor needs, keyed by `seq`.
 *
 * `importance` is load-bearing-ness: pinned constraints and decisions outrank progress. It is
 * a property of the node, never of its age — the whole point of separating it from `A`.
 */
export function memoryProfile(store, scope, now = Date.now()) {
  const nodes = store.activeNodes(scope, 500)
  const encodings = encodingsByNode(store, scope)
  const bySeq = new Map()
  let consolidated = 0
  let loadBearing = 0
  for (const node of nodes) {
    const times = [Number(node.created), ...(encodings.get(node.id) ?? [])]
    const A = availability(times, now)
    // `hits` counts how often the node was actually surfaced and used — the evidence that a
    // claim is stable enough to stand alone. Three retrievals is the arbitrary line at which a
    // paraphrase stops being a guess; it is a parameter, not a law.
    const claimability = Math.min(1, (Number(node.hits) || 0) / 3)
    const loadBearingNode = Boolean(node.pin) || node.kind === 'constraint' || node.kind === 'decision'
    if (loadBearingNode) { loadBearing++; consolidated += claimability }
    bySeq.set(Number(node.seq), {
      id: node.id, A, claimability, hits: Number(node.hits) || 0,
      pin: Boolean(node.pin), kind: node.kind, loadBearing: loadBearingNode, tier: Number(node.tier) || 0,
    })
  }
  return {
    bySeq,
    claimability: loadBearing ? consolidated / loadBearing : 0,
    nodes: bySeq.size,
  }
}

/**
 * How much of the card belongs to claims.
 *
 * `compact()` hardcodes 0.45. That fixed split is why three constraints can eat the node share
 * at 600 bytes and leave nothing to reconnect the task (SKELETON-BENCH, conclusion 3). Scaling
 * with claimability fixes it in the direction the evidence points: spend on claims when the
 * claims are trustworthy, spend on excerpts when they are not.
 */
export function nodeBudgetRatio(profile, { floor = 0.2, ceil = 0.6 } = {}) {
  const c = profile?.claimability ?? 0
  return Math.min(ceil, Math.max(floor, 0.25 + 0.35 * c))
}

/**
 * Per-block loss risk, as a selection multiplier.
 *
 * The compressor's own rule is "能回捞的不常驻" — anything recall can get back does not need to
 * be resident. That rule is correct and the current implementation only applies half of it: it
 * assumes recoverability instead of measuring it. `A` measures it.
 *
 *   high A -> cheap to drop, the memory is strong; multiplier near 1
 *   low A  -> dropping it is a one-way door; multiplier up to 2x for load-bearing blocks
 *
 * Pinned blocks are `mandatory` upstream and never compete, so they are excluded here.
 */
export function lossRisk(profile, seq, { weight = 1, mildWeight = 0.4 } = {}) {
  const memory = profile?.bySeq?.get(Number(seq))
  if (!memory || memory.pin) return 1
  const w = memory.loadBearing ? weight : mildWeight
  return 1 + w * (1 - memory.A)
}

/**
 * Blocks that may be shadowed without a recovery path.
 *
 * This is the report the checkpoint should carry. A block is *at risk* when nothing consolidated
 * stands behind it and it did not make the cut — the claim line was never written, the raw text
 * is not in the card, and the only way back is a lexical search for words nobody wrote down.
 */
export function shadowRisk(profile, shadowedSeqs, { aFloor = 0.35 } = {}) {
  const atRisk = []
  for (const seq of shadowedSeqs) {
    const memory = profile?.bySeq?.get(Number(seq))
    if (!memory) continue
    if (memory.A >= aFloor) continue        // strong enough that recall will plausibly find it
    if (memory.claimability >= 1) continue  // already schematized; the claim survives on its own
    atRisk.push({ seq, A: memory.A, kind: memory.kind, loadBearing: memory.loadBearing })
  }
  return atRisk.sort((a, b) => Number(b.loadBearing) - Number(a.loadBearing) || a.A - b.A)
}

/**
 * The identifier-dense slice of a block, not its head.
 *
 * A claim that starts at byte 0 loses exactly what made the block worth promoting: the path or
 * the error code usually sits after a banner of filler. This is the same lesson `skeleton.js`
 * learned for excerpts (`bestWindow`) — quoting the head of a 20 KB tool result gives you the
 * banner and none of the payload.
 */
function identifierWindow(text, limit = 96) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (source.length <= limit) return source
  const pattern = /[A-Za-z0-9_]*[/.][A-Za-z0-9_./-]+|--[a-z][a-z-]+|\bv?\d+\.\d+\.\d+\b|\b[A-Z]{3,}\b/g
  const first = pattern.exec(source)
  if (!first) return bounded(source, limit)
  // Centre the window on the identifier so neither the path nor its surroundings are cut.
  const start = Math.max(0, Math.min(source.length - limit, first.index - Math.floor(limit / 3)))
  return source.slice(start, start + limit)
}

/**
 * The one thing the combination can do that neither half can do alone — and the correction that
 * made it work.
 *
 * The first attempt keyed this on low availability, and it promoted nothing, for a structural
 * reason worth writing down: **a checkpoint is compacted from recent history, so its blocks have
 * just been encoded and their availability is high by construction.** Forgetting acts on old
 * material; compaction acts on new material. Measured across four consolidation levels, the
 * availability signal produced no differentiation in the compressor at all (see
 * `bench/consolidation.mjs`) — the timescales do not overlap.
 *
 * What does overlap is *coverage*. A block is in danger at compaction time not because it is
 * fading but because it was never written down: there is no node whose terms point at it, so
 * once the span is shadowed the only way back is guessing the exact words. That is the residual
 * loss `SKELETON-BENCH.md` already names — extraction catches nine of eleven memory items and
 * misses the ambient environment facts entirely.
 *
 * So the rule is coverage, not decay: no node, identifier-dense, about to be shadowed -> write
 * one. It costs the checkpoint zero bytes and turns a lexical coin-flip into a term lookup.
 */
export function promoteUncovered(store, scope, blocks, { now = Date.now(), max = 4, minIdentifiers = 1, session = null } = {}) {
  const IDENT = /[A-Za-z0-9_]*[/.][A-Za-z0-9_./-]+|--[a-z][a-z-]+|\bv?\d+\.\d+\.\d+\b|\b[A-Z]{3,}\b/g
  const existing = new Set()
  // Identifiers the graph already knows, so a block adds information only if it brings
  // something new. Without this, a session that reads `src/mod3.js` on every turn spends the
  // whole promotion budget re-recording the same path, and the one ambient fact that mattered
  // never gets its turn. Measured: with `max: 2` and no de-duplication, the 路径 and 版本
  // details were never promoted in forty turns.
  const present = new Set()
  // Positions are only comparable inside one session and only when the host gave one: a block
  // with an unknown seq (-1) is never "already covered" by position, only by its identifiers.
  // Keying by bare seq skipped every block after the first turn, because every turn's
  // positions used to restart at zero.
  for (const node of store.activeNodes(scope)) {
    if (node.session && Number(node.seq) >= 0) existing.add(`${node.session}:${node.seq}`)
    for (const identifier of String(node.claim ?? '').match(IDENT) ?? []) present.add(identifier)
  }

  const candidates = []
  for (const block of blocks) {
    if (session && Number(block.seq) >= 0 && existing.has(`${session}:${block.seq}`)) continue
    const text = String(block.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 12) continue
    // Only blocks that carry something unguessable: a path, a flag, a version, an error code.
    const identifiers = [...new Set(text.match(IDENT) ?? [])]
    if (identifiers.length < minIdentifiers) continue
    const fresh = identifiers.filter(identifier => !present.has(identifier))
    if (!fresh.length) continue
    candidates.push({ block, text, identifiers, fresh, score: fresh.length / identifiers.length })
  }
  // Rarest first: a block made entirely of identifiers nobody has recorded is worth more than
  // one that is half noise.
  candidates.sort((a, b) => b.score - a.score || a.block.seq - b.block.seq)

  const created = []
  for (const candidate of candidates) {
    if (created.length >= max) break
    const claim = `环境事实：${identifierWindow(candidate.text)}`
    // Content-addressed, not `p-<seq>`. `seq` is only unique inside one turn's buffer — a
    // session numbers its events monotonically, but a caller that re-normalizes a turn will
    // restart at zero, and `p-2` from this turn then overwrites `p-2` from the last one. That
    // exact collision cost the first version of this function every promotion it ever made.
    const id = `ref-${hash(`${scope}\u0000environment\u0000${claim}`).slice(0, 16)}`
    if (created.some(row => row.id === id)) continue
    store.recordNodes(scope, {
      nodes: [{ id, kind: 'reference', claim, anchor: Number(candidate.block.seq) >= 0 ? `seq:${candidate.block.seq}` : null,
        seq: candidate.block.seq, session, source: 'compaction' }],
    })
    // Claim them now, so a later block with the same identifiers is not worth another row.
    for (const identifier of candidate.fresh) present.add(identifier)
    created.push({ id, seq: candidate.block.seq, claim, identifiers: candidate.identifiers.slice(0, 4) })
  }
  return created
}
