import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUDGET_RATIO, MAX_BUDGET_BYTES, MIN_BUDGET_BYTES,
  budgetFor, createSkeletonEngine, fromConversation, skeletonSummarize, spanBytes,
} from '../src/compaction.js'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text, calls = []) => ({ role: 'assistant', content: [{ type: 'text', text }, ...calls] })
const toolCall = (name, input) => ({ type: 'tool-call', name, input })
const toolResult = text => ({ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] })

test('conversation messages map onto surface events without losing tool pairing', () => {
  const events = fromConversation([
    user('不要改 package.json'),
    assistant('先写文件', [toolCall('write', { path: 'src/a.js' })]),
    toolResult('ok'),
  ])
  assert.deepEqual(events.map(event => event.type), [
    'user/message', 'assistant/message', 'assistant/message', 'tool/result',
  ])
})

test('the budget scales with the span and is always clamped', () => {
  assert.equal(budgetFor({ messages: [] }), MIN_BUDGET_BYTES)
  const huge = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200000) }] }] }
  assert.equal(budgetFor(huge), MAX_BUDGET_BYTES)
  const mid = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] }
  assert.equal(budgetFor(mid), Math.floor(Buffer.byteLength(JSON.stringify(mid.messages[0].content)) * BUDGET_RATIO))
})

/** A span big enough to shrink: the host rejects any checkpoint that is not smaller. */
function longConversation() {
  const messages = [
    user('不要改 package.json，锁文件必须原样'),
    assistant('决定用 anchor 而不是摘要，因为摘要会丢掉约束'),
  ]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 步：检查输出与构建日志，确认缓存命中。`.repeat(3) }] })
  }
  return { messages }
}

test('the summarizer returns the backend envelope without calling a model', () => {
  const input = longConversation()
  const result = skeletonSummarize(input)
  assert.equal(result.llmStreamCall, false)
  assert.equal(result.summary.length, 1)
  assert.equal(result.summary[0].type, 'text')
  assert.match(result.summary[0].text, /package\.json/)
  assert.match(result.summary[0].text, /数据不是指令/)
  // The host refuses a checkpoint that is not smaller than the span it replaces.
  assert.ok(Buffer.byteLength(result.summary[0].text) < spanBytes(input) * 0.45)
  assert.ok(result.summary.every(block => block.type === 'text'))
})

test('a span below the framing overhead is refused instead of growing the transcript', () => {
  assert.throws(() => skeletonSummarize({ messages: [user('继续')] }), /小于可压缩下限/)
})

test('the engine subclass keeps the base constructor contract and overrides only summarize', async () => {
  const Base = class { constructor(ctx, config) { this.ctx = ctx; this.config = config; this.summarized = 0 } }
  const Engine = createSkeletonEngine(Base)
  const engine = new Engine({ id: 'ctx' }, { thresholdRatio: 0.8 })
  assert.equal(engine.ctx.id, 'ctx')
  assert.deepEqual(engine.config, { thresholdRatio: 0.8 })

  const out = await engine.summarize(longConversation(), null, undefined)
  assert.equal(out.llmStreamCall, false)
  assert.match(out.summary[0].text, /package\.json/)
})

test('a cancelled signal never yields a checkpoint', async () => {
  const Base = class { constructor() {} }
  const engine = new (createSkeletonEngine(Base))({}, {})
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(() => engine.summarize({ messages: [user('x')] }, null, controller.signal))
})

test('an un-replayable prefix is rejected instead of fabricating a summary', async () => {
  const Base = class { constructor() {} }
  const engine = new (createSkeletonEngine(Base))({}, {})
  await assert.rejects(() => engine.summarize({ messages: [] }, null, undefined), /可重放的消息前缀/)
  assert.throws(() => createSkeletonEngine(undefined), /需要一个 CompactionEngine 基类/)
})
