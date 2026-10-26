import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHostRunner } from '../src/host-runner.js'
import { hostProbe } from '../src/host-probe.js'
import { readDefaults } from '../src/harness.js'
const pluginModule = await import(process.env.DSH_SOUL_TEST_ENTRY ?? new URL('../../../index.js', import.meta.url).href)
import { projectScope } from '../src/util.js'

const manifest = process.env.DSH_TEST_PACKAGE
test('real DSH: spawn integration on 0.2.1, explicit refusal on 0.2.0', { skip: !manifest, timeout: 30000 }, async () => {
  const req = createRequire(resolve(manifest)), load = name => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href)
  const { Context } = await load('cordis')
  const { SessionStore } = await load('dsh-session')
  const { SessionProjectionRegistry } = await load('dsh-session-projection')
  const { AgentRegistry } = await load('dsh-agent')
  const { AgentLoop } = await load('dsh-agent-loop')
  const { SystemPrompt } = await load('dsh-system-prompt')
  const { ToolRuntime } = await load('dsh-tools')
  const { LlmRuntime, LlmAdapter } = await load('dsh-llm')
  const { default: SubagentRuntime } = await load('dsh-subagent')
  if (JSON.parse(readFileSync(manifest, 'utf8')).version === '0.2.0-rc.2') {
    assert.equal(typeof SubagentRuntime.prototype.startActivation, 'undefined')
    const ctx = new Context()
    new SystemPrompt(ctx, { includeHarnessIdentity: false })
    new AgentRegistry(ctx)
    const runner = createHostRunner(ctx)
    assert.equal(runner.capability().reason, 'host_runner_unavailable')
    runner.stop(); await ctx.fiber.dispose()
    return
  }
  const { WorkingDirectoryService } = await load('dsh-working-directory')
  const { LocalFileSystem } = await load('dsh-fs-local')
  const { CommandRuntime } = await load('dsh-commands')
  const { createUserMessage } = await load('dsh-llm')
  const { evaluatePluginCompatibility } = await load('dsh-app-boot')
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.1-rc.2'), undefined)
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.0-rc.2'), undefined)
  const spawnProvider = await load('dsh-subagent-spawn-in-process')
  const dir = mkdtempSync(join(tmpdir(), 'evolve-real-host-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-q'); writeFileSync(join(dir, 'README.md'), 'host integration fixture\n')
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  const ctx = new Context()
  new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  new LocalFileSystem(ctx, { cwd: dir, diffBasisMaxBytes: 1048576 }); new WorkingDirectoryService(ctx, { defaultDirectory: dir })
  const agents = new AgentRegistry(ctx), tools = new ToolRuntime(ctx), llm = new LlmRuntime(ctx)
  const commands = new CommandRuntime(ctx)
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } })
  new SubagentRuntime(ctx, { maxDepth: { get: () => 1 }, maxActiveSubagents: { get: () => 8 } })
  spawnProvider.apply(ctx, { providerName: 'spawn' })
  if (process.env.DSH_EVOLVE_DEBUG) ctx.on('session/event', (s, e) => console.error(s.id, e.type, JSON.stringify(e.data).slice(0, 1200)))
  await new Promise(resolve => setImmediate(resolve))
  let requests = [], toolCwd, mode = 'normal', started, edits = 0
  class LocalAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const lastUser = options.messages.findLastIndex(m => m.role === 'user')
      let data
      try { data = JSON.parse(options.messages[lastUser]?.content?.find(b => b.type === 'text')?.text) } catch {}
      if (data?.index?.target) {
        edits++
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ actions: [
          { type: 'write', path: 'harness/tools.md', text: edits === 1 ? '检查参数，失败时停止并报告原因。' : '先检查参数，失败时停止并报告原因。' }, { type: 'finish', why: 'reduce tool errors' }] }) }
        yield { type: 'usage', usage: { inputTokens: 19, outputTokens: 11 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (mode === 'hang') {
        started()
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason)
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
        return
      }
      if (!options.messages.slice(lastUser + 1).some(m => m.role === 'tool') || mode === 'loop') {
        const block = { type: 'tool-call', id: 'call-' + requests.length, name: 'fixture_write', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 7 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  llm.registerAdapter(['local-test'], new LocalAdapter())
  tools.register({ name: 'fixture_write', description: 'Write fixture output', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_, value) => [{ type: 'text', text: value.text }] },
    execute: async (_, exec) => {
      toolCwd = ctx.workingDirectory.get(exec.agent.session)
      if (mode === 'baseline') throw new Error('invalid parameters')
      if (exec.agent.session.header.origin === 'subagent') writeFileSync(join(toolCwd, 'result.txt'), 'ok')
      return { text: 'written' }
    } })
  const parent = await agents.create({ sessionId: 'test-parent', meta: { cwd: dir }, agentOptions: { provider: 'local-test', model: 'fixture' } })
  const runner = createHostRunner(ctx), settled = [], payloads = []
  const execute = hostProbe({ spawn: runner.spawn, capability: runner.capability, provider: 'local-test', model: 'fixture', steps: 3 })
  const files = { ...readDefaults(), 'memory.md': 'CANDIDATE_SENTINEL' }
  const reserve = payload => { payloads.push(payload); return { settle: (outcome, usage) => settled.push({ outcome, usage }) } }
  const input = { parent: parent.agent, root: dir, files, task: 'write result', reserve, signal: new AbortController().signal,
    checks: [{ name: 'artifact', argv: [process.execPath, '-e', "if(require('fs').readFileSync('result.txt','utf8')!=='ok')process.exit(1)"] }] }
  try {
    assert.equal(runner.capability(parent.agent).ok, true)
    await execute.preflight({ cwd: dir, parent: parent.agent })
    const result = await execute(input)
    assert.equal(result.metrics.complete, true, JSON.stringify(result))
    assert.equal(result.metrics.deliverable, true)
    assert.equal(result.metrics.steps, 2); assert.equal(result.metrics.toolCalls, 1); assert.equal(result.metrics.toolErrors, 0)
    assert.equal(result.transcript, 'done'); assert.equal(result.checks[0].ok, true)
    assert.equal(requests.length, 2); assert.equal(settled.length, 2)
    assert(settled.every(s => s.outcome === 'ok' && s.usage.inputTokens > 0))
    assert(requests.every(r => JSON.stringify(r.messages).includes('CANDIDATE_SENTINEL')))
    assert(payloads.every(p => p.includes('CANDIDATE_SENTINEL')))
    assert.notEqual(toolCwd, dir); assert.equal(existsSync(toolCwd), false)
    assert.equal(existsSync(join(dir, 'result.txt')), false); assert.equal(git('status', '--porcelain'), '')
    assert.deepEqual(agents.list().map(a => a.id), ['test-parent'])
    assert.equal(git('worktree', 'list', '--porcelain').match(/worktree /g).length, 1)

    requests = []
    await assert.rejects(() => execute({ ...input, reserve: () => { throw Object.assign(new Error('input_limit'), { code: 'input_limit' }) } }), error => error.code === 'input_limit')
    assert.equal(requests.length, 0); assert.equal(agents.list().length, 1)

    const failedCheck = await execute({ ...input, checks: [{ name: 'fails', argv: [process.execPath, '-e', 'process.exit(1)'] }] })
    assert.equal(failedCheck.checks[0].ok, false); assert.equal(failedCheck.metrics.deliverable, false)

    mode = 'loop'; requests = []
    await assert.rejects(() => execute(input), error => error.code === 'probe_step_limit')
    assert.equal(requests.length, 3); assert.equal(agents.list().length, 1)

    mode = 'hang'; requests = []
    const controller = new AbortController(), dispatched = new Promise(resolve => { started = resolve })
    const running = execute({ ...input, signal: controller.signal })
    await dispatched
    controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    await assert.rejects(() => running, /cancelled/)
    assert.equal(requests[0].signal.aborted, true); assert.equal(agents.list().length, 1)
    runner.stop()
    const timedRunner = createHostRunner(ctx, { requestTimeoutMs: 100 })
    try {
      const timed = hostProbe({ spawn: timedRunner.spawn, capability: timedRunner.capability, provider: 'local-test', model: 'fixture' })
      await assert.rejects(() => timed(input), error => error.code === 'request_timeout')
      assert.equal(agents.list().length, 1)
    } finally { timedRunner.stop() }

    // Full plugin commands use actual AgentLoop observations, not fabricated episode rows.
    let handle
    let soul
    const fiber = ctx.plugin({ ...pluginModule, apply(context, config) { soul = pluginModule.apply(context, config); handle = soul.harness; return soul } },
      { enabled: true, profile: 'test', database: ':memory:', harnessEvolution: { enabled: true, provider: 'local-test', model: 'fixture',
      checks: input.checks, cooldownTurns: 0, shadowWindow: 2 } })
    await fiber.inertia
    assert.equal(fiber.state, 2)
    const command = async text => (await commands.execute(parent.agent, '/evolve ' + text, [], new AbortController().signal)).result
    const turn = async text => {
      parent.agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
      await parent.agent.whenIdle()
    }
    try {
      const scope = projectScope(parent.agent.session)
      assert.equal((await command('status')).kind, 'success')
      const remembered = await commands.execute(parent.agent, '/learn remember 保留现有记忆功能', [], new AbortController().signal)
      assert.equal(remembered.result.kind, 'success')
      const recalled = await commands.execute(parent.agent, '/learn search 保留现有记忆功能', [], new AbortController().signal)
      assert(recalled.result.text.includes('保留现有记忆功能'))
      assert.notEqual(soul.store.db, handle.store.db)
      assert.equal(git('status', '--porcelain'), '')
      mode = 'baseline'
      for (let i = 0; i < 3; i++) await turn('write result')
      const diagnosis = await command('diagnose')
      assert.equal(JSON.parse(diagnosis.text).repeats, 3, diagnosis.text)
      mode = 'normal'; requests = []
      const launched = await command('run')
      assert.equal(launched.kind, 'success', launched.text)
      const outcome = await handle.evolve.running
      assert.equal(outcome.state, 'shadow', JSON.stringify(outcome))
      assert.equal(outcome.cost.calls, 3)
      assert.equal(handle.store.db.prepare('SELECT COUNT(*) AS n FROM call').get().n, 3)
      assert.equal(git('status', '--porcelain'), '')
      for (let i = 0; i < 2; i++) await turn('write result')
      assert.equal(handle.evolve.current(scope).state, 'stable')
      // A correction on the next turn is attributed to the previous task and rolls back.
      mode = 'baseline'; await turn('write result')
      mode = 'normal'
      const second = await command('run')
      assert.equal(second.kind, 'success', second.text)
      await handle.evolve.running
      const beforeCorrection = handle.evolve.current(scope)
      assert.equal(beforeCorrection.state, 'shadow')
      await turn('不对，还是不行')
      assert.notEqual(handle.evolve.current(scope).rev, beforeCorrection.rev)
      assert.equal(handle.evolve.current(scope).state, 'stable')
    } finally { await fiber.dispose() }
    assert.equal(tools.get('evolve_status'), undefined)
    assert.equal(tools.get('learning_search'), undefined)
  } finally {
    runner.stop(); await parent.dispose(); await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
