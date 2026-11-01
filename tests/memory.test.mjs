import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { MemoryBuffer, capture, projectionText, recall, neighbourhood, consolidate, recordHandoff, handoffFor, recordCorrection, mergeDuplicates } from '../src/memory.js'
import { apply } from '../index.js'
import { projectScope } from '../src/util.js'

const user = (text) => ({ type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
const write = path => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'write', input: { path } }] } } })
const wrote = () => ({ type: 'tool/result', data: { content: [{ type: 'text', text: 'ok' }], isError: false } })

function fakeContext() {
  const tools = [], commands = [], contexts = [], handlers = new Map()
  const ctx = {
    tools: { register: t => { tools.push(t); return () => {} } },
    commands: { register: c => { commands.push(c); return () => {} } },
    systemPrompt: { context: c => { contexts.push(c); return () => {} } },
    on: (event, handler) => { handlers.set(event, handler); return () => {} },
    get: key => (key === 'llm' ? { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } } : undefined),
  }
  return { ctx, tools, commands, contexts, handlers }
}

test('node storage is idempotent and keeps support as evidence of recurrence', () => {
  const store = new Store(':memory:')
  try {
    const node = { id: 'n1', kind: 'constraint', claim: '不要改 package.json', anchor: 'seq:1', pin: 1, seq: 1 }
    store.recordNodes('p', { nodes: [node] })
    store.recordNodes('p', { nodes: [node] })
    const rows = store.activeNodes('p')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].support, 2)
    assert.deepEqual(rows[0].terms.includes('package.json'), false, 'terms come from the claim, not the id')
    assert.deepEqual(store.memoryStats('p').byKind, { constraint: 1 })
  } finally { store.close() }
})

test('pruning drops old unpinned nodes but never a pinned constraint', () => {
  const store = new Store(':memory:')
  try {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, kind: 'progress', claim: `step ${i}`, seq: i }))
    nodes.push({ id: 'pin', kind: 'constraint', claim: '不要改 package.json', pin: 1, seq: 99 })
    store.recordNodes('p', { nodes })
    store.pruneNodes('p', 5)
    const kept = store.activeNodes('p', 100)
    assert.equal(kept.length, 6)
    assert.ok(kept.some(node => node.id === 'pin'))
  } finally { store.close() }
})

test('the automatic prune after a write honours the configured node cap', () => {
  const nodes = Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, kind: 'progress', claim: `step ${i}`, seq: i }))
  const roomy = new Store(':memory:', { maxNodes: 1000 })
  const tight = new Store(':memory:', { maxNodes: 50 })
  try {
    roomy.recordNodes('p', { nodes })
    tight.recordNodes('p', { nodes })
    assert.equal(roomy.activeNodes('p', 2000).length, 600, 'a cap above 500 must not be clipped to the old default')
    assert.equal(tight.activeNodes('p', 2000).length, 50)
  } finally { roomy.close(); tight.close() }
})

test('the activation log is bounded and drops rows of deleted nodes first', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [{ id: 'keep', kind: 'decision', claim: '保留', seq: 1 }, { id: 'gone', kind: 'decision', claim: '删掉', seq: 2 }] })
    for (let i = 0; i < 4; i++) store.activate('p', { node: 'gone' })
    store.db.prepare("DELETE FROM node WHERE id='gone'").run()
    for (let i = 0; i < 3; i++) store.activate('p', { node: 'keep' })
    assert.equal(store.pruneActivations('p', 5), 4)
    assert.deepEqual(store.db.prepare('SELECT DISTINCT node FROM activation').all().map(r => r.node), ['keep'])
  } finally { store.close() }
})

test('the card points the model at a tool that exists', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('不要改 package.json，锁文件必须原样')])
    store.putSpans('p', 's', [{ seq: 0, kind: 'user/message', hash: 'h', text: '原文' }])
    const card = projectionText(store, 'p', 600)
    assert.match(card, /soul_recall/)
    assert.doesNotMatch(card, /soul_recall_session/)
  } finally { store.close() }
})

test('capture turns a turn into a pinned constraint and an artifact', () => {
  const store = new Store(':memory:')
  try {
    const events = [user('不要改 package.json，锁文件必须原样'), write('src/store.js'), wrote()]
    const result = capture(store, 'p', events, { hashOf: path => `hash:${path}` })
    assert.deepEqual(result, { nodes: 2, edges: 0, superseded: 0 })
    const rows = store.activeNodes('p')
    assert.ok(rows.some(node => node.kind === 'constraint' && node.pin === 1))
    assert.ok(rows.some(node => node.kind === 'artifact' && node.hash === 'hash:src/store.js'))
  } finally { store.close() }
})

test('projection is empty before the graph exists and stays within its budget after', () => {
  const store = new Store(':memory:')
  try {
    assert.equal(projectionText(store, 'p', 600), '')
    capture(store, 'p', [user('不要改 package.json'), user('构建必须走 pnpm build')])
    const card = projectionText(store, 'p', 200)
    assert.match(card, /package\.json/)
    assert.ok(Buffer.byteLength(card) <= 220, card)
  } finally { store.close() }
})

test('recall returns one hop of neighbours and records the activation', () => {
  const store = new Store(':memory:')
  try {
    const decision = { id: 'd1', kind: 'decision', claim: '决定用 anchor 而不是摘要', seq: 2 }
    const artifact = { id: 'a1', kind: 'artifact', claim: 'src/skeleton.js 已写入', seq: 3 }
    store.recordNodes('p', { nodes: [decision, artifact], edges: [{ src: 'd1', dst: 'a1', rel: 'derived', w: 1 }] })
    const out = recall(store, 'p', 'anchor 摘要')
    assert.equal(out.hits[0].id, 'd1')
    assert.equal(out.neighbours[0].id, 'a1')
    assert.equal(store.nodeRow('d1').hits, 1)
    assert.equal(store.memoryStats('p').activations, 1)
  } finally { store.close() }
})

test('the plugin compiles a finished turn and injects the card instead of the raw history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-mem-'))
  const { ctx, contexts, handlers } = fakeContext()
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  const session = { id: 's1', header: { cwd: dir } }
  const agent = { session }
  try {
    const preStep = handlers.get('agent/pre-step')
    const message = user('不要改 package.json，锁文件必须原样').data.message
    await preStep({ agent, messages: [message], step: 1 }, async () => ({ kind: 'accept', messages: [message] }))
    handlers.get('session/event')(session, { type: 'turn/end', data: {} })

    const provider = contexts.find(c => c.name === 'dsh-soul:memory')
    assert.ok(provider, 'memory provider registered')
    const text = provider.text({ agent })
    assert.match(text, /^\[骨架\]/)
    assert.match(text, /package\.json/)

    // A subagent never inherits the parent's skeleton.
    assert.equal(provider.text({ agent: { session: { id: 'x', header: { cwd: dir, origin: 'subagent' } } } }), '')
    // The scope the projection reads is the scope the capture wrote.
    assert.equal(projectScope({ id: session.id, header: { cwd: dir } }).startsWith('project:'), true)
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('edge weight accumulates, caps, and decays back to noise', () => {
  const store = new Store(':memory:')
  try {
    const id = store.link('p', { src: 'a', dst: 'b', rel: 'coactivated', delta: 0.1 })
    for (let i = 0; i < 100; i++) store.link('p', { src: 'a', dst: 'b', rel: 'coactivated', delta: 0.1 })
    const [edge] = store.edgesOf('p', 'a')
    assert.equal(edge.id, id)
    assert.equal(edge.w, 5, 'weight is capped instead of growing without bound')
    for (let i = 0; i < 200; i++) store.decayEdges('p', { factor: 0.97, floor: 0.05 })
    assert.equal(store.edgesOf('p', 'a').length, 0, 'an unused association eventually disappears')
  } finally { store.close() }
})

test('capture links a new node to the old node it talks about', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('不要改 package.json，锁文件必须原样')])
    capture(store, 'p', [user('再说一次：package.json 的锁文件不能动，必须原样')])
    const nodes = store.activeNodes('p')
    const related = store.db.prepare("SELECT * FROM edge WHERE scope='p' AND rel='related'").all()
    assert.ok(nodes.length >= 2)
    assert.ok(related.length >= 1, 'shared terms must produce a related edge')
    assert.ok(related[0].w > 0 && related[0].w <= 1)
  } finally { store.close() }
})

test('recall wires co-activated nodes together and reports strength', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [
      { id: 'd1', kind: 'decision', claim: '决定用 anchor 而不是摘要', seq: 1 },
      { id: 'a1', kind: 'artifact', claim: 'src/skeleton.js 已写入', seq: 2 },
    ], edges: [{ src: 'd1', dst: 'a1', rel: 'derived', w: 1 }] })
    const out = recall(store, 'p', 'anchor')
    assert.equal(out.hits[0].id, 'd1')
    assert.ok(out.neighbours.some(node => node.id === 'a1' && node.strength > 0))
  } finally { store.close() }
})

test('the neighbourhood is ranked by edge weight and survives a consolidation pass', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [
      { id: 'x', kind: 'decision', claim: '根节点', seq: 1 },
      { id: 'weak', kind: 'progress', claim: '弱关联', seq: 2 },
      { id: 'strong', kind: 'decision', claim: '强关联', seq: 3 },
    ] })
    store.link('p', { src: 'x', dst: 'weak', rel: 'related', delta: 0.2 })
    store.link('p', { src: 'x', dst: 'strong', rel: 'related', delta: 0.9 })
    const around = neighbourhood(store, 'p', 'x')
    assert.deepEqual(around.map(node => node.id), ['strong', 'weak'])
    const after = consolidate(store, 'p', { factor: 0.9, floor: 0.05 })
    assert.equal(after.edges, 2)
    assert.ok(after.byRel.related)
  } finally { store.close() }
})

test('the last position of a session is shown to the next one and hidden from itself', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('不要改 package.json')])
    const progress = { id: 'p1', kind: 'progress', claim: 'bundle 还没恢复，卡在 Lua 投递层', seq: 3 }
    store.recordNodes('p', { nodes: [progress] })
    assert.equal(recordHandoff(store, 'p', 'sess-a', progress.claim), progress.claim)
    assert.equal(handoffFor(store, 'p').session, 'sess-a')

    const next = projectionText(store, 'p', 600, { sessionId: 'sess-b' })
    assert.match(next, /^\[上次会话 \d{4}-\d{2}-\d{2}\] bundle 还没恢复/, next)

    const same = projectionText(store, 'p', 600, { sessionId: 'sess-a' })
    assert.ok(!same.includes('上次会话'), 'a session must not be told about its own handoff')
  } finally { store.close() }
})

test('a later constraint that replaces an earlier one closes its validity, it does not delete it', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('必须用 npm 安装依赖')])
    const first = store.activeNodes('p').find(node => node.kind === 'constraint')
    assert.ok(first, 'the first constraint exists')

    const result = capture(store, 'p', [user('必须改成用 pnpm 安装依赖')])
    assert.equal(result.superseded, 1, 'the replacement reports one supersession')

    const card = projectionText(store, 'p', 600)
    assert.ok(!card.includes('- 约束: 必须用 npm 安装依赖'), 'the superseded line leaves the card (pnpm contains npm as a substring)')
    assert.ok(card.includes('pnpm'), 'the new line is on the card')

    // Still findable — "this was replaced" is an answer, silence is not.
    const found = recall(store, 'p', 'npm 安装依赖')
    const old = found.hits.find(row => row.id === first.id)
    assert.ok(old, 'recall still returns the superseded node')
    assert.ok(old.supersededAt > 0, 'and marks it as superseded')
  } finally { store.close() }
})

test('a rewrite with no replacement wording leaves the earlier constraint alone', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('必须用 npm 安装依赖')])
    // Same object, no "instead" marker: this is a restatement, not a replacement.
    const result = capture(store, 'p', [user('必须用 npm 安装依赖，锁文件也要提交')])
    assert.equal(result.superseded, 0)
    assert.equal(store.activeNodes('p').filter(node => node.kind === 'constraint').length, 2)
  } finally { store.close() }
})

test('a replacement about a different object retires nothing', () => {
  const store = new Store(':memory:')
  try {
    capture(store, 'p', [user('必须用 npm 安装依赖')])
    const result = capture(store, 'p', [user('必须改成用 vite 构建前端')])
    assert.equal(result.superseded, 0, 'sharing one common word is not the same object')
    assert.equal(projectionText(store, 'p', 600).includes('npm'), true)
  } finally { store.close() }
})

test('a user correction becomes a pinned constraint, and a bare one does not', () => {
  const store = new Store(':memory:')
  try {
    const id = recordCorrection(store, 'p', { text: '不对，这里必须用 pnpm 而不是 npm', intent: '安装依赖' })
    assert.ok(id, 'a substantive correction is written')
    const node = store.nodeRow(id)
    assert.equal(node.kind, 'constraint')
    assert.equal(node.pin, 1)
    assert.equal(node.source, 'correction')
    assert.match(node.claim, /安装依赖/, 'the correction says what it is correcting')
    assert.ok(projectionText(store, 'p', 600).includes('pnpm'))

    // "不对" alone says the last answer was wrong without saying what is right. Pinning that
    // would put a contentless line on every future card.
    assert.equal(recordCorrection(store, 'p', { text: '不对' }), null)
    assert.equal(store.activeNodes('p').length, 1)
  } finally { store.close() }
})

test('identical claims written through two paths merge into one, keeping the edges', () => {
  const store = new Store(':memory:')
  try {
    // Two writers hash different strings, so the same sentence lands as two rows.
    store.recordNodes('p', { nodes: [
      { id: 'via-extract', kind: 'decision', claim: '决定用 anchor 而不是摘要', seq: 1 },
      { id: 'via-lookup', kind: 'decision', claim: '决定用 anchor 而不是摘要', seq: 9 },
      { id: 'witness', kind: 'artifact', claim: 'src/skeleton.js 已写入', seq: 2 },
    ] })
    store.link('p', { src: 'via-lookup', dst: 'witness', rel: 'related', delta: 1 })
    store.link('p', { src: 'via-extract', dst: 'witness', rel: 'derived', delta: 2 })

    const merged = mergeDuplicates(store, 'p')
    assert.equal(merged.length, 1)
    // The better-connected copy wins, so both edges survive on one node.
    assert.equal(merged[0].into, 'via-extract')
    assert.equal(store.activeNodes('p').filter(node => node.kind === 'decision').length, 1)
    const edges = store.edgesOf('p', 'via-extract').map(edge => edge.rel).sort()
    assert.deepEqual(edges, ['derived', 'related'], "the absorbed node edges are re-pointed")
    assert.equal(store.nodeRow('via-extract').support, 2, 'recurrence is transferred to the surviving node')
    assert.equal(store.nodeRow('via-lookup').support, 1, 'the retired record is not artificially reinforced')
    assert.equal(store.nodeRow('via-lookup').state, 'retired', 'retired, not deleted')
    assert.equal(store.nodeRow('via-lookup').claim, '决定用 anchor 而不是摘要', 'still readable by recall')
  } finally { store.close() }
})

test('two constraints that differ by one word are never merged', () => {
  const store = new Store(':memory:')
  try {
    store.recordNodes('p', { nodes: [
      { id: 'a', kind: 'constraint', claim: '必须用 pnpm', pin: 1, seq: 1 },
      { id: 'b', kind: 'constraint', claim: '不要用 pnpm', pin: 1, seq: 2 },
    ] })
    assert.deepEqual(mergeDuplicates(store, 'p'), [], 'opposite instructions are not duplicates')
    assert.equal(store.activeNodes('p').length, 2)
  } finally { store.close() }
})
