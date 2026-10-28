import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Evolve } from '../src/evolve.js'
import { budgetSettings } from '../src/budget.js'
import { buildContrast, patternOf, snapshot } from '../src/lesson.js'
import { trajectoryText } from '../src/observe.js'
import { terms } from '../src/util.js'
import { defaults, fixtureEditor, fixtureExecutor } from './fixture.mjs'

const config = (overrides = {}) => ({
  enabled: true, provider: 'fixture', model: 'fixture-model', reasoningEffort: '',
  injectHarness: false, harnessFolder: '.dsh-soul/harness',
  checks: [{ name: 'artifact', argv: [process.execPath, '-e', 'process.exit(0)'] }],
  budget: budgetSettings({ cooldownTurns: 0, repeatThreshold: 2, ...overrides }),
})

const state = (extra = {}) => ({
  scope: 'p', text: '修复构建超时', steps: 4, toolCalls: 6, toolErrors: 0,
  durationMs: 10, complete: true, reason: 'stop', tools: ['Bash'], errors: [], ...extra,
})

const divergenceOfLesson = lesson => lesson.divergence ?? {
  signals: [{ kind: lesson.kind, weight: 1, detail: lesson.summary }], score: 1,
}

function setup(t, { editor = fixtureEditor(), executor = fixtureExecutor(), cfg = config() } = {}) {
  const store = new Store(':memory:')
  const evolve = new Evolve({
    store, config: cfg,
    generate: req => editor.generate(req),
    execute: ctx => executor.execute(ctx),
  })
  evolve.ensure('p', defaults())
  t.after(async () => { await evolve.stop(); store.close() })
  return { store, evolve, editor, executor }
}

function seedLesson(store, extra = {}) {
  for (let i = 0; i < 2; i++) {
    store.recordLesson({
      scope: 'p', kind: 'recovery', taskKey: `k${i}`, terms: terms(i ? '修复一下构建超时' : '修复构建超时'),
      task: '修复构建超时', summary: '工具错误后仍完成：Bash',
      detail: { summary: '修复构建超时', metrics: { steps: 5, toolCalls: 9, toolErrors: 2, complete: true, reason: 'stop', durationMs: 1000 }, tools: ['Bash'], errors: [{ tool: 'Bash', text: 'timeout' }] },
      success: { summary: '修复构建超时', metrics: { steps: 3, toolCalls: 5, toolErrors: 0, complete: true, reason: 'stop', durationMs: 800 }, tools: ['Bash'], errors: [] },
      divergence: { signals: [{ kind: 'recovery', weight: 1, detail: [{ tool: 'Bash', text: 'timeout' }] }], score: 1 },
      ...extra,
    })
  }
  return store.lessons('p').find(item => item.kind === 'recovery')
}

test('a finished turn is classified into exactly one free experience kind', () => {
  assert.equal(patternOf(state()), null, 'ordinary clean work is not evidence of anything')

  const resolved = patternOf(state(), { hadDivergence: true })
  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.divergence, null)
  assert(resolved.success, 'the clean turn is contrast evidence for the family')

  const recovery = patternOf(state({ toolErrors: 2, errors: [{ tool: 'Bash', text: 'timeout' }] }))
  assert.equal(recovery.kind, 'recovery')
  assert.equal(recovery.divergence.signals[0].kind, 'recovery')
  assert.equal(recovery.detail.metrics.toolErrors, 2)
  assert(recovery.success)

  // An incomplete turn with a tool error is a tool problem, not a completion problem:
  // fixing the tool call is the earlier, cheaper axis.
  const toolError = patternOf(state({ toolErrors: 1, complete: false, reason: 'max-tokens' }))
  assert.equal(toolError.kind, 'tool_error')
  assert.equal(patternOf(state({ complete: false, reason: 'cancelled' })).kind, 'incomplete')
  assert.equal(patternOf(state({ corrections: 1 })).kind, 'user_correction')
})

test('stored experience and trajectories never keep an unredacted credential', () => {
  const secret = 'api_key = abc123'
  const turn = state({
    text: `修复构建超时 ${secret}`, toolErrors: 1,
    errors: [{ tool: 'Bash', text: secret }],
  })
  const lesson = patternOf(turn)
  assert(!JSON.stringify(lesson).includes('abc123'))
  assert(!trajectoryText(turn).includes('abc123'))
  assert(JSON.stringify(lesson).includes('[REDACTED]'))
})

test('contrast renders metrics and a related success without inlining the raw trajectory', () => {
  const lesson = {
    kind: 'recovery', support: 3, contradictions: 0, state: 'observed',
    summary: '工具错误后仍完成：Bash', last_reason: null, attempts: 0,
  }
  const observed = snapshot(state({ toolErrors: 2, errors: [{ tool: 'Bash', text: 'timeout' }] }))
  const success = snapshot(state({ toolErrors: 0, steps: 3 }))
  const contrast = buildContrast({ lesson, observed, success })
  assert.match(contrast, /## 经验簇/)
  assert.match(contrast, /## 当前观察/)
  assert.match(contrast, /## 同任务成功\/恢复样本/)
  assert.match(contrast, /toolErrors=2/)
  assert(!contrast.includes('"toolErrors":2'), 'the evidence file remains the only raw body')
  assert(Buffer.byteLength(contrast) <= 3000)
})

test('rephrased occurrences join one cluster; unrelated work does not', () => {
  const store = new Store(':memory:')
  try {
    const first = store.recordLesson({
      scope: 'p', kind: 'recovery', taskKey: 'a', terms: terms('修复构建超时'),
      task: '修复构建超时', summary: 's', success: { summary: 'ok' },
    })
    const second = store.recordLesson({
      scope: 'p', kind: 'recovery', taskKey: 'b', terms: terms('修复一下构建超时'),
      task: '修复一下构建超时', summary: 's2',
    })
    assert.equal(second.id, first.id)
    assert.equal(second.support, 2)

    const other = store.recordLesson({
      scope: 'p', kind: 'recovery', taskKey: 'c', terms: terms('部署生产环境'),
      task: '部署生产环境', summary: 's3',
    })
    assert.notEqual(other.id, first.id)
    assert.deepEqual(store.lessonCandidates('p', 2, { kinds: ['recovery'] }).map(l => l.id), [first.id])
    // A pattern last seen outside the repeat window is history, not a recurring trigger.
    store.db.prepare('UPDATE lesson SET seen=? WHERE id=?').run(Date.now() - 10_000, first.id)
    assert.equal(store.lessonCandidates('p', 2, { kinds: ['recovery'], windowMs: 1000 }).length, 0)

    const related = store.relatedLesson('p', { taskKey: 'a', terms: terms('修复构建超时') })
    assert.equal(related.id, first.id)
  } finally { store.close() }
})

test('a compiled cluster is not reopened by recurrence, and two failures retire it', () => {
  const store = new Store(':memory:')
  try {
    const seeded = seedLesson(store)
    assert.equal(seeded.state, 'observed')
    assert.equal(store.lessonCandidates('p', 2, { kinds: ['recovery'] }).length, 1)

    assert.equal(store.settleLesson(seeded.id, { state: 'shadow', rev: 'r1', episode: 'e1' }).state, 'compiled')
    assert.equal(store.lessonCandidates('p', 2, { kinds: ['recovery'] }).length, 0)
    assert.equal(store.lesson(seeded.id).rev, 'r1')

    // A compiled lesson is already in the current version. Another occurrence must add
    // support, not reopen it, or the same edit would be paid for on every turn.
    const recurring = store.recordLesson({
      scope: 'p', kind: 'recovery', taskKey: 'k9', terms: terms('修复构建超时'),
      task: '修复构建超时', summary: 'again',
    })
    assert.equal(recurring.state, 'compiled')
    assert.equal(recurring.support, 3)

    // Only an explicit rollback invalidates it. One rollback leaves it retryable; the
    // second failure retires it for good.
    assert.equal(store.reopenLessonsForRev('r1', 'p'), 1)
    assert.equal(store.lesson(seeded.id).state, 'observed')
    assert.equal(store.lesson(seeded.id).contradictions, 1)
    store.settleLesson(seeded.id, { state: 'shadow', rev: 'r2', episode: 'e2' })
    store.reopenLessonsForRev('r2', 'p')
    const retired = store.lesson(seeded.id)
    assert.equal(retired.state, 'retired')
    assert.equal(retired.contradictions, 2)
    assert.equal(store.lessonCandidates('p', 2, { kinds: ['recovery'] }).length, 0)

    // Recurrence after retirement does not resurrect a pattern that already failed twice.
    const after = store.recordLesson({
      scope: 'p', kind: 'recovery', taskKey: 'k10', terms: terms('修复构建超时'),
      task: '修复构建超时', summary: 'still here',
    })
    assert.equal(after.state, 'retired')
  } finally { store.close() }
})

test('free observation fills the pool but a resolved turn is evidence, not a trigger', (t) => {
  const f = setup(t)
  const recovery = f.evolve.recordObservation({
    scope: 'p', state: state({ toolErrors: 1, errors: [{ tool: 'Bash', text: 'timeout' }] }),
  })
  assert.equal(recovery.kind, 'recovery')
  assert.equal(f.evolve.eligibleLesson('p', 1).id, recovery.id)
  // Crossing repeatThreshold changes only the pool status; it does not start an episode.
  const promoted = f.evolve.recordObservation({
    scope: 'p', state: state({ text: '修复一下构建超时', toolErrors: 1, errors: [{ tool: 'Bash', text: 'timeout' }] }),
  })
  assert.equal(promoted.id, recovery.id)
  assert.equal(promoted.support, 2)
  assert.equal(promoted.state, 'candidate')

  const clean = state({ text: '修复构建超时', toolErrors: 0 })
  assert.equal(f.evolve.recordObservation({ scope: 'p', state: clean }), null)
  const resolved = f.evolve.recordObservation({ scope: 'p', state: clean, hadDivergence: true })
  assert.equal(resolved.kind, 'resolved')
  assert.equal(f.evolve.eligibleLessons('p', 1).some(l => l.kind === 'resolved'), false)
  // The pool may return either matching success shape (the earlier recovery sample also
  // carries a success snapshot); what matters is that a same-family positive exists.
  const related = f.store.relatedLesson('p', { taskKey: resolved.task_key, terms: resolved.terms })
  assert(related)
  assert(['resolved', 'recovery'].includes(related.kind))
  assert(related.success)
})

test('a verified real task records positive evidence', (t) => {
  const f = setup(t)
  const lesson = f.evolve.recordVerified({
    scope: 'p', taskKey: 'v1', taskTerms: terms('修复构建超时'), task: '修复构建超时',
    state: state(), rev: 'r9', checks: [{ name: 'artifact', ok: true }],
  })
  assert.equal(lesson.kind, 'verified_success')
  assert.equal(lesson.support, 1)
  assert(lesson.success.metrics.complete)
  assert.equal(f.evolve.eligibleLessons('p', 1).some(l => l.kind === 'verified_success'), false)
})

test('a cluster-triggered episode compiles it, and a shadow failure reopens it', async (t) => {
  const editor = fixtureEditor()
  const f = setup(t, { editor })
  const lesson = seedLesson(f.store)
  const start = () => f.evolve.start({
    scope: 'p', taskKey: lesson.task_key, taskTerms: lesson.terms, trigger: 'lesson',
    divergence: divergenceOfLesson(lesson), metrics: lesson.detail ?? {},
    trajectory: lesson.trajectory ?? '', task: lesson.task, lesson: f.store.lesson(lesson.id),
  })

  const first = await start()
  assert.equal(first.started, true)
  await f.evolve.running
  assert.equal(f.store.lesson(lesson.id).state, 'compiled')

  // The first editor request carries the contrast, but not the raw trajectory body.
  const prompt = JSON.stringify(editor.requests[0].data)
  assert(prompt.includes('## 经验簇'))
  assert(prompt.includes('同任务成功'))
  assert(!prompt.includes('"toolErrors":2'))

  const decisions = f.evolve.observe({
    scope: 'p', taskKey: lesson.task_key, taskTerms: lesson.terms,
    corrections: 1, toolErrors: 0, complete: true,
  })
  assert.equal(decisions[0].verdict, 'fail')
  const reopened = f.store.lesson(lesson.id)
  assert.equal(reopened.state, 'observed')
  assert.equal(reopened.rev, null)
  assert.equal(reopened.contradictions, 1)

  const second = await start()
  assert.equal(second.started, true)
  await f.evolve.running
  f.evolve.observe({
    scope: 'p', taskKey: lesson.task_key, taskTerms: lesson.terms,
    corrections: 1, toolErrors: 0, complete: true,
  })
  assert.equal(f.store.lesson(lesson.id).state, 'retired')
  assert.equal((await start()).reason, 'lesson_retired')
  assert.equal(editor.requests.length, 2, 'a retired cluster never buys another editor session')
})

test('report exposes observed cost and refuses to call adoption generalization', (t) => {
  const f = setup(t)
  const report = f.evolve.report('p')
  assert.equal(report.scope, 'p')
  assert.equal(typeof report.lessons.counts.observed, 'number')
  assert.equal(report.episodes.total, 0)
  assert.equal(report.cost.calls, 0)
  assert.match(report.note, /留存\/迁移/)
})

test('a version 1 database gains the lesson column and keeps old episodes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolve-migrate-'))
  const path = join(dir, 'evolve.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(`
      PRAGMA user_version=1;
      CREATE TABLE episode(
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_key TEXT NOT NULL,
        trigger TEXT NOT NULL, from_rev TEXT NOT NULL, to_rev TEXT,
        divergence TEXT, target TEXT, cost TEXT, state TEXT NOT NULL,
        reason TEXT, created INTEGER NOT NULL, finished INTEGER);
      INSERT INTO episode VALUES ('e1','p','k','test','r0',NULL,NULL,'C4',NULL,'rejected','old',1,2);
    `)
    old.close()

    const store = new Store(path)
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6)
      const columns = store.db.prepare('PRAGMA table_info(episode)').all().map(c => c.name)
      assert(columns.includes('lesson'))
      const row = store.recentEpisodes('p', 1)[0]
      assert.equal(row.id, 'e1')
      assert.equal(row.lesson, null)
      assert.equal(store.lessonStats('p').counts.observed, 0)
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
