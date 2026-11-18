import test from 'node:test'
import assert from 'node:assert/strict'
import { assessEvidence, callEvidence } from '../src/recall-evidence.js'
import { Store } from '../src/store.js'
import { recall, projectionText } from '../src/memory.js'

const q = 'src/a.js 的重试次数是多少？'
const claim = 'src/a.js 的重试次数设为 3。'
const source = { session:'one', seq:2 }
const hit = {claim,source,excerpt:claim,kind:'decision',state:'active'}

test('one source can support a simple setting; copies do not add independent evidence',()=>{
  const result=assessEvidence(q,[hit,{...hit}],[{...source,text:claim}]);assert.equal(result.status,'supported');assert.deepEqual(result.sources,[source])
  assert.equal(assessEvidence(q,[{...hit,excerpt:null}],[{...source,text:claim}]).value,'3')
  for(const change of [{excerpt:'src/b.js 的重试次数设为 3。'},{excerpt:'计划'+claim},{excerpt:'src/a.js 的重试次数设为 3 到 8。'},
    {contradictedBy:['later']},{supersededAt:42},{state:'stale'},{kind:'reference'},{source:null}]) {
    assert.equal(assessEvidence(q,[{...hit,...change}],[{...source,text:change.excerpt??claim}]).status,'insufficient')
  }
  assert.deepEqual(assessEvidence(q,[hit,{...hit,claim:claim.replace('3','4')}]).missing,['conflicting_values'])
  assert.equal(assessEvidence('为什么 '+q,[hit]).status,'insufficient')
})

test('a receipt proves only its own call: no adjacent, duplicated, or missing result accepted',()=>{
  const call={type:'tool/call',data:{callId:'job-1',name:'export'}}, receipt={type:'tool/result',data:{message:{toolCallId:'job-1',isError:false}}}
  const check=events=>callEvidence({id:'s',seq:events.length,eventAt:i=>events[i]},'callId=job-1 成功了吗')
  assert.equal(check([call,receipt]).outcome,'completed');assert.equal(check([call,receipt]).artifactVerified,false)
  assert.equal(check([call,{type:'tool/result',data:{message:{toolCallId:'job-1',isError:true}}}]).outcome,'error')
  for(const arr of [[call],[receipt,call],[call,call,receipt],[call,receipt,receipt],[call,{...receipt,data:{message:{toolCallId:'job-2',isError:false}}}]]) assert.equal(check(arr),null)
})

test('one hundred recall exposures do not reinforce a node or create a graph edge',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.evidenceRecall=true
  s.recordNodes('p',{nodes:[{id:'a',kind:'decision',claim},{id:'b',kind:'progress',claim:'src/a.js 已读'}]})
  for(let i=0;i<100;i++) assert.equal(recall(s,'p',q).links,0)
  assert.equal(s.nodeRow('a').hits,0);assert.equal(s.nodeRow('a').support,1);assert.equal(s.graphStats('p').edges,0)
})

test('card admission uses distinct tool-use turns, not search exposure; pins remain visible',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.cardAdmission=true
  s.recordNodes('p',{nodes:[{id:'n',kind:'progress',claim:'独特进度条目'}, {id:'pin',kind:'constraint',claim:'必须核实',pin:true}]})
  for(const turn of [1,1])s.activate('p',{node:'n',turn,source:'tool'})
  s.activate('p',{node:'n',turn:2,source:'recall'})
  for(const dynamics of [false,true]) {const c=projectionText(s,'p',600,{dynamics});assert.match(c,/必须核实/);assert.doesNotMatch(c,/独特进度/)}
  s.activate('p',{node:'n',turn:3,source:'tool'});assert.match(projectionText(s,'p'),/独特进度/)
})
