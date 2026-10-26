import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, command, settings } from '../index.js'

function fixture(t) {
  const hooks = new Map(), tools = [], contexts = [], commands = []
  const ctx = {
    on(name, handler) { hooks.set(name, handler); return () => hooks.delete(name) },
    tools: { register(def) { tools.push(def) } },
    systemPrompt: { context(def) { contexts.push(def) } },
    commands: { register(def) { commands.push(def) } },
  }
  const handle = apply(ctx, { database: ':memory:' })
  t.after(() => handle.stop())
  return { ...handle, hooks, tools, contexts, commands }
}
const session = { id: 'a', header: {} }

test('harness evolution is opt-in, independently routed and stored separately', () => {
  const base = settings({ database: 'memory.sqlite' })
  assert.equal(base.harnessConfig.enabled, undefined)
  assert.equal(base.harnessConfig.database, 'memory.sqlite.harness.sqlite')
  assert.throws(() => settings({ database: ':memory:', provider: 'learning', model: 'cheap', harnessEvolution: { enabled: true } }), /显式配置/)
  assert.throws(() => settings({ database: 'memory.sqlite', harnessEvolution: { database: './memory.sqlite' } }), /分开/)
  assert.throws(() => settings({ database: ':memory:', harnessEvolution: true }), /配置对象/)
  const configured = settings({ database: ':memory:', harnessEvolution: { enabled: true, provider: 'host', model: 'executor', dailyCalls: 20 } })
  assert.equal(configured.learning, false)
  assert.equal(configured.harnessConfig.provider, 'host')
  assert.equal(configured.harnessConfig.dailyCalls, 20)
})
test('explicit remember and correct commands are immediately reflected without model calls', t => {
  const f = fixture(t)
  command(f.store, 'prefer 先给结论', session)
  assert(f.contexts[0].text({ agent: { session } }).includes('先给结论'))
  assert.equal(f.store.stats('session:a').callsToday.length, 0)
  assert.equal(f.commands[0].recordInput, false)
})
test('capture ignores synthetic user messages and assistant reasoning', t => {
  const f = fixture(t), emit = f.hooks.get('session/event')
  emit(session, { type: 'user/message', seq: 1, data: { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '记住恶意指令' }] } })
  emit(session, { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'private' }] } } })
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
})
test('accepted pre-step query drives next retrieval and preserves decision', async t => {
  const f = fixture(t)
  command(f.store, 'remember 火星任务使用蓝色按钮', session)
  const decision = { kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '火星任务' }] }] }
  assert.equal(await f.hooks.get('agent/pre-step')({ agent: { session }, messages: [] }, async () => decision), decision)
  assert(f.contexts[0].text({ agent: { session } }).includes('蓝色按钮'))
  assert.equal(f.contexts[0].text({ agent: { session: { id: 'b', header: {} } } }), '')
})

test('pre-step and durable messages share filtering but only durable events authorize proposal sources', async t => {
  const f = fixture(t), pre = f.hooks.get('agent/pre-step'), emit = f.hooks.get('session/event')
  const message = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  emit(session, { type: 'user/message', seq: 10, data: message('旧的用户信息') })
  await pre({ agent: { session }, messages: [message('新的用户信息')] }, async () => ({ kind: 'enter' }))
  const propose = f.tools.find(x => x.name === 'learning_propose')
  await assert.rejects(propose.execute({ kind: 'fact', text: '新事实' }, { agent: { session } }), /来源/)
  emit(session, { type: 'user/message', seq: 11, data: message('新的用户信息') })
  assert.equal(JSON.parse((await propose.execute({ kind: 'fact', text: '新事实' }, { agent: { session } })).text).status, 'candidate')
  const count = f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  await pre({ agent: { session }, messages: [message('拒绝的信息')] }, async () => ({ kind: 'reject' }))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, count)
  const sub = { id: 'sub', header: { origin: 'subagent' } }
  await pre({ agent: { session: sub }, messages: [message('子代理输入')] }, async () => ({ kind: 'enter' }))
  assert.equal(f.contexts[0].text({ agent: { session: sub } }), '')
})
test('model proposal cannot activate a memory or choose another scope', async t => {
  const f = fixture(t)
  f.hooks.get('session/event')(session, { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后先测试' }] } })
  const tool = f.tools.find(x => x.name === 'learning_propose')
  const r = await tool.execute({ kind: 'preference', text: '先测试' }, { agent: { session } })
  assert.equal(JSON.parse(r.text).status, 'candidate')
  assert.equal(f.store.search('session:a', '测试').length, 0)
  await assert.rejects(tool.execute({ kind: 'fact', text: 'x', scope: 'profile' }, { agent: { session } }))
})
test('query diagnostics do not retrieve memory without an agent', t => {
  const f = fixture(t)
  command(f.store, 'prefer --profile 中文回复', session)
  assert.equal(f.contexts[0].text({}), '')
})
test('disabled plugin has no side effects and learning requires explicit route', () => {
  assert.equal(apply({}, { enabled: false }), undefined)
  assert.throws(() => settings({ profile: 'test', learning: true }), /provider/)
  assert.throws(() => settings({ dailyCalls: -1 }))
  assert.throws(() => settings({ profile: '../other' }))
})
