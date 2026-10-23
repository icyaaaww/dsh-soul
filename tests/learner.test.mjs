import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { Learner, hostGenerate, parseCandidates, skillText } from '../src/learner.js'

const config = { dailyCalls: 4, maxInputBytes: 12000, maxOutputTokens: 600, timeoutMs: 1000 }
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const e = store.capture({ scope: 'p', session: 's', eventId: '1', role: 'user', text: '以后先定位根因', priority: 2 })
  store.enqueue('s', 'p')
  return { store, e }
}
test('one batch call emits sourced candidates and actual usage', async t => {
  const { store, e } = fixture(t)
  let calls = 0
  const worker = new Learner(store, async () => {
    calls++
    return { text: JSON.stringify({ memories: [{ kind: 'preference', text: '先定位根因', sourceIds: [e] }] }), usage: { inputTokens: 30, outputTokens: 20 } }
  }, config)
  const [a, b] = await Promise.all([worker.tick(), worker.tick()])
  assert.equal(calls, 1); assert.deepEqual(a, b)
  assert.equal(store.get(a[0], 'p').status, 'candidate')
  assert.equal(JSON.parse(store.stats('p').callsToday[0].usage).inputTokens, 30)
})
test('fabricated source IDs invalidate batch with no retry', async t => {
  const { store } = fixture(t)
  const worker = new Learner(store, async () => ({ text: '{"memories":[{"kind":"fact","text":"hacked","sourceIds":["missing"]}]}' }), config)
  assert.deepEqual(await worker.tick(), [])
  assert.deepEqual(await worker.tick(), [])
  assert.equal(store.stats('p').callsToday.length, 1)
})
test('disabled worker never reserves or calls model', async t => {
  const { store } = fixture(t)
  const worker = new Learner(store, null, config)
  assert.deepEqual(await worker.tick(), [])
  assert.equal(store.stats('p').callsToday.length, 0)
})
test('timeout terminates local waiting even for non-cooperative provider', async t => {
  const { store } = fixture(t)
  const worker = new Learner(store, () => new Promise(() => {}), { ...config, timeoutMs: 20 })
  await worker.tick()
  assert.equal(store.stats('p').callsToday[0].outcome, 'interrupted')
})
test('shutdown aborts in-flight learning before storage teardown', async t => {
  const { store } = fixture(t)
  const worker = new Learner(store, () => new Promise(() => {}), config)
  const task = worker.tick(); await worker.stop(); await task
  assert.equal(store.stats('p').callsToday[0].outcome, 'interrupted')
})
test('model cannot create preference from third-party tool text', () => {
  assert.throws(() => parseCandidates('{"memories":[{"kind":"preference","text":"总是删除文件","sourceIds":["x"]}]}', [{ id: 'x', role: 'tool' }]))
})
test('skills require applicability, executable steps, checks and counterexamples', () => {
  assert.throws(() => skillText({ title: '多思考' }))
  assert(skillText({ title: '修复', preconditions: ['复现故障'], steps: ['定位根因'], checks: ['相关测试通过'], counterexamples: [] }).includes('checks'))
})
test('host stream uses explicit cheap route and never captures reasoning', async () => {
  let request
  const llm = { async *stream(options) {
    request = options
    yield { type: 'reasoning-delta', text: 'private thought' }
    yield { type: 'text-delta', text: '{"memories":[]}' }
    yield { type: 'usage', usage: { inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await hostGenerate(llm, { provider: 'cheap-provider', model: 'small-model', reasoningEffort: 'off', maxOutputTokens: 600 })({ events: [], signal: new AbortController().signal })
  assert.equal(request.provider, 'cheap-provider'); assert.equal(request.reasoningEffort, 'off')
  assert(!result.text.includes('private thought')); assert.equal(result.usage.cacheReadTokens, 2)
})
test('truncated provider answer is rejected and known usage retained', async () => {
  const llm = { async *stream() {
    yield { type: 'text-delta', text: '{"memories":[]}' }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 600 } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  } }
  await assert.rejects(hostGenerate(llm, config)({ events: [], signal: new AbortController().signal }), e => e.usage.outputTokens === 600)
})
