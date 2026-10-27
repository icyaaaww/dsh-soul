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
const pluginModule = await import(process.env.DSH_SOUL_TEST_ENTRY ?? new URL('../index.js', import.meta.url).href)
import { projectScope } from '../src/util.js'

const manifest = process.env.DSH_TEST_PACKAGE
test('real DSH: spawn integration on 0.2.1, explicit refusal on 0.2.0', { skip: !manifest, timeout: 90000 }, async () => {
  const req = createRequire(resolve(manifest)), load = name => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href)
  const hostVersion = JSON.parse(readFileSync(manifest, 'utf8')).version
  if (process.env.DSH_TEST_VERSION) assert.equal(hostVersion, process.env.DSH_TEST_VERSION)
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
    await runner.stop(); await ctx.fiber.dispose()
    return
  }
  const { WorkingDirectoryService } = await load('dsh-working-directory')
  const { LocalFileSystem } = await load('dsh-fs-local')
  const { CommandRuntime } = await load('dsh-commands')
  const { SkillRegistry } = await load('dsh-skill')
  const skillTool = await load('dsh-tool-skill')
  const { createUserMessage } = await load('dsh-llm')
  // 0.2.0 only checks peerDependencies; engines.dsh is enforced by the newer host.
  const { evaluatePluginCompatibility } = await load('dsh-app-boot')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.1-rc.2'), undefined)
  assert.notEqual(evaluatePluginCompatibility(pkg, {}, '0.2.0-rc.2'), undefined)
  const spawnProvider = await load('dsh-subagent-spawn-in-process')
  const dir = mkdtempSync(join(tmpdir(), 'evolve-real-host-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-q'); writeFileSync(join(dir, 'README.md'), 'host integration fixture\n')
  writeFileSync(join(dir, '.gitignore'), 'result.txt\n')
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  const ctx = new Context()
  new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  new LocalFileSystem(ctx, { cwd: dir, diffBasisMaxBytes: 1048576 }); new WorkingDirectoryService(ctx, { defaultDirectory: dir })
  const agents = new AgentRegistry(ctx), tools = new ToolRuntime(ctx), llm = new LlmRuntime(ctx)
  const commands = new CommandRuntime(ctx)
  const skills = new SkillRegistry(ctx)
  skillTool.apply(ctx)
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } })
  new SubagentRuntime(ctx, { maxDepth: { get: () => 3 }, maxActiveSubagents: { get: () => 8 } })
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
      const taskUser = options.messages.findLastIndex(m => m.role === 'user' && m.source?.kind === 'user')
      if (mode === 'component-probe' && JSON.stringify(options.messages[taskUser]).includes('component-run')) {
        const completed = options.messages.slice(taskUser + 1).filter(m => m.role === 'tool').length
        const actions = [
          ['skill', {name:'soul-build-check'}],
          ['evolve_script', {name:'sum',input:'{"a":2,"b":3}'}],
          ['evolve_delegate', {task:'delegated-only'}],
          ['fixture_native_delegate', {}],
          ['fixture_write', {}],
        ]
        if (completed < actions.length) {
          const [name,args] = actions[completed]
          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'block-end',index:0,block:{type:'tool-call',id:'component-'+requests.length,name,arguments:JSON.stringify(args)}}
          yield {type:'usage',usage:{inputTokens:13,outputTokens:7}}
          yield {type:'finish',reason:{kind:'tool-calls'}}
          return
        }
        yield {type:'text-delta',index:0,text:'components done'}
        yield {type:'usage',usage:{inputTokens:13,outputTokens:7}}
        yield {type:'finish',reason:{kind:'stop'}}
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
      const expected = edits <= 1 ? '检查参数，失败时停止并报告原因。' : '先检查参数，失败时停止并报告原因。'
      const correct = mode !== 'evolution' || JSON.stringify(requests.at(-1).messages).includes(expected)
      writeFileSync(join(toolCwd, 'result.txt'), correct ? 'ok' : 'bad')
      return { text: 'written' }
    } })
  tools.register({name:'fixture_native_delegate',description:'Use native host delegation',parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text']},render:(_,v)=>[{type:'text',text:v.text}]},
    async execute(_,exec) {
      const activation = await ctx.subagents.startActivation({provider:'spawn',childId:'native-fixture-'+requests.length,label:'Native fixture',delivery:'caller',signal:exec.signal,
        request:{parent:exec.agent,cwd:ctx.workingDirectory.get(exec.agent.session),prompt:[{type:'text',text:'native-child'}],agentOptions:{provider:'local-test',model:'fixture'},maxDepth:3}})
      try {return {text:(await activation.result).stopReason}} finally {await activation.dispose()}
    }})
  const parent = await agents.create({ sessionId: 'test-parent', meta: { cwd: dir }, agentOptions: { provider: 'local-test', model: 'fixture' } })
  const runner = createHostRunner(ctx), settled = [], payloads = []
  const execute = hostProbe({ spawn: runner.spawn, capability: runner.capability, provider: 'local-test', model: 'fixture', steps: 3 })
  const files = { ...readDefaults(), 'memory.md': 'CANDIDATE_SENTINEL' }
  const reserve = payload => { payloads.push(payload); return { settle: (outcome, usage) => settled.push({ outcome, usage }) } }
  const input = { parent: parent.agent, root: dir, files, task: 'write result', reserve, signal: new AbortController().signal,
    checks: [{ name: 'artifact', argv: [process.execPath, '-e', "if(require('fs').readFileSync('result.txt','utf8')!=='ok')process.exit(1)"] }] }
  try {
    assert.equal(runner.capability(parent.agent).ok, true)
    await execute.preflight({ cwd: dir, parent: parent.agent, checks: input.checks })
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
    await runner.stop()
    const timedRunner = createHostRunner(ctx, { requestTimeoutMs: 100 })
    try {
      const timed = hostProbe({ spawn: timedRunner.spawn, capability: timedRunner.capability, provider: 'local-test', model: 'fixture' })
      await assert.rejects(() => timed(input), error => error.code === 'request_timeout')
      assert.equal(agents.list().length, 1)
    } finally { await timedRunner.stop() }

    // Full plugin commands use actual AgentLoop observations, not fabricated episode rows.
    let handle
    const fiber = ctx.plugin({ ...pluginModule, apply(context, config) { handle = pluginModule.apply(context, config); return handle } },
      { enabled: true, profile: 'test', database: ':memory:', provider: 'local-test', model: 'fixture',
      checks: input.checks, cooldownTurns: 0, shadowWindow: 2 })
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
      assert.equal(tools.get('learning_search'), undefined)
      assert.equal(git('status', '--porcelain'), '')
      mode = 'baseline'
      for (let i = 0; i < 3; i++) await turn('write result')
      const diagnosis = await command('diagnose')
      assert.equal(JSON.parse(diagnosis.text).repeats, 3, diagnosis.text)
      mode = 'evolution'; requests = []
      const launched = await command('run')
      assert.equal(launched.kind, 'success', launched.text)
      const outcome = await handle.evolve.running
      assert.equal(outcome.state, 'shadow', JSON.stringify(outcome))
      assert.equal(outcome.cost.calls, 9)
      assert.equal(handle.store.db.prepare('SELECT COUNT(*) AS n FROM call').get().n, 9)
      assert.equal(git('status', '--porcelain'), '')
      mode = 'normal'
      assert.equal((await command('verify')).kind, 'error', 'no real task under the trial yet')
      for (let i = 0; i < 2; i++) {
        await turn('write result')
        assert.equal(handle.evolve.current(scope).state, 'shadow', 'silence is not proof of correctness')
        const verified = await command('verify')
        assert.equal(verified.kind, 'success', verified.text)
        assert.equal((await command('verify')).kind, 'error', 'cannot count one task twice')
      }
      assert.equal(handle.evolve.current(scope).state, 'stable')
      // All eight components must execute through real host services, including
      // the skill provider, native skill tool, script tool and post-tool hook.
      mode = 'normal'
      const stable = handle.evolve.current(scope)
      const upgraded = { ...stable.files,
        'subagents.md': 'C5_DELEGATION_SENTINEL：先明确产物，再执行子任务。',
        'skills/build-check/SKILL.md': '---\nname: build-check\ndescription: 构建验收流程\n---\nC6_SKILL_SENTINEL：先检查再交付。',
        'scripts/sum.mjs': 'export function run(x) { return {sum:x.a+x.b} }',
        'hooks/check.mjs': 'export const timeoutMs=100;export const failOpen=true;export function run(x){return {note:"C8_HOOK_SENTINEL"}}',
      }
      for (const path of ['system.md','guardrails.md','memory.md','tools.md']) upgraded[path] += '\nC1_C4_' + path
      const previousCalls = handle.store.db.prepare('SELECT COUNT(*) AS n FROM call').get().n
      requests = []; mode = 'component-probe'
      const componentProbe = await handle.evolve.execute({ ...input, files:upgraded, task:'component-run' })
      assert.equal(componentProbe.metrics.deliverable, true)
      assert.equal(componentProbe.metrics.toolErrors, 0, JSON.stringify(requests.flatMap(r=>r.messages.filter(m=>m.role==='tool'&&m.isError))))
      assert.equal(componentProbe.metrics.tokens, 200, 'own and native nested delegation usage belongs to the probe')
      assert.equal(componentProbe.metrics.steps, 10)
      assert.equal(requests.length, 10)
      assert.equal(handle.store.db.prepare('SELECT COUNT(*) AS n FROM call').get().n,previousCalls,'nested probe reserves through caller, not a separate live budget')
      for (const marker of ['C5_DELEGATION_SENTINEL','C6_SKILL_SENTINEL','C8_HOOK_SENTINEL','C1_C4_system.md','C1_C4_guardrails.md','C1_C4_memory.md','C1_C4_tools.md']) {
        assert(requests.some(r => JSON.stringify(r.messages).includes(marker)),marker)
      }
      assert(requests.some(r => JSON.stringify(r.messages).includes('\\"sum\\":5')))
      assert.equal((await skills.list({cwd:dir})).some(s=>s.name==='soul-build-check'),false,'probe does not leak skills to live project')

      mode = 'normal'
      const augmentedRev = handle.store.putRev(scope,upgraded,{parent:stable.rev,state:'stable',reason:'host-fixture'})
      handle.components.invalidate()
      assert((await skills.list({cwd:dir})).some(s=>s.name==='soul-build-check'))
      const invoke = (name,args) => tools.execute({callId:'direct-'+name,name,arguments:args,agent:parent.agent,signal:new AbortController().signal})
      const loaded = await invoke('skill',{name:'soul-build-check'})
      assert.equal(loaded.isError,false,JSON.stringify(loaded))
      assert(loaded.content.some(c=>c.text?.includes('C6_SKILL_SENTINEL')))
      const scripted = await invoke('evolve_script',{name:'sum',input:'{"a":3,"b":4}'})
      assert.equal(scripted.isError,false,JSON.stringify(scripted))
      assert.equal(JSON.parse(scripted.value.text).sum,7)
      const hooked = await invoke('fixture_write',{})
      assert.equal(hooked.value.text,'written','hook preserves canonical result')
      assert(hooked.content.some(c=>c.text?.includes('C8_HOOK_SENTINEL')))
      requests=[]
      const delegated = await invoke('evolve_delegate',{task:'delegated-only'})
      assert.equal(delegated.isError,false,JSON.stringify(delegated))
      assert(requests.some(r=>JSON.stringify(r.messages).includes('C5_DELEGATION_SENTINEL')))
      assert.equal(handle.evolve.rollback(scope,stable.rev).ok,true)
      assert.equal((await skills.list({cwd:dir})).some(s=>s.name==='soul-build-check'),false)
      assert.equal((await invoke('evolve_script',{name:'sum',input:'{}'})).isError,true)
      assert(!(await invoke('fixture_write',{})).content.some(c=>c.text?.includes('C8_HOOK_SENTINEL')))
      assert.notEqual(handle.evolve.current(scope).rev,augmentedRev)
      // A correction on the next turn is attributed to the previous task and rolls back.
      mode = 'baseline'; await turn('write result')
      mode = 'evolution'
      const callsBeforeRetry = handle.store.db.prepare('SELECT COUNT(*) n FROM call').get().n
      const blocked = await command('run')
      assert.equal(blocked.kind, 'error')
      assert.equal(JSON.parse(blocked.text).reason, 'lesson_compiled')
      assert.equal(handle.store.db.prepare('SELECT COUNT(*) n FROM call').get().n, callsBeforeRetry,
        'a repeated compiled lesson must not purchase another editor session')
      // Only an explicit rollback reopens the lesson for a new paid attempt.
      const seedRev = handle.store.rev(stable.rev, scope).parent
      assert.equal((await command('rollback ' + seedRev)).kind, 'success')
      assert.equal(handle.evolve.current(scope).rev, seedRev)
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
    await runner.stop(); await parent.dispose(); await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
