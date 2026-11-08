/**
 * Replay bench — does the card hold what the next turn actually needs?
 *
 * Ground truth is behavioural and needs no model: a non-pinned node is *needed* at turn t when
 * turn t's user message or tool paths name one of its instance entities. The card is rendered
 * before the turn, from the graph as it stood. Three policies, same graph, same bytes:
 *
 *   recency   1.5: pinned, kind, newest
 *   due       2.0: importance × due(A) — lower activation ranks higher (reproduced here only)
 *   need      2.1: ACT-R need with cue, working memory, graph context and lateral inhibition
 *
 * Workload: synthetic by default — topics reused with power-law (Zipf) probability, which is
 * the environmental regularity Anderson & Schooler measured — or a real DSH session log:
 *
 *   node bench/replay.mjs
 *   node bench/replay.mjs --turns=120 --budget=600
 *   node bench/replay.mjs --log=path/to/session.v3.jsonl
 *   node bench/replay.mjs --fit            grid-search d, leak, beta, inhibition on the workload
 *
 * Reported: recall@card (needed nodes on the card / needed nodes), card churn (fraction of turns
 * whose card differs from the previous one — every change appends a runtime-context snapshot),
 * and mean card bytes. Synthetic numbers measure the mechanism, not a real project.
 */

import { readFileSync } from 'node:fs'
import { Store } from '../src/store.js'
import { MemoryBuffer, capture, noteTurnUse, noteUse, wireTurn, driftContext, projectionText, cuesOf } from '../src/memory.js'
import { memoryView, render, PARAMS, availability, importanceOf } from '../src/graph-memory.js'
import { project } from '../src/skeleton.js'
import { entities, isInstance } from '../src/util.js'

const flag = name => process.argv.some(a => a === `--${name}`)
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback
const TURNS = Number(arg('turns', 120))
const BUDGET = Number(arg('budget', 600))
const LOG = arg('log', null)
// --truth=tools: only tool paths count as "needed" (the user message is not part of the answer key).
const TRUTH = arg('truth', 'all')
const DAY = 86_400_000
const T0 = 1_790_000_000_000

/* ------------------------------------------------------------------ */
/* workload                                                             */
/* ------------------------------------------------------------------ */

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const msg = (type, content, extra = {}) => ({ type, data: { message: { content, ...extra } } })
const userEv = text => msg('user/message', [{ type: 'text', text }], { source: { kind: 'user' } })
const sayEv = (text, calls = []) => msg('assistant/message', [{ type: 'text', text }, ...calls])
const call = (name, path) => ({ type: 'tool-call', name, input: { path } })
const resultEv = (text, isError = false) => ({ type: 'tool/result', data: { content: [{ type: 'text', text }], isError } })

/** Turns as arrays of events, each with a wall-clock time. */
function synthetic(turns, seed = 20261108) {
  const rand = rng(seed)
  const topics = Array.from({ length: 40 }, (_, k) => ({ k, file: `src/area${k % 6}/mod${k}.js`, pkg: `lib${k}` }))
  // Zipf over a slowly rotating ranking: a few topics dominate, and the dominant ones change.
  const pick = t => {
    const shift = Math.floor(t / 30)
    let r = rand() * 4.3 // ≈ H(40)
    for (let i = 1; i <= 40; i++) { r -= 1 / i; if (r <= 0) return topics[(i - 1 + shift * 7) % 40] }
    return topics[0]
  }
  const out = []
  let at = T0
  for (let t = 0; t < turns; t++) {
    at += (rand() < 0.1 ? 0.8 : 0.03) * DAY
    const topic = pick(t)
    const events = []
    if (t === 0) events.push(userEv('不要改 package.json，提交前必须跑 npm test'))
    else events.push(userEv(rand() < 0.7 ? `继续处理 ${topic.file}，${topic.pkg} 的问题` : `看看 ${topic.pkg} 的报错`))
    const fail = rand() < 0.15
    events.push(sayEv(`先读 ${topic.file}`, [call('read', topic.file)]), resultEv(fail ? `Error E${topic.k}01 in ${topic.file}` : 'ok', fail))
    if (rand() < 0.5) events.push(sayEv(`决定把 ${topic.pkg} 的调用改成批量，因为 ${topic.file} 里请求太多`, [call('edit', topic.file)]), resultEv('ok'))
    else events.push(sayEv(`${topic.file} 已检查，${topic.pkg} 正常，下一步看 mod${(topic.k + 1) % 40}`))
    out.push({ at, events })
  }
  return out
}

/** A DSH session log (uncompressed JSONL): group events into turns at each human message. */
function fromLog(path) {
  const turns = []
  let current = null
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const type = event?.type
    if (!type) continue
    const source = event.data?.source?.kind ?? event.data?.message?.source?.kind
    if (type === 'user/message' && source === 'runtime-context') continue
    if (type === 'user/message' && source === 'user') {
      if (current) turns.push(current)
      current = { at: Number(event.at ?? event.time ?? 0) || null, events: [] }
    }
    if (current && ['user/message', 'assistant/message', 'tool/result'].includes(type)) current.events.push({ type, seq: event.seq, data: event.data })
  }
  if (current) turns.push(current)
  let at = T0
  for (const turn of turns) { at = turn.at ?? at + 0.03 * DAY; turn.at = at }
  return turns
}

/* ------------------------------------------------------------------ */
/* policies                                                             */
/* ------------------------------------------------------------------ */

/** 2.0's schedule, reproduced for comparison: lower activation ranks higher. */
function dueCard(view, budget) {
  const due = A => A <= 0.95 ? 1 + (1 - A) : 1 / (1 + 4 * (A - 0.95))
  const ordered = [...view.list].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0)
    || importanceOf(b) * due(b.A) - importanceOf(a) * due(a.A) || b.seq - a.seq)
  const lines = ['[骨架]']
  let spent = Buffer.byteLength(lines[0])
  for (const entry of ordered) {
    const line = `- ${entry.kind}: ${entry.claim}`
    const price = Buffer.byteLength(line) + 1
    if (spent + price > budget) continue
    lines.push(line); spent += price
  }
  return lines.join('\n')
}

function cardFor(policy, store, now, cues, turn, params) {
  if (params.noCue) cues = null
  if (policy === 'recency') return project(store.activeNodes('p', 200), { budget: BUDGET })
  if (policy === 'due') return dueCard(memoryView(store, 'p', { now }), BUDGET)
  return render(memoryView(store, 'p', { now, cues, turn, params, context: new Map(JSON.parse(store.readMeta('drift:p') ?? '[]')) }), { budget: BUDGET, params })
}

/* ------------------------------------------------------------------ */
/* replay                                                               */
/* ------------------------------------------------------------------ */

function replay(turns, policy, params = PARAMS) {
  let now = turns[0]?.at ?? T0
  const store = new Store(':memory:', { now: () => now })
  const buffer = new MemoryBuffer()
  let needed = 0, onCard = 0, changed = 0, bytes = 0, scored = 0, previous = null
  try {
    for (let t = 0; t < turns.length; t++) {
      now = turns[t].at
      store.writeMeta('turns:p', t)
      const human = turns[t].events.find(e => e.type === 'user/message')
      const text = (human?.data?.message?.content ?? []).map(b => b.text ?? '').join('\n')
      // What this turn will touch, by instance entity: the ground truth for this card.
      const touched = new Set([TRUTH === 'tools' ? '' : text, ...turns[t].events.flatMap(e => (e.data?.message?.content ?? [])
        .filter(b => b.type === 'tool-call').map(b => b.input?.path ?? ''))].flatMap(s => entities(s)).filter(isInstance))
      const card = cardFor(policy, store, now, cuesOf(text), t, params)
      if (previous !== null && card !== previous) changed++
      previous = card
      bytes += Buffer.byteLength(card)
      if (touched.size) {
        for (const node of store.activeNodes('p')) {
          if (node.pin) continue
          const own = entities(node.claim).filter(isInstance)
          if (!own.some(e => touched.has(e))) continue
          needed++
          if (card.includes(node.claim) || own.some(e => e.includes('/') && card.includes(e.slice(e.lastIndexOf('/') + 1)) && card.includes(e.slice(0, e.lastIndexOf('/') + 1)))) onCard++
        }
        scored++
      }
      // Then the turn happens, exactly as the plugin records it.
      if (policy === 'need') noteUse(store, 'p', { text, source: 'cue', turn: t })
      for (const e of turns[t].events) buffer.push('s', e)
      const events = buffer.take('s')
      const used = policy === 'need' ? noteTurnUse(store, 'p', events, { turn: t }) : []
      const out = capture(store, 'p', events, { session: 's', turn: t, temporal: false })
      const failed = events.some(e => e.type === 'tool/result' && e.data?.isError)
      wireTurn(store, 'p', { used, created: out.ids ?? [], turn: t, outcome: { toolErrors: failed ? 1 : 0, complete: true } })
      driftContext(store, 'p', text)
    }
  } finally { store.close() }
  return { recall: needed ? onCard / needed : 0, needed, churn: changed / Math.max(1, turns.length - 1), bytes: bytes / Math.max(1, turns.length), scored }
}

/* ------------------------------------------------------------------ */

const turns = LOG ? fromLog(LOG) : synthetic(TURNS)
const pct = v => `${(v * 100).toFixed(1)}%`
const pad = (s, n) => String(s).padEnd(n)
console.log(`${LOG ? `log ${LOG}` : 'synthetic Zipf workload'} · ${turns.length} turns · card ${BUDGET} B\n`)
console.log(pad('policy', 10) + pad('recall@card', 14) + pad('needed', 9) + pad('churn', 9) + 'bytes')
for (const [policy, params, label] of [['recency', PARAMS, 'recency'], ['due', PARAMS, 'due'], ['need', { ...PARAMS, noCue: true }, 'need-cue'], ['need', PARAMS, 'need']]) {
  const r = replay(turns, policy, params)
  console.log(pad(label, 10) + pad(pct(r.recall), 14) + pad(r.needed, 9) + pad(pct(r.churn), 9) + r.bytes.toFixed(0))
}

if (flag('fit')) {
  console.log('\ngrid search (need policy):')
  const grid = []
  for (const d of [0.3, 0.5, 0.7]) for (const leak of [0.3, 0.5, 0.7]) for (const beta of [0.5, 1.5, 3]) for (const inhibition of [0, Math.LN2, 1.5]) {
    const params = { ...PARAMS, d, leak, beta, inhibition }
    grid.push({ params, ...replay(turns, 'need', params) })
  }
  grid.sort((a, b) => b.recall - a.recall || a.churn - b.churn)
  for (const row of grid.slice(0, 5)) {
    const p = row.params
    console.log(`d=${p.d} leak=${p.leak} beta=${p.beta} inhibition=${p.inhibition.toFixed(2)}  recall ${pct(row.recall)}  churn ${pct(row.churn)}`)
  }
  console.log('(fitted on this workload only — do not ship a fit to synthetic data as a default)')
}
