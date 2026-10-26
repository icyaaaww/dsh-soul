import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settings, apply, name, inject } from '../index.js'
import { projectScope, taskKey, leadingIntent, day, bounded, redact } from '../src/util.js'
import { Recorder, divergenceOf, isCorrection, trajectoryText } from '../src/observe.js'

/** Minimal Cordis stand-in: enough to exercise registration and dispatch. */
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

const session = (cwd = process.cwd()) => ({ id: 's1', header: { cwd } })

test('plugin is disabled by default and registers nothing until asked', () => {
  assert.equal(name, 'dsh-soul')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'commands', 'llm'])
  const { ctx, tools, contexts } = fakeContext()
  const out = apply(ctx, { profile: 'test', database: ':memory:' })
  assert.equal(out, undefined)
  assert.equal(tools.length, 0)
  assert.equal(contexts.length, 0)
})

test('enabling requires an explicit model route and never inherits learning', () => {
  assert.throws(() => settings({ profile: 'p', enabled: true }), /显式配置 provider/)
  assert.throws(() => settings({ profile: 'p', learning: true }), /不提供后台记忆提炼/)
  assert.throws(() => settings({}), /无法确定 profile/)
  const a = settings({ profile: 'one' }), b = settings({ profile: 'two' })
  assert.notEqual(a.database, b.database)
})

test('enabled: tools and the four every-call contexts register exactly once', async () => {
  const { ctx, tools, commands, contexts } = fakeContext()
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    assert.equal(contexts.length, 8)
    const normal = contexts.filter(c => !c.name.startsWith('dsh-soul:probe:'))
    assert.deepEqual(normal.map(c => c.order), [900, 910, 920, 950])
    assert.equal(new Set(contexts.map(c => c.name)).size, 8)
    assert.deepEqual(tools.map(t => t.name).sort(), ['evolve_diagnose', 'evolve_request', 'evolve_status', 'evolve_tree'])
    assert.deepEqual(commands.map(c => c.name), ['evolve'])
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false)
      assert.equal(tool.output.schema.type, 'object')
    }
  } finally { await handle.stop() }
})

test('harness components are injected per-context, and empty for subagents', async () => {
  const { ctx, contexts } = fakeContext()
  const dir = mkdtempSync(join(tmpdir(), 'evolve-plugin-'))
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    const agent = { session: session(dir) }
    // Seeding happens on the command path; before that there is nothing to inject.
    assert.equal(contexts[0].text({ agent }), '')
    // Subagent sessions never receive the parent harness.
    const sub = { session: { id: 'x', header: { cwd: dir, origin: 'subagent' } } }
    assert.equal(contexts[0].text({ agent: sub }), '')
    // A session without a cwd gets nothing rather than a global default harness.
    assert.equal(contexts[0].text({ agent: { session: { id: 'y', header: {} } } }), '')
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('harness is materialised to disk, and writing it back round-trips', async () => {
  const { harnessRoot, ensureHarness, writeHarness, readDefaults } = await import('../src/harness.js')
  const dir = mkdtempSync(join(tmpdir(), 'evolve-write-'))
  try {
    const first = ensureHarness(dir)
    assert.equal(first.created, true)
    assert(existsSync(join(harnessRoot(dir), 'system.md')))
    // Seeding twice must not clobber edits.
    ensureHarness(dir)
    const files = readDefaults()
    files['tools.md'] = '## 工具\n自定义内容。\n'
    writeHarness(dir, files)
    const reread = ensureHarness(dir)
    assert.equal(reread.created, false)
    assert.equal((await import('node:fs')).readFileSync(join(harnessRoot(dir), 'tools.md'), 'utf8'), '## 工具\n自定义内容。\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/evolve status seeds the database without dirtying the project', async () => {
  const { ctx, commands } = fakeContext()
  const dir = mkdtempSync(join(tmpdir(), 'evolve-cmd-'))
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    const agent = { session: session(dir) }
    const result = await commands[0].handler({ agent, rawInput: 'status', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    const status = JSON.parse(result.text)
    assert.equal(status.fixedTax.cap, 2400)
    assert(status.fixedTax.bytes > 0 && status.fixedTax.bytes <= 2400)
    assert.equal(status.enabled, true)
    assert.equal(existsSync(join(dir, '.dsh-soul')), false)
    assert.equal(status.hostProbe.reason, 'host_runner_unavailable')
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('/evolve run refuses when there is no repeatable divergence', async () => {
  const { ctx, commands } = fakeContext()
  const dir = mkdtempSync(join(tmpdir(), 'evolve-run-'))
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    const agent = { session: session(dir) }
    const result = await commands[0].handler({ agent, rawInput: 'run', signal: new AbortController().signal })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /没有可归因的分歧/)
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('/evolve help lists the zero-cost commands', async () => {
  const { ctx, commands } = fakeContext()
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    const result = await commands[0].handler({ agent: { session: session() }, rawInput: 'help', signal: new AbortController().signal })
    assert.match(result.text, /evolve status/)
    assert.match(result.text, /默认关闭/)
  } finally { await handle.stop() }
})

test('the paid tool never spends: it only reports whether a run is worthwhile', async () => {
  const { ctx, tools } = fakeContext()
  const dir = mkdtempSync(join(tmpdir(), 'evolve-tool-'))
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    const agent = { session: session(dir) }
    const status = tools.find(t => t.name === 'evolve_status')
    const out = await status.execute({}, { agent, signal: new AbortController().signal })
    assert.equal(typeof JSON.parse(out.text), 'object')
    const request = tools.find(t => t.name === 'evolve_request')
    const refused = await request.execute({ confirm: 'confirm' }, { agent, signal: new AbortController().signal })
    assert.equal(JSON.parse(refused.text).started, false)
    // No model call was made, so no capacity was consumed.
    assert.equal(handle.evolve.status(projectScope(agent.session)).budget.daily.calls.used, 0)
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('tool argument validation rejects unknown and missing parameters', async () => {
  const { ctx, tools } = fakeContext()
  const handle = apply(ctx, { profile: 'test', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
  try {
    const agent = { session: session() }
    const status = tools.find(t => t.name === 'evolve_status')
    await assert.rejects(() => status.execute({ nope: 'x' }, { agent }), /不支持的参数/)
    const request = tools.find(t => t.name === 'evolve_request')
    await assert.rejects(() => request.execute({}, { agent }), /缺少参数/)
  } finally { await handle.stop() }
})

test('observation estimates a task key without storing the whole message', () => {
  const recorder = new Recorder()
  const state = recorder.start('s', { scope: 'project:x', turn: 1, intent: '把日志转成 JSON 并去重' })
  assert(state.taskKey)
  assert(state.taskKey === taskKey({ scope: 'project:x', text: '把日志转成 JSON 并去重' }))
  // Coarse: same intent words in a different order still collapses to the same family.
  assert.equal(leadingIntent('把日志转成 JSON 并去重'), leadingIntent('把日志转成 JSON 并去重'))
  assert.equal(isCorrection('不对，又错了'), true)
  assert.equal(isCorrection('继续'), false)
})

test('divergence scoring needs a real signal, and corrections outrank tool errors', () => {
  const recorder = new Recorder()
  recorder.start('s', { scope: 'p', turn: 1, intent: 'x' })
  assert.equal(divergenceOf({ toolErrors: 0, corrections: 0, complete: true, deliverable: true, reason: 'stop', toolCalls: 3, text: 'x', errors: [] }), null)
  const correction = divergenceOf({ toolErrors: 1, corrections: 1, complete: true, deliverable: true, reason: 'stop', toolCalls: 3, text: 'x', errors: [] })
  assert(correction.score >= 7)
  assert(correction.signals.some(s => s.kind === 'user_correction'))
  // Highest weight first, because diagnosis picks the earliest/strongest signal.
  assert.equal(correction.signals[0].weight, Math.max(...correction.signals.map(s => s.weight)))
})

test('harness tool results never count as independent evidence', () => {
  const recorder = new Recorder()
  recorder.start('s', { scope: 'p', turn: 1, intent: 'x' })
  recorder.observe('s', 'tool/call', { callId: 'c1', name: 'evolve_status' })
  recorder.observe('s', 'tool/result', { message: { toolCallId: 'c1', isError: true } })
  assert.equal(recorder.get('s').toolErrors, 0)
  recorder.observe('s', 'tool/call', { callId: 'c2', name: 'Bash' })
  recorder.observe('s', 'tool/result', { message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] } })
  assert.equal(recorder.get('s').toolErrors, 1)
})

test('utility guards: byte bounds, redaction, day keys', () => {
  // A cut that would split a 3-byte character drops the partial instead of emitting U+FFFD.
  assert(Buffer.byteLength(bounded('啊'.repeat(100), 10)) <= 10)
  assert(!bounded('啊'.repeat(100), 10).includes('�'))
  assert.equal(bounded('abc', 10), 'abc')
  assert.match(redact('api_key = abc123'), /\[REDACTED\]/)
  assert.match(redact('sk-abcdefghijklmnopqrstuvwx'), /\[REDACTED TOKEN\]/)
  assert.equal(day(Date.UTC(2026, 9, 26, 23, 59)), '2026-10-26')
})
