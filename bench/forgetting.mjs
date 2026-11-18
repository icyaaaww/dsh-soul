/**
 * Forgetting bench — does the graph let go of the right things?
 *
 * `bench/replay.mjs` asks whether the card holds what the next turn needs, over a few days and
 * far below the node cap. This one asks the question that only shows up later: after months of
 * work and several times the cap in writes, is a decision still there on the day it is needed
 * again, and has the debris of finished work actually gone?
 *
 * The workload is synthetic and the answer key is behavioural (no model anywhere):
 *
 *   evergreen  a decision that is consulted again every week or two, for the whole run
 *   latent     a decision made once and first asked about three to six weeks later
 *   burst      a task worked intensively for a day or two (many uses, close together), then never
 *   one-off    a single turn about something that never comes up again
 *
 * A probe is the turn where an evergreen or latent decision is needed after a gap. At each probe:
 *
 *   lost        the row is gone (hard-deleted): nothing can bring it back
 *   hidden      the row exists but is not live (retired) when the turn starts
 *   on card     the card rendered for that turn carries the decision
 *   recall@3    asked by keyword, the decision is among the first three hits (and MRR)
 *   back        after the turn (cue, recall, tool use), the node is live again
 *
 * and across the run:
 *
 *   debris      share of live nodes that belong to work which will never be touched again
 *   false hits  nodes returned for a question the graph holds no answer to
 *   recall@card / churn, as in the replay bench
 *
 *   node bench/forgetting.mjs
 *   node bench/forgetting.mjs --days=120 --cap=500 --budget=600 --seed=7
 *   node bench/forgetting.mjs --json
 *   node bench/forgetting.mjs --days=42 --cap=100 --seed=7 --tiered
 *
 * Two maintenance regimes: `auto` is what the plugin does unattended, `sleep` adds a `/mem sleep`
 * at the end of every simulated day. Synthetic numbers measure the mechanism, not a real project.
 */

import { Store } from '../src/store.js'
import { rankedCandidates } from '../src/graph-search.js'
import * as memory from '../src/memory.js'
import * as graph from '../src/graph-memory.js'
import { entities, isInstance } from '../src/util.js'

const { MemoryBuffer, capture, noteTurnUse, noteUse, wireTurn, driftContext, cuesOf, recall, mergeDuplicates, consolidate } = memory
const { memoryView, render, retire } = graph

const flag = name => process.argv.some(a => a === `--${name}`)
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback
const DAYS = Number(arg('days', 90))
const CAP = Number(arg('cap', 200))
const BUDGET = Number(arg('budget', 600))
const SEED = Number(arg('seed', 20261111))
const TIERED = flag('tiered')
const COMPARE = flag('compare-retrieval')
const RANKED = flag('ranked')
const DAY = 86_400_000
const MIN = 60_000
const T0 = 1_790_000_000_000

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/* ------------------------------------------------------------------ */
/* workload                                                             */
/* ------------------------------------------------------------------ */

const msg = (type, content, extra = {}) => ({ type, data: { message: { content, ...extra } } })
const userEv = text => msg('user/message', [{ type: 'text', text }], { source: { kind: 'user' } })
const sayEv = (text, calls = []) => msg('assistant/message', [{ type: 'text', text }, ...calls])
const call = (name, path) => ({ type: 'tool-call', name, input: { path } })
const resultEv = (text, isError = false) => ({ type: 'tool/result', data: { content: [{ type: 'text', text }], isError } })

const PARAMS = ['连接池上限', '超时秒数', '重试次数', '缓存容量', '批量大小', '分页大小', '并发数', '队列长度', '心跳间隔', '快照周期']
const REASONS = ['并发太高', '请求太多', '偶发超时', '内存吃紧', '日志刷屏', '启动太慢']
const VARIANTS = ['批量', '流式', '懒加载', '分片', '幂等', '异步']
const AREAS = ['core', 'net', 'store', 'ui', 'cli', 'jobs']

/**
 * One simulated project. Each turn carries its topic and, for a probe, the decision it needs.
 * Topic names never repeat across classes, so "which work does this node belong to" is exact.
 */
function workload(days, seed) {
  const rand = rng(seed)
  const pick = list => list[Math.floor(rand() * list.length)]
  const topic = (cls, k) => ({ cls, k, key: `${cls}${k}`, file: `src/${AREAS[k % AREAS.length]}/${cls}${k}.js`, pkg: `${cls}lib${k}`, lastDay: -1, deadAfter: Infinity })

  // Decisions that stay load-bearing: one parameter each, consulted on a fixed rhythm.
  const evergreen = Array.from({ length: 8 }, (_, k) => ({ ...topic('ev', k), param: PARAMS[k % PARAMS.length], value: 16 + k * 8, period: 5 + (k * 3) % 9, phase: k % 5 }))
  // Decisions made once and asked about much later, with nothing in between.
  const latent = Array.from({ length: Math.max(4, Math.floor(days / 8)) }, (_, k) => {
    const born = 1 + Math.floor(rand() * Math.max(1, days - 45))
    return { ...topic('lt', k), param: PARAMS[(k + 3) % PARAMS.length], value: 3 + k, born, asked: born + 20 + Math.floor(rand() * 22) }
  })
  // Finished work: a new task every other day, worked hard and then dropped.
  const bursts = Array.from({ length: Math.ceil(days / 2) }, (_, k) => ({ ...topic('bu', k), start: k * 2, length: 1 + (rand() < 0.5 ? 1 : 0), turns: 8 + Math.floor(rand() * 7) }))
  for (const burst of bursts) burst.deadAfter = burst.start + burst.length - 1

  const establish = t => [
    userEv(`${t.pkg} 的${t.param}要定一下，看看 ${t.file}`),
    sayEv(`先读 ${t.file}`, [call('read', t.file)]), resultEv('ok'),
    sayEv(`决定 ${t.pkg} 的${t.param}定为 ${t.value}，因为 ${t.file} ${pick(REASONS)}`, [call('edit', t.file)]), resultEv('ok'),
  ]
  const consult = t => [
    userEv(`${t.pkg} 的${t.param}当时定的是多少？顺便核对 ${t.file}`),
    sayEv(`先读 ${t.file}`, [call('read', t.file)]), resultEv('ok'),
    sayEv(`${t.file} 已核对，${t.pkg} 的${t.param}保持原值，这一处不用动`),
  ]
  const work = (t, step) => {
    const fail = rand() < 0.15
    const events = [
      userEv(rand() < 0.7 ? `继续处理 ${t.file}，${t.pkg} 的问题` : `看看 ${t.pkg} 的报错`),
      sayEv(`先读 ${t.file}`, [call('read', t.file)]), resultEv(fail ? `Error E${t.k}${step} in ${t.file}` : 'ok', fail),
    ]
    if (rand() < 0.5) events.push(sayEv(`决定把 ${t.pkg} 的调用改成${pick(VARIANTS)}，因为 ${t.file} 里${pick(REASONS)}`, [call('edit', t.file)]), resultEv('ok'))
    else events.push(sayEv(`${t.file} 已检查，${t.pkg} 的第 ${step} 项正常，下一步看第 ${step + 1} 项`))
    return events
  }
  // Questions the graph cannot answer: ordinary words, no object it has ever seen.
  const NOWHERE = ['为什么部署脚本昨天超时了', '上次发布检查的结论是什么', '那个报错的问题后来正常了吗', '帮我看看请求太多的情况', '下一步检查什么比较好', '调用失败的原因有哪些']

  const turns = []
  let seq = 0
  let oneoff = 0
  for (let day = 0; day < days; day++) {
    let at = T0 + day * DAY + 9 * 60 * MIN
    const today = []
    const push = (t, events, extra = {}) => today.push({ topic: t, events, ...extra })

    if (day === 0) today.push({ topic: null, events: [userEv('不要改 package.json，提交前必须跑 npm test'), sayEv('好的，已记下这两条约束，之后都照此执行')] })
    for (const t of evergreen) {
      if (day < t.phase || (day - t.phase) % t.period !== 0) continue
      if (t.lastDay < 0) push(t, establish(t), { establishes: t.key })
      else push(t, consult(t), { probe: t.key, query: `${t.pkg} ${t.param}`, gapDays: day - t.lastDay })
      t.lastDay = day
    }
    for (const t of latent) {
      if (day === t.born) { push(t, establish(t), { establishes: t.key }); t.lastDay = day }
      else if (day === t.asked) { push(t, consult(t), { probe: t.key, query: `${t.pkg} ${t.param}`, gapDays: day - t.lastDay }); t.lastDay = day; t.deadAfter = day }
    }
    for (const t of bursts) {
      if (day < t.start || day >= t.start + t.length) continue
      const share = Math.ceil(t.turns / t.length)
      for (let i = 0; i < share; i++) push(t, work(t, (day - t.start) * share + i + 1))
    }
    for (let i = 0; i < 2; i++) {
      const t = { ...topic('oo', oneoff++), deadAfter: day }
      push(t, work(t, 1))
    }
    if (day % 3 === 2) today.push({ topic: null, events: [userEv(NOWHERE[(day / 3 | 0) % NOWHERE.length]), sayEv('这个问题在目前的记录里没有对应内容，需要先查原文')], nowhere: true })

    // Interleave the day's work the way a session does, a few minutes apart.
    for (let i = today.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [today[i], today[j]] = [today[j], today[i]] }
    // An establishing turn must precede its own probe if both fall on one day (they never do),
    // and bursts keep their step order.
    for (const turn of today) {
      at += (3 + Math.floor(rand() * 6)) * MIN
      turns.push({ ...turn, day, at, events: turn.events.map(event => ({ ...event, seq: seq++ })) })
    }
  }
  return turns
}

/* ------------------------------------------------------------------ */
/* simulation                                                           */
/* ------------------------------------------------------------------ */

const live = row => Boolean(row) && row.state === 'active' && !row.valid_to

function simulate(turns, mode) {
  let now = turns[0].at
  const store = new Store(':memory:', { now: () => now, maxNodes: CAP, tieredRetention: TIERED, rankedRecall: RANKED || COMPARE })
  store.rankedRecall = RANKED
  const paired = { legacy: [], ranked: [] }
  const measure = (query, matches) => {
    if (!COMPARE) return
    const arms = [['legacy', memory.legacyCandidates], ['ranked', rankedCandidates]]
    if (paired.legacy.length % 2) arms.reverse()
    for (const [arm, search] of arms) {
      const start = performance.now(), rows = search(store, 'p', query, 6), ms = performance.now() - start
      paired[arm].push({ ms, n: rows.length, rank: matches ? rows.findIndex(r => !r.valid_to && r.state !== 'stale' && matches(r.claim)) + 1 : null })
    }
  }
  const buffer = new MemoryBuffer()
  const owner = new Map()        // node id -> topic
  const keyNode = new Map()      // topic key -> id of the decision that will be asked about
  const probes = []
  const debris = []
  let needed = 0, onCard = 0, changed = 0, previous = null, falseHits = 0, nowhere = 0, written = 0
  const realNow = Date.now
  // Everything in the plugin that stamps a row reads the wall clock; pin it to the simulation.
  Date.now = () => now
  try {
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t]
      now = turn.at
      store.writeMeta('turns:p', t)
      const human = turn.events.find(e => e.type === 'user/message')
      const text = (human?.data?.message?.content ?? []).map(b => b.text ?? '').join('\n')
      const cues = cuesOf(text)
      const context = new Map(JSON.parse(store.readMeta('drift:p') ?? '[]'))
      const card = render(memoryView(store, 'p', { now, cues, turn: t, context }), { budget: BUDGET })
      if (previous !== null && card !== previous) changed++
      previous = card

      // recall@card, as in the replay bench: live nodes about what this turn touches.
      const touched = new Set([text, ...turn.events.flatMap(e => (e.data?.message?.content ?? [])
        .filter(b => b.type === 'tool-call').map(b => b.input?.path ?? ''))].flatMap(s => entities(s)).filter(isInstance))
      if (touched.size) for (const node of store.activeNodes('p')) {
        if (node.pin) continue
        const own = entities(node.claim).filter(isInstance)
        if (!own.some(e => touched.has(e))) continue
        needed++
        if (card.includes(node.claim) || own.some(e => e.includes('/') && card.includes(e.slice(e.lastIndexOf('/') + 1)) && card.includes(e.slice(0, e.lastIndexOf('/') + 1)))) onCard++
      }

      let probe = null
      if (turn.probe) {
        const id = keyNode.get(turn.probe)
        const row = id ? store.nodeRow(id) : null
        const answer = `${turn.topic.pkg} 的${turn.topic.param}定为 ${turn.topic.value}`
        const contains = text => new RegExp(answer + '(?![0-9])').test(text)
        measure(turn.query, contains)
        probe = { cls: turn.topic.cls, gapDays: turn.gapDays, id, lost: Boolean(id) && !row, notCaptured: !id, hidden: Boolean(row) && !live(row), card: Boolean(row) && card.includes(row.claim), answer3: contains(card), rank: 0, back: false }
        // The model asks by keyword when the card does not already answer.
        if (!probe.card) {
          const found = recall(store, 'p', turn.query, { limit: 6, turn: t, dynamicsView: memoryView(store, 'p', { now, cues: cuesOf(turn.query) }) })
          probe.rank = found.hits.findIndex(hit => hit.id === id) + 1
          probe.answer3 ||= found.hits.slice(0, 3).some(hit => !hit.supersededAt && hit.state !== 'stale' && contains(hit.claim))
        }
        probes.push(probe)
      }
      if (turn.nowhere) {
        measure(text, null)
        nowhere++
        falseHits += recall(store, 'p', text, { limit: 6, turn: t }).hits.length
      }

      // Then the turn happens, exactly as the plugin records it.
      noteUse(store, 'p', { text, source: 'cue', turn: t })
      for (const event of turn.events) buffer.push('s', event)
      const events = buffer.take('s')
      const used = noteTurnUse(store, 'p', events, { turn: t })
      const out = capture(store, 'p', events, { session: 's', turn: t, temporal: false })
      for (const id of out.ids ?? []) { owner.set(id, turn.topic); written++ }
      if (turn.establishes) {
        const made = (out.ids ?? []).map(id => store.nodeRow(id)).find(row => row?.kind === 'decision')
        if (made) keyNode.set(turn.establishes, made.id)
      }
      const failed = events.some(e => e.type === 'tool/result' && e.data?.isError)
      wireTurn(store, 'p', { used, created: out.ids ?? [], turn: t, outcome: { toolErrors: failed ? 1 : 0, complete: true } })
      driftContext(store, 'p', text)
      if (probe?.id) probe.back = live(store.nodeRow(probe.id))

      // Unattended maintenance every 20 turns; `/mem sleep` at the end of each day in `sleep`.
      const endOfDay = t === turns.length - 1 || turns[t + 1].day !== turn.day
      if (typeof memory.sleep === 'function') {
        if (t % 20 === 19) memory.sleep(store, 'p', { now, retire: mode === 'sleep' ? false : undefined, limit: CAP })
        if (mode === 'sleep' && endOfDay) memory.sleep(store, 'p', { now, retire: true, limit: CAP })
      } else {
        if (t % 20 === 19) { mergeDuplicates(store, 'p', { limit: CAP }); consolidate(store, 'p') }
        if (mode === 'sleep' && endOfDay) { mergeDuplicates(store, 'p', { limit: CAP }); consolidate(store, 'p'); retire(store, 'p', memoryView(store, 'p', { now })) }
      }
      if (endOfDay) {
        const rows = store.activeNodes('p', CAP * 4).filter(row => !row.pin)
        const dead = rows.filter(row => { const topic = owner.get(row.id); return topic && topic.deadAfter + 7 < turn.day })
        debris.push(rows.length ? dead.length / rows.length : 0)
      }
    }
    const states = Object.fromEntries(store.db.prepare("SELECT CASE WHEN valid_to IS NOT NULL AND state='active' THEN 'superseded' ELSE state END s, COUNT(*) n FROM node WHERE scope='p' GROUP BY s").all().map(row => [row.s, row.n]))
    return { paired, probes, debris, needed, onCard, churn: changed / Math.max(1, turns.length - 1), falseHits: nowhere ? falseHits / nowhere : 0, written, states, edges: store.graphStats('p').edges }
  } finally { Date.now = realNow; store.close() }
}

/* ------------------------------------------------------------------ */

const mean = list => list.length ? list.reduce((sum, v) => sum + v, 0) / list.length : 0
const share = (list, test) => list.length ? list.filter(test).length / list.length : 0
function summarize(result) {
  const row = list => ({
    n: list.length,
    answer3: share(list, p => p.answer3), notCaptured: share(list, p => p.notCaptured),
    lost: share(list, p => p.lost),
    hidden: share(list, p => p.hidden),
    card: share(list, p => p.card),
    recall3: share(list, p => p.card || (p.rank > 0 && p.rank <= 3)),
    mrr: mean(list.map(p => p.card ? 1 : p.rank ? 1 / p.rank : 0)),
    back: share(list, p => p.back),
  })
  return {
    ...(COMPARE ? { paired: Object.fromEntries(Object.entries(result.paired).map(([arm, rows]) => {
      const yes = rows.filter(r => r.rank !== null), no = rows.filter(r => r.rank === null), ms = rows.map(r => r.ms).sort((a,b) => a-b)
      return [arm, { positives: yes.length, hits3: yes.filter(r => r.rank > 0 && r.rank <= 3).length, negatives: no.length,
        abstained: no.filter(r => !r.n).length, falseHits: mean(no.map(r => r.n)), p50ms: ms[Math.ceil(ms.length * .5)-1], p95ms: ms[Math.ceil(ms.length * .95)-1] }]
    })) } : {}),
    evergreen: row(result.probes.filter(p => p.cls === 'ev')),
    latent: row(result.probes.filter(p => p.cls === 'lt')),
    all: row(result.probes),
    debris: mean(result.debris.slice(Math.floor(result.debris.length / 3))),
    recallAtCard: result.needed ? result.onCard / result.needed : 0,
    churn: result.churn, falseHits: result.falseHits, written: result.written, states: result.states, edges: result.edges,
  }
}

const turns = workload(DAYS, SEED)
const report = {}
for (const mode of ['auto', 'sleep']) report[mode] = summarize(simulate(turns, mode))

if (flag('json')) console.log(JSON.stringify({ days: DAYS, cap: CAP, budget: BUDGET, seed: SEED, tiered: TIERED, ranked: RANKED, turns: turns.length, report }, null, 2))
else {
  const pct = v => `${(v * 100).toFixed(1)}%`
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`synthetic project · ${DAYS} days · ${turns.length} turns · cap ${CAP} nodes · card ${BUDGET} B · seed ${SEED} · ${TIERED ? 'tiered' : 'legacy'}\n`)
  for (const mode of ['auto', 'sleep']) {
    const r = report[mode]
    if (COMPARE) console.log(`[${mode}] read-only paired retrieval:`, r.paired)
    console.log(`[${mode}] ${r.written} nodes written · left: ${Object.entries(r.states).map(([k, v]) => `${k} ${v}`).join(', ')} · ${r.edges} edges`)
    console.log('  ' + pad('probe', 11) + pad('n', 5) + pad('lost', 8) + pad('hidden', 8) + pad('on card', 9) + pad('recall@3', 10) + pad('MRR', 7) + 'back')
    for (const cls of ['evergreen', 'latent', 'all']) {
      const p = r[cls]
      console.log('  ' + pad(cls, 11) + pad(p.n, 5) + pad(pct(p.lost), 8) + pad(pct(p.hidden), 8) + pad(pct(p.card), 9) + pad(pct(p.recall3), 10) + pad(p.mrr.toFixed(2), 7) + pct(p.back))
    }
    console.log(`  answer on card or top 3: ${pct(r.all.answer3)} · uncaptured ${pct(r.all.notCaptured)}`)
    console.log(`  debris ${pct(r.debris)} of live nodes · false hits ${r.falseHits.toFixed(1)}/query · recall@card ${pct(r.recallAtCard)} · churn ${pct(r.churn)}\n`)
  }
  console.log('lost = row deleted; hidden = retired when needed; back = live again after the turn.')
  console.log('(synthetic: measures the mechanism, not a real project)')
}
