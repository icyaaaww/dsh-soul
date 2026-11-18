import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { Evolve } from '../src/evolve.js'
import { budgetSettings } from '../src/budget.js'
import { edit } from '../src/edit.js'
import { holdoutCases } from '../src/validation.js'
import { terms } from '../src/util.js'
import { buildContrast } from '../src/lesson.js'
import { compare } from '../bench/evolution.mjs'
import { defaults, divergence, fixtureEditor, fixtureExecutor } from './fixture.mjs'

const checks = [{ name: 'artifact', argv: ['node', '-e', 'process.exit(0)'] }]
const holdouts = ['transfer', 'control'].map(role => ({ role, task: `private ${role} prompt`, checks }))
const input = { scope: 'p', task: 'repair build', taskKey: 'k', trigger: 'manual', divergence: divergence(), checks }

test('verified contrast outranks a newer observed recovery, without attributing causation', t => {
  const { evolve, store } = setup(t)
  const task = 'verify build', taskKey = 'k', taskTerms = terms(task)
  evolve.recordVerified({ scope: 'p', task, taskKey, taskTerms, checks: [{ ok: true }] })
  store.recordLesson({ scope: 'p', task, taskKey, kind: 'recovery', success: { summary: 'stopped' } })
  const best = store.relatedLesson('p', { taskKey, terms: taskTerms })
  assert.equal(best.kind, 'verified_success')
  assert.match(buildContrast({ success: best.success, successKind: best.kind }), /产物检查通过；不能把收益归因/)
  assert.match(buildContrast({ success: { summary: 'stopped' }, successKind: 'recovery' }), /未证明产物正确/)
})

test('three-arm report counts fixes, regressions and learning costs without silently dropping cases', () => {
  const yes = { passed: true, targetErrors: 0, calls: 2 }, no = { passed: false, targetErrors: 2, calls: 3 }
  const experiment = { model: 'fixture', revision: 'fixture', callBudget: 12, learningCalls: { fixed21: 0, evolve21: 2, evolve22: 4 }, cases: [
    { id: 'transfer', role: 'transfer', fixed21: no, evolve21: no, evolve22: yes },
    { id: 'control', role: 'control', fixed21: yes, evolve21: no, evolve22: yes }] }
  const { report } = compare(experiment)
  assert.deepEqual(report.evolve22, { fixed: 1, broken: 0, targetErrorsAvoided: 2, calls: 8, extraCalls: 3, extraCallsPerFix: 3 })
  assert.equal(report.evolve21.broken, 1)
  assert.throws(() => compare({ ...experiment, callBudget: 5 }), /over agreed budget/)
  assert.throws(() => compare({ ...experiment, cases: [experiment.cases[1], experiment.cases[1]] }), /duplicate/)
})

function setup(t, { controlCalls = 5 } = {}) {
  const store = new Store(':memory:'), editor = fixtureEditor(), runner = fixtureExecutor()
  const evolve = new Evolve({ store, config: { enabled: true, budget: budgetSettings({ cooldownTurns: 0 }), evolution: { holdouts }, checks },
    generate: r => editor.generate(r), execute: async ctx => {
      const result = await runner.execute(ctx)
      if (ctx.task === holdouts[1].task) {
        result.checks[0].ok = true
        if (ctx.arm === 'candidate') result.metrics.toolCalls = controlCalls
      }
      return result
    } })
  evolve.ensure('p', defaults())
  t.after(async () => { await evolve.stop(); store.close() })
  return { evolve, store, editor, runner }
}

test('holdouts do not reach the editor, cost four reserved arms, and cannot be reused', async t => {
  const { evolve, editor, runner } = setup(t)
  assert.equal((await evolve.start(input)).started, true)
  const result = await evolve.running
  assert.equal(result.state, 'shadow')
  assert.equal(result.detail.transfer, 'passed_configured_cases')
  assert.equal(runner.calls.length, 8)
  assert.ok(runner.calls.every(c => c.maxSteps === Math.floor((evolve.config.budget.episodeCalls - 6) / 8) || c.maxSteps === evolve.config.budget.probeSteps))
  for (const c of holdouts) assert.ok(!JSON.stringify(editor.requests).includes(c.task))
  assert.equal((await evolve.start(input)).reason, 'fresh_holdouts_required')
})

test('control that passes checks but needs extra tool calls blocks adoption', async t => {
  const { evolve, store } = setup(t, { controlCalls: 6 })
  await evolve.start(input)
  assert.equal((await evolve.running).reason, 'control_regression_or_invalid_baseline')
  assert.equal(store.openWatches('p').length, 0)
})

test('duplicate, incomplete, and original-task holdouts fail before editing', () => {
  assert.deepEqual(holdoutCases(undefined, 'original'), [])
  for (const cases of [[], [holdouts[0]], [holdouts[0], holdouts[0]], [holdouts[0], { ...holdouts[1], task: ' ORIGINAL  ' }]]) {
    assert.throws(() => holdoutCases(cases, 'original'), { code: 'invalid_holdouts' })
  }
})

test('exact line edits preserve CRLF and reject ambiguous, stale or multiple edits', async () => {
  const replace = { type: 'replace', path: 'harness/tools.md', before: 'old', after: 'new $&' }
  const run = (text, actions) => edit({ generate: async () => ({ actions: [...actions, { type: 'finish', why: 'localized fix' }] }),
    context: { files: { 'tools.md': text }, target: 'C4', task: 'repair build', evidence: [] } })
  assert.equal((await run('a\r\nold\r\nz\n', [replace])).files['tools.md'], 'a\r\nnew $&\r\nz\n')
  for (const text of ['older', 'old\nold']) await assert.rejects(run(text, [replace]), { code: 'rule_mismatch' })
  await assert.rejects(run('old', [replace, replace]), { code: 'invalid_rule_edit' })
})

test('only a new separately verified task can re-open a retired same-family issue once', t => {
  const { evolve, store } = setup(t)
  const task = 'repair build timeout', taskTerms = terms(task)
  const lesson = store.recordLesson({ scope: 'p', kind: 'tool_error', task, taskKey: 'old', summary: 'timeout' })
  const reject = () => store.settleLesson(lesson.id, { state: 'rejected' })
  reject(); reject()
  const verify = (taskKey, ok) => evolve.recordVerified({ scope: 'p', taskKey, taskTerms, task, checks: [{ ok }] })
  assert.equal(verify('fresh', false), null)
  verify('old', true)
  assert.equal(store.lesson(lesson.id).state, 'retired')
  verify('fresh', true)
  assert.equal(store.lesson(lesson.id).state, 'observed')
  reject(); verify('fresh', true)
  assert.equal(store.lesson(lesson.id).state, 'retired')
})
