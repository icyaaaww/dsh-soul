import { entities, isInstance, terms, hash, redact } from './util.js'
import { rankedCandidates } from './graph-search.js'

const pointing = /^(?:刚才那个|这个文件|那它|它们|它|这个|那个|上一个|该文件|这份|那份)/u
const bare = /你要删什么|你要做什么|你在干什么|之前是多少|^(?:它|这|那)(?:个|份)?(?:呢|是什么|怎么样)?[？?。 ]*$/u
const words = text => terms(redact(text).replace(/(?:怎么填写|怎么写|写什么|填什么|是什么|是多少|请问|麻烦|之前|那个|这个|刚才|一下|呢|吗)/gu, ' '), 32)

export function singleObject(text) {
  const ids = entities(text).filter(isInstance)
  const unique = ids.filter(x => !ids.some(y => y !== x && y.endsWith('/' + x)))
  return unique.length === 1 ? unique[0] : null
}

export function prepareCues(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recall_cue(scope TEXT NOT NULL, signature TEXT NOT NULL,
    node TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE, tokens TEXT NOT NULL,
    stamp TEXT NOT NULL, PRIMARY KEY(scope,signature))`)
}

export function forgetCue(store, scope, phrase) {
  if (!store.adaptiveRecall) throw Error('memory.adaptiveRecall 未启用')
  return store.db.prepare('DELETE FROM recall_cue WHERE scope=? AND signature=?').run(scope,hash(words(phrase).sort().join('\0'))).changes
}

export function confirmCue(store, scope, id, phrase) {
  if (!store.adaptiveRecall) throw Error('memory.adaptiveRecall 未启用')
  const row = store.nodeRow(id), tokens = words(phrase).sort()
  if (!row || row.scope !== scope || row.valid_to != null || !['retired','active'].includes(row.state)) throw Error('需要当前项目内有效的节点')
  if (phrase.length > 240 || !tokens.length || pointing.test(phrase) || bare.test(phrase)) throw Error('问法须包含可独立辨认的主题')
  store.tx(() => {
    store.db.prepare('INSERT OR REPLACE INTO recall_cue(scope,signature,node,tokens,stamp) VALUES(?,?,?,?,?)')
      .run(scope,hash(tokens.join('\0')),id,JSON.stringify(tokens),hash(row.claim))
    store.db.prepare('DELETE FROM recall_cue WHERE scope=? AND rowid NOT IN (SELECT rowid FROM recall_cue WHERE scope=? ORDER BY rowid DESC LIMIT 128)').run(scope,scope)
  })
}

// Only supplemental candidates are returned. Do not activate or wire these automatically.
export function cueCandidates(store, scope, query, previous, limit, aliases = true) {
  if (!limit || !query || entities(query).some(isInstance)) return []
  if (pointing.test(query)) {
    if (!previous || bare.test(query)) return []
    const rest = query.replace(pointing,'').replace(/^的/u,'').replace(/(?:是多少|是什么|呢|吗)[？? ]*$/u,'').trim()
    if (!words(rest).length) return []
    return rankedCandidates(store,scope,`${previous} ${rest}`,limit).filter(n => n.valid_to == null && n.state !== 'stale').map(n => ({...n, via:'previous_object'}))
  }
  if (!aliases || bare.test(query)) return []
  const q = new Set(words(query)); if (!q.size) return []
  const matches = []
  for (const r of store.db.prepare('SELECT c.tokens,c.stamp,n.* FROM recall_cue c JOIN node n ON n.id=c.node AND n.scope=c.scope WHERE c.scope=? AND n.valid_to IS NULL AND n.state IN (\'active\',\'retired\')').all(scope)) {
    if (r.stamp !== hash(r.claim)) continue
    const tokens = JSON.parse(r.tokens), shared = tokens.filter(t => q.has(t)).length
    const score = shared/(tokens.length+q.size-shared)
    if (score===1 || (shared>=2 && score>=0.65)) matches.push({row:store.parseNode(r),score})
  }
  matches.sort((a,b) => b.score-a.score)
  if (!matches.length || matches.some(x => x.row.id!==matches[0].row.id && x.score===matches[0].score)) return []
  return [{...matches[0].row,via:'confirmed_phrase'}]
}
