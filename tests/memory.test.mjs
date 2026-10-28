import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { MemoryBuffer, capture, projectionText, recall, neighbourhood, consolidate, recordHandoff, handoffFor } from '../src/memory.js'
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

test('capture turns a turn into a pinned constraint and an artifact', () => {
  const store = new Store(':memory:')
  try {
    const events = [user('不要改 package.json，锁文件必须原样'), write('src/store.js'), wrote()]
    const result = capture(store, 'p', events, { hashOf: path => `hash:${path}` })
    assert.deepEqual(result, { nodes: 2, edges: 0 })
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
