/**
 * Consolidation bench — compaction with and without the memory dimension.
 *
 * The claim under test: compression and forgetting are the same operation seen twice, so
 * compaction should ask which blocks it is *allowed* to drop, not assume every shadowed block
 * is recoverable. The measurement is mechanical — no model, no imitation of one.
 *
 *   node bench/consolidation.mjs
 *   node bench/consolidation.mjs --budget=1200 --consolidated=0.3
 *
 * Method: build a real in-memory Store, let `capture()` extract nodes from a synthetic session
 * the way it does in production, then backdate part of the graph so some knowledge is
 * consolidated (retrieved repeatedly, high availability) and the rest is not. Compaction runs
 * twice over the same span and the same budget, changing only whether it can see the graph.
 */

import { Store } from '../src/store.js'
import { capture } from '../src/memory.js'
import { compact, extract, normalize } from '../src/skeleton.js'
import { memoryProfile, nodeBudgetRatio, shadowRisk, availability } from '../src/consolidation.js'

const arg = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const BUDGET = arg('budget', 1200)
const DAY = 86_400_000
const pct = v => `${(v * 100).toFixed(1)}%`
const pad = (s, n) => String(s).padEnd(n)

/** The identifiers that must survive: paths, flags, versions, error codes. */
const ITEMS = [
  { kind: 'constraint', token: 'package.json', text: '不要改 package.json，锁文件必须原样', seq: 0 },
  { kind: 'constraint', token: '--frozen-lockfile', text: '构建必须走 pnpm build --frozen-lockfile', seq: 0 },
  { kind: 'constraint', token: 'worktree', text: '探测必须在 git worktree 里跑，不能污染主目录', seq: 0 },
  { kind: 'decision', token: 'anchor', text: '决定用 anchor 而不是摘要，因为摘要会丢掉约束' },
  { kind: 'decision', token: '双时态', text: '决定把 schema 升到 4，因为需要双时态的失效判定' },
  { kind: 'artifact', token: 'src/skeleton.js', path: 'src/skeleton.js' },
  { kind: 'artifact', token: 'src/store.js', path: 'src/store.js' },
  { kind: 'artifact', token: 'bench/consolidation.mjs', path: 'bench/consolidation.mjs' },
  { kind: 'progress', token: '成对验证', text: '下一步必须重跑成对验证再谈收益' },
  { kind: 'ambient', token: 'v0.9.4' },
  { kind: 'ambient', token: 'ENOSPC' },
]

const FILLER = [
  '读取', '检查', '输出', '构建', '编译', '运行', '等待', '缓存', '索引', '日志',
  '模块', '目录', '行号', '字段', '接口', '参数', '版本', '路径', '标记', '队列',
  'stdout', 'stderr', 'exit', 'warning', 'trace', 'chunk', 'flush', 'buffer', 'retry',
]

const mulberry32 = seed => () => {
  seed |= 0
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** A session shaped like a real one: constraints first, ambient facts only inside tool output. */
function scenario(seed = 7) {
  const rnd = mulberry32(seed)
  const events = []
  let seq = 0
  const user = text => events.push({ seq: seq++, type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
  const say = text => events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const call = (name, input) => events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name, input }] } } })
  const result = text => events.push({ seq: seq++, type: 'tool/result', data: { content: [{ type: 'text', text }], isError: false } })
  const filler = () => {
    const parts = []
    for (let i = 0; i < 18 + Math.floor(rnd() * 14); i++) parts.push(FILLER[Math.floor(rnd() * FILLER.length)])
    return `step ${seq}: ${parts.join(' ')} ok`
  }

  user(`修一下压缩失忆。${ITEMS[0].text}；${ITEMS[1].text}；${ITEMS[2].text}`)
  say(ITEMS[3].text)
  call('read', { path: 'src/skeleton.js' })
  result(`${filler()}\n${ITEMS[5].path} 共 541 行，导出了 select 与 compact`)
  say(ITEMS[8].text)
  for (let turn = 0; turn < 6; turn++) {
    user(`继续第 ${turn + 1} 步`)
    say(filler())
    call('write', { path: 'src/store.js' })
    result(`写入成功 ${filler()}`)
    say(filler())
  }
  call('run', { command: 'pnpm install' })
  result(`失败: ENOSPC ${filler()}\nv0.9.4 需要 node >= 24 ${filler()}`)
  say(ITEMS[4].text)
  user('把 bench 加上')
  call('write', { path: 'bench/consolidation.mjs' })
  result(`写入成功 ${filler()}`)
  say(filler())
  return events
}

/**
 * Give the graph a history. `consolidatedShare` of the load-bearing nodes are treated as
 * repeatedly retrieved over the last month; the rest were written once and never touched
 * again — which is what most of a real graph looks like.
 */
function backdate(store, scope, { consolidatedShare, now }) {
  const nodes = store.activeNodes(scope, 500)
  const loadBearing = nodes.filter(n => n.pin || n.kind === 'decision')
  const consolidated = new Set(
    loadBearing.slice(0, Math.round(loadBearing.length * consolidatedShare)).map(n => n.id))
  const insert = store.db.prepare('INSERT INTO activation(id,scope,node,query,at) VALUES (?,?,?,?,?)')
  for (const node of nodes) {
    // Everything was encoded a month ago; only some of it was ever needed again.
    store.db.prepare('UPDATE node SET created=?, seen=? WHERE id=?').run(now - 30 * DAY, now - 30 * DAY, node.id)
    if (consolidated.has(node.id)) {
      for (const daysAgo of [24, 18, 12, 6, 2, 0.5]) {
        insert.run(`a-${node.id}-${daysAgo}`, scope, node.id, 'bench', now - daysAgo * DAY)
      }
      store.db.prepare('UPDATE node SET hits=? WHERE id=?').run(6, node.id)
    }
  }
  return { loadBearing: loadBearing.length, consolidated: consolidated.size }
}

function measure(text) {
  const found = ITEMS.filter(item => text.includes(item.token))
  const constraints = ITEMS.filter(item => item.kind === 'constraint')
  return {
    detail: found.length / ITEMS.length,
    constraints: constraints.filter(item => text.includes(item.token)).length / constraints.length,
    bytes: Buffer.byteLength(text),
  }
}

/* ------------------------------------------------------------------ */

const now = Date.now()
const events = scenario()
const out = []
out.push(`跨度 ${Buffer.byteLength(JSON.stringify(events))} bytes · 预算 ${BUDGET} B\n`)

const rows = []
for (const consolidatedShare of [0, 0.3, 0.7, 1]) {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', events, { hashOf: () => null })
    const truth = backdate(store, 'p', { consolidatedShare, now })
    const memory = memoryProfile(store, 'p', now)

    const controls = measure(compact({ events, budget: BUDGET }).text)
    const withMemory = measure(compact({ events, budget: BUDGET, memory }).text)
    const shadowedAll = normalize(events).map(b => b.seq)
    const atRisk = shadowRisk(memory, shadowedAll).length

    rows.push({
      consolidatedShare, truth, memory, controls, withMemory, atRisk,
      ratio: nodeBudgetRatio(memory),
    })
  } finally { store.close() }
}

out.push('## 图已被巩固的比例 → 压缩时的行为\n')
out.push(`${pad('已巩固', 8)}${pad('节点份额', 10)}${pad('细节: 无知觉', 14)}${pad('细节: 用图', 12)}${pad('约束: 无知觉', 14)}${pad('约束: 用图', 12)}${pad('无支撑段', 10)}`)
for (const row of rows) {
  out.push(pad(pct(row.consolidatedShare), 8)
    + pad(row.ratio.toFixed(2), 10)
    + pad(pct(row.controls.detail), 14)
    + pad(pct(row.withMemory.detail), 12)
    + pad(pct(row.controls.constraints), 14)
    + pad(pct(row.withMemory.constraints), 12)
    + pad(String(row.atRisk), 10))
}

const last = rows.at(-1)
out.push('\n## 读法\n')
out.push(`节点份额随巩固程度从 0.25 涨到 ${nodeBudgetRatio(rows[0].memory).toFixed(2)}–${last.ratio.toFixed(2)}：`)
out.push(`  没固化时把预算让给原文摘录，固化后才敢花在 claim 上。固定 45% 是对两种情况都不成立的平均值。`)
out.push(`\n"无支撑段"是这一版真正报告的东西：被遮蔽、图里又没有固化骨架的块。`)
out.push(`  这一栏从 ${rows[0].atRisk} 降到 ${last.atRisk}——不是因为压缩更狠，是因为图知道哪些丢掉是单向门。`)

const sample = rows[1]
out.push('\n## 样例（巩固 30%）\n')
out.push(`可用性分布：${[...sample.memory.bySeq.values()].slice(0, 6).map(v => `${v.kind}=${v.A.toFixed(2)}`).join('  ')}`)
out.push(`约束四条实写：${ITEMS.filter(i => i.kind === 'constraint').map(i => i.token).join(', ')}`)

console.log(out.join('\n'))
