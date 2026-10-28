import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { projectScope } from '../src/util.js'

/**
 * Offline demo of the memory skeleton: feed two turns through the real plugin hooks, then
 * print exactly what would be injected, what is stored, and what a recall returns.
 * No model call is made anywhere in this file.
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

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

const dir = mkdtempSync(join(tmpdir(), 'soul-demo-'))
writeFileSync(join(dir, 'store.js'), 'export const schema = 4\n')

const { ctx, contexts, tools, handlers } = fakeContext()
const handle = apply(ctx, { profile: 'demo', database: ':memory:', enabled: true, provider: 'p', model: 'm' })
const session = { id: 'demo-1', header: { cwd: dir } }
const agent = { session }
const preStep = handlers.get('agent/pre-step')
const sessionEvent = handlers.get('session/event')

async function turn(message, extra = []) {
  const next = async () => ({ kind: 'accept', messages: [message] })
  await preStep({ agent, messages: [message], step: 1 }, next)
  for (const event of extra) sessionEvent(session, event)
  sessionEvent(session, { type: 'turn/end', data: {} })
}

try {
  await turn(user('不要改 package.json，锁文件必须原样；探测必须在 git worktree 里跑'), [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'write', input: { path: 'store.js' } }] } } },
    { type: 'tool/result', data: { content: [{ type: 'text', text: 'ok' }], isError: false } },
  ])

  await turn(user('继续'), [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '决定用 anchor 而不是摘要，因为摘要会丢约束' }] } } },
  ])

  const provider = contexts.find(context => context.name === 'dsh-soul:memory')
  const scope = projectScope({ id: session.id, header: { cwd: dir } })
  console.log('=== 每轮注入（纯函数、不进历史） ===')
  console.log(provider.text({ agent }))
  console.log('\n=== 存储 ===')
  console.log(JSON.stringify(handle.store.memoryStats(scope), null, 2))
  const recallTool = tools.find(tool => tool.name === 'soul_recall')
  console.log('\n=== soul_recall("package.json") ===')
  const recalled = await recallTool.execute({ query: 'package.json' }, { agent })
  console.log(JSON.stringify(JSON.parse(recalled.text), null, 2))
} finally {
  await handle.stop()
  rmSync(dir, { recursive: true, force: true })
}
