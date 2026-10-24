import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { command } from '../index.js'
import { skillText, Learner, hostGenerate } from '../src/learner.js'

const setup = t => { const s = new Store(':memory:'); t.after(() => s.close()); return s }
const event = (s, n, text = '以后先复现故障', scope = 'p') => s.capture({ session: 's', scope, eventId: n, role: 'user', text, priority: 2 })
const config = { dailyCalls: 4, maxInputBytes: 12000, maxOutputTokens: 600, timeoutMs: 1000 }
const longSkill = () => skillText({ title: '排查数据库连接超时', preconditions: ['已获得可复现的连接错误'],
  steps: Array.from({ length: 8 }, (_, i) => `${i}：检查日志并记录连接结果，${'核对实际配置和超时参数。'.repeat(7)}`),
  checks: ['数据库连接恢复', '相关测试通过'], counterexamples: ['未经授权不得修改生产数据库'] })

test('long trial skills are discoverable as bounded cards and full checks remain available', t => {
  const s = setup(t), text = longSkill()
  assert(Buffer.byteLength(text) > 2400)
  const key = s.remember('p', 'skill', text, 's')
  assert.equal(s.recall('p', '数据库连接超时'), '')
  s.accept(key, 'p')
  const recalled = s.recall('p', '数据库连接超时')
  assert(recalled.includes(key)); assert(recalled.includes('"status":"trial"'))
  assert(recalled.includes('"partial":true')); assert(recalled.includes('learning_get'))
  assert(Buffer.byteLength(recalled) < 1200)
  assert.equal(s.get(key, 'p').text, text)
  assert.equal(s.recall('p', '蛋糕烘焙'), '')
  s.feedback(key, 'p', 's1', 'pass', '真实使用通过')
  s.feedback(key, 'p', 's2', 'pass', '再次通过')
  assert(s.recall('p', '数据库连接超时').includes('"status":"active"'))
  s.feedback(key, 'p', 's3', 'fail', '复现反例')
  assert.equal(s.recall('p', '数据库连接超时'), '')
})

test('human remembering an existing candidate activates it without activating skills', t => {
  const s = setup(t), e = event(s, 1)
  const key = s.add({ scope: 'p', kind: 'preference', text: '先复现故障', sourceIds: [e] })
  assert.equal(s.recall('p', '故障'), '')
  assert.equal(s.remember('p', 'preference', '先复现故障', 's'), key)
  assert.equal(s.get(key, 'p').status, 'active')
  assert.equal(s.get(key, 'p').sources.length, 2)
  assert(s.recall('p', '故障').includes(key))
  const skill = s.remember('p', 'skill', longSkill(), 's')
  s.remember('p', 'skill', longSkill(), 's')
  assert.equal(s.get(skill, 'p').status, 'candidate')
})

test('cache observes another connection and rollback, with bounded entries and no prompt writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learning-v02-')), path = join(dir, 'memory.sqlite')
  const a = new Store(path), b = new Store(path)
  try {
    assert.equal(a.recall('p', '缓存检查'), '')
    const key = b.remember('p', 'fact', '缓存检查的旧内容', 's')
    const first = a.recall('p', '缓存检查')
    assert(first.includes(key))
    const before = a.db.prepare('SELECT total_changes() AS n').get().n
    assert.equal(a.recall('p', '缓存检查'), first)
    assert.equal(a.db.prepare('SELECT total_changes() AS n').get().n, before)
    assert.throws(() => b.tx(() => { b.db.prepare("UPDATE memories SET text='错误更新' WHERE id=?").run(key); throw new Error('rollback') }))
    assert.equal(a.recall('p', '缓存检查'), first)
    const next = b.revise(key, 'p', '缓存检查的新内容', 's')
    assert(a.recall('p', '缓存检查').includes(next))
    assert(!a.recall('p', '缓存检查').includes('旧内容'))
    b.forget(next, 'p')
    assert.equal(a.recall('p', '缓存检查'), '')
    for (let i = 0; i < 150; i++) a.recall('p', `query${i}`)
    assert.equal(a.cache.size, 128)
    const stats = a.stats('p')
    assert(stats.metrics.find(x => x.key === 'recall_cache_hits').value >= 2)
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('cache keys isolate scope and byte limits; empty results refresh on accept', t => {
  const s = setup(t), e = event(s, 1)
  const key = s.add({ scope: 'p', kind: 'fact', text: '缓存检查', sourceIds: [e] })
  assert.equal(s.recall('p', '缓存检查'), '')
  s.accept(key, 'p')
  assert(s.recall('p', '缓存检查').includes(key))
  assert.equal(s.recall('q', '缓存检查'), '')
  assert(Buffer.byteLength(s.recall('p', '缓存检查', 500)) <= 500)
  assert(s.recall('p', '缓存检查', 2400).includes(key))
})

test('inbox is bounded, scoped and shows evidence and explicit next steps', t => {
  const s = setup(t)
  for (let i = 0; i < 12; i++) s.add({ scope: 'session:s', kind: 'fact', text: `项目事实${i}`, sourceIds: [event(s, i, `来源${i}`, 'session:s')] })
  s.add({ scope: 'q', kind: 'fact', text: '其他项目秘密', sourceIds: [event(s, 'q', '秘密', 'q')] })
  const inbox = JSON.parse(command(s, 'inbox', { id: 's', header: {} }))
  assert.equal(inbox[0].total, 12); assert.equal(inbox[0].items.length, 10)
  assert(inbox[0].items[0].evidence.length)
  assert(inbox[0].items[0].next.includes('/learn accept'))
  assert(!JSON.stringify(inbox).includes('其他项目秘密'))
  assert.equal(s.stats('session:s').callsToday.length, 0)
})

test('nearby corrections coalesce before dispatch, running work is never mutated', t => {
  const s = setup(t), e1 = event(s, 1), key = s.enqueue('s', 'p')
  const e2 = event(s, 2, '下次检查回归测试')
  assert.equal(s.enqueue('s', 'p'), key)
  const job = s.reserve('worker', config)
  assert(job.events.some(e => e.id === e1)); assert(job.events.some(e => e.id === e2))
  event(s, 3, '下次核对变更范围')
  const next = s.enqueue('s', 'p')
  assert.notEqual(next, key)
  assert.equal(JSON.parse(s.db.prepare('SELECT event_ids FROM jobs WHERE id=?').get(key).event_ids).length, 2)
})

test('older high-priority corrections survive more than twelve intervening observations', t => {
  const s = setup(t), e = event(s, 1)
  for (let i = 0; i < 15; i++) s.capture({ session: 's', scope: 'p', eventId: `a${i}`, role: 'assistant', text: '常规进展' })
  assert(s.enqueue('s', 'p'))
  assert(s.reserve('w', config).events.some(row => row.id === e))
})

test('daily usage separates cache and reasoning and preserves unknown requests', async t => {
  const s = setup(t)
  event(s, 1); s.enqueue('s', 'p')
  await new Learner(s, async () => ({ text: '{"memories":[]}', usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 30, reasoningTokens: 12 } }), config).tick()
  event(s, 2); s.enqueue('s', 'p')
  await new Learner(s, async () => { throw new Error('secret-provider-body') }, config).tick()
  const stats = s.stats('p')
  assert.deepEqual(stats.usageToday, { reportedCalls: 1, unknownCalls: 1, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 30, reasoningTokens: 12 })
  assert(!JSON.stringify(stats).includes('secret-provider-body'))
  assert(stats.recentJobs.some(j => j.outcome === 'provider_failure'))
})

test('invalid JSON and truncated responses have safe, distinct diagnostic outcomes', async t => {
  const s = setup(t)
  event(s, 1); s.enqueue('s', 'p')
  await new Learner(s, async () => ({ text: 'private malformed output' }), config).tick()
  assert.equal(s.stats('p').callsToday[0].outcome, 'invalid_candidates')
  event(s, 2); s.enqueue('s', 'p')
  const generate = hostGenerate({ async *stream() {
    yield { type: 'text-delta', text: '{"memories":[]}' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 600 } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  } }, config)
  await new Learner(s, generate, config).tick()
  assert(s.stats('p').callsToday.some(c => c.outcome === 'truncated'))
  assert(!JSON.stringify(s.stats('p')).includes('private malformed output'))
})

test('schema v1 upgrade preserves memories, evidence, tombstones and spent budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learning-migration-')), path = join(dir, 'memory.sqlite')
  let s = new Store(path)
  try {
    const key = s.remember('p', 'preference', '先给结论', 's')
    const evidence = s.get(key, 'p').sources[0]
    const forgotten = s.remember('p', 'fact', '过时内容', 's')
    s.forget(forgotten, 'p')
    event(s, 1); s.enqueue('s', 'p')
    s.finish(s.reserve('w', config), [], null, 'failed')
    const tombstones = s.db.prepare('SELECT * FROM tombstones ORDER BY key').all()
    // Schema 1 is identical except for the retrieval revision metadata/triggers.
    s.db.exec(`DROP TRIGGER memory_insert_revision; DROP TRIGGER memory_update_revision;
      DROP TRIGGER memory_delete_revision; DELETE FROM meta WHERE key='retrieval_revision'; PRAGMA user_version=1;`)
    s.close(); s = new Store(path)
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(s.get(key, 'p').text, '先给结论'); assert(s.event(evidence))
    assert.deepEqual(s.db.prepare('SELECT * FROM tombstones ORDER BY key').all(), tombstones)
    assert.equal(s.stats('p').callsToday.length, 1)
    assert(s.recall('p', '').includes(key))
    s.revise(key, 'p', '先说明限制', 's')
    assert(!s.recall('p', '').includes('先给结论'))
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }) }
})
