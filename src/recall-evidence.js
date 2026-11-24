import { entities, isInstance } from './util.js'

// Deliberately narrow: this is an early-stop proof for simple scalar questions,
// not a general-purpose judge. Other questions still get one raw-span lookup.
const attributes = /连接池上限|超时(?:时间|秒数)?|重试次数|缓存容量|并发数|队列长度|分页大小|心跳间隔|快照周期/gu
const statusQuestion = /(?:成功了吗|成功了没|完成了吗|是否.{0,8}(?:成功|完成)|执行结果|did .{0,40}succeed)/i
const unverified = /[？?]|可能|预计|计划|建议|假设|不要|不再|并非|不是|尚未|未确认|如果|拟定|据说|示例|草案|错误|不正确|作废|取消|以前|曾经|过去|原先|原来/u
const refKey = ({session,seq}) => JSON.stringify([session,seq])
const originalRequest = /原文|原始(?:文本|资料|材料|来源|记录|文档|证据)|出处|引文|引用原文|查(?:看|找|一下)?原文|核对(?:原文|来源)|\b(?:original(?:\s+(?:text|source|document|record))?|verbatim|citation|quoted?)\b/iu

export const requestsOriginalEvidence = query => originalRequest.test(String(query ?? ''))


export function assessEvidence(query, hits, spans = []) {
  const missing = (...gaps) => ({status:'insufficient', missing:gaps, sources:[]})
  if (statusQuestion.test(query)) return missing('matched_call_result')
  if (/之前|曾经|当时|过去|历史|原来/.test(query)) return missing('historical_version')
  if (/为什么|为何|原因|如何|怎么|相比|比较|是不是|是否/.test(query)) return missing('question_requires_review')
  const ids = entities(query).filter(isInstance)
  const objects = ids.filter(x=>!ids.some(y=>y!==x && y.endsWith('/'+x)))
  const attrs = [...new Set(query.match(attributes) ?? [])]
  if (objects.length!==1 || attrs.length!==1) return missing(...[...(objects.length!==1?['unambiguous_object']:[]),...(attrs.length!==1?['specific_attribute']:[])])
  const [obj]=objects,[attr]=attrs
  const number = new RegExp(`${attr}\\s*(?:定为|设为|设置为|为|是|[:：=])\\s*(\\d+(?:\\.\\d+)?(?:\\s*(?:毫秒|秒|分钟|天|次|MB|GB|ms|%))?)\\s*$`, 'iu')
  const values = text => new Set(String(text??'').split(/[。；;\n]/u).flatMap(sentence=>{
    if (unverified.test(sentence)||!entities(sentence).includes(obj)) return []
    const ids = entities(sentence).filter(isInstance).filter(x=>!/^\d+(?:\.\d+)?$/.test(x))
    if(ids.some(x=>x!==obj&&!obj.endsWith('/'+x)&&!x.endsWith('/'+obj))) return []
    const value=number.exec(sentence)?.[1]; return value?[value.replace(/\s+/g,'').toLowerCase()]:[]
  }))
  const excerpts = new Map(spans.map(s=>[refKey(s),s.text])), supported = new Map(), claims = new Set()
  for (const h of hits) {
    if (!['decision','constraint'].includes(h.kind)||h.supersededAt!=null||h.state==='stale'||h.contradictedBy?.length) continue
    for(const value of values(h.claim)) {
      claims.add(value)
      if (!h.source?.session||!Number.isInteger(h.source.seq)||h.source.seq<0) continue
      const key=refKey(h.source), original=excerpts.get(key)
      const observed=values(original)
      if(observed.size>1) return missing('conflicting_values')
      if(observed.has(value)) supported.set(key,{session:h.source.session,seq:h.source.seq})
    }
  }
  if(claims.size>1) return missing('conflicting_values')
  if(!supported.size) return missing('current_claim_and_matching_source')
  return {status:'supported', object:obj, attribute:attr, value:[...claims][0], sources:[...supported.values()], missing:[]}
}

// Only resolve calls the question identifies explicitly, within this session. A
// successful tool call is never a claim that a deliverable passed acceptance.
export function callEvidence(session, query) {
  const id=/\bcallId\s*[:=]\s*([\w.-]{1,128})(?![\w.-])/i.exec(query)?.[1]
  if(!id||typeof session?.eventAt!=='function'||!Number.isSafeInteger(session.seq)||session.seq>4000) return null
  let call, receipt
  for(let seq=0;seq<session.seq;seq++) {
    const e=session.eventAt(seq),d=e?.data
    if(e?.type==='tool/call'&&d?.callId===id) { if(call) return null; call={seq,name:d.name} }
    if(e?.type==='tool/result'&&d?.message?.toolCallId===id) {
      if(!call||receipt||typeof d.message.isError!=='boolean') return null
      receipt={seq,error:d.message.isError}
    }
  }
  return call&&receipt?{status:'call_result',callId:id,tool:call.name,outcome:receipt.error?'error':'completed',artifactVerified:false,
    sources:[call,receipt].map(r=>({session:String(session.id),seq:r.seq})),missing:[]}:null
}
