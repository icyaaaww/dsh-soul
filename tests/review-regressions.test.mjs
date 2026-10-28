import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Evolve } from '../src/evolve.js'
import { Budget, budgetSettings } from '../src/budget.js'
import { apply } from '../index.js'
import { projectScope, terms } from '../src/util.js'
import { defaults, fixtureEditor, fixtureExecutor, divergence } from './fixture.mjs'

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'soul-review-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function engine(store) {
  const editor = fixtureEditor(), executor = fixtureExecutor()
  const evolve = new Evolve({ store,
    config: { enabled: true, provider: 'fixture', model: 'fixture',
      checks: [{ name: 'artifact', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      budget: budgetSettings({ cooldownTurns: 0 }) },
    generate: input => editor.generate(input), execute: input => executor.execute(input),
  })
  return { evolve, editor }
}

test('rollback across multiple revisions restores the requested tree and all affected lessons after reload', async t => {
  const path = join(folder(t), 'review.sqlite')
  let store = new Store(path)
  const { evolve } = engine(store)
  try {
    const a = evolve.ensure('p', defaults()).rev
    const b = store.putRev('p', { ...defaults(), 'tools.md': 'B' }, { parent: a, state: 'stable' })
    const c = store.putRev('p', { ...defaults(), 'tools.md': 'C' }, { parent: b, state: 'shadow' })
    const other = store.putRev('other', defaults(), { state: 'stable' })
    const lessons = [b, c].map((rev, i) => {
      const row = store.recordLesson({ scope: 'p', kind: 'recovery', taskKey: `task${i}`, task: `unique${i}`, summary: 'recovery' })
      store.settleLesson(row.id, { state: 'shadow', rev })
      return row.id
    })
    store.openWatch(c, 'p', 'task1', { toolErrors: 0 }, 3)
    assert.equal(evolve.current('p').rev, c) // populate the runtime cache
    const result = evolve.rollback('p', a)
    assert.equal(result.ok, true)
    assert.deepEqual(new Set(result.retired), new Set([b, c]))
    assert.equal(evolve.current('p').rev, a)
    assert.deepEqual(evolve.current('p').files, defaults())
    assert.equal(store.openWatches('p').length, 0)
    assert.equal(store.latest('other').id, other)
    for (const id of lessons) {
      const row = store.lesson(id)
      assert.equal(row.state, 'observed')
      assert.equal(row.contradictions, 1)
      assert.equal(row.rev, null)
    }
    await evolve.stop(); store.close(); store = new Store(path)
    assert.equal(store.latest('p').id, a)
    // Restoring a historical branch must also retire the newer active branch.
    const d = store.putRev('p', { ...defaults(), 'tools.md': 'D' }, { parent: a, state: 'stable' })
    const next = engine(store).evolve
    assert.equal(next.rollback('p', b).ok, true)
    assert.equal(next.current('p').rev, b)
    assert.equal(store.rev(d, 'p').state, 'retired')
    assert.equal(next.rollback('p').rev, a)
    await next.stop()
  } finally { await evolve.stop(); store.close() }
})

test('a failed rollback audit write leaves revision, watch and lesson states intact', async () => {
  const store = new Store(':memory:'), { evolve } = engine(store)
  try {
    const a = evolve.ensure('p', defaults()).rev
    const b = store.putRev('p', { ...defaults(), 'tools.md': 'B' }, { parent: a, state: 'shadow' })
    const lesson = store.recordLesson({ scope: 'p', kind: 'recovery', taskKey: 'k', task: 'build', summary: 'x' })
    store.settleLesson(lesson.id, { state: 'shadow', rev: b })
    store.openWatch(b, 'p', 'k', {}, 3)
    store.log = () => { throw new Error('audit unavailable') }
    assert.throws(() => evolve.rollback('p', a), /audit unavailable/)
    assert.equal(evolve.current('p').rev, b)
    assert.equal(store.openWatches('p').length, 1)
    assert.equal(store.lesson(lesson.id).state, 'compiled')
  } finally { await evolve.stop(); store.close() }
})

function plugin(t) {
  const commands = [], handlers = new Map()
  const ctx = { tools: { register: () => () => {} }, commands: { register: x => { commands.push(x); return () => {} } },
    systemPrompt: { context: () => () => {} }, on: (key, fn) => { handlers.set(key, fn); return () => {} },
    get: key => key === 'llm' ? { stream: async function* () { throw new Error('must not call model') } } : undefined }
  const handle = apply(ctx, { enabled: true, profile: 'review', database: ':memory:', provider: 'fixture', model: 'fixture' })
  t.after(() => handle.stop())
  const session = { id: 'review', header: { cwd: process.cwd() } }, scope = projectScope(session)
  return { ...handle, commands, handlers, session, scope }
}

for (const state of ['retired', 'compiled']) test(`/evolve run cannot bypass a ${state} lesson through current-session divergence`, async t => {
  const h = plugin(t)
  for (let i = 0; i < 3; i++) {
    h.recorder.start(h.session.id, { scope: h.scope, turn: i, intent: 'repair authentication handler' }).toolErrors = 1
    h.handlers.get('session/event')(h.session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const lesson = h.evolve.eligibleLessons(h.scope)[0]
  assert.ok(lesson)
  if (state === 'retired') {
    h.store.settleLesson(lesson.id, { state: 'rejected' })
    h.store.settleLesson(lesson.id, { state: 'rejected' })
  } else h.store.settleLesson(lesson.id, { state: 'shadow', rev: 'existing-revision' })
  const result = await h.commands[0].handler({ agent: { session: h.session }, rawInput: 'run', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.equal(JSON.parse(result.text).reason, `lesson_${state}`)
  // A stale caller snapshot and a rephrased task also cannot reopen it.
  const blocked = await h.evolve.start({ scope: h.scope, taskKey: 'changed-key', taskTerms: terms('authentication repair handler'), lesson })
  assert.equal(blocked.reason, `lesson_${state}`)
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM episode').get().n, 0)
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM call').get().n, 0)
})

test('direct observation runs attach a matching eligible lesson for outcome accounting', async () => {
  const store = new Store(':memory:'), { evolve } = engine(store)
  try {
    evolve.ensure('p', defaults())
    let lesson
    for (let i = 0; i < 3; i++) lesson = store.recordLesson({ scope: 'p', kind: 'tool_error', taskKey: 'k', task: 'repair build', summary: 'error' })
    const result = await evolve.start({ scope: 'p', taskKey: 'k', task: 'repair build', trigger: 'user_command', divergence: divergence(), metrics: {} })
    assert.equal(result.started, true)
    await evolve.running
    assert.equal(store.episode(result.episode, 'p').lesson, lesson.id)
    assert.equal(store.lesson(lesson.id).state, 'compiled')
  } finally { await evolve.stop(); store.close() }
})

test('retirement survives history pruning and recurrence outside the last 100 clusters', () => {
  const store = new Store(':memory:')
  try {
    const input = { scope: 'p', kind: 'recovery', taskKey: 'old', task: 'oldunique', summary: 'x' }
    const old = store.recordLesson(input)
    store.settleLesson(old.id, { state: 'rejected' }); store.settleLesson(old.id, { state: 'rejected' })
    for (let i = 0; i < 210; i++) store.recordLesson({ ...input, taskKey: `k${i}`, task: `unique${i}` })
    const recurrence = store.recordLesson(input)
    assert.equal(recurrence.id, old.id)
    assert.equal(recurrence.state, 'retired')
    // Durable retired rows must not consume the capacity for new observations.
    store.db.exec("UPDATE lesson SET state='retired' WHERE scope='p'")
    const fresh = store.recordLesson({ ...input, taskKey: 'fresh', task: 'freshunique' })
    assert.ok(store.lesson(fresh.id))
  } finally { store.close() }
})

test('production observation storage redacts both text and task terms', t => {
  const h = plugin(t), secret = 'reviewsecret123456'
  const state = h.recorder.start(h.session.id, { scope: h.scope, turn: 1, intent: `repair login api_key=${secret}` })
  state.corrections = 1
  h.handlers.get('session/event')(h.session, { type: 'turn/end', data: {} })
  for (const table of ['lesson', 'meta', 'ledger']) {
    assert.equal(JSON.stringify(h.store.db.prepare(`SELECT * FROM ${table}`).all()).includes(secret), false, table)
  }
  const lesson = h.store.lessons(h.scope)[0]
  assert.ok(lesson.task.includes('[REDACTED]'))
  assert.ok(lesson.terms.includes('login'))
  // The Store boundary also protects callers passing unsanitized snapshots/trajectories.
  h.store.recordLesson({ scope: h.scope, kind: 'recovery', taskKey: 'raw', task: `password=${secret}`, summary: 'x',
    terms: [secret], detail: { password: secret }, trajectory: JSON.stringify({ error: `api_key=${secret}` }) })
  assert.equal(JSON.stringify(h.store.db.prepare('SELECT * FROM lesson').all()).includes(secret), false)
})

test('v2 migration scrubs old metadata, preserves version history and is idempotent', t => {
  const path = join(folder(t), 'migration.sqlite'), secret = 'legacysecret123456'
  let store = new Store(path)
  try {
    const rev = store.putRev('p', defaults(), { state: 'stable' })
    const lesson = store.recordLesson({ scope: 'p', kind: 'recovery', taskKey: 'k', task: 'repair login', summary: 'x' })
    store.db.prepare('UPDATE lesson SET task=?,terms=?,detail=?,trajectory=? WHERE id=?')
      .run(`repair login api_key=${secret}`, JSON.stringify([secret]), JSON.stringify({ password: secret }), JSON.stringify({ text: `password=${secret}` }), lesson.id)
    store.db.prepare('INSERT INTO meta VALUES (?,?)').run('last:p', JSON.stringify({ text: `api_key=${secret}` }))
    store.db.prepare('INSERT INTO meta VALUES (?,?)').run('observations:p', JSON.stringify([{ task_key: 'k', terms: [secret], created: 1 }]))
    store.openWatch(rev, 'p', 'k', { taskTerms: [secret], toolErrors: 0 }, 3)
    store.db.exec('PRAGMA user_version=2'); store.close(); store = new Store(path)
    for (const table of ['lesson', 'meta', 'watch']) assert.equal(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes(secret), false)
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6)
    assert.equal(store.latest('p').id, rev)
    assert.deepEqual(store.materialize(rev), defaults())
    assert.equal(store.lesson(lesson.id).support, 1)
    assert.deepEqual(JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key='observations:p'").get().value)[0].terms, [])
    // New safe tokens must survive subsequent opens; cleanup is a one-time migration.
    store.openWatch(rev, 'p', 'k', { taskTerms: ['repair', 'login'] }, 3)
    store.close(); store = new Store(path)
    assert.deepEqual(store.openWatches('p')[0].baseline.taskTerms, ['repair', 'login'])
  } finally { store.close() }
})

test('episode call allowance survives midnight and restart while daily allowance resets', t => {
  const path = join(folder(t), 'budget.sqlite')
  let now = Date.parse('2026-10-26T23:59:59Z'), store = new Store(path, { now: () => now })
  const cfg = budgetSettings({ episodeCalls: 4, dailyCalls: 4 })
  try {
    const rev = store.putRev('p', defaults(), { state: 'stable' })
    const ep = store.createEpisode({ scope: 'p', taskKey: 'k', trigger: 'test', fromRev: rev })
    let budget = new Budget(store, cfg, () => now)
    for (let i = 0; i < 4; i++) assert.equal(budget.request('p', ep, 'edit', 'x').ok, true)
    // Simulate the dated counter format persisted by v2; it must not be refunded.
    store.db.prepare('UPDATE budget SET day=? WHERE key=?').run('2026-10-26', budget.key('p', ep, 'ep'))
    now += 2000; store.close(); store = new Store(path, { now: () => now }); budget = new Budget(store, cfg, () => now)
    assert.equal(budget.request('p', ep, 'edit', 'x').reason, 'episode_budget')
    assert.equal(budget.report('p', ep).episode.calls.used, 4)
    assert.equal(budget.report('p', ep).daily.calls.used, 0)
    const next = store.createEpisode({ scope: 'p', taskKey: 'next', trigger: 'test', fromRev: rev })
    assert.equal(budget.request('p', next, 'edit', 'x').ok, true)
    assert.equal(budget.report('p', next).daily.calls.used, 1)
  } finally { store.close() }
})

test('episode byte allowance persists across days, and refused requests reserve nothing', () => {
  let now = Date.parse('2026-10-26T23:59:59Z')
  const store = new Store(':memory:', { now: () => now }), budget = new Budget(store, budgetSettings({ episodeInputBytes: 8000 }), () => now)
  try {
    const rev = store.putRev('p', defaults(), { state: 'stable' })
    const ep = store.createEpisode({ scope: 'p', taskKey: 'k', trigger: 'test', fromRev: rev })
    assert.equal(budget.request('p', ep, 'edit', 'x'.repeat(5000)).ok, true)
    now += 2000
    assert.equal(budget.request('p', ep, 'edit', 'x'.repeat(3000)).ok, true)
    assert.equal(budget.request('p', ep, 'edit', 'x').reason, 'input_budget')
    const report = budget.report('p', ep)
    assert.equal(report.episode.inputBytes.used, 8000)
    assert.equal(report.episode.calls.used, 2)
    assert.equal(report.daily.calls.used, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM call').get().n, 2)
  } finally { store.close() }
})

test('delegations without an episode use only the daily allowance', () => {
  let now = Date.parse('2026-10-26T23:59:59Z')
  const store = new Store(':memory:'), budget = new Budget(store, budgetSettings({ episodeCalls: 4, dailyCalls: 5 }), () => now)
  try {
    for (let i = 0; i < 5; i++) assert.equal(budget.request('p', null, 'delegate', 'x').ok, true)
    assert.equal(budget.request('p', null, 'delegate', 'x').reason, 'daily_budget')
    now += 2000
    assert.equal(budget.request('p', null, 'delegate', 'x').ok, true)
  } finally { store.close() }
})
