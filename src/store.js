import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { hash, id, day, clean, bounded } from './util.js'

export const SCHEMA_VERSION = 1

/**
 * Storage for harness revision trees, episodes, evidence and the append-only ledger.
 *
 * Design notes:
 * - Content-addressed: `blob` holds component bodies by sha256, so identical edits across
 *   revisions cost nothing and diffs are exact.
 * - `rev.parent` forms the version chain, which is what makes rollback-to-any-point and
 *   two-version diff cheap.
 * - Budgets live in `budget` and are reserved inside a transaction *before* a request is
 *   dispatched, so a crash cannot refund spent capacity.
 * - `ledger` is append-only: every adoption must be explainable after the fact.
 */
export class Store {
  constructor(path, { now = Date.now } = {}) {
    this.now = now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`数据库版本 ${version} 高于插件支持的 ${SCHEMA_VERSION}`)
    }
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO meta VALUES ('epoch','0');

        CREATE TABLE IF NOT EXISTS blob(
          hash TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created INTEGER NOT NULL);

        CREATE TABLE IF NOT EXISTS rev(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          parent TEXT REFERENCES rev(id) ON DELETE SET NULL,
          tree TEXT NOT NULL,
          state TEXT NOT NULL,
          taxes INTEGER NOT NULL,
          created INTEGER NOT NULL,
          reason TEXT);
        CREATE INDEX IF NOT EXISTS rev_scope ON rev(scope, created);
        CREATE INDEX IF NOT EXISTS rev_state ON rev(scope, state);

        CREATE TABLE IF NOT EXISTS episode(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          task_key TEXT NOT NULL,
          trigger TEXT NOT NULL,
          from_rev TEXT NOT NULL REFERENCES rev(id) ON DELETE CASCADE,
          to_rev TEXT REFERENCES rev(id) ON DELETE SET NULL,
          divergence TEXT,
          target TEXT,
          cost TEXT,
          state TEXT NOT NULL,
          reason TEXT,
          created INTEGER NOT NULL,
          finished INTEGER);
        CREATE INDEX IF NOT EXISTS episode_scope ON episode(scope, created);
        CREATE INDEX IF NOT EXISTS episode_task ON episode(scope, task_key, created);
        CREATE INDEX IF NOT EXISTS episode_target ON episode(scope, target, state);

        CREATE TABLE IF NOT EXISTS evidence(
          id TEXT PRIMARY KEY,
          episode TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS evidence_episode ON evidence(episode, kind);

        CREATE TABLE IF NOT EXISTS watch(
          rev TEXT PRIMARY KEY REFERENCES rev(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          task_key TEXT NOT NULL,
          remaining INTEGER NOT NULL,
          baseline TEXT NOT NULL,
          verdict TEXT,
          decided INTEGER,
          created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS watch_open ON watch(scope, verdict);

        CREATE TABLE IF NOT EXISTS ledger(
          id TEXT PRIMARY KEY,
          rev TEXT,
          scope TEXT NOT NULL,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          gate TEXT,
          detail TEXT,
          created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ledger_scope ON ledger(scope, created);

        CREATE TABLE IF NOT EXISTS budget(
          key TEXT PRIMARY KEY,
          day TEXT NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          reserved INTEGER NOT NULL DEFAULT 0);

        CREATE TABLE IF NOT EXISTS call(
          id TEXT PRIMARY KEY,
          episode TEXT REFERENCES episode(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          day TEXT NOT NULL,
          input_bytes INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          usage TEXT,
          created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS call_day ON call(day);
        CREATE INDEX IF NOT EXISTS call_episode ON call(episode);

        PRAGMA user_version=${SCHEMA_VERSION};
        COMMIT;
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() { try { this.db.close() } catch { /* already closed */ } }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value }
    catch (error) { try { this.db.exec('ROLLBACK') } catch { /* nested */ } throw error }
  }

  epoch() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get()
    return row ? Number(row.value) : 0
  }

  bump() { this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='epoch'").run() }

  // -- blobs ---------------------------------------------------------------

  put(text) {
    const key = hash(text)
    this.db.prepare('INSERT OR IGNORE INTO blob VALUES (?,?,?,?)').run(key, text, Buffer.byteLength(text), this.now())
    return key
  }

  get(key) {
    return this.db.prepare('SELECT body FROM blob WHERE hash=?').get(key)?.body ?? null
  }

  /** Materialise a tree ref into {path: text}. */
  materialize(revId) {
    const row = this.db.prepare('SELECT tree FROM rev WHERE id=?').get(revId)
    if (!row) throw new Error(`版本不存在: ${revId}`)
    const files = {}
    for (const [path, key] of Object.entries(JSON.parse(row.tree))) {
      const body = this.get(key)
      if (body === null) throw new Error(`组件正文缺失: ${path} (${key})`)
      files[path] = body
    }
    return files
  }

  // -- revisions -----------------------------------------------------------

  /** Persist a tree and return its revision id. Idempotent on identical content. */
  putRev(scope, files, { parent = null, state = 'draft', reason = null, taxes = 0 } = {}) {
    const refs = {}
    for (const [path, text] of Object.entries(files)) refs[path] = this.put(text)
    const canonical = JSON.stringify(Object.keys(refs).sort().map(p => [p, refs[p]]))
    const key = hash(canonical)
    const existing = this.db.prepare('SELECT id FROM rev WHERE id=?').get(key)
    if (existing) return key
    this.db.prepare('INSERT INTO rev(id,scope,parent,tree,state,taxes,created,reason) VALUES (?,?,?,?,?,?,?,?)')
      .run(key, scope, parent, JSON.stringify(refs), state, taxes, this.now(), reason)
    return key
  }

  rev(key, scope) {
    const row = this.db.prepare('SELECT * FROM rev WHERE id=? AND scope=?').get(key, scope)
    return row ? { ...row, tree: JSON.parse(row.tree) } : null
  }

  latest(scope, states = ['stable', 'shadow']) {
    const slots = states.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM rev WHERE scope=? AND state IN (${slots}) ORDER BY created DESC, rowid DESC LIMIT 1`)
      .get(scope, ...states) ?? null
  }

  setRevState(key, state) {
    this.db.prepare('UPDATE rev SET state=? WHERE id=?').run(state, key)
  }

  chain(scope, limit = 50) {
    return this.db.prepare('SELECT * FROM rev WHERE scope=? ORDER BY created DESC, rowid DESC LIMIT ?').all(scope, limit)
  }

  // -- episodes ------------------------------------------------------------

  createEpisode({ scope, taskKey, trigger, fromRev, divergence = null, target = null }) {
    const key = id()
    this.db.prepare('INSERT INTO episode(id,scope,task_key,trigger,from_rev,state,created) VALUES (?,?,?,?,?,?,?)')
      .run(key, scope, taskKey, trigger, fromRev, 'running', this.now())
    if (divergence) this.db.prepare('UPDATE episode SET divergence=? WHERE id=?').run(JSON.stringify(divergence), key)
    if (target) this.db.prepare('UPDATE episode SET target=? WHERE id=?').run(target, key)
    return key
  }

  finishEpisode(key, { toRev = null, cost = null, state, reason = null }) {
    this.db.prepare('UPDATE episode SET to_rev=?, cost=?, state=?, reason=?, finished=? WHERE id=?')
      .run(toRev, cost ? JSON.stringify(cost) : null, state, reason, this.now(), key)
  }

  episode(key, scope) {
    const row = this.db.prepare('SELECT * FROM episode WHERE id=? AND scope=?').get(key, scope)
    if (!row) return null
    return {
      ...row,
      divergence: row.divergence ? JSON.parse(row.divergence) : null,
      cost: row.cost ? JSON.parse(row.cost) : null,
      evidence: this.db.prepare('SELECT id,kind,path,bytes FROM evidence WHERE episode=? ORDER BY created').all(key),
    }
  }

  recentEpisodes(scope, limit = 20) {
    return this.db.prepare('SELECT id,scope,task_key,trigger,target,state,reason,created,finished FROM episode WHERE scope=? ORDER BY created DESC, rowid DESC LIMIT ?')
      .all(scope, limit)
  }

  /** Newest finished episode for a target component, used for the 20-turn cooldown. */
  lastAdoption(scope) {
    return this.db.prepare("SELECT created FROM rev WHERE scope=? AND state IN ('stable','shadow') ORDER BY created DESC LIMIT 1").get(scope)?.created ?? 0
  }

  /** True when an unfinished episode exists for the same scope; only one runs at a time. */
  running(scope) {
    return this.db.prepare("SELECT id FROM episode WHERE scope=? AND state='running' LIMIT 1").get(scope)?.id ?? null
  }

  // -- evidence ------------------------------------------------------------

  addEvidence(episode, kind, text) {
    const key = id()
    const body = bounded(text, 24000)
    const path = `${kind}-${key}.txt`
    this.db.prepare('INSERT INTO evidence(id,episode,kind,path,bytes,created) VALUES (?,?,?,?,?,?)')
      .run(key, episode, kind, path, Buffer.byteLength(body), this.now())
    this.evidenceBody = this.evidenceBody ?? new Map()
    this.evidenceBody.set(key, body)
    this.db.prepare('INSERT OR REPLACE INTO blob VALUES (?,?,?,?)').run(`ev:${key}`, body, Buffer.byteLength(body), this.now())
    return { id: key, kind, path, bytes: Buffer.byteLength(body) }
  }

  readEvidence(key) { return this.get(`ev:${key}`) }

  // -- watch ---------------------------------------------------------------

  openWatch(rev, scope, taskKey, baseline, window) {
    this.db.prepare("INSERT OR REPLACE INTO watch(rev,scope,task_key,remaining,baseline,verdict,decided,created) VALUES (?,?,?,?,?,NULL,NULL,?)")
      .run(rev, scope, taskKey, window, JSON.stringify(baseline), this.now())
  }

  openWatches(scope) {
    return this.db.prepare('SELECT * FROM watch WHERE scope=? AND verdict IS NULL ORDER BY created').all(scope)
      .map(r => ({ ...r, baseline: JSON.parse(r.baseline) }))
  }

  decideWatch(rev, verdict) {
    this.db.prepare('UPDATE watch SET verdict=?, decided=? WHERE rev=?').run(verdict, this.now(), rev)
  }

  /** Decrement remaining tasks; returns the updated row. */
  consumeWatch(rev) {
    this.db.prepare('UPDATE watch SET remaining=MAX(0,remaining-1) WHERE rev=?').run(rev)
    const row = this.db.prepare('SELECT * FROM watch WHERE rev=?').get(rev)
    return row ? { ...row, baseline: JSON.parse(row.baseline) } : null
  }

  // -- ledger --------------------------------------------------------------

  log({ rev = null, scope, action, actor, gate = null, detail = null }) {
    const key = id()
    this.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)')
      .run(key, rev, scope, action, actor, gate ? JSON.stringify(gate) : null,
        detail === null ? null : bounded(typeof detail === 'string' ? detail : JSON.stringify(detail), 4000), this.now())
    return key
  }

  ledger(scope, limit = 30) {
    return this.db.prepare('SELECT * FROM ledger WHERE scope=? ORDER BY rowid DESC LIMIT ?').all(scope, limit)
      .map(r => ({ ...r, gate: r.gate ? JSON.parse(r.gate) : null }))
  }

  // -- budget --------------------------------------------------------------

  /**
   * Reserve capacity across several independent dimensions at once.
   * All-or-nothing: if any dimension would exceed its limit, nothing is taken.
   * Reserved capacity is never refunded, matching the "no retry of paid work" rule.
   */
  reserve({ day: dayKey, dims, episode = null, phase = 'edit', inputBytes = 0 }) {
    return this.tx(() => {
      // All-or-nothing across dimensions: a partial reservation would let one dimension
      // starve while another over-spends.
      for (const [key, { limit, amount }] of Object.entries(dims)) {
        const row = this.db.prepare('SELECT * FROM budget WHERE key=?').get(key)
        const used = row && row.day === dayKey ? row.used : 0
        if (used + amount > limit) return { ok: false, key, used, limit, amount }
      }
      // Capacity is spent immediately, not held: this plugin never retries paid work, so
      // there is no window in which a reservation should be released.
      for (const [key, { amount }] of Object.entries(dims)) {
        this.db.prepare(`INSERT INTO budget(key,day,used,reserved) VALUES (?,?,?,0)
          ON CONFLICT(key) DO UPDATE SET
            used=CASE WHEN budget.day=excluded.day THEN budget.used+excluded.used ELSE excluded.used END,
            reserved=0, day=excluded.day`)
          .run(key, dayKey, amount)
      }
      const callId = id()
      this.db.prepare('INSERT INTO call(id,episode,phase,day,input_bytes,outcome,created) VALUES (?,?,?,?,?,?,?)')
        .run(callId, episode, phase, dayKey, inputBytes, 'reserved', this.now())
      return { ok: true, callId }
    })
  }

  /** Record the outcome of an already-reserved call. Usage may stay unknown, never zero. */
  settle(callId, outcome, usage = null) {
    this.db.prepare('UPDATE call SET outcome=?, usage=? WHERE id=?')
      .run(outcome, usage ? JSON.stringify(usage) : null, callId)
  }

  budgetState(dayKey, keys) {
    const out = {}
    for (const key of keys) {
      const row = this.db.prepare('SELECT * FROM budget WHERE key=?').get(key)
      out[key] = row && row.day === dayKey ? { used: row.used, reserved: row.reserved } : { used: 0, reserved: 0 }
    }
    return out
  }

  callStats(dayKey) {
    return this.db.prepare('SELECT phase, outcome, COUNT(*) AS n FROM call WHERE day=? GROUP BY phase, outcome').all(dayKey)
  }

  integrity() {
    return {
      integrity: this.db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeys: this.db.prepare('PRAGMA foreign_key_check').all().length,
      epoch: this.epoch(),
    }
  }
}

export { day, clean }
