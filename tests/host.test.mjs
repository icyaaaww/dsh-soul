import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
const { apply, inject } = await import(process.env.DSH_SOUL_TEST_ENTRY || process.env.DSH_LEARNING_TEST_ENTRY || new URL('../index.js', import.meta.url).href)

const manifest = process.env.DSH_TEST_PACKAGE || join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/package.json')
if (process.env.DSH_TEST_PACKAGE && !existsSync(manifest)) throw new Error('Configured DSH test package is missing; refusing to skip host tests')
if (process.env.DSH_TEST_VERSION) assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, process.env.DSH_TEST_VERSION)
test('real DSH commands, durable user events, prompt assembly and schema validators', { skip: !existsSync(manifest) }, async () => {
  const req = createRequire(resolve(manifest))
  const load = name => import(pathToFileURL(req.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { SessionStore } = await load('@deepseek-ai/dsh-session')
  const { CommandRuntime } = await load('@deepseek-ai/dsh-commands')
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
  const { assertSupportedJsonSchema, validateJsonSchemaValue } = await load('@deepseek-ai/dsh-tools')
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  const prompts = new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  const commands = new CommandRuntime(ctx)
  const entries = []
  ctx.provide('tools')
  ctx.set('tools', { register(t) { entries.push(t) } })
  const handle = apply(ctx, { database: ':memory:' })
  try {
    for (const tool of entries) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema) }
    const session = sessions.create('learning-host-test', { meta: { cwd: process.cwd() } })
    const agent = { session }
    const signal = new AbortController().signal
    const invocation = await commands.execute(agent, '/learn prefer 先给结论再说明', [], signal)
    assert.equal(invocation.result.kind, 'success')
    const assembly = await prompts.assemble({ agent, scope: agent })
    assert.equal(assembly.contexts.filter(c => c.name === 'dsh-soul:memory').length, 1)
    assert(assembly.contexts.some(c => c.text.includes('先给结论')))
    const message = createUserMessage({ content: [{ type: 'text', text: '以后修复先复现故障' }], source: { kind: 'user' } })
    session.append('user/message', message, { surfaceOp: 'append' })
    const proposal = await entries.find(t => t.name === 'learning_propose').execute({ kind: 'preference', text: '修复先复现故障' }, { agent, signal })
    assert.deepEqual(validateJsonSchemaValue(entries[0].output.schema, proposal, ''), [])
    assert.equal(JSON.parse(proposal.text).status, 'candidate')
    const second = await prompts.assemble({ agent, scope: agent })
    assert(!second.contexts.some(c => c.text.includes('修复先复现故障')))
    const inbox = await commands.execute(agent, '/learn inbox', [], signal)
    assert.equal(inbox.result.kind, 'success')
    assert(inbox.result.text.includes('修复先复现故障'))
    await commands.execute(agent, '/learn prefer 修复先复现故障', [], signal)
    const confirmed = await prompts.assemble({ agent, scope: agent })
    assert(confirmed.contexts.some(c => c.text.includes('修复先复现故障')))
    const skillInput = { title: '修复故障', preconditions: ['能够复现'], steps: ['定位根因'], checks: ['验证原问题解决'], counterexamples: ['不能复现时先收集信息'] }
    const skillResult = await commands.execute(agent, `/learn skill ${JSON.stringify(skillInput)}`, [], signal)
    assert.equal(skillResult.result.kind, 'success')
    const skillId = skillResult.result.text.split('：')[1]
    await commands.execute(agent, `/learn accept ${skillId}`, [], signal)
    const cards = JSON.parse((await entries.find(t => t.name === 'learning_search').execute({ query: '修复故障' }, { agent, signal })).text)
    assert(cards.some(c => c.id === skillId && c.status === 'trial' && c.partial))
    const full = JSON.parse((await entries.find(t => t.name === 'learning_get').execute({ id: skillId }, { agent, signal })).text)
    assert.deepEqual(JSON.parse(full.text), skillInput)
  } finally { await handle.stop() }
})

test('real Cordis plugin fiber loads and awaits disposer; reload has no duplicate registrations', { skip: !existsSync(manifest) }, async () => {
  const req = createRequire(resolve(manifest)), load = name => import(pathToFileURL(req.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { CommandRuntime } = await load('@deepseek-ai/dsh-commands')
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  new CommandRuntime(ctx)
  ctx.provide('tools'); ctx.set('tools', { register() { return () => {} } })
  ctx.provide('llm'); ctx.set('llm', {})
  let handle
  const plugin = { name: 'learning-fixture', inject, apply(context, config) { handle = apply(context, config); return handle } }
  for (let i = 0; i < 2; i++) {
    const fiber = ctx.plugin(plugin, { database: ':memory:' })
    await fiber.inertia
    assert.equal(fiber.state, 2)
    assert(handle.store.stats('p'))
    await fiber.dispose()
    assert.throws(() => handle.store.stats('p'), /closed|not open|database/i)
  }
})

test('real LLM runtime and tool pipeline preserve sourced learning, usage and cancellation', { skip: !existsSync(manifest) }, async () => {
  const req = createRequire(resolve(manifest)), load = name => import(pathToFileURL(req.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { CommandRuntime } = await load('@deepseek-ai/dsh-commands')
  const { SessionStore } = await load('@deepseek-ai/dsh-session')
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
  const { LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  const commands = new CommandRuntime(ctx), tools = new ToolRuntime(ctx), llm = new LlmRuntime(ctx)
  let requests = 0, request, hang = false, started
  class LocalAdapter extends LlmAdapter {
    async *stream(options) {
      requests++; request = options
      if (hang) {
        started()
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason)
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
        return
      }
      const events = JSON.parse(options.messages[0].content[0].text)
      const evidence = events.find(e => e.role === 'user')
      yield { type: 'reasoning-delta', text: 'private test reasoning' }
      yield { type: 'text-delta', text: JSON.stringify({ memories: [{ kind: 'preference', text: '先复现问题再修复', sourceIds: [evidence.id] }] }) }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const unregister = llm.registerAdapter(['local-test'], new LocalAdapter())
  const handle = apply(ctx, { database: ':memory:', learning: true, provider: 'local-test', model: 'deterministic-fixture', idleMs: 3600000 })
  try {
    const session = sessions.create('learning-stream-test', { meta: { cwd: process.cwd() } }), agent = { session }
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '以后先复现问题再修复' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const ids = await handle.learner.tick()
    assert.equal(ids.length, 1); assert.equal(requests, 1)
    assert.equal(request.provider, 'local-test'); assert.equal(request.model, 'deterministic-fixture')
    assert.equal(request.maxTokens, 600); assert.deepEqual(request.tools, [])
    const signal = new AbortController().signal
    const candidate = await tools.execute({ callId: 'get-candidate', name: 'learning_get', arguments: { id: ids[0] }, agent, signal })
    assert.equal(candidate.isError, false)
    assert(JSON.stringify(candidate).includes('candidate'))
    assert(!JSON.stringify(candidate).includes('private test reasoning'))
    assert.equal((await commands.execute(agent, `/learn accept ${ids[0]}`, [], signal)).result.kind, 'success')
    const search = await tools.execute({ callId: 'search-active', name: 'learning_search', arguments: { query: '复现问题' }, agent, signal })
    assert.equal(search.isError, false); assert(JSON.stringify(search).includes(ids[0]))
    const status = JSON.parse((await commands.execute(agent, '/learn status', [], signal)).result.text)
    assert.equal(status.usageToday.inputTokens, 20); assert.equal(status.usageToday.cacheReadTokens, 10)
    hang = true
    const dispatch = new Promise(resolve => { started = resolve })
    await commands.execute(agent, '/learn review', [], signal)
    const running = handle.learner.tick()
    await dispatch
    await handle.learner.stop(); await running
    assert.equal(request.signal.aborted, true)
    const stopped = JSON.parse((await commands.execute(agent, '/learn status', [], signal)).result.text)
    assert(stopped.callsToday.some(c => c.outcome === 'interrupted'))
  } finally { await handle.stop(); unregister() }
  assert.equal(tools.get('learning_get'), undefined)
})

test('host reload preserves disk memories and revisions; forgetting survives reopening', { skip: !existsSync(manifest) }, async () => {
  const req = createRequire(resolve(manifest)), load = name => import(pathToFileURL(req.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { CommandRuntime } = await load('@deepseek-ai/dsh-commands')
  const { SessionStore } = await load('@deepseek-ai/dsh-session')
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
  const folder = mkdtempSync(join(tmpdir(), 'soul-host-disk-'))
  const ctx = new Context(), sessions = new SessionStore(ctx)
  const prompts = new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  const commands = new CommandRuntime(ctx)
  new ToolRuntime(ctx)
  const session = sessions.create('disk-test', { meta: { cwd: folder } }), agent = { session }, signal = new AbortController().signal
  let handle
  const run = async raw => {
    const result = (await commands.execute(agent, `/learn ${raw}`, [], signal)).result
    assert.equal(result.kind, 'success', result.text)
    return result.text
  }
  try {
    handle = apply(ctx, { database: join(folder, 'memory.sqlite') })
    const first = (await run('prefer 回答先给结论')).split('：')[1]
    await handle.stop()
    handle = apply(ctx, { database: join(folder, 'memory.sqlite') })
    assert((await prompts.assemble({ agent, scope: agent })).contexts.some(c => c.text.includes('回答先给结论')))
    const next = (await run(`revise ${first} 回答先说明条件`)).split('：')[1]
    assert.equal(JSON.parse(await run(`show ${next}`)).version, 2)
    await handle.stop()
    handle = apply(ctx, { database: join(folder, 'memory.sqlite') })
    const assembly = await prompts.assemble({ agent, scope: agent })
    assert(assembly.contexts.some(c => c.text.includes('回答先说明条件')))
    assert(!assembly.contexts.some(c => c.text.includes('回答先给结论')))
    await run(`forget ${next}`)
    await handle.stop()
    handle = apply(ctx, { database: join(folder, 'memory.sqlite') })
    assert.equal(JSON.parse(await run('list active')).length, 0)
    assert(!(await prompts.assemble({ agent, scope: agent })).contexts.some(c => c.name === 'dsh-soul:memory' && c.text.trim()))
    assert.equal(handle.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { await handle?.stop(); rmSync(folder, { recursive: true, force: true }) }
})

test('real host compatibility gate accepts the release and rejects untested versions', { skip: !existsSync(manifest) }, async () => {
  const req = createRequire(resolve(manifest))
  const { evaluatePluginCompatibility } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
  const entry = process.env.DSH_SOUL_TEST_ENTRY || new URL('../index.js', import.meta.url).href
  const pkg = JSON.parse(readFileSync(new URL('./package.json', entry), 'utf8'))
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version
  assert.equal(evaluatePluginCompatibility(pkg, {}, version), undefined)
  // 0.2.0's gate only reads peers. Verify engines rejection using the newer gate.
  if (version === '0.2.1-rc.2') {
    const old = { ...pkg, version: '0.2.0', engines: { ...pkg.engines, dsh: '0.2.0-rc.2' } }
    assert.equal(evaluatePluginCompatibility(old, {}, version).requirements['engines.dsh'], '0.2.0-rc.2')
    for (const unsupported of ['0.2.1-rc.1', '0.2.1', '0.3.0']) {
      assert(evaluatePluginCompatibility(pkg, {}, unsupported))
    }
  }
})
