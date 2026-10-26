#!/usr/bin/env node
/**
 * Offline demonstration of one full episode.
 *
 * Uses a deterministic editor and a deterministic probe so the run is reproducible and costs
 * nothing. Everything except the two model/executor boundaries is production code: the gate,
 * the anchor checks, the budget reservation, the shadow window and the rollback path are the
 * same ones a real run would use.
 *
 * This proves the loop works. It does NOT prove the plugin improves a real agent.
 */
import { Store } from '../src/harness-evolution/src/store.js'
import { Evolve } from '../src/harness-evolution/src/evolve.js'
import { budgetSettings } from '../src/harness-evolution/src/budget.js'
import { diagnose } from '../src/harness-evolution/src/diagnose.js'
import { sizeReport } from '../src/harness-evolution/src/tree.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../src/harness-evolution/harness/default/', import.meta.url))
const files = {}
for (const name of ['system.md', 'guardrails.md', 'memory.md', 'tools.md', 'subagents.md']) {
  files[name] = readFileSync(dir + name, 'utf8')
}

const divergence = { signals: [{ kind: 'tool_error', weight: 3, detail: 'Bash timeout on the build command' }], score: 3 }

const editor = async ({ data }) => {
  // Read the trajectory once, then edit ONLY the diagnosed component. Moving the timeout
  // detail into a skill would be a second axis, and the single-variable gate would reject
  // the whole episode -- which is the point: an edit must stay attributable.
  if (!data.observations.includes('toolErrors')) {
    return { actions: [{ type: 'read', path: data.index.evidence[0] }] }
  }
  return {
    actions: [
      { type: 'write', path: 'harness/tools.md', text: '## 工具\n读用 Read，找用 Grep。同一命令连续失败两次就停，改为报告。\n超时就缩小范围，不重试原命令。\n' },
      { type: 'finish', why: '工具指引删去与超时无关的细节，并补一条有界回退' },
    ],
  }
}

const executor = async () => ({
  metrics: { toolErrors: 0, toolCalls: 5, steps: 3, complete: true, deliverable: true, durationMs: 1 },
  transcript: 'candidate run: build succeeded after bounded retry',
})

const store = new Store(':memory:')
const config = {
  enabled: true, provider: 'offline-fixture', model: 'deterministic', reasoningEffort: '',
  injectHarness: false, harnessFolder: '.dsh-soul/harness', checks: [],
  budget: budgetSettings({ cooldownTurns: 0 }),
}
const evolve = new Evolve({ store, config, generate: editor, execute: executor })

try {
  evolve.ensure('demo', files)
  const before = sizeReport(files)
  const diagnosis = diagnose(divergence)
  console.log(JSON.stringify({
    note: '离线确定性演示：编辑器与探测都是替身，闸门/额度/影子/回滚是生产代码。不证明真实模型提升。',
    phase: 'diagnose',
    diagnosis: { target: diagnosis.target, rule: diagnosis.rule, why: diagnosis.why },
    fixedTaxBefore: before.tax,
  }, null, 2))

  const started = await evolve.start({
    scope: 'demo', taskKey: 'build-fix', trigger: 'demo', divergence,
    metrics: { toolErrors: 2, toolCalls: 9, steps: 5, complete: true, deliverable: true },
    trajectory: JSON.stringify({ toolErrors: 2, toolCalls: 9, steps: 5 }),
    task: '修复构建超时',
  })
  await evolve.running
  const episode = store.episode(started.episode, 'demo')
  const current = evolve.current('demo')
  const after = sizeReport(current.files)

  console.log(JSON.stringify({
    phase: 'episode',
    state: episode.state,
    reason: episode.reason,
    cost: episode.cost,
    fixedTaxBefore: before.tax,
    fixedTaxAfter: after.tax,
    taxDelta: after.tax - before.tax,
    evidence: episode.evidence.map(e => `${e.kind}:${e.bytes}B`),
  }, null, 2))

  // Real traffic falsifies the candidate.
  const decisions = evolve.observe({ scope: 'demo', taskKey: 'build-fix', corrections: 1, toolErrors: 0, complete: true })
  console.log(JSON.stringify({
    phase: 'shadow',
    observed: decisions,
    revState: store.rev(current.rev, 'demo').state,
    restored: evolve.current('demo').rev === store.rev(current.rev, 'demo').parent,
  }, null, 2))

  const integrity = store.integrity()
  console.log(JSON.stringify({ phase: 'audit', ledger: store.ledger('demo', 6).map(r => r.action), ...integrity }, null, 2))
  if (episode.state !== 'shadow') process.exitCode = 1
} finally {
  await evolve.stop()
  store.close()
}
