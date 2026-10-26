import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settings, apply } from '../index.js'
import { Store } from '../src/store.js'
import { Evolution, evolutionSettings } from '../src/evolution.js'
import { compactObservations, fail } from '../src/evolution-suite.js'
import { finishProbe } from '../src/evolution-docker.js'
import { fixtureModel, suite, method } from './evolution-fixture.mjs'

const config = extra => evolutionSettings({ evolution: true, evolutionProvider: 'fixture', evolutionModel: 'executor', ...extra })
function fixture(t, extra = {}) {
  const s = new Store(':memory:'), model = fixtureModel(), e = new Evolution(s, model.generate, config(extra))
  e.register('p', suite()); t.after(async () => { await e.stop(); s.close() })
  return { s, e, model, run: async () => { const start = e.start('p', 'numbers', 's'); await e.running; return e.status('p', start.id)[0] } }
}

test('profile cannot silently fall back; explicit independent databases and disabled plugins remain usable', () => {
  assert.throws(() => settings(), /无法确定 profile/)
  const a = settings({ profile: 'one' }), b = settings({ profile: 'two' })
  assert.notEqual(a.database, b.database)
  assert.equal(settings({ database: ':memory:' }).database, ':memory:')
  assert.equal(apply({}, { enabled: false }), undefined)
  assert.throws(() => evolutionSettings({ evolution: true, provider: 'learning', model: 'learning-model' }), /不继承/)
  assert.equal(config({ evolutionEditorModel: 'editor' }).editorModel, 'editor')
})

test('fixed-suite result requires acceptance and two distinct human sessions; pending review blocks repeat spending', async t => {
  const f = fixture(t), run = await f.run()
  assert.equal(run.state, 'awaiting_review')
  assert.equal(f.s.get(run.memory, 'p').status, 'candidate')
  assert.equal(f.s.recall('p', '数字数组'), '')
  assert.throws(() => f.e.start('p', 'numbers', 's'), { code: 'review_pending' })
  assert.throws(() => f.s.feedback(run.memory, 'p', 'a', 'pass', 'test'), /接受/)
  f.s.accept(run.memory, 'p')
  f.s.feedback(run.memory, 'p', 'a', 'pass', 'task A')
  f.s.feedback(run.memory, 'p', 'a', 'pass', 'same session cannot count twice')
  assert.equal(f.s.get(run.memory, 'p').status, 'trial')
  f.s.feedback(run.memory, 'p', 'b', 'pass', 'task B')
  assert.equal(f.s.get(run.memory, 'p').status, 'active')
  f.e.rollback('p', 'numbers')
  const repeated = await f.run()
  assert.equal(repeated.state, 'rejected')
  assert.equal(repeated.reason, 'blocked_strategy')
  assert.equal(f.e.current('p', 'numbers'), undefined)
})

test('request bytes are reserved before dispatch and concurrent probes cannot exceed run or daily bytes', async t => {
  for (const extra of [{ evolutionRunInputBytes: 8000 }, { evolutionDailyInputBytes: 8000 }]) {
    const f = fixture(t, extra), result = await f.run()
    assert.equal(result.reason, 'input_budget')
    const usage = f.s.db.prepare('SELECT SUM(bytes) AS bytes,COUNT(*) AS n FROM evo_request_sizes').get()
    assert(usage.bytes <= 8000)
    assert.equal(usage.n, f.model.requests.length)
  }
  const f = fixture(t)
  const estimate = f.e.estimate('p', 'numbers').estimate
  assert.deepEqual(estimate.fullPlanCalls, { min: 22, max: 112 })
  assert.equal(estimate.runCallCap, 80); assert.equal(estimate.dailyCallCap, 100)
  assert.equal(estimate.runInputByteCap, 512000)
  assert.equal(f.model.requests.length, 0)
})

test('executor context retains latest reads, summarizes writes and bounds trace entries', () => {
  const trace = [{ type: 'read', path: 'input', text: 'old' }, { type: 'write', path: 'result', text: 'x'.repeat(16000) }, { type: 'read', path: 'input', text: 'latest' }]
  const context = compactObservations(trace)
  assert.deepEqual(context, [{ type: 'write', path: 'result', bytes: 16000 }, { type: 'read', path: 'input', text: 'latest' }])
  assert.equal(compactObservations(Array.from({ length: 30 }, () => ({ error: 'missing_file' }))).length, 16)
  assert.equal(trace[1].text.length, 16000)
})

test('cleanup failure preserves execution/cancellation diagnosis and prevents success publication', () => {
  const cleanup = fail('sandbox_cleanup'), cancelled = fail('cancelled')
  assert.throws(() => finishProbe(null, cancelled, cleanup), e => e === cancelled && e.cleanupError === cleanup)
  assert.throws(() => finishProbe({ ok: false, error: 'sandbox_timeout' }, null, cleanup), e => e.code === 'sandbox_timeout' && e.cleanupError === cleanup)
  assert.throws(() => finishProbe({ ok: true, output: '42' }, null, cleanup), { code: 'sandbox_cleanup' })
  assert.deepEqual(finishProbe({ ok: false, error: 'sandbox_timeout' }, null, null), { ok: false, error: 'sandbox_timeout' })
})

test('discovery batches evidence and verification queries independently of skill count', t => {
  const s = new Store(':memory:'); t.after(() => s.close())
  for (let i = 0; i < 24; i++) {
    const key = s.remember('p', 'skill', JSON.stringify(method(`数字数组 method ${i}`)), 's')
    s.accept(key, 'p'); s.feedback(key, 'p', 'a', 'pass', 'ok'); s.feedback(key, 'p', 'b', 'pass', 'ok')
  }
  const prepare = s.db.prepare.bind(s.db); let count = 0
  s.db.prepare = sql => { count++; return prepare(sql) }
  const cards = s.discover('p', '数字数组')
  assert.equal(cards.length, 6); assert(cards.every(c => c.evidence.passedSessions === 2))
  assert.equal(count, 5)
  s.db.prepare = prepare
})
