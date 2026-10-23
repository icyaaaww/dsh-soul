import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { redact, projectScope } from '../src/util.js'

const setup = t => { const s = new Store(':memory:'); t.after(() => s.close()); return s }
const source = (s, scope = 'p', session = 's', eventId = 'e', text = '以后先定位根因', role = 'user') =>
  s.capture({ scope, session, eventId, role, text, priority: 2 })

test('Chinese retrieval, profile preferences and project isolation', t => {
  const s = setup(t)
  s.remember('p', 'fact', '这个项目使用蓝色按钮', 's')
  s.remember('q', 'fact', '隔壁项目使用蓝色按钮', 's2')
  s.remember('profile', 'preference', '回答先给结论', 's')
  const rows = s.search('p', '蓝色按钮')
  assert.equal(rows.length, 1); assert.equal(rows[0].scope, 'p')
  assert(s.recall('p', '按钮').includes('先给结论'))
  assert(!s.recall('p', '按钮').includes('隔壁'))
})
test('untrusted extracted preferences remain candidates until human acceptance', t => {
  const s = setup(t), e = source(s)
  const key = s.add({ scope: 'p', kind: 'preference', text: '先定位根因', sourceIds: [e] })
  assert.equal(s.recall('p', '根因'), '')
  assert.throws(() => s.add({ scope: 'p', kind: 'fact', text: '激活', sourceIds: [e], active: true }))
  s.accept(key, 'p')
  assert(s.recall('p', '根因').includes('先定位根因'))
})
test('foreign sources and unknown IDs cannot be used to launder evidence', t => {
  const s = setup(t), e = source(s, 'q')
  assert.throws(() => s.add({ scope: 'p', kind: 'fact', text: '内容', sourceIds: [e] }))
  assert.throws(() => s.add({ scope: 'p', kind: 'fact', text: '内容', sourceIds: ['unknown'] }))
})
test('correction retires old preference and preserves version relationship', t => {
  const s = setup(t), first = s.remember('p', 'preference', '回答详细', 's')
  const second = s.revise(first, 'p', '回答简洁', 's')
  assert.equal(s.get(second, 'p').version, 2)
  assert.equal(s.get(second, 'p').supersedes, first)
  assert.equal(s.get(first, 'p').status, 'deprecated')
  assert(!s.recall('p', '回答').includes('回答详细'))
})
test('skill needs two distinct human trials and fails closed on negative feedback', t => {
  const s = setup(t), key = s.remember('p', 'skill', '测试技能', 's')
  assert.throws(() => s.feedback(key, 'p', 's1', 'pass', '通过'))
  assert.equal(s.accept(key, 'p'), 'trial')
  assert.equal(s.feedback(key, 'p', 's1', 'pass', '通过'), 'trial')
  assert.equal(s.feedback(key, 'p', 's1', 'pass', '重复反馈'), 'trial')
  assert.equal(s.feedback(key, 'p', 's2', 'pass', '不同任务通过'), 'active')
  assert.equal(s.feedback(key, 'p', 's3', 'fail', '出现反例'), 'deprecated')
  assert(!s.recall('p', '测试技能').includes('测试技能'))
})
test('forget deletes sources, index, derivatives and blocks replay', t => {
  const s = setup(t), e = source(s)
  const root = s.add({ scope: 'p', kind: 'fact', text: '共同来源事实', sourceIds: [e] })
  const child = s.add({ scope: 'p', kind: 'episode', text: '共享来源派生内容', sourceIds: [e], parentIds: [root] })
  assert.equal(s.forget(root, 'p'), 2)
  assert.equal(s.get(child, 'p'), null)
  assert.equal(s.event(e), undefined)
  assert.equal(source(s), null)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM search').get().n, 0)
  const e2 = source(s, 'p', 's', 'new')
  assert.throws(() => s.add({ scope: 'p', kind: 'fact', text: '共同来源事实', sourceIds: [e2] }), /遗忘/)
})
test('forget during in-flight learning discards returned candidates', t => {
  const s = setup(t), e = source(s)
  const key = s.add({ scope: 'p', kind: 'fact', text: '待忘记', sourceIds: [e] })
  s.enqueue('s', 'p')
  const job = s.reserve('worker', { dailyCalls: 4, maxInputBytes: 12000, maxOutputTokens: 600, timeoutMs: 1000 })
  s.forget(key, 'p')
  assert.deepEqual(s.finish(job, [{ kind: 'fact', text: '重新出现', sourceIds: [e] }], null, 'ok'), [])
  assert.equal(s.search('p', '', { status: 'candidate' }).length, 0)
})
test('daily reservation is atomic across two connections and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-learning-')), path = join(dir, 'db.sqlite')
  let a, b
  try {
    a = new Store(path); b = new Store(path)
    source(a, 'p', 's1'); a.enqueue('s1', 'p')
    source(a, 'p', 's2'); a.enqueue('s2', 'p')
    const budget = { dailyCalls: 1, maxInputBytes: 12000, maxOutputTokens: 600, timeoutMs: 1000 }
    const job = a.reserve('a', budget)
    assert(job); assert.equal(b.reserve('b', budget), null)
    a.finish(job, [], null, 'failed'); a.close(); a = new Store(path)
    assert.equal(a.reserve('new', budget), null)
    assert.equal(a.stats('p').callsToday.length, 1)
  } finally { a?.close(); b?.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('expired calls are not retried automatically after crash', t => {
  let now = 1000000
  const s = new Store(':memory:', { now: () => now }); t.after(() => s.close())
  source(s); s.enqueue('s', 'p')
  const budget = { dailyCalls: 4, maxInputBytes: 12000, maxOutputTokens: 600, timeoutMs: 1000 }
  assert(s.reserve('a', budget)); now += 32000
  assert.equal(s.reserve('b', budget), null)
  assert.equal(s.stats('p').jobs[0].state, 'interrupted')
  assert.equal(s.stats('p').callsToday.length, 1)
})
test('same correction cannot enqueue paid learning every turn', t => {
  const s = setup(t)
  source(s)
  assert(s.enqueue('s', 'p'))
  s.capture({ eventId: 'answer', session: 's', scope: 'p', role: 'assistant', text: '已了解' })
  assert.equal(s.enqueue('s', 'p'), null)
})
test('empty/irrelevant query does not inject unrelated facts, byte cap enforced', t => {
  const s = setup(t)
  s.remember('p', 'fact', '火星探索', 's')
  assert.equal(s.recall('p', ''), '')
  assert.equal(s.recall('p', '财务报表'), '')
  for (let i = 0; i < 10; i++) s.remember('p', 'fact', '测试检索' + '甲'.repeat(200) + i, 's')
  assert(Buffer.byteLength(s.recall('p', '测试检索', 1200)) <= 1200)
})
test('credential redaction occurs before persistence', t => {
  const s = setup(t), secret = 'sk-123456789012345678901234'
  const key = source(s, 'p', 's', 'secret', `api_key=${secret}\nCookie: SESSDATA=longcredential`)
  assert(!s.event(key).text.includes(secret))
  assert(!s.event(key).text.includes('longcredential'))
  assert(!redact('https://user:pass@example.com').includes('user:pass'))
})
test('no cwd means session-local memory, never process-global', () => {
  assert.notEqual(projectScope({ id: 'a' }), projectScope({ id: 'b' }))
})
test('correction also retires derived memories based on the replaced evidence', t => {
  const s = setup(t), root = s.remember('p', 'fact', '原来使用旧接口', 's')
  const e = s.get(root, 'p').sources[0]
  const child = s.add({ scope: 'p', kind: 'fact', text: '基于旧接口的配置', sourceIds: [e], parentIds: [root] })
  s.accept(child, 'p')
  s.revise(root, 'p', '现在使用新接口', 's')
  assert.equal(s.get(child, 'p').status, 'deprecated')
  assert(!s.recall('p', '接口').includes('基于旧接口'))
})
test('TTL maintenance removes old unreferenced excerpts but retains memory evidence', t => {
  let now = 1000000
  const s = new Store(':memory:', { now: () => now }); t.after(() => s.close())
  const unreferenced = source(s, 'p', 's', 'orphan', '临时对话')
  const memory = s.remember('p', 'fact', '长期事实', 's')
  now += 31 * 86400000
  s.maintain()
  assert.equal(s.event(unreferenced), undefined)
  assert(s.event(s.get(memory, 'p').sources[0]))
})
test('byte-bounded batch prioritizes triggering correction over unrelated chat', t => {
  const s = setup(t)
  for (let i = 0; i < 6; i++) s.capture({ eventId: i, session: 's', scope: 'p', role: 'assistant', text: '无关'.repeat(1000) })
  const e = source(s, 'p', 's', 'fix', '以后先复现故障')
  s.enqueue('s', 'p')
  const job = s.reserve('w', { dailyCalls: 4, maxInputBytes: 2000, maxOutputTokens: 600, timeoutMs: 1000 })
  assert(job.events.some(row => row.id === e))
})
test('an explicit human command may reintroduce a forgotten fact without enabling source replay', t => {
  const s = setup(t), first = s.remember('p', 'fact', '偏好猫', 's')
  const oldSource = s.get(first, 'p').sources[0]
  s.forget(first, 'p')
  const second = s.remember('p', 'fact', '偏好猫', 's')
  assert.equal(s.get(second, 'p').status, 'active')
  assert(s.blocked(`event:${oldSource}`))
})
test('revision always has a distinct version even when another memory has identical text', t => {
  const s = setup(t), a = s.remember('p', 'fact', '旧值', 's'), b = s.remember('p', 'fact', '新值', 's')
  const revised = s.revise(a, 'p', '新值', 's')
  assert.notEqual(revised, b)
  assert.equal(s.get(revised, 'p').supersedes, a)
  assert.equal(s.get(revised, 'p').version, 2)
})
