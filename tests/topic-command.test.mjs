import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { projectScope } from '../src/util.js'

function fakeContext() {
  const tools = [], commands = [], contexts = [], handlers = new Map()
  const ctx = {
    tools: { register: tool => { tools.push(tool); return () => {} } },
    commands: { register: command => { commands.push(command); return () => {} } },
    systemPrompt: { context: value => { contexts.push(value); return () => {} } },
    on: (event, handler) => { handlers.set(event, handler); return () => {} },
    get: () => undefined,
  }
  return { ctx, tools, commands, contexts, handlers }
}

const session = { id: 'topic-session', header: { cwd: process.cwd() } }
const agent = { session }
const addNode = (id, kind, claim, seq) => ({ id, kind, claim, session: session.id, seq })

test('opt-in topic tool and command route to current source-backed child evidence', async t => {
  const { ctx, tools, commands } = fakeContext()
  const handle = apply(ctx, { profile: 'topics', database: ':memory:', memory: { topics: true } })
  t.after(() => handle.stop())
  const scope = projectScope(session)
  handle.store.recordNodes(scope, { nodes: [
    addNode('auth-decision', 'decision', 'src/auth/login.js 登录校验改为严格匹配。', 4),
    addNode('auth-progress', 'progress', 'src/auth/login.js 严格匹配已验证。', 12),
  ] })
  handle.store.putSpans(scope, session.id, [
    { seq: 4, kind: 'user/message', text: '原始决定：src/auth/login.js 登录校验改为严格匹配。', hash: 'source-4' },
    { seq: 12, kind: 'tool/result', text: '测试结果：src/auth/login.js 严格匹配已验证。', hash: 'source-12' },
  ])

  const tool = tools.find(item => item.name === 'soul_topic')
  assert.ok(tool)
  const find = async args => JSON.parse((await tool.execute(args, { agent })).text)
  const result = await find({ query: 'src/auth/login.js' })
  assert.equal(result.topics.length, 1)
  assert.equal(result.topics[0].count, 2)
  const expanded = await find({ id: result.topics[0].id })
  assert.deepEqual(expanded.members.map(member => member.seq), [4, 12])
  assert.match(expanded.members[0].excerpt, /原始决定/)
  assert.match(expanded.members[1].excerpt, /测试结果/)

  const mem = commands.find(command => command.name === 'mem')
  const listed = await mem.handler({ agent, rawInput: 'topics src/auth/login.js' })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /src\/auth\/login\.js/)
  const opened = await mem.handler({ agent, rawInput: `topic ${result.topics[0].id}` })
  assert.equal(opened.kind, 'success')
  assert.match(opened.text, /原始决定/)
})

test('topic tool is absent unless explicitly enabled', async t => {
  const { ctx, tools } = fakeContext()
  const handle = apply(ctx, { profile: 'topics-off', database: ':memory:' })
  t.after(() => handle.stop())
  assert.equal(tools.some(item => item.name === 'soul_topic'), false)
})
