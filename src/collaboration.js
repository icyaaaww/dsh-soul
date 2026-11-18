import { hash } from './util.js'

// Prompt text comes exclusively from this vocabulary, never from stored user text.
const styles = new Map([
  ['brief', ['length','简短回答']], ['detailed',['length','展开说明']],
  ['conclusion',['order','先给结论，再讲依据']], ['evidence',['order','先列证据，再给结论']],
  ['options',['approach','列出可行选项与取舍']], ['recommend',['approach','给出一个明确建议并说明取舍']],
])
const roles = new Map([['any',''],['review','评审：区分证据、取舍和未知。'],['build','实现：报告实际改动与验证结果。']])
const roleOf = text => /评审|架构|比较方案/.test(text) ? 'review' : /实现|改代码|修复|写测试|落地/.test(text) ? 'build' : 'any'
const phrases = new Map([
  ['brief', /^(?:简短(?:一点|点|回答)?|简单(?:一点|点)|一句话(?:回答)?)$/],
  ['detailed',/^(?:详细(?:一点|点|说明|回答)?|展开(?:讲|说明)?)$/],
  ['conclusion',/^先给(?:我)?(?:最终)?(?:结论|建议)(?:再(?:讲|说|给)(?:依据|证据|数据))?$/],
  ['evidence',/^先(?:讲|列|给)证据(?:再给结论)?$/], ['options',/^列出(?:多个)?(?:选项|方案)$/], ['recommend',/^给(?:我)?一个明确建议$/],
])
export function preferenceOf(text) {
  const input=String(text).trim().replace(/[，、,。！!\s]/gu,'')
  const feedback = new Map([['太长了','brief'],['太啰嗦了','brief'],['细节不够','detailed'],['请直接说结论','conclusion']]).get(input)
  if(feedback)return {range:'turn',role:'any',value:feedback,revoke:false,feedback:true}
  const m=/^(这次|本轮|以后|今后)(所有项目|跨项目|这个项目|本项目)?(?:(?:在|讨论)?(架构评审|架构|评审|实现|开发)(?:时)?)?(?:都)?(.+)$/.exec(input)
  if (!m) return null
  const revoke=/^(?:取消|不再|别再)(.+)$/.exec(m[4])
  for(const [value,re] of phrases) if(re.test(revoke?.[1]??m[4])) return {
    range:['这次','本轮'].includes(m[1])?'turn':/所有项目|跨项目/.test(m[2]??'')?'global':'project',role:m[3]?roleOf(m[3]==='开发'?'实现':m[3]):'any',value,revoke:!!revoke,
  }
  return null
}

export class Collaboration {
  constructor(store,profile) {
    this.store=store; this.db=store.db; this.profile=profile; this.sessions=new Map()
    this.db.exec(`CREATE TABLE IF NOT EXISTS collab_rule(
      profile TEXT, scope TEXT, role TEXT, dimension TEXT, value TEXT, active INTEGER, source TEXT, via TEXT, updated INTEGER,
      PRIMARY KEY(profile,scope,role,dimension));
      CREATE TABLE IF NOT EXISTS collab_signal(profile TEXT,scope TEXT,role TEXT,value TEXT,session_key TEXT,
        source TEXT, PRIMARY KEY(profile,scope,role,value,session_key));
      CREATE TABLE IF NOT EXISTS collab_event(profile TEXT,scope TEXT,role TEXT,dimension TEXT,value TEXT,action TEXT,source TEXT,at INTEGER,
        PRIMARY KEY(profile,scope,source,role,dimension));
      CREATE TABLE IF NOT EXISTS collab_basis(profile TEXT,scope TEXT,decision TEXT,observation TEXT,
        PRIMARY KEY(profile,scope,decision,observation));`)
  }
  session(sid,scope) {
    if(this.sessions.get(sid)?.scope!==scope) this.sessions.set(sid,{scope,role:'any',temp:new Map(),seen:new Set()})
    return this.sessions.get(sid)
  }
  end(sid) { this.sessions.delete(sid) }
  applyRule(scope,role,value,revoke,source,via) {
    const [dim]=styles.get(value); const at=this.store.now()
    return this.store.tx(()=>{
      const prior=this.db.prepare('SELECT value,active FROM collab_rule WHERE profile=? AND scope=? AND role=? AND dimension=?').get(this.profile,scope,role,dim)
      if(revoke && prior?.active && prior.value!==value) throw Error('当前规则不同；请用 /mem style 查看后撤销。')
      const event=this.db.prepare('INSERT OR IGNORE INTO collab_event VALUES(?,?,?,?,?,?,?,?)').run(this.profile,scope,role,dim,value,revoke?'revoke':'set',source,at)
      if(!event.changes) return
      if(via==='confirmed_pattern') this.db.prepare(`INSERT OR IGNORE INTO collab_basis SELECT profile,scope,?,source FROM collab_signal
        WHERE profile=? AND scope=? AND role=? AND value=?`).run(source,this.profile,scope,role,value)
      this.db.prepare('INSERT OR REPLACE INTO collab_rule VALUES(?,?,?,?,?,?,?,?,?)').run(this.profile,scope,role,dim,value,revoke?0:1,source,via,at)
      this.db.prepare('DELETE FROM collab_signal WHERE profile=? AND scope=? AND role=? AND value=?').run(this.profile,scope,role,value)
    })
  }
  observe(scope,sid,text,source) {
    const state=this.session(sid,scope), rule=preferenceOf(text)
    if(!rule){const task=roleOf(text); if(task!=='any')state.role=task;return false}
    if(state.seen.has(source))return true
    state.seen.add(source)
    if(rule.role!=='any')state.role=rule.role
    const dim=styles.get(rule.value)[0]
    if(rule.range==='turn') {
      const role=rule.role==='any'?state.role:rule.role
      state.temp.set(dim,{value:rule.value,source,role,active:!rule.revoke,via:'this_turn'})
      if(!rule.revoke)this.db.prepare('INSERT OR IGNORE INTO collab_signal VALUES(?,?,?,?,?,?)').run(this.profile,scope,role,rule.value,hash(sid),source)
    } else this.applyRule(rule.range==='global'?'*':scope,rule.role,rule.value,rule.revoke,source,'explicit')
    return true
  }
  suggestions(scope) {
    const rows=this.db.prepare(`SELECT s.role,s.value,count(*) independentSessions FROM collab_signal s
      WHERE profile=? AND scope=? AND NOT EXISTS (SELECT 1 FROM collab_rule r WHERE r.profile=s.profile AND r.scope=s.scope AND r.role=s.role AND r.value=s.value)
      GROUP BY role,value ORDER BY role,value`).all(this.profile,scope)
    return rows.filter(r=>r.independentSessions>=3 && !rows.some(other=>other.role===r.role && other.value!==r.value &&
      styles.get(other.value)[0]===styles.get(r.value)[0] && other.independentSessions>=r.independentSessions))
  }
  explain(scope,sid) {
    const state=this.session(sid,scope), effective=new Map()
    const saved=this.db.prepare(`SELECT scope,role,dimension,value,active,source,via,updated FROM collab_rule WHERE profile=? AND scope IN ('*',?) ORDER BY (scope='*') DESC,(role='any') DESC,role,dimension`).all(this.profile,scope)
    for(const r of saved)if(r.active && (r.role==='any'||r.role===state.role))effective.set(r.dimension,r)
    for(const [dim,r] of state.temp)if(r.role==='any'||r.role===state.role){if(r.active)effective.set(dim,r);else effective.delete(dim)}
    return {role:state.role, effective:[...effective.values()],saved}
  }
  render(scope,sid) {
    const {role,effective}=this.explain(scope,sid)
    const lines=[roles.get(role),...effective.map(r=>styles.get(r.value)[1])].filter(Boolean)
    return lines.length?'[协作方式，仅在本轮未另行要求时采用] '+lines.join('；')+'。证据不足就说明未知；不改变权限或预算。':''
  }
  command(scope,sid,args,source) {
    if(!args.length||args[0]==='show') return {...this.explain(scope,sid),suggested:this.suggestions(scope)}
    if(args[0]==='history')return this.db.prepare(`SELECT e.scope,e.role,e.dimension,e.value,e.action,e.source,e.at,
      (SELECT count(*) FROM collab_basis b WHERE b.profile=e.profile AND b.scope=e.scope AND b.decision=e.source) AS priorObservations
      FROM collab_event e WHERE profile=? AND scope IN ('*',?) ORDER BY at DESC,rowid DESC LIMIT 20`).all(this.profile,scope)
    const global=args[0]==='global'; if(global)args=args.slice(1)
    const [op,role,value]=args
    if(args.length!==3||!['set','accept','revoke'].includes(op)||!roles.has(role)||!styles.has(value))throw Error('用法：/mem style set|accept|revoke any|review|build brief|detailed|conclusion|evidence|options|recommend')
    if(op==='accept'&&(global||!this.suggestions(scope).some(r=>r.role===role&&r.value===value)))throw Error('没有对应的已归纳候选')
    this.applyRule(global?'*':scope,role,value,op==='revoke',source,op==='accept'?'confirmed_pattern':'explicit')
    return this.explain(scope,sid)
  }
}
