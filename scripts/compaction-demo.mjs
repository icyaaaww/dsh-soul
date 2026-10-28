import { budgetFor, skeletonSummarize } from '../src/compaction.js'

/**
 * Offline demo of graph compaction: feed a long conversation through the exact `summarize()`
 * hook the host calls, then show what would replace the condensed span.
 * No model is called anywhere in this file.
 */

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const say = (text, calls = []) => ({ role: 'assistant', content: [{ type: 'text', text }, ...calls] })
const write = path => ({ type: 'tool-call', name: 'write', input: { path } })
const result = text => ({ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] })

const words = ['读取', '检查', '输出', '构建', '缓存', '索引', '日志', '模块', '目录', '字段', '接口', '参数']
const noise = (seed) => `step ${seed}: ${Array.from({ length: 26 }, (_, i) => words[(seed + i) % words.length]).join(' ')} ok`

const messages = [
  user('把 soul 的压缩失忆修好，先看架构再动手'),
  user('不要改 package.json，锁文件必须原样'),
  user('构建必须走 pnpm build --frozen-lockfile'),
  user('探测必须在 git worktree 里跑，不能污染主目录'),
]
for (let i = 0; i < 10; i++) messages.push(result(noise(i)))
messages.push(say('决定用 anchor 而不是摘要，因为摘要会丢掉约束'))
messages.push(say('写入产物', [write('src/skeleton.js')]))
messages.push(result('wrote src/skeleton.js'))
for (let i = 10; i < 18; i++) messages.push(result(noise(i)))
messages.push(say('决定把 schema 升到 4，因为需要双时态的失效判定'))
messages.push(say('写入产物', [write('src/store.js')]))
messages.push(result('wrote src/store.js'))
for (let i = 18; i < 24; i++) messages.push(result(noise(i)))
messages.push(user('继续'))
messages.push(say('下一步必须重跑成对验证再谈收益'))

const inputBytes = messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message.content)), 0)
const budget = budgetFor({ messages })
const output = skeletonSummarize({ messages })

console.log(`输入 ${messages.length} 条消息 / ${inputBytes} bytes`)
console.log(`预算 ${budget} bytes（跨度的 ${Math.round(budget / inputBytes * 100)}%）`)
console.log(`\n=== 替换该跨度的 checkpoint ===\n${output.summary[0].text}\n`)
console.log(`输出 ${Buffer.byteLength(output.summary[0].text)} bytes`)
console.log(`llmStreamCall = ${output.llmStreamCall}（换掉摘要器就等于删掉这次调用）`)

for (const token of ['package.json', '--frozen-lockfile', 'worktree', 'anchor', '双时态', 'src/skeleton.js', '成对验证']) {
  console.log(`  ${token.padEnd(20)} ${output.summary[0].text.includes(token) ? '保留' : '丢失'}`)
}
