import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Evolution, evolutionSettings, better } from '../src/evolution.js'
import { suiteContract, executeProbe } from '../src/evolution-suite.js'
import { evolutionGenerate } from '../src/evolution-model.js'
import { fixtureModel, suite, method } from './evolution-fixture.mjs'

const config = overrides => evolutionSettings({ evolution: true, provider: 'fixture', model: 'executor', evolutionEditorModel: 'editor', ...overrides })
function setup(t, options = {}, settings = {}) {
  const s = new Store(':memory:'), model = fixtureModel(options), e = new Evolution(s, model.generate, config(settings))
  e.register('p', suite()); t.after(async () => { await e.stop(); s.close() })
  return { s, e, model, run: async () => { const run = e.start('p', 'numbers', 'session'); await e.running; return e.inspect('p', run.id) } }
}

test('full proposal/probe/composition/recursion/holdout loop executes independent files and auto-adopts verified skill', async t => {
  const f = setup(t, { latency: 1 }), run = await f.run()
  assert.equal(run.state, 'adopted', JSON.stringify(run))
  assert.equal(run.summary.baseline.passed, 0); assert.equal(run.summary.selected.passed, 2)
  assert.equal(run.summary.validation.selected.passed, 2)
  assert.equal(run.round, 2)
  assert(run.probes.some(p => p.label === 'r1-composed' && p.results.every(r => r.pass)))
  assert(run.probes.some(p => p.label === 'r1-candidate1' && p.results.some(r => !r.pass)))
  assert.equal(f.s.get(run.memory, 'p').status, 'active')
  assert.equal(f.s.get(run.memory, 'p').origin, 'evolution')
  assert(f.s.recall('p', '数字数组', 6000).includes('fixed_suite'))
  assert.equal(f.s.recall('elsewhere', '数字数组'), '')
  assert(f.model.maxInflight() > 1); assert(f.model.maxInflight() <= 2)
  assert(run.usage.every(c => c.usage?.inputTokens === 100))
  for (const call of f.model.requests.filter(r => r.phase !== 'execute')) {
    assert(!JSON.stringify(call.data).includes('HOLDOUT'))
    assert(!JSON.stringify(call.data).includes('expected'))
  }
  const second = await f.run()
  assert.equal(second.state, 'unchanged')
  assert.equal(f.e.current('p', 'numbers').memory, run.memory)
  assert(f.model.requests.filter(r => r.phase === 'propose').at(-1).data.priorLesson)
  f.s.feedback(run.memory, 'p', 'human-pass', 'pass', '实际使用通过')
  assert.equal(f.s.get(run.memory, 'p').status, 'active')
  f.e.rollback('p', 'numbers')
  assert.equal(f.e.current('p', 'numbers'), undefined)
  assert.equal(f.s.recall('p', '数字数组'), '')
  assert.equal(f.s.db.prepare('PRAGMA foreign_key_check').all().length, 0)
})

test('training improvement cannot be adopted when held-out cases fail', async t => {
  const f = setup(t, { overfit: true }), run = await f.run()
  assert.equal(run.state, 'rejected'); assert.equal(run.reason, 'validation_failed')
  assert.equal(run.summary.selected.passed, 2); assert.equal(run.memory, null)
  assert.equal(f.e.current('p', 'numbers'), undefined)
})

test('a second recursive round uses the first winner and can improve it again', async t => {
  const f = setup(t), original = f.e.generate
  let round = 0
  f.e.generate = async request => {
    if (request.phase === 'propose') {
      round++
      if (round === 2) {
        assert.deepEqual(request.data.baseline.strategy.steps, ['numeric'])
        return { candidates: [method('numeric unique'), method('numeric unique alternative')] }
      }
    }
    if (request.phase === 'compose' && round === 1) return { strategy: method('baseline'), lesson: { cue: '数字数组', lesson: '第一轮只改善部分场景，继续检查去重', evidence: request.data.candidates.map(c => c.label) } }
    return original(request)
  }
  const run = await f.run()
  assert.equal(run.state, 'adopted')
  assert.equal(run.round, 2)
  assert(run.probes.some(p => p.label === 'r2-composed' && p.results.every(r => r.pass)))
})

test('composition regressions are actually probed and do not replace a better candidate', async t => {
  const f = setup(t, { regressComposition: true }), run = await f.run()
  assert(run.probes.some(p => p.label === 'r1-composed' && p.results.every(r => !r.pass)))
  assert.equal(run.state, 'rejected')
  assert.notEqual(run.summary.selectedLabel, 'r1-composed')
})

test('fixed contracts reject duplicate holdouts, unknown executables, invalid paths and too few cases', () => {
  for (const mutate of [
    s => { s.cases[2] = { ...s.cases[0], id: 'other', split: 'validation' } },
    s => { s.command = 'run shell' },
    s => { s.cases[0].files = { '../secret': 'private' } },
    s => { s.cases = s.cases.slice(0, 2) },
    s => { s.cases[0].checks[0].kind = 'eval' },
  ]) { const s = suite(); mutate(s); assert.throws(() => suiteContract(s)) }
})

test('virtual executor never exposes arbitrary actions and validators grade actual files', async () => {
  const task = suite().cases[0], original = structuredClone(task)
  let n = 0
  const result = await executeProbe({ task, strategy: method('test'), signal: new AbortController().signal, maxSteps: 3,
    request: async () => ++n === 1 ? { actions: [{ type: 'shell', command: 'echo forbidden' }] } :
      { actions: [{ type: 'write', path: 'result.json', text: '[2,3]' }, { type: 'finish', answer: 'done' }] } })
  assert.equal(result.pass, true); assert.equal(result.toolErrors, 1); assert.deepEqual(task, original)
  const unfinished = await executeProbe({ task, strategy: method('test'), signal: new AbortController().signal, maxSteps: 1,
    request: async () => ({ actions: [{ type: 'write', path: 'result.json', text: '[2,3]' }] }) })
  assert.equal(unfinished.pass, false)
})

test('latency alone and quality regressions cannot win the selection policy', () => {
  const row = { caseId: 'a', pass: true, calls: 3, actions: 4, toolErrors: 0, durationMs: 100 }
  const base = [row, { ...row, caseId: 'b' }]
  assert.equal(better(base.map(r => ({ ...r, durationMs: 1 })), base), false)
  assert.equal(better(base.map(r => ({ ...r, calls: 2 })), base), true)
  assert.equal(better([{ ...row, pass: false, calls: 1 }, { ...row, calls: 1 }], base), false)
})

test('call reservations are bounded despite concurrent probes and failure preserves old method', async t => {
  const f = setup(t, { latency: 1 }, { evolutionMaxCalls: 8 }), run = await f.run()
  assert.equal(run.state, 'failed'); assert.equal(run.reason, 'run_budget'); assert.equal(run.memory, null)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM evo_calls').get().n, 8)
})

test('a useful winner reaches holdout before another round could consume the run or daily allowance', async t => {
  for (const limits of [{ evolutionMaxCalls: 60 }, { evolutionDailyCalls: 60 }]) {
    const f = setup(t, {}, limits), run = await f.run()
    assert.equal(run.state, 'adopted')
    assert.equal(run.round, 1)
    assert.equal(f.model.requests.filter(r => r.phase === 'propose').length, 1)
    assert.equal(run.summary.validation.selected.passed, 2)
    assert(f.model.requests.length < 60)
  }
})

test('cancellation and timeout terminate local waiting without late adoption or automatic retries', async t => {
  const s = new Store(':memory:'); let started, resolveLate
  const admitted = new Promise(resolve => { started = resolve })
  const e = new Evolution(s, () => { started(); return new Promise(resolve => { resolveLate = resolve }) }, config())
  t.after(async () => { await e.stop(); s.close() })
  e.register('p', suite()); const run = e.start('p', 'numbers', 's'); await admitted
  assert.equal((await e.cancel('q', run.id)).cancelled, false)
  assert.equal((await e.cancel('p', run.id)).cancelled, true)
  const count = s.db.prepare('SELECT COUNT(*) AS n FROM evo_calls').get().n
  resolveLate({ actions: [{ type: 'finish', answer: 'late' }] }); await Promise.resolve()
  assert.equal(e.status('p', run.id)[0].state, 'interrupted')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM evo_calls').get().n, count)
  assert.equal(e.current('p', 'numbers'), undefined)
})

test('non-cooperative request timeout records unknown usage and keeps the incumbent', async t => {
  const s = new Store(':memory:'), e = new Evolution(s, () => new Promise(() => {}), config({ evolutionRequestTimeoutMs: 50 }))
  t.after(async () => { await e.stop(); s.close() })
  e.register('p', suite()); const run = e.start('p', 'numbers', 's'); await e.running
  assert.equal(e.status('p', run.id)[0].reason, 'request_timeout')
  assert(s.db.prepare('SELECT usage FROM evo_calls').all().every(r => r.usage === null))
})

test('changed/forgotten sources invalidate in-flight adoption and erase dependent probe text', async t => {
  const f = setup(t), first = await f.run()
  let unblock, started
  const admitted = new Promise(resolve => { started = resolve })
  f.e.generate = request => { started(); return new Promise(resolve => { unblock = () => resolve({ actions: [{ type: 'finish', answer: 'late' }] }) }) }
  const next = f.e.start('p', 'numbers', 's'); await admitted
  f.s.forget(first.memory, 'p'); unblock(); await f.e.running
  assert.equal(f.e.status('p', next.id)[0].reason, 'source_changed')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM evo_probes WHERE run IN (?,?)').get(first.id, next.id).n, 0)
  assert.equal(f.e.current('p', 'numbers'), undefined)
})

test('suite edits invalidate prior automated skills; unregister removes suite, skills and probe data', async t => {
  const f = setup(t), run = await f.run()
  const revised = suite(); revised.cases[0].checks[0].expected = [2, 2, 3]
  f.e.register('p', revised)
  assert.equal(f.e.current('p', 'numbers'), undefined)
  assert.equal(f.s.get(run.memory, 'p').status, 'deprecated')
  await f.e.command('unregister numbers', { id: 'human' }, 'p')
  assert.equal(f.e.list('p').length, 0)
  assert.equal(f.s.get(run.memory, 'p'), null)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM evo_probes').get().n, 0)
  assert(f.s.db.prepare('SELECT COUNT(*) AS n FROM evo_calls').get().n > 0)
})

test('automatic runs require explicit suite opt-in, matching scope/keywords and persistent cooldown', async t => {
  const f = setup(t)
  assert.equal(f.e.automatic('q', 's', '数字数组'), null)
  assert.equal(f.e.automatic('p', 's', '写一封信'), null)
  assert(f.e.automatic('p', 's', '数字数组排序失败'))
  await f.e.running
  assert.equal(f.e.automatic('p', 's', '数字数组'), null)
  f.e.register('p', suite({ auto: false }))
  assert.equal(f.e.automatic('p', 's', '数字数组'), null)
})

test('restart preserves budgets and refuses concurrent profile workers; expired work is not resumed', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'soul-evo-')), path = join(folder, 'memory.sqlite')
  let now = Date.now(), a = new Store(path, { now: () => now }), b = new Store(path, { now: () => now })
  const one = new Evolution(a, () => new Promise(() => {}), config({ evolutionDailyCalls: 1 })), two = new Evolution(b, fixtureModel().generate, config({ evolutionDailyCalls: 1 }))
  try {
    one.register('p', suite()); const run = one.start('p', 'numbers', 's')
    await one.running // concurrent second probe exhausts the daily budget and aborts the stalled first
    assert.equal(one.status('p', run.id)[0].reason, 'daily_budget')
    assert.throws(() => two.start('p', 'numbers', 's'), /daily_budget/)
    b.db.prepare("UPDATE evo_runs SET state='running',lease=? WHERE id=?").run(now + 100, run.id)
    assert.throws(() => two.start('p', 'numbers', 's'), /busy/)
    now += 101; two.recover()
    assert.equal(two.status('p', run.id)[0].reason, 'lease_expired')
  } finally { await one.stop(); await two.stop(); a.close(); b.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('real stream wrapper uses separate editor route, excludes reasoning and rejects truncated output', async () => {
  const requests = [], llm = { async *stream(input) { requests.push(input); yield { type: 'reasoning-delta', text: 'hidden' }; yield { type: 'text-delta', text: '{"ok":true}' }; yield { type: 'usage', usage: { inputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const generate = evolutionGenerate(llm, config()), usages = []
  assert.deepEqual(await generate({ system: 'system', data: {}, phase: 'propose', signal: new AbortController().signal, onUsage: u => usages.push(u) }), { ok: true })
  assert.equal(requests[0].model, 'editor'); assert.deepEqual(requests[0].tools, []); assert.equal(usages.length, 1)
  const truncated = evolutionGenerate({ async *stream() { yield { type: 'text-delta', text: '{"ok":true}' }; yield { type: 'finish', reason: { kind: 'max-tokens' } } } }, config())
  await assert.rejects(truncated({ system: '', data: {}, phase: 'execute', signal: new AbortController().signal, onUsage() {} }), /truncated/)
})

test('negative human feedback immediately retires an automatically validated method', async t => {
  const f = setup(t), run = await f.run()
  f.s.feedback(run.memory, 'p', 'real-user', 'fail', '真实任务出现回归')
  assert.equal(f.e.current('p', 'numbers'), undefined)
  assert.equal(f.s.recall('p', '数字数组'), '')
})

test('JavaScript without a configured sandbox fails before reserving any model request', async t => {
  const f = setup(t), contract = suite({ runtime: 'javascript' })
  contract.cases.forEach(c => { c.invocation = JSON.parse(c.files['input.json']); c.checks = [{ target: 'execution', kind: 'jsonEquals', expected: c.checks[0].expected }] })
  f.e.register('p', contract); const result = await f.run()
  assert.equal(result.reason, 'sandbox_unavailable')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM evo_calls').get().n, 0)
})

test('bundled examples copy without overwriting and register for the current project', async t => {
  const f = setup(t), folder = mkdtempSync(join(tmpdir(), 'soul-example-')), session = { id: 'user', header: { cwd: folder } }
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  for (const runtime of ['memory', 'javascript']) {
    const example = await f.e.command(`example ${runtime}`, session, 'project')
    const original = readFileSync(example.path, 'utf8')
    const registered = await f.e.command(`register "${example.path}"`, session, 'project')
    assert.equal(registered.train, 2); assert.equal(registered.validation, 2)
    await assert.rejects(f.e.command(`example ${runtime}`, session, 'project'), { code: 'EEXIST' })
    assert.equal(readFileSync(example.path, 'utf8'), original)
  }
  assert.equal(f.e.list('project').length, 2)
  assert.equal(f.e.list('unrelated').length, 0)
})

test('rollback restores the previous verified version after an efficiency improvement', async t => {
  const f = setup(t), first = await f.run(), original = f.e.generate
  f.e.generate = async request => {
    if (request.phase === 'propose') return { candidates: [method('numeric unique efficient'), method('numeric unique efficient alternative')] }
    if (request.phase === 'compose') return { strategy: method('numeric unique efficient composed'), lesson: {
      cue: '数字数组', lesson: '省略多余的中间文件写入', evidence: request.data.candidates.map(c => c.label),
    } }
    if (!request.data.strategy.steps.join(' ').includes('efficient') && !request.data.observations.length) {
      return { actions: [{ type: 'write', path: 'scratch.txt', text: 'redundant' }] }
    }
    return original(request)
  }
  const second = await f.run()
  assert.equal(second.state, 'adopted', JSON.stringify(second))
  assert.notEqual(second.memory, first.memory)
  assert.equal(f.s.get(first.memory, 'p').status, 'deprecated')
  assert.equal(f.e.current('p', 'numbers').parent, first.memory)
  const reverted = f.e.rollback('p', 'numbers')
  assert.equal(reverted.current, first.memory)
  assert.equal(f.s.get(first.memory, 'p').status, 'active')
  assert.equal(f.s.get(second.memory, 'p').status, 'deprecated')
  assert(f.s.recall('p', '数字数组', 6000).includes('fixed_suite'))
  assert.equal(f.s.recall('elsewhere', '数字数组'), '')
})
