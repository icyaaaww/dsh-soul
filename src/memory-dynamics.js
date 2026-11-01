/**
 * Memory dynamics — retrievability instead of a stored weight.
 *
 * The current skeleton stores `node.weight`, a scalar that goes up on activation and never
 * comes down. A scalar with no time in it cannot forget: `0.4` means the same thing after one
 * hour and after six months. Human memory is different in exactly one respect that matters
 * here — what you can recall is a function of *when you last needed it*, not a property you
 * carry around. This module makes strength a computed quantity: two state variables
 * (stability, difficulty) plus a clock, and everything else derived.
 *
 * Model: FSRS-5 (power-law forgetting curve, spaced-review stability growth, lapse collapse).
 *   - Chosen over the textbook Ebbinghaus exponential because the exponential fits real
 *     retention data worse (Wixted & Ebbesen 1991), and because FSRS has been fitted on
 *     hundreds of millions of real reviews while the exponential has been fitted on one man.
 *   - Chosen over FSRS-7's dual trace because two traces need training data we do not have
 *     yet; see `NOTES` at the bottom for the upgrade path.
 *
 * Zero model calls, zero dependencies, pure functions. Every function here is deterministic
 * and testable, which is the point: a decay function whose sign is load-bearing has to be
 * assertable. The reference implementation everyone cites (MemoryBank) shipped
 * `math.exp(-t / 5*S)` — parsed as `((-t)/5)*S` — so recalling a memory made it decay *faster*,
 * and the bug survived three years and a paper.
 */

const DAY = 86_400_000

/** FSRS-5 default weights (w0..w18). Published preset, NOT fitted to this workload. */
export const W = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
])

export const LIMITS = Object.freeze({ sMin: 0.01, sMax: 36_500, dMin: 1, dMax: 10 })

/** Review grades. Named after what the harness can *observe*, not after a human's feeling. */
export const GRADE = Object.freeze({ LAPSE: 1, HARD: 2, GOOD: 3, EASY: 4 })

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Retrievability: probability the memory is available at `t` days after the last review.
 *
 * R(S, S) = 0.9 by construction, so "stability" reads as "the interval at which you still
 * have a 90% chance". This is the whole forgetting curve; it is monotone decreasing in t and
 * monotone increasing in S, which `tests/dynamics.test.mjs` asserts in both directions.
 */
export function retrievability(t, S) {
  if (!(S > 0)) return 0
  const days = Math.max(0, Number(t) || 0)
  return (1 + (19 * days) / (81 * S)) ** -0.5
}

/** Inverse of the curve: the elapsed time at which retrievability falls to `r`. */
export function intervalFor(r, S) {
  const target = clamp(Number(r), 1e-4, 0.9999)
  return ((81 * S) / 19) * (target ** -2 - 1)
}

export function initialStability(grade = GRADE.GOOD) {
  return clamp(W[clamp(Math.round(grade), 1, 4) - 1], LIMITS.sMin, LIMITS.sMax)
}

export function initialDifficulty(grade = GRADE.GOOD) {
  const g = clamp(Math.round(grade), 1, 4)
  return clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, LIMITS.dMin, LIMITS.dMax)
}

/** Difficulty moves against the grade and mean-reverts, so one bad day is not permanent. */
export function nextDifficulty(D, grade = GRADE.GOOD) {
  const g = clamp(Math.round(grade), 1, 4)
  const delta = -W[6] * (g - 3)
  const moved = D + delta * ((10 - D) / 9)
  return clamp(W[7] * initialDifficulty(GRADE.EASY) + (1 - W[7]) * moved, LIMITS.dMin, LIMITS.dMax)
}

/**
 * Stability after a review.
 *
 * Two branches, and the asymmetry is the model's whole content:
 *   - success grows stability by a factor that is *larger* the lower retrievability was at
 *     review time — the spacing effect, as an equation. Cramming at R=0.99 barely helps;
 *     retrieving at R=0.7 helps a lot. This is why the projection policy in `schedule()` is
 *     not cosmetic.
 *   - a lapse does not subtract, it *recomputes* stability from difficulty, and caps the
 *     result at the previous stability: forgetting a well-consolidated memory does real damage.
 */
export function nextStability(S, D, R, grade = GRADE.GOOD) {
  const g = clamp(Math.round(grade), 1, 4)
  const H = g === GRADE.HARD ? W[15] : 1
  const E = g === GRADE.EASY ? W[16] : 1
  const raw = g === GRADE.LAPSE
    ? Math.min(S, W[11] * D ** -W[12] * ((S + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - R)))
    : S * (1 + Math.exp(W[8]) * (11 - D) * S ** -W[9] * (Math.exp(W[10] * (1 - R)) - 1) * H * E)
  return clamp(raw, LIMITS.sMin, LIMITS.sMax)
}

/**
 * One review. Returns the new state; never mutates.
 *
 * `elapsedDays` is measured from the last review, and `R` is supplied rather than recomputed
 * when the caller already knows it (a recall that happened mid-turn).
 */
export function review(state, grade, elapsedDays, { now = 0 } = {}) {
  const g = clamp(Math.round(grade), 1, 4)
  const S = state?.S > 0 ? state.S : initialStability(g)
  const D = state?.D >= 1 ? state.D : initialDifficulty(g)
  const t = Math.max(0, Number(elapsedDays) || 0)
  const R = state?.S > 0 ? retrievability(t, S) : 0.9
  // Same-day reviews would otherwise return a stability that *drops* on success, because the
  // growth factor is proportional to (e^{w10(1-R)} - 1) and R is ~1: the model is right that
  // massed repetition is nearly worthless, but a review that returns less stability than
  // before is impossible to reason about downstream. Floor it at the current value.
  const grown = nextStability(S, D, R, g)
  const nextS = g === GRADE.LAPSE ? grown : Math.max(S, grown)
  return { S: nextS, D: nextDifficulty(D, g), R, at: now }
}

/** Fresh state for a node that has just been created. */
export function initialState(grade = GRADE.GOOD, at = 0) {
  const g = clamp(Math.round(grade), 1, 4)
  return { S: initialStability(g), D: initialDifficulty(g), R: 1, at }
}

/**
 * Implicit grade from signals the harness already records. No model call, no user input.
 *
 * This is the part that has no precedent in the spaced-repetition literature: FSRS expects a
 * human to click "Again/Hard/Good/Easy". Here the audit trail supplies it —
 *   - a correction that names this claim  -> LAPSE (the memory failed to constrain behaviour)
 *   - surfaced but the turn diverged      -> HARD  (it was there and did not help)
 *   - surfaced and the turn completed     -> GOOD
 *   - surfaced and verification passed    -> EASY  (it demonstrably did its job)
 * The mapping is a heuristic and is documented as one; the parameters must not be fitted to
 * it until there is data, because fitting to a proxy teaches the model the proxy.
 */
export function gradeOf({ surfaced = false, corrected = false, diverged = false, verified = false } = {}) {
  if (corrected) return GRADE.LAPSE
  if (!surfaced) return null
  if (verified) return GRADE.EASY
  if (diverged) return GRADE.HARD
  return GRADE.GOOD
}

/**
 * ACT-R base-level activation over a raw activation log, for the P0 step.
 *
 * `B = ln( Σ (t - t_j)^-d )`, d = 0.5. Power-law forgetting, the spacing effect and the
 * frequency effect all fall out of one line with one parameter — that is why it is worth
 * computing before committing to a schema migration. Costs O(activations) per node, which is
 * why it is the probe and not the destination.
 */
export function baseLevel(times, now, { d = 0.5, floor = 1 / 1440 } = {}) {
  let sum = 0
  for (const at of times) {
    const dt = Math.max(floor, (now - at) / DAY)
    sum += dt ** -d
  }
  return sum > 0 ? Math.log(sum) : -Infinity
}

/**
 * The exponential accumulator, i.e. the approximation everyone reaches for — reported here as
 * an approximation with an error term, not as ACT-R.
 *
 * `a' = a·e^{-Δt/τ} + 1` then `B ≈ ln a` gives O(1) updates, and it is *not* base-level
 * activation: it forgets exponentially, so a memory touched ten times last month and one
 * touched once last month converge. Power-law decay has no exact O(1) accumulator — the sum
 * over `(T - t_j)^-d` genuinely depends on the whole history, which is why ACT-R keeps a
 * trace list and why FSRS' single (S, D, last-review) triple was a substantive modelling
 * decision rather than a convenience.
 *
 * Consequence for the roadmap: ACT-R is the *probe* (P0 — it can be computed from the
 * activation table that already exists, no migration), and FSRS is the *destination* (P1 —
 * O(1) state, fitted on real reviews). Do not try to make ACT-R incremental; keep the log.
 */
export function exponentialAccumulator(a, deltaDays, { tau = 7 } = {}) {
  return (Number(a) || 0) * Math.exp(-Math.max(0, Number(deltaDays) || 0) / tau) + 1
}

/**
 * What the projection should show, given a byte budget.
 *
 * The card is a *review session*, not a noticeboard. Three classes compete:
 *   1. pinned  — always shown, retrievability irrelevant: a violated constraint is an error,
 *                not a low-probability recall.
 *   2. due      — R inside [rLow, rHigh]. Showing a memory at R=0.99 buys almost nothing
 *                (see `nextStability`: the growth factor collapses); showing it at R=0.7 is
 *                the most information per byte that exists. This is desirable difficulty as a
 *                scheduling rule.
 *   3. fresh    — R still ~1 but the claim is new and carries the task forward.
 *
 * `massed` reproduces today's behaviour (newest first) so the two can be compared on the same
 * bytes without touching the caller.
 */
const KIND_ORDER = { constraint: 0, reference: 1, decision: 2, artifact: 3, progress: 4 }

/** Today's ordering, reproduced exactly: pinned, then kind, then newest. Weights are unused. */
export function orderByRecency(nodes, now = Date.now()) {
  return [...nodes].sort((a, b) =>
    (b.pin ? 1 : 0) - (a.pin ? 1 : 0)
    || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || (b.seq ?? 0) - (a.seq ?? 0))
}

/** The proposal: pinned first (R is irrelevant for a violated constraint), then value density. */
export function orderByDynamics(nodes, now = Date.now(), { rLow = 0.5, rHigh = 0.95 } = {}) {
  const price = node => Buffer.byteLength(node.claim ?? '') + 12
  return [...nodes]
    .map(node => {
      const S = node.S > 0 ? node.S : initialStability(GRADE.GOOD)
      const R = retrievability(node.at ? Math.max(0, (now - node.at) / DAY) : 0, S)
      // Value rises as a memory approaches the point of being lost, and peaks just inside the
      // window where a retrieval still does something: `nextStability` shows that reviewing at
      // R≈0.99 multiplies stability by almost nothing, while R≈0.7 multiplies it several-fold.
      // Below rLow the memory is expensive to recover and worth a defensive review.
      const due = R <= rHigh ? 1 + (1 - R) : 1 / (1 + (R - rHigh) * 4)
      const importance = node.pin ? 1e3
        : node.kind === 'constraint' ? 12
        : node.kind === 'decision' ? 6
        : node.kind === 'reference' ? 3 : 2
      return { node, R, value: (importance * due) / price(node), price: price(node) }
    })
    .sort((a, b) => (b.node.pin ? 1 : 0) - (a.node.pin ? 1 : 0) || b.value - a.value)
    .map(entry => entry.node)
}

/** Importance alone, no clock: isolates how much of the gain is ranking by kind. */
export function orderByImportance(nodes) {
  const imp = node => node.pin ? 1e3
    : node.kind === 'constraint' ? 12
    : node.kind === 'decision' ? 6
    : node.kind === 'reference' ? 3 : 2
  return [...nodes].sort((a, b) => imp(b) - imp(a) || (a.seq ?? 0) - (b.seq ?? 0))
}

export function schedule(nodes, { now = Date.now(), budget = 600, priceOf = null, policy = 'dynamics', rLow = 0.5, rHigh = 0.95 } = {}) {
  const price = priceOf ?? (node => Buffer.byteLength(node.claim ?? '') + 12)
  const ordered = policy === 'recency' ? orderByRecency(nodes, now)
    : policy === 'importance' ? orderByImportance(nodes)
    : orderByDynamics(nodes, now, { rLow, rHigh })
  const picked = []
  let spent = 0
  for (const node of ordered) {
    const p = price(node)
    if (spent + p > budget) continue
    picked.push(node)
    spent += p
  }
  return { picked, spent }
}

/**
 * Consolidation. Two timescales, and a demotion instead of a deletion.
 *
 * `sleep()` is what `/mem sleep` becomes. Three things happen, in this order:
 *   1. **downscale** — every edge loses a fixed fraction. This is the synaptic-homeostasis
 *      reading: sleep weakens synapses globally, and what survives is what mattered.
 *   2. **replay** — memories whose retrievability fell through the floor during this window
 *      get their strongest edges re-strengthened. Targeted reactivation, not uniform decay.
 *   3. **promote** — a memory that has survived `promoteAfter` sleeps with high stability
 *      moves to the slow tier, where it decays more slowly. Complementary learning systems:
 *      the fast store learns in one shot, the slow store is written by replay.
 * Forgetting here sets `state='dormant'` and never deletes. A dormant node is still reachable
 * by an explicit recall; it is only out of the projection. Deletion stays a separate, rarer,
 * explicitly-argued operation.
 */
export function sleep(nodes, { now = Date.now(), promoteAfter = 3, slowS = 30, dormantR = 0.15, replayR = 0.3, downscale = 0.95 } = {}) {
  const plan = { downscale, replayed: [], promoted: [], dormant: [] }
  const worthKeeping = node => (node.hits ?? 0) > 0 || node.kind === 'decision' || node.kind === 'constraint'
  for (const node of nodes) {
    if (node.pin) continue
    const S = node.S > 0 ? node.S : initialStability(GRADE.GOOD)
    const elapsed = node.at ? Math.max(0, (now - node.at) / DAY) : (node.elapsedDays ?? 0)
    const R = retrievability(elapsed, S)
    const sleeps = (node.sleeps ?? 0) + 1
    // The two fates are decided by one question: was this ever worth anything?
    //   - never retrieved and never load-bearing -> let it go quiet. No replay, no cost.
    //   - retrieved at least once, or a decision/constraint -> rescue it. This is the half of
    //     sleep that carries information: the replayed set is chosen, not sampled.
    if (R < replayR && worthKeeping(node)) plan.replayed.push(node.id)
    if (sleeps >= promoteAfter && S >= slowS && (node.tier ?? 0) === 0) plan.promoted.push(node.id)
    else if (R < dormantR && !worthKeeping(node) && sleeps >= 2) plan.dormant.push(node.id)
  }
  return plan
}

/** Decay rate per tier. Fast store forgets in weeks, slow store in years. */
export const TIER_RATE = Object.freeze({ 0: 1, 1: 4 })

export const NOTES = Object.freeze({
  whyNotExponential:
    '原式 R = e^(-t/S) 拟合真实保持率不如幂律 (Wixted & Ebbesen 1991)；且 S 单一标量无法表达"间隔越久、复习越有效"的交互项。',
  whyNotDualTrace:
    'FSRS-7 用 S_slow / S_fast 双迹 + 混合权重，比单迹更准，但需要 34 个权重和可观的复习日志。先做单迹，等 profile 里有几千条真实 activation 再升级；双迹正好对应本项目的快/慢两档记忆。',
  whyNoRandomForgetting:
    'MemoryBank 用随机数决定删除，导致不可审计、不可复现、且把唯一的副本扔掉。本项目的原则是"压缩只删可见性，不删存在性"，遗忘只降可见性。',
})
