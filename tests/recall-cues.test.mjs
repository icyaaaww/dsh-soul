import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { recall } from '../src/memory.js'
import { singleObject, confirmCue, forgetCue } from '../src/recall-cues.js'
import { scenario } from '../bench/recall-cues.mjs'

test('chronological ablation isolates context, confirmation and expiry', () => {
  const r=scenario()
  assert.deepEqual(r.first,{strict:false,previous:false,confirmed:false})
  assert.deepEqual(r.repeat,{strict:false,previous:false,confirmed:true})
  assert.deepEqual(r.followup,{strict:false,previous:true,confirmed:true})
  for(const k of ['unknown_attribute','switched','obsolete']) assert.equal(r[k].confirmed,true,k)
})

test('confirmed cues are read-only, revocable, scoped and tied to the exact claim', t => {
  const s = new Store(':memory:',{adaptiveRecall:true}); t.after(()=>s.close())
  const put = claim => s.recordNodes('p',{nodes:[{id:'n',claim,kind:'decision'}]})
  put('NOB 的废墟教堂'); const phrase='场景借用写什么'
  assert.throws(()=>confirmCue(s,'p','n','你要删什么'))
  assert.throws(()=>confirmCue(s,'other','n',phrase))
  confirmCue(s,'p','n',phrase)
  assert.equal(recall(s,'p',phrase).hits[0].via,'confirmed_phrase')
  assert.equal(s.nodeRow('n').hits,0)
  assert.equal(recall(s,'other',phrase).hits.length,0)
  assert.equal(forgetCue(s,'p',phrase),1); assert.equal(recall(s,'p',phrase).hits.length,0)
  confirmCue(s,'p','n',phrase); put('新作者的新作品'); assert.equal(recall(s,'p',phrase).hits.length,0)
  assert.equal(singleObject('检查 src/a.js 和 src/b.js'),null)
  assert.equal(singleObject('检查 src/a.js'),'src/a.js')
})
