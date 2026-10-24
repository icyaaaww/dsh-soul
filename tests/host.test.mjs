import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
const { apply, inject } = await import(process.env.DSH_SOUL_TEST_ENTRY || process.env.DSH_LEARNING_TEST_ENTRY || new URL('../index.js', import.meta.url).href)

const manifest = process.env.DSH_TEST_PACKAGE || join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/package.json')
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
