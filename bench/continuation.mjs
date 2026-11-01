/**
 * Continuation bench — after the turn that stated a detail is long gone, can the task still
 * get at it?
 *
 * The metric is deliberately not "how much survived compaction". It is the question
 * `SKELETON-BENCH` could not ask offline: **at the moment the work needs a detail, is it still
 * reachable?** reachable is measured in four rungs, and the rung matters more than the total:
 *
 *   card  — it is in the standing projection; no search, no guessing
 *   node  — one soul_recall, matched by term, because a node was written
 *   span  — only the raw-text index can find it, and only if the right words are guessed
 *   lost  — none of the above
 *
 * `span` looks like success and is not: it is the rung where the model has to already know how
 * the fact was worded. Moving an item from span to node is the whole value of promotion, and
 * moving it from node to card is the whole value of the projection ordering.
 *
 * No model is involved, so this is a proxy for continuation, not a measurement of it. What it
 * does measure is real: whether the information was addressable at all.
 *
 *   node bench/continuation.mjs
 *   node bench/continuation.mjs --turns=40 --budget=600
 */

import { Store } from '../src/store.js'
import { capture, projectionText, promoteTurn } from '../src/memory.js'
import { terms as termSet } from '../src/util.js'

const arg = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const TURNS = arg('turns', 40)
const BUDGET = arg('budget', 600)
const TURN_HOURS = arg('turn-hours', 6)
const DAY = 86_400_000
const HOUR = 3_600_000
const T0 = 1_790_000_000_000
const pad = (s, n) => String(s).padEnd(n)
const pct = v => `${(v * 100).toFixed(0)}%`

/**
 * The details a real session would need again, each stated exactly once, each at a different
 * rung of extractability — that is the point of the fixture, not variety for its own sake.
 *
 * `probe` is how the model would actually ask: a keyword it half-remembers, not a full question.
 * Chasing the answer to "适配器文件在哪" is not what happens in practice — the model knows it
 * wants the adapter and searches for that word. Measuring with the full question instead makes
 * every lookup fail on term overlap and says nothing about the memory.
 */
const DETAILS = [
  {
    key: '约束', stated: 0, token: 'package.json', rung: 'extractable',
    probe: '锁文件 package.json', line: '不要改 package.json，锁文件必须原样',
  },
  {
    key: '决策', stated: 3, token: '双时态', rung: 'extractable',
    probe: 'schema 双时态', line: '决定把 schema 升到 4，因为需要双时态的失效判定',
  },
  {
    key: '路径', stated: 8, token: 'sdk/adapter.js', rung: 'ambient',
    probe: 'adapter 适配器', line: '读取成功，sdk/adapter.js 共 412 行，入口在第 88 行',
  },
  {
    key: '版本', stated: 12, token: '0.9.4', rung: 'ambient',
    probe: 'node 版本 要求', line: '版本 0.9.4 要求 node >= 24，本机 20.11.1',
  },
  {
    key: '错误码', stated: 24, token: 'ELOOP', rung: 'ambient-failure',
    probe: '构建 失败 错误', line: '失败: ELOOP，符号链接循环，见 scripts/link.js',
  },
  {
    key: '产物', stated: 30, token: 'src/graph-memory.js', rung: 'extractable',
    probe: 'graph-memory 读路径', line: null,
  },
]

const FILLER = ['读取', '检查', '输出', '构建', '编译', '运行', '等待', '缓存', '索引', '日志', '模块', '目录', '行号', '字段', '接口', '参数', '标记', '队列', 'stdout', 'stderr', 'exit', 'warning', 'trace', 'chunk', 'flush', 'buffer', 'retry']

const mulberry32 = seed => () => {
  seed |= 0
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * One turn's worth of surface events, shaped like the real thing.
 *
 * `rnd` is passed in and seeded per run, not shared at module scope. A shared generator makes
 * every configuration see different filler — which is how the first version of this bench
 * produced a difference between two runs whose only change was the card ordering.
 */
function turnEvents(turn, rnd) {
  const noise = seq => `step ${seq}: ${Array.from({ length: 16 + Math.floor(rnd() * 10) }, () => FILLER[Math.floor(rnd() * FILLER.length)]).join(' ')} ok`
  const events = []
  let seq = 0
  const user = text => events.push({ type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
  const say = text => events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const call = (name, input) => events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name, input }] } } })
  const result = (text, isError = false) => events.push({ type: 'tool/result', data: { content: [{ type: 'text', text }], isError } })

  user(`继续第 ${turn} 步：${noise(seq++)}`)
  const stated = DETAILS.filter(detail => detail.stated === turn)

  for (const detail of stated) {
    if (detail.rung === 'extractable' && detail.key === '约束') user(detail.line)
    else if (detail.rung === 'extractable' && detail.key === '决策') say(detail.line)
    else if (detail.rung === 'extractable') { call('write', { path: detail.token }); result(`写入成功 ${noise(seq++)}`) }
    else if (detail.rung === 'ambient') { call('read', { path: 'CHANGELOG.md' }); result(`${noise(seq++)} ${detail.line}`) }
    else { call('run', { command: 'pnpm build' }); result(`${detail.line} ${noise(seq++)}`, true) }
  }
  // Every turn has ordinary work in it, so the graph has to earn the signal against noise.
  say(`第 ${turn} 步的进展：${noise(seq++)}`)
  call('read', { path: `src/mod${turn % 7}.js` })
  result(`${noise(seq++)}\nsrc/mod${turn % 7}.js 共 ${300 + turn} 行`)
  return events
}

/* ------------------------------------------------------------------ */

/** The four rungs, in the order a real lookup would try them. */
function available(store, scope, detail, card) {
  if (card.includes(detail.token)) return 'card'
  const nodes = store.searchNodes(scope, termSet(detail.probe), 5)
  if (nodes.some(node => node.claim.includes(detail.token))) return 'node'
  if (store.findSpans(scope, detail.token, 1).length) return 'span'
  return 'lost'
}

function run({ dynamics, promote }) {
  const store = new Store(':memory:')
  try {
    const rnd = mulberry32(20261031)
    let lastCard = ''
    let spanSeq = 0
    // `MemoryBuffer` numbers a session's events monotonically; without that the sequence is
    // per-turn and every seq-keyed lookup collides across turns. The bench has to imitate the
    // production numbering or it measures its own bug.
    let eventSeq = 0
    for (let turn = 0; turn < TURNS; turn++) {
      const events = turnEvents(turn, rnd).map(event => ({ ...event, seq: eventSeq++ }))
      capture(store, 'p', events, { hashOf: () => null })
      if (promote) promoteTurn(store, 'p', events, { now: T0 })
      // Keep the span index current the way `turn/end` does, so `span` is a real rung and not
      // an absent one — otherwise every comparison would flatter the memory layer.
      store.putSpans('p', 's1', events.map(event => {
        const text = JSON.stringify(event.data ?? {})
        return { seq: event.seq, kind: event.type, hash: `${event.seq}-${text.length}`, text }
      }))
      lastCard = projectionText(store, 'p', BUDGET, { dynamics, now: T0 + turn * TURN_HOURS * HOUR })
    }
    // The card at the end of the task, which is when a detail stated twenty turns ago has to
    // still be either on it or one lookup away.
    const end = T0 + TURNS * TURN_HOURS * HOUR
    const card = projectionText(store, 'p', BUDGET, { dynamics, now: end })
    const rows = DETAILS.map(detail => ({ ...detail, rung: available(store, 'p', detail, card) }))
    return {
      rows, card, bytes: Buffer.byteLength(card), nodes: store.memoryStats('p').byKind,
      spans: store.spanCoverage('p').spans,
    }
  } finally { store.close() }
}

/* ------------------------------------------------------------------ */

const CONFIGS = [
  { label: '现状（都关）', dynamics: false, promote: false },
  { label: '只开提升', dynamics: false, promote: true },
  { label: '只开排期', dynamics: true, promote: false },
  { label: '都开', dynamics: true, promote: true },
]

const out = []
out.push(`${TURNS} 轮 × ${TURN_HOURS} 小时 · 预算 ${BUDGET} B · ${DETAILS.length} 个必须记得的细节\n`)

const results = CONFIGS.map(config => ({ config, ...run(config) }))

out.push('## 1. 每个细节最后停在哪一档\n')
out.push(pad('细节', 10) + pad('陈述于', 10) + CONFIGS.map(c => pad(c.label, 16)).join(''))
for (let i = 0; i < DETAILS.length; i++) {
  const detail = DETAILS[i]
  out.push(pad(detail.key, 10) + pad(`第 ${detail.stated} 轮`, 10)
    + results.map(r => pad(r.rows[i].rung, 16)).join(''))
}

out.push('\n## 2. 分档统计\n')
const RUNGS = ['card', 'node', 'span', 'lost']
out.push(pad('', 16) + CONFIGS.map(c => pad(c.label, 16)).join(''))
for (const rung of RUNGS) {
  out.push(pad(rung === 'card' ? '卡片直接可见' : rung === 'node' ? '一次检索（靠词）' : rung === 'span' ? '只能靠猜原话' : '彻底失去',
    16) + results.map(r => pad(String(r.rows.filter(row => row.rung === rung).length), 16)).join(''))
}

out.push('\n## 3. 结构化可及率（card + node）/ 总\n')
for (const result of results) {
  const reach = result.rows.filter(row => row.rung === 'card' || row.rung === 'node').length
  out.push(`  ${pad(result.config.label, 16)}${reach}/${DETAILS.length}  = ${pct(reach / DETAILS.length)}   卡片 ${result.bytes} B`)
}

out.push('\n## 4. 卡片（都开）\n')
out.push(results.at(-1).card)
out.push(`\n节点构成：${JSON.stringify(results.at(-1).nodes)}`)

out.push('\n---\n')
out.push('读法：`span` 不算成功。它意味着模型必须已经知道那句话怎么说的才能找到——')
out.push('而需要回忆的东西，恰恰是你不记得怎么说的那句。把 span 提到 node 是提升的全部价值，')
out.push('把 node 提到 card 是排期排序的全部价值。')

console.log(out.join('\n'))
