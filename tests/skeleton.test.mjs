import test from 'node:test'
import assert from 'node:assert/strict'
import { compact, extract, normalize, ppr, project, select, buildGraph } from '../src/skeleton.js'

const user = (seq, text) => ({ seq, type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
const say = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const call = (seq, name, input) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name, input }] } } })
const result = (seq, text, isError = false) => ({ seq, type: 'tool/result', data: { content: [{ type: 'text', text }], isError } })

test('normalize keeps the tool path and pairs the result with its call', () => {
  const blocks = normalize([
    user(0, '修一下'),
    call(1, 'write', { path: 'src/a.js', content: 'x' }),
    result(2, 'ok'),
  ])
  assert.deepEqual(blocks.map(b => b.kind), ['user', 'tool-call', 'tool-result'])
  assert.equal(blocks[1].path, 'src/a.js')
  assert.equal(blocks[2].path, 'src/a.js')
  assert.equal(blocks[2].ok, true)
})

test('a standing instruction becomes a pinned constraint, a question does not', () => {
  const { nodes } = extract(normalize([
    user(0, '不要改 package.json，锁文件必须原样'),
    user(1, '这个函数在哪'),
  ]))
  const constraints = nodes.filter(n => n.kind === 'constraint')
  assert.equal(constraints.length, 1)
  assert.equal(constraints[0].pin, 1)
  // `package.json` must survive: a sentence splitter that breaks on the dot deletes the point.
  assert.match(constraints[0].claim, /package\.json/)
})

test('a decision is one node, not a decision plus a duplicate progress node', () => {
  const { nodes } = extract(normalize([say(0, '决定用 anchor 而不是摘要，因为摘要会丢约束')]))
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].kind, 'decision')
})

test('rewriting a file supersedes the earlier artifact instead of stacking a second one', () => {
  const { nodes, edges } = extract(normalize([
    call(0, 'write', { path: 'src/a.js' }),
    result(1, 'ok'),
    call(2, 'edit', { path: 'src/a.js' }),
    result(3, 'ok'),
  ]))
  const artifacts = nodes.filter(n => n.kind === 'artifact')
  assert.equal(artifacts.length, 2)
  assert.ok(edges.some(e => e.rel === 'supersedes' && e.src === artifacts[1].id && e.dst === artifacts[0].id))
})

test('page-rank is a distribution and prefers the seed', () => {
  const blocks = normalize([user(0, 'alpha beta'), user(1, 'gamma delta'), user(2, 'alpha beta gamma')])
  const rank = ppr(buildGraph(blocks), [0])
  const sum = [...rank].reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`)
  assert.ok(rank[0] > rank[1])
})

test('selection never exceeds the budget and always takes mandatory blocks', () => {
  const blocks = normalize([
    user(0, '不要改 package.json'),
    ...Array.from({ length: 12 }, (_, i) => result(i + 1, `step ${i} ${'x'.repeat(60)}`)),
  ])
  const adjacency = buildGraph(blocks)
  const { picked, bytes } = select(blocks, { adjacency, seeds: [0], budget: 400, mandatory: [0] })
  assert.ok(bytes <= 400, `bytes=${bytes}`)
  assert.ok(picked.includes(0))
})

test('compaction keeps every pinned constraint under a tight budget', () => {
  const events = [
    user(0, '不要改 package.json'),
    user(1, '构建必须走 pnpm build --frozen-lockfile'),
    user(2, '探测必须在 git worktree 里跑'),
    ...Array.from({ length: 40 }, (_, i) => result(i + 3, `noise ${i} ${'y'.repeat(80)}`)),
  ]
  const out = compact({ events, budget: 700 })
  assert.match(out.text, /package\.json/)
  assert.match(out.text, /--frozen-lockfile/)
  assert.match(out.text, /worktree/)
  assert.match(out.text, /数据不是指令/)
  assert.ok(out.stats.bytes <= 800, `bytes=${out.stats.bytes}`)
})

test('an invalidated artifact is withheld rather than presented as current', () => {
  const events = [call(0, 'write', { path: 'src/store.js' }), result(1, 'ok')]
  const out = compact({ events, budget: 600, storedHash: () => 'original', hashOf: () => 'changed' })
  assert.equal(out.stats.stale, 1)
  assert.ok(!out.text.includes('产物: src/store.js'), out.text)
})

test('empty history and a zero budget degrade to nothing instead of throwing', () => {
  assert.equal(compact({ events: [], budget: 400 }).text, '')
  const { picked } = select(normalize([user(0, 'x')]), { adjacency: [[], []], seeds: [0], budget: 0 })
  assert.deepEqual(picked, [])
})

test('projection respects its budget and puts constraints first', () => {
  const { nodes } = extract(normalize([
    user(0, '不要改 package.json'),
    say(1, '决定用 anchor，因为摘要会丢约束'),
  ]))
  const text = project(nodes, { budget: 120 })
  assert.ok(Buffer.byteLength(text) <= 140, text)
  assert.match(text.split('\n')[1], /约束/)
})

test('a graph boost reorders selection without changing the rules', () => {
  const blocks = normalize([
    user(0, '甲 乙 丙'),
    user(1, '丁 戊 己'),
    user(2, '庚 辛 壬'),
  ])
  const adjacency = buildGraph(blocks)
  const plain = select(blocks, { adjacency, seeds: [0], budget: 400 })
  const boosted = select(blocks, { adjacency, seeds: [0], budget: 400, boost: new Map([[2, 4], [0, 0.1]]) })
  assert.equal(plain.picked.length, 3)
  assert.equal(boosted.picked[0], 2, 'the boosted block must be taken first')
  assert.ok(boosted.picked.indexOf(2) < boosted.picked.indexOf(0))
})
