// Controlled post-retrieval task. The correct request is supplied to every arm;
// the only question is which, if any, result belongs to its latest attempt.
import assert from 'node:assert/strict'

const names = ['校对译稿','导出母版','复核色样','更新索引','合并字幕','同步清单','生成预览','归档底稿','检查音轨','编译页面','刷新快照','备份素材']
const variants = ['same_turn','next_turn','interleaved','planned_only','failed','retry_pending','missing_link','late_old_response']
function fixture(name, i, variant) {
  const target=`req${i}`, other=`other${i}`, call=`call${i}`, foreign=`side${i}`
  const rows=[]
  const add=(type,turn,data)=>{const row={id:rows.length,type,turn,...data};rows.push(row);return row.id}
  const start=add('request',1,{req:target,text:name})
  add('request',1,{req:other,text:`${name}的另一个版本`})
  const action=(turn,req,callId)=>add('action',turn,{req,callId})
  const receipt=(turn,callId,ok=true)=>add('receipt',turn,{callId,ok,text:ok?'产物已生成':'操作失败'})
  let gold=null
  if(variant==='planned_only'){action(1,other,foreign);receipt(1,foreign)}
  else {
    action(1,target,call)
    if(variant==='same_turn') gold=receipt(1,call)
    if(variant==='next_turn') gold=receipt(2,call)
    if(variant==='interleaved'){gold=receipt(1,call);action(1,other,foreign);receipt(1,foreign)}
    if(variant==='failed'){receipt(1,call,false);action(1,other,foreign);receipt(2,foreign)}
    if(variant==='retry_pending'){receipt(1,call);action(2,target,call+'b')}
    if(variant==='missing_link') gold=receipt(1,null)
    if(variant==='late_old_response'){action(2,target,call+'b');gold=receipt(2,call+'b');receipt(2,call)}
  }
  // Gold is assigned by the generator, never made available to retrieval.
  return {start,rows,gold}
}
function choose(arm,{start,rows}) {
  const seed=rows[start], actions=rows.filter(r=>r.type==='action' && r.req===seed.req)
  const receipts=rows.filter(r=>r.type==='receipt'&&r.ok)
  if(arm==='node_only') return null // the supplied request carries no execution result
  if(arm==='window') return receipts.filter(r=>Math.abs(r.turn-seed.turn)<=1).at(-1)?.id??null
  if(arm==='same_turn') return receipts.filter(r=>r.turn===seed.turn).at(-1)?.id??null
  const last=actions.at(-1)
  return last ? receipts.filter(r=>r.callId===last.callId && r.id>last.id).at(-1)?.id??null : null
}
const report={}
for(const arm of ['node_only','window','same_turn','call_link']){
  const summary={hits:0,positive:0,abstain:0,negative:0,wrongReceipt:0,byVariant:{}}
  for(const variant of variants){let correct=0
    names.forEach((name,i)=>{const f=fixture(name,i,variant),out=choose(arm,f),ok=out===f.gold
      if(f.gold==null){summary.negative++;if(ok)summary.abstain++}else{summary.positive++;if(ok)summary.hits++}
      if(out!==null&&!ok)summary.wrongReceipt++
      if(ok)correct++
    });summary.byVariant[variant]=correct
  }
  assert.equal(summary.positive+summary.negative,names.length*variants.length)
  report[arm]=summary
}
console.log(JSON.stringify({unit:'post-retrieval receipt attribution, known request',tasks:names.length,variants,report},null,2))
