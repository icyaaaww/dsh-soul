// Usage: node scripts/verify-upgrade.mjs /absolute/path/to/previous-release.tgz [...]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'

assert(process.argv.length > 2, 'Supply at least one released TGZ archive')
for (const archive of process.argv.slice(2)) {
  const folder = mkdtempSync(join(tmpdir(), 'soul-upgrade-'))
  let old, upgraded
  try {
    execFileSync('tar', ['-xf', resolve(archive), '-C', folder])
    const { Store: OldStore } = await import(pathToFileURL(join(folder, 'package/src/store.js')).href)
    const path = join(folder, 'memory.sqlite')
    old = new OldStore(path)
    const before = old.db.prepare('PRAGMA user_version').get().user_version
    const preference = old.remember('p', 'preference', '先给结论', 's')
    const source = old.get(preference, 'p').sources[0]
    const forgotten = old.remember('p', 'fact', '已过时信息', 's'); old.forget(forgotten, 'p')
    const skill = old.remember('p', 'skill', JSON.stringify({ title: '修复', preconditions: ['能复现'], steps: ['查根因'], checks: ['验证'], counterexamples: [] }), 's')
    old.accept(skill, 'p'); old.feedback(skill, 'p', 's1', 'pass', '通过')
    old.capture({ scope: 'p', session: 's', eventId: 'trigger', role: 'user', text: '以后先复现', priority: 2 })
    old.enqueue('s', 'p')
    const job = old.reserve('old', { dailyCalls: 4, maxInputBytes: 12000, maxOutputTokens: 600, timeoutMs: 1000 })
    old.finish(job, [], { inputTokens: 10, outputTokens: 20 }, 'ok')
    const tombstones = old.db.prepare('SELECT * FROM tombstones ORDER BY key').all()
    const calls = old.db.prepare('SELECT * FROM calls ORDER BY id').all()
    let priorTrial
    if (old.experience) {
      old.experience.startRun('old-trial', 'p', 1)
      priorTrial = old.experience.start({ memory: skill, scope: 'p', session: 'old-trial', goal: '验证旧版使用记录', change: '保留现有方法' }).trial.id
      const observed = old.capture({ eventId: 'result', session: 'old-trial', scope: 'p', role: 'tool', text: '实际工具观察' })
      old.experience.trackSource('old-trial', 'p', observed)
      old.experience.report(priorTrial, 'p', 'old-trial', { verdict: 'uncertain', note: '没有基线', sourceIds: [observed] })
    }
    old.close(); old = null
    upgraded = new Store(path)
    assert.equal(upgraded.get(preference, 'p').text, '先给结论')
    assert(upgraded.event(source))
    assert.equal(upgraded.get(skill, 'p').feedback.length, 1)
    assert.equal(upgraded.get(skill, 'p').status, 'trial')
    assert.equal(upgraded.get(skill, 'p').performance.passedSessions, 1)
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM tombstones ORDER BY key').all(), tombstones)
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM calls ORDER BY id').all(), calls)
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4)
    if (priorTrial) assert.equal(upgraded.experience.get(priorTrial, 'p').verdict, 'uncertain')
    assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM evo_suites').get().n, 0)
    assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0)
    upgraded.experience.startRun('new-session', 'p', 1)
    assert(upgraded.experience.start({ memory: skill, scope: 'p', session: 'new-session', goal: '修复故障', change: '验证升级后试用' }).trial.id)
    upgraded.close(); upgraded = null
    assert.throws(() => new OldStore(path), /版本/)
    console.log(JSON.stringify({ archive: resolve(archive), fromSchema: before, toSchema: 4, passed: true,
      verified: ['memory', 'sources', 'feedback', 'tombstones', 'spent budget', 'new trial', 'integrity', 'old-version rejection'] }))
  } finally { old?.close(); upgraded?.close(); rmSync(folder, { recursive: true, force: true }) }
}
