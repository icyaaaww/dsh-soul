import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { compareTrials, captureReplay, normalizeChecks } from '../src/validation.js'
import { hostProbe } from '../src/host-probe.js'

const run = (overrides = {}) => ({ ok: true, verification: 'same-snapshot', checks: [{ name: 'artifact', ok: true }],
  metrics: { complete: true, toolErrors: 0, tokens: 1000, durationMs: 10000, steps: 10 }, ...overrides })
const pair = (a = run(), b = run()) => ({ baseline: a, candidate: b })
test('verified quality wins must repeat; one lucky pass and unverifiable output never qualify', () => {
  const win = pair(run({ checks: [{name:'artifact',ok:false}] }), run())
  assert.equal(compareTrials([win, win]).reason, 'verified_quality_gain')
  assert.equal(compareTrials([win]).ok, false)
  assert.equal(compareTrials([win, pair()]).ok, false)
  assert.equal(compareTrials([pair(run(), run({checks:[]})), win]).ok, false)
  assert.equal(compareTrials([pair(run(), run({verification:'different'})), win]).ok, false)
  assert.equal(compareTrials([pair(run(), run({checks:[{name:'invented',ok:true}]})), win]).ok, false)
})
test('efficiency needs repeatable 20% savings with passing checks and no material tradeoff', () => {
  const b = run({metrics:{complete:true,toolErrors:0,tokens:750,durationMs:10000,steps:10}})
  assert.equal(compareTrials([pair(run(),b),pair(run(),b)]).reason, 'verified_efficiency_gain')
  const time = run({metrics:{...b.metrics,tokens:1000,durationMs:7000}})
  assert.equal(compareTrials([pair(run(),time),pair(run(),time)]).ok, true)
  for (const metrics of [{...b.metrics,tokens:null}, {...b.metrics,tokens:750,durationMs:20000}, {...b.metrics,tokens:990,durationMs:9900,steps:1}]) {
    const next = run({metrics})
    assert.equal(compareTrials([pair(run(),next),pair(run(),next)]).ok, false)
  }
})
test('checks require an explicit verifier dependency set unless the verifier is inline', () => {
  assert.throws(() => normalizeChecks([]), /checks/)
  assert.throws(() => normalizeChecks([{name:'test',argv:['node','test.mjs']}]), /protectedPaths/)
  assert.throws(() => normalizeChecks([{name:'test',argv:['node','test.mjs'],protectedPaths:['../test.mjs']}]), /invalid_verifier_paths/)
  assert.equal(normalizeChecks([{name:'test',argv:['node','-e','process.exit(0)']}])[0].argv[0], process.execPath)
})
test('replays pin code and reject edited verifiers; two worktrees never share output', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-validation-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  const git = (...args) => execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true})
  git('init','-q'); mkdirSync(join(dir,'tests'))
  writeFileSync(join(dir,'source.txt'),'before')
  writeFileSync(join(dir,'tests/check.cjs'), "if(require('fs').readFileSync('result.txt','utf8')!=='ok')process.exit(1)")
  git('add','.'); git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial')
  const checks = [{name:'artifact',argv:[process.execPath,'tests/check.cjs'],protectedPaths:['tests']}]
  const replay = await captureReplay(dir,checks)
  writeFileSync(join(dir,'source.txt'),'after');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','new head')
  let tamper = false
  const paths = []
  const execute = hostProbe({spawn: async ({cwd}) => {
    paths.push(cwd)
    const {readFileSync, existsSync} = await import('node:fs')
    assert.equal(readFileSync(join(cwd,'source.txt'),'utf8'),'before')
    assert.equal(existsSync(join(cwd,'result.txt')),false)
    writeFileSync(join(cwd,'result.txt'),'ok')
    if(tamper)writeFileSync(join(cwd,'tests/check.cjs'),'process.exit(0)')
    return {steps:1,toolCalls:1,toolErrors:0,complete:true,durationMs:1}
  }})
  const input = {root:dir,files:{'memory.md':'test'},checks,replay,signal:new AbortController().signal}
  const first = await execute(input)
  assert.equal(first.checks[0].ok,true)
  assert.equal((await execute(input)).verification,first.verification)
  assert.notEqual(paths[0],paths[1])
  tamper = true
  await assert.rejects(()=>execute(input),e=>e.code==='verifier_modified')
  assert.equal(git('status','--porcelain'),'')
  assert.equal(git('worktree','list','--porcelain').match(/worktree /g).length,1)
})
