import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runComponent, skillOf, createComponents } from '../src/components.js'
import { lint } from '../src/tree.js'
import { edit } from '../src/edit.js'
import { defaults } from './fixture.mjs'

const skill = '---\nname: build-check\ndescription: 构建失败时检查依赖及命令\n---\n先检查依赖，再运行构建。'
const hook = 'export const timeoutMs = 100; export const failOpen = true; export function run(x) { return {note:x.isError ? "停止重复失败" : "检查产物"} }'
test('candidate components survive host cwd canonicalization through directory aliases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'soul-component-alias-'))
  const target = join(root, 'checkout'), alias = join(root, 'alias')
  mkdirSync(target)
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const runtime = createComponents({ tools: { register: () => () => {} }, on: () => () => {} }, { current: () => null })
  try {
    const files = { 'skills/build-check/SKILL.md': skill }
    const release = runtime.lease(alias, files)
    assert.equal(runtime.filesAt(realpathSync.native(target)), files)
    assert.throws(() => runtime.lease(target, {}), /component_lease_busy/)
    release()
    assert.equal(runtime.filesAt(target), null)
  } finally {
    await runtime.stop()
    rmSync(alias)
    rmSync(root, { recursive: true, force: true })
  }
})
test('editor can create a valid skill, script and hook in an initially empty component', async () => {
  for (const [target,path,text] of [['C6','skills/build-check/SKILL.md',skill],['C7','scripts/sum.mjs','export function run(x) { return x.a+x.b }'],['C8','hooks/check.mjs',hook]]) {
    const result = await edit({generate:async()=>({actions:[{type:'write',path:'harness/'+path,text},{type:'finish',why:'test'}]}),context:{target,files:defaults(),task:'x',evidence:[]},signal:new AbortController().signal})
    assert.equal(result.files[path],text)
    assert.deepEqual(lint(path,text),[])
  }
  assert.throws(()=>skillOf('skills/x/SKILL.md',skill),/invalid_skill_metadata/)
  assert(lint('skills/main.mjs','anything').length)
})
test('scripts run real JSON transforms without access to process, imports or dynamic code', async () => {
  assert.deepEqual(await runComponent('export function run(x) { return [...new Set(x)].sort() }',[3,1,3]),[1,3])
  for(const source of ['export function run(){return process.env}', 'import fs from "node:fs"; export function run(){return 1}', 'export function run(){return Function("return process")()}']) {
    await assert.rejects(()=>runComponent(source,{}))
  }
  await assert.rejects(()=>runComponent('export function run(){for(;;){}}',{}, {timeoutMs:700}))
  await assert.rejects(()=>runComponent('export function run(){return "a".repeat(30000)}',{}))
})
test('hooks execute their contract; cancellation and endless async work settle', async () => {
  assert.equal((await runComponent(hook,{isError:true},{kind:'hook'})).note,'停止重复失败')
  await assert.rejects(()=>runComponent('export function run(){return {note:"bad"}}',{}, {kind:'hook'}))
  await assert.rejects(()=>runComponent('export const failOpen=true;export const timeoutMs=10;export function run(){return new Promise(()=>{})}',{}, {kind:'hook'}))
  const controller = new AbortController()
  const promise = runComponent('export function run(){return new Promise(()=>{})}',{}, {signal:controller.signal})
  controller.abort(new Error('cancelled'))
  await assert.rejects(()=>promise,/cancelled/)
})
test('component leases, provider invalidation and rollback change actual loads without stale catalog entries', async () => {
  let files = {'skills/build-check/SKILL.md':skill,'scripts/sum.mjs':'export function run(x){return x.a+x.b}', 'hooks/check.mjs':hook}
  let provider, invalidations=0
  const tools = new Map(), handlers = new Map()
  const ctx={get:n=>n==='skills'?{registerProvider:fn=>{provider=fn({invalidate:()=>invalidations++});return()=>{provider=null}}}:undefined,
    tools:{register:t=>{tools.set(t.name,t);return()=>tools.delete(t.name)}},on:(n,fn)=>{handlers.set(n,fn);return()=>handlers.delete(n)}}
  const runtime=createComponents(ctx,{current:()=>({files})})
  try {
    const cwd=process.cwd(), exec={agent:{session:{header:{cwd}}},signal:new AbortController().signal,name:'test_tool'}
    const entries=await provider.list({cwd})
    assert.equal((await provider.get(entries[0],{cwd})).content,'先检查依赖，再运行构建。')
    const release=runtime.lease(cwd,{})
    assert.deepEqual(await provider.list({cwd}),[])
    release()
    assert.equal((await provider.list({cwd})).length,1)
    const output=await tools.get('evolve_script').execute({name:'sum',input:'{"a":2,"b":3}'},exec)
    assert.equal(JSON.parse(output.text),5)
    const result={isError:true,content:[{type:'text',text:'original failure'}]}
    const post=handlers.get('tools/post-execute')
    const decision=await post(exec,result,async()=>({kind:'accept'}))
    assert.equal(decision.content[0].text,'original failure')
    assert.match(decision.content[1].text,/停止重复失败/)
    assert.deepEqual(await post(exec,result,async()=>({kind:'block',feedback:[]})),{kind:'block',feedback:[]})
    files={};runtime.invalidate()
    assert.equal(await provider.get(entries[0],{cwd}),undefined)
    await assert.rejects(()=>tools.get('evolve_script').execute({name:'sum',input:'{}'},exec),/script_not_found/)
    assert.deepEqual(await post(exec,result,async()=>({kind:'accept'})),{kind:'accept'})
    assert(invalidations>=3)
  } finally {runtime.stop()}
  assert.equal(tools.size,0)
})
