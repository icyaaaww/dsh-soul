import { pathToFileURL } from 'node:url'
import { Store } from '../src/store.js'
import { rankedCandidates } from '../src/graph-search.js'
import { confirmCue, cueCandidates, singleObject } from '../src/recall-cues.js'

export function compareCues(store, scope, text, previous, gold) {
  const direct = rankedCandidates(store, scope, text, 6)
  const score = rows => gold.length ? rows.slice(0,3).some(r => gold.includes(r.id)) : !rows.length
  const merge = cues => [...cues, ...direct.filter(r => !cues.some(c => c.id === r.id))]
  return { strict: score(direct), previous: score(merge(cueCandidates(store,scope,text,previous,6,false))),
    confirmed: score(merge(cueCandidates(store,scope,text,previous,6))) }
}

export function scenario() {
  const s = new Store(':memory:', { adaptiveRecall:true }), results = {}
  const ask = (name,text,previous,gold) => { results[name] = compareCues(s,'p',text,singleObject(previous),gold) }
  try {
    s.recordNodes('p',{nodes:[{id:'credits',kind:'decision',claim:'NOB 的废墟教堂'},
      {id:'timeout',kind:'decision',claim:'src/worker.js 超时 17 秒'}]})
    ask('first','场景借用写什么','',['credits'])
    confirmCue(s,'p','credits','场景借用写什么')
    ask('repeat','请问场景借用怎么写','',['credits'])
    ask('followup','它的超时是多少','检查 src/worker.js',['timeout'])
    ask('unknown_attribute','它的分页上限是多少','检查 src/worker.js',[])
    ask('switched','这个文件的采样率是多少','检查 src/audio.js',[])
    s.supersede('credits')
    ask('obsolete','场景借用怎么写','',[])
    return results
  } finally { s.close() }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(scenario(),null,2))
