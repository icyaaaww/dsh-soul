import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { skillText } from '../src/learner.js'
import { settings } from '../index.js'

const goal = '修复数据库连接超时，原失败用例和回归测试通过'
function fixture(t) {
  let now = 100000
  const s = new Store(':memory:', { now: () => now }); t.after(() => s.close())
  const skill = (title = '数据库连接超时诊断', scope = 'p') => {
    const key = s.remember(scope, 'skill', skillText({ title, preconditions: ['已有可复现失败'], steps: ['先检查日志与配置'], checks: ['原失败用例通过'], counterexamples: ['没有复现时不改动配置'] }), 'human')
    s.accept(key, scope); return key
  }
  const key = skill()
  const begin = (session, turn = 1, scope = 'p') => s.experience.observe(session, scope, `start${turn}`, 'turn/start', { turn })
  const observation = (session, n = 1, { scope = 'p', turn = 1, name = 'test_tool', error = false, text = '原失败用例通过；输出来自测试工具' } = {}) => {
    s.experience.observe(session, scope, `c${n}`, 'tool/call', { turn, callId: `call${n}`, name })
    s.experience.observe(session, scope, `r${n}`, 'tool/result', { turn, message: { toolCallId: `call${n}`, isError: error } })
    const source = s.capture({ eventId: `r${n}`, scope, session, role: 'tool', text })
    s.experience.trackSource(session, scope, source)
    return source
  }
  const trial = (session, baseline, memory = key, taskGoal = goal) => s.experience.start({ memory, scope: 'p', session, goal: taskGoal, change: '先检查配置再重试', baseline }).trial.id
  const finish = (session, ms = 1000, turn = 1, reason = 'completed') => {
    now += ms; s.experience.observe(session, 'p', `end${turn}`, 'turn/end', { turn, reason: { kind: reason } })
  }
  const report = (id, session, ids, verdict = 'helped') => s.experience.report(id, 'p', session, { verdict, note: '观察到测试通过；比较是否可归因仍需审核', sourceIds: ids })
  const run = (session, baseline, { memory = key, ms = 1000, turn = 1, error = false } = {}) => {
    begin(session, turn); const id = trial(session, baseline, memory)
    const source = observation(session, 1, { turn, error }); report(id, session, [source]); finish(session, ms, turn)
    return { id, source }
  }
  return { s, key, skill, begin, observation, trial, finish, report, run, advance: ms => { now += ms } }
}

test('efficiency mode has capacity for complete evidence; explicit overrides and economy remain available', () => {
  const c = settings({ profile: 'test' })
  assert.equal(c.learningMode, 'efficiency'); assert.equal(c.learning, false)
  assert.equal(c.dailyCalls, 12); assert.equal(c.maxOutputTokens, 1600); assert.equal(c.idleMs, 10000)
  assert.equal(settings({ profile: 'test', learningMode: 'economy' }).maxOutputTokens, 600)
  assert.equal(settings({ profile: 'test', learningMode: 'efficiency', dailyCalls: 1, maxOutputTokens: 2200 }).dailyCalls, 1)
  assert.throws(() => settings({ profile: 'test', learningMode: 'aggressive' }))
  assert.throws(() => settings({ profile: 'test', learning: true }), /provider/)
})

test('observed run metrics are idempotent, exclude Soul tools and are not task-success verdicts', t => {
  const f = fixture(t)
  f.begin('s'); const id = f.trial('s')
  f.s.experience.observe('s', 'p', 'step1', 'step/start', { turn: 1 })
  f.s.experience.observe('s', 'p', 'step1', 'step/start', { turn: 1 })
  const source = f.observation('s', 1, { error: true })
  f.s.experience.observe('s', 'p', 'r1again', 'tool/result', { turn: 1, message: { toolCallId: 'call1', isError: true } })
  f.observation('s', 2, { name: 'learning_get' })
  f.report(id, 's', [source]); f.finish('s', 2500)
  const row = f.s.experience.get(id, 'p')
  assert.equal(row.observed.duration_ms, 2500); assert.equal(row.observed.steps, 1)
  assert.equal(row.observed.tool_calls, 1); assert.equal(row.observed.tool_errors, 1)
  assert.equal(row.observed.stop_reason, 'completed'); assert.equal(row.review, null)
  assert.equal(f.s.get(f.key, 'p').status, 'trial')
  assert(row.comparison.blockers.includes('missing_baseline')); assert.equal(row.comparison.delta, null)
  assert.throws(() => f.s.experience.assess(id, 'p', 'helped', '不能凭自己觉得成功就归因'), /不能确认/)
})

test('comparison records observed changes but promotion requires human review in two distinct sessions', t => {
  const f = fixture(t), baseline = f.run('base', null, { ms: 4000 })
  const a = f.run('a', baseline.id, { ms: 2000 })
  let row = f.s.experience.get(a.id, 'p')
  assert.equal(row.comparison.delta.durationMs, -2000)
  assert.equal(row.comparison.attribution, 'requires_human_review')
  assert.equal(f.s.get(f.key, 'p').status, 'trial')
  f.s.experience.assess(a.id, 'p', 'helped', '核对输入与环境一致，质量无回退且完成更快')
  f.s.experience.assess(a.id, 'p', 'helped', '重复审核不增加独立次数')
  f.s.feedback(f.key, 'p', 'a', 'pass', '同一会话的普通反馈不额外加分')
  assert.equal(f.s.experience.summary(f.key).passedSessions, 1)
  const b = f.run('b', baseline.id, { ms: 3000 })
  f.s.experience.assess(b.id, 'p', 'helped', '第二个会话独立核实结果')
  assert.equal(f.s.get(f.key, 'p').status, 'active')
  assert.equal(f.s.experience.summary(f.key).helped, 2)
  assert.throws(() => f.report(b.id, 'b', [b.source], 'harmed'), /已审核/)
})

test('lower latency cannot auto-win against harmed or unknown quality', t => {
  const f = fixture(t), base = f.run('base', null, { ms: 8000 }), a = f.run('a', base.id, { ms: 100 })
  f.s.experience.assess(a.id, 'p', 'harmed', '速度快但跳过了必要检查，产生回归')
  assert.equal(f.s.get(f.key, 'p').status, 'deprecated')
  assert(!f.s.recall('p', '数据库连接超时').includes(f.key))
  assert.throws(() => f.s.experience.assess(a.id, 'p', 'helped', '试图重新激活'), /只能试用/)
})

test('neutral and uncertain reviews never count as passed sessions', t => {
  const f = fixture(t), a = f.run('a'), b = f.run('b', a.id)
  f.s.experience.assess(a.id, 'p', 'uncertain', '没有基线')
  f.s.experience.assess(b.id, 'p', 'neutral', '无可观察改进')
  assert.equal(f.s.get(f.key, 'p').status, 'trial')
  assert.equal(f.s.experience.summary(f.key).passedSessions, 0)
  assert.equal(f.s.experience.summary(f.key).neutral, 1)
})

test('foreign, invented, assistant and other-turn evidence cannot substantiate trial reports', t => {
  const f = fixture(t), a = f.run('a')
  f.begin('b'); const b = f.trial('b')
  const assistant = f.s.capture({ eventId: 'assistant', session: 'b', scope: 'p', role: 'assistant', text: '我成功了' })
  f.s.experience.trackSource('b', 'p', assistant)
  for (const source of [a.source, assistant, 'invented']) assert.throws(() => f.report(b, 'b', [source]), /来源必须/)
  assert.throws(() => f.report(b, 'a', [a.source]), /当前会话/)
  assert.equal(f.s.experience.get(b, 'foreign'), null)
  const correct = f.observation('b')
  assert.throws(() => f.s.experience.report(b, 'p', 'b', { verdict: 'helped', note: '伪造耗时', sourceIds: [correct], duration_ms: 1 }), /报告需/)
  f.report(b, 'b', [correct]); f.finish('b')
  f.begin('b', 2); const later = f.trial('b', b)
  assert.throws(() => f.report(later, 'b', [correct]), /本轮/)
})

test('confounded, late, incomplete and unfinished comparisons cannot be reviewed as helpful', t => {
  const f = fixture(t), base = f.run('base')
  f.begin('multi'); const a = f.trial('multi', base.id)
  f.trial('multi', base.id, f.skill('另一个同时使用的方法'))
  f.report(a, 'multi', [f.observation('multi')]); f.finish('multi')
  assert(f.s.experience.get(a, 'p').comparison.blockers.includes('multiple_methods'))
  assert.throws(() => f.s.experience.assess(a, 'p', 'helped', '多个改动无法归因'), /multiple_methods/)
  f.begin('late'); f.observation('late')
  const b = f.trial('late', base.id)
  f.report(b, 'late', [f.observation('late', 2)]); f.finish('late')
  assert(f.s.experience.get(b, 'p').comparison.blockers.includes('late_registration'))
  f.begin('unfinished'); const c = f.trial('unfinished', base.id)
  f.report(c, 'unfinished', [f.observation('unfinished')])
  assert.throws(() => f.s.experience.assess(c, 'p', 'helped', '还没有结束'), /unfinished_run/)
  f.s.experience.interrupt('unfinished')
  assert(f.s.experience.get(c, 'p').comparison.blockers.includes('incomplete_observation'))
})

test('baseline goals must match, references are immutable and duplicate registration does not create trials', t => {
  const f = fixture(t), base = f.run('base')
  f.begin('s')
  assert.throws(() => f.trial('s', base.id, f.key, '另一个不相关任务'), /相同目标/)
  const a = f.trial('s', base.id)
  assert.equal(f.trial('s', base.id), a)
  assert.throws(() => f.report(base.id, 'base', [base.source]), /基线不可改写/)
  assert.equal(f.s.experience.list('p').length, 2)
})

test('forgetting baseline evidence invalidates downstream credit and source-derived lessons', t => {
  const f = fixture(t), baselineSkill = f.skill('旧版方法'), base = f.run('base', null, { memory: baselineSkill })
  const a = f.run('a', base.id), b = f.run('b', base.id)
  f.s.experience.assess(a.id, 'p', 'helped', '第一次确认'); f.s.experience.assess(b.id, 'p', 'helped', '第二次确认')
  assert.equal(f.s.get(f.key, 'p').status, 'active')
  const derived = f.s.add({ scope: 'p', kind: 'fact', text: '旧版方法衍生的结论', sourceIds: [base.source] })
  assert.equal(f.s.forget(baselineSkill, 'p'), 2)
  assert.equal(f.s.get(derived, 'p'), null); assert.equal(f.s.experience.get(base.id, 'p'), null)
  assert.equal(f.s.event(base.source), undefined)
  assert.equal(f.s.get(f.key, 'p').status, 'trial')
  assert.equal(f.s.experience.summary(f.key).passedSessions, 0)
  assert.equal(f.s.experience.get(a.id, 'p').review, null)
  assert.equal(f.s.db.prepare('PRAGMA foreign_key_check').all().length, 0)
})

test('a corrected evidence memory invalidates a reviewed trial and cached skill card', t => {
  const f = fixture(t), base = f.run('base'), a = f.run('a', base.id), b = f.run('b', base.id)
  f.s.experience.assess(a.id, 'p', 'helped', '第一轮对比'); f.s.experience.assess(b.id, 'p', 'helped', '第二轮对比')
  assert(f.s.recall('p', '数据库连接超时').includes('"helped":2'))
  const evidenceMemory = f.s.add({ scope: 'p', kind: 'fact', text: '第一次测试通过', sourceIds: [a.source] })
  f.s.revise(evidenceMemory, 'p', '第一次测试其实漏了用例', 'human')
  assert.equal(f.s.get(f.key, 'p').status, 'trial')
  assert(!f.s.recall('p', '数据库连接超时').includes('"helped":2'))
})

test('ranking favors human-supported skills only within equal lexical coverage', t => {
  const f = fixture(t), good = f.key, other = f.skill('数据库连接超时排查'), irrelevant = f.skill('烘焙蛋糕')
  f.s.feedback(good, 'p', 'one', 'pass', '实际通过'); f.s.feedback(good, 'p', 'two', 'pass', '实际通过')
  f.s.feedback(other, 'p', 'one', 'pass', '实际通过'); f.s.feedback(other, 'p', 'two', 'pass', '实际通过')
  const base = f.run('base'), after = f.run('after', base.id)
  f.s.experience.assess(after.id, 'p', 'helped', '对比确认改进')
  const found = f.s.discover('p', '数据库连接超时')
  assert.equal(found[0].id, good); assert(!found.some(x => x.id === irrelevant))
  assert.equal(f.s.discover('q', '数据库连接超时').length, 0)
})

test('metrics do not record tool arguments, duplicate result names, or unsupported clock duration', t => {
  const f = fixture(t)
  f.begin('s'); const a = f.trial('s')
  f.s.experience.observe('s', 'p', 'c', 'tool/call', { turn: 1, callId: 'known', name: 'test_tool', arguments: 'password=private' })
  f.s.experience.observe('s', 'p', 'r', 'tool/result', { turn: 1, message: { toolCallId: 'unknown', isError: false } })
  f.advance(-100); f.finish('s', 1)
  const row = f.s.experience.get(a, 'p')
  assert.equal(row.observed.duration_ms, null); assert.equal(row.observed.complete, 0)
  assert(!JSON.stringify(f.s.db.prepare('SELECT * FROM run_calls').all()).includes('private'))
})

test('retention preserves reviewed evidence, deleting a skill removes its reports, and reload cannot time an orphan', () => {
  const folder = mkdtempSync(join(tmpdir(), 'soul-experience-')), path = join(folder, 'memory.sqlite')
  let now = 100000, s = new Store(path, { now: () => now })
  try {
    const key = s.remember('p', 'skill', 'legacy skill', 'human'); s.accept(key, 'p')
    s.experience.startRun('s', 'p', 1)
    const a = s.experience.start({ memory: key, scope: 'p', session: 's', goal, change: '采用方法' }).trial.id
    const e = s.capture({ eventId: 'e', session: 's', scope: 'p', role: 'tool', text: 'secret=redacted\n测试结果' })
    s.experience.trackSource('s', 'p', e)
    s.experience.report(a, 'p', 's', { verdict: 'uncertain', note: '基线缺失', sourceIds: [e] })
    s.close(); now += 32 * 86400000; s = new Store(path, { now: () => now }); s.maintain()
    assert(s.event(e)); assert.equal(s.experience.current('s', 'p'), undefined)
    assert.equal(s.experience.get(a, 'p').observed.complete, 0)
    assert.equal(s.experience.get(a, 'p').observed.duration_ms, null)
    assert(!JSON.stringify(s.experience.get(a, 'p')).includes('redacted'))
    s.forget(key, 'p'); assert.equal(s.experience.get(a, 'p'), null); assert.equal(s.event(e), undefined)
  } finally { s.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('in-flight tool calls cause late registration and missing results prevent a complete comparison', t => {
  const f = fixture(t), base = f.run('base')
  f.begin('pending')
  f.s.experience.observe('pending', 'p', 'call', 'tool/call', { turn: 1, callId: 'slow', name: 'test_tool' })
  const key = f.trial('pending', base.id)
  f.report(key, 'pending', [f.observation('pending')]); f.finish('pending')
  const row = f.s.experience.get(key, 'p')
  assert(row.comparison.blockers.includes('late_registration'))
  assert(row.comparison.blockers.includes('incomplete_observation'))
  assert.equal(row.observed.duration_ms, null)
})

test('pending report counts invalidate cached cards across connections', () => {
  const folder = mkdtempSync(join(tmpdir(), 'soul-report-cache-')), path = join(folder, 'memory.sqlite')
  const writer = new Store(path), reader = new Store(path)
  try {
    const key = writer.remember('p', 'skill', '数据库连接超时诊断', 'human'); writer.accept(key, 'p')
    writer.experience.startRun('s', 'p', 1)
    const trial = writer.experience.start({ memory: key, scope: 'p', session: 's', goal, change: '测试方法' }).trial.id
    assert(!reader.recall('p', '数据库连接超时', 6000).includes('"pending":1'))
    const source = writer.capture({ eventId: 'result', session: 's', scope: 'p', role: 'tool', text: '实际观察' })
    writer.experience.trackSource('s', 'p', source)
    writer.experience.report(trial, 'p', 's', { verdict: 'uncertain', note: '尚无基线', sourceIds: [source] })
    assert(reader.recall('p', '数据库连接超时', 6000).includes('"pending":1'))
  } finally { reader.close(); writer.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('forgetting a skill suppresses observations even when its trial was never reported', t => {
  const f = fixture(t)
  f.begin('s'); f.trial('s')
  const e = f.observation('s')
  f.s.forget(f.key, 'p')
  assert.equal(f.s.event(e), undefined)
  assert(f.s.blocked(`event:${e}`))
  assert.equal(f.s.experience.list('p').length, 0)
})
