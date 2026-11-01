import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const manifest = process.env.DSH_TEST_PACKAGE
const unsupported = manifest && JSON.parse(readFileSync(manifest, 'utf8')).version === '0.2.0-rc.2'
const plugin = await import(process.env.DSH_SOUL_TEST_ENTRY ?? new URL('../index.js', import.meta.url).href)
test('real DSH: memory-only works without a plugin model route and never spends on evolution', { skip: !manifest ? 'DSH_TEST_PACKAGE not set' : unsupported ? '0.2.0 is outside engines.dsh; rejection is tested in host.test.mjs' : false }, async () => {
  const req = createRequire(resolve(manifest)), load = name => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href)
  const { Context } = await load('cordis')
  const { SessionStore } = await load('dsh-session')
  const { SessionProjectionRegistry } = await load('dsh-session-projection')
  const { AgentRegistry } = await load('dsh-agent')
  const { AgentLoop } = await load('dsh-agent-loop')
  const { SystemPrompt } = await load('dsh-system-prompt')
  const { ToolRuntime } = await load('dsh-tools')
  const { CommandRuntime } = await load('dsh-commands')
  const { LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm')
  const ctx = new Context(), dir = mkdtempSync(join(tmpdir(), 'soul-memory-host-'))
  let parent, handle
  try {
    new SessionStore(ctx); new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    const tools = new ToolRuntime(ctx), commands = new CommandRuntime(ctx)
    // Mount before llm and skills exist: memory must not wait for these services.
    const fiber = ctx.plugin({ ...plugin, apply(context, config) { return handle = plugin.apply(context, config) } },
      { database: ':memory:', profile: 'test', enabled: false, memory: { enabled: true }, injectHarness: false })
    await fiber.await()
    assert.equal(fiber.state, 2)
    assert.equal(handle.evolve, undefined)
    assert.ok(tools.get('soul_recall'))
    assert.equal(tools.get('evolve_delegate'), undefined)
    const llm = new LlmRuntime(ctx), requests = []
    class Adapter extends LlmAdapter {
      async *stream(options) {
        requests.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '已记录，继续检查。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已记录，继续检查。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    llm.registerAdapter(['fixture'], new Adapter())
    const agents = new AgentRegistry(ctx)
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } })
    await new Promise(done => setImmediate(done))
    parent = await agents.create({ sessionId: 'memory-only', meta: { cwd: dir }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const send = async text => {
      parent.agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
      await parent.agent.whenIdle()
    }
    await send('不要修改 package.json，锁文件必须原样')
    const run = async text => (await commands.execute(parent.agent, text, [], new AbortController().signal)).result
    assert.match((await run('/mem show')).text, /package.json/)
    await send('继续检查文件')
    assert.equal(requests.length, 2)
    assert.match(JSON.stringify(requests[1]), /package.json/)
    assert.equal((await run('/evolve run')).kind, 'error')
    assert.equal(handle.store.db.prepare('SELECT COUNT(*) AS n FROM call').get().n, 0)
    await fiber.dispose()
    assert.equal(tools.get('soul_recall'), undefined)
  } finally {
    await parent?.dispose?.()
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
