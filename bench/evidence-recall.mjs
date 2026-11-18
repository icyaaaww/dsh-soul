import { performance } from 'node:perf_hooks'
import { apply } from '../index.js'
import { projectScope } from '../src/util.js'

// Warm, in-memory tool calls. No answer model; counts concern the tool's evidence verdict.
async function run(enabled) {
  const tools=[], noop={register:()=>()=>{}}
  const h=apply({tools:{register:t=>{tools.push(t);return ()=>{}}},commands:noop,
    systemPrompt:{context:()=>()=>{}},on:()=>()=>{},get:()=>undefined},
  {database:':memory:',memory:{evidenceRecall:enabled}})
  try {
    const tool=tools.find(t=>t.name==='soul_recall'), session=id=>({id,header:{cwd:process.cwd()},seq:0}),scope=projectScope(session('seed'))
    const requests=[]
    for(let i=0;i<30;i++) {
      const obj=`src/job${i}.js`,claim=`${obj} 的重试次数设为 ${i+1}。`
      h.store.recordNodes(scope,{nodes:[{id:`n${i}`,kind:'decision',claim,session:'seed',seq:i},
        {id:`p${i}`,kind:'progress',claim:`已检查 ${obj}`}]})
      h.store.putSpans(scope,'seed',[{seq:i,text:claim,kind:'user/message',hash:`sample${i}`}])
      requests.push([`${obj} 的重试次数是多少？`,String(i+1)],[`${obj} 的分页大小是多少？`,null])
    }
    const ms=[],result={queries:requests.length,searches:0,supportedCorrect:0,unsupportedMarkedSupported:0,unknown:0,unclassified:0}
    for(const [i,[query,gold]] of requests.entries()) {
      const start=performance.now(); const r=JSON.parse((await tool.execute({query},{agent:{session:session(`q${i}`)}})).text)
      ms.push(performance.now()-start);if(r.indexed)result.searches++
      if(!r.evidence)result.unclassified++
      else if(r.evidence.status==='supported'){if(r.evidence.value===gold)result.supportedCorrect++;else result.unsupportedMarkedSupported++}
      else if(gold===null&&r.evidence.status==='insufficient')result.unknown++
    }
    ms.sort((a,b)=>a-b);return {...result,p95ms:+ms[Math.ceil(ms.length*.95)-1].toFixed(2)}
  } finally {await h.stop()}
}
console.log(JSON.stringify({legacy:await run(false),evidence:await run(true)},null,2))
