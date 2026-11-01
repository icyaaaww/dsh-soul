/**
 * Behavioural diff: an older tree versus the current one, with every new switch off.
 *
 * The question being answered is narrow and important: **if a user upgrades and changes nothing,
 * do they get the same bytes?** Anything that differs is a compatibility break and has to be
 * either reverted, gated behind a flag, or documented as an intentional fix.
 *
 *   PRISTINE=/path/to/old/dsh-soul/src node bench/compat.mjs
 *
 * Point `PRISTINE` at the `src` directory of the release you are upgrading from. Without it the
 * script cannot run, and says so rather than silently comparing the tree with itself.
 */

const pristineRoot = process.env.PRISTINE
if (!pristineRoot) {
  console.error('需要 PRISTINE=<旧版 src 目录>，例如 PRISTINE=../dsh-soul-1.5.0/src')
  process.exit(2)
}
const toUrl = path => `file:///${path.replace(/\\/g, '/').replace(/^\//, '')}`
const PRISTINE = toUrl(pristineRoot)
const CURRENT = new URL('../src', import.meta.url).href

const pristineSkeleton = await import(`${PRISTINE}/skeleton.js`)
const currentSkeleton = await import(`${CURRENT}/skeleton.js`)
const pristineStore = await import(`${PRISTINE}/store.js`)
const currentStore = await import(`${CURRENT}/store.js`)
const pristineMemory = await import(`${PRISTINE}/memory.js`)
const currentMemory = await import(`${CURRENT}/memory.js`)

const DAY = 86_400_000
const T0 = 1_790_000_000_000
const pad = (s, n) => String(s).padEnd(n)
const out = []
let breaks = 0
const check = (name, same, detail = '') => {
  if (!same) breaks++
  out.push(`${same ? 'same  ' : 'DIFFER'}  ${pad(name, 44)}${detail}`)
}

/** A node set that exercises every kind the two versions can produce, references included. */
const NODES = [
  { id: 'c1', kind: 'constraint', claim: '不要改 package.json', pin: 1, seq: 9, state: 'active', created: T0, seen: T0, weight: 1, hits: 0 },
  { id: 'd1', kind: 'decision', claim: '决定走 anchor 而不是摘要', pin: 0, seq: 8, state: 'active', created: T0, seen: T0, weight: 1, hits: 0 },
  { id: 'a1', kind: 'artifact', claim: 'src/store.js 已写入', pin: 0, seq: 7, state: 'active', created: T0, seen: T0, weight: 1, hits: 0 },
  { id: 'r1', kind: 'reference', claim: '常用检索：双时态', pin: 0, seq: 6, state: 'active', created: T0, seen: T0, weight: 1, hits: 0 },
  { id: 'p1', kind: 'progress', claim: '下一步重跑成对验证', pin: 0, seq: 5, state: 'active', created: T0, seen: T0, weight: 1, hits: 0 },
]

/* ------------------------------------------------------------------ */
out.push('## 1. project() —— 默认卡片排序\n')
for (const budget of [200, 400, 600, 1200]) {
  const a = pristineSkeleton.project(NODES, { budget })
  const b = currentSkeleton.project(NODES, { budget })
  check(`project budget=${budget}`, a === b, a === b ? '' : `\n  旧: ${a.split('\n').join(' | ')}\n  新: ${b.split('\n').join(' | ')}`)
}

/* ------------------------------------------------------------------ */
out.push('\n## 2. compact() —— 压缩选点\n')
const events = [
  { seq: 0, type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不要改 package.json，构建走 pnpm build --frozen-lockfile' }] } } },
  { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '决定用 anchor 而不是摘要' }] } } },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'write', input: { path: 'src/store.js' } }] } } },
  { seq: 3, type: 'tool/result', data: { content: [{ type: 'text', text: 'ok 写入成功，共 412 行' }], isError: false } },
  ...Array.from({ length: 12 }, (_, i) => ({ seq: 4 + i, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第 ${i} 步：读取 检查 输出 构建 缓存 索引 日志 模块 目录 stdout` }] } } })),
]
for (const budget of [600, 1200, 2400]) {
  const a = pristineSkeleton.compact({ events, budget })
  const b = currentSkeleton.compact({ events, budget })
  check(`compact budget=${budget}`, a.text === b.text,
    a.text === b.text ? `${Buffer.byteLength(a.text)} B` : `\n  旧(${Buffer.byteLength(a.text)}B): ${a.text.slice(0, 120)}\n  新(${Buffer.byteLength(b.text)}B): ${b.text.slice(0, 120)}`)
}

/* ------------------------------------------------------------------ */
out.push('\n## 3. normalize / extract —— 块与节点\n')
const nA = pristineSkeleton.normalize(events)
const nB = currentSkeleton.normalize(events)
check('normalize', JSON.stringify(nA) === JSON.stringify(nB), `${nB.length} blocks`)
const eA = pristineSkeleton.extract(nA, { scope: 'p', hashOf: () => null })
const eB = currentSkeleton.extract(nB, { scope: 'p', hashOf: () => null })
check('extract', JSON.stringify(eA) === JSON.stringify(eB), `${eB.nodes.length} nodes / ${eB.edges.length} edges`)

/* ------------------------------------------------------------------ */
out.push('\n## 4. select() —— 预算最大覆盖\n')
const adjacency = pristineSkeleton.buildGraph(nA)
const sA = pristineSkeleton.select(nA, { adjacency, seeds: [0, nA.length - 1], budget: 200, kindWeight: { user: 1.4 } })
const sB = currentSkeleton.select(nB, { adjacency, seeds: [0, nB.length - 1], budget: 200, kindWeight: { user: 1.4 } })
check('select（need 未提供时）', JSON.stringify(sA) === JSON.stringify(sB), `${sB.picked.length} picked`)

/* ------------------------------------------------------------------ */
out.push('\n## 5. projectionText() —— 默认关闭动力学\n')
for (const [label, Store] of [['pristine', pristineStore.Store], ['current', currentStore.Store]]) {
  const store = new Store(':memory:')
  store.recordNodes('p', { nodes: NODES.map(({ state, weight, hits, ...rest }) => rest) })
  const card = (label === 'pristine' ? pristineMemory : currentMemory)
    .projectionText(store, 'p', 600, {})
  out.push(`  ${pad(label, 10)}${Buffer.byteLength(card)} B  ${card.split('\n').slice(0, 3).join(' | ')}`)
  store.close()
}
{
  const a = new pristineStore.Store(':memory:')
  const b = new currentStore.Store(':memory:')
  a.recordNodes('p', { nodes: NODES.map(({ state, weight, hits, ...rest }) => rest) })
  b.recordNodes('p', { nodes: NODES.map(({ state, weight, hits, ...rest }) => rest) })
  const ca = pristineMemory.projectionText(a, 'p', 600, {})
  const cb = currentMemory.projectionText(b, 'p', 600, {})
  check('projectionText 默认路径', ca === cb)
  a.close(); b.close()
}

/* ------------------------------------------------------------------ */
out.push('\n## 6. pruneNodes() —— 容量与判据\n')
function pruneCase(Store, { total, withHits, limit }) {
  const store = new Store(':memory:')
  const nodes = Array.from({ length: total }, (_, i) => ({ id: `n${i}`, kind: 'progress', claim: `第 ${i} 条`, seq: i }))
  store.recordNodes('p', { nodes })
  for (let i = 0; i < withHits; i++) store.db.prepare('UPDATE node SET hits=2 WHERE id=?').run(`n${i}`)
  for (let i = 0; i < total; i++) store.db.prepare('UPDATE node SET seen=? WHERE id=?').run(T0 - i * DAY, `n${i}`)
  store.pruneNodes('p', limit)
  const kept = store.activeNodes('p', 9999).map(row => row.id).sort()
  store.close()
  return kept
}
for (const c of [{ total: 30, withHits: 0, limit: 5 }, { total: 30, withHits: 10, limit: 5 }, { total: 10, withHits: 3, limit: 20 }]) {
  const a = pruneCase(pristineStore.Store, c)
  const b = pruneCase(currentStore.Store, c)
  check(`pruneNodes ${JSON.stringify(c)}`, JSON.stringify(a) === JSON.stringify(b),
    a.length === b.length ? `${b.length} kept` : `旧 ${a.length} 条 / 新 ${b.length} 条`)
}

/* ------------------------------------------------------------------ */
out.push('\n## 7. recall() —— 未传 dynamicsView\n')
{
  const mk = (Store) => {
    const store = new Store(':memory:')
    store.recordNodes('p', {
      nodes: [
        { id: 'cue', kind: 'decision', claim: '决定走双时态', seq: 1 },
        { id: 'n1', kind: 'artifact', claim: 'src/store.js 已写入', seq: 2 },
      ],
      edges: [{ src: 'cue', dst: 'n1', rel: 'derived', w: 3 }],
    })
    return store
  }
  const a = mk(pristineStore.Store)
  const b = mk(currentStore.Store)
  const ra = pristineMemory.recall(a, 'p', '双时态')
  const rb = currentMemory.recall(b, 'p', '双时态')
  check('recall 默认路径', JSON.stringify(ra) === JSON.stringify(rb),
    JSON.stringify(ra) === JSON.stringify(rb) ? '' : `\n  旧: ${JSON.stringify(ra)}\n  新: ${JSON.stringify(rb)}`)
  a.close(); b.close()
}

/* ------------------------------------------------------------------ */
out.push(`\n${breaks === 0 ? '全部一致：开关全关时，默认路径逐字节相同。' : `${breaks} 处差异，见上。`}`)
console.log(out.join('\n'))
