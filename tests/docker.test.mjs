import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { prepareDocker, executeJavaScript } from '../src/evolution-docker.js'
import { executeProbe, suiteContract } from '../src/evolution-suite.js'
import { Evolution, evolutionSettings } from '../src/evolution.js'
import { Store } from '../src/store.js'
import { suite, method, fixtureModel } from './evolution-fixture.mjs'

const image = process.env.DSH_SOUL_DOCKER_IMAGE
test('real Docker executes generated code with host-independent validation and isolation', { skip: !image }, async () => {
  const signal = new AbortController().signal, prepared = await prepareDocker(image, signal)
  const result = await executeJavaScript(prepared, { signal, input: [3,1,3],
    files: new Map([['solution.mjs', 'export default xs => [...new Set(xs)].sort((a,b)=>a-b)']]) })
  assert.equal(result.ok, true); assert.deepEqual(JSON.parse(result.output), [1,3])
  const contract = suite({ runtime: 'javascript' })
  contract.cases.forEach(c => { c.invocation = JSON.parse(c.files['input.json']); c.checks = [{ target: 'execution', kind: 'jsonEquals', expected: c.checks[0].expected }] })
  const task = suiteContract(contract).value.cases[0]
  const probe = await executeProbe({ task, strategy: method('test'), signal, runtime: 'javascript',
    request: async () => ({ actions: [{ type: 'write', path: 'solution.mjs', text: 'export default xs => [...new Set(xs)].sort((a,b)=>a-b)' }, { type: 'finish', answer: 'done' }] }),
    executeCode: options => executeJavaScript(prepared, options) })
  assert.equal(probe.pass, true)
  const isolation = await executeJavaScript(prepared, { signal, input: null, files: new Map([['solution.mjs', `
    import fs from 'node:fs/promises'; import net from 'node:net';
    export default async () => {
      let readonly=false; try {await fs.writeFile('/workspace/escape','x')}catch{readonly=true}
      const network = await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:80});s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.setTimeout(500,()=>{s.destroy();resolve(false)})});
      return {readonly,network,secret:process.env.DSH_SOUL_TEST_SECRET??null}
    }`]]) })
  assert.equal(isolation.ok, true); assert.deepEqual(JSON.parse(isolation.output), { readonly: true, network: false, secret: null })
  const loop = await executeJavaScript(prepared, { signal, input: 0, timeoutMs: 1000,
    files: new Map([['solution.mjs', 'export default () => {while(true){}}']]) })
  assert.equal(loop.ok, false)
  assert.equal(execFileSync('docker', [...prepared.args, 'ps', '-aq', '--filter', 'label=dsh-soul=probe'], { encoding: 'utf8', env: prepared.env }).trim(), '')
})

test('full evolution selects a JavaScript method using actual container outputs', { skip: !image }, async () => {
  const s = new Store(':memory:'), base = fixtureModel()
  const contract = suite({ runtime: 'javascript' })
  contract.cases.forEach(c => { c.invocation = JSON.parse(c.files['input.json']); c.files = {}; c.checks = [{ target: 'execution', kind: 'jsonEquals', expected: c.checks[0].expected }] })
  const generate = async r => {
    if (r.phase !== 'execute') return base.generate(r)
    const name = r.data.strategy.steps.join(' ')
    const code = `export default xs => ${name.includes('unique') ? '[...new Set(xs)]' : '[...xs]'}.sort(${name.includes('numeric') ? '(a,b)=>a-b' : ''})`
    return { actions: [{ type: 'write', path: 'solution.mjs', text: code }, { type: 'finish', answer: 'done' }] }
  }
  const e = new Evolution(s, generate, evolutionSettings({ evolution: true, evolutionProvider: 'fixture', evolutionModel: 'fixture', evolutionMaxRounds: 1,
    evolutionDockerImage: image, evolutionTimeoutMs: 180000 }))
  try {
    e.register('p', contract); const run = e.start('p', 'numbers', 's'); await e.running
    const result = e.inspect('p', run.id)
    assert.equal(result.state, 'awaiting_review', JSON.stringify(result))
    assert.equal(result.summary.validation.selected.passed, 2)
  } finally { await e.stop(); s.close() }
})
