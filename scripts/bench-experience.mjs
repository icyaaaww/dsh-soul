import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

const folder = mkdtempSync(join(tmpdir(), 'soul-experience-bench-'))
const s = new Store(join(folder, 'memory.sqlite'))
const quantiles = values => {
  values.sort((a, b) => a - b)
  return { p50_ms: +values[Math.floor(values.length * .5)].toFixed(3), p95_ms: +values[Math.floor(values.length * .95)].toFixed(3) }
}
try {
  const observation = [], retrieval = []
  for (let i = 0; i < 1000; i++) {
    const key = s.remember('p', 'skill', JSON.stringify({ title: `数据库故障诊断方案 ${i}`, preconditions: ['已有失败'], steps: ['定位根因'], checks: ['回归通过'], counterexamples: [] }), `human${i}`)
    s.accept(key, 'p'); s.feedback(key, 'p', 'one', 'pass', '通过'); s.feedback(key, 'p', 'two', 'pass', '通过')
  }
  for (let turn = 1; turn <= 100; turn++) {
    const start = performance.now()
    s.experience.observe('s', 'p', 'start', 'turn/start', { turn })
    s.experience.observe('s', 'p', 'step', 'step/start', { turn })
    for (let call = 0; call < 5; call++) {
      s.experience.observe('s', 'p', `c${call}`, 'tool/call', { turn, callId: String(call), name: 'fixture_tool' })
      s.experience.observe('s', 'p', `r${call}`, 'tool/result', { turn, message: { toolCallId: String(call), isError: false } })
    }
    s.experience.observe('s', 'p', 'end', 'turn/end', { turn, reason: { kind: 'completed' } })
    observation.push(performance.now() - start)
    s.cache.clear()
    const searchStart = performance.now(); s.recall('p', '数据库故障诊断', 3600)
    retrieval.push(performance.now() - searchStart)
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
    skillRecords: 1000, samples: 100, observedTurn13Events: quantiles(observation), skillsUncached: quantiles(retrieval),
    note: 'Synthetic local disk-backed SQLite benchmark; 13 observed events per turn, no real tools/model calls. Not end-to-end task latency or cross-device evidence.' }, null, 2))
} finally { s.close(); rmSync(folder, { recursive: true, force: true }) }
