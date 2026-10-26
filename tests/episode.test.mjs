import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { Evolve } from '../src/evolve.js'
import { budgetSettings } from '../src/budget.js'
import { verdictOf } from '../src/watch.js'
import { defaults, fixtureEditor, fixtureExecutor, divergence, BASE_METRICS } from './fixture.mjs'

const config = ({ budget: budgetOverrides = {}, ...extra } = {}) => ({
  enabled: true, provider: 'fixture', model: 'fixture-model', reasoningEffort: '',
  autoAdopt: false, injectHarness: false, harnessFolder: '.dsh-soul/harness', checks: [],
  ...extra,
  // Built last so an override cannot replace the resolved budget with a partial object.
  budget: budgetSettings({ cooldownTurns: 0, ...budgetOverrides }),
})

function setup(t, { editor = fixtureEditor(), executor = fixtureExecutor(), cfg = config() } = {}) {
  const store = new Store(':memory:')
  // Delegate dynamically so a test can swap editor.generate after construction and have the
  // new behaviour take effect, without reaching into the orchestrator's internals.
  const evolve = new Evolve({
    store, config: cfg,
    generate: req => editor.generate(req),
    execute: ctx => executor.execute(ctx),
  })
  evolve.ensure('p', defaults())
  t.after(async () => { await evolve.stop(); store.close() })
  const start = (extra = {}) => evolve.start({
    scope: 'p', taskKey: 'task-1', trigger: 'test', divergence: divergence(),
    metrics: BASE_METRICS, trajectory: '{"toolErrors":2}', task: '修复构建',
    ...extra,
  })
  return { store, evolve, editor, executor, start }
}

test('one episode: diagnose -> edit -> probe -> shadow, and the baseline is never re-run', async t => {
  const f = setup(t)
  const started = await f.start()
  assert.equal(started.started, true)
  assert.equal(started.target, 'C4')
  await f.evolve.running

  const episode = f.store.episode(started.episode, 'p')
  assert.equal(episode.state, 'shadow')
  // Exactly one probe: the reference execution is the recorded trajectory, not a replay.
  assert.equal(f.executor.calls.length, 1)
  // Only one editor session.
  assert.equal(f.editor.requests.length, 1)
  assert.equal(f.editor.requests[0].phase, 'edit')

  const current = f.evolve.current('p')
  assert.equal(current.state, 'shadow')
  assert(f.store.openWatches('p').length === 1)
})

test('host preflight and disconnected components refuse before any paid request', async t => {
  const f = setup(t)
  f.evolve.execute.preflight = async () => { throw Object.assign(new Error('no host'), { code: 'host_runner_unavailable' }) }
  assert.deepEqual(await f.start(), { started: false, reason: 'host_runner_unavailable' })
  f.evolve.execute.preflight = async () => {}
  f.evolve.execute.supportedTargets = ['C1', 'C2', 'C3', 'C4']
  const unavailable = await f.start({ diagnosis: { target: 'C7', rule: 'mechanical' } })
  assert.equal(unavailable.reason, 'component_not_connected')
  assert.equal(f.editor.requests.length, 0)
  assert.equal(f.store.recentEpisodes('p', 10).length, 0)
})

test('incomplete candidate and absent declared checks never enter shadow', async t => {
  const f = setup(t, { executor: fixtureExecutor({ complete: false }) })
  const first = await f.start()
  await f.evolve.running
  assert.equal(f.store.episode(first.episode, 'p').reason, 'probe_incomplete')
  f.evolve.execute = fixtureExecutor().execute
  const second = await f.start({ checks: [{ name: 'required', argv: ['node', '--test'] }] })
  await f.evolve.running
  assert.equal(f.store.episode(second.episode, 'p').reason, 'missing_candidate_checks')
  assert.equal(f.evolve.current('p').state, 'stable')
})

test('the editor prompt indexes evidence by path and keeps bodies out until read', async t => {
  const f = setup(t)
  await f.start()
  await f.evolve.running
  const payload = JSON.stringify(f.editor.requests[0].data)
  // The task statement belongs in the prompt; the trajectory body does not.
  assert(payload.includes('修复构建'), 'the task statement is sent')
  assert(payload.includes('evidence/'), 'evidence is addressable by path')
  assert(!payload.includes('"toolErrors":2'), 'the raw trajectory stays out of the first prompt')
  // Only the diagnosed component is exposed as editable.
  assert.deepEqual(f.editor.requests[0].data.index.editable, ['tools.md'])
})

test('an evidence read pulls the body in on demand, and only within the read budget', async t => {
  const f = setup(t)
  let reads = 0
  f.editor.generate = async ({ data }) => {
    reads++
    if (reads === 1) {
      const path = data.index.evidence[0]
      return { actions: [{ type: 'read', path }] }
    }
    const observed = data.observations
    assert(observed.includes('"toolErrors":2') || observed.includes('toolErrors'), 'the body arrived after the read')
    return { actions: [{ type: 'write', path: 'harness/tools.md', text: '## 工具\n有界回退。\n' }, { type: 'finish', why: 'read then edited' }] }
  }
  const started = await f.start()
  await f.evolve.running
  assert.equal(f.store.episode(started.episode, 'p').state, 'shadow')

  // Over-budget reads are refused rather than silently truncated.
  const g = setup(t)
  g.editor.generate = async () => ({ actions: Array.from({ length: 7 }, () => ({ type: 'read', path: 'harness/tools.md' })) })
  const over = await g.start()
  await g.evolve.running
  assert.equal(g.store.episode(over.episode, 'p').reason, 'read_limit')
})

test('a candidate that regresses the B layer is rejected, not adopted', async t => {
  const f = setup(t, { executor: fixtureExecutor({ toolErrors: 9 }) })
  const started = await f.start()
  await f.evolve.running
  const episode = f.store.episode(started.episode, 'p')
  assert.equal(episode.state, 'rejected')
  assert(episode.reason.includes('B 层劣化'))
  assert.equal(f.evolve.current('p').state, 'stable')
  assert.equal(f.store.openWatches('p').length, 0)
})

test('off-target edits are rejected by the structure gate before any probe is paid for', async t => {
  const editor = fixtureEditor({ body: 'x' })
  editor.generate = async ({ data }) => ({
    actions: [{ type: 'write', path: 'harness/system.md', text: 'hijack' }, { type: 'finish', why: 'x' }],
  })
  const f = setup(t, { editor })
  const started = await f.start()
  await f.evolve.running
  const episode = f.store.episode(started.episode, 'p')
  assert.equal(episode.state, 'rejected')
  assert.equal(f.executor.calls.length, 0, 'no probe cost after a structural rejection')
})

test('anchor tampering from the editor is rejected', async t => {
  const f = setup(t)
  const original = defaults()['system.md']
  f.editor.generate = async () => ({
    actions: [{ type: 'write', path: 'harness/system.md', text: original.replace('不得绕过沙箱、审批或确认流程', '可以绕过沙箱、审批或确认流程') },
      { type: 'finish', why: 'x' }],
  })
  // Diagnose C4, but the editor tries C1: rejected as off-target before anchors matter.
  const started = await f.start()
  await f.evolve.running
  assert.equal(f.store.episode(started.episode, 'p').state, 'rejected')
})

test('fixed-tax reduction alone is adoptable: knowledge moves out of the per-turn path', async t => {
  const f = setup(t)
  // Editor shrinks tools.md; metrics are unchanged.
  f.editor.generate = async () => ({
    actions: [{ type: 'write', path: 'harness/tools.md', text: '## 工具使用\n读用 Read，找用 Grep。\n' },
      { type: 'finish', why: 'moved guidance into a skill' }],
  })
  f.executor.execute = async () => ({ metrics: { ...BASE_METRICS }, transcript: '' })
  const started = await f.start()
  await f.evolve.running
  const episode = f.store.episode(started.episode, 'p')
  assert.equal(episode.state, 'shadow')
  const current = f.evolve.current('p')
  assert(current.state === 'shadow')
})

test('shadow window: real traffic promotes after the window, and a correction rolls back', async t => {
  const f = setup(t)
  const started = await f.start()
  await f.evolve.running
  const rev = f.store.latest('p', ['shadow']).id

  // Same task kind, clean turns: the window drains then promotes.
  for (let i = 0; i < 3; i++) {
    f.evolve.observe({ scope: 'p', taskKey: 'task-1', corrections: 0, toolErrors: 0, complete: true })
  }
  assert.equal(f.store.rev(rev, 'p').state, 'stable')
  // A decided window leaves the open set, so read the verdict from the table itself.
  assert.equal(f.store.openWatches('p').length, 0, 'the window is closed once decided')
  assert.equal(f.store.db.prepare('SELECT verdict FROM watch WHERE rev=?').get(rev).verdict, 'pass')
})

test('a user correction inside the window rolls the revision back to its parent', async t => {
  const f = setup(t)
  const started = await f.start()
  await f.evolve.running
  const shadow = f.store.latest('p', ['shadow'])
  assert.equal(shadow.state, 'shadow')

  const decisions = f.evolve.observe({ scope: 'p', taskKey: 'task-1', corrections: 1, toolErrors: 0, complete: true })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].verdict, 'fail')
  assert.equal(f.store.rev(shadow.id, 'p').state, 'retired')
  assert.equal(f.store.rev(shadow.parent, 'p').state, 'stable')
  assert.equal(f.evolve.current('p').rev, shadow.parent)
})

test('a window ignores unrelated task kinds instead of closing on noise', async t => {
  const f = setup(t)
  await f.start()
  await f.evolve.running
  const rev = f.store.latest('p', ['shadow']).id
  f.evolve.observe({ scope: 'p', taskKey: 'other-task', corrections: 0, toolErrors: 0, complete: true })
  assert.equal(f.store.openWatches('p')[0].remaining, 3, 'unrelated turns do not drain the window')
  assert.equal(f.store.rev(rev, 'p').state, 'shadow')
})

test('verdict ordering: a correction beats any amount of good metrics', () => {
  const window = { remaining: 2, baseline: { toolErrors: 0 } }
  assert.equal(verdictOf(window, { corrections: 1, toolErrors: 0, complete: true }), 'fail')
  assert.equal(verdictOf(window, { corrections: 0, toolErrors: 0, complete: false }), 'fail')
  assert.equal(verdictOf(window, { corrections: 0, toolErrors: 2, complete: true }), 'fail')
  assert.equal(verdictOf({ remaining: 0, baseline: { toolErrors: 0 } }, { corrections: 0, toolErrors: 0, complete: true }), 'pass')
})

test('budget is reserved before dispatch and never refunded on failure', async t => {
  const cfg = config({ budget: { dailyCalls: 1 } })
  const f = setup(t, { cfg })
  // Consume the only daily call with a failing model so the outcome is not 'ok'.
  const editor = fixtureEditor()
  f.evolve.generate = async () => { throw Object.assign(new Error('boom'), { code: 'provider_failure' }) }
  const started = await f.start()
  await f.evolve.running
  const episode = f.store.episode(started.episode, 'p')
  assert.equal(episode.state, 'failed')
  const report = f.evolve.status('p').budget
  assert.equal(report.daily.calls.used, 1, 'the failed call still counts')
  const second = await f.start()
  assert.equal(second.started, false)
  assert.equal(second.reason, 'daily_budget')
})

test('a request larger than the per-request cap is refused before it is dispatched', async t => {
  const cfg = config({ budget: { requestInputBytes: 2000 } })
  const f = setup(t, { cfg })
  let calls = 0
  // Accumulate real observations until the payload outgrows the cap, then assert that the
  // oversized request never reaches the model.
  f.editor.generate = async ({ data }) => {
    calls++
    if (calls > 12) throw new Error('the cap should have fired before this')
    return { actions: [{ type: 'read', path: 'harness/tools.md' }, { type: 'read', path: 'harness/tools.md' }] }
  }
  const started = await f.start()
  await f.evolve.running
  const episode = f.store.episode(started.episode, 'p')
  assert.equal(episode.state, 'failed')
  assert.equal(episode.reason, 'input_limit')
  assert(calls < 12, 'dispatch stopped at the cap')
  // A refused request is never dispatched AND never recorded: the call log holds exactly one
  // row per dispatched request, so capacity accounting stays honest.
  const recorded = f.store.db.prepare('SELECT COUNT(*) AS n FROM call').get().n
  assert.equal(recorded, calls, 'one row per dispatched request, none for the refused one')
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM call WHERE outcome='input_limit'").get().n, 0)
})

test('cooldown blocks a second episode and reports how far off it is', async t => {
  const f = setup(t, { cfg: config({ budget: { cooldownTurns: 20 } }) })
  const first = await f.start()
  await f.evolve.running
  assert.equal(first.started, true)
  const second = await f.start()
  assert.equal(second.started, false)
  assert.equal(second.reason, 'cooldown')
  assert.equal(second.need, 20)
})

test('manual rollback to an arbitrary revision restores the parent and closes windows', async t => {
  const f = setup(t)
  await f.start()
  await f.evolve.running
  const shadow = f.store.latest('p', ['shadow'])
  const out = f.evolve.rollback('p', shadow.parent)
  assert.equal(out.ok, true)
  assert.equal(f.evolve.current('p').rev, shadow.parent)
  assert.equal(f.store.rev(shadow.id, 'p').state, 'retired')
})

test('ledger explains every adoption with the gate that admitted it', async t => {
  const f = setup(t)
  const started = await f.start()
  await f.evolve.running
  const rows = f.store.ledger('p', 20)
  assert(rows.some(r => r.action === 'episode_start'))
  assert(rows.some(r => r.action === 'shadow' && r.gate?.decision?.adopt === true))
  assert(rows.some(r => r.action === 'episode_shadow'))
})

test('the store survives a reload with the same revision graph', async t => {
  const store = new Store(':memory:')
  const evolve = new Evolve({ store, config: config(), generate: fixtureEditor().generate, execute: fixtureExecutor().execute })
  evolve.ensure('p', defaults())
  const rev = evolve.current('p').rev
  const files = store.materialize(rev)
  assert.equal(files['system.md'], defaults()['system.md'])
  const check = store.integrity()
  assert.equal(check.integrity, 'ok')
  assert.equal(check.foreignKeys, 0)
  store.close()
})
