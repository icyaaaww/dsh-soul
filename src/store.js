import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { clean, day, hash, id, terms } from './util.js'
import { card, MEMORY_HEADER } from './cards.js'
import { Experience, EXPERIENCE_SCHEMA } from './experience.js'
import { EVOLUTION_SCHEMA } from './evolution-schema.js'

const kinds = new Set(['preference', 'fact', 'episode', 'skill'])
const states = new Set(['candidate', 'trial', 'active', 'deprecated'])

export class Store {
  constructor(path, { now = Date.now } = {}) {
    this.now = now
    this.cache = new Map()
    this.pendingMetrics = new Map()
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;`)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > 4) { this.db.close(); throw new Error('记忆库版本高于插件支持版本') }
    try { this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('epoch','0');
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, session TEXT NOT NULL, scope TEXT NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS event_session ON events(session,created);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL, created INTEGER NOT NULL,
        updated INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, supersedes TEXT, origin TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope,status,kind);
      CREATE INDEX IF NOT EXISTS memory_fingerprint ON memories(fingerprint);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, tokens);
      CREATE TABLE IF NOT EXISTS sources(memory TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        event TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, PRIMARY KEY(memory,event));
      CREATE TABLE IF NOT EXISTS links(parent TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        child TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, PRIMARY KEY(parent,child));
      CREATE TABLE IF NOT EXISTS tombstones(key TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback(memory TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        trial TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(memory,trial));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, scope TEXT NOT NULL,
        event_ids TEXT NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL, created INTEGER NOT NULL,
        epoch INTEGER NOT NULL, owner TEXT, lease INTEGER, outcome TEXT);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,priority,created);
      CREATE TABLE IF NOT EXISTS queued_sources(event TEXT PRIMARY KEY, job TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, job TEXT NOT NULL, day TEXT NOT NULL,
        reserved_input INTEGER NOT NULL, reserved_output INTEGER NOT NULL,
        usage TEXT, outcome TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_day ON calls(day);
      CREATE TABLE IF NOT EXISTS metrics(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('retrieval_revision','0');
      CREATE TRIGGER IF NOT EXISTS memory_insert_revision AFTER INSERT ON memories BEGIN
        UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='retrieval_revision'; END;
      CREATE TRIGGER IF NOT EXISTS memory_update_revision AFTER UPDATE ON memories BEGIN
        UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='retrieval_revision'; END;
      CREATE TRIGGER IF NOT EXISTS memory_delete_revision AFTER DELETE ON memories BEGIN
        UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='retrieval_revision'; END;
      ${EXPERIENCE_SCHEMA}
      ${EVOLUTION_SCHEMA}
      PRAGMA user_version=4;
      COMMIT;
    `) } catch (error) { this.db.close(); throw error }
    this.revisionQuery = this.db.prepare("SELECT value FROM meta WHERE key='retrieval_revision'")
    this.experience = new Experience(this)
  }
  close() { try { this.experience.interrupt(); this.flushMetrics() } finally { this.cache.clear(); this.db.close() } }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  epoch() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get().value) }
  bump() { this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='epoch'").run() }
  metric(key, amount = 1) {
    this.db.prepare('INSERT INTO metrics VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value').run(key, amount)
  }
  count(key, amount = 1) { this.pendingMetrics.set(key, (this.pendingMetrics.get(key) ?? 0) + amount) }
  flushMetrics() {
    if (!this.pendingMetrics.size) return
    this.tx(() => { for (const [key, amount] of this.pendingMetrics) this.metric(key, amount) })
    this.pendingMetrics.clear()
  }
  capture({ eventId, session, scope, role, text, priority = 0 }) {
    if (!['user', 'assistant', 'tool', 'command'].includes(role)) throw new Error('无效来源')
    const eventKey = hash(`${session}:${eventId}`)
    if (this.blocked(`event:${eventKey}`)) return null
    const value = clean(text, 4000)
    this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?)')
      .run(eventKey, session, scope, role, value, this.now(), priority)
    return eventKey
  }
  blocked(key) { return !!this.db.prepare('SELECT 1 FROM tombstones WHERE key=?').get(key) }
  event(key) { return this.db.prepare('SELECT * FROM events WHERE id=?').get(key) }
  get(key, scope) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id=? AND (scope=? OR scope='profile')").get(key, scope)
    if (!row) return null
    return { ...row, sources: this.db.prepare('SELECT event FROM sources WHERE memory=?').all(key).map(x => x.event),
      feedback: this.db.prepare('SELECT * FROM feedback WHERE memory=? ORDER BY created').all(key),
      ...(row.kind === 'skill' ? { performance: this.experience.summary(key), trials: this.experience.history(scope, key),
        verification: this.db.prepare('SELECT suite,run,state FROM evo_versions WHERE memory=?').get(key) ?? null } : {}) }
  }
  add({ scope, kind, text, sourceIds, origin = 'model', active = false, parentIds = [], supersedes = null }) {
    if (!kinds.has(kind) || !scope) throw new Error('记忆类型或范围无效')
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 12) throw new Error('记忆必须引用来源')
    text = clean(text, kind === 'skill' ? 3200 : 1800)
    const fingerprint = hash(`${scope}:${kind}:${text.normalize('NFKC')}`)
    if (this.blocked(`memory:${fingerprint}`) && origin !== 'human') throw new Error('此内容已经遗忘，拒绝重新生成')
    for (const source of sourceIds) {
      const e = this.event(source)
      if (!e || (e.scope !== scope && !(scope === 'profile' && origin === 'human')))
        throw new Error('来源缺失或越过记忆范围')
      if (active && (origin !== 'human' || e.role !== 'command')) throw new Error('自动提取不能直接激活')
      if (origin === 'human' && e.role !== 'command') throw new Error('人工记忆必须来自明确命令')
    }
    // A lesson derived from observed skill use remains dependent on that skill.
    parentIds = [...new Set([...parentIds, ...sourceIds.flatMap(source => this.db.prepare(`
      SELECT DISTINCT t.memory FROM trials t JOIN run_sources rs ON rs.run=t.run WHERE rs.event=?`).all(source).map(r => r.memory))])]
    for (const parent of parentIds) {
      const row = this.get(parent, scope)
      if (!row || row.status === 'deprecated') throw new Error('派生记忆的父来源无效')
    }
    const old = supersedes ? null : this.db.prepare('SELECT id FROM memories WHERE fingerprint=? AND status!=?').get(fingerprint, 'deprecated')
    if (old) {
      for (const source of sourceIds) this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(old.id, source)
      for (const parent of parentIds) if (parent !== old.id) this.db.prepare('INSERT OR IGNORE INTO links VALUES (?,?)').run(parent, old.id)
      if (active && kind !== 'skill') this.db.prepare("UPDATE memories SET status='active',origin='human',updated=? WHERE id=?").run(this.now(), old.id)
      return old.id
    }
    if (this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status!='deprecated'").get().n >= 10000)
      throw new Error('有效及候选记忆已达 10000 条上限，请先整理或遗忘')
    const key = id(), now = this.now()
    this.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(key, scope, kind, text, active && kind !== 'skill' ? 'active' : 'candidate', fingerprint, now, now, 1, supersedes, origin)
    this.db.prepare('INSERT INTO search VALUES (?,?)').run(key, terms(text).join(' '))
    for (const source of sourceIds) this.db.prepare('INSERT INTO sources VALUES (?,?)').run(key, source)
    for (const parent of parentIds) this.db.prepare('INSERT INTO links VALUES (?,?)').run(parent, key)
    return key
  }
  remember(scope, kind, text, session) {
    return this.tx(() => {
      const source = this.capture({ eventId: id(), session, scope, role: 'command', text })
      return this.add({ scope, kind, text, sourceIds: [source], origin: 'human', active: true })
    })
  }
  search(scope, query = '', { status = 'active', limit = 6 } = {}) {
    if (!states.has(status)) throw new Error('状态无效')
    limit = Math.max(1, Math.min(30, Number(limit) || 6))
    const tokens = terms(query).slice(0, 24)
    if (!tokens.length) return this.db.prepare(`SELECT * FROM memories WHERE (scope=? OR scope='profile')
      AND status=? ORDER BY updated DESC,id LIMIT ?`).all(scope, status, limit)
    const match = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ')
    return this.db.prepare(`SELECT m.* FROM search JOIN memories m ON m.id=search.id
      WHERE search MATCH ? AND (m.scope=? OR m.scope='profile') AND m.status=?
      ORDER BY bm25(search),m.updated DESC,m.id LIMIT ?`).all(match, scope, status, limit)
  }
  discover(scope, query, { includeTrials = true, limit = 6 } = {}) {
    const active = this.experience.rank(this.search(scope, query, { limit: Math.min(30, limit * 3) }), query).slice(0, limit)
    const hasTrials = includeTrials && query.trim() && this.db.prepare("SELECT 1 FROM memories WHERE (scope=? OR scope='profile') AND status='trial' AND kind='skill' LIMIT 1").get(scope)
    const trials = hasTrials ? this.experience.rank(this.search(scope, query, { status: 'trial', limit: 6 }).filter(r => r.kind === 'skill'), query).slice(0, 2) : []
    return [...active, ...trials].map(row => {
      const item = card(row)
      if (row.kind === 'skill') {
        const p = this.experience.summary(row.id)
        if (Object.values(p).some(Boolean)) item.evidence = p
        const verified = this.db.prepare('SELECT suite,run FROM evo_versions WHERE memory=? AND state=?').get(row.id, 'current')
        if (verified) item.verification = { ...verified, kind: 'fixed_suite', note: '仅验证套件内任务，不是人工确认或普遍能力证明' }
      }
      return item
    })
  }
  inbox(scope) {
    return ['candidate', 'trial'].map(status => ({ status,
      total: this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE (scope=? OR scope='profile') AND status=?").get(scope, status).n,
      items: this.search(scope, '', { status, limit: 10 }).map(row => ({ ...card(row),
        evidence: this.db.prepare('SELECT e.role,e.text FROM sources s JOIN events e ON e.id=s.event WHERE s.memory=? ORDER BY e.created DESC LIMIT 1').all(row.id).map(e => ({ role: e.role, text: clean(e.text, 240) })),
        next: status === 'candidate' ? `/learn show ${row.id} → /learn accept ${row.id}` : `/learn feedback ${row.id} pass|fail 真实使用结果`,
      })) })).concat({ status: 'review', items: this.experience.inbox(scope) })
  }
  recall(scope, query, maxBytes = 2400) {
    const revision = this.revisionQuery.get().value
    if (revision !== this.cacheRevision) { this.cache.clear(); this.cacheRevision = revision }
    const key = JSON.stringify([scope, query, maxBytes])
    let text
    if (this.cache.has(key)) {
      text = this.cache.get(key)
      this.cache.delete(key); this.cache.set(key, text)
      this.count('recall_cache_hits')
    } else {
      text = this.assemble(scope, query, maxBytes)
      this.cache.set(key, text)
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value)
      this.count('recall_cache_misses')
    }
    if (text) { this.count('recall_assemblies'); this.count('recall_bytes', Buffer.byteLength(text)) }
    return text
  }
  assemble(scope, query, maxBytes) {
    const prefs = this.db.prepare("SELECT * FROM memories WHERE kind='preference' AND status='active' AND (scope=? OR scope='profile') ORDER BY updated DESC LIMIT 2").all(scope)
    const matches = query.trim() ? this.discover(scope, query) : []
    let text = MEMORY_HEADER
    const seen = new Set()
    for (const row of [...prefs.map(card), ...matches]) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      // JSON quoting keeps third-party delimiters visibly within a data value.
      const line = JSON.stringify(row) + '\n'
      if (Buffer.byteLength(text + line) <= maxBytes) text += line
    }
    return text === MEMORY_HEADER ? '' : text
  }
  accept(key, scope) {
    const row = this.get(key, scope)
    if (!row || row.status === 'deprecated') throw new Error('找不到可接受的候选')
    if (row.status === 'active') return 'active'
    const status = row.kind === 'skill' ? 'trial' : 'active'
    this.db.prepare('UPDATE memories SET status=?,updated=? WHERE id=?').run(status, this.now(), key)
    return status
  }
  feedback(key, scope, trial, verdict, note) {
    if (!['pass', 'fail'].includes(verdict)) throw new Error('反馈必须是 pass 或 fail')
    return this.tx(() => {
      const row = this.get(key, scope)
      if (!row || row.kind !== 'skill' || row.status === 'candidate' || row.status === 'deprecated')
        throw new Error('先接受候选技能进入 trial；废弃技能需修订为新版本')
      this.db.prepare('INSERT INTO feedback VALUES (?,?,?,?,?) ON CONFLICT(memory,trial) DO UPDATE SET verdict=excluded.verdict,note=excluded.note,created=excluded.created')
        .run(key, clean(trial, 200), verdict, clean(note, 1000), this.now())
      this.experience.recalculate(key)
      return this.get(key, scope).status
    })
  }
  revise(key, scope, text, session) {
    return this.tx(() => {
      const old = this.get(key, scope)
      if (!old) throw new Error('记忆不存在')
      if (clean(text, old.kind === 'skill' ? 3200 : 1800) === old.text) throw new Error('新内容没有变化')
      const event = this.capture({ eventId: id(), session, scope: old.scope, role: 'command', text })
      const next = this.add({ scope: old.scope, kind: old.kind, text, sourceIds: [event], origin: 'human', active: true, supersedes: key })
      this.db.prepare('UPDATE memories SET version=? WHERE id=?').run(old.version + 1, next)
      for (const affected of this.dependents(key)) {
        this.db.prepare("UPDATE memories SET status='deprecated',updated=? WHERE id=?").run(this.now(), affected.id)
        this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run(`memory:${affected.fingerprint}`, this.now())
        this.experience.invalidateMemory(affected.id)
      }
      this.suppressSources(key)
      this.bump()
      return next
    })
  }
  suppressSources(key) {
    for (const { event } of this.db.prepare('SELECT event FROM sources WHERE memory=?').all(key)) {
      this.experience.invalidateEvidence(event)
      this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run(`event:${event}`, this.now())
      this.db.prepare('DELETE FROM events WHERE id=?').run(event)
    }
  }
  forget(key, scope) {
    return this.tx(() => {
      if (!this.get(key, scope)) throw new Error('记忆不存在或不属于当前范围')
      const rows = this.dependents(key)
      for (const row of rows) {
        this.db.prepare('DELETE FROM evo_probes WHERE run IN (SELECT run FROM evo_dependencies WHERE memory=? UNION SELECT run FROM evo_versions WHERE memory=?)').run(row.id, row.id)
        this.db.prepare('UPDATE evo_runs SET summary=NULL WHERE id IN (SELECT run FROM evo_dependencies WHERE memory=? UNION SELECT run FROM evo_versions WHERE memory=?)').run(row.id, row.id)
        this.experience.invalidateMemory(row.id)
        this.experience.forgetSources(row.id)
        this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run(`memory:${row.fingerprint}`, this.now())
        this.suppressSources(row.id)
        this.db.prepare('DELETE FROM search WHERE id=?').run(row.id)
        this.db.prepare('DELETE FROM memories WHERE id=?').run(row.id)
      }
      this.bump()
      return rows.length
    })
  }
  dependents(key) {
    return this.db.prepare(`WITH RECURSIVE doomed(id) AS (
      SELECT ? UNION SELECT child FROM links JOIN doomed ON links.parent=doomed.id
      UNION SELECT s.memory FROM sources s JOIN sources p ON p.event=s.event JOIN doomed ON p.memory=doomed.id
    ) SELECT m.* FROM memories m JOIN doomed ON m.id=doomed.id`).all(key)
  }
  maintain() {
    this.flushMetrics()
    return this.tx(() => {
      this.experience.maintain()
      const cutoff = this.now() - 30 * 86400000
      this.db.prepare("UPDATE jobs SET state='cancelled',outcome='expired' WHERE state='pending' AND created<?").run(cutoff)
      this.db.prepare("DELETE FROM jobs WHERE state NOT IN ('pending','running') AND created<?").run(cutoff)
      this.db.prepare('DELETE FROM calls WHERE created<?').run(cutoff)
      this.db.prepare('DELETE FROM evo_calls WHERE created<?').run(cutoff)
      this.db.prepare("DELETE FROM evo_runs WHERE created<? AND state!='running' AND id NOT IN (SELECT run FROM evo_versions)").run(cutoff)
      // Evidence used by memories is retained; unreferenced chat excerpts have a cap/TTL.
      this.db.prepare(`DELETE FROM events WHERE id NOT IN (SELECT event FROM sources)
        AND id NOT IN (SELECT event FROM trial_sources)
        AND (created<? OR id IN (SELECT id FROM events ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 10000))
        AND id NOT IN (SELECT value FROM jobs,json_each(jobs.event_ids) WHERE jobs.state='running')`).run(cutoff)
      this.db.prepare('DELETE FROM queued_sources WHERE event NOT IN (SELECT id FROM events)').run()
    })
  }
  enqueue(session, scope) {
    return this.tx(() => {
    const recent = this.db.prepare('SELECT id,priority,created FROM events WHERE session=? AND scope=? ORDER BY created DESC,rowid DESC LIMIT 12').all(session, scope)
    const important = this.db.prepare(`SELECT id,priority,created FROM events WHERE session=? AND scope=? AND priority>0
      AND id NOT IN (SELECT event FROM queued_sources) ORDER BY priority DESC,created DESC,rowid DESC LIMIT 12`).all(session, scope)
    let events = [...new Map([...recent, ...important].map(e => [e.id, e])).values()].sort((a,b) => a.created-b.created)
    const triggers = events.filter(e => e.priority > 0 && !this.db.prepare('SELECT 1 FROM queued_sources WHERE event=?').get(e.id))
    if (!triggers.length) return null
    const pending = this.db.prepare("SELECT * FROM jobs WHERE session=? AND scope=? AND state='pending' AND epoch=? ORDER BY created DESC LIMIT 1").get(session, scope, this.epoch())
    if (pending) {
      const combined = [...new Map([...JSON.parse(pending.event_ids).map(key => this.event(key)).filter(Boolean), ...events].map(e => [e.id, e])).values()]
      if (combined.length <= 24) {
        events = combined.sort((a,b) => a.created-b.created)
        this.db.prepare('UPDATE jobs SET event_ids=?,priority=? WHERE id=?').run(JSON.stringify(events.map(e => e.id)), Math.max(...events.map(e => e.priority)), pending.id)
        for (const e of triggers) this.db.prepare('INSERT OR IGNORE INTO queued_sources VALUES (?,?)').run(e.id, pending.id)
        this.metric('jobs_coalesced')
        return pending.id
      }
    }
    if (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='pending'").get().n >= 32) return null
    const eventIds = events.map(e => e.id)
    const key = hash(eventIds.join(':'))
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,session,scope,event_ids,state,priority,created,epoch) VALUES (?,?,?,?,'pending',?,?,?)")
      .run(key, session, scope, JSON.stringify(eventIds), Math.max(...events.map(e => e.priority)), this.now(), this.epoch())
    for (const e of triggers) this.db.prepare('INSERT OR IGNORE INTO queued_sources VALUES (?,?)').run(e.id, key)
    return key
    })
  }
  reserve(owner, { dailyCalls, maxInputBytes, maxOutputTokens, timeoutMs }) {
    return this.tx(() => {
      const now = this.now()
      // Expired requests are not retried: the provider may already have billed them.
      this.db.prepare("UPDATE jobs SET state='interrupted',outcome='unknown_after_interruption' WHERE state='running' AND lease<?").run(now)
      if (this.db.prepare("SELECT 1 FROM jobs WHERE state='running'").get()) return null
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE day=?').get(day(now)).n
      if (used >= dailyCalls) return null
      const job = this.db.prepare("SELECT * FROM jobs WHERE state='pending' ORDER BY priority DESC,created LIMIT 1").get()
      if (!job) return null
      const events = JSON.parse(job.event_ids).map(key => this.event(key)).filter(Boolean)
      if (job.epoch !== this.epoch() || !events.length) {
        this.db.prepare("UPDATE jobs SET state='cancelled',outcome='source_changed' WHERE id=?").run(job.id)
        return null
      }
      let bytes = 0
      const selected = [...events].sort((a,b) => b.priority-a.priority).filter(e => { const n = Buffer.byteLength(JSON.stringify(e)); if (bytes + n > maxInputBytes) return false; bytes += n; return true }).sort((a,b) => events.indexOf(a)-events.indexOf(b))
      if (!selected.length) {
        this.db.prepare("UPDATE jobs SET state='cancelled',outcome='input_budget' WHERE id=?").run(job.id)
        return null
      }
      this.db.prepare("UPDATE jobs SET state='running',owner=?,lease=? WHERE id=?").run(owner, now + timeoutMs + 30000, job.id)
      const callId = id()
      this.db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)').run(callId, job.id, day(now), bytes, maxOutputTokens, null, 'reserved', now)
      return { ...job, events: selected, callId, owner }
    })
  }
  finish(job, candidates, usage, outcome) {
    return this.tx(() => {
      const current = this.db.prepare('SELECT state,owner FROM jobs WHERE id=?').get(job.id)
      this.db.prepare('UPDATE calls SET usage=?,outcome=? WHERE id=?').run(usage ? JSON.stringify(usage) : null, outcome, job.callId)
      if (current?.state !== 'running' || current.owner !== job.owner) return []
      const valid = job.epoch === this.epoch() && job.events.every(e => this.event(e.id))
      const keys = []
      if (valid && outcome === 'ok') for (const candidate of candidates) {
        try { keys.push(this.add({ ...candidate, scope: job.scope, origin: 'model' })) }
        catch { /* Invalid or forgotten candidates are never admitted. */ }
      }
      this.db.prepare('UPDATE jobs SET state=?,outcome=? WHERE id=?').run(valid ? 'done' : 'cancelled', valid ? outcome : 'source_changed', job.id)
      return keys
    })
  }
  stats(scope) {
    this.flushMetrics()
    const callsToday = this.db.prepare('SELECT reserved_input AS inputBytes,reserved_output AS maxOutputTokens,usage,outcome FROM calls WHERE day=?').all(day(this.now()))
    const usageToday = { reportedCalls: 0, unknownCalls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    for (const call of callsToday) {
      let usage
      try { usage = JSON.parse(call.usage) } catch { /* Keep unknown usage unknown. */ }
      if (!usage || !['inputTokens', 'outputTokens'].every(k => Number.isFinite(usage[k]) && usage[k] >= 0)) { usageToday.unknownCalls++; continue }
      usageToday.reportedCalls++
      for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens']) {
        if (Number.isFinite(usage[key]) && usage[key] >= 0) usageToday[key] += usage[key]
      }
    }
    return {
      memories: this.db.prepare("SELECT status,kind,COUNT(*) AS count FROM memories WHERE scope=? OR scope='profile' GROUP BY status,kind").all(scope),
      jobs: this.db.prepare('SELECT state,COUNT(*) AS count FROM jobs GROUP BY state').all(),
      callsToday, usageToday,
      metrics: this.db.prepare('SELECT * FROM metrics').all(),
      recentJobs: this.db.prepare('SELECT state,outcome,created FROM jobs WHERE scope=? ORDER BY created DESC,rowid DESC LIMIT 10').all(scope),
      cache: { entries: this.cache.size, maxEntries: 128 },
      observations: this.db.prepare('SELECT COUNT(*) AS turns,SUM(tool_errors) AS toolErrors FROM runs WHERE scope=?').get(scope),
      methodReviews: this.db.prepare('SELECT review,COUNT(*) AS count FROM trials WHERE scope=? AND reported IS NOT NULL GROUP BY review').all(scope),
      budgetDay: 'UTC', epoch: this.epoch(),
    }
  }
}
