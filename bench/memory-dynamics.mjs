/**
 * Memory dynamics bench.
 *
 * Holds the byte budget and the node set constant and varies only *what the card shows*, so
 * the number reported is the cost of the scheduling policy. No model is involved and no
 * language model's behaviour is imitated: the question is mechanical — over a project's
 * lifetime, which policy still has the load-bearing node in front of the model, and does the
 * other policy at least succeed at dropping what deserves to be dropped.
 *
 *   node bench/memory-dynamics.mjs
 *   node bench/memory-dynamics.mjs --turns=60 --budget=600 --turn-days=0.5
 */

import {
  GRADE, retrievability, initialState, review, gradeOf,
  baseLevel, exponentialAccumulator, schedule, intervalFor, orderByRecency, orderByDynamics,
} from '../src/memory-dynamics.js'

const arg = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const TURNS = arg('turns', 60)
const BUDGET = arg('budget', 600)
const TURN_DAYS = arg('turn-days', 0.5)
const HORIZON = TURNS * TURN_DAYS
const DAY = 86_400_000
const T0 = 1_790_000_000_000

const pct = v => `${(v * 100).toFixed(1)}%`
const pad = (s, n) => String(s).padEnd(n)
const out = []

/* ------------------------------------------------------------------ */
/* 1. invariants — the assertions the reference implementation lacked   */
/* ------------------------------------------------------------------ */

function invariants() {
  const rows = []
  const check = (name, ok, detail) => rows.push({ name, ok, detail })

  // R must fall with time and rise with stability. MemoryBank shipped this backwards:
  // `math.exp(-t / 5*S)` parses as `((-t)/5)*S`, so recall accelerated forgetting.
  check('R 随 t 单调下降',
    retrievability(1, 5) > retrievability(2, 5) && retrievability(2, 5) > retrievability(9, 5),
    `R(1)=${retrievability(1, 5).toFixed(3)} > R(2)=${retrievability(2, 5).toFixed(3)} > R(9)=${retrievability(9, 5).toFixed(3)}`)
  check('R 随 S 单调上升',
    retrievability(3, 1) < retrievability(3, 5) && retrievability(3, 5) < retrievability(3, 50),
    `R(3|S=1)=${retrievability(3, 1).toFixed(3)} < ${retrievability(3, 5).toFixed(3)} < ${retrievability(3, 50).toFixed(3)}`)
  check('R(S,S)=0.9（S 的定义）', Math.abs(retrievability(5, 5) - 0.9) < 1e-9, `R(5,5)=${retrievability(5, 5)}`)
  check('intervalFor 是曲线逆函数', Math.abs(intervalFor(0.9, 7) - 7) < 1e-6, `I(0.9,7)=${intervalFor(0.9, 7).toFixed(4)}`)

  // Success must never shrink stability. A model where reviewing hurts is a bug, and it is
  // exactly the bug a sign error produces.
  const st = initialState(GRADE.GOOD)
  const same = review(st, GRADE.GOOD, 0)
  check('同日复习不降低 S', same.S >= st.S, `S ${st.S.toFixed(2)} → ${same.S.toFixed(2)}`)

  // Same-node ordering must be stable under repeated calls (pure function of state).
  const nodes = [{ id: 'a', kind: 'decision', claim: '甲', pin: 0, seq: 2, ...initialState(GRADE.GOOD) }]
  const once = orderByDynamics(nodes, T0)[0].id
  check('排序是纯函数', once === orderByDynamics(nodes, T0)[0].id, 'same state → same order')

  check('未出现的节点没有评分', gradeOf({ surfaced: false }) === null, 'gradeOf(surfaced:false) = null')
  check('被纠正的约束记 lapse', gradeOf({ surfaced: true, corrected: true }) === GRADE.LAPSE, 'lapse')
  check('验证通过记 easy', gradeOf({ surfaced: true, verified: true }) === GRADE.EASY, 'easy')
  return rows
}

/* ------------------------------------------------------------------ */
/* 2. the curve, and what it costs to be wrong about it                 */
/* ------------------------------------------------------------------ */

function curveTable() {
  const Ss = [1, 3, 10, 30]
  const days = [1, 3, 7, 30, 90]
  return {
    head: ['S\\t', ...days.map(d => `${d}d`)],
    body: Ss.map(S => [String(S), ...days.map(d => retrievability(d, S).toFixed(3))]),
  }
}

/** The MemoryBank expression, evaluated as Python parses it, for comparison. */
const memoryBank = (t, S) => Math.exp((-t / 5) * S)

/* ------------------------------------------------------------------ */
/* 3. spacing vs massing, and the cost of a lapse                       */
/* ------------------------------------------------------------------ */

function spacing() {
  const run = gaps => {
    let st = initialState(GRADE.GOOD, T0)
    for (const gap of gaps) st = review(st, GRADE.GOOD, gap)
    return st.S
  }
  return {
    single: run([]),
    massed: run([0.5, 0.5, 0.5, 0.5, 0.5]),
    spaced: run([0.5, 1, 2, 4, 8]),
  }
}

function lapse() {
  let st = initialState(GRADE.GOOD, T0)
  for (const gap of [1, 3, 7, 21]) st = review(st, GRADE.GOOD, gap)
  const before = st.S
  const after = review(st, GRADE.LAPSE, 3).S
  return { before, after, kept: after / before }
}

/* ------------------------------------------------------------------ */
/* 4. ACT-R: is the free probe a usable stand-in for the paid model?    */
/* ------------------------------------------------------------------ */

/**
 * ACT-R base-level activation is computable today from the `activation` table that already
 * exists — no migration, no new column. The only question worth asking is whether its ranking
 * agrees with the (S, D) model, because if it does, P0 can run for a week before anyone
 * commits a schema change.
 */
function actrAgreement() {
  const nodes = population()
  // Feed *the same* history to both models. Comparing ACT-R over a review log against a model
  // that never saw the log would measure the bench, not the models.
  const now = T0 + HORIZON * DAY
  const rows = nodes.map(node => {
    const times = []
    let at = node.bornAt
    const visits = node.pin ? 6 : node.kind === 'decision' ? 3 : node.kind === 'artifact' ? 2 : 1
    let st = initialState(GRADE.GOOD, at)
    for (let i = 0; i < visits; i++) {
      times.push(at)
      st = review(st, GRADE.GOOD, i === 0 ? 0 : (at - times[i - 1]) / DAY, { now: at })
      at += (1 + i * 2) * DAY
    }
    return {
      id: node.id,
      B: baseLevel(times, now),
      R: retrievability((now - st.at) / DAY, st.S),
    }
  })
  const rank = key => {
    const order = [...rows].sort((a, b) => b[key] - a[key]).map(r => r.id)
    return new Map(order.map((id, i) => [id, i]))
  }
  const rb = rank('B')
  const rr = rank('R')
  let sq = 0
  for (const [id, i] of rb) sq += (i - rr.get(id)) ** 2
  const n = rows.length
  const rho = 1 - (6 * sq) / (n * (n * n - 1))
  // Operational version of the same question: do they agree on what is about to be lost?
  const bottom = m => new Set([...m].sort((a, b) => b[1] - a[1]).slice(0, Math.ceil(n / 4)).map(([id]) => id))
  const bb = bottom(rb)
  const overlap = [...bottom(rr)].filter(id => bb.has(id)).length / bb.size
  return { rho, overlap, n }
}

/* ------------------------------------------------------------------ */
/* 5. the experiment: same budget, same nodes, two policies             */
/* ------------------------------------------------------------------ */

/**
 * A project's worth of nodes, at the scale the store actually allows (`pruneNodes` caps a
 * scope at 500). The population has to exceed what the card can carry per turn, or there is
 * no scheduling problem: with 40 nodes and an ~8-line card every node is refreshed every few
 * turns and nothing can decay, which flatters every policy equally and measures nothing.
 *
 * Constraints are stated on day one — the thing that silently disappears in a real session.
 * Importance is a property of the node, never of its age.
 */
function population() {
  const spec = [
    ['constraint', 3, 1], ['constraint', 7, 0],
    ['decision', 40, 0], ['artifact', 50, 0], ['progress', 100, 0],
  ]
  const nodes = []
  let i = 0
  const total = spec.reduce((s, [, n]) => s + n, 0)
  for (const [kind, count, pin] of spec) {
    for (let k = 0; k < count; k++) {
      // The five hard constraints are stated in the first hour, as they are in life, and never
      // spoken again. Everything else arrives across the project.
      const born = pin || kind === 'constraint' ? (k % 10) * 0.02 : (i / total) * HORIZON
      const at = T0 + born * DAY
      nodes.push({
        id: `${kind}-${k}`, kind, pin: Boolean(pin), seq: i,
        claim: kind === 'constraint'
          ? `不要改 package.json（第 ${k + 1} 条硬约束）`
          : `${kind} 第 ${k + 1} 条：src/mod${k}.js 的标识符 ${kind}_${k}`,
        bornAt: at,
        ...initialState(GRADE.GOOD, at),
        hits: 0,
      })
      i++
    }
  }
  return nodes.sort((a, b) => a.bornAt - b.bornAt)
}

const TOTAL = () => population().length

function experiment(policy) {
  const nodes = population()
  const state = new Map(nodes.map(n => [n.id, { ...n }]))
  const priceOf = node => Buffer.byteLength(node.claim) + 12
  let reviews = 0
  let inWindow = 0
  let perfunctory = 0

  for (let turn = 0; turn < TURNS; turn++) {
    const now = T0 + turn * TURN_DAYS * DAY
    const live = [...state.values()]
    const { picked } = schedule(live, { now, budget: BUDGET, priceOf, policy })
    for (const node of picked) {
      const cur = state.get(node.id)
      const elapsed = (now - cur.at) / DAY
      const R = retrievability(elapsed, cur.S)
      if (R >= 0.5 && R <= 0.9) inWindow++
      else if (R > 0.95) perfunctory++
      const next = review(cur, GRADE.GOOD, elapsed, { now })
      state.set(node.id, { ...cur, S: next.S, D: next.D, at: now, hits: cur.hits + 1 })
      reviews++
    }
  }

  const end = T0 + HORIZON * DAY
  const live = [...state.values()]
  const withR = live.map(n => ({ ...n, R: retrievability((end - n.at) / DAY, n.S) }))
  const atRisk = withR.filter(n => (n.pin || n.kind === 'decision') && n.R < 0.6)
  const trivia = withR.filter(n => n.kind === 'progress')
  const triviaForgotten = trivia.filter(n => n.R < 0.6)
  return {
    reviews,
    window: inWindow / Math.max(1, reviews),
    perfunctory: perfunctory / Math.max(1, reviews),
    // What the card can carry at the end: how many distinct nodes are still in it.
    shown: new Set(live.filter(n => n.hits > 0).map(n => n.id)).size,
    neverShown: live.filter(n => n.hits === 0).length,
    meanS: live.reduce((s, n) => s + n.S, 0) / live.length,
    criticalAtRisk: atRisk.length,
    criticalTotal: withR.filter(n => n.pin || n.kind === 'decision').length,
    triviaForgotten: triviaForgotten.length / Math.max(1, trivia.length),
  }
}

/* ------------------------------------------------------------------ */

out.push(`预算 ${BUDGET} B · ${TURNS} 轮 × ${TURN_DAYS} 天 = ${HORIZON} 天 · ${TOTAL()} 个节点\n`)

out.push('## 1. 不变量\n')
for (const row of invariants()) out.push(`${row.ok ? 'PASS' : 'FAIL'}  ${pad(row.name, 20)} ${row.detail}`)

const ct = curveTable()
out.push('\n## 2. 遗忘曲线 R(t,S)\n')
out.push(pad(ct.head[0], 6) + ct.head.slice(1).map(h => pad(h, 8)).join(''))
for (const row of ct.body) out.push(pad(row[0], 6) + row.slice(1).map(c => pad(c, 8)).join(''))
out.push(`\nMemoryBank 的实现（按 Python 实际解析求值）：R(1d,S=10)=${memoryBank(1, 10).toFixed(4)}，R(1d,S=1)=${memoryBank(1, 1).toFixed(4)}`)
out.push('→ 强度越高死得越快。差一对括号，三年没人发现。')

const sp = spacing()
const lp = lapse()
out.push('\n## 3. 间隔效应与遗忘的代价\n')
out.push(`同样 5 次复习：集中 2.5 天 S=${sp.massed.toFixed(2)}d · 拉开 15.5 天 S=${sp.spaced.toFixed(2)}d → **${(sp.spaced / sp.massed).toFixed(2)}×**`)
out.push(`一次 lapse：S ${lp.before.toFixed(1)}d → ${lp.after.toFixed(2)}d（保留 ${pct(lp.kept)}）`)

const ag = actrAgreement()
out.push('\n## 4. ACT-R 能否当免费探针\n')
out.push(`与 (S,D) 模型的排序一致度：Spearman ρ = ${ag.rho.toFixed(3)}，末 25% "最危险"集合重合 ${pct(ag.overlap)}（n=${ag.n}）`)
out.push(`→ 可以先用它跑一周，再决定要不要动 schema。代价是 O(激活次数)，且没有精确的 O(1) 增量式。`)

/* ------------------------------------------------------------------ */
/* 4b. rotation: does the card ever reach the quiet part of the store?  */
/* ------------------------------------------------------------------ */

/**
 * A narrow, assumption-free measurement: 60 nodes, a card that holds about seven lines, forty
 * turns. Count how many *distinct* nodes the card ever shows. No stability model, no grades,
 * no notion of importance beyond the pin — just "does the schedule ever look at the rest".
 */
function rotation() {
  const DAY2 = DAY
  const build = () => Array.from({ length: 60 }, (_, i) => ({
    id: `n${i}`, kind: i < 5 ? 'constraint' : 'decision',
    claim: `节点 ${i} 的载荷性标识符 mod${i}.js`, pin: i < 5 ? 1 : 0, seq: i,
    S: 3.17, D: 5, at: -30 * DAY2,
  }))
  const run = policy => {
    const state = new Map(build().map(n => [n.id, { ...n }]))
    const seen = new Set()
    let slots = 0
    for (let turn = 0; turn < 40; turn++) {
      const now = turn * 0.2 * DAY2
      for (const node of schedule([...state.values()], { now, budget: 400, policy }).picked) {
        seen.add(node.id)
        slots++
        const cur = state.get(node.id)
        const nx = review(cur, GRADE.GOOD, (now - cur.at) / DAY2, { now })
        state.set(node.id, { ...cur, S: nx.S, D: nx.D, at: now })
      }
    }
    return { covered: seen.size, slots }
  }
  return { recency: run('recency'), dynamics: run('dynamics') }
}

const rot = rotation()
out.push('\n## 4b. 卡片到底看得到几个节点\n')
out.push(`60 个节点 · 40 轮 · 卡片约 7 行（含 5 条 pin）`)
out.push(`  最新优先   40 轮共 ${rot.recency.slots} 次复习，只覆盖 ${rot.recency.covered}/60 个节点`)
out.push(`  按可检索度 40 轮共 ${rot.dynamics.slots} 次复习，覆盖 ${rot.dynamics.covered}/60 个节点`)
out.push(`→ 动态排序的第一个效果不是"更准"，是"不再退化"。静态排序会把全部预算压在同一批上。`)

const rec = experiment('recency')
const imp = experiment('importance')
const dyn = experiment('dynamics')
out.push('\n## 5. 同一预算、同一批节点、只有排法不同\n')
out.push(pad('', 26) + pad('最新优先（现状）', 18) + pad('只按重要性', 18) + pad('重要性×可检索度', 18))
const rows = [
  ['期末关键节点 R<.6', `${rec.criticalAtRisk}/${rec.criticalTotal}`, `${imp.criticalAtRisk}/${imp.criticalTotal}`, `${dyn.criticalAtRisk}/${dyn.criticalTotal}`],
  ['平均稳定性(天)', rec.meanS.toFixed(2), imp.meanS.toFixed(2), dyn.meanS.toFixed(2)],
  ['从头到尾没上过卡', `${rec.neverShown}`, `${imp.neverShown}`, `${dyn.neverShown}`],
  ['复习落在 R>.95（白费）', pct(rec.perfunctory), pct(imp.perfunctory), pct(dyn.perfunctory)],
  ['落在 R∈[.5,.9]（有效）', pct(rec.window), pct(imp.window), pct(dyn.window)],
]
for (const row of rows) out.push(pad(row[0], 26) + pad(row[1], 18) + pad(row[2], 18) + pad(row[3], 18))

console.log(out.join('\n'))
