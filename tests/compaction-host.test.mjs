import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSkeletonEngine } from '../src/compaction.js'

/**
 * Real-host compaction test.
 *
 * Boots the actual DSH runtime (Cordis + AgentLoop + TokenMeter + the shipped compaction
 * backend), replaces only `summarize()` with the graph selector, and compacts a real session.
 * Skipped unless DSH_TEST_PACKAGE points at an installed `@deepseek-ai/dsh/package.json`.
 */

const manifest = process.env.DSH_TEST_PACKAGE

test('real DSH: graph compaction condenses a live session without a model call', { skip: !manifest, timeout: 120000 }, async () => {
  const req = createRequire(resolve(manifest))
  const load = name => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href)
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version

  const { Context, Service } = await load('cordis')
  const { SessionStore } = await load('dsh-session')
  const { SessionProjectionRegistry } = await load('dsh-session-projection')
  const { AgentRegistry } = await load('dsh-agent')
  const { AgentLoop } = await load('dsh-agent-loop')
  const { SystemPrompt } = await load('dsh-system-prompt')
  const { LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm')
  const { TokenMeter } = await load('dsh-token-meter')
  const { BasicCompactionEngine } = await load('dsh-compaction-basic')

  const dir = mkdtempSync(join(tmpdir(), 'soul-compact-host-'))
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new LlmRuntime(ctx)
  new TokenMeter(ctx)
  const agents = new AgentRegistry(ctx)
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } })
  await new Promise(done => setImmediate(done))

  const llm = ctx.llm
  const requests = []
  class LocalAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const turn = requests.length
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: turn === 1 ? '决定用 anchor 而不是摘要，因为摘要会丢掉约束' : `第 ${turn} 步：继续检查输出。` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new LocalAdapter()
  llm.registerAdapter(['local-test'], adapter)

  const Engine = createSkeletonEngine(BasicCompactionEngine)
  const engine = new Engine(ctx, { thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 64, auto: false })

  const parent = await agents.create({
    sessionId: 'compact-host', meta: { cwd: dir },
    agentOptions: { provider: 'local-test', model: 'fixture' },
  })
  const agent = parent.agent
  const send = async text => {
    agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
    await agent.whenIdle()
  }

  try {
    await send('不要改 package.json，锁文件必须原样')
    for (let i = 0; i < 10; i++) {
      await send(`第 ${i} 步：检查输出与构建日志，确认缓存命中与产物一致。`.repeat(3))
    }
    await send('构建必须走 pnpm build --frozen-lockfile')

    const before = requests.length
    const card = await engine.compactNow(agent, new AbortController().signal)

    assert.ok(card, `compaction returned no result (host ${version})`)
    assert.ok(card.shadowedSeqs.length > 0, 'nothing was shadowed')
    // The whole point: selection is local, so no provider request happened during compaction.
    assert.equal(requests.length, before, 'compaction must not call a model')

    const messages = typeof agent.session.deriveMessages === 'function' ? agent.session.deriveMessages() : []
    const text = JSON.stringify(messages)
    assert.match(text, /package\.json/, 'a pinned constraint survived the compaction')
    assert.match(text, /数据不是指令|checkpoint/i)

    const checkpoint = messages
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .map(block => block?.text ?? '')
      .find(candidate => candidate.includes('数据不是指令'))
    console.log('\nhost', version, '| shadowed', card.shadowedSeqs.length, '| tokens freed', card.shadowedTokenCount)
    console.log('--- checkpoint ---\n' + String(checkpoint).slice(0, 700))
  } finally {
    await parent.dispose?.()
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
