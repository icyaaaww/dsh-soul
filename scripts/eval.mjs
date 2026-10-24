import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { skillText } from '../src/learner.js'

// Local user-history scenarios; this measures retrieval, not LLM task success.
const s = new Store(':memory:')
const cases = []
function check(name, scope, query, expected, forbidden = []) {
  const context = s.recall(scope, query)
  const present = expected.every(id => context.includes(id))
  const absent = forbidden.every(id => !context.includes(id))
  cases.push({ name, pass: present && absent && Buffer.byteLength(context) <= 2400, contextBytes: Buffer.byteLength(context) })
}
try {
  const preference = s.remember('profile', 'preference', '回答请先给结论，再解释原因', 'user1')
  const project = s.remember('project:a', 'fact', '当前服务用 SQLite 保存任务，先备份再迁移', 'user1')
  const foreign = s.remember('project:b', 'fact', '另一个服务的 SQLite 禁止原地迁移', 'user2')
  check('跨项目通用表达偏好', 'project:b', '你好', [preference], [project])
  check('项目规则不串到其他项目', 'project:a', 'SQLite 迁移', [preference, project], [foreign])
  check('没有相关资料时只提供明确偏好', 'project:a', '蛋糕烘焙', [preference], [project, foreign])
  const source = s.capture({ session: 'u1', scope: 'project:a', eventId: 'e1', role: 'user', text: '以后加上回归测试', priority: 2 })
  const candidate = s.add({ scope: 'project:a', kind: 'preference', text: '修改后需要回归测试', sourceIds: [source] })
  check('推测的候选不能成为既定偏好', 'project:a', '回归测试', [preference], [candidate])
  s.remember('project:a', 'preference', '修改后需要回归测试', 'user1')
  check('明确命令确认已有候选', 'project:a', '回归测试', [candidate])
  const revised = s.revise(project, 'project:a', '当前服务已迁移 PostgreSQL，保留迁移前备份', 'user1')
  check('修订后旧规则不再被召回', 'project:a', '迁移', [revised], [project])
  s.forget(revised, 'project:a')
  check('遗忘立即作用于重复查询', 'project:a', '迁移', [], [revised, project])
  const text = skillText({ title: '诊断任务队列重复执行', preconditions: ['出现重复任务日志'],
    steps: Array.from({ length: 8 }, (_, i) => `${i}. ${'检查任务标识、日志时间、重试次数以及锁的归属。'.repeat(5)}`),
    checks: ['同一任务只完成一次', '重启后任务不重复'], counterexamples: ['禁止直接删除生产任务数据'] })
  assert(Buffer.byteLength(text) > 2400)
  const skill = s.remember('project:a', 'skill', text, 'user1')
  check('未接受的技能不注入', 'project:a', '任务队列重复执行', [], [skill])
  s.accept(skill, 'project:a')
  check('相关试用长技能可发现', 'project:a', '任务队列重复执行', [skill])
  s.feedback(skill, 'project:a', 'trial1', 'pass', '第一次真实使用通过')
  s.feedback(skill, 'project:a', 'trial2', 'pass', '第二次真实使用通过')
  check('验证后的长技能仍可发现', 'project:a', '任务队列重复执行', [skill])
  const fullBytes = Buffer.byteLength(text), cardBytes = Buffer.byteLength(JSON.stringify(s.discover('project:a', '任务队列重复执行').find(r => r.id === skill)))
  s.feedback(skill, 'project:a', 'trial3', 'fail', '重启后出现反例')
  check('失败技能立即退出检索', 'project:a', '任务队列重复执行', [], [skill])
  console.log(JSON.stringify({ scenarios: cases.length, passed: cases.filter(c => c.pass).length, cases,
    longSkillExample: { fullTextBytes: fullBytes, cardBytes, note: 'Reading the complete skill via learning_get adds a tool round trip and additional input tokens.' },
    note: 'Curated deterministic retrieval scenarios, not held-out research benchmarks or paid-model quality/cost evaluation. No monetary saving percentage claimed.' }, null, 2))
  if (cases.some(c => !c.pass)) process.exitCode = 1
} finally { s.close() }
