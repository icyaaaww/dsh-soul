import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRADE, W, retrievability, intervalFor, initialStability, initialDifficulty,
  nextDifficulty, nextStability, review, initialState, gradeOf, baseLevel,
  exponentialAccumulator, orderByRecency, orderByDynamics, schedule, sleep,
} from '../src/memory-dynamics.js'

const DAY = 86_400_000

/**
 * The four assertions MemoryBank never had. Its curve shipped as `math.exp(-t / 5*S)`, which
 * Python parses as `((-t)/5)*S`, so a memory that was recalled decayed *faster* — and the bug
 * survived three years and a paper. Every one of these would have caught it in one line.
 */
test('retrievability falls with time — the direction a decay curve must point', () => {
  for (const S of [0.5, 1, 3, 30, 365]) {
    let last = Infinity
    for (const t of [0, 0.5, 1, 2, 7, 30, 90, 365]) {
      const R = retrievability(t, S)
      assert.ok(R < last, `S=${S}: R(${t})=${R} must be below the previous point`)
      last = R
    }
  }
})

test('retrievability rises with stability — remembering must not accelerate forgetting', () => {
  // This is the exact inversion MemoryBank shipped: R(1d, S=10) = 0.135 while R(1d, S=1) = 0.819.
  let last = -Infinity
  for (const S of [0.5, 1, 3, 10, 30, 100, 1000]) {
    const R = retrievability(3, S)
    assert.ok(R > last, `R(3, S=${S})=${R} must exceed the previous stability's value`)
    last = R
  }
  assert.ok(retrievability(1, 10) > retrievability(1, 1), 'a strong memory is not the first to go')
})

test('R(S, S) = 0.9, so stability reads as the 90% interval', () => {
  for (const S of [0.5, 1, 7, 90, 3650]) {
    assert.ok(Math.abs(retrievability(S, S) - 0.9) < 1e-12, `R(${S},${S}) = ${retrievability(S, S)}`)
  }
  assert.ok(Math.abs(intervalFor(0.9, 12) - 12) < 1e-9, 'intervalFor inverts the curve')
})

test('a successful review never shrinks stability', () => {
  for (const start of [0.4, 1, 10, 100]) {
    for (const elapsed of [0, 0.01, 1, 30]) {
      for (const grade of [GRADE.HARD, GRADE.GOOD, GRADE.EASY]) {
        const st = { S: start, D: 5, at: 0 }
        const next = review(st, grade, elapsed)
        assert.ok(next.S >= start - 1e-9,
          `S=${start} grade=${grade} t=${elapsed} gave S=${next.S} — reviewing must not hurt`)
      }
    }
  }
})

test('a lapse collapses stability but floors it, so one bad day is recoverable', () => {
  let st = initialState(GRADE.GOOD)
  for (const gap of [1, 3, 7, 21]) st = review(st, GRADE.GOOD, gap)
  const mature = st.S
  const lapsed = review(st, GRADE.LAPSE, 3)
  assert.ok(lapsed.S < mature * 0.5, `lapse kept ${lapsed.S / mature} of ${mature}`)
  assert.ok(lapsed.S > 0.1, 'a lapse must not annihilate the memory')
})

test('spacing beats massing at equal review count — the whole point of the schedule', () => {
  const run = gaps => {
    let st = initialState(GRADE.GOOD, 0)
    for (const gap of gaps) st = review(st, GRADE.GOOD, gap)
    return st.S
  }
  const massed = run([0.5, 0.5, 0.5, 0.5, 0.5])
  const spaced = run([0.5, 1, 2, 4, 8])
  assert.ok(spaced > massed * 2, `spaced ${spaced.toFixed(2)}d vs massed ${massed.toFixed(2)}d`)
})

test('difficulty mean-reverts instead of ratcheting', () => {
  let D = initialDifficulty(GRADE.GOOD)
  for (let i = 0; i < 20; i++) D = nextDifficulty(D, GRADE.LAPSE)
  const floor = nextDifficulty(D, GRADE.LAPSE)
  assert.ok(floor <= 10 && floor >= 1, 'stays in range')
  assert.ok(D <= 10, 'twenty lapses do not leave the scale')
  const recovered = nextDifficulty(D, GRADE.EASY)
  assert.ok(recovered < D, 'an easy review must move difficulty back down')
})

test('initial state and stability stay inside the model bounds', () => {
  for (const grade of [GRADE.LAPSE, GRADE.HARD, GRADE.GOOD, GRADE.EASY]) {
    const st = initialState(grade)
    assert.ok(st.S > 0 && st.S <= 36_500)
    assert.ok(st.D >= 1 && st.D <= 10)
    assert.ok(Math.abs(st.D - initialDifficulty(grade)) < 1e-12)
  }
  assert.equal(initialStability(1), W[0])
})

test('implicit grades never invent a review that did not happen', () => {
  assert.equal(gradeOf({}), null, 'nothing surfaced, nothing learned')
  assert.equal(gradeOf({ surfaced: false, corrected: true }), GRADE.LAPSE,
    'a violation is observable even if the card never showed it')
  assert.equal(gradeOf({ surfaced: true }), GRADE.GOOD)
  assert.equal(gradeOf({ surfaced: true, diverged: true }), GRADE.HARD)
  assert.equal(gradeOf({ surfaced: true, verified: true }), GRADE.EASY)
})

test('ACT-R base level rises with frequency and falls with delay', () => {
  const now = 100 * DAY
  const once = baseLevel([now - 5 * DAY], now)
  const twice = baseLevel([now - 5 * DAY, now - 4 * DAY], now)
  const older = baseLevel([now - 50 * DAY], now)
  assert.ok(twice > once, 'frequency raises activation')
  assert.ok(once > older, 'delay lowers activation')
  assert.equal(baseLevel([], now), -Infinity)
})

test('the exponential accumulator is not ACT-R, and this is why we keep the log', () => {
  // The difference shows up after a silence. Under a power law, frequency survives a long gap
  // — ten touches a month ago still outrank one touch yesterday. Under exponential decay the
  // old trace is simply gone. Anyone who "optimises" ACT-R into an accumulator loses this.
  const now = 100 * DAY
  const frequentOld = [20, 22, 24, 26, 28, 30, 32, 34, 36, 38].map(d => now - d * DAY)
  const singleNew = [now - 1 * DAY]
  assert.ok(baseLevel(frequentOld, now) > baseLevel(singleNew, now),
    'ACT-R: frequency made a month ago still beats a single recent touch')

  let frequent = 0
  for (let i = 0; i < 10; i++) frequent = exponentialAccumulator(frequent, 2, { tau: 5 })
  frequent *= Math.exp(-20 / 5) // then twenty days of silence
  const single = exponentialAccumulator(0, 1, { tau: 5 })
  assert.ok(frequent < single, 'the accumulator forgets the frequency entirely — hence: keep the log')
})

test('ordering is a pure function of state', () => {
  const nodes = [
    { id: 'a', kind: 'decision', claim: '甲', pin: 0, seq: 2, S: 5, D: 5, at: 0 },
    { id: 'b', kind: 'constraint', claim: '乙', pin: 1, seq: 1, S: 5, D: 5, at: 0 },
  ]
  const first = orderByDynamics(nodes, 10 * DAY).map(n => n.id)
  const second = orderByDynamics(nodes, 10 * DAY).map(n => n.id)
  assert.deepEqual(first, second)
  assert.equal(first[0], 'b', 'pinned first, regardless of retrievability')
})

test('pinned constraints survive any budget, and the budget is never exceeded', () => {
  const nodes = [
    { id: 'pin', kind: 'constraint', claim: '不要改 package.json', pin: 1, seq: 1, S: 5, at: 0 },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`, kind: 'progress', claim: `第 ${i} 步的输出已经写入 files/mod${i}.js`, pin: 0, seq: i + 2, S: 5, at: 0,
    })),
  ]
  const budget = 200
  const { picked, spent } = schedule(nodes, { now: 60 * DAY, budget, policy: 'dynamics' })
  assert.ok(picked.some(n => n.id === 'pin'))
  assert.ok(spent <= budget, `spent ${spent} > ${budget}`)
})

test('the schedule rotates while newest-first starves', () => {
  // The mechanism claim in one test: a static order (any static order) keeps showing the same
  // nodes forever. Only a time-dependent order reaches the rest. Reviews are simulated, because
  // a schedule that never updates state has nothing to rotate against.
  const make = () => Array.from({ length: 60 }, (_, i) => ({
    id: `n${i}`, kind: i < 5 ? 'constraint' : 'decision',
    claim: `节点 ${i} 的载荷性标识符 mod${i}.js`, pin: i < 5 ? 1 : 0, seq: i,
    S: 3.17, D: 5, at: -30 * DAY,
  }))
  const cover = policy => {
    const state = new Map(make().map(n => [n.id, { ...n }]))
    const seen = new Set()
    for (let turn = 0; turn < 40; turn++) {
      const now = turn * 0.2 * DAY
      for (const node of schedule([...state.values()], { now, budget: 400, policy }).picked) {
        seen.add(node.id)
        const cur = state.get(node.id)
        const elapsed = (now - cur.at) / DAY
        const next = review(cur, GRADE.GOOD, elapsed, { now })
        state.set(node.id, { ...cur, S: next.S, D: next.D, at: now })
      }
    }
    return seen.size
  }
  const recency = cover('recency')
  const dynamics = cover('dynamics')
  assert.ok(dynamics > recency * 1.5,
    `rotation covered ${dynamics}, recency covered ${recency}`)
})

test('forgetting demotes, it does not delete', () => {
  const now = 200 * DAY
  const nodes = [
    // A lapsed, never-retrieved progress note left alone for four months.
    { id: 'old', kind: 'progress', claim: '陈旧的步骤', pin: 0, S: 0.4, at: now - 120 * DAY, hits: 0, sleeps: 2 },
    // The same age and the same stability, but pinned: it can never be demoted.
    { id: 'pin', kind: 'constraint', claim: '不要改 package.json', pin: 1, S: 0.4, at: now - 120 * DAY, hits: 0, sleeps: 9 },
    // Retrieved once, so it earned its place even though it is now unreadable.
    { id: 'used', kind: 'decision', claim: '走过 anchor 而不是摘要', pin: 0, S: 0.4, at: now - 120 * DAY, hits: 1, sleeps: 2 },
  ]
  const plan = sleep(nodes, { now })
  assert.deepEqual(plan.dormant, ['old'], 'only the never-used stale note is demoted')
  assert.ok(!plan.dormant.includes('pin'), 'a pinned constraint is never demoted')
  assert.ok(!plan.dormant.includes('used'), 'a node that was retrieved once is not demoted')
})
