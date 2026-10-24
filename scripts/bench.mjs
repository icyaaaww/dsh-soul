import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

const folder = mkdtempSync(join(tmpdir(), 'dsh-learning-bench-'))
const store = new Store(join(folder, 'bench.sqlite'))
try {
  const start = performance.now()
  store.tx(() => {
    for (let i = 0; i < 10000; i++) {
      const e = store.capture({ eventId: i, session: 'bench', scope: 'project:bench', role: 'command', text: `任务${i}：修复日志中的数据库问题，先复现后测试。tag${i}` })
      store.add({ scope: 'project:bench', kind: 'fact', text: `任务${i}：修复数据库问题，先复现后测试。tag${i}`, sourceIds: [e], origin: 'human', active: true })
    }
  })
  const setupMs = performance.now() - start
  const cases = {
    specific_uncached: { cold: true, queries: Array.from({ length: 100 }, (_, i) => `tag${i * 97}`) },
    broad_chinese_uncached: { cold: true, queries: Array.from({ length: 100 }, () => '数据库问题修复') },
    broad_chinese_cached: { cold: false, queries: Array.from({ length: 100 }, () => '数据库问题修复') },
  }
  const result = {}
  for (const [name, { cold, queries }] of Object.entries(cases)) {
    if (!cold) store.recall('project:bench', queries[0])
    const samples = queries.map(q => { if (cold) store.cache.clear(); const t = performance.now(); store.recall('project:bench', q); return performance.now() - t }).sort((a,b) => a-b)
    result[name] = { p50_ms: +samples[49].toFixed(3), p95_ms: +samples[94].toFixed(3), max_ms: +samples[99].toFixed(3) }
  }
  console.log(JSON.stringify({ fixtureRecords: 10000, samplesPerCase: 100, node: process.version, platform: process.platform,
    cpu: cpus()[0]?.model, memoryGiB: Math.round(totalmem()/2**30), setupMs: Math.round(setupMs), result,
    note: 'Synthetic disk-backed local benchmark; uncached clears the plugin cache, not SQLite/OS caches. Cached uses one prewarmed query. No model requests; not end-to-end or cross-device performance.' }, null, 2))
} finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
