import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { projectScope } from '../src/util.js'

/**
 * The `/mem` surface, driven the way the host drives it.
 *
 * These four verbs are the only place a person can inspect or undo what the read path decides,
 * so they are worth exercising through the real registration rather than by calling the
 * helpers directly.
 */

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

const signal = () => new AbortController().signal
const session = cwd => ({ id: 's1', header: { cwd } })

function harness(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soul-mem-'))
  const { ctx, tools, commands, contexts, handlers } = fakeContext()
  // `/mem` and `/evolve` register together behind the same switch, so the harness has to enable
  // the plugin the way a real bundle does.
  const handle = apply(ctx, {
    profile: 'test', database: join(dir, 'evolve.sqlite'),
    enabled: true, provider: 'p', model: 'm', ...extra,
  })
  const mem = commands.find(command => command.name === 'mem')
  return {
    dir, ctx, tools, commands, contexts, handlers, mem, handle,
    run: rawInput => mem.handler({ agent: { session: session(dir) }, rawInput, signal: signal() }),
    stop: async () => {
      await handle?.stop?.()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('/mem registers with the new verbs advertised', async () => {
  const h = harness()
  try {
    assert.ok(h.mem, '/mem must register')
    assert.match(h.mem.input.hint, /dynamics/)
    assert.match(h.mem.input.hint, /restore/)
  } finally { await h.stop() }
})

test('/mem dynamics reports the ledger even with an empty graph', async () => {
  const h = harness()
  try {
    const result = await h.run('dynamics')
    assert.equal(result.kind, 'success')
    const data = JSON.parse(result.text)
    assert.equal(data.switch, 'off', 'the flag is off unless configured')
    assert.equal(data.sizes.nodes, 0)
    assert.deepEqual(data.nodes, [])
    assert.deepEqual(data.retireCandidates, [])
  } finally { await h.stop() }
})

test('/mem dynamics honours the switch and stays local', async () => {
  const h = harness({ memory: { dynamics: true } })
  try {
    const result = await h.run('dynamics')
    assert.equal(JSON.parse(result.text).switch, 'on')
  } finally { await h.stop() }
})

test('/mem sleep consolidates and reports what it retired', async () => {
  const h = harness()
  try {
    const result = await h.run('sleep')
    assert.equal(result.kind, 'success')
    const data = JSON.parse(result.text)
    assert.ok('retired' in data, 'retirement is reported, not silent')
    // With the dynamics layer off, `/mem sleep` must not start hiding nodes behind an unchanged
    // command — an upgrade that changes nothing has to keep behaving like the old one.
    assert.deepEqual(data.retired, [], 'retirement is gated on memory.dynamics')
    // Association decay still runs: that half of the old `/mem sleep` is unchanged.
    assert.ok('edges' in data)
  } finally { await h.stop() }
})

test('/mem restore requires an argument and accepts one', async () => {
  const h = harness()
  try {
    const missing = await h.run('restore')
    assert.equal(missing.kind, 'error')
    const ok = await h.run('restore ghost-node')
    assert.equal(ok.kind, 'success')
    assert.deepEqual(JSON.parse(ok.text).restored, [], 'an unknown id restores nothing, without failing')
  } finally { await h.stop() }
})

test('an unknown verb lists the real ones', async () => {
  const h = harness()
  try {
    const result = await h.run('nonsense')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /dynamics/)
    assert.match(result.text, /restore/)
  } finally { await h.stop() }
})

/** One complete turn, the way the host drives it: pre-step opens the observation, turn/end closes it. */
async function turn(h, text = '看一下 src/store.js') {
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
  await h.handlers.get('agent/pre-step')(
    { agent: { session: session(h.dir) }, messages: [message], step: 1 },
    async () => ({ kind: 'accept', messages: [message] }),
  )
  h.handlers.get('session/event')(session(h.dir), { type: 'turn/end', data: {} })
}

test('idle maintenance merges duplicates and leaves retirement alone', async () => {
  const h = harness({ memory: { maintenanceTurns: 5 } })
  try {
    const scope = projectScope({ id: 's1', header: { cwd: h.dir } })
    h.handle.store.recordNodes(scope, { nodes: [
      { id: 'keep', kind: 'decision', claim: '决定用 anchor', seq: 1 },
      { id: 'dupe', kind: 'decision', claim: '决定用 anchor', seq: 2 },
    ] })
    // Pretend enough turns have gone by without waiting for them.
    h.handle.store.writeMeta('turns:' + scope, 10)

    // A turn end only has state if a pre-step opened one, so drive the whole turn: that is
    // the path the host actually takes, and the scheduler hangs off the real turn boundary.
    await turn(h)
    await new Promise(done => setTimeout(done, 20))

    assert.equal(h.handle.store.nodeRow('dupe').state, 'retired', 'the duplicate was merged away')
    assert.equal(h.handle.store.readMeta('maintenance:' + scope), '11', 'the watermark advanced')
    assert.equal(h.handle.store.activeNodes(scope).filter(n => n.kind === 'decision').length, 1)
  } finally { await h.stop() }
})

test('idle maintenance respects the turn interval', async () => {
  const h = harness({ memory: { maintenanceTurns: 50 } })
  try {
    const scope = projectScope({ id: 's1', header: { cwd: h.dir } })
    h.handle.store.recordNodes(scope, { nodes: [
      { id: 'keep', kind: 'decision', claim: '决定用 anchor', seq: 1 },
      { id: 'dupe', kind: 'decision', claim: '决定用 anchor', seq: 2 },
    ] })
    h.handle.store.writeMeta('turns:' + scope, 1)
    await turn(h)
    await new Promise(done => setTimeout(done, 20))
    assert.equal(h.handle.store.nodeRow('dupe').state, 'active', 'not due yet, nothing happens')
  } finally { await h.stop() }
})
